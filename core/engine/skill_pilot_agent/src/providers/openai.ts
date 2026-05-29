import { Agent, run, OpenAIProvider } from '@openai/agents';
import type { AgentInputItem, Model } from '@openai/agents-core';
import type { ResolvedProvider } from './types';

export interface OpenAIRunResult {
  stream: AsyncIterable<any>;
  collectedItems: AgentInputItem[];
}

let _chatModelCache: Map<string, Model> = new Map();

async function resolveModelForProvider(resolved: ResolvedProvider): Promise<string | Model> {
  // OpenAI itself supports the Responses API — use the default (string model name)
  if (resolved.provider.id === 'openai') {
    return resolved.model;
  }

  // Third-party providers (DeepSeek, Groq, etc.) only support Chat Completions.
  // Create a provider with useResponses: false to force the /v1/chat/completions endpoint.
  const cacheKey = `${resolved.provider.id}:${resolved.model}`;
  const cached = _chatModelCache.get(cacheKey);
  if (cached) return cached;

  const apiKey = process.env[resolved.provider.api_key_env] || '';
  const provider = new OpenAIProvider({
    apiKey,
    baseURL: resolved.provider.base_url,
    useResponses: false,
  });

  const model = await provider.getModel(resolved.model);
  _chatModelCache.set(cacheKey, model);
  return model;
}

export async function buildOpenAIAgent(
  resolved: ResolvedProvider,
  instructions: string,
  tools: any[],
  effort?: string,
): Promise<Agent> {
  process.env.OPENAI_BASE_URL = resolved.provider.base_url;
  process.env.OPENAI_API_KEY = process.env[resolved.provider.api_key_env] || '';

  const modelSettings: any = {};
  if (effort && resolved.provider.effort_levels.includes(effort)) {
    modelSettings.reasoning = { effort };
  }

  const model = await resolveModelForProvider(resolved);

  return new Agent({
    name: 'Skill Pilot spcode',
    instructions,
    model,
    tools,
    modelSettings: Object.keys(modelSettings).length > 0 ? modelSettings : undefined,
  });
}

export async function runOpenAIAgent(
  agent: Agent,
  prompt: string,
  conversation: AgentInputItem[],
  maxTurns: number,
): Promise<OpenAIRunResult> {
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
