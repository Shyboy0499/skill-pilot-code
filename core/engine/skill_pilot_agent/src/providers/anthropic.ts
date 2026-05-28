import Anthropic from '@anthropic-ai/sdk';
import type { ResolvedProvider, AdapterStreamEvent } from './types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

function effortToTokens(effort: string): number {
  switch (effort) {
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 8192;
    case 'xhigh':
      return 16384;
    default:
      return 4096;
  }
}

// ---------------------------------------------------------------------------
// Tool schema conversion (OpenAI/zod -> Anthropic JSON Schema)
// ---------------------------------------------------------------------------

function openaiToolToAnthropic(tool: Record<string, unknown>): AnthropicTool {
  const params: Record<string, unknown> =
    (tool.parameters as Record<string, unknown>)?._def as Record<string, unknown> ||
    (tool.parameters as Record<string, unknown>) ||
    {};

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const shape = params.shape as Record<string, Record<string, unknown>> | undefined;

  if (shape) {
    for (const [key, def] of Object.entries(shape)) {
      const zodDef: Record<string, unknown> = (def as Record<string, unknown>)?._def as Record<string, unknown> || def;
      properties[key] = {
        type: zodDef.typeName ? String(zodDef.typeName).toLowerCase() : 'string',
        description: zodDef.description || '',
      };
      if (typeof (def as { isOptional?: () => boolean }).isOptional === 'function') {
        if (!(def as { isOptional: () => boolean }).isOptional()) {
          required.push(key);
        }
      }
    }
  }

  return {
    name: tool.name as string,
    description: (tool.description as string) || '',
    input_schema: {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------

export async function* runAnthropicAgent(
  resolved: ResolvedProvider,
  systemPrompt: string,
  userPrompt: string,
  tools: Record<string, unknown>[],
  effort?: string,
): AsyncGenerator<AdapterStreamEvent> {
  const apiKey = process.env[resolved.provider.api_key_env];
  if (!apiKey) {
    yield { type: 'error', error: `${resolved.provider.api_key_env} not set` };
    return;
  }

  const anthropic = new Anthropic({ apiKey, baseURL: resolved.provider.base_url });

  // Convert OpenAI-format tool schemas to Anthropic format.
  // Exclude built-in tools that are not OpenAI function-typed (e.g. the "bash"
  // tool injected by the harness).
  const anthropicTools: AnthropicTool[] = tools
    .filter((t) => t.name !== 'bash' || (t as Record<string, unknown>).type === 'function')
    .map(openaiToolToAnthropic);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  // Compute a generous max_tokens so the thinking budget fits comfortably.
  const thinkingBudget = effort ? effortToTokens(effort) : undefined;
  const maxTokens = thinkingBudget ? thinkingBudget + 4096 : 4096;

  let continueLoop = true;
  while (continueLoop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = anthropic.messages.stream({
      model: resolved.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      tools: anthropicTools.length > 0
        ? (anthropicTools as unknown as Anthropic.Messages.ToolUnion[])
        : undefined,
      ...(effort
        ? { thinking: { type: 'enabled' as const, budget_tokens: effortToTokens(effort) } }
        : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    let currentText = '';
    const currentToolCalls: { id: string; name: string; input: string }[] = [];

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          currentText += event.delta.text;
          yield { type: 'text_delta', text: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          if (currentToolCalls.length > 0) {
            currentToolCalls[currentToolCalls.length - 1].input += event.delta.partial_json;
          }
        }
      } else if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          currentToolCalls.push({
            id: event.content_block.id,
            name: event.content_block.name,
            input: '',
          });
        }
      } else if (event.type === 'message_stop') {
        break;
      }
    }

    // Execute tool calls (if any) and feed results back into the conversation.
    if (currentToolCalls.length > 0) {
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const tc of currentToolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.input);
        } catch {
          // Partial or invalid JSON; continue with empty args.
        }

        yield { type: 'tool_call', toolName: tc.name, toolArgs: args };

        const tool = tools.find(
          (t) => t.name === tc.name,
        ) as { run: (args: Record<string, unknown>) => unknown } | undefined;

        if (tool) {
          try {
            const output = await tool.run(args);
            const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
            yield { type: 'tool_result', toolOutput: outputStr.substring(0, 200) };
            toolResults.push({
              type: 'tool_result' as const,
              tool_use_id: tc.id,
              content: outputStr,
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            yield { type: 'tool_result', toolOutput: `Error: ${message}` };
            toolResults.push({
              type: 'tool_result' as const,
              tool_use_id: tc.id,
              content: `Error: ${message}`,
              is_error: true,
            });
          }
        } else {
          // Tool definition not found; report an error result so the model can
          // recover gracefully.
          const msg = `Tool "${tc.name}" not found`;
          yield { type: 'tool_result', toolOutput: msg };
          toolResults.push({
            type: 'tool_result' as const,
            tool_use_id: tc.id,
            content: msg,
            is_error: true,
          });
        }
      }

      // Append the assistant turn + the user turn carrying tool results.
      messages.push({
        role: 'assistant',
        content: currentText || 'Processing...',
      });

      // The SDK expects ContentBlockParam[]; ToolResultBlockParam is one variant.
      messages.push({
        role: 'user',
        content: toolResults as unknown as Array<Anthropic.Messages.ContentBlockParam>,
      });
    } else {
      continueLoop = false;
    }
  }

  yield { type: 'done' };
}
