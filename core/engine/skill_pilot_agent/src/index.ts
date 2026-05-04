import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Agent, run } from '@openai/agents';
import { OpenAI } from 'openai';
import { z } from 'zod';
import { Command } from 'commander';
import dotenv from 'dotenv';

dotenv.config();

const program = new Command();

program
  .name('skill-pilot-agent')
  .description('Skill Pilot Agent CLI')
  .option('--sandbox <yes|no>', 'Run in a sandbox environment', 'yes')
  .option('--auto <yes|no>', 'Automatically use tools', 'yes')
  .option('--network <yes|no>', 'Allow network access', 'no')
  .option('--model <model>', 'Override the default model')
  .option('--agent-dir <path>', 'Root directory where the agent operates', process.cwd())
  .option('--log-level <level>', 'Log level', 'info')
  .option('--max-retries <number>', 'Max number of retries', '3')
  .option('--timeout <seconds>', 'Task timeout', '60')
  .option('--bash-commands <commands>', 'Allowed bash commands')
  .option('--skills-dir <path>', 'Skills directory', '.agent')
  .option('--skills <skills>', 'Allowed skills')
  .argument('[prompt]', 'The user prompt');

program.parse();

const options = program.opts();
const userPrompt = program.args[0];

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
  const skillFiles = fs.readdirSync(fullSkillsPath);
  
  const filter = allowedSkills ? allowedSkills.split(',') : null;

  for (const file of skillFiles) {
    if (filter && !filter.includes(file) && !filter.includes(path.parse(file).name)) continue;
    
    const content = fs.readFileSync(path.join(fullSkillsPath, file), 'utf8');
    skillInstructions += `\n--- Skill: ${file} ---\n${content}\n`;
  }
  return skillInstructions;
}

// Bash Tool implementation
async function executeBash(command: string): Promise<string> {
  console.log(`[BASH] Executing: ${command}`);
  
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd: options.agentDir });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout || 'Command executed successfully (no output).');
      } else {
        resolve(`Error (exit code ${code}):\n${stderr}\n${stdout}`);
      }
    });

    child.on('error', (err) => {
      resolve(`Failed to spawn process: ${err.message}`);
    });
  });
}

const bashTool: any = {
  type: 'function',
  name: 'bash',
  description: 'Execute a bash command on the system. Use this to read files, run tests, or modify code.',
  parameters: z.object({
    command: z.string().describe('The shell command to execute.'),
  }),
  run: async (args: any) => executeBash(args.command),
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
      maxTurns: parseInt(options.maxRetries) * 5, // Buffering turns
    });

    console.log('\n--- Final Output ---\n');
    console.log(result.finalOutput);
  } catch (error: any) {
    console.error('Error during agent execution:', error.message);
    process.exit(1);
  }
}

main();
