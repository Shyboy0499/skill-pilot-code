import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Agent, run } from '@openai/agents';
import type { FunctionTool } from '@openai/agents-core';
import { z } from 'zod';
import { Command } from 'commander';
import dotenv from 'dotenv';

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
  console.log(`[BASH] Executing: ${command}`);
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

const bashTool: FunctionTool = {
  type: 'function',
  name: 'bash',
  description: 'Execute a bash command on the system. Use this to read files, run tests, or modify code.',
  parameters: z.object({
    command: z.string().describe('The shell command to execute.'),
  }),
  run: async (args) => executeBash(args.command as string),
};

// Main execution
async function main() {
  if (!userPrompt) {
    program.help();
    process.exit(0);
  }

  const instructions = loadInstructions(options.agentDir);
  const skillInstructions = loadSkills(options.agentDir, options.skillsDir, options.skills);

  const skillPilotAgent = new Agent({
    name: 'Skill Pilot spcode',
    instructions: instructions + skillInstructions,
    model: model,
    tools: [bashTool],
  });

  console.log(`Skill Pilot spcode starting session with model: ${model}`);

  try {
    const result = await run(skillPilotAgent, userPrompt, {
      maxTurns: maxRetries * 5,
    });

    console.log('\n--- Final Output ---\n');
    console.log(result.finalOutput);
  } catch (error: any) {
    console.error('Error during agent execution:', error.message);
    process.exit(1);
  }
}

main();
