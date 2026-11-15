import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArloError, ArloErrorCode, verifyWindowsAcl, inspectWindowsAclBatch, type ContinueCollaborationRequest,
  type InitializeRootSendingRequest, type RootInitialAllowanceStatus,
  type ReloadSendingRulesRequest, type RootConfigurationStatus, type RootSendingStatus } from '@arlo/sdk';
import { writePrivateStateFile } from '../storage/index.ts';
import { DEFAULT_SENDING_RULE, loadSendingRules, type SendingRule } from './rules.ts';

const MAX_CONTROL_REQUESTS = 10_000;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const LEDGER_NAME = 'sending-controls.json';
const MARKER_NAME = 'sending-controls.initialized';

interface ControlRecord {
  request_id: string;
  fingerprint: string;
  sequence: number;
}

interface IssuanceRecord {
  config_id: string;
  sequence: number;
  period_id: string;
  granted: number;
  initial_issuance_consumed: true;
  requests: ControlRecord[];
}

interface ControlLedger {
  version: 1;
  authority: string;
  records: IssuanceRecord[];
  checksum: string;
}

interface LivePeriod {
  configId: string;
  periodId: string;
  granted: number;
  used: number | null;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Durable human control history and ephemeral usage are intentionally distinct.
 * A daemon reload can verify issuance, but cannot reconstruct subsequent sends.
 * Only a fresh, authenticated human control opens another period. */
export class RootSendingStore {
  private readonly periods = new Map<string, LivePeriod>();
  private readonly bindings = new Map<string, string>();
  private readonly dispatchedConfigurations = new Set<string>();
  private readonly dispatchedEndpoints = new Set<string>();
  // Status-only controls must never become grants when replayed after a mode
  // change. They need no durable writes: another daemon rejects their identity.
  private readonly statusControls = new Map<string, string>();
  private rules: ReadonlyMap<string, SendingRule> = new Map();
  private rulesRevision = crypto.randomUUID();
  private rulesError: string | null = null;
  private observedLedger = false;
  private readonly stateDir: string;
  private readonly daemonId: string;

  constructor(stateDir: string, daemonId: string) {
    this.stateDir = stateDir;
    this.daemonId = daemonId;
  }

  /** One rule source, shared by status and every issuance operation. */
  private currentRule(configId: string | null): SendingRule {
    return configId === null ? DEFAULT_SENDING_RULE : this.rules.get(configId) ?? DEFAULT_SENDING_RULE;
  }

  initializeRules(): void {
    try { this.rules = loadSendingRules(this.stateDir); this.rulesError = null; }
    catch (error) {
      this.rules = new Map();
      this.rulesError = error instanceof ArloError ? error.message : 'Sending rules could not be read';
    }
    this.rulesRevision = crypto.randomUUID();
  }

  reload(endpointId: string, configuration: RootConfigurationStatus,
    request: ReloadSendingRulesRequest, revalidate: () => void): RootSendingStatus {
    const validate = () => {
      if (request.daemon_id !== this.daemonId) throw new ArloError(ArloErrorCode.STALE_GENERATION);
      if (request.rules_revision !== this.rulesRevision) throw new ArloError(ArloErrorCode.STALE_CONTROL_REQUEST);
      if (configuration.ownership !== 'verified' || configuration.config_id === null) {
        throw new ArloError(ArloErrorCode.ALLOWANCE_UNKNOWN, configuration.reason);
      }
      revalidate();
    };
    validate();
    let replacement: ReadonlyMap<string, SendingRule>;
    try { replacement = loadSendingRules(this.stateDir); }
    catch (error) {
      if (error instanceof ArloError) this.rulesError = error.message;
      throw error;
    }
    // Reading the OS boundary can observe replacement or invoke a callback.
    // Recheck both authority and snapshot before the single publication.
    validate();
    this.rules = replacement;
    this.rulesRevision = crypto.randomUUID();
    this.rulesError = null;
    return this.status(endpointId, configuration);
  }

  /** Verified ownership attaches existing rules; it never issues a period. */
  observeConfiguration(endpointId: string, configuration: RootConfigurationStatus): void {
    if (configuration.ownership === 'verified' && configuration.config_id !== null) {
      this.bindings.set(endpointId, configuration.config_id);
      if (this.dispatchedEndpoints.has(endpointId)) this.dispatchedConfigurations.add(configuration.config_id);
    } else this.forget(endpointId);
  }

  status(endpointId: string, configuration: RootConfigurationStatus): RootSendingStatus {
    this.observeConfiguration(endpointId, configuration);
    let issuance: IssuanceRecord | undefined;
    let historyAvailable = true;
    let capacityAvailable = true;
    try {
      const ledger = this.load();
      issuance = ledger.records.find(row => row.config_id === configuration.config_id);
      capacityAvailable = this.historySize(ledger) < MAX_CONTROL_REQUESTS;
    }
    catch { this.periods.clear(); historyAvailable = false; }
    return this.describe(endpointId, configuration, issuance, historyAvailable, capacityAvailable);
  }

  private describe(endpointId: string, configuration: RootConfigurationStatus,
    issuance: IssuanceRecord | undefined, historyAvailable = true, capacityAvailable = true): RootSendingStatus {
    this.observeConfiguration(endpointId, configuration);
    const period = configuration.ownership === 'verified'
      ? this.periods.get(endpointId) : undefined;
    const samePeriod = period !== undefined && period.configId === configuration.config_id &&
      period.periodId === issuance?.period_id;
    const known = samePeriod && period.used !== null;
    if (!samePeriod) this.periods.delete(endpointId);
    const rule = this.currentRule(configuration.ownership === 'verified' ? configuration.config_id : null);
    const remaining = rule.mode === 'bounded' && known ? Math.max(0, period.granted - period.used!) : null;
    return {
      daemon_id: this.daemonId, mode: rule.mode,
      period_id: known ? period.periodId : issuance?.period_id ?? null,
      knowledge: known ? 'known' : 'unknown',
      granted: known ? period.granted : issuance?.granted ?? null,
      used: known ? period.used : null, remaining,
      next_grant: rule.grant, rules_revision: this.rulesRevision, rules_error: this.rulesError,
      pause_reason: rule.mode === 'continuous' ? null : !known ? ArloErrorCode.ALLOWANCE_UNKNOWN
        : remaining === 0 ? ArloErrorCode.ALLOWANCE_EXHAUSTED : null,
      control_sequence: issuance?.sequence ?? 0, root_configuration: configuration,
      initial_allowance: this.eligibility(endpointId, configuration, issuance, historyAvailable, capacityAvailable),
    };
  }

  private eligibility(endpointId: string, configuration: RootConfigurationStatus,
    issuance: IssuanceRecord | undefined, historyAvailable: boolean, capacityAvailable: boolean): RootInitialAllowanceStatus {
    if (configuration.ownership !== 'verified') return { eligibility: 'unknown', reason: 'OWNERSHIP_UNVERIFIED',
      guidance: 'Persistent root ownership is unverified. Restore the native session evidence before explicitly continuing collaboration.' };
    if (!historyAvailable) return { eligibility: 'unknown', reason: 'HISTORY_UNAVAILABLE',
      guidance: 'Sending history is unavailable. Restore complete protected history; missing records never prove first use.' };
    if (issuance) return { eligibility: 'consumed', reason: 'INITIAL_ALLOWANCE_CONSUMED',
      guidance: 'Initial allowance has already been consumed. If sending is paused, explicitly continue collaboration to open a new period.' };
    if (!capacityAvailable) return { eligibility: 'unknown', reason: 'CAPACITY_EXHAUSTED',
      guidance: 'Persistent sending history is full. Preserve old eligibility and control records; increase supported capacity through a future migration.' };
    if (this.dispatchedEndpoints.has(endpointId) || this.dispatchedConfigurations.has(configuration.config_id!)) {
      return { eligibility: 'unknown', reason: 'DISPATCH_HISTORY_PRESENT',
        guidance: 'This root has already dispatched. A delayed first-use callback cannot reset usage; explicitly continue collaboration.' };
    }
    return { eligibility: 'unknown', reason: 'FIRST_USE_UNPROVEN',
      guidance: 'A trusted host must prove a newly created, durably saved native root. Registration and absent records do not prove first use; explicitly continue collaboration.' };
  }

  initialize(endpointId: string, configuration: RootConfigurationStatus,
    request: InitializeRootSendingRequest, revalidate: () => void, isNewBinding: () => boolean): RootSendingStatus {
    if (configuration.ownership !== 'verified' || configuration.config_id === null) {
      return this.describe(endpointId, configuration, undefined);
    }
    let ledger: ControlLedger;
    try { ledger = this.load(); }
    catch { return this.describe(endpointId, configuration, undefined, false); }
    const configId = configuration.config_id;
    const issuance = ledger.records.find(row => row.config_id === configId);
    // Durable consumed history takes precedence over even a fresh host attestation.
    if (issuance || this.dispatchedConfigurations.has(configId) || this.dispatchedEndpoints.has(endpointId)) {
      revalidate();
      return this.describe(endpointId, configuration, issuance);
    }
    if (this.historySize(ledger) >= MAX_CONTROL_REQUESTS) {
      return this.describe(endpointId, configuration, undefined, true, false);
    }
    const proof = request.first_use;
    const evidence = proof?.evidence;
    const current = request.evidence;
    if (!isNewBinding() || !proof || proof.kind !== 'new-session-materialized' || !evidence || evidence.invalid ||
        !evidence.file_identity || !evidence.file_revision || !evidence.host_origin || !current ||
        evidence.session_file !== current.session_file || evidence.file_identity !== current.file_identity ||
        evidence.file_revision !== current.file_revision || evidence.host_origin !== current.host_origin) {
      return this.describe(endpointId, configuration, undefined);
    }
    this.checkCapacity(ledger, true, false);
    revalidate();
    const rule = this.currentRule(configId);
    const next: IssuanceRecord = { config_id: configId, sequence: 0, period_id: crypto.randomUUID(),
      granted: rule.grant, initial_issuance_consumed: true, requests: [] };
    ledger.records.push(next);
    return this.publishAndOpen(endpointId, configuration, ledger, next, () => {
      revalidate();
      if (!isNewBinding()) throw new ArloError(ArloErrorCode.ALLOWANCE_UNKNOWN);
    });
  }

  continue(endpointId: string, configuration: RootConfigurationStatus,
    request: ContinueCollaborationRequest, revalidate: () => void): RootSendingStatus {
    if (request.daemon_id !== this.daemonId) throw new ArloError(ArloErrorCode.STALE_GENERATION);
    if (typeof request.request_id !== 'string' || request.request_id.length < 1 || request.request_id.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(request.request_id) ||
        !Number.isSafeInteger(request.sequence) || request.sequence < 1) {
      throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
    }
    if (configuration.ownership !== 'verified' || configuration.config_id === null) {
      throw new ArloError(ArloErrorCode.ALLOWANCE_UNKNOWN, configuration.reason);
    }
    revalidate();
    const configId = configuration.config_id;
    const fingerprint = digest([request.daemon_id, endpointId, request.generation, configId,
      request.request_id, request.sequence]);
    const statusFingerprint = this.statusControls.get(request.request_id);
    if (statusFingerprint !== undefined) {
      if (statusFingerprint !== fingerprint) throw new ArloError(ArloErrorCode.CONTROL_REQUEST_CONFLICT);
      return this.status(endpointId, configuration);
    }
    const continuous = this.currentRule(configId).mode === 'continuous';
    let ledger: ControlLedger | undefined;
    try { ledger = this.load(); }
    catch (error) { if (!continuous) throw error; }
    let issuance = ledger?.records.find(row => row.config_id === configId);
    const previous = ledger?.records.flatMap(row => row.requests)
      .find(row => row.request_id === request.request_id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ArloError(ArloErrorCode.CONTROL_REQUEST_CONFLICT);
      revalidate();
      // A replay may report unknown after state loss. It never installs a new
      // live period from the durable successful control record.
      return this.describe(endpointId, configuration, issuance);
    }
    if (continuous) {
      if (this.statusControls.size >= MAX_CONTROL_REQUESTS) {
        throw new ArloError(ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE, 'Status control history is full; no request identity was evicted');
      }
      this.statusControls.set(request.request_id, fingerprint);
      this.bindings.set(endpointId, configId);
      return this.describe(endpointId, configuration, issuance, ledger !== undefined,
        ledger !== undefined && this.historySize(ledger) < MAX_CONTROL_REQUESTS);
    }
    if (!ledger) throw new ArloError(ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE);
    if (request.sequence !== (issuance?.sequence ?? 0) + 1) {
      throw new ArloError(ArloErrorCode.STALE_CONTROL_REQUEST);
    }
    this.checkCapacity(ledger, issuance === undefined);
    revalidate();
    const rule = this.currentRule(configId);
    const periodId = crypto.randomUUID();
    if (!issuance) {
      issuance = { config_id: configId, sequence: 0, period_id: periodId,
        granted: rule.grant, initial_issuance_consumed: true, requests: [] };
      ledger.records.push(issuance);
    }
    issuance.sequence = request.sequence;
    issuance.period_id = periodId;
    issuance.granted = rule.grant;
    issuance.requests.push({ request_id: request.request_id, fingerprint, sequence: request.sequence });
    return this.publishAndOpen(endpointId, configuration, ledger, issuance, revalidate);
  }

  private checkCapacity(ledger: ControlLedger, newRecord: boolean, humanRequest = true): void {
    // Automatic records have no human requests. Bound both kinds together so
    // they cannot evade the same persistent-history capacity limit.
    const size = this.historySize(ledger);
    if (size + (newRecord ? 1 : 0) + (humanRequest ? 1 : 0) > MAX_CONTROL_REQUESTS) {
      throw new ArloError(ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE, 'Persistent control history is full; no history was evicted');
    }
  }

  private historySize(ledger: ControlLedger): number {
    return ledger.records.reduce((count, row) => count + 1 + row.requests.length, 0);
  }

  /** The sole issuance seam for both trusted first use and explicit continue. */
  private publishAndOpen(endpointId: string, configuration: RootConfigurationStatus,
    ledger: ControlLedger, issuance: IssuanceRecord, revalidate: () => void): RootSendingStatus {
    const before = this.periods.get(endpointId);
    const beforeUsed = before?.used;
    const beforeDispatch = this.dispatchedEndpoints.has(endpointId) || this.dispatchedConfigurations.has(issuance.config_id);
    ledger.checksum = digest([ledger.version, ledger.authority, ledger.records]);
    try {
      // Publish the loss witness first. A crash during publication cannot turn
      // a successful or ambiguous old request into an apparently new request.
      writePrivateStateFile(this.stateDir, MARKER_NAME, `${ledger.checksum}\n`, true);
      writePrivateStateFile(this.stateDir, LEDGER_NAME, JSON.stringify(ledger), true);
      this.observedLedger = true;
      // ACL checks and fsync can take time: no stale binding is opened after
      // durable publication. Its request remains consumed if validation fails.
      revalidate();
      const latest = this.load().records.find(row => row.config_id === issuance.config_id);
      revalidate();
      // Publication is not permission to overwrite a newer human operation or
      // usage committed while storage/host verification was in progress.
      if (latest?.period_id !== issuance.period_id || latest.sequence !== issuance.sequence ||
          this.periods.get(endpointId) !== before || before?.used !== beforeUsed ||
          (this.dispatchedEndpoints.has(endpointId) || this.dispatchedConfigurations.has(issuance.config_id)) !== beforeDispatch) {
        return this.describe(endpointId, configuration, latest);
      }
      this.bindings.set(endpointId, issuance.config_id);
      this.periods.set(endpointId, { configId: issuance.config_id, periodId: issuance.period_id,
        granted: issuance.granted, used: 0 });
      const state = this.describe(endpointId, configuration, latest);
      if (state.knowledge !== 'known') throw new ArloError(ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE);
      return state;
    } catch (error) {
      // An ambiguous publication stops this operation's prior period, while a
      // newer successfully installed period remains authoritative.
      if (this.periods.get(endpointId) === before) this.periods.delete(endpointId);
      if (error instanceof ArloError && error.code !== ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE) throw error;
      throw new ArloError(ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE);
    }
  }

  check(endpointId: string): void {
    const configId = this.bindings.get(endpointId);
    if (configId === undefined) throw new ArloError(ArloErrorCode.ALLOWANCE_UNKNOWN);
    if (this.currentRule(configId).mode === 'continuous') return;
    const period = this.periods.get(endpointId);
    if (!period || period.used === null) throw new ArloError(ArloErrorCode.ALLOWANCE_UNKNOWN);
    if (period.used >= period.granted) throw new ArloError(ArloErrorCode.ALLOWANCE_EXHAUSTED);
  }

  /** Called at the synchronous message exchange commit, before transport. */
  charge(endpointId: string): void {
    this.check(endpointId);
    const period = this.periods.get(endpointId);
    if (period && period.used !== null) {
      period.used = period.used < Number.MAX_SAFE_INTEGER ? period.used + 1 : null;
    }
    this.dispatchedEndpoints.add(endpointId);
    const configId = this.bindings.get(endpointId);
    if (configId) this.dispatchedConfigurations.add(configId);
  }

  forget(endpointId: string): void {
    this.periods.delete(endpointId);
    this.bindings.delete(endpointId);
    this.dispatchedEndpoints.delete(endpointId);
    // The stable configuration witness survives endpoint retirement, so a
    // new binding cannot erase an earlier dispatch or regain first use.
  }

  private load(): ControlLedger {
    try {
      const ledgerPath = path.join(this.stateDir, LEDGER_NAME);
      const markerPath = path.join(this.stateDir, MARKER_NAME);
      const inspections = inspectWindowsAclBatch([this.stateDir, ledgerPath, markerPath].filter(file => fs.existsSync(file)));
      const safe = (file: string) => verifyWindowsAcl(file, inspections[file]).valid;
      if (!safe(this.stateDir)) throw new Error('Unsafe state');
      const stat = fs.statSync(this.stateDir, { bigint: true });
      const authority = digest([fs.realpathSync.native(this.stateDir), String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
      if (!fs.existsSync(ledgerPath)) {
        if (this.observedLedger || fs.existsSync(markerPath)) throw new Error('Missing history');
        return { version: 1, authority, records: [], checksum: '' };
      }
      this.observedLedger = true;
      const info = fs.lstatSync(ledgerPath);
      if (!info.isFile() || info.size > MAX_LEDGER_BYTES || !safe(ledgerPath) ||
          !fs.lstatSync(markerPath).isFile() || !safe(markerPath)) throw new Error('Unsafe history');
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as ControlLedger;
      if (!this.validLedger(ledger, authority) || fs.statSync(markerPath).size !== 65 ||
          fs.readFileSync(markerPath, 'utf8') !== `${ledger.checksum}\n`) throw new Error('Invalid history');
      return ledger;
    } catch {
      this.periods.clear();
      throw new ArloError(ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE);
    }
  }

  private validLedger(ledger: ControlLedger, authority: string): boolean {
    if (!ledger || ledger.version !== 1 || ledger.authority !== authority || !Array.isArray(ledger.records) ||
        ledger.records.length > MAX_CONTROL_REQUESTS || ledger.checksum !== digest([ledger.version, ledger.authority, ledger.records])) return false;
    const configs = new Set<string>();
    const requests = new Set<string>();
    for (const row of ledger.records) {
      if (!row || !/^rc-[0-9a-f-]{36}$/.test(row.config_id) || configs.has(row.config_id) ||
          !Number.isSafeInteger(row.sequence) || row.sequence < 0 || typeof row.period_id !== 'string' ||
          !Number.isSafeInteger(row.granted) || row.granted < 1 || row.initial_issuance_consumed !== true ||
          !Array.isArray(row.requests) || row.requests.length !== row.sequence) return false;
      configs.add(row.config_id);
      for (const [index, request] of row.requests.entries()) {
        if (!request || typeof request.request_id !== 'string' || request.request_id.length < 1 || request.request_id.length > 256 ||
            !/^[a-f0-9]{64}$/.test(request.fingerprint) || request.sequence !== index + 1 || requests.has(request.request_id)) return false;
        requests.add(request.request_id);
        // #76 permitted 10,000 human requests in addition to its records.
        // Keep that durable history readable; the combined budget governs only
        // new admissions, never retroactively invalidates an old successful grant.
        if (requests.size > MAX_CONTROL_REQUESTS) return false;
      }
    }
    return true;
  }
}
