import fs from 'node:fs';
import path from 'node:path';
import { ArloError } from '@arlo/sdk';
import { prepareStateDirectory, writePrivateStateFile } from '../storage/index.ts';
import { acquireStateMutex, type StateMutexRelease } from '../storage/mutex.ts';

/** Native package tools must not follow a selected configuration into another owner. */
export function assertConfigurationFile(file: string): void {
  try {
    const entry = fs.lstatSync(file);
    if (!entry.isFile() || entry.nlink !== 1) throw new Error('CONFIGURATION_TARGET_CONFLICT');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** A retained symlink still names its original target after a package is removed. */
export function recordedPackageDirectory(selected: string): string {
  const absolute = path.resolve(selected);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) return path.resolve(path.dirname(absolute), fs.readlinkSync(absolute));
  } catch { /* A deleted npm package has no remaining link. */ }
  return absolute;
}

/** Coordinates only this configuration scope; never locks or restarts the shared Daemon. */
export async function setupTransaction(directory: string): Promise<StateMutexRelease> {
  prepareStateDirectory(directory);
  try { return await acquireStateMutex(directory); }
  catch (error) {
    if (error instanceof ArloError && error.code === 'DAEMON_ALREADY_RUNNING') {
      throw new Error('SETUP_BUSY');
    }
    throw error;
  }
}

export function persistSetupRecord(file: string, value: object): void {
  prepareStateDirectory(path.dirname(file));
  // Existing ownership and ACL validation is also performed by the durable writer.
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('UNSAFE_SETUP_RECORD');
  writePrivateStateFile(path.dirname(file), path.basename(file), JSON.stringify(value, null, 2) + '\n', true);
}
