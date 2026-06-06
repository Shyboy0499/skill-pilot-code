# Skill Pilot Agent — Demo Script

> Follow this script in order. Each section builds on the last.
> Estimated runtime: 8-12 minutes.

## Setup (before recording)

```bash
export DEEPSEEK_API_KEY="sk-..."  # Replace with your actual key
cd core/engine/skill_pilot_agent
npm run build
```

---

## ACT 1: First Impressions (60s)

```bash
# Show --help with examples
node dist/index.js --help
```

**Narrate:** "14 flags, 5 usage examples, 4 providers, environment variables — everything documented."

```bash
# One-shot: simple question
node dist/index.js --model deepseek-v4-flash "what is the capital of France? answer in 3 words"
```

**Narrate:** "One-shot mode. Single prompt, single response. Fast."

```bash
# One-shot: coding task
node dist/index.js --model deepseek-v4-flash "write a python function that checks if a string is a palindrome"
```

**Narrate:** "Real coding task. The agent writes working code."

---

## ACT 2: Tools in Action (90s)

```bash
# Read a file
node dist/index.js --model deepseek-v4-flash "read package.json and tell me what dependencies are listed"
```

**Narrate:** "Tools. The agent reads actual files on disk — this isn't hallucinated."

```bash
# Bash execution
node dist/index.js --model deepseek-v4-flash "use bash to list all .ts files under src/ recursively"
```

**Narrate:** "Shell commands. It can run anything — ls, grep, npm, git."

```bash
# Web search
node dist/index.js --model deepseek-v4-flash "use web_search to find the latest React version"
```

**Narrate:** "Web search. No API key needed — DuckDuckGo. And web_fetch can read any URL."

```bash
# Multi-step: read + edit + write
echo "hello world" > demo.txt
node dist/index.js --model deepseek-v4-flash "1. read demo.txt, 2. use edit to replace hello with goodbye, 3. read it again to verify"
cat demo.txt
rm demo.txt
```

**Narrate:** "Multi-tool workflows. Read, edit, verify — all in one prompt. Three tools, one command."

---

## ACT 3: REPL Mode (90s)

```bash
# Launch REPL
node dist/index.js --model deepseek-v4-flash
```

**Type these commands during recording:**

```
/models
```
**Narrate:** "9 models across 4 providers. See which one is active."

```
/tools
```
**Narrate:** "13 tools. From file operations to web search to sandboxed execution."

```
read the file src/tools/web.ts and tell me what it exports
```
**Narrate:** "The agent uses the read tool to inspect source code. Real file, real content."

```
what other tools are defined in the src/tools/ directory?
```
**Narrate:** "Multi-turn context. It remembers the previous question."

```
/model deepseek-v4-pro
```
**Narrate:** "Switch models at runtime. From flash to pro — more reasoning power."

```
what model are you using now?
```

```
/model deepseek-v4-flash
/clear
```
**Narrate:** "Switch back and clear. Full control."

```
/fix
```
**Narrate:** "Manual fix cycle. Runs a one-shot agent to check and fix the project."

```
/exit
```

---

## ACT 4: Live Coding Mode (90s)

```bash
# Start watch mode in one terminal
node dist/index.js --watch --model deepseek-v4-flash --watch-auto-commit no
```

**In another terminal while recording:**

```bash
# Create a file with an intentional TypeScript error
echo "const x: number = 'this is wrong';" > src/bad.ts

# Watch the first terminal — agent detects change and spawns fix agent
```

**Narrate:** "Live coding mode. I just created a file with a type error. The agent detected the change, spawned itself, analyzed the file, and fixed it. All autonomous."

**After fix runs:**

```bash
# Clean up
rm src/bad.ts
# Press Ctrl+C in watch terminal
```

---

## ACT 5: Advanced Features (60s)

```bash
# Effort levels
node dist/index.js --model deepseek-v4-flash --effort low "explain recursion in one sentence"
node dist/index.js --model deepseek-v4-flash --effort xhigh "explain recursion in one sentence"
```

**Narrate:** "Effort levels. Low for fast answers, xhigh for deep reasoning. Same model, different depth."

```bash
# Sandboxed execution
node dist/index.js --model deepseek-v4-flash "use the sandbox tool to run: echo isolated && pwd"
```

**Narrate:** "Sandbox. Commands run in isolated temp directories with resource limits and network blocking."

```bash
# Streaming bash
node dist/index.js --model deepseek-v4-flash "use bash_stream to run: for i in 1 2 3; do echo step \$i; sleep 0.3; done"
```

**Narrate:** "Streaming output. Watch the steps appear in real-time — no waiting for the command to finish."

```bash
# Model suggestion on typo
node dist/index.js --model deepseek-v4-flsh "test" 2>&1 | head -3
```

**Narrate:** "Smart error handling. Typo'd the model name? It suggests the closest match."

---

## ACT 6: Closing (30s)

```bash
# Provider list
node dist/index.js "test" 2>&1 | head -3
```

**Narrate:** "Four providers: OpenAI, DeepSeek, Anthropic, Gemini. Add one API key and switch anytime."

```bash
# Show the quick-start script
cat run-agent.sh | head -15
```

**Narrate:** "One command to get started. The whole project is at github.com/Shyboy0499/skill-pilot-code."

```bash
# Show commit count
git log --oneline | wc -l
```

**Narrate:** "40+ commits. Built from scratch. Open source."

---

## Quick Reference Card

| Feature | Command |
|---------|---------|
| One-shot | `node dist/index.js --model deepseek-v4-flash "prompt"` |
| REPL | `node dist/index.js --model deepseek-v4-flash` |
| Watch mode | `node dist/index.js --watch --model deepseek-v4-flash` |
| List models | `/models` (in REPL) |
| List tools | `/tools` (in REPL) |
| Switch model | `/model deepseek-v4-pro` (in REPL) |
| Manual fix | `/fix` (in REPL) |
| Effort levels | `--effort low\|medium\|high\|xhigh` |
| MCP server | `--mcp-server '{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}'` |
