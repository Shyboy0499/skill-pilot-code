---
name: run-skill-pilot-code
description: Build, run, and smoke-test the spcode CLI and skill-pilot-agent coding agent
---

# Run: skill-pilot-code

spcode is a local coding agent CLI (fork of OpenAI Codex). The repo contains
two deliverables: the Rust `spcode` binary in `codex-rs/` and the Node.js
`skill-pilot-agent` in `core/engine/skill_pilot_agent/`.

Drive both with the driver script:
`.claude/skills/run-skill-pilot-code/driver.sh`

Paths below are relative to the repo root.

## Prerequisites

- Rust toolchain (rustc, cargo)
- Node.js >= 22
- pnpm (for agent dependencies)

## Build

```bash
cd codex-rs
cargo build --bin spcode
```

Binary lands at `codex-rs/target/debug/spcode`.

## Run (agent path)

```bash
.claude/skills/run-skill-pilot-code/driver.sh
```

Runs 7 smoke tests covering: CLI help/version output, `--skills-dir` and
`--skills` flag acceptance, agent startup with skill loading, and
`--approve-tools` flag presence.

Options: `--build-only` (skip smoke), `--agent-only` (skip Rust build).

## Run (human path)

```bash
cd codex-rs
echo "your prompt" | ./target/debug/spcode exec -
```

The TUI (`cargo run --bin spcode`) requires a real terminal. The non-interactive
`exec` path works with piped input. Without authentication, both paths start and
show config info before hitting a 401 from the API — the CLI itself works.

## Run: skill-pilot-agent

```bash
npx ts-node core/engine/skill_pilot_agent/src/index.ts --skills-dir .agent "hello"
```

Starts, loads skills, attempts LLM connection. Fails with `Connection error`
unless `SKILL_PILOT_BASE_URL` points to a running LLM server — that's expected.

Key flags:
- `--skills-dir <path>` — directory scanned recursively for `SKILL.md` files (default: `.agent`)
- `--skills <list>` — comma-separated skill filter; matches filename, relative path, and parent directory name. Use `none` to disable all.
- `--approve-tools yes` — require y/n/a approval before each bash command (default: `no`)

## Test

```bash
cd codex-rs
cargo test -p codex-core --lib
```

1608 tests pass. 3 pre-existing failures on macOS: config schema fixture
mismatch, network proxy on non-Linux, and a zsh snapshot test.

## Gotchas

- The `spcode` binary in PATH may be the npm `@openai/codex` package (Node.js
  wrapper), not this Rust build. Use the full path `codex-rs/target/debug/spcode`.
- Skill filter matching is three-way: `--skills pirate` matches `pirate.md`
  (by filename), `pirate/SKILL.md` (by parent directory name), and
  `path/to/pirate.md` (by name in path).
- `--skills-dir` resolves relative to `--agent-dir` (defaults to CWD),
  not the script location.
- The agent wrapper at `core/bin/skill-pilot-agent` preserves CWD so
  AGENTS.md and `.agent/` skills resolve from wherever you invoke it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ts-node: command not found` | `cd core/engine/skill_pilot_agent && pnpm install` |
| `Connection error` from agent | No LLM server running at `SKILL_PILOT_BASE_URL` — this is expected in dev |
| `cargo build` fails | `cd codex-rs && cargo fetch` then retry |
