import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface WatchConfig {
  paths: string[];
  debounceMs: number;
  maxRetries: number;
  autoCommit: boolean;
  model: string;
  agentDir: string;
}

export class WatchLoop {
  private config: WatchConfig;
  private watchers: fs.FSWatcher[] = [];
  private pending: { changedFiles: Set<string> } | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fixQueue: string[][] = [];
  private running = false;
  private busy = false;
  private stats = { filesWatched: 0, fixesApplied: 0, commitsMade: 0 };
  private statsFile: string;

  static loadConfig(agentDir: string, cliOverrides: Partial<WatchConfig> = {}): WatchConfig {
    const defaults: WatchConfig = {
      paths: ['src/'],
      debounceMs: 2000,
      maxRetries: 3,
      autoCommit: true,
      model: '',
      agentDir: agentDir,
    };
    const rcPath = path.join(agentDir, '.watchrc.json');
    if (fs.existsSync(rcPath)) {
      try {
        const rc = JSON.parse(fs.readFileSync(rcPath, 'utf8'));
        if (rc.paths && Array.isArray(rc.paths)) defaults.paths = rc.paths;
        if (typeof rc.debounceMs === 'number') defaults.debounceMs = rc.debounceMs;
        if (typeof rc.maxRetries === 'number') defaults.maxRetries = rc.maxRetries;
        if (typeof rc.autoCommit === 'boolean') defaults.autoCommit = rc.autoCommit;
      } catch (e) { /* ignore */ }
    }
    return Object.assign({}, defaults, cliOverrides);
  }

  constructor(config: WatchConfig) {
    this.config = config;
    this.statsFile = path.join(config.agentDir, '.skillpilot', 'watch-stats.json');
    this.loadStats();
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

  private onChange(filePath: string): void {
    if (!this.running) return;

    if (!this.pending) {
      this.pending = { changedFiles: new Set() };
    }

    this.pending.changedFiles.add(path.relative(this.config.agentDir, filePath));

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
    if (this.busy) {
      this.fixQueue.push(files);
      this.pending = null;
      return;
    }

    await this.runFixCycle(files);
  }

  async runFixCycle(files: string[]): Promise<void> {
    this.busy = true;
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
          this.saveStats();
          console.error(`  Fix cycle succeeded.`);
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
      this.busy = false;
      this.processQueue();
      return;
    }

    // Try to commit
    if (this.config.autoCommit) {
      try {
        await this.gitCommit(files);
        this.stats.commitsMade++;
        this.saveStats();
      } catch (err: any) {
        console.error(`  Commit failed: ${err.message}`);
      }
    }

    this.pending = null;
    console.error(`  Waiting for changes...\n`);
    this.busy = false;
    this.processQueue();
  }

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
      const distIndex = path.resolve(__dirname, '../dist/index.js');
      const child = spawn('node', [
        distIndex,
        '--model', this.config.model,
        '--agent-dir', this.config.agentDir,
        '--approve-tools', 'no',
        '--max-retries', '10',
        '--timeout', '120',
        prompt,
      ], {
        cwd: this.config.agentDir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
      }, 130_000);

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        process.stdout.write(text);
        if (output.length < 100_000) output += text.substring(0, 100_000 - output.length);
      });

      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        process.stderr.write(text);
        if (output.length < 100_000) output += text.substring(0, 100_000 - output.length);
      });

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        resolve({ exitCode: code, output });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  }

  private gitCommit(files: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (files.length === 0) {
        resolve();
        return;
      }

      const gitAdd = spawn('git', ['add', '--all', '--', ...files], {
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

  private processQueue(): void {
    if (this.fixQueue.length > 0 && this.running) {
      const next = this.fixQueue.shift()!;
      this.runFixCycle(next);
    }
  }

  private loadStats() {
    try {
      if (fs.existsSync(this.statsFile)) {
        const saved = JSON.parse(fs.readFileSync(this.statsFile, 'utf8'));
        if (typeof saved.fixesApplied === 'number') this.stats.fixesApplied = saved.fixesApplied;
        if (typeof saved.commitsMade === 'number') this.stats.commitsMade = saved.commitsMade;
      }
    } catch (e) { /* ignore */ }
  }

  private saveStats() {
    try {
      const dir = path.dirname(this.statsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.statsFile, JSON.stringify({
        fixesApplied: this.stats.fixesApplied,
        commitsMade: this.stats.commitsMade,
        lastRun: 'see file mtime',
      }, null, 2));
    } catch (e) { /* ignore */ }
  }

  getStatus(): string {
    return `Watching: ${this.config.paths.join(', ')} | Debounce: ${this.config.debounceMs}ms | Auto-commit: ${this.config.autoCommit} | Fixes: ${this.stats.fixesApplied} | Commits: ${this.stats.commitsMade}`;
  }

  isRunning(): boolean {
    return this.running;
  }
}
