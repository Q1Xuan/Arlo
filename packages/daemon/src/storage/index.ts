import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { acquireStateMutex, type StateMutexRelease } from './mutex.ts';
export type { StateMutexRelease } from './mutex.ts';
import {
  ArloErrorCode,
  ArloError,
  getCurrentUserSid,
  enforceWindowsAcl,
  verifyWindowsAcl,
  assertSafeStatePath,
  type DaemonDiscoveryRecord,
} from '@arlo/sdk';

export interface DaemonLockContent {
  pid: number;
  daemon_id: string;
  created_at: string;
  owner_sid: string;
}

export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error.code === 'EPERM') {
      return true; // Process exists but owned by someone else
    }
    return false; // ESRCH -> process does not exist
  }
}

export function prepareStateDirectory(stateDir: string): void {
  assertSafeStatePath(stateDir);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }

  enforceWindowsAcl(stateDir, true);

  const verification = verifyWindowsAcl(stateDir);
  if (!verification.valid) {
    throw new ArloError(
      verification.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS,
      verification.detail ?? 'State directory failed security verification'
    );
  }
}

export function writePrivateStateFile(stateDir: string, name: string, content: string, durable = false, beforeCommit?: () => void): void {
  const target = path.join(stateDir, name);
  try {
    fs.lstatSync(target);
    const existing = verifyWindowsAcl(target);
    if (!existing.valid) throw new ArloError(existing.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = path.join(stateDir, `${name}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    enforceWindowsAcl(temporary, false);
    const check = verifyWindowsAcl(temporary);
    if (!check.valid) throw new ArloError(check.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS);
    if (durable) {
      const fd = fs.openSync(temporary, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    beforeCommit?.();
    fs.renameSync(temporary, target);
    if (durable && process.platform === 'linux') {
      const fd = fs.openSync(stateDir, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export async function acquireDaemonLock(stateDir: string, daemonId: string, currentPid: number): Promise<StateMutexRelease> {
  const release = await acquireStateMutex(stateDir);
  try {
    claimDaemonLock(stateDir, daemonId, currentPid);
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

function claimDaemonLock(stateDir: string, daemonId: string, currentPid: number): void {
  const lockPath = path.join(stateDir, 'daemon.lock');

  if (fs.existsSync(lockPath)) {
    const aclVerif = verifyWindowsAcl(lockPath);
    if (!aclVerif.valid) {
      throw new ArloError(
        aclVerif.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS,
        aclVerif.detail ?? 'Lock file failed security verification'
      );
    }

    let existingLock: DaemonLockContent | undefined;
    try {
      const content = fs.readFileSync(lockPath, 'utf8');
      existingLock = JSON.parse(content) as DaemonLockContent;
    } catch {
      throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
    }

    if (!existingLock || !Number.isSafeInteger(existingLock.pid) || existingLock.pid <= 0 ||
        typeof existingLock.daemon_id !== 'string' || existingLock.owner_sid !== getCurrentUserSid()) {
      throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
    }
    if (existingLock && process.platform !== 'linux') {
      if (isProcessAlive(existingLock.pid)) {
        // If it's the exact same daemon instance, it already owns the lock
        if (existingLock.daemon_id === daemonId && existingLock.pid === currentPid) {
          return;
        }

        // Another daemon instance or process holds the lock
        const discoveryPath = path.join(stateDir, 'discovery.json');
        if (fs.existsSync(discoveryPath)) {
          try {
            const disc = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
            if (disc.daemon_id === existingLock.daemon_id && disc.pid === existingLock.pid) {
              throw new ArloError(
                ArloErrorCode.DAEMON_ALREADY_RUNNING,
                'Active winning daemon instance is already running'
              );
            }
          } catch (e) {
            if (e instanceof ArloError) throw e;
          }
        }

        // Process is alive but not confirmed active winning daemon: DO NOT KILL THE PROCESS
        throw new ArloError(
          ArloErrorCode.LOCK_ACQUISITION_FAILED,
          'Lock held by an active process; cannot kill foreign processes'
        );
      }
    }
  }

  // Reclaim a dead lock only while holding the OS mutex. This serializes the
  // entire read/check/replace sequence, including simultaneous stale recovery.
  const lockContent: DaemonLockContent = {
    pid: currentPid,
    daemon_id: daemonId,
    created_at: new Date().toISOString(),
    owner_sid: getCurrentUserSid(),
  };

  writePrivateStateFile(stateDir, 'daemon.lock', JSON.stringify(lockContent, null, 2));
}

export function publishDiscoveryRecord(stateDir: string, record: DaemonDiscoveryRecord): void {
  writePrivateStateFile(stateDir, 'discovery.json', JSON.stringify(record, null, 2));
}

export function cleanInstanceResources(stateDir: string, daemonId: string, bootstrapToken?: string): void {
  if (process.platform === 'linux') {
    try { assertSafeStatePath(stateDir); }
    catch { return; }
  }
  let ownsLock = false;
  let ownsDiscovery = false;

  // Only remove lock if it belongs to this daemonId
  const lockPath = path.join(stateDir, 'daemon.lock');
  if (fs.existsSync(lockPath) && (process.platform !== 'linux' || verifyWindowsAcl(lockPath).valid)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (lock.daemon_id === daemonId) {
        ownsLock = true;
      }
    } catch {}
  }

  // Only remove discovery.json if it belongs to this daemonId
  const discPath = path.join(stateDir, 'discovery.json');
  if (fs.existsSync(discPath) && (process.platform !== 'linux' || verifyWindowsAcl(discPath).valid)) {
    try {
      const disc = JSON.parse(fs.readFileSync(discPath, 'utf8'));
      if (disc.daemon_id === daemonId) {
        ownsDiscovery = true;
      }
    } catch {}
  }

  // Only remove bootstrap token if this instance owned the lock or discovery record
  if (ownsDiscovery || (ownsLock && bootstrapToken)) {
    const tokenPath = path.join(stateDir, 'bootstrap.token');
    if (fs.existsSync(tokenPath) && (process.platform !== 'linux' || verifyWindowsAcl(tokenPath).valid)) {
      try {
        if (!bootstrapToken || fs.readFileSync(tokenPath, 'utf8') === bootstrapToken) fs.unlinkSync(tokenPath);
      } catch {}
    }
  }
  // Keep the ownership marker until all instance resources have been removed.
  if (ownsDiscovery) fs.unlinkSync(discPath);
  if (ownsLock) fs.unlinkSync(lockPath);
}
