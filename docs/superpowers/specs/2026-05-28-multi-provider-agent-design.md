# Multi-Provider Agent with Direct API Access

## Summary

Replace the single-proxy architecture (`SKILL_PILOT_BASE_URL` routes everything) with
direct per-provider API access. The agent resolves a model name to a provider config
(base URL, API key, protocol adapter), calls the native SDK, and emits a unified stream
format the agent core consumes unchanged. Add `--effort` CLI support to match the
Python agent.

## Architecture

```
CLI: --model gpt-5.5 --effort high "do thing"
         │
         ▼
┌─────────────────────────────────────────────────┐
│  Provider Registry                              │
│  model → provider → (base URL, key, adapter)     │
└─────────────────────────────────────────────────┘
         │                    │
   openai protocol     anthropic / gemini protocol
   (pass-through)      (adapter translates)
         │                    │
┌────────▼────────┐  ┌────────▼────────┐
│ @openai/agents  │  │ Anthropic SDK    │
│ (DeepSeek, etc) │  │ Gemini SDK       │
└─────────────────┘  └──────────────────┘
         │                    │
         └────────┬───────────┘
                  ▼
         Unified stream events:
         { type: "text_delta" | "tool_call" | "tool_result", ... }
```

The agent loop never touches provider-specific code. Adding a new provider requires
one adapter + one config entry.

## Provider Config

File: `providers.json` (shipped alongside the agent).

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

- `api_key_env` names an environment variable — secrets never in the config file.
- `protocol` selects the adapter: `openai` (pass-through), `anthropic`, `gemini`.
- `effort_levels` advertises what the provider supports; `[]` means none.

## CLI Changes

Add `--effort` flag:

```
Options:
  --model <model>           Model name (required)
  --effort <effort>         Reasoning effort: low, medium, high, xhigh
```

- `--model` remains required.
- `--effort` is optional. When set, passed to the adapter as `reasoning.effort`.
  When unset, the adapter omits it (provider default).

## Data Flow (session lifecycle)

1. **Startup** — agent loads `providers.json`, builds a flat `model → provider` map.
2. **Resolve** — `--model claude-sonnet-4-6` matches provider `anthropic`.
   Read `ANTHROPIC_API_KEY` from env. Select `AnthropicAdapter`.
3. **Run** — adapter takes `(model, prompt, tools, effort)` and emits unified events:
   ```
   { type: "text_delta", text: "I'll look at that bug..." }
   { type: "tool_call", name: "bash", args: { command: "cat src/main.rs" } }
   { type: "tool_result", output: "fn main() { ... }" }
   { type: "text_delta", text: "Found it. The issue is..." }
   ```
4. **Agent consumes stream** — same format regardless of provider. No provider
   awareness in the agent loop.

## Adapters

### OpenAI Adapter (openai protocol)

Pass-through. Sets `OPENAI_BASE_URL` and `OPENAI_API_KEY` to the provider's values,
then delegates to the existing `@openai/agents` SDK. Works for OpenAI, DeepSeek,
Groq, and any OpenAI-compatible endpoint.

Reasoning effort: passed as `ModelSettings.reasoning.effort` (same as Python agent).

### Anthropic Adapter (anthropic protocol)

Translates between the agent's internal format and the Anthropic SDK:

- **Tools**: converted from OpenAI tool schema to Anthropic tool format.
- **Messages**: converted from the agent's message format to Anthropic content blocks.
- **Streaming**: Anthropic SSE events mapped to unified `{ type, text/tool }` events.
- **Reasoning effort**: set on the Anthropic `thinking` parameter.

### Gemini Adapter (gemini protocol)

Translates to/from Google's Gemini SDK:

- **Tools**: converted to Gemini `FunctionDeclaration` format.
- **Streaming**: Gemini `GenerateContentResponse` chunks mapped to unified events.
- **Reasoning effort**: mapped to Gemini's `thinking_config`.

## Error Handling

| Failure | Behavior |
|---------|----------|
| Unknown model | `Error: Unknown model 'xyz'. Available: gpt-5.5, deepseek-chat, ...` |
| API key not set | `Error: ANTHROPIC_API_KEY not set. Required by provider 'anthropic' for model 'claude-sonnet-4-6'.` |
| Provider API error | Surface as stream error — agent already handles connection failures |
| Config file missing/malformed | Agent exits with parse error pointing to the file |

No silent fallbacks. Wrong model or missing key fails loudly.

## Files Changed

| File | Change |
|------|--------|
| `providers.json` | New — provider configuration shipped with the agent |
| `src/index.ts` | Add `--effort` flag, load config, resolve model → provider → adapter |
| `src/providers/config.ts` | New — load, validate, and index provider config |
| `src/providers/openai.ts` | New — OpenAI-compatible adapter (pass-through) |
| `src/providers/anthropic.ts` | New — Anthropic adapter with translation layer |
| `src/providers/gemini.ts` | New — Gemini adapter with translation layer |

## Testing Strategy

- **Unit**: each adapter translates input/output correctly (mock SDK calls, no live API).
- **Integration**: `--model deepseek-chat` with `DEEPSEEK_API_KEY` → real agent run
  (cheapest provider for testing).
- **CLI smoke**: missing `--model` errors, `--effort` accepted, unknown model errors.
- **Config**: missing file, malformed JSON, missing `api_key_env` — all error cleanly.
