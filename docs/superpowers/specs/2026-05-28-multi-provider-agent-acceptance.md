# Multi-Provider Agent — Acceptance Tests

> Updated 2026-05-28 to replace single-proxy (`SKILL_PILOT_BASE_URL`) tests with multi-provider architecture.

---

## Architecture Recap

- `--model` selects the model → `providers.json` maps it to a provider → provider config determines protocol adapter, base URL, and API key env var.
- No proxy. No fallback. No mode switching. Wrong model or missing key fails loudly.
- Three protocols: `openai` (pass-through via `@openai/agents`), `anthropic` (native SDK), `gemini` (native SDK).

---

### 1. Model is required — missing `--model` shows available models

**Condition:** `--model` is not passed.

**Command:**
```bash
node dist/index.js "hello"
```

**Expected:**
- Exit code 1.
- Error lists all models from `providers.json`:
  ```
  Error: --model <model> is required. Available: gpt-5.5, gpt-5.4, gpt-5.4-mini, deepseek-chat, deepseek-reasoner, claude-sonnet-4-6, claude-haiku-4-5, gemini-2.5-flash, gemini-2.5-pro
  ```

---

### 2. Unknown model errors with full list

**Condition:** `--model` specifies a model not in `providers.json`.

**Command:**
```bash
node dist/index.js --model fake-model "hello"
```

**Expected:**
- Exit code 1.
- Error names every available model:
  ```
  Error: Unknown model 'fake-model'. Available models: gpt-5.5, gpt-5.4, ...
  ```

---

### 3. Missing API key per provider

**Condition:** Provider's required `api_key_env` is not set. Each provider fails independently.

**Commands:**
```bash
unset OPENAI_API_KEY
node dist/index.js --model gpt-5.5 "hello"

unset ANTHROPIC_API_KEY
node dist/index.js --model claude-sonnet-4-6 "hello"

unset GEMINI_API_KEY
node dist/index.js --model gemini-2.5-flash "hello"

unset DEEPSEEK_API_KEY
node dist/index.js --model deepseek-chat "hello"
```

**Expected (each):**
- Exit code 1.
- Error names the exact env var, provider, and model:
  ```
  Error: OPENAI_API_KEY not set. Required by provider 'openai' for model 'gpt-5.5'.
  Error: ANTHROPIC_API_KEY not set. Required by provider 'anthropic' for model 'claude-sonnet-4-6'.
  Error: GEMINI_API_KEY not set. Required by provider 'gemini' for model 'gemini-2.5-flash'.
  Error: DEEPSEEK_API_KEY not set. Required by provider 'deepseek' for model 'deepseek-chat'.
  ```

---

### 4. Invalid API key surfaces provider error — no fallback

**Condition:** API key is set but invalid. Provider's native SDK returns an auth error.

**Commands:**
```bash
OPENAI_API_KEY=bad-key node dist/index.js --model gpt-5.5 "hello"
ANTHROPIC_API_KEY=bad-key node dist/index.js --model claude-sonnet-4-6 "hello"
GEMINI_API_KEY=bad-key node dist/index.js --model gemini-2.5-flash "hello"
```

**Expected:**
- Startup log shows correct provider: `Skill Pilot spcode starting session with model: gpt-5.5 (provider: openai)`
- Provider API returns auth error (OpenAI: 401, Anthropic: 404, Gemini: 400).
- Error message includes provider name — makes it clear which API rejected the key.
- Does NOT fall back to another provider. Does NOT prompt for a different key. Does NOT show an OpenAI sign-in option.

---

### 5. Provider routing — each protocol hits the correct API

**Condition:** Valid-looking API keys set. The agent routes to the correct adapter based on `protocol` in `providers.json`.

**Commands:**
```bash
OPENAI_API_KEY=sk-test node dist/index.js --model gpt-5.5 "test"
DEEPSEEK_API_KEY=sk-test node dist/index.js --model deepseek-chat "test"
ANTHROPIC_API_KEY=sk-ant-test node dist/index.js --model claude-sonnet-4-6 "test"
GEMINI_API_KEY=test node dist/index.js --model gemini-2.5-flash "test"
```

**Expected:**
- Each startup log shows the correct `(provider: <id>)`.
- OpenAI + DeepSeek: error comes from the OpenAI-compatible endpoint (both use `protocol: "openai"`).
- Anthropic: error comes from `api.anthropic.com` — the native Anthropic SDK is in use.
- Gemini: error comes from `generativelanguage.googleapis.com` — the native Gemini SDK is in use.

---

### 6. `--effort` flag is accepted and passed to supporting providers

**Condition:** `--effort` is set to a valid level (`low`, `medium`, `high`, `xhigh`).

**Commands:**
```bash
OPENAI_API_KEY=sk-test node dist/index.js --model gpt-5.5 --effort high "test"
ANTHROPIC_API_KEY=sk-ant-test node dist/index.js --model claude-sonnet-4-6 --effort medium "test"
```

**Expected:**
- No warning about effort — both OpenAI and Anthropic have `effort_levels` that include `high`/`medium`.
- Agent starts normally, reaches the provider API.

---

### 7. `--effort` warns when provider doesn't support it

**Condition:** `--effort` is set but the provider's `effort_levels` is empty.

**Command:**
```bash
DEEPSEEK_API_KEY=sk-test node dist/index.js --model deepseek-chat --effort high "test"
```

**Expected:**
- Warning is printed to stderr BEFORE the startup log:
  ```
  Warning: --effort high ignored. Provider 'deepseek' does not support reasoning effort.
  ```
- Agent proceeds normally (effort is dropped, not a hard error).
- Exit code 0 (assuming valid key — error would be from API, not from effort).

---

### 8. `--effort` with empty or invalid value is silently ignored

**Condition:** `--effort` is passed with an empty string or unrecognized value.

**Commands:**
```bash
OPENAI_API_KEY=sk-test node dist/index.js --model gpt-5.5 --effort "" "test"
OPENAI_API_KEY=sk-test node dist/index.js --model gpt-5.5 --effort mega "test"
```

**Expected:**
- Empty string: treated as unset (no warning, no crash).
- Unrecognized value: passed to adapter, which checks against `effort_levels` and ignores it. No crash.
- Agent starts normally in both cases.

---

### 9. `--providers-config` loads a custom config file

**Condition:** A custom `providers.json` exists at a non-default path.

**Command:**
```bash
node dist/index.js --providers-config ./custom-providers.json --model some-model "test"
```

**Expected:**
- If file exists and is valid JSON: models from that file are used. Unknown model error lists models from the custom config.
- If file doesn't exist: `Error: Provider config not found at <path>`.
- If file has invalid JSON: `Error: Invalid JSON in provider config at <path>`.

---

### 10. `--providers-config` defaults to `providers.json` next to dist

**Condition:** `--providers-config` is not passed.

**Command:**
```bash
OPENAI_API_KEY=sk-test node dist/index.js --model gpt-5.5 "test"
```

**Expected:**
- Loads `providers.json` from the repo root (resolved relative to `dist/`).
- Models from the default config are available.

---

### 11. Existing flags still work alongside new provider flags

**Condition:** Old flags combined with new provider flags.

**Command:**
```bash
OPENAI_API_KEY=sk-test node dist/index.js \
  --model gpt-5.5 \
  --effort medium \
  --skills-dir .agent \
  --skills all \
  --max-retries 2 \
  --timeout 30 \
  --approve-tools no \
  "test prompt"
```

**Expected:**
- All flags parse without error.
- Startup log shows `(provider: openai)`.
- `--skills-dir` and `--skills` are accepted (no "unknown option" error).
- `--approve-tools` is accepted.
- `--timeout` and `--max-retries` are accepted with valid values.
- Agent reaches provider API.

---

### 12. `--help` shows all new flags

**Command:**
```bash
node dist/index.js --help
```

**Expected output includes:**
```
--model <model>            Override the default model
--effort <effort>          Reasoning effort: low, medium, high, xhigh
--providers-config <path>  Path to providers.json config file
--skills-dir <path>        Skills directory (default: ".agent")
--skills <skills>          Allowed skills
--approve-tools <yes|no>   Require approval before running bash commands
```

---

### 13. No proxy fallback — `SKILL_PILOT_BASE_URL` is ignored

**Condition:** `SKILL_PILOT_BASE_URL` is set (leftover from old architecture).

**Command:**
```bash
SKILL_PILOT_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=sk-test node dist/index.js --model gpt-5.5 "test"
```

**Expected:**
- `SKILL_PILOT_BASE_URL` has no effect. The agent does not read it.
- The OpenAI adapter sets `OPENAI_BASE_URL` to the provider's configured `base_url` from `providers.json` (`https://api.openai.com/v1`), not to `SKILL_PILOT_BASE_URL`.
- Agent connects to `api.openai.com`, not `localhost:8000`.

---

### 14. `--timeout` and `--max-retries` validation still works

**Commands:**
```bash
node dist/index.js --model gpt-5.5 --timeout -1 "test"
node dist/index.js --model gpt-5.5 --max-retries 0 "test"
node dist/index.js --model gpt-5.5 --timeout abc "test"
```

**Expected:**
- Invalid `--timeout`: `Invalid --timeout value: ... Must be a positive number.`
- Invalid `--max-retries`: `Invalid --max-retries value: ... Must be a positive number.`
- Exit code 1 in all cases.
- Does NOT reach the provider API (fails before model resolution).

---

## Non-Goals (explicitly NOT supported)

- **No `/models` interactive picker** — model selection is via `--model` CLI flag only. The TUI model browser is in the Rust `spcode` binary, not the Node.js agent.
- **No mode switching at runtime** — provider is fixed per invocation based on `--model`. No session-level provider changes.
- **No automatic fallback** — if one provider's API is unreachable, the agent does not try another provider. The error is surfaced directly.
- **No key prompt** — missing API keys exit with an error message naming the env var. The agent does not prompt interactively for keys.
