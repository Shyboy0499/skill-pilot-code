import { patchToolParameters } from './patches/sdk-patch';

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Agent, applyPatchTool } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents-core';
import { z } from 'zod';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { createTools } from './tools';
import { startRepl, type ReplCommand } from './repl';
import { saveSession, loadSession, listSessions, forkSession } from './session';
import { loadProviderConfig, resolveModel, listModels, checkApiKey } from './providers/config';
import { buildOpenAIAgent, runOpenAIAgent } from './providers/openai';
import { runAnthropicAgent } from './providers/anthropic';
import { runGeminiAgent } from './providers/gemini';
import type { ResolvedProvider } from './providers/types';
import { executeBashStreaming, consumeStreamingOutput } from './streaming/tool-stream';
import { MCPClient, loadMCPTools } from './mcp/client';
import type { MCPClientOptions } from './mcp/types';
import { WatchLoop, type WatchConfig } from './watcher';

dotenv.config();

const program = new Command();

program
  .name('skill-pilot-agent')
  .description('Skill Pilot Agent CLI')
  .option('--model <model>', 'Override the default model')
  .option('--agent-dir <path>', 'Root directory where the agent operates', process.cwd())
  .option('--max-retries <number>', 'Max number of retries', '3')
  .option('--timeout <seconds>', 'Task timeout', '60')
  .option('--skills-dir <path>', 'Skills directory', '.agent')
  .option('--skills <skills>', 'Allowed skills')
  .option('--effort <effort>', 'Reasoning effort: low, medium, high, xhigh')
  .option('--providers-config <path>', 'Path to providers.json config file')
  .option('--approve-tools <yes|no>', 'Require approval before running bash commands', 'no')
  .option('--mcp-server <json>', 'MCP server config: {"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}')
  .option('--watch', 'Enable live coding watch mode')
  .option('--watch-paths <paths>', 'Comma-separated paths to watch', 'src/')
  .option('--watch-debounce <ms>', 'Debounce window in ms', '2000')
  .option('--watch-max-retries <number>', 'Max fix attempts per change batch', '3')
  .option('--watch-auto-commit <yes|no>', 'Auto-commit after successful fix', 'yes')
  .argument('[prompt]', 'The user prompt');

program.parse();

const options = program.opts();
const userPrompt = program.args[0];

// Validate numeric options
const timeout = parseInt(options.timeout);
if (isNaN(timeout) || timeout <= 0) {
  console.error(`Invalid --timeout value: ${options.timeout}. Must be a positive number.`);
  process.exit(1);
}
const maxRetries = parseInt(options.maxRetries);
if (isNaN(maxRetries) || maxRetries <= 0) {
  console.error(`Invalid --max-retries value: ${options.maxRetries}. Must be a positive number.`);
  process.exit(1);
}

if (options.approveTools !== 'yes' && options.approveTools !== 'no') {
  console.error(`Invalid --approve-tools value: ${options.approveTools}. Must be 'yes' or 'no'.`);
  process.exit(1);
}

// MCP client setup
let mcpClient: MCPClient | null = null;
let mcpTools: any[] = [];

let mcpServerConfig: MCPClientOptions | null = null;
if (options.mcpServer) {
  try {
    mcpServerConfig = JSON.parse(options.mcpServer) as MCPClientOptions;
    if (!mcpServerConfig.command) {
      console.error('Error: --mcp-server JSON must include "command" field.');
      process.exit(1);
    }
  } catch {
    console.error('Error: Invalid --mcp-server JSON.');
    process.exit(1);
  }
}

// Watch mode validation
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

// Tool approval gate
const requireApproval = options.approveTools === 'yes';
let approveAll = false;

function promptApproval(command: string): Promise<boolean> {
  if (!requireApproval || approveAll) return Promise.resolve(true);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`[APPROVE] Run: ${command}\n(y)es / (n)o / (a)ll: `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === 'a' || a === 'all') {
        approveAll = true;
        resolve(true);
      } else if (a === 'y' || a === 'yes') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

// Load provider config
const providersJsonPath = options.providersConfig
  ? path.resolve(options.providersConfig)
  : path.resolve(__dirname, '../providers.json');
loadProviderConfig(providersJsonPath);

let model = options.model;
if (!model) {
  const available = listModels().join(', ');
  console.error(`Error: --model <model> is required. Available: ${available}`);
  process.exit(1);
}

let resolved = resolveModel(model);
const effort: string | undefined = options.effort || undefined;

if (effort && resolved.provider.effort_levels.length === 0) {
  console.error(`Warning: --effort ${effort} ignored. Provider '${resolved.provider.id}' does not support reasoning effort.`);
}

// Helper to load AGENTS.md
function loadInstructions(agentDir: string): string {
  const agentsMdPath = path.join(agentDir, 'AGENTS.md');
  if (fs.existsSync(agentsMdPath)) {
    return fs.readFileSync(agentsMdPath, 'utf8');
  }
  return 'You are a helpful coding assistant named Skill Pilot.';
}

// Find .claude/skills/ directories by walking up from agentDir to the filesystem root.
function findAncestorClaudeSkillsDirs(agentDir: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  let current = path.resolve(agentDir);

  while (true) {
    const candidate = path.join(current, '.claude', 'skills');
    if (!seen.has(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      dirs.push(candidate);
    }
    seen.add(candidate);

    const parent = path.dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }
  return dirs;
}

// Extract a simple YAML field value (single-line, quoted or unquoted).
function extractYamlField(fmText: string, field: string): string {
  const re = new RegExp(`^${field}\\s*:\\s*(.+)$`, 'm');
  const m = fmText.match(re);
  if (!m) return '';
  let val = m[1].trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return val;
}

// Parse simple YAML frontmatter from a markdown string.
// Returns { name, description, body } or null if no valid frontmatter.
function parseFrontmatter(content: string): { name: string; description: string; body: string } | null {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null;

  const rest = content.slice(content.indexOf('\n') + 1);
  const endIdx = rest.indexOf('\n---\n');
  if (endIdx === -1) {
    const endIdx2 = rest.indexOf('\r\n---\r\n');
    if (endIdx2 === -1) return null;
    const fmText = rest.slice(0, endIdx2);
    const bodyStart = endIdx2 + '\r\n---\r\n'.length;
    const name = extractYamlField(fmText, 'name');
    const description = extractYamlField(fmText, 'description');
    if (!name) return null;
    return { name, description, body: rest.slice(bodyStart).trim() };
  }

  const fmText = rest.slice(0, endIdx);
  const bodyStart = endIdx + '\n---\n'.length;
  const name = extractYamlField(fmText, 'name');
  const description = extractYamlField(fmText, 'description');
  if (!name) return null;
  return { name, description, body: rest.slice(bodyStart).trim() };
}

// Load Claude Code-style skills from .claude/skills/<name>/SKILL.md directories.
function loadClaudeSkills(agentDir: string, allowedSkills?: string): string {
  const claudeDirs = findAncestorClaudeSkillsDirs(agentDir);
  if (claudeDirs.length === 0) return '';

  const filter = allowedSkills ? allowedSkills.split(',') : null;
  let skillInstructions = '';

  for (const claudeDir of claudeDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(claudeDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDirName = entry.name;
      const skillMdPath = path.join(claudeDir, skillDirName, 'SKILL.md');

      if (!fs.existsSync(skillMdPath)) continue;

      const content = fs.readFileSync(skillMdPath, 'utf8');
      const parsed = parseFrontmatter(content);
      if (!parsed) {
        // No frontmatter — treat the whole file as the skill body, use dir name as skill name
        if (filter && !filter.some((f) => f === skillDirName)) continue;
        skillInstructions += `\n--- Skill: ${skillDirName} ---\n${content.trim()}\n`;
        continue;
      }

      // Check filter against frontmatter name or directory name
      if (filter && !filter.some((f) => f === parsed.name || f === skillDirName)) continue;

      const descLine = parsed.description ? `${parsed.description}\n\n` : '';
      skillInstructions += `\n--- Skill: ${parsed.name} ---\n${descLine}${parsed.body}\n`;
    }
  }

  return skillInstructions;
}

// Helper to load skills from both the --skills-dir path and .claude/skills/.
function loadSkills(agentDir: string, skillsDir: string, allowedSkills?: string): string {
  const fullSkillsPath = path.resolve(agentDir, skillsDir);
  const filter = allowedSkills ? allowedSkills.split(',') : null;

  let skillInstructions = '';

  // 1. Scan --skills-dir for .md files
  if (fs.existsSync(fullSkillsPath)) {
    function scanDir(dir: string): string[] {
      const results: string[] = [];
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return results;
      }
      for (const entry of dirEntries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...scanDir(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(entryPath);
        }
      }
      return results;
    }

    const mdFiles = scanDir(fullSkillsPath);

    if (mdFiles.length > 0) {
      skillInstructions += '\n\nAvailable Skills:\n';

      for (const filePath of mdFiles) {
        const relativeName = path.relative(fullSkillsPath, filePath).replace(/\\/g, '/');
        const parsedName = path.parse(relativeName).name;

        const dirParts = path.dirname(relativeName).split('/');
        const matchesFilter = filter
          ? filter.some((f) => f === parsedName || f === relativeName || dirParts.includes(f))
          : true;
        if (!matchesFilter) continue;

        try {
          const content = fs.readFileSync(filePath, 'utf8');
          skillInstructions += `\n--- Skill: ${relativeName} ---\n${content}\n`;
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  // 2. Load Claude Code-style skills from .claude/skills/
  const claudeSkills = loadClaudeSkills(agentDir, allowedSkills);
  if (claudeSkills) {
    if (skillInstructions) {
      skillInstructions += '\n';
    } else {
      skillInstructions += '\n\nAvailable Skills:\n';
    }
    skillInstructions += claudeSkills;
  }

  return skillInstructions;
}

// Bash Tool implementation
async function executeBash(command: string): Promise<string> {
  const approved = await promptApproval(command);
  if (!approved) return 'Command denied by user.';

  const timeoutMs = timeout * 1000;
  const maxOutput = 100_000; // 100KB cap

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: options.agentDir,
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

    child.stdout.on('data', (data: string) => {
      if (stdout.length < maxOutput) stdout += data;
    });
    child.stderr.on('data', (data: string) => {
      if (stderr.length < maxOutput) stderr += data;
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(`Command timed out after ${timeout}s.\nPartial output:\n${stdout.substring(0, 5000)}`);
      } else if (code === 0) {
        const out = stdout || 'Command executed successfully (no output).';
        resolve(out.length > maxOutput ? out.substring(0, maxOutput) + '\n...(truncated)' : out);
      } else {
        const msg = `Error (exit code ${code}):\n${stderr}\n${stdout}`;
        resolve(msg.length > maxOutput ? msg.substring(0, maxOutput) + '\n...(truncated)' : msg);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`Failed to spawn process: ${err.message}`);
    });
  });
}

const bashTool = {
  type: 'function' as const,
  name: 'bash',
  description: 'Execute a bash command on the system. Use this to read files, run tests, or modify code.',
  needsApproval: async () => requireApproval,
  parameters: z.object({
    command: z.string().describe('The shell command to execute.'),
  }),
  invoke: async (_runContext: any, input: any) => {
    let args: any = input;
    if (typeof input === 'string') { try { args = JSON.parse(input); } catch {} }
    return executeBash(args.command);
  },
};

const bashStreamTool = {
  type: 'function' as const,
  name: 'bash_stream',
  description: 'Execute a bash command with real-time streaming output. Use this for long-running commands where you want to see progress.',
  needsApproval: async () => requireApproval,
  parameters: z.object({
    command: z.string().describe('The shell command to execute.'),
  }),
  invoke: async (_runContext: any, input: any) => {
    let args: any = input;
    if (typeof input === 'string') { try { args = JSON.parse(input); } catch {} }
    const approved = await promptApproval(args.command);
    if (!approved) return 'Command denied by user.';

    console.log(`\n[STREAM] ${args.command.substring(0, 80)}...`);
    const stream = executeBashStreaming(args.command, {
      timeoutMs: timeout * 1000,
      maxOutputBytes: 100_000,
      cwd: options.agentDir,
    });

    return await consumeStreamingOutput(stream, (chunk) => {
      if (chunk.type === 'stdout' && chunk.data) {
        process.stdout.write(chunk.data);
      } else if (chunk.type === 'stderr' && chunk.data) {
        process.stderr.write(chunk.data);
      } else if (chunk.type === 'error' && chunk.data) {
        console.error(`\n[ERROR] ${chunk.data}`);
      }
    });
  },
};

// apply_patch editor -- implements the Editor interface for local filesystem V4A diffs.
function createLocalEditor(agentDir: string) {
  function resolveOpPath(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(agentDir, filePath);
  }

  /** Parse a V4A diff string into an array of {search, replace} blocks. */
  function parseV4ADiff(diff: string): { search: string; replace: string }[] {
    const blocks: { search: string; replace: string }[] = [];
    const marker = '<<<<<<< SEARCH';
    let idx = 0;
    while ((idx = diff.indexOf(marker, idx)) !== -1) {
      const searchContentStart = diff.indexOf('\n', idx + marker.length);
      if (searchContentStart === -1) break;
      const separator = diff.indexOf('\n=======', searchContentStart);
      if (separator === -1) break;
      const replaceEnd = diff.indexOf('\n>>>>>>> REPLACE', separator);
      if (replaceEnd === -1) break;
      const search = diff.substring(searchContentStart + 1, separator);
      const replace = diff.substring(separator + '\n======='.length + 1, replaceEnd);
      blocks.push({ search, replace });
      idx = replaceEnd + '\n>>>>>>> REPLACE'.length;
    }
    return blocks;
  }

  return {
    async createFile(operation: { path: string; diff: string }) {
      const fullPath = resolveOpPath(operation.path);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, operation.diff, 'utf8');
      return { status: 'completed' as const, output: `Created ${operation.path}` };
    },

    async updateFile(operation: { path: string; diff: string }) {
      const fullPath = resolveOpPath(operation.path);
      if (!fs.existsSync(fullPath)) {
        return { status: 'failed' as const, output: `File not found: ${operation.path}` };
      }
      let content = fs.readFileSync(fullPath, 'utf8');
      const blocks = parseV4ADiff(operation.diff);
      if (blocks.length === 0) {
        return { status: 'failed' as const, output: 'No valid SEARCH/REPLACE blocks found in diff.' };
      }
      for (const { search, replace } of blocks) {
        if (!content.includes(search)) {
          return { status: 'failed' as const, output: `Search block not found in ${operation.path}: "${search.substring(0, 100)}"` };
        }
        content = content.replace(search, replace);
      }
      fs.writeFileSync(fullPath, content, 'utf8');
      return { status: 'completed' as const, output: `Updated ${operation.path}` };
    },

    async deleteFile(operation: { path: string }) {
      const fullPath = resolveOpPath(operation.path);
      if (!fs.existsSync(fullPath)) {
        return { status: 'failed' as const, output: `File not found: ${operation.path}` };
      }
      fs.unlinkSync(fullPath);
      return { status: 'completed' as const, output: `Deleted ${operation.path}` };
    },
  };
}

const patchTool = applyPatchTool({ editor: createLocalEditor(options.agentDir) });

async function buildAgent(): Promise<Agent> {
  const instructions = loadInstructions(options.agentDir);
  const skillInstructions = loadSkills(options.agentDir, options.skillsDir, options.skills);

  const multiTurnPrompt = `
When working on a task:
- Ask clarifying questions if anything is ambiguous.
- Report progress as you work — what you found, what you're doing next.
- At the end of each major step, ask the user if they want changes or have follow-up tasks.
- If the user's request is clear, proceed without unnecessary questions.
`;

  const fileTools = createTools(options.agentDir);
  const isRealOpenAI = resolved.provider.id === 'openai';

  // apply_patch is a hosted tool — only works with OpenAI's Responses API.
  const hostedTools = isRealOpenAI ? [patchTool as any] : [];

  const allBuiltTools = [...hostedTools, bashTool as any, bashStreamTool as any, ...fileTools.map((t) => t as any), ...mcpTools];
  patchToolParameters(allBuiltTools);

  return await buildOpenAIAgent(
    resolved,
    instructions + multiTurnPrompt + skillInstructions,
    allBuiltTools,
    effort,
  );
}

async function runAgentStream(
  prompt: string,
  conversation: AgentInputItem[],
): Promise<AgentInputItem[]> {
  checkApiKey(resolved);

  const instructions = loadInstructions(options.agentDir);
  const skillInstructions = loadSkills(options.agentDir, options.skillsDir, options.skills);
  const systemPrompt = instructions + skillInstructions;

  if (resolved.provider.protocol === 'openai') {
    const agent = await buildAgent();
    const { stream, collectedItems } = await runOpenAIAgent(
      agent,
      prompt,
      conversation,
      maxRetries * 5,
    );
    return await consumeStream(stream, conversation);
  }

  // Non-OpenAI adapters
  const fileTools = createTools(options.agentDir);
  const allTools = [bashTool as any, bashStreamTool as any, ...fileTools.map((t) => t as any), ...mcpTools];
  patchToolParameters(allTools);
  const collectedItems: AgentInputItem[] = [...conversation];

  const adapterStream =
    resolved.provider.protocol === 'anthropic'
      ? runAnthropicAgent(resolved, systemPrompt, prompt, allTools, effort)
      : runGeminiAgent(resolved, systemPrompt, prompt, allTools, effort);

  for await (const event of adapterStream) {
    if (event.type === 'text_delta' && event.text) {
      process.stdout.write(event.text);
    } else if (event.type === 'tool_call') {
      console.log(`\n[TOOL:${event.toolName}] ${JSON.stringify(event.toolArgs)}`);
    } else if (event.type === 'tool_result') {
      console.log(`[RESULT] ${event.toolOutput}`);
    } else if (event.type === 'error') {
      console.error(`\n[ERROR] ${event.error}`);
    }
  }

  console.log('');
  return collectedItems;
}

async function consumeStream(
  stream: AsyncIterable<any>,
  conversation: AgentInputItem[],
): Promise<AgentInputItem[]> {
  console.log('');

  const collectedItems: AgentInputItem[] = [...conversation];

  try {
    for await (const event of stream) {
      const evt = event as any;

      if (evt.type === 'raw_model_stream_event') {
        if (evt.data?.delta) {
          process.stdout.write(evt.data.delta);
        }
      } else if (evt.type === 'run_item_stream_event') {
        const item = evt.item;
        if (item) {
          collectedItems.push(item);
          if (item.type === 'tool_call') {
            console.log(`\n[TOOL:${item.name}] ${item.arguments?.command || item.arguments?.file_path || ''}`);
          } else if (item.type === 'tool_result') {
            const output = item.output?.substring?.(0, 200) || '';
            console.log(`[RESULT] ${output}`);
          }
        }
      } else if (evt.type === 'agent_updated_stream_event') {
        // Agent handoff — no-op for now
      }
    }
  } catch (err: any) {
    if (!err.message?.includes('aborted') && !err.message?.includes('cancelled')) {
      throw err;
    }
  }

  console.log('');
  return collectedItems;
}

// Main execution
async function main() {
  // Watch mode state (in main() closure so REPL handlers can access)
  const watchConfig: WatchConfig = {
    paths: options.watchPaths.split(',').map((p: string) => p.trim()).filter(Boolean),
    debounceMs: watchDebounce,
    maxRetries: watchMaxRetries,
    autoCommit: watchAutoCommit,
    model: model,
    agentDir: options.agentDir,
  };
  let watchLoop: WatchLoop | null = null;
  const defaultWatchPaths = [...watchConfig.paths]; // snapshot original CLI defaults

  // Graceful shutdown for watch mode
  process.on('SIGINT', () => {
    if (watchLoop && watchLoop.isRunning()) {
      watchLoop.stop();
    }
    process.exit(0);
  });

  const instructions = loadInstructions(options.agentDir);
  const skillInstructions = loadSkills(options.agentDir, options.skillsDir, options.skills);

  // No prompt + TTY → REPL mode. No prompt + pipe → show help.
  if (!userPrompt) {
    if (!process.stdin.isTTY) {
      program.help();
      process.exit(0);
    }

    // Connect to MCP server and load tools
    if (mcpServerConfig) {
      mcpClient = new MCPClient(mcpServerConfig);
      try {
        await mcpClient.connect();
        mcpTools = await loadMCPTools(mcpClient);
        console.error(`Loaded ${mcpTools.length} MCP tools from ${mcpServerConfig.command}`);
      } catch (err: any) {
        console.error(`Warning: Failed to load MCP tools: ${err.message}`);
        mcpClient = null;
        mcpTools = [];
      }
    }

    // Cleanup MCP client on exit
    process.on('exit', () => {
      if (mcpClient) {
        mcpClient.disconnect();
      }
    });

    const mcpInfo = mcpTools.length > 0 ? ` | MCP tools: ${mcpTools.length}` : '';
    console.log(`Skill Pilot spcode starting session with model: ${model} (provider: ${resolved.provider.id})${mcpInfo}`);

    let conversation: AgentInputItem[] = [];
    let sessionId: string | null = null;

    // If --watch flag, auto-start watcher before REPL
    if (options.watch) {
      watchLoop = new WatchLoop(watchConfig);
      watchLoop.start();
    }

    startRepl(async (cmd: ReplCommand) => {
      switch (cmd.type) {
        case 'prompt':
          console.log('');
          try {
            conversation = await runAgentStream(cmd.text, conversation.length > 0 ? conversation : []);
            if (sessionId) saveSession(sessionId, conversation);
          } catch (err: any) {
            console.error(`\n[ERROR] ${err.message || err}`);
            console.error('Session continues. You can try again or /model to switch providers.\n');
          }
          break;

        case 'save':
          if (conversation.length === 0) {
            console.log('Nothing to save yet.');
          } else {
            sessionId = sessionId || `session-${Date.now()}`;
            saveSession(sessionId, conversation);
          }
          break;

        case 'load': {
          const items = loadSession(cmd.id);
          if (items) {
            conversation = items;
            sessionId = cmd.id;
          }
          break;
        }

        case 'fork': {
          const newId = forkSession(cmd.id);
          if (newId) {
            const items = loadSession(newId);
            if (items) { conversation = items; sessionId = newId; }
          }
          break;
        }

        case 'list':
          listSessions();
          break;

        case 'clear':
          conversation = [];
          sessionId = null;
          console.log('Conversation cleared.');
          break;

        case 'help':
          console.log('/exit | /clear | /save | /load <id> | /fork <id> | /list | /models | /model <name> | /tools | /watch');
          break;

        case 'models': {
          const allModels = listModels();
          console.log('\nAvailable models:');
          // Re-read providers.json to map models to providers
          try {
            const raw = fs.readFileSync(providersJsonPath, 'utf8');
            const data = JSON.parse(raw);
            for (const provider of data.providers) {
              for (const m of provider.models) {
                const marker = m === model ? ' (current)' : '';
                console.log(`  ${m.padEnd(22)} [${provider.id}]${marker}`);
              }
            }
          } catch {
            for (const m of allModels) {
              const marker = m === model ? ' (current)' : '';
              console.log(`  ${m}${marker}`);
            }
          }
          console.log('');
          break;
        }

        case 'tools': {
          const fileTools = createTools(options.agentDir);
          const allToolNames = [
            'apply_patch',
            'bash',
            'bash_stream',
            ...fileTools.map((t: any) => t.name),
            ...mcpTools.map((t: any) => t.name),
          ];
          console.log(`\nAvailable tools (${allToolNames.length}):`);
          for (const name of allToolNames) {
            console.log(`  ${name}`);
          }
          console.log('');
          break;
        }

        case 'switch-model': {
          const allModels = listModels();
          if (!allModels.includes(cmd.model)) {
            console.log(`\nUnknown model '${cmd.model}'. Available models:`);
            for (const m of allModels) {
              console.log(`  ${m}`);
            }
            console.log('');
            break;
          }
          const newResolved = resolveModel(cmd.model);
          checkApiKey(newResolved);
          resolved = newResolved;
          model = cmd.model;
          console.log(`\nSwitched to model: ${model} (provider: ${resolved.provider.id})\n`);
          break;
        }

        case 'watch-on': {
          if (cmd.paths && cmd.paths.length > 0) {
            console.log(`\nStarting watch on: ${cmd.paths.join(', ')}`);
            watchConfig.paths = cmd.paths;
          } else {
            watchConfig.paths = [...defaultWatchPaths]; // reset to CLI defaults
          }
          if (watchLoop && watchLoop.isRunning()) {
            watchLoop.stop();
          }
          watchConfig.model = model;
          watchLoop = new WatchLoop(watchConfig);
          watchLoop.start();
          break;
        }

        case 'watch-off': {
          if (watchLoop && watchLoop.isRunning()) {
            watchLoop.stop();
            watchLoop = null;
            console.log('Watch stopped.');
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

        case 'exit':
          break;
      }
    });
    return;
  }

  // One-shot mode — user provided a prompt
  // Connect to MCP server and load tools (one-shot mode)
  if (mcpServerConfig && !mcpClient) {
    mcpClient = new MCPClient(mcpServerConfig);
    try {
      await mcpClient.connect();
      mcpTools = await loadMCPTools(mcpClient);
      console.error(`Loaded ${mcpTools.length} MCP tools from ${mcpServerConfig.command}`);
    } catch (err: any) {
      console.error(`Warning: Failed to load MCP tools: ${err.message}`);
      mcpClient = null;
      mcpTools = [];
    }
    process.on('exit', () => {
      if (mcpClient) mcpClient.disconnect();
    });
  }

  const mcpInfoOneShot = mcpTools.length > 0 ? ` | MCP tools: ${mcpTools.length}` : '';
  console.log(`Skill Pilot spcode starting session with model: ${model} (provider: ${resolved.provider.id})${mcpInfoOneShot}`);

  try {
    const conversation = await runAgentStream(userPrompt, []);
    const sessionId = `session-${Date.now()}`;
    saveSession(sessionId, conversation);
  } catch (error: any) {
    console.error('Error during agent execution:', error.message);
    process.exit(1);
  }
}

main();
