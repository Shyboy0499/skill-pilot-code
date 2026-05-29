import { spawn, ChildProcess } from 'node:child_process';
import { ToolChunk, StreamOptions, ToolOutput } from './types';

export async function* executeBashStreaming(
  command: string,
  options: StreamOptions
): AsyncIterable<ToolChunk> {
  const { timeoutMs, maxOutputBytes, cwd } = options;

  const child: ChildProcess = spawn(command, [], {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  });

  let totalBytes = 0;
  let killed = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let killTimerId: ReturnType<typeof setTimeout> | undefined;
  let exitResolve: ((code: number | null) => void) | undefined;
  let stderrEndResolve: (() => void) | undefined;

  const exitPromise = new Promise<number | null>((resolve) => {
    exitResolve = resolve;
    child.on('close', (code) => resolve(code));
  });

  const kill = () => {
    if (killed) return;
    killed = true;
    child.kill('SIGTERM');
    killTimerId = setTimeout(() => {
      child.kill('SIGKILL');
    }, 5000);
  };

  // Arm timeout
  if (timeoutMs > 0) {
    timeoutId = setTimeout(kill, timeoutMs);
  }

  // Buffer stderr chunks as they arrive concurrently
  const stderrChunks: string[] = [];
  let stderrClosed = false;

  const stderrEndPromise = new Promise<void>((resolve) => {
    stderrEndResolve = resolve;
  });

  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      if (!killed) {
        stderrChunks.push(chunk.toString());
      }
    });
    child.stderr.on('end', () => {
      stderrClosed = true;
      stderrEndResolve?.();
    });
    child.stderr.on('error', () => {
      stderrClosed = true;
      stderrEndResolve?.();
    });
  }

  // Drain buffered stderr chunks (called between stdout yields)
  const drainStderr = function* () {
    while (stderrChunks.length > 0) {
      yield { type: 'stderr' as const, data: stderrChunks.shift()! };
    }
  };

  // Consume stdout via for-await-of
  if (child.stdout) {
    try {
      for await (const chunk of child.stdout) {
        if (killed) break;

        // Interleave any buffered stderr
        yield* drainStderr();

        const data = chunk.toString();
        totalBytes += Buffer.byteLength(data);

        if (totalBytes > maxOutputBytes) {
          yield {
            type: 'error',
            data: `Output exceeded maximum size of ${maxOutputBytes} bytes`,
          };
          kill();
          break;
        }

        yield { type: 'stdout', data };
      }
    } catch {
      // Stream read error — process may have been killed
    }
  }

  // Wait for stderr to finish closing, then drain remaining
  await stderrEndPromise;
  yield* drainStderr();

  // Clean up timeout
  if (timeoutId) clearTimeout(timeoutId);
  if (killTimerId) clearTimeout(killTimerId);

  // Make sure child has exited, then yield exit code
  const exitCode = await exitPromise;
  yield { type: 'exit', code: exitCode ?? undefined };
}

export function isStreamingOutput(
  value: unknown
): value is AsyncIterable<ToolChunk> {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    Symbol.asyncIterator in (value as object)
  );
}

export async function consumeStreamingOutput(
  stream: AsyncIterable<ToolChunk>,
  onChunk?: (chunk: ToolChunk) => void,
  maxOutput: number = 100000
): Promise<string> {
  let output = '';

  for await (const chunk of stream) {
    onChunk?.(chunk);

    if (chunk.type === 'stdout' || chunk.type === 'stderr') {
      if (chunk.data && output.length < maxOutput) {
        const remaining = maxOutput - output.length;
        output += chunk.data.slice(0, remaining);
      }
    }
  }

  return output;
}

export function createStreamingToolWrapper(
  onToolOutput?: (toolName: string, chunk: ToolChunk) => void
): (
  toolName: string,
  run: (...args: any[]) => any
) => (...args: any[]) => Promise<string> {
  return (toolName: string, run: (...args: any[]) => any) => {
    return async (...args: any[]): Promise<string> => {
      const result = await run(...args);

      if (isStreamingOutput(result)) {
        return consumeStreamingOutput(result, (chunk) => {
          onToolOutput?.(toolName, chunk);
        });
      }

      // Plain string result
      return result as string;
    };
  };
}
