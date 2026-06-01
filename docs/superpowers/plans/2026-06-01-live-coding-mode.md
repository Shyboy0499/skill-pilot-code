# Live Coding Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--watch` mode and `/watch` REPL commands so the agent monitors file changes, auto-fixes TypeScript/lint/test errors, and commits.

**Architecture:** A `WatchLoop` class in `src/watcher.ts` uses `fs.watch` to monitor paths with debounce, batches changed files, spawns a one-shot agent process (`node dist/index.js`) per batch, and optionally `git commit`s on success. CLI flags wire the watcher into startup, and REPL commands start/stop it from a session.

**Tech Stack:** Node.js built-ins (`fs`, `child_process`, `path`), existing `commander` CLI, existing `@openai/agents` SDK (indirectly via one-shot spawn)

---

### Task 1: Add `/watch` commands to REPL

**Files:**
- Modify: `core/engine/skill_pilot_agent/src/repl.ts` (all changes)

- [ ] **Step 1: Add watch command types to ReplCommand union**

In `src/repl.ts`, add three new types to the `ReplCommand` union (after the `switch-model` line):

```typescript
export type ReplCommand =
  | { type: 'prompt'; text: string }
  | { type: 'exit' }
  | { type: 'clear' }
  | { type: 'save' }
  | { type: 'load'; id: string }
  | { type: 'list' }
  | { type: 'fork'; id: string }
  | { type: 'help' }
  | { type: 'models' }
  | { type: 'tools' }
  | { type: 'switch-model'; model: string }
  | { type: 'watch-on'; paths?: string[] }
  | { type: 'watch-off' }
  | { type: 'watch-status' };
```

- [ ] **Step 2: Add `/watch` to the welcome banner**

In the `startRepl` function, add a line to the welcome banner (after the `/model` line):

```typescript
console.log('  /model <name>  Switch to a different model');
console.log('  /watch [on|off] Start/stop live coding watch mode');
```

- [ ] **Step 3: Add `/watch` command parsing**

In the `rl.on('line', ...)` handler, add parsing for the three watch commands (after the `/model` parsing, before the `else` fallback):

```typescript
} else if (trimmed === '/watch on' || trimmed === '/watch') {
  cmd = { type: 'watch-on' };
} else if (trimmed.startsWith('/watch on ')) {
  const paths = trimmed.slice(10).trim().split(',').map(p => p.trim()).filter(Boolean);
  cmd = { type: 'watch-on', paths };
} else if (trimmed === '/watch off') {
  cmd = { type: 'watch-off' };
} else if (trimmed === '/watch status') {
  cmd = { type: 'watch-status' };
} else {
```

- [ ] **Step 4: Build and verify**

Run: `cd core/engine/skill_pilot_agent && npm run build`
Expected: `tsc` exits 0, no type errors.

- [ ] **Step 5: Commit**

```bash
git add core/engine/skill_pilot_agent/src/repl.ts
git commit -m "feat(repl): add /watch on|off|status command parsing"
```

---

### Task 2: Create `WatchLoop` class

**Files:**
- Create: `core/engine/skill_pilot_agent/src/watcher.ts`

- [ ] **Step 1: Create the file with imports and interfaces**

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';

export interface WatchConfig {
  paths: string[];
  debounceMs: number;
  maxRetries: number;
  autoCommit: boolean;
  model: string;
  agentDir: string;
}

interface PendingFix {
  changedFiles: Set<string>;
  retries: number;
}

export class WatchLoop {
  private config: WatchConfig;
  private watchers: fs.FSWatcher[] = [];
  private pending: PendingFix | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fixQueue: string[][] = [];
  private running = false;
  private stats = { filesWatched: 0, fixesApplied: 0, commitsMade: 0 };
```

- [ ] **Step 2: Implement constructor and start/stop methods**

```typescript
  constructor(config: WatchConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.error(`\nWatching ${this.config.paths.join(', ')} for changes... (Ctrl+C to stop)`);
    console.error(`  Debounce: ${this.config.debounceMs}ms | Max retries: ${this.config.maxRetries} | Auto-commit: ${this.config.autoCommit}\n`);

    for (const watchPath of this.config.paths) {
      const resolved = path.resolve(this.config.agentDir, watchPath);
      if (!fs.existsSync(resolved)) {
        console.error(`Warning: watch path not found: ${watchPath}`);
        continue;
      }

      try {
        const watcher = fs.watch(resolved, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          const fullPath = path.join(resolved, filename);
          this.onChange(fullPath);
        });

        watcher.on('error', (err) => {
          console.error(`Watch error on ${watchPath}: ${err.message}`);
        });

        this.watchers.push(watcher);
        this.stats.filesWatched++;
      } catch (err: any) {
        console.error(`Failed to watch ${watchPath}: ${err.message}`);
      }
    }
  }

  stop(): void {
    this.running = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const w of this.watchers) w.close();
    this.watchers = [];

    console.error(`\nWatch stopped. Stats: ${this.stats.filesWatched} paths watched, ${this.stats.fixesApplied} fixes applied, ${this.stats.commitsMade} commits made.`);
  }
```

- [ ] **Step 3: Implement debounce and change batching**

```typescript
  private onChange(filePath: string): void {
    if (!this.running) return;

    if (!this.pending) {
      this.pending = { changedFiles: new Set(), retries: 0 };
    }

    this.pending.changedFiles.add(path.relative(this.config.agentDir, filePath));

    // Debounce: reset timer on each change
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.flushPending();
    }, this.config.debounceMs);
  }

  private async flushPending(): Promise<void> {
    if (!this.pending || this.pending.changedFiles.size === 0) return;

    const files = Array.from(this.pending.changedFiles);
    console.error(`\n[change] ${files.join(', ')}`);

    // If currently running a fix, queue this batch
    if (this.fixQueue.length > 0 || this.running) {
      this.fixQueue.push(files);
      this.pending = null;
      return;
    }

    await this.runFixCycle(files);
  }
```

- [ ] **Step 4: Implement fix cycle (spawn agent, retry, commit)**

```typescript
  private async runFixCycle(files: string[]): Promise<void> {
    const prompt = this.buildFixPrompt(files);
    let success = false;

    for (let attempt = 0; attempt < this.config.maxRetries && !success; attempt++) {
      if (attempt > 0) {
        console.error(`  Retry ${attempt}/${this.config.maxRetries}...`);
      }

      try {
        const result = await this.spawnAgent(prompt);
        success = result.exitCode === 0;
        if (success) {
          this.stats.fixesApplied++;
        } else {
          console.error(`  Agent exited with code ${result.exitCode}`);
        }
      } catch (err: any) {
        console.error(`  Agent crash: ${err.message}`);
      }
    }

    if (!success) {
      console.error(`  Giving up after ${this.config.maxRetries} attempts.`);
      this.pending = null;
      this.processQueue();
      return;
    }

    // Try to commit
    if (this.config.autoCommit) {
      try {
        await this.gitCommit(files);
        this.stats.commitsMade++;
      } catch (err: any) {
        console.error(`  Commit failed: ${err.message}`);
      }
    }

    this.pending = null;
    console.error(`  Waiting for changes...\n`);
    this.processQueue();
  }
```

- [ ] **Step 5: Implement agent spawning**

```typescript
  private buildFixPrompt(files: string[]): string {
    return `Fix ALL issues in the project. Check each of these:
1. TypeScript compilation: run 'npx tsc --noEmit' and fix all errors
2. Tests: run 'npm test' and fix any failures
3. Broken imports: fix any import paths that are wrong
4. Lint errors: fix any lint violations

Changed files: ${files.join(', ')}

After fixing: verify with tsc and tests, then report: "FIXED: <summary>" if successful or "FAILED: <reason>" if unable to fix.`;
  }

  private spawnAgent(prompt: string): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      // Pass the current model's API key
      const child = spawn('node', [
        path.resolve(__dirname, '../dist/index.js'),
        '--model', this.config.model,
        '--agent-dir', this.config.agentDir,
        '--approve-tools', 'no',
        '--max-retries', '10',
        '--timeout', '120',
        prompt,
      ], {
        cwd: this.config.agentDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        process.stdout.write(text);
        output += text;
      });

      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        process.stderr.write(text);
        output += text;
      });

      child.on('close', (code) => {
        resolve({ exitCode: code, output });
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }
```

- [ ] **Step 6: Implement git commit**

```typescript
  private async gitCommit(files: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const gitAdd = spawn('git', ['add', ...files], {
        cwd: this.config.agentDir,
        stdio: 'pipe',
      });

      gitAdd.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`git add failed with code ${code}`));
          return;
        }

        const shortFiles = files.map(f => path.basename(f)).join(', ');
        const msg = `fix(auto): resolve issues in ${shortFiles}`;

        const gitCommit = spawn('git', ['commit', '-m', msg], {
          cwd: this.config.agentDir,
          stdio: 'pipe',
        });

        let commitOutput = '';
        gitCommit.stdout.on('data', (d: Buffer) => { commitOutput += d.toString(); });
        gitCommit.stderr.on('data', (d: Buffer) => { commitOutput += d.toString(); });

        gitCommit.on('close', (commitCode) => {
          if (commitCode === 0) {
            console.error(`  Committed: ${msg}`);
            resolve();
          } else if (commitOutput.includes('nothing to commit')) {
            resolve(); // No changes — not an error
          } else {
            reject(new Error(`git commit failed: ${commitOutput.trim()}`));
          }
        });
      });

      gitAdd.on('error', reject);
    });
  }
```

- [ ] **Step 7: Implement queue processing and status**

```typescript
  private processQueue(): void {
    if (this.fixQueue.length > 0 && this.running) {
      const next = this.fixQueue.shift()!;
      this.runFixCycle(next);
    }
  }

  getStatus(): string {
    return `Watching: ${this.config.paths.join(', ')} | Debounce: ${this.config.debounceMs}ms | Auto-commit: ${this.config.autoCommit} | Fixes: ${this.stats.fixesApplied} | Commits: ${this.stats.commitsMade}`;
  }

  isRunning(): boolean {
    return this.running;
  }
}
```

- [ ] **Step 8: Build and verify**

Run: `cd core/engine/skill_pilot_agent && npm run build`
Expected: `tsc` exits 0, no type errors. File `dist/watcher.js` created.

- [ ] **Step 9: Commit**

```bash
git add core/engine/skill_pilot_agent/src/watcher.ts
git commit -m "feat: add WatchLoop class for live coding mode"
```

---

### Task 3: Wire `--watch` flags and `/watch` handlers into index.ts

**Files:**
- Modify: `core/engine/skill_pilot_agent/src/index.ts` (add CLI flags, import watcher, add REPL handlers, add watch startup in main)

- [ ] **Step 1: Add CLI flags to program**

In `src/index.ts`, add five new `.option()` calls after `--mcp-server` and before `.argument()`:

```typescript
  .option('--mcp-server <json>', 'MCP server config: {"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}')
  .option('--watch', 'Enable live coding watch mode')
  .option('--watch-paths <paths>', 'Comma-separated paths to watch', 'src/')
  .option('--watch-debounce <ms>', 'Debounce window in ms', '2000')
  .option('--watch-max-retries <number>', 'Max fix attempts per change batch', '3')
  .option('--watch-auto-commit <yes|no>', 'Auto-commit after successful fix', 'yes')
  .argument('[prompt]', 'The user prompt');
```

- [ ] **Step 2: Import WatchLoop**

Add import at top of `src/index.ts` (after other local imports):

```typescript
import { WatchLoop } from './watcher';
```

- [ ] **Step 3: Validate new flags**

After existing validation (after `--mcp-server` JSON parsing block, around line 79), add:

```typescript
// Watch mode config
const watchDebounce = parseInt(options.watchDebounce);
if (isNaN(watchDebounce) || watchDebounce < 100) {
  console.error(`Invalid --watch-debounce value: ${options.watchDebounce}. Must be >= 100ms.`);
  process.exit(1);
}
const watchMaxRetries = parseInt(options.watchMaxRetries);
if (isNaN(watchMaxRetries) || watchMaxRetries < 1) {
  console.error(`Invalid --watch-max-retries value: ${options.watchMaxRetries}. Must be >= 1.`);
  process.exit(1);
}
const watchAutoCommit = options.watchAutoCommit !== 'no';
```

- [ ] **Step 4: Add watch REPL command handlers**

In the REPL handler switch statement (in `startRepl`), add three new cases before `case 'exit'`:

```typescript
        case 'watch-on': {
          if (cmd.paths) {
            console.log(`\nStarting watch on: ${cmd.paths.join(', ')}`);
            // Rebuild watch config with custom paths
            watchConfig.paths = cmd.paths;
          }
          if (!watchLoop) {
            watchConfig.agentDir = options.agentDir;
            watchConfig.model = model;
            watchLoop = new WatchLoop(watchConfig);
            watchLoop.start();
          } else if (!watchLoop.isRunning()) {
            watchLoop.start();
          } else {
            console.log('Watch is already running.');
          }
          break;
        }

        case 'watch-off': {
          if (watchLoop && watchLoop.isRunning()) {
            watchLoop.stop();
            watchLoop = null;
          } else {
            console.log('Watch is not running.');
          }
          break;
        }

        case 'watch-status': {
          if (watchLoop && watchLoop.isRunning()) {
            console.log(watchLoop.getStatus());
          } else {
            console.log('Watch is not running.');
          }
          break;
        }
```

- [ ] **Step 5: Add watch startup in main()**

First, declare `watchConfig` and `watchLoop` at the TOP of `async function main()`, before any logic. This makes them accessible to both the auto-start path and REPL handlers via closure:

```typescript
async function main() {
  // Watch mode state (declared here so REPL handlers can access via closure)
  const watchConfig: WatchConfig = {
    paths: options.watchPaths.split(',').map((p: string) => p.trim()).filter(Boolean),
    debounceMs: watchDebounce,
    maxRetries: watchMaxRetries,
    autoCommit: watchAutoCommit,
    model: model,
    agentDir: options.agentDir,
  };
  let watchLoop: WatchLoop | null = null;

  const instructions = loadInstructions(options.agentDir);
  // ... rest of main()
```

Then, inside the `if (!userPrompt)` block, AFTER the `!process.stdin.isTTY` check, add before `startRepl(...)`:

```typescript
    // If --watch flag, auto-start watcher before REPL starts
    if (options.watch) {
      watchConfig.model = model; // use current model at startup time
      watchLoop = new WatchLoop(watchConfig);
      watchLoop.start();
    }
```

The REPL `startRepl(...)` call runs normally — the watcher operates independently via `fs.watch` events. The REPL handlers for `/watch on|off|status` access `watchLoop` and `watchConfig` through closure. The `watchConfig` can be updated (e.g. paths changed via `/watch on src/,tests/`) and the old `watchLoop` stopped + a new one created with updated config.

- [ ] **Step 6: Build and verify**

Run: `cd core/engine/skill_pilot_agent && npm run build`
Expected: `tsc` exits 0, no type errors.

- [ ] **Step 7: Manual test — CLI flags parse**

```bash
node dist/index.js --help 2>&1 | grep -c "watch"
```
Expected: `5` (five watch-related options shown)

- [ ] **Step 8: Manual test — REPL shows /watch**

```bash
OPENAI_API_KEY=sk-test node dist/index.js --model gpt-5.5 2>&1 <<< $'/exit\n' | grep -c "watch"
```
Wait — REPL needs TTY. Use `--watch --help` instead.

```bash
node dist/index.js --watch --help 2>&1 | grep watch
```
Expected: shows watch options.

- [ ] **Step 9: Commit**

```bash
git add core/engine/skill_pilot_agent/src/index.ts
git commit -m "feat: wire --watch flags and /watch REPL handlers for live coding mode"
```

- [ ] **Step 10: Final integration test**

Start the watcher (will run until Ctrl+C):

```bash
DEEPSEEK_API_KEY="sk-..." node dist/index.js --watch --model deepseek-v4-flash
```

Then in another terminal, touch a file in `src/` and observe the agent fixing cycle.

---

### Task 4: Push and final verification

- [ ] **Step 1: Build final**

```bash
cd core/engine/skill_pilot_agent && npm run build
```

- [ ] **Step 2: Push**

```bash
git push target feat/agent-mvp:main --force
```
