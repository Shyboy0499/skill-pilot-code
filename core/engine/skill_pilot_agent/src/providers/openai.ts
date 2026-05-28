import { Agent, run } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents-core';
import type { ResolvedProvider } from './types';

export function buildOpenAIAgent(
  resolved: ResolvedProvider,
  instructions: string,
  tools: any[],
  effort?: string,
): Agent {
  process.env.OPENAI_BASE_URL = resolved.provider.base_url;
  process.env.OPENAI_API_KEY = process.env[resolved.provider.api_key_env] || '';

  const modelSettings: any = {};
  if (effort && resolved.provider.effort_levels.includes(effort)) {
    modelSettings.reasoning = { effort };
  }

  return new Agent({
    name: 'Skill Pilot spcode',
    instructions,
    model: resolved.model,
    tools,
    modelSettings: Object.keys(modelSettings).length > 0 ? modelSettings : undefined,
  });
}

export async function runOpenAIAgent(
  agent: Agent,
  prompt: string,
  conversation: AgentInputItem[],
  maxTurns: number,
): Promise<{ stream: AsyncIterable<any>; collectedItems: AgentInputItem[] }> {
  const input: any =
    conversation.length > 0
      ? [...conversation, { type: 'message', role: 'user', content: prompt } as any]
      : prompt;

  const result = (await run(agent, input, {
    maxTurns,
    stream: true,
  })) as any;

  return { stream: result, collectedItems: [...conversation] };
}
