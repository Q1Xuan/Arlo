import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ArloError, ArloErrorCode } from '@arlo/sdk';

export interface ParticipationStatus {
  configured: boolean;
  /** null until synchronization succeeds; saving errors preserve this value. */
  effective: boolean | null;
  error?: string;
}

/** Configuration identity is adapter-owned; no path is published to the Daemon. */
export function participationScope(configPath: string): string {
  if (!path.isAbsolute(configPath)) throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
  let parent = path.resolve(configPath);
  const missing: string[] = [];
  while (!fs.existsSync(parent)) {
    missing.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  let canonical = path.join(fs.realpathSync(parent), ...missing);
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function readParticipationPreference(configPath: string): boolean {
  return readConfig(configPath).crossHostEnabled === true;
}

function readConfig(configPath: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ('crossHostEnabled' in value && typeof value.crossHostEnabled !== 'boolean')) {
      throw new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Invalid Arlo plugin settings');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error instanceof ArloError ? error : new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Cannot read Arlo plugin settings');
  }
}

/** Shared by native settings entries. Polling rereads the file across host
 * processes; an acknowledgement changes all registered runtimes of this host
 * using the same scope. Settings never replace roots or touch received input. */
export function createParticipationSettings(options: {
  configPath: string;
  prepare: () => Promise<{ effective: boolean; apply: (enabled: boolean) => Promise<boolean> }>;
  changed?: (status: ParticipationStatus) => void;
  /** Zero disables the clock for deterministic callers. */
  pollIntervalMs?: number;
}) {
  participationScope(options.configPath);
  let state: ParticipationStatus = { configured: readParticipationPreference(options.configPath), effective: null };
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const status = (): ParticipationStatus => ({ ...state });
  const publish = () => options.changed?.(status());
  const updateState = (next: ParticipationStatus) => {
    const changed = state.configured !== next.configured || state.effective !== next.effective || state.error !== next.error;
    state = next;
    if (changed) publish();
  };
  const live = () => { if (disposed) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY); };

  async function synchronize(forceConfirmation = false): Promise<ParticipationStatus> {
    live();
    try {
      // Re-read after acknowledgement too: another process can save a newer
      // preference while this request is in flight. It must not remain stale.
      for (;;) {
        live();
        const configured = readParticipationPreference(options.configPath);
        if (forceConfirmation || state.configured !== configured) updateState({ configured, effective: null });
        // Capture the common revision before reading the value to apply. A
        // delayed request must never revive a preference already superseded by
        // another process, even if this updater disappears before its response.
        const update = await options.prepare();
        live();
        const enabled = readParticipationPreference(options.configPath);
        if (!forceConfirmation && update.effective === enabled) {
          updateState({ configured: enabled, effective: enabled });
          return status();
        }
        updateState({ configured: enabled, effective: null });
        let confirmed: boolean;
        try { confirmed = await update.apply(enabled); }
        catch (error) {
          if (error instanceof ArloError && error.code === ArloErrorCode.STALE_GENERATION) continue;
          throw error;
        }
        live();
        if (confirmed !== enabled) throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
        if (readParticipationPreference(options.configPath) !== enabled) continue;
        updateState({ configured: enabled, effective: confirmed });
        return status();
      }
    } catch (error) {
      if (!disposed) {
        updateState({ configured: state.configured, effective: null,
          error: error instanceof ArloError ? error.code : ArloErrorCode.CONNECTION_FAILED });
      }
      throw error;
    }
  }
  function enqueue(job: () => Promise<ParticipationStatus>): Promise<ParticipationStatus> {
    const result = queue.then(job);
    queue = result.catch(() => {});
    return result;
  }
  const refresh = () => enqueue(() => synchronize());
  function set(enabled: boolean): Promise<ParticipationStatus> {
    return enqueue(async () => {
      live();
      if (typeof enabled !== 'boolean') throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
      const config = { ...readConfig(options.configPath), crossHostEnabled: enabled };
      fs.mkdirSync(path.dirname(options.configPath), { recursive: true });
      const temporary = `${options.configPath}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, options.configPath);
      } finally { fs.rmSync(temporary, { force: true }); }
      // Another runtime sharing this configuration can make the cached status
      // stale. An explicit setting always requires a fresh Daemon confirmation.
      return synchronize(true);
    });
  }
  const interval = options.pollIntervalMs ?? 500;
  const timer = interval > 0 ? setInterval(() => { void refresh().catch(() => {}); }, interval) : undefined;
  timer?.unref();
  return { status, refresh, set, dispose() { disposed = true; if (timer) clearInterval(timer); } };
}
