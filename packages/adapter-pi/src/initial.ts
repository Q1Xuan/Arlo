import crypto from 'node:crypto';
import fs from 'node:fs';
import { captureRootConfigurationEvidence, type RootFirstUseEvidence } from '@arlo/sdk';
import { parseSessionEntries, type ExtensionContext } from '@earendil-works/pi-coding-agent';

type Manager = ExtensionContext['sessionManager'];
const CUSTOM_TYPE = 'arlo-first-use';
const MAX_INITIAL_BYTES = 16 * 1024 * 1024;
/** Identical immutable origin for ownership and first-use evidence. */
export function piSessionOrigin(header: ReturnType<Manager['getHeader']>): string {
  return JSON.stringify([header?.id, header?.timestamp, header?.cwd, header?.parentSession]);
}

/** Pi's native startup/new contract allocates a pristine header and reserves
 * a path. Setup entries stay in memory; the first conversation creates it
 * exclusively. A resume, fork, reload or missing daemon record is no witness. */
export function witnessPiCreation(manager: Manager, reason: string,
  append: (customType: string, data: unknown) => void): (() => RootFirstUseEvidence | undefined) | undefined {
  if (reason !== 'startup' && reason !== 'new') return undefined;
  const header = manager.getHeader();
  const file = manager.getSessionFile();
  if (!header || header.parentSession || header.id !== manager.getSessionId() || !file || fs.existsSync(file)) return undefined;
  const setup = manager.getEntries();
  if (setup.some(entry => !['model_change', 'thinking_level_change', 'session_info'].includes(entry.type))) return undefined;
  const birth = piSessionOrigin(manager.getHeader());
  const creationId = crypto.randomUUID();
  append(CUSTOM_TYPE, { creation_id: creationId, host_origin: birth });
  const prefix = JSON.stringify([header, ...manager.getEntries()]);
  const marker = manager.getEntries().at(-1);
  if (manager.getHeader() !== header || piSessionOrigin(manager.getHeader()) !== birth || manager.getSessionFile() !== file ||
      marker?.type !== 'custom' || marker.customType !== CUSTOM_TYPE ||
      JSON.stringify(marker.data) !== JSON.stringify({ creation_id: creationId, host_origin: birth })) return undefined;
  let attempted = false;
  return () => {
    if (attempted) return undefined;
    if (!fs.existsSync(file)) {
      // Setup-only history is not yet saved. A conversation with no durable
      // artifact has lost persistence evidence and cannot become fresh later.
      attempted = manager.getEntries().some(entry => entry.type === 'message' &&
        (entry.message.role === 'user' || entry.message.role === 'assistant'));
      return undefined;
    }
    attempted = true;
    // Failure after materialization is terminal for this witness. Repairing a
    // file cannot turn historical uncertainty into another automatic grant.
    let descriptor: number | undefined;
    try {
      if (manager.getHeader() !== header || manager.getSessionId() !== header.id ||
          manager.getSessionFile() !== file || piSessionOrigin(manager.getHeader()) !== birth) return undefined;
      descriptor = fs.openSync(file, 'r');
      const pinned = captureRootConfigurationEvidence(file, descriptor, birth);
      const stat = fs.fstatSync(descriptor);
      if (stat.size <= 0 || stat.size > MAX_INITIAL_BYTES) return undefined;
      const bytes = Buffer.alloc(stat.size);
      if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) return undefined;
      const text = bytes.toString('utf8');
      if (!text.endsWith('\n')) return undefined;
      // Pi's parser can omit damaged lines. Independently parse every line,
      // then compare the full durable artifact with the native public view.
      const raw = text.trimEnd().split('\n').map(line => JSON.parse(line));
      const parsed = parseSessionEntries(text);
      const live = [manager.getHeader(), ...manager.getEntries()];
      if (JSON.stringify(raw) !== JSON.stringify(parsed) || JSON.stringify(parsed) !== JSON.stringify(live) ||
          JSON.stringify(parsed.slice(0, JSON.parse(prefix).length)) !== prefix ||
          !manager.getEntries().some(entry => entry.type === 'message' &&
            (entry.message.role === 'user' || entry.message.role === 'assistant')) ||
          manager.getHeader() !== header || piSessionOrigin(manager.getHeader()) !== birth || manager.getSessionFile() !== file ||
          captureRootConfigurationEvidence(file, descriptor).file_revision !== pinned.file_revision) return undefined;
      return { kind: 'new-session-materialized', creation_id: creationId, evidence: pinned };
    } catch { return undefined; }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  };
}
