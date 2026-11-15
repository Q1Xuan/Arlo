import crypto from 'node:crypto';
import { MAX_ROOT_PENDING_MESSAGES, MAX_ROOT_PENDING_BYTES } from '@arlo/sdk';
import type {
  ReceptionHost,
  ReceptionScope,
  PendingSnapshot,
  PendingInput,
  ReceptionEvidence,
  ReceptionDispatch,
} from '@arlo/adapter-sdk';
import type { ArloMessageNotificationParams } from '@arlo/sdk';
import { BridgeRequestError, correlationMarker, generateCorrelationId } from './contract.ts';
import {
  ClaudeCodeQueueStorage,
  QueueWriteError,
  type ClaudeCodeStorageOptions,
  type DurableMessageRecord,
} from './storage.ts';

export interface ClaudeCodeReceptionHostOptions extends ClaudeCodeStorageOptions {}

/** Input that still occupies queue capacity: nothing has settled it yet. */
function occupiesCapacity(record: DurableMessageRecord): boolean {
  return record.status === 'dispatching' || record.status === 'submitting' || record.status === 'unknown';
}

function hasUnconfirmedHandoff(record: DurableMessageRecord): boolean {
  return record.status === 'dispatching' || record.status === 'submitting';
}

export class ClaudeCodeReceptionHost implements ReceptionHost {
  readonly instanceId = crypto.randomUUID();
  readonly sessionId: string;
  private readonly storage: ClaudeCodeQueueStorage;
  private readonly pending = new Map<string, DurableMessageRecord>();
  private readonly recordsByNativeId = new Map<string, DurableMessageRecord>();
  private readonly observers = new Set<(evidence: ReceptionEvidence) => void>();
  private retired = false;
  private retirementComplete = false;
  private dispatcherReplacementPending = false;
  private retirementPlan?: { records: DurableMessageRecord[]; discarded: DurableMessageRecord[] };
  private readonly recoveredIds = new Set<string>();

  /** New-endpoint accounting excludes old dispatches; local admission still counts every retained input. */
  readonly endpointReception: ReceptionHost = {
    instanceId: this.instanceId,
    prepare: frame => this.prepare(frame),
    observe: listener => this.observe(listener),
    snapshot: scope => {
      const snapshot = this.snapshot(scope);
      return {
        ...snapshot,
        pending: snapshot.pending.filter(input => !this.recoveredIds.has(input.nativeMessageId)),
        inFlight: snapshot.inFlight.filter(input => !this.recoveredIds.has(input.nativeMessageId)),
      };
    },
  };

  constructor(options: ClaudeCodeReceptionHostOptions) {
    this.sessionId = options.sessionId;
    this.storage = new ClaudeCodeQueueStorage(options);
  }

  /** End this live reception before its runtime detaches from accounting. */
  retire(): void {
    if (this.retirementComplete) return;
    this.retired = true;
    if (!this.retirementPlan) {
      const discarded: DurableMessageRecord[] = [];
      const records = this.storage.loadAll().map(record => {
        if (record.status === 'enqueued') {
          const settled: DurableMessageRecord = { ...record, status: 'discarded', settledAt: new Date().toISOString() };
          discarded.push(settled);
          return settled;
        }
        if (hasUnconfirmedHandoff(record)) {
          return { ...record, status: 'unknown' as const };
        }
        return record;
      });
      // Keep the same transition and evidence across an unconfirmed rename.
      this.retirementPlan = { records, discarded };
    }
    const { records, discarded } = this.retirementPlan;
    this.storage.rewriteAll(records);
    for (const record of records) this.publish(record);
    this.retirementComplete = true;
    this.dispatcherReplacementPending = false;
    this.retirementPlan = undefined;
    for (const record of discarded) this.emitSettlement(record, 'discarded');
  }

  /** A new Mod cannot prove handoffs issued by the dispatcher it replaced. */
  replaceDispatcher(): void {
    if (this.retired) throw new BridgeRequestError(409, 'CONFLICT', 'Reception has retired');
    this.dispatcherReplacementPending = true;
    const records = this.storage.loadAll().map(record =>
      hasUnconfirmedHandoff(record)
        ? { ...record, status: 'unknown' as const }
        : record);
    this.storage.rewriteAll(records);
    for (const record of records) this.publish(record);
    this.dispatcherReplacementPending = false;
  }

  async recover(): Promise<void> {
    if (this.retired || this.dispatcherReplacementPending) return;
    const records = this.storage.loadAll();
    let mutated = false;
    for (const record of records) {
      // The host call had not returned, or returned without claim evidence that
      // this process can still prove. Either way the handoff result is
      // unresolved: keep the text off the poll queue and never resubmit it.
      if (hasUnconfirmedHandoff(record)) {
        record.status = 'unknown';
        mutated = true;
      }
      if (record.correlationId === undefined) {
        // An older queue has no marker yet. Assign one before any host call so
        // a claim can only ever be proven against a marker this host issued.
        record.correlationId = generateCorrelationId();
        mutated = true;
      }
    }
    if (mutated) {
      this.storage.rewriteAll(records);
    }
    this.pending.clear();
    this.recordsByNativeId.clear();
    for (const record of records) {
      this.publish(record);
      // A previous process's records are durable local input, not credit on the
      // endpoint this process is about to register. Reporting those ids makes
      // a new Daemon binding refuse readiness.
      this.recoveredIds.add(record.nativeMessageId);
    }
  }

  private publish(record: DurableMessageRecord): void {
    this.recordsByNativeId.set(record.nativeMessageId, record);
    if (record.status === 'enqueued') this.pending.set(record.nativeMessageId, record);
    else this.pending.delete(record.nativeMessageId);
  }

  private persistUpdate(record: DurableMessageRecord): void {
    this.storage.rewriteAll(Array.from(this.recordsByNativeId.values(), (current) =>
      current.nativeMessageId === record.nativeMessageId ? record : current));
    this.publish(record);
  }

  private requireRecord(nativeMessageId: string, messageId?: string): DurableMessageRecord {
    this.requireLive();
    const record = this.recordsByNativeId.get(nativeMessageId);
    if (!record) throw new BridgeRequestError(404, 'NOT_FOUND', 'Message does not exist');
    if (messageId !== undefined && messageId !== record.messageId) {
      throw new BridgeRequestError(409, 'CONFLICT', 'Message identity does not match');
    }
    return record;
  }

  private requireLive(): void {
    if (this.retired) throw new BridgeRequestError(409, 'CONFLICT', 'Reception has retired');
    if (this.dispatcherReplacementPending) throw new BridgeRequestError(409, 'CONFLICT', 'Dispatcher replacement is incomplete');
  }

  private transition(nativeMessageId: string, from: DurableMessageRecord['status'][], to: DurableMessageRecord['status'], messageId?: string): void {
    const record = this.requireRecord(nativeMessageId, messageId);
    if (!from.includes(record.status)) {
      throw new BridgeRequestError(409, 'CONFLICT', `Cannot transition ${record.status} to ${to}`);
    }
    this.persistUpdate({ ...record, status: to });
  }

  beginDispatch(nativeMessageId: string, messageId?: string): void {
    this.transition(nativeMessageId, ['enqueued'], 'dispatching', messageId);
  }

  cancelDispatch(nativeMessageId: string, messageId?: string): void {
    this.transition(nativeMessageId, ['dispatching'], 'enqueued', messageId);
  }

  recordHandoff(nativeMessageId: string, messageId?: string): void {
    this.transition(nativeMessageId, ['dispatching'], 'submitting', messageId);
  }

  recordNotEntered(nativeMessageId: string, messageId?: string): void {
    // An explicit host refusal settles the input here and releases its credit.
    const record = this.requireRecord(nativeMessageId, messageId);
    if (record.status !== 'dispatching') {
      throw new BridgeRequestError(409, 'CONFLICT', `Cannot transition ${record.status} to discarded`);
    }
    this.settleRecord(record, 'discarded');
  }

  recordUnresolved(nativeMessageId: string, messageId?: string): void {
    // A failed or unprovable handoff ends unresolved. A submission that already
    // reached the host without claim evidence is unresolved the same way.
    this.transition(nativeMessageId, ['dispatching', 'submitting'], 'unknown', messageId);
  }

  /**
   * Claim evidence: the host turn input that ingested this message carried its
   * own correlation marker. Anything else leaves the handoff unresolved.
   */
  claim(nativeMessageId: string, messageId?: string, marker?: string): void {
    const record = this.requireRecord(nativeMessageId, messageId);
    // The reported marker is only evidence if it is the one this host issued.
    const issued = record.correlationId === undefined ? undefined : correlationMarker(record.correlationId);
    if (typeof marker !== 'string' || marker !== issued) {
      throw new BridgeRequestError(409, 'CONFLICT', 'Correlation marker does not belong to this message');
    }
    // A repeated report of the same proven claim changes nothing.
    if (record.status === 'claimed') return;
    if (record.status !== 'submitting') {
      throw new BridgeRequestError(409, 'CONFLICT', `Cannot claim a ${record.status} message`);
    }
    this.settleRecord(record, 'claimed');
  }

  prepare(frame: ArloMessageNotificationParams): {
    nativeMessageId: string;
    enqueue(): Promise<'enqueued' | 'not_enqueued' | 'unknown'>;
  } {
    const nativeMessageId = crypto.randomUUID();
    const dispatch: ReceptionDispatch = {
      daemon_id: frame.daemon_id,
      endpoint_id: frame.to_endpoint,
      message_id: frame.message_id,
      delivery_id: frame.delivery_id,
      generation: frame.target_generation,
    };
    const textBytes = Buffer.byteLength(frame.text, 'utf8');
    const record: DurableMessageRecord = {
      nativeMessageId,
      messageId: frame.message_id,
      text: frame.text,
      textBytes,
      fromEndpoint: frame.from_endpoint,
      correlationId: generateCorrelationId(),
      dispatch,
      status: 'enqueued',
      enqueuedAt: new Date().toISOString(),
    };

    return {
      nativeMessageId,
      enqueue: async (): Promise<'enqueued' | 'not_enqueued' | 'unknown'> => {
        if (this.retired || this.dispatcherReplacementPending) return 'not_enqueued';
        // Enforce the physical queue budget across endpoint/process changes.
        // This check and publication have no await between them.
        let count = 0;
        let bytes = 0;
        for (const current of this.recordsByNativeId.values()) {
          if (current.status === 'enqueued' || occupiesCapacity(current)) {
            count++;
            bytes += current.textBytes;
          }
        }
        if (count >= MAX_ROOT_PENDING_MESSAGES || bytes + textBytes > MAX_ROOT_PENDING_BYTES) return 'not_enqueued';
        try {
          // Persist to disk FIRST before confirming enqueued
          this.storage.append(record);
          this.publish(record);
          return 'enqueued';
        } catch (error) {
          if (error instanceof QueueWriteError && error.published) {
            // The input exists, but directory durability is unconfirmed. Keep
            // its credit and report uncertainty; no host submission occurred.
            this.publish(record);
            return 'unknown';
          }
          return 'not_enqueued';
        }
      },
    };
  }

  snapshot(scope: ReceptionScope): PendingSnapshot {
    const pendingList: PendingInput[] = [];
    const inFlightList: PendingInput[] = [];
    for (const record of this.recordsByNativeId.values()) {
      const item: PendingInput = {
        nativeMessageId: record.nativeMessageId,
        messageId: record.messageId,
        textBytes: record.textBytes,
        dispatch: record.dispatch,
      };
      if (record.status === 'enqueued') {
        pendingList.push(item);
      } else if (occupiesCapacity(record)) {
        inFlightList.push(item);
      }
    }
    return {
      instanceId: this.instanceId,
      generation: scope.generation,
      complete: (!this.retired || this.retirementComplete) && !this.dispatcherReplacementPending,
      pending: pendingList,
      inFlight: inFlightList,
    };
  }

  observe(listener: (evidence: ReceptionEvidence) => void): () => void {
    this.observers.add(listener);
    return () => {
      this.observers.delete(listener);
    };
  }

  async settle(nativeMessageId: string, event: 'claimed' | 'discarded'): Promise<void> {
    this.requireLive();
    const record = this.recordsByNativeId.get(nativeMessageId);
    if (!record) return;
    this.settleRecord(record, event);
  }

  private settleRecord(record: DurableMessageRecord, event: 'claimed' | 'discarded'): void {
    if (record.status === event && record.settledAt !== undefined) return;
    this.persistUpdate({ ...record, status: event, settledAt: new Date().toISOString() });
    this.emitSettlement(record, event);
  }

  private emitSettlement(record: DurableMessageRecord, event: 'claimed' | 'discarded'): void {
    // Notify observers
    const evidence: ReceptionEvidence = {
      instanceId: this.instanceId,
      dispatch: record.dispatch,
      nativeMessageId: record.nativeMessageId,
      event,
    };
    for (const observer of this.observers) {
      try {
        observer(evidence);
      } catch {
        // Observers shouldn't break settlement
      }
    }
  }

  getPendingMessages(): DurableMessageRecord[] {
    if (this.retired || this.dispatcherReplacementPending) return [];
    return Array.from(this.pending.values()).filter((record) => record.status === 'enqueued');
  }
}
