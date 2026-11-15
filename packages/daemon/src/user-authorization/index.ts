import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArloError, ArloErrorCode, verifyWindowsAcl, type RootConfigurationStatus,
  type RootSendingStatus, type ContinueCollaborationRequest } from '@arlo/sdk';
import { writePrivateStateFile } from '../storage/index.ts';
import { DEFAULT_SENDING_RULE, loadSendingRules, type SendingRule } from '../autonomous-sending/rules.ts';

const FILE = 'user-authorized-roots.json';
const MARKER = 'user-authorized-roots.initialized';
const MAX_BYTES = 32 * 1024 * 1024;
const CAPACITY = 10_000;
const hash = (x: unknown) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
interface Root { endpointId: string; sessionId: string; generation: number }
interface Row { subject: string; configId: string; period: string | null; sequence: number; granted: number; used: number }
interface Operation {
  id: string; fingerprint: string; result?: RootSendingStatus;
  preparation?: { daemon_id: string; sequence: number };
}
interface Ledger { version: 1; authority: string; namespace: string; rows: Row[]; operations: Operation[]; checksum: string }

/** User consent is independent of native-file evidence. The daemon lifetime OS
 * mutex and synchronous atomic snapshots serialize rows and committed results.
 * Endpoint tokens/generations and expiry are the write lease; daemon restart
 * invalidates them without discarding this ledger. No transcript is inspected. */
export class UserAuthorizationStore {
  private observed = false;
  private claims = new Map<string, Root>();
  private rules: ReadonlyMap<string, SendingRule> = new Map();
  private revision = crypto.randomUUID();
  private rulesError: string | null = null;
  private readonly stateDir: string;
  private readonly daemonId: string;
  private readonly isActive: (root: Root) => boolean;
  constructor(stateDir: string, daemonId: string, isActive: (root: Root) => boolean) {
    this.stateDir = stateDir; this.daemonId = daemonId; this.isActive = isActive;
  }

  initializeRules(): void {
    try { this.rules = loadSendingRules(this.stateDir); this.rulesError = null; }
    catch { this.rulesError = 'Sending rules could not be read'; }
  }
  private subject(root: Root): string { return hash(['claudecode', 'user-authorized', root.sessionId]); }
  forget(endpointId: string): void {
    for (const [key, owner] of this.claims) if (owner.endpointId === endpointId) this.claims.delete(key);
  }
  private claim(root: Root): void {
    if (!this.isActive(root)) throw new ArloError(ArloErrorCode.STALE_GENERATION);
    const key = this.subject(root), old = this.claims.get(key);
    if (old && this.isActive(old) && (old.endpointId !== root.endpointId || old.generation !== root.generation)) {
      throw new ArloError(ArloErrorCode.BINDING_MISMATCH, 'Another live attachment holds this session write lease.');
    }
    this.claims.set(key, root);
  }
  private row(ledger: Ledger, root: Root): Row | undefined { return ledger.rows.find(r => r.subject === this.subject(root)); }
  private rule(row?: Row): SendingRule { return row ? this.rules.get(row.configId) ?? DEFAULT_SENDING_RULE : DEFAULT_SENDING_RULE; }
  private configuration(row?: Row, reason?: RootConfigurationStatus['reason']): RootConfigurationStatus {
    return { root_authenticated: true, config_id: row?.configId ?? null,
      config_path: path.join(this.stateDir, 'autonomous-communication.json'),
      ownership: row ? 'user-authorized' : 'unknown', history: 'unknown',
      reason: reason ?? (row ? 'USER_AUTHORIZED' : 'AUTHORIZATION_REQUIRED'),
      guidance: row ? '用户已授权绑定。Native transcript replacement with the same ID cannot be detected. Binding and reattachment grant nothing. Complete ledger loss removes duplicate-grant protection.'
        : reason === 'HISTORY_MISSING' ? 'Authorization history is unavailable. Restore the complete ledger; missing history does not prove first use.'
          : 'Use /arlo-authorize to explicitly bind this live session, then /arlo-continue to issue allowance. Same-ID transcript continuity is not verified. Complete ledger loss can permit duplicate grants after a new authorization.' };
  }
  private describe(row?: Row, reason?: RootConfigurationStatus['reason']): RootSendingStatus {
    const rule = this.rule(row), known = !!row?.period;
    const remaining = known && rule.mode === 'bounded' ? Math.max(0, row!.granted - row!.used) : null;
    return { daemon_id: this.daemonId, mode: rule.mode, period_id: row?.period ?? null,
      knowledge: known ? 'known' : 'unknown', granted: known ? row!.granted : null,
      used: known ? row!.used : null, remaining, next_grant: rule.grant,
      rules_revision: this.revision, rules_error: this.rulesError,
      pause_reason: rule.mode === 'continuous' ? null : !known ? 'ALLOWANCE_UNKNOWN' : remaining === 0 ? 'ALLOWANCE_EXHAUSTED' : null,
      control_sequence: row?.sequence ?? 0, root_configuration: this.configuration(row, reason),
      initial_allowance: { eligibility: 'unknown', reason: 'FIRST_USE_UNPROVEN',
        guidance: 'User-authorized roots never auto-initialize. Explicit authorization grants nothing; explicitly continue collaboration.' } };
  }
  status(root: Root): RootSendingStatus {
    this.claim(root);
    try { return this.describe(this.row(this.load(), root)); }
    catch { return this.describe(undefined, 'HISTORY_MISSING'); }
  }
  configurationStatus(root: Root): RootConfigurationStatus { return this.status(root).root_configuration; }

  authorize(root: Root, requestId: string, revalidate: () => void): RootSendingStatus {
    return this.operate(root, requestId, 'authorize', 0, revalidate);
  }
  /** Persist the original semantic request before the runtime attempts its
   * effect. New attachments recover it by action ID, including uncommitted
   * old-epoch requests, which must never become grants in the new epoch. */
  prepareContinue(root: Root, id: string, revalidate: () => void): ContinueCollaborationRequest {
    this.claim(root); revalidate();
    this.validateOperationId(id);
    const ledger = this.load(), row = this.row(ledger, root);
    const old = ledger.operations.find(op => op.id === id);
    const sequence = old?.preparation?.sequence ?? (old?.result
      ? old.result.control_sequence + (old.result.mode === 'continuous' ? 1 : 0)
      : (row?.sequence ?? 0) + 1);
    if (old && old.fingerprint !== hash([this.subject(root), 'continue', sequence])) {
      throw new ArloError(ArloErrorCode.CONTROL_REQUEST_CONFLICT);
    }
    if (!row) throw new ArloError(ArloErrorCode.ALLOWANCE_UNKNOWN);
    const daemon_id = old?.preparation?.daemon_id ?? old?.result?.daemon_id ?? this.daemonId;
    if (!old) {
      if (ledger.operations.length + ledger.rows.length >= CAPACITY) throw new ArloError(ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE);
      ledger.operations.push({ id, fingerprint: hash([this.subject(root), 'continue', sequence]),
        preparation: { daemon_id, sequence } });
      this.save(ledger, () => { revalidate(); this.claim(root); });
    }
    revalidate(); this.claim(root);
    return { endpoint_id: root.endpointId, generation: root.generation, request_id: id, daemon_id, sequence };
  }
  private validateOperationId(id: string): void {
    if (typeof id !== 'string' || !id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
  }
  continue(root: Root, request: ContinueCollaborationRequest, revalidate: () => void): RootSendingStatus {
    // A committed operation may be read after reattachment/restart. Transport
    // tokens are excluded from its semantic fingerprint, but caller auth is not.
    return this.operate(root, request.request_id, 'continue', request.sequence, () => {
      revalidate();
      if (request.daemon_id !== this.daemonId) throw new ArloError(ArloErrorCode.STALE_GENERATION);
    }, revalidate);
  }
  private operate(root: Root, id: string, kind: 'authorize' | 'continue', sequence: number,
    validateNew: () => void, validateReplay = validateNew): RootSendingStatus {
    this.claim(root); validateReplay();
    this.validateOperationId(id);
    const ledger = this.load(), subject = this.subject(root);
    const fingerprint = hash([subject, kind, sequence]);
    const old = ledger.operations.find(op => op.id === id);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new ArloError(ArloErrorCode.CONTROL_REQUEST_CONFLICT);
      if (old.result) { validateReplay(); this.claim(root); return old.result; }
      if (old.preparation?.daemon_id !== this.daemonId) throw new ArloError(ArloErrorCode.STALE_GENERATION);
    }
    validateNew();
    let row = this.row(ledger, root);
    const additions = (old ? 0 : 1) + (kind === 'authorize' && !row ? 1 : 0);
    if (ledger.operations.length + ledger.rows.length + additions > CAPACITY) throw new ArloError(ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE);
    if (kind === 'authorize') {
      if (!row) {
        row = { subject, configId: `rc-${crypto.randomUUID()}`, period: null, sequence: 0, granted: 0, used: 0 };
        ledger.rows.push(row);
      }
    } else {
      if (!row) throw new ArloError(ArloErrorCode.ALLOWANCE_UNKNOWN, 'Explicitly authorize this root before continuing.');
      if (sequence !== row.sequence + 1 || !Number.isSafeInteger(sequence)) throw new ArloError(ArloErrorCode.STALE_CONTROL_REQUEST);
      if (this.rule(row).mode === 'bounded') {
        row.period = crypto.randomUUID(); row.granted = this.rule(row).grant; row.used = 0; row.sequence = sequence;
      }
    }
    const result = this.describe(row);
    if (old) old.result = result;
    else ledger.operations.push({ id, fingerprint, result });
    validateNew(); this.claim(root); this.save(ledger, () => { validateNew(); this.claim(root); });
    return result;
  }
  reload(root: Root, revision: string, daemonId: string): RootSendingStatus {
    this.claim(root);
    const ledger = this.load(), row = this.row(ledger, root);
    if (!row) throw new ArloError(ArloErrorCode.ALLOWANCE_UNKNOWN);
    if (daemonId !== this.daemonId) throw new ArloError(ArloErrorCode.STALE_GENERATION);
    if (revision !== this.revision) throw new ArloError(ArloErrorCode.STALE_CONTROL_REQUEST);
    try { const rules = loadSendingRules(this.stateDir); this.claim(root); this.rules = rules; this.rulesError = null; }
    catch (error) { this.rulesError = 'Sending rules could not be read'; throw error; }
    this.revision = crypto.randomUUID(); return this.describe(row);
  }
  /** Admission identity is the existing message ID and full semantic payload.
   * Return false on an earlier committed reservation: never transmit it again
   * after a restart lost the in-memory exchange record. A charge is not a receipt. */
  replayDispatch(root: Root, messageId: string, payload: unknown): boolean {
    this.claim(root);
    const ledger = this.load(), old = ledger.operations.find(op => op.id === messageId);
    if (!old) return false;
    if (old.fingerprint !== hash([this.subject(root), 'dispatch', payload])) throw new ArloError(ArloErrorCode.CONTROL_REQUEST_CONFLICT);
    return true;
  }
  charge(root: Root, messageId: string, payload: unknown): boolean {
    this.claim(root);
    const ledger = this.load(), row = this.row(ledger, root);
    if (!row) throw new ArloError(ArloErrorCode.ALLOWANCE_UNKNOWN);
    const fingerprint = hash([this.subject(root), 'dispatch', payload]);
    const old = ledger.operations.find(op => op.id === messageId);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new ArloError(ArloErrorCode.CONTROL_REQUEST_CONFLICT);
      return false;
    }
    if (ledger.operations.length + ledger.rows.length >= CAPACITY) throw new ArloError(ArloErrorCode.ACCOUNTING_UNAVAILABLE);
    const rule = this.rule(row);
    if (rule.mode === 'bounded' && !row.period) throw new ArloError(ArloErrorCode.ALLOWANCE_UNKNOWN);
    if (rule.mode === 'bounded' && row.used >= row.granted) throw new ArloError(ArloErrorCode.ALLOWANCE_EXHAUSTED);
    if (row.used >= Number.MAX_SAFE_INTEGER) throw new ArloError(ArloErrorCode.ACCOUNTING_UNAVAILABLE);
    row.used++;
    ledger.operations.push({ id: messageId, fingerprint, result: this.describe(row) });
    this.claim(root); this.save(ledger, () => this.claim(root)); return true;
  }
  private authority(): string {
    if (!verifyWindowsAcl(this.stateDir).valid || fs.lstatSync(this.stateDir).isSymbolicLink()) throw new Error('Unsafe storage');
    const stat = fs.statSync(this.stateDir, { bigint: true });
    return hash([fs.realpathSync.native(this.stateDir), String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
  }
  private read(name: string, limit: number): string {
    const file = path.join(this.stateDir, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit || !verifyWindowsAcl(file).valid) throw new Error('Unsafe history');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'linux' ? fs.constants.O_NOFOLLOW : 0));
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error('History changed');
      const buffer = Buffer.alloc(Math.min(limit, stat.size) + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
        if (!count) break; size += count;
      }
      const after = fs.lstatSync(file);
      if (size !== stat.size || size > limit || after.dev !== stat.dev || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs) throw new Error('History changed');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    } finally { fs.closeSync(fd); }
  }
  private load(): Ledger {
    try {
      const authority = this.authority();
      if (!fs.existsSync(path.join(this.stateDir, FILE))) {
        if (this.observed || fs.existsSync(path.join(this.stateDir, MARKER))) throw new Error('Missing history');
        return { version: 1, authority, namespace: crypto.randomUUID(), rows: [], operations: [], checksum: '' };
      }
      this.observed = true;
      const ledger = JSON.parse(this.read(FILE, MAX_BYTES)) as Ledger;
      if (!ledger || ledger.version !== 1 || ledger.authority !== authority || typeof ledger.namespace !== 'string' ||
          this.read(MARKER, 128) !== `${ledger.namespace}\n` || !Array.isArray(ledger.rows) || !Array.isArray(ledger.operations) ||
          ledger.rows.length + ledger.operations.length > CAPACITY ||
          ledger.checksum !== hash([ledger.version, ledger.authority, ledger.namespace, ledger.rows, ledger.operations])) throw new Error('Corrupt history');
      const subjects = new Set<string>(), ids = new Set<string>(), configs = new Set<string>();
      for (const r of ledger.rows) {
        if (!r || !/^[0-9a-f]{64}$/.test(r.subject) || subjects.has(r.subject) || configs.has(r.configId) || !/^rc-[0-9a-f-]{36}$/.test(r.configId) ||
            ![r.sequence, r.granted, r.used].every(x => Number.isSafeInteger(x) && x >= 0) ||
            (r.period !== null && (typeof r.period !== 'string' || !r.period || r.granted < 1))) throw new Error('Invalid row');
        subjects.add(r.subject); configs.add(r.configId);
      }
      for (const op of ledger.operations) {
        if (!op || typeof op.id !== 'string' || !op.id || op.id.length > 256 || ids.has(op.id) || !/^[0-9a-f]{64}$/.test(op.fingerprint) ||
            op.result && (op.result.root_configuration?.ownership !== 'user-authorized' || !configs.has(op.result.root_configuration.config_id!)) ||
            !op.result && !op.preparation || op.preparation &&
              (typeof op.preparation.daemon_id !== 'string' || !op.preparation.daemon_id ||
               !Number.isSafeInteger(op.preparation.sequence) || op.preparation.sequence < 1 ||
               !ledger.rows.some(row => op.fingerprint === hash([row.subject, 'continue', op.preparation!.sequence])))) throw new Error('Invalid operation');
        ids.add(op.id);
      }
      return ledger;
    } catch { throw new ArloError(ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE); }
  }
  private save(ledger: Ledger, beforeCommit: () => void): void {
    try {
      if (this.authority() !== ledger.authority) throw new Error('Storage changed');
      ledger.checksum = hash([ledger.version, ledger.authority, ledger.namespace, ledger.rows, ledger.operations]);
      const text = JSON.stringify(ledger);
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('History capacity');
      if (!fs.existsSync(path.join(this.stateDir, MARKER))) writePrivateStateFile(this.stateDir, MARKER, `${ledger.namespace}\n`, true);
      else if (this.read(MARKER, 128) !== `${ledger.namespace}\n`) throw new Error('History changed');
      writePrivateStateFile(this.stateDir, FILE, text, true, beforeCommit);
      this.observed = true;
    } catch { throw new ArloError(ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE); }
  }
}
