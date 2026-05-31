import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { webFetchTool, webSearchTool } from './tools/web';
import { watchTool, watchFileTool } from './tools/watch';
import { createSandboxedBash } from './tools/sandbox';

type ToolContext = { agentDir: string };

function safePath(base: string, filePath: string): string {
  const resolved = path.resolve(base, filePath);
  if (!resolved.startsWith(base)) {
    throw new Error(`Path escapes agent directory: ${filePath}`);
  }
  return resolved;
}

// -- read ---------------------------------------------------------------
export const readTool = {
  type: 'function' as const,
  name: 'read',
  description: 'Read the contents of a file.',
  needsApproval: async () => false,
  parameters: z.object({
    file_path: z.string().describe('Path to the file to read, relative to the project root.'),
  }),
  run: async (args: { file_path: string }, ctx: ToolContext) => {
    const fullPath = safePath(ctx.agentDir, args.file_path);
    if (!fs.existsSync(fullPath)) return `File not found: ${args.file_path}`;
    return fs.readFileSync(fullPath, 'utf8');
  },
};

// -- write --------------------------------------------------------------
export const writeTool = {
  type: 'function' as const,
  name: 'write',
  description: 'Create a new file or overwrite an existing one.',
  needsApproval: async () => false,
  parameters: z.object({
    file_path: z.string().describe('Path to the file to write, relative to the project root.'),
    content: z.string().describe('The content to write to the file.'),
  }),
  run: async (args: { file_path: string; content: string }, ctx: ToolContext) => {
    const fullPath = safePath(ctx.agentDir, args.file_path);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, args.content, 'utf8');
    return `Wrote ${args.content.length} bytes to ${args.file_path}.`;
  },
};

// -- edit ---------------------------------------------------------------
export const editTool = {
  type: 'function' as const,
  name: 'edit',
  description: 'Replace a string in a file. The old_string must match exactly once.',
  needsApproval: async () => false,
  parameters: z.object({
    file_path: z.string().describe('Path to the file to edit, relative to the project root.'),
    old_string: z.string().describe('The exact string to replace.'),
    new_string: z.string().describe('The replacement text.'),
  }),
  run: async (args: { file_path: string; old_string: string; new_string: string }, ctx: ToolContext) => {
    const fullPath = safePath(ctx.agentDir, args.file_path);
    if (!fs.existsSync(fullPath)) return `File not found: ${args.file_path}`;
    const content = fs.readFileSync(fullPath, 'utf8');
    const count = content.split(args.old_string).length - 1;
    if (count === 0) return `old_string not found in ${args.file_path}.`;
    if (count > 1) return `old_string matches ${count} times in ${args.file_path}. Make it unique.`;
    fs.writeFileSync(fullPath, content.replace(args.old_string, args.new_string), 'utf8');
    return `Replaced 1 occurrence in ${args.file_path}.`;
  },
};

// -- glob ---------------------------------------------------------------
export const globTool = {
  type: 'function' as const,
  name: 'glob',
  description: 'Find files matching a pattern. Supports ** for recursive matching.',
  needsApproval: async () => false,
  parameters: z.object({
    pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts" or "*.md".'),
  }),
  run: async (args: { pattern: string }, ctx: ToolContext) => {
    const results: string[] = [];

    function patternToRegex(pat: string): RegExp {
      let escaped = '';
      for (const ch of pat) {
        if (ch === '*') escaped += '.*';
        else if (ch === '?') escaped += '.';
        else if ('.+^${}()|[]\\'.includes(ch)) escaped += '\\' + ch;
        else escaped += ch;
      }
      return new RegExp('^' + escaped + '$');
    }

    function matchPath(entryPath: string, segments: string[]): boolean {
      if (segments.length === 0) return entryPath === '';
      const [head, ...tail] = segments;
      if (head === '**') {
        if (tail.length === 0) return true;
        const parts = entryPath.split('/');
        for (let i = 0; i <= parts.length; i++) {
          if (matchPath(parts.slice(i).join('/'), tail)) return true;
        }
        return false;
      }
      const parts = entryPath.split('/');
      return patternToRegex(head).test(parts[0]) && matchPath(parts.slice(1).join('/'), tail);
    }

    function walk(dir: string, depth: number) {
      if (depth > 20) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        const relative = path.relative(ctx.agentDir, entryPath).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          walk(entryPath, depth + 1);
          if (matchPath(relative + '/', args.pattern.replace(/\\/g, '/').split('/'))) {
            results.push(relative + '/');
          }
        } else if (entry.isFile()) {
          if (matchPath(relative, args.pattern.replace(/\\/g, '/').split('/'))) {
            results.push(relative);
          }
        }
      }
    }

    walk(ctx.agentDir, 0);
    if (results.length === 0) return `No files matching "${args.pattern}".`;
    return results.slice(0, 200).join('\n') + (results.length > 200 ? `\n... and ${results.length - 200} more` : '');
  },
};

// -- grep ---------------------------------------------------------------
export const grepTool = {
  type: 'function' as const,
  name: 'grep',
  description: 'Search file contents for a regex pattern. Returns matching lines with line numbers.',
  needsApproval: async () => false,
  parameters: z.object({
    pattern: z.string().describe('The regex pattern to search for.'),
    path: z.string().optional().describe('File or directory to search. Defaults to the project root.'),
  }),
  run: async (args: { pattern: string; path?: string }, ctx: ToolContext) => {
    const searchPath = args.path ? safePath(ctx.agentDir, args.path) : ctx.agentDir;
    let regex: RegExp;
    try { regex = new RegExp(args.pattern, 'g'); } catch {
      return `Invalid regex: ${args.pattern}`;
    }
    const results: string[] = [];
    const maxResults = 100;

    function searchFile(filePath: string) {
      if (results.length >= maxResults) return;
      let content: string;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { return; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        if (regex.test(lines[i])) {
          regex.lastIndex = 0;
          results.push(`${path.relative(ctx.agentDir, filePath)}:${i + 1}: ${lines[i].substring(0, 200)}`);
        }
      }
    }

    function walk(dir: string) {
      if (results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(entryPath);
        else if (entry.isFile()) searchFile(entryPath);
      }
    }

    if (fs.statSync(searchPath).isFile()) {
      searchFile(searchPath);
    } else {
      walk(searchPath);
    }

    if (results.length === 0) return `No matches for "${args.pattern}".`;
    return results.join('\n') + (results.length >= maxResults ? `\n... (limited to ${maxResults} results)` : '');
  },
};

// Wrap a raw tool object into the SDK-compatible format (v0.11+ requires invoke/needsApproval).
// SDK invoke signature: (runContext, input, details?) => result
// SDK passes input as a JSON string from Chat Completions APIs — parse it.
function adaptTool(raw: any): any {
  const origRun = raw.invoke || raw.run || (async () => { throw new Error(`Tool ${raw.name} has no invoke/run`); });
  return {
    type: raw.type || 'function',
    name: raw.name,
    description: raw.description,
    parameters: raw.parameters,
    needsApproval: raw.needsApproval || (async () => false),
    invoke: async (_runContext: any, input: any, _details?: any) => {
      // Parse JSON string args from Chat Completions
      let args = input;
      if (typeof input === 'string') {
        try { args = JSON.parse(input); } catch { /* pass raw */ }
      }
      return origRun(args, _runContext?.context);
    },
  };
}

// All tools with context injection
export function createTools(agentDir: string): any[] {
  const ctx: ToolContext = { agentDir };
  const sandboxedBashTool = createSandboxedBash({ agentDir });

  return [
    adaptTool({ ...readTool, invoke: (args: any) => readTool.run(args, ctx) }),
    adaptTool({ ...writeTool, invoke: (args: any) => writeTool.run(args, ctx) }),
    adaptTool({ ...editTool, invoke: (args: any) => editTool.run(args, ctx) }),
    adaptTool({ ...globTool, invoke: (args: any) => globTool.run(args, ctx) }),
    adaptTool({ ...grepTool, invoke: (args: any) => grepTool.run(args, ctx) }),
    adaptTool({ ...webFetchTool, invoke: webFetchTool.run }),
    adaptTool({ ...webSearchTool, invoke: webSearchTool.run }),
    adaptTool({ ...sandboxedBashTool, invoke: sandboxedBashTool.run }),
    adaptTool({ ...watchTool, invoke: (args: any) => watchTool.run(args, ctx) }),
    adaptTool({ ...watchFileTool, invoke: (args: any) => watchFileTool.run(args, ctx) }),
  ];
}
