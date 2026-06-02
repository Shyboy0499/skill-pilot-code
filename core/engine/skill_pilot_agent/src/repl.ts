import { createInterface } from 'node:readline';

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
  | { type: 'watch-on'; paths: string[] }
  | { type: 'watch-off' }
  | { type: 'watch-status' }
  | { type: 'fix'; paths: string[] };

export function startRepl(onCommand: (cmd: ReplCommand) => Promise<void>): void {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n> ',
  });

  console.log('Skill Pilot Agent — multi-turn mode');
  console.log('  /help          Show commands');
  console.log('  /exit          End session');
  console.log('  /clear         Reset conversation');
  console.log('  /save          Save current session');
  console.log('  /load <id>     Load a saved session');
  console.log('  /fork <id>     Fork a saved session');
  console.log('  /list          List saved sessions');
  console.log('  /models        List available models');
  console.log('  /tools         List available tools');
  console.log('  /model <name>  Switch to a different model');
  console.log('  /watch <on|off|status>  Manage live coding watch mode');
  console.log('  /fix [paths]    Run a one-shot fix cycle on specified paths');
  console.log('');

  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    let cmd: ReplCommand;

    if (trimmed === '/exit') {
      cmd = { type: 'exit' };
    } else if (trimmed === '/clear') {
      cmd = { type: 'clear' };
    } else if (trimmed === '/save') {
      cmd = { type: 'save' };
    } else if (trimmed === '/list') {
      cmd = { type: 'list' };
    } else if (trimmed === '/help') {
      cmd = { type: 'help' };
    } else if (trimmed === '/models') {
      cmd = { type: 'models' };
    } else if (trimmed === '/tools') {
      cmd = { type: 'tools' };
    } else if (trimmed.startsWith('/load ')) {
      cmd = { type: 'load', id: trimmed.slice(6).trim() };
    } else if (trimmed.startsWith('/fork ')) {
      cmd = { type: 'fork', id: trimmed.slice(6).trim() };
    } else if (trimmed.startsWith('/model ')) {
      cmd = { type: 'switch-model', model: trimmed.slice(7).trim() };
    } else if (trimmed === '/watch' || trimmed.startsWith('/watch on')) {
      const rest = trimmed.startsWith('/watch on ') ? trimmed.slice(10).trim() : '';
      const paths = rest ? rest.split(',').map(p => p.trim()).filter(Boolean) : [];
      cmd = { type: 'watch-on', paths };
    } else if (trimmed === '/watch off') {
      cmd = { type: 'watch-off' };
    } else if (trimmed === '/watch status') {
      cmd = { type: 'watch-status' };
    } else if (trimmed === '/fix') {
      cmd = { type: 'fix', paths: [] };
    } else if (trimmed.startsWith('/fix ')) {
      var fixPaths = trimmed.slice(5).trim().split(',').map(function(p) { return p.trim(); }).filter(Boolean);
      cmd = { type: 'fix', paths: fixPaths };
    } else {
      cmd = { type: 'prompt', text: trimmed };
    }

    if (cmd.type === 'exit') {
      rl.close();
      return;
    }

    try {
      await onCommand(cmd);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nSession ended.');
    process.exit(0);
  });
}

