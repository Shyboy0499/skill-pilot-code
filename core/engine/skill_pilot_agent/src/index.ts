import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Agent, run } from '@openai/agents';
import type { AgentInputItem, StreamEvent } from '@openai/agents-core';
import { z } from 'zod';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { createTools } from './tools';
import { startRepl, type ReplCommand } from './repl';
import { saveSession, loadSession, listSessions, forkSession } from './session';

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
  .option('--approve-tools <yes|no>', 'Require approval before running bash commands', 'no')
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

// Configuration from environment
const baseURL = process.env.SKILL_PILOT_BASE_URL || 'http://localhost:8000/v1';
const apiKey = process.env.SKILL_PILOT_API_KEY || 'no-key';
const defaultModel = process.env.SKILL_PILOT_MODEL || 'skill-pilot';
const model = options.model || defaultModel;

process.env.OPENAI_BASE_URL = baseURL;
process.env.OPENAI_API_KEY = apiKey;

// Helper to load AGENTS.md
function loadInstructions(agentDir: string): string {
  const agentsMdPath = path.join(agentDir, 'AGENTS.md');
  if (fs.existsSync(agentsMdPath)) {
    return fs.readFileSync(agentsMdPath, 'utf8');
  }
  return 'You are a helpful coding assistant named Skill Pilot.';
}

// Helper to load skills
function loadSkills(agentDir: string, skillsDir: string, allowedSkills?: string): string {
  const fullSkillsPath = path.resolve(agentDir, skillsDir);
  if (!fs.existsSync(fullSkillsPath)) return '';

  let skillInstructions = '\n\nAvailable Skills:\n';
  const filter = allowedSkills ? allowedSkills.split(',') : null;

  function scanDir(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
  parameters: z.object({
    command: z.string().describe('The shell command to execute.'),
  }),
  run: async (args: { command: string }) => executeBash(args.command),
};

function buildAgent(): Agent {
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

  return new Agent({
    name: 'Skill Pilot spcode',
    instructions: instructions + multiTurnPrompt + skillInstructions,
    model: model,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: [bashTool as any, ...fileTools.map((t) => t as any)],
  });
}

async function runStreaming(agent: Agent, prompt: string, conversation?: AgentInputItem[]) {
  const input: any = conversation && conversation.length > 0 ? [...conversation, { type: 'message', role: 'user', content: prompt }] : prompt;

  const result = await run(agent, input, {
    maxTurns: maxRetries * 5,
    stream: true,
  }) as any;

  console.log('');

  const collectedItems: AgentInputItem[] = [...(conversation || [])];

  try {
    for await (const event of result as AsyncIterable<StreamEvent>) {
      const evt = event as any;

      if (evt.type === 'raw_model_stream') {
        if (evt.data?.delta) {
          process.stdout.write(evt.data.delta);
        }
      } else if (evt.type === 'run_item_stream') {
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
      } else if (evt.type === 'agent_updated') {
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
  const instructions = loadInstructions(options.agentDir);
  const skillInstructions = loadSkills(options.agentDir, options.skillsDir, options.skills);

  // No prompt + TTY → REPL mode. No prompt + pipe → show help.
  if (!userPrompt) {
    if (!process.stdin.isTTY) {
      program.help();
      process.exit(0);
    }

    const agent = buildAgent();
    console.log(`Skill Pilot spcode starting session with model: ${model}`);

    let conversation: AgentInputItem[] = [];
    let sessionId: string | null = null;

    startRepl(async (cmd: ReplCommand) => {
      switch (cmd.type) {
        case 'prompt':
          console.log('');
          conversation = await runStreaming(agent, cmd.text, conversation.length > 0 ? conversation : undefined);
          if (sessionId) saveSession(sessionId, conversation);
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
          console.log('/exit | /clear | /save | /load <id> | /fork <id> | /list');
          break;

        case 'exit':
          break;
      }
    });
    return;
  }

  // One-shot mode — user provided a prompt
  const agent = buildAgent();
  console.log(`Skill Pilot spcode starting session with model: ${model}`);

  try {
    const conversation = await runStreaming(agent, userPrompt);
    const sessionId = `session-${Date.now()}`;
    saveSession(sessionId, conversation);
  } catch (error: any) {
    console.error('Error during agent execution:', error.message);
    process.exit(1);
  }
}

main();
