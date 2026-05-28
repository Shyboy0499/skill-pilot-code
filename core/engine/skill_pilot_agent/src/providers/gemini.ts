import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import type { FunctionDeclaration, Tool as GeminiTool, Part } from '@google/generative-ai';
import type { ResolvedProvider, AdapterStreamEvent } from './types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
// Tool schema conversion (OpenAI/zod -> Gemini FunctionDeclaration)
// ---------------------------------------------------------------------------

const ZOD_TYPE_TO_SCHEMA_TYPE: Record<string, SchemaType> = {
  ZodString: SchemaType.STRING,
  ZodNumber: SchemaType.NUMBER,
  ZodBoolean: SchemaType.BOOLEAN,
  ZodArray: SchemaType.ARRAY,
  ZodObject: SchemaType.OBJECT,
};

function openaiToolToGemini(tool: Record<string, unknown>): FunctionDeclaration {
  const params: Record<string, unknown> =
    (tool.parameters as Record<string, unknown>)?._def as Record<string, unknown> ||
    (tool.parameters as Record<string, unknown>) ||
    {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const properties: Record<string, any> = {};
  const required: string[] = [];
  const shape = params.shape as Record<string, Record<string, unknown>> | undefined;

  if (shape) {
    for (const [key, def] of Object.entries(shape)) {
      const zodDef: Record<string, unknown> =
        (def as Record<string, unknown>)?._def as Record<string, unknown> || def;
      properties[key] = {
        type: ZOD_TYPE_TO_SCHEMA_TYPE[String(zodDef.typeName)] || SchemaType.STRING,
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
    parameters: {
      type: SchemaType.OBJECT,
      properties,
      required: required.length > 0 ? required : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------

export async function* runGeminiAgent(
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

  const genAI = new GoogleGenerativeAI(apiKey);

  // Convert OpenAI-format tool schemas to Gemini FunctionDeclaration format.
  // Exclude built-in tools that are not OpenAI function-typed (e.g. the "bash"
  // tool injected by the harness).
  const functionDeclarations: FunctionDeclaration[] = tools
    .filter((t) => t.name !== 'bash' || (t as Record<string, unknown>).type === 'function')
    .map(openaiToolToGemini);

  const geminiTools: GeminiTool[] = [];
  if (functionDeclarations.length > 0) {
    geminiTools.push({ functionDeclarations });
  }

  // Compute a generous maxOutputTokens so the thinking budget fits comfortably.
  const thinkingBudget = effort ? effortToTokens(effort) : undefined;
  const maxOutputTokens = thinkingBudget ? thinkingBudget + 4096 : 8192;

  const model = genAI.getGenerativeModel({
    model: resolved.model,
    systemInstruction: systemPrompt,
    tools: geminiTools.length > 0 ? geminiTools : undefined,
    generationConfig: {
      maxOutputTokens,
    },
  });

  const chat = model.startChat({
    history: [],
    tools: geminiTools.length > 0 ? geminiTools : undefined,
  });

  let nextInput: string | Array<string | Part> = userPrompt;
  let continueLoop = true;
  const maxTurns = 10;
  let turnCount = 0;

  while (continueLoop && turnCount < maxTurns) {
    turnCount++;
    const result = await chat.sendMessageStream(nextInput);

    const currentToolCalls: { name: string; args: object }[] = [];

    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      if (chunkText) {
        yield { type: 'text_delta', text: chunkText };
      }

      const candidates = chunk.candidates;
      if (candidates) {
        for (const candidate of candidates) {
          const parts = candidate.content?.parts;
          if (parts) {
            for (const part of parts) {
              if (part.functionCall) {
                currentToolCalls.push({
                  name: part.functionCall.name,
                  args: part.functionCall.args,
                });
              }
            }
          }
        }
      }
    }

    // Execute tool calls and feed results back into the conversation.
    if (currentToolCalls.length > 0) {
      const functionResponseParts: Part[] = [];

      for (const tc of currentToolCalls) {
        yield { type: 'tool_call', toolName: tc.name, toolArgs: tc.args as Record<string, unknown> };

        const tool = tools.find(
          (t) => t.name === tc.name,
        ) as { run: (args: Record<string, unknown>) => unknown } | undefined;

        if (tool) {
          try {
            const output = await tool.run(tc.args as Record<string, unknown>);
            const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
            yield { type: 'tool_result', toolOutput: outputStr.substring(0, 200) };
            functionResponseParts.push({
              functionResponse: {
                name: tc.name,
                response: { result: outputStr },
              },
            } as Part);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            yield { type: 'tool_result', toolOutput: `Error: ${message}` };
            functionResponseParts.push({
              functionResponse: {
                name: tc.name,
                response: { error: message },
              },
            } as Part);
          }
        } else {
          // Tool definition not found; report an error result so the model can
          // recover gracefully.
          const msg = `Tool "${tc.name}" not found`;
          yield { type: 'tool_result', toolOutput: msg };
          functionResponseParts.push({
            functionResponse: {
              name: tc.name,
              response: { error: msg },
            },
          } as Part);
        }
      }

      // Send function responses back to the model. The ChatSession maintains
      // history internally, so these responses are associated with the
      // preceding function calls automatically.
      nextInput = functionResponseParts;
    } else {
      continueLoop = false;
    }
  }

  yield { type: 'done' };
}
