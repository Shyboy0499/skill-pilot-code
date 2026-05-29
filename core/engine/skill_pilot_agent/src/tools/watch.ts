import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

type ToolContext = { agentDir: string };

function safePath(base: string, filePath: string): string {
  const resolved = path.resolve(base, filePath);
  if (!resolved.startsWith(base)) {
    throw new Error(`Path escapes agent directory: ${filePath}`);
  }
  return resolved;
}

type ChangeType = 'created' | 'modified' | 'deleted';

interface PendingChange {
  timer: ReturnType<typeof setTimeout>;
  fullPath: string;
  eventType: string;
}

export const watchTool = {
  type: 'function' as const,
  name: 'watch',
  description:
    'Watch files or directories for changes. Returns a summary of files created, modified, and deleted during the watch period.',
  parameters: z.object({
    paths: z
      .array(z.string())
      .describe('Files or directories to watch, relative to project root.'),
    poll_ms: z.number().optional().describe('Debounce interval in ms (default 500).'),
    duration_ms: z
      .number()
      .optional()
      .describe('How long to watch in ms (default 30000, max 120000).'),
  }),
  run: async (
    args: { paths: string[]; poll_ms?: number; duration_ms?: number },
    ctx: ToolContext,
  ) => {
    const debounceMs = args.poll_ms ?? 500;
    const durationMs = Math.min(args.duration_ms ?? 30000, 120000);

    // -- Resolve and validate all paths -----------------------------------
    const resolvedPaths: { original: string; resolved: string; isDir: boolean }[] = [];
    for (const p of args.paths) {
      let resolved: string;
      try {
        resolved = safePath(ctx.agentDir, p);
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
      if (!fs.existsSync(resolved)) {
        return `Path not found: ${p}`;
      }
      let isDir: boolean;
      try {
        isDir = fs.statSync(resolved).isDirectory();
      } catch {
        return `Permission denied: ${p}`;
      }
      resolvedPaths.push({ original: p, resolved, isDir });
    }

    // -- State ------------------------------------------------------------
    const confirmedChanges = new Map<string, ChangeType>();
    const pendingChanges = new Map<string, PendingChange>();
    const watchers: fs.FSWatcher[] = [];

    function determineChangeType(fullPath: string, eventType: string): ChangeType {
      if (eventType === 'change') return 'modified';
      return fs.existsSync(fullPath) ? 'created' : 'deleted';
    }

    function flushChange(relPath: string, fullPath: string, eventType: string) {
      pendingChanges.delete(relPath);
      const newType = determineChangeType(fullPath, eventType);
      const prevType = confirmedChanges.get(relPath);

      if (!prevType) {
        confirmedChanges.set(relPath, newType);
        return;
      }

      // A file that was deleted earlier but now exists again -> report as modified
      if (prevType === 'deleted' && newType !== 'deleted') {
        confirmedChanges.set(relPath, 'modified');
      } else {
        confirmedChanges.set(relPath, newType);
      }
    }

    function onEvent(fullPath: string, eventType: string) {
      const relPath = path.relative(ctx.agentDir, fullPath);

      const existing = pendingChanges.get(relPath);
      if (existing) clearTimeout(existing.timer);

      const timer = setTimeout(() => {
        flushChange(relPath, fullPath, eventType);
      }, debounceMs);

      pendingChanges.set(relPath, { timer, fullPath, eventType });
    }

    // -- Set up watchers --------------------------------------------------
    for (const { resolved, isDir, original } of resolvedPaths) {
      try {
        const watcher = fs.watch(
          resolved,
          { recursive: isDir },
          (eventType, filename) => {
            if (filename) {
              onEvent(path.join(resolved, filename), eventType);
            } else {
              // filename may be null on some platforms — use the watched path itself
              onEvent(resolved, eventType);
            }
          },
        );
        watcher.on('error', () => {
          // Silently ignore watcher errors during the watch period.
          // Individual permission / missing-file errors are surfaced per-path above.
        });
        watchers.push(watcher);
      } catch (e: any) {
        for (const w of watchers) w.close();
        return `Error watching ${original}: ${e.message}`;
      }
    }

    // -- Wait for the specified duration ----------------------------------
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        // Flush any still-pending debounced changes
        for (const [relPath, pending] of pendingChanges) {
          clearTimeout(pending.timer);
          flushChange(relPath, pending.fullPath, pending.eventType);
        }
        resolve();
      }, durationMs);
    });

    // -- Clean up ---------------------------------------------------------
    for (const w of watchers) w.close();

    // -- Collect results --------------------------------------------------
    const created: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const [relPath, type] of confirmedChanges) {
      if (type === 'created') created.push(relPath);
      else if (type === 'modified') modified.push(relPath);
      else deleted.push(relPath);
    }

    const total = created.length + modified.length + deleted.length;

    if (total === 0) {
      return `Watched for ${durationMs}ms. No changes detected.`;
    }

    const maxPaths = 50;
    const allEntries = [
      ...created.map((p) => `  [created] ${p}`),
      ...modified.map((p) => `  [modified] ${p}`),
      ...deleted.map((p) => `  [deleted] ${p}`),
    ];

    const lines = [
      `Watched for ${durationMs}ms. ${total} change(s) detected:`,
      `  Created: ${created.length}`,
      `  Modified: ${modified.length}`,
      `  Deleted: ${deleted.length}`,
    ];

    if (allEntries.length > 0) {
      lines.push('');
      lines.push(...allEntries.slice(0, maxPaths));
      if (allEntries.length > maxPaths) {
        lines.push(`... and ${allEntries.length - maxPaths} more`);
      }
    }

    return lines.join('\n');
  },
};

export const watchFileTool = {
  type: 'function' as const,
  name: 'watch_file',
  description:
    'Watch a single file and return when it is modified. Blocks until the file changes or timeout.',
  parameters: z.object({
    file_path: z
      .string()
      .describe('Path to the file to watch, relative to project root.'),
    timeout_ms: z.number().optional().describe('Max wait time in ms (default 30000).'),
  }),
  run: async (
    args: { file_path: string; timeout_ms?: number },
    ctx: ToolContext,
  ) => {
    const timeoutMs = args.timeout_ms ?? 30000;

    let fullPath: string;
    try {
      fullPath = safePath(ctx.agentDir, args.file_path);
    } catch (e: any) {
      return JSON.stringify({ error: e.message });
    }

    if (!fs.existsSync(fullPath)) {
      return JSON.stringify({ error: `File not found: ${args.file_path}` });
    }

    let oldMtime: Date;
    try {
      oldMtime = fs.statSync(fullPath).mtime;
    } catch {
      return JSON.stringify({ error: `Permission denied: ${args.file_path}` });
    }

    const oldMtimeStr = oldMtime.toISOString();

    const POLL_MS = 500;

    const result = await new Promise<{
      changed: boolean;
      old_mtime: string;
      new_mtime: string;
    }>((resolve) => {
      let resolved = false;

      // -- event-based watcher (fast path) --------------------------------
      const watcher = fs.watch(fullPath, (eventType) => {
        if (resolved) return;
        if (eventType !== 'change') return;
        resolved = true;
        watcher.close();
        clearInterval(interval);
        clearTimeout(timeout);
        try {
          const newMtime = fs.statSync(fullPath).mtime;
          resolve({
            changed: true,
            old_mtime: oldMtimeStr,
            new_mtime: newMtime.toISOString(),
          });
        } catch {
          resolve({
            changed: true,
            old_mtime: oldMtimeStr,
            new_mtime: 'unknown',
          });
        }
      });

      // -- stat polling (reliable fallback) -------------------------------
      const interval = setInterval(() => {
        if (resolved) return;
        try {
          const currentMtime = fs.statSync(fullPath).mtime;
          if (currentMtime.getTime() !== oldMtime.getTime()) {
            resolved = true;
            clearInterval(interval);
            clearTimeout(timeout);
            watcher.close();
            resolve({
              changed: true,
              old_mtime: oldMtimeStr,
              new_mtime: currentMtime.toISOString(),
            });
          }
        } catch {
          // File may have been deleted — watcher will catch it
        }
      }, POLL_MS);

      // -- timeout -------------------------------------------------------
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        watcher.close();
        clearInterval(interval);
        resolve({
          changed: false,
          old_mtime: oldMtimeStr,
          new_mtime: oldMtimeStr,
        });
      }, timeoutMs);
    });

    return JSON.stringify(result);
  },
};
