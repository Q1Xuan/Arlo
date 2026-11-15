import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlClient, ArloError, ArloErrorCode, resolveStateDir, assertSafeStatePath,
  inspectWindowsAclBatch, verifyWindowsAcl } from '@arlo/sdk';

function assertPrivateState(stateDir: string): void {
  assertSafeStatePath(stateDir);
  const files: string[] = [];
  for (const name of ['coordination.lock', 'daemon.lock', 'discovery.json', 'daemon.crt', 'daemon.key', 'bootstrap.token']) {
    const target = path.join(stateDir, name);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ArloError(ArloErrorCode.UNSAFE_LOCATION);
      files.push(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const inspections = inspectWindowsAclBatch(files);
  for (const file of files) {
    const check = verifyWindowsAcl(file, inspections[file]);
    if (!check.valid) throw new ArloError(check.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS);
  }
}

export interface SharedDaemonOptions {
  stateDir?: string;
  idleTimeoutMs?: number;
  /** Budget for reaching one authenticated shared daemon. Single-processor
   * machines spend it mostly on concurrent caller and PowerShell inspector
   * startup, so constrained deployments may raise it above the 30s default. */
  startTimeoutMs?: number;
  signal?: AbortSignal;
}

/** Authenticate the shared instance, starting a detached contender if absent.
 * OS ownership is decided by the daemon's lock, never by a caller's process.
 * Cancelling a caller does not terminate an instance other callers may use. */
export async function ensureSharedDaemon(options: SharedDaemonOptions = {}): Promise<string> {
  const idleTimeoutMs = options.idleTimeoutMs ?? 60000;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > 2147483647) {
    throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
  }
  const startTimeoutMs = options.startTimeoutMs ?? 30000;
  if (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs <= 0 || startTimeoutMs > 2147483647) {
    throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
  }
  const stateDir = resolveStateDir(options.stateDir);
  const controller = new AbortController();
  const cancelled = () => controller.abort(new ArloError(ArloErrorCode.CONNECTION_FAILED));
  options.signal?.addEventListener('abort', cancelled, { once: true });
  if (options.signal?.aborted) cancelled();
  const timeout = setTimeout(cancelled, startTimeoutMs);
  let rejectCancelled: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancelled = () => reject(new ArloError(ArloErrorCode.CONNECTION_FAILED));
    controller.signal.addEventListener('abort', rejectCancelled, { once: true });
  });
  // Attach immediately, including the pre-aborted case, to avoid an unhandled rejection.
  void cancellation.catch(() => {});
  let spawned = false;
  let attempts = 0;
  let child: ChildProcess | undefined;
  let startupError: ArloError | undefined;
  try {
    while (true) {
      controller.signal.throwIfAborted();
      if (startupError) throw startupError;
      assertPrivateState(stateDir);
      const client = new ControlClient({ stateDir });
      const dispose = () => client.dispose();
      controller.signal.addEventListener('abort', dispose, { once: true });
      try {
        const daemonId = await Promise.race([client.refreshConnection(), cancellation]);
        controller.signal.throwIfAborted();
        return daemonId;
      } catch (error) {
        controller.signal.throwIfAborted();
        if (!(error instanceof ArloError) || error.code !== ArloErrorCode.DAEMON_NOT_RUNNING) throw error;
      } finally {
        controller.signal.removeEventListener('abort', dispose);
        client.dispose();
      }
      if (!spawned) {
        controller.signal.throwIfAborted();
        if (++attempts > 3) throw new ArloError(ArloErrorCode.CONNECTION_FAILED);
        // Preserve default path semantics in the daemon: on Linux, runtime
        // discovery and persistent audit logs intentionally use separate XDG
        // directories. Resolve explicit overrides before changing child cwd.
        const stateArgs = options.stateDir || process.env.ARLO_STATE_DIR ? [stateDir] : [];
        child = spawn(process.execPath, [
          fileURLToPath(new URL('../../bin/shared.js', import.meta.url)), String(idleTimeoutMs), ...stateArgs,
        ], {
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        child.once('error', () => { startupError = new ArloError(ArloErrorCode.CONNECTION_FAILED); });
        child.once('exit', () => { spawned = false; });
        child.on('message', message => {
          const code = (message as { error?: ArloErrorCode })?.error;
          // A lock loser must discover the winner. Other fixed startup failures
          // are surfaced without exposing paths, process output or credentials.
          if (code === ArloErrorCode.DAEMON_ALREADY_RUNNING) attempts--;
          else if (code) startupError = new ArloError(code);
        });
        child.unref();
        child.channel?.unref();
        spawned = true;
      }
      await Promise.race([delay(100, undefined, { signal: controller.signal }), cancellation]);
    }
  } catch (error) {
    if (controller.signal.aborted) throw new ArloError(ArloErrorCode.CONNECTION_FAILED);
    throw error;
  } finally {
    if (child?.connected) child.disconnect();
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancelled);
    if (rejectCancelled) controller.signal.removeEventListener('abort', rejectCancelled);
  }
}
