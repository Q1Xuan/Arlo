import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyWindowsAcl, inspectWindowsAclBatch, captureRootConfigurationEvidence, type RootConfigurationEvidence, type RootConfigurationStatus,
  type RootConfigurationReason } from '@arlo/sdk';
import { writePrivateStateFile } from '../storage/index.ts';

export const MAX_ROOT_CONFIGURATION_BINDINGS = 10_000;
const LEDGER_NAME = 'root-bindings.json';
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;

interface BindingRecord {
  subject: string;
  owner: string;
  location: string;
  config_id: string;
}

interface BindingLedger {
  version: 1;
  authority: string;
  records: BindingRecord[];
  checksum: string;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fileIdentity(file: string): { location: string; physical: string; revision: string } {
  const canonical = fs.realpathSync.native(file);
  const evidence = captureRootConfigurationEvidence(canonical);
  return {
    location: digest(process.platform === 'win32' ? canonical.toLowerCase() : canonical),
    physical: evidence.file_identity!,
    revision: evidence.file_revision!,
  };
}

const guidance: Record<RootConfigurationReason, string> = {
  USER_AUTHORIZED: 'User consent is not native-file ownership evidence.',
  AUTHORIZATION_REQUIRED: 'Explicit user authorization is required.',
  BOUND: 'Persistent ownership verified. First eligibility remains unknown; this query grants no allowance.',
  EVIDENCE_UNAVAILABLE: 'Use a durably saved root in a supported public session store, then query again.',
  EVIDENCE_INVALID: 'Retry after the host finishes saving. If evidence remains invalid, restore the original host session artifact or save a valid root through the host.',
  OWNER_CONFLICT: 'Close duplicate instances and query the original session. After a crashed host, stop its instances and restart the daemon to clear live claims. Preserve the ledger; copied or replaced artifacts cannot inherit its rules.',
  HISTORY_MISSING: 'Restore the complete binding ledger from a trusted backup. Missing history does not prove first eligibility.',
  HISTORY_CORRUPT: 'Restore a complete valid binding ledger from a trusted backup. Do not delete history to regain first eligibility.',
  STORAGE_UNAVAILABLE: 'Restore access to the private Arlo state directory and retry. No persistent binding was confirmed.',
  CAPACITY_EXHAUSTED: 'The binding store is full. Preserve its history; increase supported capacity through a future migration rather than deleting old bindings.',
};

/** One authority, serialized by the daemon's lifetime OS mutex. Host artifacts
 * are only inspected; all binding writes stay in protected Arlo storage. */
export class RootConfigurationStore {
  private readonly claims = new Map<string, Set<string>>();
  private readonly newBindings = new Set<string>();
  private readonly verifiedOwners = new Map<string, string>();
  private observedLedger = false;
  private readonly stateDir: string;
  private readonly capacity: number;

  constructor(stateDir: string, capacity = MAX_ROOT_CONFIGURATION_BINDINGS) {
    this.stateDir = stateDir;
    this.capacity = capacity;
  }

  /** A persisted binding loaded from an earlier daemon cannot become first use
   * when its separate issuance files have been cleaned. This is only a loss
   * witness: a newly bound config still needs the trusted host creation proof. */
  isNewBinding(configId: string): boolean { return this.newBindings.has(configId); }

  query(root: { endpointId: string; hostKind?: string; sessionId: string },
    evidence: RootConfigurationEvidence | undefined,
    isActive: (endpointId: string) => boolean): RootConfigurationStatus {
    const result = (reason: RootConfigurationReason, configId: string | null = null): RootConfigurationStatus => {
      if (reason !== 'BOUND') this.verifiedOwners.delete(root.endpointId);
      return {
        root_authenticated: true, config_id: configId,
        config_path: path.join(this.stateDir, 'autonomous-communication.json'),
        ownership: reason === 'BOUND' ? 'verified' : reason === 'OWNER_CONFLICT' ? 'conflict' : 'unknown',
        history: 'unknown', reason, guidance: guidance[reason],
      };
    };
    if (!root.hostKind || !evidence) return result('EVIDENCE_UNAVAILABLE');
    if (evidence.invalid) return result('EVIDENCE_INVALID');
    let proof: ReturnType<typeof fileIdentity>;
    try { proof = fileIdentity(evidence.session_file); }
    catch { return result('EVIDENCE_INVALID'); }
    if (evidence.file_identity !== undefined && evidence.file_identity !== proof.physical) return result('OWNER_CONFLICT');
    if (evidence.file_revision !== undefined && evidence.file_revision !== proof.revision) return result('EVIDENCE_INVALID');

    try {
      const ledgerPath = path.join(this.stateDir, LEDGER_NAME);
      const markerPath = path.join(this.stateDir, 'root-bindings.initialized');
      const inspections = inspectWindowsAclBatch([this.stateDir, ledgerPath, markerPath].filter(file => fs.existsSync(file)));
      const privateDir = verifyWindowsAcl(this.stateDir, inspections[this.stateDir]);
      if (!privateDir.valid) return result('STORAGE_UNAVAILABLE');
      const stat = fs.statSync(this.stateDir, { bigint: true });
      const authority = digest([fs.realpathSync.native(this.stateDir), String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
      let ledger: BindingLedger;
      try {
        const info = fs.lstatSync(ledgerPath);
        if (!info.isFile() || info.size > MAX_LEDGER_BYTES || !verifyWindowsAcl(ledgerPath, inspections[ledgerPath]).valid) return result('STORAGE_UNAVAILABLE');
        this.observedLedger = true;
        try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); }
        catch { return result('HISTORY_CORRUPT'); }
        if (!this.validLedger(ledger, authority)) return result('HISTORY_CORRUPT');
        try {
          const marker = fs.lstatSync(markerPath);
          if (!marker.isFile() || !verifyWindowsAcl(markerPath, inspections[markerPath]).valid) return result('STORAGE_UNAVAILABLE');
          if (marker.size !== 65 || fs.readFileSync(markerPath, 'utf8') !== `${ledger.checksum}\n`) return result('HISTORY_CORRUPT');
        } catch (error) {
          return result((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'HISTORY_MISSING' : 'STORAGE_UNAVAILABLE');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return result('STORAGE_UNAVAILABLE');
        // An issuance also witnesses prior ownership: clearing both binding
        // files cannot mint a new config ID that hides its consumed history.
        if (this.observedLedger || fs.existsSync(markerPath) ||
            fs.existsSync(path.join(this.stateDir, 'sending-controls.json')) ||
            fs.existsSync(path.join(this.stateDir, 'sending-controls.initialized'))) return result('HISTORY_MISSING');
        ledger = { version: 1, authority, records: [], checksum: '' };
      }

      const subject = digest([root.hostKind, root.sessionId]);
      const owner = digest([root.hostKind, proof.physical, evidence.host_origin ?? null]);
      let record = ledger.records.find(row => row.subject === subject);
      if (record && (record.owner !== owner || record.location !== proof.location) ||
          ledger.records.some(row => row.owner === owner && row.subject !== subject)) return result('OWNER_CONFLICT');
      if (!record && ledger.records.length >= this.capacity) return result('CAPACITY_EXHAUSTED');

      if (!record) {
        record = { subject, owner, location: proof.location, config_id: `rc-${crypto.randomUUID()}` };
        ledger.records.push(record);
        ledger.checksum = digest([ledger.version, ledger.authority, ledger.records]);
        // Publish the loss detector first: a crash before ledger publication
        // leaves unknown history rather than an apparently empty fresh store.
        writePrivateStateFile(this.stateDir, 'root-bindings.initialized', `${ledger.checksum}\n`, true);
        writePrivateStateFile(this.stateDir, LEDGER_NAME, JSON.stringify(ledger), true);
        this.observedLedger = true;
        this.newBindings.add(record.config_id);
      }
      let claims = this.claims.get(owner);
      if (!claims) this.claims.set(owner, claims = new Set());
      for (const endpoint of claims) if (!isActive(endpoint)) claims.delete(endpoint);
      claims.add(root.endpointId);
      if (claims.size > 1) return result('OWNER_CONFLICT');
      // ACL checks and durable publication can take time. A changed native
      // artifact must not receive verified rules from the earlier observation.
      const currentProof = fileIdentity(evidence.session_file);
      if (currentProof.location !== proof.location || currentProof.physical !== proof.physical) return result('OWNER_CONFLICT');
      if (currentProof.revision !== proof.revision) return result('EVIDENCE_INVALID');
      this.verifiedOwners.set(root.endpointId, owner);
      return result('BOUND', record.config_id);
    } catch { return result('STORAGE_UNAVAILABLE'); }
  }

  /** A second active claim invalidates sending authority for both instances. */
  hasExclusiveClaim(endpointId: string, isActive: (endpointId: string) => boolean): boolean {
    const owner = this.verifiedOwners.get(endpointId);
    if (owner === undefined) return false;
    const claims = this.claims.get(owner);
    if (!claims) return false;
    for (const id of claims) if (!isActive(id)) claims.delete(id);
    return claims.size === 1 && claims.has(endpointId);
  }

  private validLedger(ledger: BindingLedger, authority: string): boolean {
    if (!ledger || ledger.version !== 1 || ledger.authority !== authority ||
        !Array.isArray(ledger.records) || ledger.records.length > MAX_ROOT_CONFIGURATION_BINDINGS ||
        ledger.checksum !== digest([ledger.version, ledger.authority, ledger.records])) return false;
    const subjects = new Set<string>();
    const owners = new Set<string>();
    const ids = new Set<string>();
    for (const row of ledger.records) {
      if (!row || !/^[0-9a-f]{64}$/.test(row.subject) || !/^[0-9a-f]{64}$/.test(row.owner) ||
          !/^[0-9a-f]{64}$/.test(row.location) || !/^rc-[0-9a-f-]{36}$/.test(row.config_id) ||
          subjects.has(row.subject) || owners.has(row.owner) || ids.has(row.config_id)) return false;
      subjects.add(row.subject); owners.add(row.owner); ids.add(row.config_id);
    }
    return true;
  }
}
