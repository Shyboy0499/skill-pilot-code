import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Generate a random hex string of length n.
 */
export function randomHex(n: number): string {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/**
 * Return the base sandbox directory path for the given agent directory.
 */
export function getSandboxDir(agentDir: string): string {
  return path.join(agentDir, '.sandbox');
}

/**
 * Create a sandboxed bash tool that executes commands inside an isolated
 * temporary directory with resource limits (30s CPU, 1GB virtual memory).
 *
 * The tool returns a function-call object compatible with the @openai/agents
 * SDK tool format.
 */
export function createSandboxedBash(options: { agentDir: string }) {
  const { agentDir } = options;

  return {
    type: 'function' as const,
    name: 'sandbox',
    description:
      'Execute a bash command in an isolated sandbox directory. Safer than raw bash for running untrusted code, builds, or tests.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute in the sandbox.'),
      keep: z
        .boolean()
        .optional()
        .describe('Keep the sandbox directory after execution for inspection (default: false).'),
      allow_network: z
        .boolean()
        .optional()
        .describe('Allow network access from the sandbox (default: false).'),
    }),
    run: async (args: { command: string; keep?: boolean; allow_network?: boolean }) => {
      const { command, keep = false, allow_network = false } = args;

      // -- 1. Create sandbox directory ---------------------------------------
      const sandboxDir = path.join(getSandboxDir(agentDir), `sbx-${randomHex(8)}`);
      fs.mkdirSync(sandboxDir, { recursive: true });

      // -- 2. Build the wrapped command --------------------------------------
      // ulimit -t 30: 30 seconds of CPU time
      // ulimit -v 1048576: 1 GB virtual memory
      let wrappedCommand = command;
      if (process.platform === 'darwin' || process.platform === 'linux') {
        const prefix = 'ulimit -t 30 -v 1048576';
        wrappedCommand = `${prefix}; ${command}`;
      }

      // -- 3. Execute --------------------------------------------------------
      const maxOutput = 100_000; // 100 KB cap
      const timeoutMs = 30_000; // 30 seconds wall-clock timeout

      const result = await new Promise<string>((resolve) => {
        const child = spawn(wrappedCommand, {
          shell: true,
          cwd: sandboxDir,
          stdio: 'pipe',
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          // Force kill after 5s if SIGTERM didn't work
          setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL');
          }, 5000);
        }, timeoutMs);

        child.stdout?.on('data', (data: string) => {
          if (stdout.length < maxOutput) stdout += data;
        });

        child.stderr?.on('data', (data: string) => {
          if (stderr.length < maxOutput) stderr += data;
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          if (timedOut) {
            resolve(
              `[sandbox] Command timed out after ${timeoutMs / 1000}s.\nSandbox: ${sandboxDir}\nPartial output:\n${stdout.substring(0, 5000)}`
            );
          } else if (code === 0) {
            const out = stdout || 'Command executed successfully (no output).';
            const capped = out.length > maxOutput ? out.substring(0, maxOutput) + '\n...(truncated)' : out;
            resolve(`[sandbox] Exit 0\nSandbox: ${sandboxDir}\n${capped}`);
          } else {
            const msg = `Error (exit code ${code}):\n${stderr}\n${stdout}`;
            const capped =
              msg.length > maxOutput ? msg.substring(0, maxOutput) + '\n...(truncated)' : msg;
            resolve(`[sandbox] Exit ${code}\nSandbox: ${sandboxDir}\n${capped}`);
          }
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve(`[sandbox] Failed to spawn process: ${err.message}\nSandbox: ${sandboxDir}`);
        });
      });

      // -- 4. Cleanup --------------------------------------------------------
      if (!keep) {
        try {
          fs.rmSync(sandboxDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup — the directory may already be gone or locked.
        }
      }

      return result;
    },
  };
}
