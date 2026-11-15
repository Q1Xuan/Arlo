import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentUserSid, windowsPowerShellEnv, verifyWindowsAcl, ArloError, ArloErrorCode } from '@arlo/sdk';

export type StateMutexRelease = (() => Promise<void>) & { isHeld(): boolean };

export async function acquireStateMutex(stateDir: string): Promise<StateMutexRelease> {
  if (process.platform === 'linux') {
    const guard = path.join(stateDir, 'coordination.lock');
    let fd: number | undefined;
    try {
      try {
        fs.lstatSync(guard);
        const existing = verifyWindowsAcl(guard);
        if (!existing.valid) throw new ArloError(existing.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      fd = fs.openSync(guard, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      const check = verifyWindowsAcl(guard);
      if (!check.valid) throw new ArloError(check.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS);
      // flock operates on the inherited open file description. The parent keeps
      // that description alive; even SIGKILL releases it without PID heuristics.
      const result = cp.spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 10000,
      });
      if (result.status !== 0) throw new ArloError(result.status === 1
        ? ArloErrorCode.DAEMON_ALREADY_RUNNING : ArloErrorCode.LOCK_ACQUISITION_FAILED);
      const ownedFd = fd;
      let released = false;
      return Object.assign(async () => {
        if (!released) { released = true; fs.closeSync(ownedFd); }
        // Never unlink: waiters must continue to lock the same inode.
      }, { isHeld: () => !released });
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (error instanceof ArloError) throw error;
      throw new ArloError(ArloErrorCode.LOCK_ACQUISITION_FAILED);
    }
  }
  if (process.platform !== 'win32') {
    // Other platforms remain fail-closed until their platform work item.
    const guard = path.join(stateDir, 'coordination.lock');
    let fd: number;
    try { fd = fs.openSync(guard, 'wx', 0o600); }
    catch (error) {
      throw new ArloError((error as NodeJS.ErrnoException).code === 'EEXIST'
        ? ArloErrorCode.DAEMON_ALREADY_RUNNING
        : ArloErrorCode.LOCK_ACQUISITION_FAILED);
    }
    let released = false;
    return Object.assign(async () => {
      if (!released) { released = true; fs.closeSync(fd); fs.unlinkSync(guard); }
    }, { isHeld: () => !released });
  }
  const identity = fs.realpathSync.native(stateDir).toLowerCase();
  const name = `Global\\Arlo-${getCurrentUserSid()}-${crypto.createHash('sha256').update(identity).digest('hex')}`;
  const helper = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./windows-mutex.ps1', import.meta.url)), '-Name', name], {
    windowsHide: true, env: windowsPowerShellEnv(), stdio: ['pipe', 'pipe', 'ignore'],
  });
  helper.stdin.on('error', () => {});
  const exited = new Promise<void>(resolve => helper.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    let output = '';
    const fail = (code: ArloErrorCode = ArloErrorCode.LOCK_ACQUISITION_FAILED) => {
      clearTimeout(timeout);
      if (!ready) reject(new ArloError(code));
    };
    const timeout = setTimeout(() => { helper.kill(); fail(); }, 10000);
    helper.once('error', () => fail());
    helper.once('close', () => fail());
    helper.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('ACQUIRED')) {
        ready = true;
        clearTimeout(timeout);
        resolve();
      } else if (output.includes('BUSY')) {
        fail(ArloErrorCode.DAEMON_ALREADY_RUNNING);
      }
    });
  });
  let released = false;
  return Object.assign(async () => {
    if (!released) { released = true; helper.stdin.end('release\n'); }
    await exited;
  }, { isHeld: () => !released && helper.exitCode === null && helper.signalCode === null });
}
