import { DaemonClient, ArloError, ArloErrorCode } from '@arlo/sdk';
import { ArloDaemon } from '../server/index.ts';
import { runSetupCli } from '../setup/index.ts';
import { stdin, stdout } from 'node:process';
import { selectCommand } from './menu.ts';

export interface CliOptions {
  stateDir?: string;
  port?: number;
  json?: boolean;
}

export function parseCliArgs(args: string[]): { command: string; options: CliOptions } {
  const explicitCommand = args[0] && !args[0].startsWith('-');
  const command = explicitCommand ? args[0] : 'status';
  const options: CliOptions = {};

  for (let i = explicitCommand ? 1 : 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--state-dir' && i + 1 < args.length) {
      options.stateDir = args[++i];
    } else if (arg === '--port' && i + 1 < args.length) {
      options.port = parseInt(args[++i], 10);
    } else if (arg === '--json') {
      options.json = true;
    }
  }

  return { command, options };
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<number> {
  if ((!args[0] || args[0].startsWith('-')) && stdin.isTTY && stdout.isTTY && !args.includes('--json')) {
    const command = await selectCommand();
    if (!command) {
      console.log('Cancelled. No changes applied.');
      return 0;
    }
    if (command === 'setup') console.log('Setup finds an existing host, previews coordinated component installation and registers native user access after confirmation.');
    if (command === 'uninstall') console.log('Uninstall removes the owned host registration and cleans matching unshared components through their recorded package manager after confirmation.');
    args = [command, ...args];
  }
  if (['setup', 'setup-status', 'uninstall'].includes(args[0])) return runSetupCli(args[0], args.slice(1));
  const { command, options } = parseCliArgs(args);

  try {
    if (command === 'serve') {
      const daemon = new ArloDaemon({
        stateDir: options.stateDir,
        port: options.port,
      });

      const { port, daemonId } = await daemon.start();
      console.log(`Arlo Daemon started on https://127.0.0.1:${port} (PID: ${process.pid}, Daemon ID: ${daemonId})`);

      let exiting = false;
      const handleExit = async () => {
        if (exiting) return;
        exiting = true;
        console.log('\nShutting down Arlo Daemon...');
        try {
          await daemon.stop();
          process.exit(0);
        } catch {
          console.error(JSON.stringify({ error: ArloErrorCode.CORRUPTED_STATE }));
          process.exit(1);
        }
      };

      process.on('SIGINT', handleExit);
      process.on('SIGTERM', handleExit);

      // Keep running
      return 0;
    }

    if (command === 'status') {
      const client = new DaemonClient({ stateDir: options.stateDir });
      const status = await client.getStatus();

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log('Arlo Daemon Status:');
        console.log(`  Daemon ID: ${status.daemon_id}`);
        console.log(`  PID:       ${status.pid}`);
        console.log(`  Port:      ${status.port}`);
        console.log(`  Status:    ${status.status}`);
        console.log(`  Uptime:    ${status.uptime_ms} ms`);
        console.log(`  Protocol:  ${status.protocol_version}`);
        console.log(`  Listener:  ${status.listener}`);
      }
      return 0;
    }

    if (command === 'doctor') {
      const client = new DaemonClient({ stateDir: options.stateDir });
      const report = await client.getDoctor();

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log('Arlo Doctor Diagnostic Report:');
        console.log(`  Overall:   ${report.overall_status.toUpperCase()}`);
        console.log(`  Daemon ID: ${report.daemon_id ?? 'unknown'}`);
        if (report.runtime) console.log(`  Runtime:   ${report.runtime.executable} (Node ${report.runtime.node}, PID ${report.runtime.pid})`);
        console.log('  Checks:');
        for (const check of report.checks) {
          const badge = check.status === 'pass' ? '[PASS]' : check.status === 'warn' ? '[WARN]' : '[FAIL]';
          console.log(`    ${badge} ${check.name}${check.error_code ? ` (${check.error_code})` : ''}`);
        }
      }
      return report.overall_status === 'healthy' ? 0 : 1;
    }

    throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
  } catch (error: any) {
    const code = error instanceof ArloError ? error.code : ArloErrorCode.CORRUPTED_STATE;
    if (options.json) {
      console.error(JSON.stringify({ error: code }));
    } else {
      console.error(`Error: [${code}]`);
    }
    return 1;
  }
}
