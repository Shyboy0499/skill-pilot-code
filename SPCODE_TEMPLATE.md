# spcode — Skill Pilot Coding Agent

## Quick Start

```bash
# Build
cd codex-rs && cargo build --bin spcode

# REPL / TUI mode
./target/debug/spcode

# One-shot mode
./target/debug/spcode exec "fix all TypeScript errors"

# Code review
./target/debug/spcode review

# Resume last session
./target/debug/spcode resume --last
```

## Auth Setup

```bash
# Login with OpenAI
spcode login

# Or manually edit ~/.spcode/auth.json
{
  "auth_mode": "apikey",
  "OPENAI_API_KEY": "sk-..."
}
```

## Config (~/.codex/config.toml)

```toml
model = "gpt-5.5"
model_reasoning_effort = "xhigh"
personality = "pragmatic"

[projects."/path/to/your/project"]
trust_level = "trusted"
```

## Node.js Agent (alternative — works with DeepSeek)

```bash
cd core/engine/skill_pilot_agent

# Build
npm run build

# REPL mode (interactive)
node dist/index.js --model deepseek-v4-flash

# One-shot
node dist/index.js --model deepseek-v4-flash "your prompt"

# Watch mode (auto-fix on save)
node dist/index.js --watch --model deepseek-v4-flash
```

## REPL Commands

| Command | Action |
|---------|--------|
| `/help` | Show all commands |
| `/models` | List available models (9 models, 4 providers) |
| `/tools` | List available tools (13 tools) |
| `/model <name>` | Switch model at runtime |
| `/fix [paths]` | Run one-shot fix cycle |
| `/watch on [paths]` | Start live coding watch |
| `/watch off` | Stop watching |
| `/watch status` | Show watch stats |
| `/save` | Save session |
| `/load <id>` | Load session |
| `/list` | List saved sessions |
| `/clear` | Reset conversation |
| `/exit` | End session |

## Available Tools

| Tool | What it does |
|------|-------------|
| `read` | Read file contents |
| `write` | Create or overwrite a file |
| `edit` | String replacement in files |
| `glob` | Find files by pattern |
| `grep` | Search file contents |
| `bash` | Execute shell commands |
| `bash_stream` | Execute with real-time streaming output |
| `sandbox` | Isolated sandboxed execution |
| `apply_patch` | Apply V4A diffs |
| `web_fetch` | Fetch URL content |
| `web_search` | DuckDuckGo web search |
| `watch` | Watch files/dirs for changes |
| `watch_file` | Watch single file for modifications |

## Providers & Models

| Provider | Models | Protocol |
|----------|--------|----------|
| OpenAI | gpt-5.5, gpt-5.4, gpt-5.4-mini | Responses API |
| DeepSeek | deepseek-v4-flash, deepseek-v4-pro | Chat Completions |
| Anthropic | claude-sonnet-4-6, claude-haiku-4-5 | Native SDK |
| Gemini | gemini-2.5-flash, gemini-2.5-pro | Native SDK |

## Environment Variables

```bash
DEEPSEEK_API_KEY="sk-..."     # DeepSeek API key
OPENAI_API_KEY="sk-..."       # OpenAI API key
ANTHROPIC_API_KEY="sk-ant-..." # Anthropic API key
GEMINI_API_KEY="..."          # Gemini API key
SPCODE_MODEL="deepseek-v4-flash"  # Default model (for Node.js agent)
```
