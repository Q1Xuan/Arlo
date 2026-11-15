import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

/** Select a command; execution stays with the existing CLI flows. */
export async function selectCommand(): Promise<string | undefined> {
  const commands = ['setup', 'doctor', 'status', 'uninstall'];
  const prompt = createInterface({ input: stdin, output: stdout });
  prompt.on('SIGINT', () => prompt.close());
  stdout.write('Arlo\n  1. Installation / access setup\n  2. Diagnostic\n  3. View status\n  4. Uninstall\n  0. Cancel\nChoose an action [1-4, 0 to cancel]: ');
  try {
    for await (const line of prompt) {
      const answer = line.trim().toLowerCase();
      if (['', '0', 'q', 'quit', 'cancel'].includes(answer)) return undefined;
      if (/^[1-4]$/.test(answer)) return commands[Number(answer) - 1];
      stdout.write('Choose an action [1-4, 0 to cancel]: ');
    }
    return undefined;
  } finally { prompt.close(); }
}
