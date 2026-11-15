import crypto from 'node:crypto';
import {
  ArloErrorCode, type ArloSendMessageResult,
  type RootReceiptRequest, type RootCreditReleaseRequest, type ReadyRootRequest,
  type ArloMessageNotificationParams, type ArloMessageStatusQueryResult, type ArloMessageStatusResult,
  type ArloReceiptAssertion, type ArloUncertainAssertion, type ArloRecordedAssertion,
  ARLO_PROFILE_VERSION, ARLO_NOTIFICATION_METHOD, ARLO_MESSAGE_ID_META_KEY,
  MAX_SINGLE_TEXT_BYTES, MAX_ROOT_PENDING_MESSAGES, MAX_ROOT_PENDING_BYTES,
  MAX_INSTANCE_PENDING_BYTES, MAX_CONCURRENT_IN_FLIGHT_ACKS, MAX_DELIVERY_SEQ, MAX_REPLY_DEPTH,
  type RootRateLimit,
} from '@arlo/sdk';
import type { EndpointRecord } from '../server/index.ts';
import { LogEventCode, type AuditLogger } from '../logging/index.ts';

export type MessageStatus = 'in_flight' | 'accepted' | 'rejected' | 'unknown';

/** The outcome a send tool call already returned to its caller. Never rewritten. */
export interface ReturnedSendOutcome {
  status: 'accepted' | 'rejected' | 'unknown';
  reason?: string;
  returnedAt: number;
}

export interface MessageRecord {
  messageId: string;
  deliveryId: string;
  fromEndpoint: string;
  toEndpoint: string;
  groupId: string;
  targetGeneration: number;
  deliverySeq: string;
  text: string;
  textBytes: number;
  sentAt: string;
  status: MessageStatus;
  reason?: string;
  nativeMessageId?: string;
  pendingCredit: boolean;
  receiptWaiters: Array<(status: 'accepted' | 'rejected' | 'unknown', reason?: string) => void>;
  createdAt: number;
  /**
   * Every receipt already merged into `status`, including uncertain ones.
   * Repeats of the winning assertion are idempotent; a definite assertion
   * contradicting this one is a conflict.
   */
  recordedAssertions: ArloRecordedAssertion[];
  /**
   * The definite assertion currently reflected by `status`. Kept separately
   * because later evidence must not overwrite the recorded result.
   */
  winningAssertion?: ArloReceiptAssertion;
  /** Set once a definite assertion contradicts the recorded one. */
  conflict?: {
    detectedAt: number;
    assertions: ArloReceiptAssertion[];
    stoppedEndpointId: string;
  };
  /** Populated when the send tool result was already delivered. */
  returnedOutcome?: ReturnedSendOutcome;
  /** True when definitive evidence arrived only after the tool result returned. */
  lateEvidence: boolean;
  /** Authorised parent message ID when this record is an associated reply. */
  replyTo?: string;
  /** Depth computed by the daemon: 0 for a new message, parent depth + 1 for a reply. */
  replyDepth: number;
  /** Last time the record was fully settled, used by the bounded retention policy. */
  settledAt?: number;
  /** Last time any receipt touched this record, used by active-ledger accounting. */
  lastReceiptAt?: number;
}


interface MessageExchangeOptions {
  daemonId: string;
  now: () => number;
  messageRecordTtlMs: number;
  maxTrackedMessages: number;
  ackTimeoutMs: number;
  senderRateLimit: RootRateLimit;
  receiverRateLimit: RootRateLimit;
  endpoints: Map<string, EndpointRecord>;
  permitsCommunication: (from: EndpointRecord, to: EndpointRecord) => boolean;
  replayDispatch?: (endpointId: string, messageId: string, payload: unknown) => boolean;
  charge: (endpointId: string, messageId: string, payload: unknown) => boolean | void;
  log: AuditLogger['log'];
}

export class MessageAdmissionError extends Error {}
export class MessageExchangeControlError extends Error {
  readonly statusCode: number;
  readonly response: { error: ArloErrorCode; message?: string };

  constructor(statusCode: number, response: { error: ArloErrorCode; message?: string }) {
    super(response.message ?? response.error);
    this.statusCode = statusCode;
    this.response = response;
  }
}

/** The sole live-instance authority for dispatch, replay protection, receipt
 * evidence, and pending credit. HTTP handlers never inspect or mutate records. */
export class MessageExchange {
  private globalPendingBytes = 0;
  private inFlightAckCount = 0;
  private readonly messages = new Map<string, MessageRecord>();
  // Retired logical IDs retain replay protection and consume tracking capacity.
  private readonly retiredMessageIds = new Set<string>();
  private readonly daemonId: string;
  private readonly now: () => number;
  private readonly messageRecordTtlMs: number;
  private readonly maxTrackedMessages: number;
  private readonly ackTimeoutMs: number;
  private readonly senderRateLimit: RootRateLimit;
  private readonly receiverRateLimit: RootRateLimit;
  private readonly endpoints: Map<string, EndpointRecord>;
  private readonly logger: { log: AuditLogger['log'] };
  private readonly options: MessageExchangeOptions;

  constructor(options: MessageExchangeOptions) {
    this.options = options;
    this.daemonId = options.daemonId;
    this.now = options.now;
    this.messageRecordTtlMs = options.messageRecordTtlMs;
    this.maxTrackedMessages = options.maxTrackedMessages;
    this.ackTimeoutMs = options.ackTimeoutMs;
    this.senderRateLimit = options.senderRateLimit;
    this.receiverRateLimit = options.receiverRateLimit;
    this.endpoints = options.endpoints;
    this.logger = { log: options.log };
  }

  private permitsCommunication(from: EndpointRecord, to: EndpointRecord): boolean {
    return this.options.permitsCommunication(from, to);
  }

  reconcileReady(ep: EndpointRecord, body: ReadyRootRequest): void {
    if (this.hasUnreconciledConflict(ep.endpointId)) {
      ep.ready = false;
      ep.deliverable = false;
      throw new MessageExchangeControlError(409, { error: ArloErrorCode.ACCOUNTING_UNAVAILABLE,
        message: 'A conflicting receipt fault is still unreconciled for this binding' });
    }
    if (!ep.mcpSessionId || !ep.sseStream || ep.sseStream.writableEnded) {
      throw new MessageExchangeControlError(400, { error: ArloErrorCode.CHANNEL_NOT_READY,
        message: 'MCP session not initialized' });
    }
    const existingPending = [...this.messages.values()].filter(msg => msg.toEndpoint === ep.endpointId && msg.pendingCredit);
    const reportedIds = body.reconciled_pending_message_ids ?? [];
    if (!Array.isArray(reportedIds) || reportedIds.some(id => typeof id !== 'string' || !id)) {
      throw new MessageExchangeControlError(400, { error: ArloErrorCode.INVALID_ARGUMENT });
    }
    const reported = new Set(reportedIds);
    if (!existingPending.every(msg => reported.has(msg.messageId)) || reported.size !== existingPending.length) {
      ep.ready = false;
      ep.deliverable = false;
      throw new MessageExchangeControlError(409, { error: ArloErrorCode.ACCOUNTING_UNAVAILABLE,
        message: 'cannot reconcile existing pending queue state upon re-entry' });
    }
    ep.pendingMessagesCount = existingPending.length;
    ep.pendingBytes = existingPending.reduce((sum, msg) => sum + msg.textBytes, 0);
    ep.ready = true;
    ep.deliverable = true;
  }

  recordReceipt(ep: EndpointRecord, body: RootReceiptRequest, currentRootCredential: boolean): void {
    const msg = this.messages.get(body.message_id);
    if (!msg) {
      // The record is expired or was never dispatched by this daemon, so the
      // original result can no longer be verified. Refusing is the only
      // honest answer: it neither fabricates a rejection nor acknowledges a
      // receipt that may belong to a record this daemon never owned.
      throw new MessageExchangeControlError(409, {
          error: ArloErrorCode.REPLAY_RESULT_UNAVAILABLE,
          message: 'No matching dispatch record is retained for this receipt',
        });
    }

    // A proven refusal before construction has no native ID. Historical
    // enqueue/uncertain evidence still needs one, and an established native
    // association below must always match, including for negative receipts.
    if (
      msg.deliveryId !== body.delivery_id ||
      msg.toEndpoint !== ep.endpointId ||
      body.daemon_id !== this.daemonId ||
      msg.targetGeneration !== body.generation ||
      (body.generation !== ep.connectionGeneration &&
        (!currentRootCredential || body.generation < ep.historicalGenerationFloor ||
          (body.status !== 'not_enqueued' && !body.native_message_id))) ||
      (msg.nativeMessageId !== undefined && msg.nativeMessageId !== body.native_message_id)
    ) {
      throw new MessageExchangeControlError(400, { error: ArloErrorCode.BINDING_MISMATCH });
    }

    // The first receipt or consumption proof establishes the native
    // association. Later assertions cannot switch or omit that identity.
    msg.nativeMessageId ??= body.native_message_id;

    if (msg.status === 'in_flight') {
      // First receipt decides the result the send tool returns.
      msg.lastReceiptAt = this.now();
      if (this.inFlightAckCount > 0) this.inFlightAckCount--;
      if (body.status === 'enqueued') {
        const assertion = this.buildAssertion(body, 'enqueued');
        msg.status = 'accepted';
        msg.nativeMessageId = body.native_message_id;
        msg.winningAssertion = assertion;
        msg.recordedAssertions.push(assertion);
      } else if (body.status === 'not_enqueued') {
        const assertion = this.buildAssertion(body, 'not_enqueued');
        msg.status = 'rejected';
        msg.reason = body.reason;
        msg.winningAssertion = assertion;
        msg.recordedAssertions.push(assertion);
        // Proven absent from the host queue: the reservation is released.
        this.releaseRecordCredit(msg, ep);
      } else {
        msg.status = 'unknown';
        msg.reason = body.reason ?? ArloErrorCode.ENQUEUE_UNCERTAIN;
        // Retain the inconclusive evidence: if a contradicting definite
        // assertion arrives later, the conflict must show what came first.
        msg.recordedAssertions.push(this.buildUncertainAssertion(body));
      }
      this.markSettled(msg);
      this.settleWaiters(msg);
    } else if (body.status === 'uncertain') {
      // An uncertain receipt can never downgrade a definite result. It
      // still settles a waiting record without inventing new evidence.
      msg.lastReceiptAt = this.now();
      if (msg.status === 'unknown') msg.reason ??= body.reason ?? ArloErrorCode.ENQUEUE_UNCERTAIN;
      this.settleWaiters(msg);
    } else {
      const asserted = MessageExchange.assertionStatus(body.status);
      const recorded = msg.status === 'accepted' || msg.status === 'rejected' ? msg.status : undefined;
      if (recorded !== asserted) {
        if (recorded === undefined) {
          // Waiting or unknown is clarified by valid late evidence. The
          // already returned send result stays exactly as it was.
          const assertion = this.buildAssertion(body, body.status);
          msg.lastReceiptAt = this.now();
          msg.status = assertion.status;
          msg.reason = body.reason;
          msg.winningAssertion = assertion;
          msg.recordedAssertions.push(assertion);
          if (msg.nativeMessageId === undefined && body.native_message_id) {
            msg.nativeMessageId = body.native_message_id;
          }
          if (msg.returnedOutcome) msg.lateEvidence = true;
          // The same proof gives the same credit outcome whenever it
          // arrives: not_enqueued releases the reservation, enqueued keeps it.
          if (assertion.receipt === 'not_enqueued') this.releaseRecordCredit(msg, ep);
          this.markSettled(msg);
          this.settleWaiters(msg);
        } else {
          // Two definite assertions contradict each other. Preserve the
          // recorded status and both assertions, stop new deliveries to
          // this binding, and hold credit conservatively for reconciliation.
          const assertion = this.buildAssertion(body, body.status);
          // `recorded` is definite here, so a definite assertion for the
          // recorded side always exists: the winning one or the first
          // definite entry in the ledger.
          const recordedAssertion =
            msg.winningAssertion ??
            msg.recordedAssertions.find((a): a is ArloReceiptAssertion => a.receipt !== 'uncertain') ??
            assertion;
          const assertions = [recordedAssertion, assertion];
          if (!msg.pendingCredit) {
            // A prior rejection (or consumption proof) may have released
            // this reservation. Conflicting enqueue evidence makes that
            // release unsafe; charge it once, even if this exceeds limits.
            msg.pendingCredit = true;
            ep.pendingMessagesCount++;
            ep.pendingBytes += msg.textBytes;
            this.globalPendingBytes += msg.textBytes;
          }
          msg.conflict ??= { detectedAt: this.now(), assertions, stoppedEndpointId: ep.endpointId };
          msg.lastReceiptAt = this.now();
          msg.reason = ArloErrorCode.RECEIPT_CONFLICT;
          msg.settledAt = undefined;
          ep.deliverable = false;
          throw new MessageExchangeControlError(409, {
              error: ArloErrorCode.RECEIPT_CONFLICT,
              message: 'Conflicting receipt status received',
            });
        }
      } else {
        // An identical definite receipt is idempotent: no state change,
        // no second credit release, no re-dispatch.
        msg.lastReceiptAt = this.now();
        this.settleWaiters(msg);
      }
    }

  }

  releaseCredit(ep: EndpointRecord, body: RootCreditReleaseRequest, currentRootCredential: boolean): void {
    const msg = this.messages.get(body.message_id);
    if (msg && (msg.toEndpoint !== ep.endpointId ||
      (body.daemon_id !== undefined && body.daemon_id !== this.daemonId) ||
      (body.generation !== undefined && body.generation !== msg.targetGeneration) ||
      (body.delivery_id !== undefined && body.delivery_id !== msg.deliveryId) ||
      (msg.targetGeneration !== ep.connectionGeneration &&
        (!currentRootCredential || msg.targetGeneration < ep.historicalGenerationFloor || body.daemon_id !== this.daemonId ||
          body.generation !== msg.targetGeneration || body.delivery_id !== msg.deliveryId || !body.native_message_id)) ||
      (msg.nativeMessageId !== undefined && msg.nativeMessageId !== body.native_message_id))) {
      throw new MessageExchangeControlError(400, { error: ArloErrorCode.BINDING_MISMATCH });
    }
    if (msg?.conflict) {
      // The queue state of a conflicted delivery is unproven, so the
      // reservation is held for conservative reconciliation instead of
      // being released on either assertion.
      throw new MessageExchangeControlError(409, {
          error: ArloErrorCode.ACCOUNTING_UNAVAILABLE,
          message: 'Receipt conflict leaves credit unresolved; reconcile before releasing',
        });
    }
    if (msg) msg.nativeMessageId ??= body.native_message_id;
    if (msg && msg.pendingCredit) {
      this.releaseRecordCredit(msg, ep);
    }

  }

  async send(endpoint: EndpointRecord, args: Record<string, unknown>, messageId: unknown,
    requestId: string, startReqTime: number): Promise<ArloSendMessageResult> {
    if (!messageId || typeof messageId !== 'string') {
      throw new MessageAdmissionError(`INVALID_ARGUMENT: missing or invalid _meta["${ARLO_MESSAGE_ID_META_KEY}"]`);
    }

    if (!args || typeof args.to !== 'string' || !args.to.trim() || args.to === '*' || args.to.toLowerCase() === 'all') {
      throw new MessageAdmissionError('INVALID_ARGUMENT: "to" must be a non-empty string endpoint ID without wildcards');
    }

    if (typeof args.text !== 'string' || args.text.length === 0) {
      throw new MessageAdmissionError('INVALID_ARGUMENT: "text" must be a non-empty string');
    }

    if (args.reply_to !== undefined && (typeof args.reply_to !== 'string' || !args.reply_to.trim())) {
      throw new MessageAdmissionError('INVALID_ARGUMENT: "reply_to" must be a non-empty string when present');
    }

    const textBytes = Buffer.byteLength(args.text, 'utf8');
    if (textBytes > MAX_SINGLE_TEXT_BYTES) {
      throw new MessageAdmissionError(`MESSAGE_TOO_LARGE: text size (${textBytes} bytes) exceeds limit of 32 KiB`);
    }

    // Query expiry never grants permission to dispatch a logical ID again.
    this.evictExpiredRecords();
    if (this.retiredMessageIds.has(messageId)) {
      throw new MessageAdmissionError(`${ArloErrorCode.REPLAY_RESULT_UNAVAILABLE}: original result expired; message cannot be dispatched again`);
    }

    // Deduplication & Conflict check on messageId
    const existing = this.messages.get(messageId);
    if (existing) {
      if (existing.fromEndpoint !== endpoint.endpointId || existing.groupId !== endpoint.groupId ||
          existing.text !== args.text || existing.toEndpoint !== args.to || existing.replyTo !== args.reply_to) {
        throw new MessageAdmissionError('MESSAGE_ID_CONFLICT: message ID reused with differing content or recipient');
      }
      if (existing.status === 'in_flight') {
        await new Promise<void>(resolve => existing.receiptWaiters.push(() => resolve()));
      }
      return { status: existing.status as 'accepted' | 'rejected' | 'unknown', message_id: messageId,
        ...(existing.reason ? { reason: existing.reason } : {}) };
    }

    if (this.options.replayDispatch?.(endpoint.endpointId, messageId, { to: args.to, text: args.text, reply_to: args.reply_to ?? null })) {
      return { status: 'unknown', message_id: messageId, reason: ArloErrorCode.ACCOUNTING_UNAVAILABLE };
    }

    // Reply association: the reference must be a known inbound message
    // this endpoint received, and the reply target must be its original
    // sender. Resolution is synchronous and derived solely from
    // daemon-side records — the model can neither redirect the reply to
    // a same-named successor nor supply or forge the depth. An evicted
    // (expired) parent and a parent this endpoint never received are
    // deliberately indistinguishable here.
    let replyDepth = 0;
    if (args.reply_to !== undefined) {
      const parent = this.messages.get(args.reply_to);
      if (!parent || parent.toEndpoint !== endpoint.endpointId || parent.status === 'rejected') {
        throw new MessageAdmissionError(
          `${ArloErrorCode.INVALID_REPLY}: reply reference is not a known inbound message of this endpoint`
        );
      }
      replyDepth = parent.replyDepth + 1;
      if (replyDepth > MAX_REPLY_DEPTH) {
        throw new MessageAdmissionError(
          `${ArloErrorCode.REPLY_DEPTH_LIMIT}: reply chain would exceed the maximum depth of ${MAX_REPLY_DEPTH}`
        );
      }
      if (args.to !== parent.fromEndpoint) {
        throw new MessageAdmissionError(
          `${ArloErrorCode.INVALID_REPLY}: reply target must be the original sender of the referenced message`
        );
      }
      const parentSender = this.endpoints.get(parent.fromEndpoint);
      if (!parentSender || parentSender.status !== 'registered') {
        throw new MessageAdmissionError(
          `${ArloErrorCode.INVALID_REPLY}: the original sender endpoint has been replaced and cannot be addressed`
        );
      }
    }

    // Target lookup
    const target = this.endpoints.get(args.to);
    if (!target || target.status !== 'registered') {
      throw new MessageAdmissionError(`${ArloErrorCode.TARGET_UNAVAILABLE}: target endpoint not found or not active`);
    }

    if (target.groupId !== endpoint.groupId) {
      throw new MessageAdmissionError(`${ArloErrorCode.GROUP_MISMATCH}: target belongs to a different communication group`);
    }

    if (!this.permitsCommunication(endpoint, target)) {
      throw new MessageAdmissionError(`${ArloErrorCode.CROSS_HOST_DISABLED}: both hosts must enable cross-host communication`);
    }

    if (!target.ready || !target.deliverable || !target.sseStream || target.sseStream.writableEnded) {
      throw new MessageAdmissionError(`${ArloErrorCode.TARGET_UNAVAILABLE}: target endpoint is not ready or deliverable`);
    }

    // A delivery sequence never wraps. Before the counter is exhausted
    // the target connection generation must be replaced; while it
    // cannot be replaced safely, new dispatch stops instead of reusing
    // or wrapping a sequence number.
    if (target.currentDeliverySeq >= MAX_DELIVERY_SEQ) {
      target.deliverable = false;
      throw new MessageAdmissionError(
        `${ArloErrorCode.SEQUENCE_EXHAUSTED}: target connection generation ${target.connectionGeneration} reached the uint64 delivery sequence limit and needs a new generation`
      );
    }

    // Capacity checks
    if (this.globalPendingBytes + textBytes > MAX_INSTANCE_PENDING_BYTES) {
      throw new MessageAdmissionError(`${ArloErrorCode.QUEUE_LIMIT}: daemon instance pending budget (8 MiB) exceeded`);
    }

    if (
      target.pendingMessagesCount >= MAX_ROOT_PENDING_MESSAGES ||
      target.pendingBytes + textBytes > MAX_ROOT_PENDING_BYTES
    ) {
      throw new MessageAdmissionError(`${ArloErrorCode.QUEUE_LIMIT}: target root pending queue limit (64 messages or 1 MiB) reached`);
    }

    if (this.inFlightAckCount >= MAX_CONCURRENT_IN_FLIGHT_ACKS) {
      throw new MessageAdmissionError(`${ArloErrorCode.RATE_LIMITED}: maximum in-flight ACK confirmations reached (64)`);
    }

    // Retired IDs still consume the bounded replay-protection budget.
    if (this.messages.size + this.retiredMessageIds.size >= this.maxTrackedMessages) {
      throw new MessageAdmissionError(
        `${ArloErrorCode.ACCOUNTING_UNAVAILABLE}: maximum tracked messages limit reached (${this.maxTrackedMessages})`
      );
    }

    // Admission pacing: every new business message is paced by its
    // sending root and by its receiving root, no matter how fresh its
    // message UUID is or which targets it scatters across. A peek
    // spends no rate credit; it only advances the refill clock and may
    // mark the bucket rejected, which turns the next admitted message
    // into the audited recovery. The matching spends happen below in
    // the same synchronous turn, so no interleaving admission can slip
    // between peeking and spending.
    const pacedAt = this.now();
    const rejectPaced = (event: LogEventCode, side: 'sending' | 'receiving', limit: RootRateLimit): never => {
      this.logger.log({ event, status: 'rejected', request_id: requestId,
        bytes: 0, duration_ms: Date.now() - startReqTime });
      throw new MessageAdmissionError(`${ArloErrorCode.RATE_LIMITED}: ${side} root admission limit reached (${limit.perMinute}/minute, burst ${limit.burst})`);
    };
    if (!endpoint.senderRate.peek(pacedAt)) rejectPaced(LogEventCode.SEND_RATE_LIMITED, 'sending', this.senderRateLimit);
    if (!target.receiverRate.peek(pacedAt)) rejectPaced(LogEventCode.RECEIVE_RATE_LIMITED, 'receiving', this.receiverRateLimit);

    // Every validation passed. Charge the same synchronous admission that
    // spends rate tokens, reserves credit, and publishes this record.
    if (this.options.charge(endpoint.endpointId, messageId, { to: args.to, text: args.text, reply_to: args.reply_to ?? null }) === false) {
      return { status: 'unknown', message_id: messageId, reason: ArloErrorCode.ACCOUNTING_UNAVAILABLE };
    }

    // Reserve atomically
    this.globalPendingBytes += textBytes;
    target.pendingMessagesCount++;
    target.pendingBytes += textBytes;
    this.inFlightAckCount++;
    target.currentDeliverySeq++;
    const deliverySeq = String(target.currentDeliverySeq);
    const deliveryId = `del-${crypto.randomUUID()}`;

    // Both buckets passed their peek in this same synchronous turn.
    // A recovery spend is the first admission after a rejection on
    // that root, which is the deterministic recovery evidence.
    const senderRecovery = endpoint.senderRate.spend();
    const receiverRecovery = target.receiverRate.spend();
    if (senderRecovery === 'recovered' || receiverRecovery === 'recovered') {
      this.logger.log({
        event: LogEventCode.RATE_RECOVERED,
        status: 'ok',
        request_id: requestId,
        bytes: textBytes,
        duration_ms: Date.now() - startReqTime,
      });
    }

    const msgRecord: MessageRecord = {
      messageId,
      deliveryId,
      fromEndpoint: endpoint.endpointId,
      toEndpoint: target.endpointId,
      groupId: target.groupId,
      targetGeneration: target.connectionGeneration,
      deliverySeq,
      text: args.text,
      textBytes,
      sentAt: new Date(this.now()).toISOString(),
      status: 'in_flight',
      pendingCredit: true,
      receiptWaiters: [],
      createdAt: this.now(),
      recordedAssertions: [],
      lateEvidence: false,
      ...(args.reply_to !== undefined ? { replyTo: args.reply_to } : {}),
      replyDepth,
    };
    this.messages.set(messageId, msgRecord);

    // Dispatch notification frame over target's SSE stream
    const frame: ArloMessageNotificationParams = {
      protocol_version: ARLO_PROFILE_VERSION,
      daemon_id: this.daemonId,
      message_id: messageId,
      delivery_id: deliveryId,
      from_endpoint: endpoint.endpointId,
      to_endpoint: target.endpointId,
      group_id: target.groupId,
      target_generation: target.connectionGeneration,
      delivery_seq: deliverySeq,
      text: args.text,
      sent_at: msgRecord.sentAt,
      ...(args.reply_to !== undefined ? { reply_to: args.reply_to, reply_depth: replyDepth } : {}),
    };

    const ssePayload = JSON.stringify({
      jsonrpc: '2.0',
      method: ARLO_NOTIFICATION_METHOD,
      params: frame,
    });

    try {
      target.sseStream.write(`event: message\ndata: ${ssePayload}\n\n`);
    } catch (err) {
      if (this.inFlightAckCount > 0) this.inFlightAckCount--;
      // A failed write may still have reached the target, so the result
      // stays unknown and the reservation is held conservatively rather
      // than released on an unproven absence.
      msgRecord.status = 'unknown';
      msgRecord.reason = ArloErrorCode.CONNECTION_LOST;
      this.markSettled(msgRecord);
    }

    this.logger.log({
      event: LogEventCode.MESSAGE_DISPATCHED,
      status: 'ok',
      request_id: requestId,
      bytes: textBytes,
      duration_ms: Date.now() - startReqTime,
    });

    // Wait for receipt or timeout or connection close
    const outcome = await new Promise<{ status: 'accepted' | 'rejected' | 'unknown'; reason?: string }>((resolve) => {
      // The send tool result is immutable once returned: record exactly
      // what the caller received so later evidence can be compared
      // against it instead of silently rewriting it.
      const recordOutcome = (status: 'accepted' | 'rejected' | 'unknown', reason?: string) => {
        msgRecord.returnedOutcome ??= { status, ...(reason ? { reason } : {}), returnedAt: this.now() };
        return { status, ...(reason ? { reason } : {}) };
      };

      if (msgRecord.status !== 'in_flight') {
        return resolve(recordOutcome(msgRecord.status, msgRecord.reason));
      }

      const stream = target.sseStream;
      const timer = setTimeout(() => {
        stream?.off('close', onClose);
        if (this.inFlightAckCount > 0) this.inFlightAckCount--;
        msgRecord.status = 'unknown';
        msgRecord.reason = ArloErrorCode.ACK_TIMEOUT;
        this.markSettled(msgRecord);
        this.settleWaiters(msgRecord);
        resolve(recordOutcome('unknown', ArloErrorCode.ACK_TIMEOUT));
      }, this.ackTimeoutMs);

      msgRecord.receiptWaiters.push((status, reason) => {
        clearTimeout(timer);
        stream?.off('close', onClose);
        resolve(recordOutcome(status, reason));
      });

      const onClose = () => {
        clearTimeout(timer);
        if (msgRecord.status === 'in_flight') {
          if (this.inFlightAckCount > 0) this.inFlightAckCount--;
          msgRecord.status = 'unknown';
          msgRecord.reason = ArloErrorCode.CONNECTION_LOST;
          this.markSettled(msgRecord);
          this.settleWaiters(msgRecord);
          resolve(recordOutcome('unknown', ArloErrorCode.CONNECTION_LOST));
        }
      };
      stream?.once('close', onClose);
    });

    return { status: outcome.status, message_id: messageId, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }

  status(endpoint: EndpointRecord, messageId: string): ArloMessageStatusQueryResult {
    this.evictExpiredRecords();
    const msg = this.messages.get(messageId);
    if (!msg || msg.fromEndpoint !== endpoint.endpointId) return {
      status: 'result_unavailable', reason: ArloErrorCode.RESULT_UNAVAILABLE,
      daemon_id: this.daemonId, message_id: messageId,
      detail: 'No reception record is available for this message from the current daemon. This does not prove the message was never enqueued and is not permission to resend it.',
    };
    const statusResult: ArloMessageStatusResult = {
      status: msg.conflict ? 'receipt_conflict' : msg.status,
      daemon_id: this.daemonId,
      message_id: msg.messageId,
      from_endpoint: msg.fromEndpoint,
      to_endpoint: msg.toEndpoint,
      group_id: msg.groupId,
      target_generation: msg.targetGeneration,
      delivery_seq: msg.deliverySeq,
      sent_at: msg.sentAt,
      ...(msg.returnedOutcome ? { original_status: msg.returnedOutcome.status } : {}),
      ...(msg.returnedOutcome?.reason ? { original_reason: msg.returnedOutcome.reason } : {}),
      ...(msg.nativeMessageId ? { native_message_id: msg.nativeMessageId } : {}),
      ...(msg.reason ? { reason: msg.reason } : {}),
      ...(msg.lateEvidence ? { late_evidence: true } : {}),
      ...(msg.conflict ? { conflict_assertions: msg.conflict.assertions } : {}),
    };
    return statusResult;
  }

  canExitIdle(): boolean {
    return this.inFlightAckCount === 0 && this.globalPendingBytes === 0 &&
      ![...this.messages.values()].some(message => this.isRecordActive(message));
  }

  /** True when a record belongs to a binding that is still faulted. */
  private hasUnreconciledConflict(endpointId: string): boolean {
    for (const msg of this.messages.values()) {
      if (msg.toEndpoint === endpointId && msg.conflict) return true;
    }
    return false;
  }

  /** Maps a definite receipt to the fixed assertion status it proves. */
  private static assertionStatus(receipt: 'enqueued' | 'not_enqueued'): 'accepted' | 'rejected' {
    return receipt === 'enqueued' ? 'accepted' : 'rejected';
  }

  /**
   * Active records carry pending credit, an unresolved result, or a conflict
   * that still needs reconciliation. The retention policy never evicts them.
   */
  private isRecordActive(msg: MessageRecord): boolean {
    return msg.pendingCredit || msg.status === 'in_flight' || msg.status === 'unknown' || msg.conflict !== undefined || msg.settledAt === undefined;
  }

  /**
   * Releases expired settled results while retaining their replay protection.
   * Neither active records nor retired IDs can be discarded for admission.
   */
  private evictExpiredRecords(): void {
    const now = this.now();
    for (const msg of this.messages.values()) {
      if (this.isRecordActive(msg)) continue;
      if (now - msg.settledAt! >= this.messageRecordTtlMs) {
        this.retiredMessageIds.add(msg.messageId);
        this.messages.delete(msg.messageId);
      }
    }
  }

  static validNativeMessageId(value: unknown): boolean {
    return value === undefined || (typeof value === 'string' && value.length > 0 &&
      Buffer.byteLength(value, 'utf8') <= 1024 && !/[\u0000-\u001f\u007f]/.test(value));
  }


  /**
   * Records what a definite receipt asserted. `daemon_id` is this daemon's own
   * identity: the receipt has already been proven to belong to it, so a forged
   * value never reaches the ledger.
   */
  private buildAssertion(
    body: RootReceiptRequest,
    receipt: 'enqueued' | 'not_enqueued'
  ): ArloReceiptAssertion {
    return { ...this.buildAssertionBase(body), receipt, status: MessageExchange.assertionStatus(receipt) };
  }

  /** Records an inconclusive receipt as evidence without asserting a result. */
  private buildUncertainAssertion(body: RootReceiptRequest): ArloUncertainAssertion {
    return { ...this.buildAssertionBase(body), receipt: 'uncertain' };
  }

  private buildAssertionBase(body: RootReceiptRequest): Omit<ArloUncertainAssertion, 'receipt'> {
    return {
      daemon_id: this.daemonId,
      delivery_id: body.delivery_id,
      target_generation: body.generation,
      ...(body.native_message_id ? { native_message_id: body.native_message_id } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      recorded_at: new Date(this.now()).toISOString(),
    };
  }

  /** Every waiter observes the same already-recorded result. */
  private settleWaiters(msg: MessageRecord): void {
    const status = msg.status === 'in_flight' ? 'unknown' : msg.status;
    for (const waiter of msg.receiptWaiters.splice(0)) {
      waiter(status, msg.reason);
    }
  }

  /**
   * Starts the retention clock once both the result and credit have settled.
   * The 24 hour bound is measured from the moment the record stopped
   * carrying obligations, not from whenever a receipt last happened to touch it.
   */
  private markSettled(msg: MessageRecord): void {
    if (msg.pendingCredit || msg.status === 'in_flight' || msg.status === 'unknown' || msg.conflict) return;
    msg.settledAt ??= this.now();
  }

  /**
   * Credit and receipt state are idempotent separately: releasing an already
   * released reservation changes nothing and never double-frees the budget.
   */
  private releaseRecordCredit(msg: MessageRecord, ep: EndpointRecord): void {
    if (!msg.pendingCredit || msg.conflict) return;
    msg.pendingCredit = false;
    ep.pendingMessagesCount = Math.max(0, ep.pendingMessagesCount - 1);
    ep.pendingBytes = Math.max(0, ep.pendingBytes - msg.textBytes);
    this.globalPendingBytes = Math.max(0, this.globalPendingBytes - msg.textBytes);
    // Releasing the last obligation starts the retention clock.
    this.markSettled(msg);
  }


}
