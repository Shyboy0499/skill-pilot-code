# Live Coding Mode — Design Spec

> Auto-fix on file changes: watch → detect → fix → test → commit loop.

## Architecture

Two new pieces, both in the existing agent CLI:

| Component | Role |
|-----------|------|
| `--watch` CLI flag | Starts file watcher, debounces changes, spawns one-shot agent per change batch |
| `/watch [on|off|status]` REPL command | Start/stop/check watching from within a REPL session |

No new process or daemon — `--watch` mode is a mode of the agent CLI. Uses the existing `watch`/`watch_file` tools internally to monitor files, then shells out to itself (`node dist/index.js`) for each fix cycle.

```
┌─────────────────────────────────────────────────────┐
│                    Terminal                          │
│  $ node dist/index.js --watch                        │
│  Watching src/ for changes... (Ctrl+C to stop)      │
│                                                      │
│  [change] src/tools/web.ts                           │
│  → Agent fixing...                                   │
│  → Fixed 2 type errors                               │
│  → Tests: 8/8 passed                                 │
│  → Committed: fix(auto): resolve type errors in web  │
│  → Waiting for changes...                            │
└─────────────────────────────────────────────────────┘
```

## Watch Loop

```
File saved
    │
    ▼
┌──────────────────┐
│ Debounce (2s)    │  collects rapid saves into one batch
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Batch changes    │  group files changed within debounce window
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Spawn one-shot   │  node dist/index.js --model <current> "fix project"
│ agent process    │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Agent runs       │  read → analyze → edit → write → bash(tsc) → bash(test)
│ auto-fix cycle   │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Success?         │───NO──→ log errors, retry (max 3), keep watching
└──────┬───────────┘
       │ YES
       ▼
┌──────────────────┐
│ git add + commit │  conventional commit: fix(auto): <summary>
└──────┬───────────┘
       │
       ▼
   back to watching
```

### Key parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Debounce window | 2s | Batches rapid saves |
| Max retries | 3 | Fix attempts per change batch |
| Commit message | `fix(auto): <summary>` | Conventional commit format |

## CLI Interface

```
# Start watching immediately
node dist/index.js --watch --model deepseek-v4-flash

# With full config
node dist/index.js --watch --model deepseek-v4-flash \
  --watch-paths "src/,tests/" \
  --watch-debounce 3000 \
  --watch-max-retries 5 \
  --watch-auto-commit true

# Start from REPL
> /watch on
Watching src/ for changes...
> /watch off
Stopped watching.
> /watch status
Watching: src/ | Debounce: 2000ms | Auto-commit: on
```

### CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--watch` | off | Enable watch mode on startup |
| `--watch-paths` | `src/` | Comma-separated paths to watch |
| `--watch-debounce` | `2000` | Debounce window in ms |
| `--watch-max-retries` | `3` | Max fix attempts per change batch |
| `--watch-auto-commit` | `true` | Auto-commit after successful fix |

### REPL commands

| Command | What it does |
|---------|-------------|
| `/watch on [paths]` | Start watching (optional custom paths) |
| `/watch off` | Stop watching |
| `/watch status` | Show watch config |

## Agent Invocation

Per change batch, the watcher spawns a one-shot agent:

```
node dist/index.js --model <current-model> --approve-tools no \
  "Fix ALL issues in the project. Check each of these:
   1. TypeScript compilation: run 'npx tsc --noEmit' and fix all errors
   2. Tests: run 'npm test' and fix any failures
   3. Broken imports: fix any import paths that are wrong
   4. Lint errors: fix any lint violations
   Changed files: <list of changed file paths>
   After fixing: verify with tsc and tests, then report results."
```

The spawned agent gets:
- The current model (inherits from the watcher session)
- The same API key (passed via env)
- Tool approval disabled (`--approve-tools no`) for fully autonomous operation
- A structured prompt listing what to check
- The list of changed files as context

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Agent fix fails (nonzero exit) | Log error, increment retry counter. After max retries: log "giving up" and keep watching |
| Agent exceeds max turns | Counts as one retry. Try again after next change |
| `tsc` has no errors | Skip agent invocation — nothing to fix |
| Commit fails (no changes) | Skip, keep watching |
| Watched path deleted | Log warning, remove from watch list |
| Multiple saves during agent run | Queue changes, process sequentially after current fix |
| Ctrl+C | Graceful shutdown: log session stats (files watched, fixes applied, commits made), exit 0 |
| Agent process crash | Catch, log stack trace, retry if under max |
| API rate limit | Add exponential backoff (1s → 2s → 4s → 8s) between retries |

## Files

| File | Change | Purpose |
|------|--------|---------|
| `src/index.ts` | Modify | Add `--watch` flags, `/watch` REPL command, watch loop logic |
| `src/watcher.ts` | Create | File watcher with debounce, batch collection, agent spawning, retry logic |
| `src/repl.ts` | Modify | Add `{ type: 'watch-on'; paths?: string[] }`, `{ type: 'watch-off' }`, `{ type: 'watch-status' }` to ReplCommand |

## Non-Goals

- No remote file watching (local filesystem only)
- No multi-branch git operations (commit to current branch only)
- No test generation (runs existing tests, doesn't write new ones)
- No notification system (terminal output only)
- No configuration file persistence (all config via CLI flags)
