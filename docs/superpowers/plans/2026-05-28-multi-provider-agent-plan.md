# Multi-Provider Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-proxy architecture with direct per-provider API access via adapters.

**Architecture:** A provider config file (`providers.json`) maps model names to providers. Each provider specifies its base URL, API key env var, and protocol. The protocol selects an adapter — OpenAI-compatible (pass-through to `@openai/agents`), Anthropic (native SDK wrapper), or Gemini (native SDK wrapper). All adapters emit a unified event stream consumed by `runStreaming()`.

**Tech Stack:** TypeScript, `@openai/agents` (existing), `@anthropic-ai/sdk` (new), `@google/generative-ai` (new), `commander`, `zod`

---

### Task 1: Install new dependencies

**Files:**
- Modify: `core/engine/skill_pilot_agent/package.json`

- [ ] **Step 1: Install Anthropic and Gemini SDKs**

```bash
cd /Users/brocode/workspace/skill-pilot-code/core/engine/skill_pilot_agent
npm install @anthropic-ai/sdk @google/generative-ai
```

- [ ] **Step 2: Verify install**

```bash
node -e "require('@anthropic-ai/sdk'); console.log('anthropic OK')"
node -e "require('@google/generative-ai'); console.log('gemini OK')"
```

Expected: Both print "OK" with no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @anthropic-ai/sdk and @google/generative-ai dependencies"
```

---

### Task 2: Provider types

**Files:**
- Create: `core/engine/skill_pilot_agent/src/providers/types.ts`

- [ ] **Step 1: Write types file**

```typescript
export interface ProviderConfig {
  id: string;
  base_url: string;
  api_key_env: string;
  protocol: 'openai' | 'anthropic' | 'gemini';
  models: string[];
  effort_levels: string[];
}

export interface ProvidersFile {
  providers: ProviderConfig[];
  default: string;
}

export interface ResolvedProvider {
  provider: ProviderConfig;
  model: string;
}

export interface AdapterStreamEvent {
  type: 'text_delta' | 'tool_call' | 'tool_result' | 'done' | 'error';
  text?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  error?: string;
}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/brocode/workspace/skill-pilot-code/core/engine/skill_pilot_agent
npx tsc --noEmit src/providers/types.ts
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/providers/types.ts
git commit -m "feat: add provider types and adapter stream event interface"
```

---

### Task 3: Provider config loader

**Files:**
- Create: `core/engine/skill_pilot_agent/src/providers/config.ts`

- [ ] **Step 1: Write config loader**

```typescript
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderConfig, ProvidersFile, ResolvedProvider } from './types';

let _registry: Map<string, ProviderConfig> | null = null;
let _defaultProviderId: string | null = null;

export function loadProviderConfig(configPath?: string): void {
  const resolvedPath = configPath || path.resolve(__dirname, '../../providers.json');

  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: Provider config not found at ${resolvedPath}`);
    process.exit(1);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch {
    console.error(`Error: Cannot read provider config at ${resolvedPath}`);
    process.exit(1);
  }

  let data: ProvidersFile;
  try {
    data = JSON.parse(raw) as ProvidersFile;
  } catch {
    console.error(`Error: Invalid JSON in provider config at ${resolvedPath}`);
    process.exit(1);
  }

  if (!data.providers || data.providers.length === 0) {
    console.error('Error: No providers defined in config.');
    process.exit(1);
  }

  _registry = new Map();
  for (const provider of data.providers) {
    if (!provider.id || !provider.base_url || !provider.api_key_env || !provider.protocol) {
      console.error(`Error: Provider entry missing required fields (id, base_url, api_key_env, protocol).`);
      process.exit(1);
    }
    for (const model of provider.models) {
      _registry.set(model, provider);
    }
  }

  _defaultProviderId = data.default || data.providers[0].id;
}

export function resolveModel(model: string): ResolvedProvider {
  if (!_registry) {
    console.error('Error: Provider config not loaded. Call loadProviderConfig() first.');
    process.exit(1);
  }

  const provider = _registry.get(model);
  if (!provider) {
    const allModels = Array.from(_registry.keys()).join(', ');
    console.error(`Error: Unknown model '${model}'. Available models: ${allModels}`);
    process.exit(1);
  }

  const apiKey = process.env[provider.api_key_env];
  if (!apiKey) {
    console.error(
      `Error: ${provider.api_key_env} not set. Required by provider '${provider.id}' for model '${model}'.`
    );
    process.exit(1);
  }

  return { provider, model };
}

export function getDefaultModel(): string | null {
  if (!_registry || !_defaultProviderId) return null;
  for (const [model, provider] of _registry) {
    if (provider.id === _defaultProviderId) {
      return model;
    }
  }
  return null;
}

export function listModels(): string[] {
  if (!_registry) return [];
  return Array.from(_registry.keys());
}

export function getProviderById(id: string): ProviderConfig | undefined {
  if (!_registry) return undefined;
  for (const provider of _registry.values()) {
    if (provider.id === id) return provider;
  }
  return undefined;
}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/brocode/workspace/skill-pilot-code/core/engine/skill_pilot_agent
npx tsc --noEmit src/providers/config.ts
```

Expected: No errors.

- [ ] **Step 3: Write unit tests**

Create `core/engine/skill_pilot_agent/tests/providers/config.test.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Since loadProviderConfig uses process.exit, we test by writing temp files and
// checking behavior. We intercept console.error to verify messages.

describe('loadProviderConfig', () => {
  // We'll write a simple smoke test script instead of jest (no test runner configured).
  // See Task 8 integration test.
});
```

Note: The agent has no test runner configured. Unit tests for pure functions would need vitest/jest setup. Instead, we'll verify config loading via the integration smoke test in Task 8.

- [ ] **Step 4: Commit**

```bash
git add src/providers/config.ts
git commit -m "feat: add provider config loader with model resolution"
```

---

### Task 4: OpenAI adapter

**Files:**
- Create: `core/engine/skill_pilot_agent/src/providers/openai.ts`

The OpenAI adapter sets `OPENAI_BASE_URL` and `OPENAI_API_KEY` to the resolved provider's values, then delegates to `@openai/agents`. This works for OpenAI, DeepSeek, Groq, and any OpenAI-compatible endpoint.

- [ ] **Step 1: Write OpenAI adapter**

```typescript
import { Agent, run } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents-core';
import type { ResolvedProvider } from './types';

export interface OpenAIRunResult {
  stream: AsyncIterable<any>;
  collectedItems: AgentInputItem[];
}

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
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/brocode/workspace/skill-pilot-code/core/engine/skill_pilot_agent
npx tsc --noEmit src/providers/openai.ts
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/providers/openai.ts
git commit -m "feat: add OpenAI-compatible adapter with effort support"
```

---

### Task 5: Anthropic adapter

**Files:**
- Create: `core/engine/skill_pilot_agent/src/providers/anthropic.ts`

The Anthropic adapter uses `@anthropic-ai/sdk` directly, translates tool schemas, and emits events compatible with the `runStreaming()` consumer.

- [ ] **Step 1: Write Anthropic adapter**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { ResolvedProvider, AdapterStreamEvent } from './types';

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

function openaiToolToAnthropic(tool: any): AnthropicTool {
  const params = tool.parameters?._def || tool.parameters || {};
  const properties: Record<string, any> = {};
  const required: string[] = [];

  if (params.shape) {
    for (const [key, def] of Object.entries(params.shape as Record<string, any>)) {
      const zodDef = (def as any)._def || def;
      properties[key] = {
        type: zodDef.typeName?.toLowerCase() || 'string',
        description: zodDef.description || '',
      };
      if (!(def as any).isOptional?.()) {
        required.push(key);
      }
    }
  }

  return {
    name: tool.name,
    description: tool.description || '',
    input_schema: {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    },
  };
}

export async function* runAnthropicAgent(
  resolved: ResolvedProvider,
  systemPrompt: string,
  userPrompt: string,
  tools: any[],
  effort?: string,
): AsyncGenerator<AdapterStreamEvent> {
  const apiKey = process.env[resolved.provider.api_key_env];
  if (!apiKey) {
    yield { type: 'error', error: `${resolved.provider.api_key_env} not set` };
    return;
  }

  const anthropic = new Anthropic({ apiKey, baseURL: resolved.provider.base_url });
  const anthropicTools: AnthropicTool[] = tools
    .filter((t) => t.name !== 'bash' || t.type === 'function')
    .map(openaiToolToAnthropic);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  let continueLoop = true;
  while (continueLoop) {
    const stream = anthropic.messages.stream({
      model: resolved.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      ...(effort ? { thinking: { type: 'enabled' as const, budget_tokens: effortToTokens(effort) } } : {}),
    });

    let currentText = '';
    let currentToolCalls: { id: string; name: string; input: string }[] = [];

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

    // Execute tool calls
    if (currentToolCalls.length > 0) {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tc of currentToolCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.input); } catch { /* partial JSON, skip */ }

        yield { type: 'tool_call', toolName: tc.name, toolArgs: args };

        const tool = tools.find((t) => t.name === tc.name);
        if (tool) {
          try {
            const output = await tool.run(args);
            const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
            yield { type: 'tool_result', toolOutput: outputStr.substring(0, 200) };
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: outputStr,
            });
          } catch (err: any) {
            yield { type: 'tool_result', toolOutput: `Error: ${err.message}` };
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: `Error: ${err.message}`,
            });
          }
        }
      }

      messages.push({ role: 'assistant', content: currentText || 'Processing...' });
      messages.push({ role: 'user', content: toolResults as any });
    } else {
      continueLoop = false;
    }
  }

  yield { type: 'done' };
}

function effortToTokens(effort: string): number {
  switch (effort) {
    case 'low': return 1024;
    case 'medium': return 4096;
    case 'high': return 8192;
    case 'xhigh': return 16384;
    default: return 4096;
  }
}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/brocode/workspace/skill-pilot-code/core/engine/skill_pilot_agent
npx tsc --noEmit src/providers/anthropic.ts
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/providers/anthropic.ts
git commit -m "feat: add Anthropic adapter with tool translation and effort"
```

---

### Task 6: Gemini adapter

**Files:**
- Create: `core/engine/skill_pilot_agent/src/providers/gemini.ts`

The Gemini adapter uses `@google/generative-ai`, translates tool schemas, and emits unified events.

- [ ] **Step 1: Write Gemini adapter**

```typescript
import { GoogleGenerativeAI, type FunctionDeclaration, type Tool as GeminiTool } from '@google/generative-ai';
import type { ResolvedProvider, AdapterStreamEvent } from './types';

function openaiToolToGemini(tool: any): FunctionDeclaration {
  const params = tool.parameters?._def || tool.parameters || {};
  const properties: Record<string, any> = {};
  const required: string[] = [];

  if (params.shape) {
    for (const [key, def] of Object.entries(params.shape as Record<string, any>)) {
      const zodDef = (def as any)._def || def;
      const typeMap: Record<string, string> = {
        ZodString: 'STRING',
        ZodNumber: 'NUMBER',
        ZodBoolean: 'BOOLEAN',
        ZodArray: 'ARRAY',
        ZodObject: 'OBJECT',
      };
      properties[key] = {
        type: typeMap[zodDef.typeName] || 'STRING',
        description: zodDef.description || '',
      };
      if (!(def as any).isOptional?.()) {
        required.push(key);
      }
    }
  }

  return {
    name: tool.name,
    description: tool.description || '',
    parameters: {
      type: 'OBJECT' as const,
      properties,
      required: required.length > 0 ? required : undefined,
    },
  };
}

export async function* runGeminiAgent(
  resolved: ResolvedProvider,
  systemPrompt: string,
  userPrompt: string,
  tools: any[],
  effort?: string,
): AsyncGenerator<AdapterStreamEvent> {
  const apiKey = process.env[resolved.provider.api_key_env];
  if (!apiKey) {
    yield { type: 'error', error: `${resolved.provider.api_key_env} not set` };
    return;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiTools: GeminiTool[] = [];
  const functionDeclarations = tools
    .filter((t) => t.name !== 'bash' || t.type === 'function')
    .map(openaiToolToGemini);

  if (functionDeclarations.length > 0) {
    geminiTools.push({ functionDeclarations });
  }

  const model = genAI.getGenerativeModel({
    model: resolved.model,
    systemInstruction: systemPrompt,
    tools: geminiTools.length > 0 ? geminiTools : undefined,
  });

  const chat = model.startChat({
    history: [],
    ...(effort ? { thinkingConfig: { thinkingBudget: effortToTokens(effort) } } : {}),
  });

  const result = await chat.sendMessageStream(userPrompt);

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) {
      yield { type: 'text_delta', text };
    }

    const candidates = (chunk as any).candidates;
    if (candidates) {
      for (const candidate of candidates) {
        const parts = candidate.content?.parts;
        if (parts) {
          for (const part of parts) {
            if (part.functionCall) {
              const args = part.functionCall.args || {};
              yield { type: 'tool_call', toolName: part.functionCall.name, toolArgs: args };

              const tool = tools.find((t: any) => t.name === part.functionCall.name);
              if (tool) {
                try {
                  const output = await tool.run(args);
                  const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
                  yield { type: 'tool_result', toolOutput: outputStr.substring(0, 200) };
                } catch (err: any) {
                  yield { type: 'tool_result', toolOutput: `Error: ${err.message}` };
                }
              }
            }
          }
        }
      }
    }
  }

  yield { type: 'done' };
}

function effortToTokens(effort: string): number {
  switch (effort) {
    case 'low': return 1024;
    case 'medium': return 4096;
    case 'high': return 8192;
    case 'xhigh': return 16384;
    default: return 4096;
  }
}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/brocode/workspace/skill-pilot-code/core/engine/skill_pilot_agent
npx tsc --noEmit src/providers/gemini.ts
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/providers/gemini.ts
git commit -m "feat: add Gemini adapter with tool translation and effort"
```

---

### Task 7: Create providers.json

**Files:**
- Create: `core/engine/skill_pilot_agent/providers.json`

- [ ] **Step 1: Write providers.json**

```json
{
  "providers": [
    {
      "id": "openai",
      "base_url": "https://api.openai.com/v1",
      "api_key_env": "OPENAI_API_KEY",
      "protocol": "openai",
      "models": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
      "effort_levels": ["low", "medium", "high", "xhigh"]
    },
    {
      "id": "deepseek",
      "base_url": "https://api.deepseek.com/v1",
      "api_key_env": "DEEPSEEK_API_KEY",
      "protocol": "openai",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "effort_levels": []
    },
    {
      "id": "anthropic",
      "base_url": "https://api.anthropic.com/v1",
      "api_key_env": "ANTHROPIC_API_KEY",
      "protocol": "anthropic",
      "models": ["claude-sonnet-4-6", "claude-haiku-4-5"],
      "effort_levels": ["low", "medium", "high", "xhigh"]
    }
  ],
  "default": "openai"
}
```

- [ ] **Step 2: Validate JSON**

```bash
cd /Users/brocode/workspace/skill-pilot-code/core/engine/skill_pilot_agent
node -e "const c = require('./providers.json'); console.log('Valid JSON,', c.providers.length, 'providers, default:', c.default)"
```

Expected: `Valid JSON, 3 providers, default: openai`

- [ ] **Step 3: Commit**

```bash
git add providers.json
git commit -m "feat: add provider config with OpenAI, DeepSeek, Anthropic"
```

---

### Task 8: Modify index.ts — wire provider registry and --effort flag

**Files:**
- Modify: `core/engine/skill_pilot_agent/src/index.ts`

This is the main integration task. Replace the hardcoded single-proxy setup with provider config loading, model resolution, and adapter routing.

- [ ] **Step 1: Add provider imports at top of file**

After the existing imports (line 12: `import { saveSession, ... }`), add:
```typescript
import { loadProviderConfig, resolveModel, listModels } from './providers/config';
import { buildOpenAIAgent, runOpenAIAgent } from './providers/openai';
import { runAnthropicAgent } from './providers/anthropic';
import { runGeminiAgent } from './providers/gemini';
import type { ResolvedProvider } from './providers/types';
```

- [ ] **Step 2: Replace the configuration block (lines 71-82)**

Old code at lines 71-82:
```typescript
// Configuration from environment
const baseURL = process.env.SKILL_PILOT_BASE_URL || 'http://localhost:8000/v1';
const apiKey = process.env.SKILL_PILOT_API_KEY || 'no-key';
const model = options.model;

if (!model) {
  console.error('Error: --model <model> is required (e.g. --model gpt-5.5, --model deepseek-chat)');
  process.exit(1);
}

process.env.OPENAI_BASE_URL = baseURL;
process.env.OPENAI_API_KEY = apiKey;
```

Replace with:
```typescript
// Load provider config (looks for providers.json relative to dist/)
const providersJsonPath = path.resolve(__dirname, '../providers.json');
loadProviderConfig(providersJsonPath);

const model = options.model;
if (!model) {
  const available = listModels().join(', ');
  console.error(`Error: --model <model> is required. Available: ${available}`);
  process.exit(1);
}

const resolved = resolveModel(model);
```

- [ ] **Step 3: Add --effort CLI option**

At line 27 (after `--skills` option), add:
```typescript
  .option('--effort <effort>', 'Reasoning effort: low, medium, high, xhigh')
```

- [ ] **Step 4: Extract effort from options**

After the model resolution block, add:
```typescript
const effort: string | undefined = options.effort || undefined;
```

- [ ] **Step 5: Modify buildAgent() to use resolved provider + effort**

Replace the `buildAgent()` function (lines 199-220) with:
```typescript
function buildAgent(): Agent {
  const instructions = loadInstructions(options.agentDir);
  const skillInstructions = loadSkills(options.agentDir, options.skillsDir, options.skills);

  const multiTurnPrompt = `
When working on a task:
- Ask clarifying questions if anything is ambiguous.
- Report progress as you work — what you found, what you're doing next.
- At the end of each major step, ask the user if they want changes or have follow-up tasks.
- If the user's request is clear, proceed without unnecessary questions.
`;

  const fileTools = createTools(options.agentDir);

  return buildOpenAIAgent(
    resolved,
    instructions + multiTurnPrompt + skillInstructions,
    [bashTool as any, ...fileTools.map((t) => t as any)],
    effort,
  );
}
```

- [ ] **Step 6: Modify runStreaming() to route non-OpenAI adapters**

Before the existing `runStreaming()` function, add a dispatch function:
```typescript
async function runAgentStream(
  prompt: string,
  conversation: AgentInputItem[],
): Promise<AgentInputItem[]> {
  const instructions = loadInstructions(options.agentDir);
  const skillInstructions = loadSkills(options.agentDir, options.skillsDir, options.skills);
  const systemPrompt = instructions + skillInstructions;

  if (resolved.provider.protocol === 'openai') {
    // Use existing @openai/agents path
    const agent = buildAgent();
    const { stream, collectedItems } = await runOpenAIAgent(
      agent,
      prompt,
      conversation,
      maxRetries * 5,
    );
    return await consumeStream(stream, conversation);
  }

  // Non-OpenAI adapters — run custom loop, then handle tool results
  const fileTools = createTools(options.agentDir);
  const allTools = [bashTool as any, ...fileTools.map((t) => t as any)];
  const collectedItems: AgentInputItem[] = [...conversation];

  const adapterStream =
    resolved.provider.protocol === 'anthropic'
      ? runAnthropicAgent(resolved, systemPrompt, prompt, allTools, effort)
      : runGeminiAgent(resolved, systemPrompt, prompt, allTools, effort);

  for await (const event of adapterStream) {
    if (event.type === 'text_delta' && event.text) {
      process.stdout.write(event.text);
    } else if (event.type === 'tool_call') {
      console.log(`\n[TOOL:${event.toolName}] ${JSON.stringify(event.toolArgs)}`);
    } else if (event.type === 'tool_result') {
      console.log(`[RESULT] ${event.toolOutput}`);
    } else if (event.type === 'error') {
      console.error(`\n[ERROR] ${event.error}`);
    }
  }

  console.log('');
  return collectedItems;
}
```

- [ ] **Step 7: Rename runStreaming to consumeStream for the OpenAI path**

Rename the existing `runStreaming()` to `consumeStream()` and remove the `buildAgent`/`run` calls from it — make it just consume a stream:

```typescript
async function consumeStream(
  stream: AsyncIterable<any>,
  conversation: AgentInputItem[],
): Promise<AgentInputItem[]> {
  console.log('');

  const collectedItems: AgentInputItem[] = [...conversation];

  try {
    for await (const event of stream) {
      const evt = event as any;

      if (evt.type === 'raw_model_stream') {
        if (evt.data?.delta) {
          process.stdout.write(evt.data.delta);
        }
      } else if (evt.type === 'run_item_stream') {
        const item = evt.item;
        if (item) {
          collectedItems.push(item);
          if (item.type === 'tool_call') {
            console.log(`\n[TOOL:${item.name}] ${item.arguments?.command || item.arguments?.file_path || ''}`);
          } else if (item.type === 'tool_result') {
            const output = item.output?.substring?.(0, 200) || '';
            console.log(`[RESULT] ${output}`);
          }
        }
      } else if (evt.type === 'agent_updated') {
        // Agent handoff — no-op
      }
    }
  } catch (err: any) {
    if (!err.message?.includes('aborted') && !err.message?.includes('cancelled')) {
      throw err;
    }
  }

  console.log('');
  return collectedItems;
}
```

- [ ] **Step 8: Update main() to use new functions**

In `main()`:
- REPL mode: call `runAgentStream()` instead of `runStreaming()`
- One-shot mode: call `runAgentStream()` instead of `runStreaming()`
- Update startup log to show provider info

Replace the REPL's `prompt` case:
```typescript
case 'prompt':
  console.log('');
  conversation = await runAgentStream(cmd.text, conversation.length > 0 ? conversation : []);
  if (sessionId) saveSession(sessionId, conversation);
  break;
```

Replace one-shot mode:
```typescript
console.log(`Skill Pilot spcode starting session with model: ${model} (provider: ${resolved.provider.id})`);
try {
  const conversation = await runAgentStream(userPrompt, []);
  const sessionId = `session-${Date.now()}`;
  saveSession(sessionId, conversation);
} catch (error: any) {
  console.error('Error during agent execution:', error.message);
  process.exit(1);
}
```

- [ ] **Step 9: Type-check**

```bash
cd /Users/brocode/workspace/skill-pilot-code/core/engine/skill_pilot_agent
npx tsc --noEmit
```

Expected: No errors. Fix any type errors before continuing.

- [ ] **Step 10: Build**

```bash
npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 11: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire provider registry, --effort flag, and adapter routing into agent"
```

---

### Task 9: Integration smoke test

**Files:** None (manual verification)

- [ ] **Step 1: Test --model required still works**

```bash
node dist/index.js "hello" 2>&1
```

Expected: `Error: --model <model> is required. Available: gpt-5.5, gpt-5.4, gpt-5.4-mini, deepseek-chat, deepseek-reasoner, claude-sonnet-4-6, claude-haiku-4-5`

- [ ] **Step 2: Test unknown model errors**

```bash
node dist/index.js --model fake-model "hello" 2>&1
```

Expected: `Error: Unknown model 'fake-model'. Available models: gpt-5.5, ...`

- [ ] **Step 3: Test missing API key errors**

```bash
unset OPENAI_API_KEY
node dist/index.js --model gpt-5.5 "hello" 2>&1
```

Expected: `Error: OPENAI_API_KEY not set. Required by provider 'openai' for model 'gpt-5.5'.`

- [ ] **Step 4: Test --effort flag accepted**

```bash
OPENAI_API_KEY=test-key node dist/index.js --model gpt-5.5 --effort high "hello" 2>&1
```

Expected: Starts with `Skill Pilot spcode starting session with model: gpt-5.5 (provider: openai)`, then fails with connection error (expected — `test-key` is fake).

- [ ] **Step 5: Test deepseek provider (cheapest real API test)**

```bash
# Requires DEEPSEEK_API_KEY set in env
node dist/index.js --model deepseek-chat "what is 2+2?" 2>&1
```

Expected: Agent runs, streams response text, prints answer. (Skip if DEEPSEEK_API_KEY not available.)

- [ ] **Step 6: Test --help shows --effort**

```bash
node dist/index.js --help 2>&1
```

Expected: Output includes `--effort <effort>  Reasoning effort: low, medium, high, xhigh`

- [ ] **Step 7: Commit if all pass**

```bash
git add -A
git commit -m "test: integration smoke test for multi-provider agent"
```

---

### Task 10: Update PR description

**Files:**
- Modify: `PR_DESCRIPTION.md` (or create if absent)

- [ ] **Step 1: Write updated PR description covering all changes**

Include:
- Summary of multi-provider approach
- Architecture diagram reference
- Files changed table
- Test results from Task 9
- How to configure: set provider API keys, use --model and --effort flags

- [ ] **Step 2: Commit**

```bash
git add PR_DESCRIPTION.md
git commit -m "docs: update PR description with multi-provider agent details"
```

---
