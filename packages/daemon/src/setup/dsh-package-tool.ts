import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';

type Result = Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'stdout' | 'stderr' | 'error'>;

/** Bound the existing DSH preparation operation, including npm-exec's
 * descendants and inherited output pipes. Windows keeps its existing path;
 * native Windows tree cancellation is part of the final platform acceptance. */
export async function runDshPackageTool(args: string[], cwd: string): Promise<Result> {
  const timeout = 240_000, maxBuffer = 4 * 1024 * 1024;
  if (process.platform === 'win32') return spawnSync(process.execPath, args,
    { cwd, env: process.env, encoding: 'utf8', windowsHide: true, timeout, maxBuffer });
  return new Promise(resolve => {
    // Only this freshly created package operation enters the private group.
    const child = spawn(process.execPath, args, { cwd, env: process.env,
      detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = [], errors: Buffer[] = [];
    let size = 0, failure: NodeJS.ErrnoException | undefined, finished = false;
    let deadline: ReturnType<typeof setTimeout>;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); clearTimeout(fallback);
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', interrupted);
      resolve({ status, signal, stdout: Buffer.concat(output).toString('utf8'),
        stderr: Buffer.concat(errors).toString('utf8'), ...(failure ? { error: failure } : {}) });
    };
    const terminate = (code: string) => {
      if (failure || finished) return;
      failure = Object.assign(new Error(code), { code });
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = Object.assign(
            new Error('DSH_PACKAGE_TERMINATION_UNVERIFIED'), { code: 'DSH_PACKAGE_TERMINATION_UNVERIFIED' });
        }
      }
      fallback = setTimeout(() => {
        failure = Object.assign(new Error('DSH_PACKAGE_TERMINATION_UNVERIFIED'), { code: 'DSH_PACKAGE_TERMINATION_UNVERIFIED' });
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(child.exitCode, child.signalCode);
      }, 5_000);
    };
    const collect = (target: Buffer[], bytes: Buffer) => {
      const remaining = Math.max(0, maxBuffer - size);
      if (remaining) target.push(bytes.subarray(0, remaining));
      size += bytes.length;
      if (size > maxBuffer) terminate('ENOBUFS');
    };
    child.stdout.on('data', bytes => collect(output, bytes));
    child.stderr.on('data', bytes => collect(errors, bytes));
    child.once('error', error => { failure = error; });
    child.once('close', (status, signal) => finish(status, signal));
    const interrupted = () => terminate('EINTR');
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    deadline = setTimeout(() => terminate('ETIMEDOUT'), timeout);
  });
}
