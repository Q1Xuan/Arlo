import crypto from 'node:crypto';
import {
  ArloError, ArloErrorCode, MAX_ROOT_PENDING_MESSAGES, MAX_ROOT_PENDING_BYTES,
  MAX_WINDOW_SIZE, MAX_TRACKED_MESSAGES, MAX_DELIVERY_SEQ,
  SETTLED_RECEIPT_CACHE_LIMIT, SETTLED_RECEIPT_TTL_MS,
  type ReceiptRetentionOptions, type ArloMessageNotificationParams,
  type RootReceiptRequest, type RootCreditReleaseRequest,
} from '@arlo/sdk';

export interface ReceptionScope {
  instanceId: string;
  generation: number;
}

export type ReceptionDispatch = Pick<RootReceiptRequest,
  'daemon_id' | 'endpoint_id' | 'message_id' | 'delivery_id' | 'generation'>;

export interface PendingInput {
  nativeMessageId: string;
  /** An unassociated, pre-existing input uses its opaque native ID. */
  messageId: string;
  textBytes: number;
  dispatch?: ReceptionDispatch;
}

export interface PendingSnapshot extends ReceptionScope {
  complete: boolean;
  pending: readonly PendingInput[];
  /** All input outside pending queues that can still become pending. */
  inFlight: readonly PendingInput[];
}

export interface ReceptionEvidence {
  instanceId: string;
  dispatch: ReceptionDispatch;
  nativeMessageId: string;
  event: 'claimed' | 'discarded' | 'enqueued' | 'not_enqueued';
}

export interface ReceptionHost {
  /** Stable for one live host object, distinct for a replacement. */
  readonly instanceId: string;
  /** Construction only: must not insert or schedule input. */
  prepare(frame: ArloMessageNotificationParams): {
    nativeMessageId: string;
    /** enqueued confirms pending input, never model reading or completion. */
    enqueue(): 'enqueued' | 'not_enqueued' | 'unknown' | Promise<'enqueued' | 'not_enqueued' | 'unknown'>;
  };
  snapshot?(scope: ReceptionScope): PendingSnapshot;
  observe?(listener: (evidence: ReceptionEvidence) => void): () => void;
}

function sameDispatch(a: ReceptionDispatch, b: ReceptionDispatch): boolean {
  return a.daemon_id === b.daemon_id && a.endpoint_id === b.endpoint_id &&
    a.message_id === b.message_id && a.delivery_id === b.delivery_id && a.generation === b.generation;
}

export interface ReceiptResult {
  status: 'enqueued' | 'duplicate' | 'rejected' | 'unknown' | 'stale_sequence';
  native_message_id?: string;
  reason?: string;
}

export interface ReceptionLedgerOptions {
  host: ReceptionHost;
  windowSize?: number;
  currentGeneration: number;
  initialCapacity?: number;
  settledReceiptRetention?: ReceiptRetentionOptions;
  /** Injectable clock so retention bounds are testable without waiting. */
  now?: () => number;
  /** Send through the existing SDK client; acknowledge only after its ACK. */
  onCredit?: (proof: RootCreditReleaseRequest) => void;
  /** Explicit later host evidence uses the existing receipt transport. */
  onReceipt?: (proof: RootReceiptRequest) => void;
}

interface RetainedReceipt {
  result: ReceiptResult;
  fingerprint: string;
  textBytes: number;
  /** Pending host credit is activity accounting, not ordinary cache. */
  creditHeld: boolean;
  settledAt: number;
  dispatch: Pick<RootReceiptRequest, 'daemon_id' | 'endpoint_id' | 'message_id' | 'delivery_id' | 'generation'>;
  nativeMessageId?: string;
  released?: RootCreditReleaseRequest['event'];
  creditUnconfirmed?: boolean;
  conflict?: [RootReceiptRequest, RootReceiptRequest];
  deferredEvidence?: ReceptionEvidence[];
  settlingEvidence?: boolean;
  pendingEnded?: boolean;
}

// Identity of one dispatch attempt. Content, owner and association must all
// match for a repeated message ID to reuse an existing receipt; any difference
// is a conflict that deduplication must not hide.
function fingerprintFrame(frame: ArloMessageNotificationParams): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        frame.daemon_id,
        frame.message_id,
        frame.delivery_id,
        frame.from_endpoint,
        frame.to_endpoint,
        frame.group_id,
        frame.target_generation,
        frame.delivery_seq,
        frame.text,
        frame.reply_to,
        frame.reply_depth,
      ]),
      'utf8'
    )
    .digest('hex');
}

export class ReceptionLedger {
  private host: ReceptionHost;
  private windowSize: bigint;
  private currentGeneration: number;
  private capacity: number;
  private readonly pendingCredit = new Map<string, string>();
  /** UTF-8 bytes of every message whose pending credit is held, by native ID. */
  private readonly pendingBytesByNative = new Map<string, number>();
  private pendingBytesTotal = 0;
  private readonly receipts = new Map<string, RetainedReceipt>();
  private readonly seenSequences = new Set<bigint>();
  private readonly settledLimit: number;
  private readonly settledTtlMs: number;
  private readonly now: () => number;
  private highestSeq = 0n;
  private readonly enqueuing = new Set<string>();
  private readonly onCredit?: (proof: RootCreditReleaseRequest) => void;
  private readonly onReceipt?: (proof: RootReceiptRequest) => void;
  private stopObserving?: () => void;
  private disposed = false;
  private conflicted = false;
  private snapshotAvailable = true;

  constructor(options: ReceptionLedgerOptions) {
    this.host = options.host;
    this.windowSize = BigInt(options.windowSize ?? MAX_WINDOW_SIZE);
    this.currentGeneration = options.currentGeneration;
    this.capacity = options.initialCapacity ?? MAX_ROOT_PENDING_MESSAGES;
    this.settledLimit = options.settledReceiptRetention?.limit ?? SETTLED_RECEIPT_CACHE_LIMIT;
    this.settledTtlMs = options.settledReceiptRetention?.ttlMs ?? SETTLED_RECEIPT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.onCredit = options.onCredit;
    this.onReceipt = options.onReceipt;
    this.observePendingSnapshot();
    this.stopObserving = this.host.observe?.(evidence => this.observeEvidence(evidence));
  }

  getPendingMessageIds(): string[] {
    this.observePendingSnapshot();
    return Array.from(new Set(this.pendingCredit.values()));
  }

  // A settled receipt is ordinary cache only once its credit is released. The
  // release itself never drops the receipt or frees accounting by itself.
  // Returns the framework message ID that was released, if any was held.
  private releasePendingCredit(nativeMessageId: string, reason: 'claimed' | 'discarded' | 'snapshot' | 'not_enqueued'): string | undefined {
    const frameMessageId = this.pendingCredit.get(nativeMessageId);
    if (frameMessageId === undefined) return undefined;
    this.pendingCredit.delete(nativeMessageId);
    const bytes = this.pendingBytesByNative.get(nativeMessageId);
    if (bytes !== undefined) {
      this.pendingBytesTotal = Math.max(0, this.pendingBytesTotal - bytes);
      this.pendingBytesByNative.delete(nativeMessageId);
    }
    const receipt = this.receipts.get(frameMessageId);
    if (receipt) {
      const event = reason === 'not_enqueued' ? undefined : reason;
      receipt.creditHeld = false;
      receipt.pendingEnded ||= reason !== 'not_enqueued';
      receipt.settledAt = this.now();
      receipt.released = event;
      receipt.creditUnconfirmed = event !== undefined;
    }
    this.pruneReceipts();
    return frameMessageId;
  }

  acknowledgeCredit(messageId: string): void {
    const receipt = this.receipts.get(messageId);
    if (receipt) receipt.creditUnconfirmed = false;
    this.pruneReceipts();
  }

  /** Evidence refers to its original dispatch even after a transport reconnect. */
  observeEvidence(evidence: ReceptionEvidence): boolean {
    if (this.disposed || evidence.instanceId !== this.host.instanceId) return false;
    const receipt = this.receipts.get(evidence.dispatch.message_id);
    if (!receipt || !sameDispatch(receipt.dispatch, evidence.dispatch) ||
        receipt.nativeMessageId !== evidence.nativeMessageId) return false;
    if (evidence.event === 'enqueued' || evidence.event === 'not_enqueued') {
      if (this.enqueuing.has(evidence.nativeMessageId)) {
        receipt.deferredEvidence ??= [];
        if (!receipt.deferredEvidence.some(item => item.event === evidence.event)) receipt.deferredEvidence.push(evidence);
        return true;
      }
      if (receipt.conflict) return false;
      const result: ReceiptResult = evidence.event === 'enqueued'
        ? { status: 'enqueued', native_message_id: evidence.nativeMessageId }
        : { status: 'rejected', reason: ArloErrorCode.QUEUE_LIMIT };
      const assertion = { ...receipt.dispatch, ...receiptOutcome(result), native_message_id: receipt.nativeMessageId };
      const previous = receiptOutcome(receipt.result);
      if (previous.status !== 'uncertain' && previous.status !== assertion.status) {
        receipt.conflict = [{ ...receipt.dispatch, ...previous, native_message_id: receipt.nativeMessageId }, assertion];
        receipt.result = { status: 'unknown', reason: ArloErrorCode.RECEIPT_CONFLICT };
        this.conflicted = true;
        if (!receipt.pendingEnded && !this.pendingCredit.has(evidence.nativeMessageId)) {
          this.chargePending(evidence.nativeMessageId, receipt.dispatch.message_id, receipt.textBytes);
          receipt.creditHeld = true;
        }
      } else {
        receipt.result = result;
        if (evidence.event === 'not_enqueued' && !receipt.settlingEvidence) this.releasePendingCredit(evidence.nativeMessageId, 'not_enqueued');
      }
      receipt.settledAt = this.now();
      // The earlier assertion may still be inside receiveFrame, unpublished.
      // Publish both sides so the Daemon can detect the same conflict.
      for (const proof of receipt.conflict ?? [assertion]) {
        try { this.onReceipt?.(proof); }
        catch {}
      }
      return true;
    }
    if (evidence.event !== 'claimed' && evidence.event !== 'discarded') return false;
    const released = this.releasePendingCredit(evidence.nativeMessageId, evidence.event);
    if (!released) return false;
    // Accounting transport failures cannot escape through a synchronous host
    // observer. The unacknowledged proof remains available for recovery.
    try { this.onCredit?.({ ...receipt.dispatch, native_message_id: evidence.nativeMessageId, event: evidence.event }); }
    catch {}
    return true;
  }

  /** Reconnect uses the real host queues; absent messages are never acceptance evidence. */
  reconcilePendingMessageIds(options: { requireComplete?: boolean; allowMissingSnapshot?: boolean } = {}): string[] {
    const snapshot = this.observePendingSnapshot();
    if (options.requireComplete && (this.conflicted || !this.snapshotAvailable ||
        ((!options.allowMissingSnapshot || this.host.snapshot) && snapshot?.complete !== true) || this.enqueuing.size > 0)) {
      throw new ArloError(ArloErrorCode.ACCOUNTING_UNAVAILABLE);
    }
    if (snapshot?.complete === true) {
      const pending = new Set([...snapshot.pending, ...snapshot.inFlight].map(input => input.nativeMessageId));
      for (const nativeId of this.pendingCredit.keys()) {
        const receipt = this.receipts.get(this.pendingCredit.get(nativeId)!);
        if (!pending.has(nativeId) && !this.enqueuing.has(nativeId) && !receipt?.conflict) {
          this.releasePendingCredit(nativeId, 'snapshot');
        }
      }
    }
    return [...new Set(this.pendingCredit.values())];
  }

  /** Credit proofs remain recoverable until the daemon acknowledges them. */
  getUnconfirmedCredits(): RootCreditReleaseRequest[] {
    return [...this.receipts.values()].filter(record => record.creditUnconfirmed && !record.conflict &&
      record.released !== undefined && record.nativeMessageId !== undefined).map(record => ({
        ...record.dispatch, native_message_id: record.nativeMessageId, event: record.released!,
      }));
  }

  /** Original receipts and credit proofs; snapshots never manufacture a receipt. */
  getRetainedEvidence(): { receipt: RootReceiptRequest; credit?: RootCreditReleaseRequest }[] {
    this.pruneReceipts();
    // A refusal before construction has no native message, but its original
    // dispatch identity still proves that this live receiver did not enqueue it.
    return [...this.receipts.values()]
      .filter(record => record.nativeMessageId !== undefined || record.result.status === 'rejected')
      .flatMap(record => {
        const receipts = record.conflict ?? [{ ...record.dispatch, ...receiptOutcome(record.result), native_message_id: record.nativeMessageId }];
        return receipts.map((receipt, index) => ({
          receipt: { ...receipt },
          ...(index === 0 && record.released && record.nativeMessageId ? { credit: {
            ...record.dispatch, native_message_id: record.nativeMessageId, event: record.released,
          } } : {}),
        }));
      });
  }

  private chargePending(nativeMessageId: string, frameMessageId: string, bytes: number): void {
    this.pendingCredit.set(nativeMessageId, frameMessageId);
    this.pendingBytesByNative.set(nativeMessageId, bytes);
    this.pendingBytesTotal += bytes;
  }

  private observePendingSnapshot(): PendingSnapshot | undefined {
    if (!this.host.snapshot) return;
    this.snapshotAvailable = false;
    try {
      const snapshot = this.host.snapshot?.({ instanceId: this.host.instanceId, generation: this.currentGeneration });
      if (!snapshot || snapshot.instanceId !== this.host.instanceId || snapshot.generation !== this.currentGeneration) return;
      if (!Array.isArray(snapshot.pending) || !Array.isArray(snapshot.inFlight)) return;
      const inputs = [...snapshot.pending, ...snapshot.inFlight];
      const nativeIds = new Set<string>();
      const messageIds = new Set<string>();
      // Validate the entire proof before changing accounting. A contradictory
      // entry makes absence elsewhere in that snapshot unusable as evidence.
      for (const input of inputs) {
        if (!input.nativeMessageId || !input.messageId || !Number.isSafeInteger(input.textBytes) || input.textBytes < 0 ||
            nativeIds.has(input.nativeMessageId) || messageIds.has(input.messageId)) return;
        nativeIds.add(input.nativeMessageId);
        messageIds.add(input.messageId);
        const associated = this.pendingCredit.get(input.nativeMessageId);
        if (associated !== undefined && associated !== input.messageId) return;
        const receipt = this.receipts.get(input.messageId);
        if (receipt && (receipt.nativeMessageId !== input.nativeMessageId || !input.dispatch ||
            !sameDispatch(receipt.dispatch, input.dispatch))) return;
        if (input.dispatch && input.dispatch.message_id !== input.messageId) return;
      }
      for (const input of inputs) {
        if (!this.pendingCredit.has(input.nativeMessageId)) {
          this.chargePending(input.nativeMessageId, input.messageId, input.textBytes);
        }
      }
      this.snapshotAvailable = snapshot.complete === true;
      return snapshot;
    } catch {
      // A host observation failure is not an empty queue and must not expose
      // host exception details or admit input against unverified capacity.
      return;
    }
  }

  getAvailableCapacity(): number {
    this.observePendingSnapshot();
    return this.snapshotAvailable ? Math.max(0, this.capacity - this.pendingCredit.size) : 0;
  }

  advanceGeneration(newGen: number): void {
    this.currentGeneration = newGen;
    // A replay window belongs to exactly one connection generation.
    this.seenSequences.clear();
    this.highestSeq = 0n;
    this.observePendingSnapshot();
  }

  private lowestWindowSeq(): bigint {
    return this.highestSeq > this.windowSize ? this.highestSeq - this.windowSize + 1n : 1n;
  }

  private pruneSequences(): void {
    const minValid = this.lowestWindowSeq();
    for (const s of this.seenSequences) {
      if (s < minValid) {
        this.seenSequences.delete(s);
      }
    }
  }

  private isEvictable(receipt: RetainedReceipt): boolean {
    if (receipt.creditHeld || receipt.creditUnconfirmed || receipt.settlingEvidence) return false;
    return receipt.result.status === 'enqueued' || receipt.result.status === 'rejected';
  }

  // Ordinary cache expires on use, not only when a sweep happens to run: an
  // idle root must not keep answering from a receipt older than the retention
  // window. Activity records have no such window.
  private liveReceipt(messageId: string): RetainedReceipt | undefined {
    const receipt = this.receipts.get(messageId);
    if (!receipt) return undefined;
    if (this.isEvictable(receipt) && this.now() - receipt.settledAt >= this.settledTtlMs) {
      this.receipts.delete(messageId);
      return undefined;
    }
    return receipt;
  }

  // Bounded, time-limited eviction of settled receipts. Activity records
  // (pending credit or an undecided result) stay even when the bound is
  // exceeded, and eviction never releases pending credit.
  private pruneReceipts(): void {
    const now = this.now();
    let settled = 0;
    for (const receipt of this.receipts.values()) {
      if (this.isEvictable(receipt)) settled++;
    }
    for (const [messageId, receipt] of [...this.receipts]) {
      if (!this.isEvictable(receipt)) continue;
      if (now - receipt.settledAt >= this.settledTtlMs || settled > this.settledLimit) {
        this.receipts.delete(messageId);
        settled--;
      }
    }
  }

  // Reserve both sequence and ID before calling the host: even synchronous
  // host observers can reenter reception before the insertion returns.
  async receiveFrame(
    frame: ArloMessageNotificationParams,
    isBindingActive?: () => boolean
  ): Promise<ReceiptResult> {
    if (this.disposed) return { status: 'rejected', reason: ArloErrorCode.CHANNEL_NOT_READY };
    if (frame.target_generation !== this.currentGeneration) {
      return {
        status: 'rejected',
        reason: ArloErrorCode.STALE_GENERATION,
      };
    }

    if (!/^[1-9]\d*$/.test(frame.delivery_seq)) {
      return { status: 'rejected', reason: ArloErrorCode.INVALID_ARGUMENT };
    }
    const seq = BigInt(frame.delivery_seq);
    if (seq > MAX_DELIVERY_SEQ) {
      return { status: 'rejected', reason: ArloErrorCode.INVALID_ARGUMENT };
    }

    const fingerprint = fingerprintFrame(frame);
    const retained = this.liveReceipt(frame.message_id);
    if (retained) {
      if (retained.fingerprint !== fingerprint) {
        return { status: 'rejected', reason: ArloErrorCode.MESSAGE_ID_CONFLICT };
      }
      return retained.result;
    }
    if (this.conflicted) return { status: 'rejected', reason: ArloErrorCode.RECEIPT_CONFLICT };

    // A frame whose result is no longer recoverable is reported as an
    // undecided outcome, never as a fabricated rejection or success, and is
    // never delivered to the host again.
    if (this.seenSequences.has(seq)) {
      return { status: 'duplicate', reason: ArloErrorCode.REPLAY_RESULT_UNAVAILABLE };
    }
    if (seq < this.lowestWindowSeq()) {
      return { status: 'stale_sequence', reason: ArloErrorCode.STALE_SEQUENCE };
    }

    // Final lifecycle check. An invalidated callback must not reach the host,
    // and nothing has been reserved yet when it fails.
    if (isBindingActive && !isBindingActive()) {
      return { status: 'rejected', reason: ArloErrorCode.CHANNEL_NOT_READY };
    }

    this.seenSequences.add(seq);
    if (seq > this.highestSeq) {
      this.highestSeq = seq;
      this.pruneSequences();
    }

    this.pruneReceipts();
    if (this.receipts.size >= MAX_TRACKED_MESSAGES) {
      // No room for another ID record. The bounded sequence window still
      // prevents this refused dispatch from entering after budget frees up.
      return { status: 'rejected', reason: ArloErrorCode.ACCOUNTING_UNAVAILABLE };
    }

    const receipt: RetainedReceipt = {
      result: { status: 'unknown', reason: ArloErrorCode.ENQUEUE_UNCERTAIN },
      fingerprint,
      textBytes: Buffer.byteLength(frame.text, 'utf8'),
      creditHeld: false,
      settledAt: this.now(),
      dispatch: {
        daemon_id: frame.daemon_id,
        endpoint_id: frame.to_endpoint,
        message_id: frame.message_id,
        delivery_id: frame.delivery_id,
        generation: frame.target_generation,
      },
    };
    this.receipts.set(frame.message_id, receipt);

    // The per-root byte budget is reserved here, before the frame can reach the
    // host, so backlog can never exceed 1 MiB of UTF-8 text per root even when
    // the dispatching daemon's own accounting is missing or out of date.
    // Readiness publication is deliberately not gated on bytes: a byte-full
    // backlog must still reach the daemon's reconciliation, which decides with
    // ACCOUNTING_UNAVAILABLE instead of wedging at the adapter.
    const frameBytes = receipt.textBytes;
    const availableCapacity = this.getAvailableCapacity();
    if (!this.snapshotAvailable) {
      receipt.result = { status: 'rejected', reason: ArloErrorCode.ACCOUNTING_UNAVAILABLE };
      this.pruneReceipts();
      return receipt.result;
    }
    if (
      availableCapacity === 0 ||
      this.pendingBytesTotal + frameBytes > MAX_ROOT_PENDING_BYTES
    ) {
      receipt.result = { status: 'rejected', reason: ArloErrorCode.QUEUE_LIMIT };
      this.pruneReceipts();
      return receipt.result;
    }

    let nativeMessageId: string | undefined;
    let completed = false;
    try {
      const prepared = this.host.prepare(frame);
      if (this.disposed || frame.target_generation !== this.currentGeneration || isBindingActive && !isBindingActive()) {
        receipt.result = { status: 'rejected', reason: ArloErrorCode.CHANNEL_NOT_READY };
        return receipt.result;
      }
      if (!prepared.nativeMessageId || this.pendingCredit.has(prepared.nativeMessageId) ||
          [...this.receipts.values()].some(record => record.nativeMessageId === prepared.nativeMessageId)) {
        receipt.result = { status: 'rejected', reason: ArloErrorCode.MESSAGE_ID_CONFLICT };
        this.pruneReceipts();
        return receipt.result;
      }
      nativeMessageId = prepared.nativeMessageId;
      receipt.nativeMessageId = nativeMessageId;
      this.chargePending(nativeMessageId, frame.message_id, frameBytes);
      receipt.creditHeld = true;
      this.enqueuing.add(nativeMessageId);
      const outcome = prepared.enqueue();
      const result = typeof outcome === 'string' ? outcome : await outcome;
      completed = true;
      if (result === 'enqueued') receipt.result = { status: 'enqueued', native_message_id: nativeMessageId };
      else if (result === 'not_enqueued') {
        receipt.result = { status: 'rejected', reason: ArloErrorCode.QUEUE_LIMIT };
      }
    } catch {
      // Host observers can throw after insertion. Without proof of no side
      // effects, retain the reservation and never expose host exception text.
      receipt.result = { status: 'unknown', reason: ArloErrorCode.ENQUEUE_UNCERTAIN };
    } finally {
      if (nativeMessageId !== undefined) this.enqueuing.delete(nativeMessageId);
    }

    // A callback inside enqueue cannot publish a success before a subsequent
    // exception. Later explicit observations may still settle that unknown.
    const deferred = receipt.deferredEvidence;
    receipt.deferredEvidence = undefined;
    receipt.settlingEvidence = true;
    if (completed) for (const evidence of deferred ?? []) this.observeEvidence(evidence);
    receipt.settlingEvidence = false;
    if (receipt.result.status === 'rejected' && nativeMessageId !== undefined) this.releasePendingCredit(nativeMessageId, 'not_enqueued');

    // Observe actual accounting after synchronous host callbacks, including
    // credit release or a post-insertion throw.
    receipt.creditHeld = nativeMessageId !== undefined && this.pendingCredit.has(nativeMessageId);
    receipt.settledAt = this.now();
    this.pruneReceipts();
    return receipt.result;
  }

  dispose(): void {
    this.disposed = true;
    this.stopObserving?.();
    this.stopObserving = undefined;
    this.seenSequences.clear();
    this.receipts.clear();
    this.pendingCredit.clear();
    this.pendingBytesByNative.clear();
    this.pendingBytesTotal = 0;
  }
}

export function receiptOutcome(receipt: ReceiptResult): Pick<RootReceiptRequest, 'status' | 'reason' | 'native_message_id'> {
  if (receipt.status === 'enqueued') return { status: 'enqueued', native_message_id: receipt.native_message_id };
  if (receipt.status === 'rejected') return { status: 'not_enqueued', reason: receipt.reason ?? ArloErrorCode.QUEUE_LIMIT };
  return { status: 'uncertain', reason: receipt.reason ?? (
    receipt.status === 'unknown' ? ArloErrorCode.ENQUEUE_UNCERTAIN : ArloErrorCode.REPLAY_RESULT_UNAVAILABLE
  ) };
}

export { createAdapterRuntime, type AdapterHost, type AdapterRuntimeOptions, type SharedStartupOptions } from './runtime.ts';
export { createParticipationSettings, readParticipationPreference, participationScope, type ParticipationStatus } from './participation.ts';
