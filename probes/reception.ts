import type { Agent } from '@deepseek-ai/dsh-agent';
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm';
import { arloMessage } from './message.ts';
import { ArloProtocolErrorCode } from './mcp-metadata.ts';
import type { ArloMessageNotificationParams } from './mcp-notification.ts';

export type ArloDeliveryFrame = ArloMessageNotificationParams;

export interface ReceiptResult {
  status: 'enqueued' | 'duplicate' | 'rejected' | 'unknown' | 'stale_sequence';
  reason?: string;
}

export interface AckResult {
  status: 'acknowledged';
  duplicate: boolean;
  quotaReleased: boolean;
  retryCount: number;
}

export interface TransportDeduplicatorOptions {
  agent: Agent;
  windowSize?: number;
  currentGeneration: number;
  initialCapacity?: number;
}

export class TransportDeduplicator {
  private agent: Agent;
  private windowSize: bigint;
  private currentGeneration: number;
  private capacity: number;
  private pendingCredit = new Set<MessageId>();
  private stopObserving: Array<() => void>;

  private inFlightMessageIds = new Set<string>();
  private processedMessageIds = new Map<string, ReceiptResult>();
  private seenSequences = new Set<string>();
  private highestSeq = 0n;
  private ackReceipts = new Map<string, number>(); // delivery_id -> ack count

  constructor(options: TransportDeduplicatorOptions) {
    this.agent = options.agent;
    this.windowSize = BigInt(options.windowSize ?? 1024);
    this.currentGeneration = options.currentGeneration;
    this.capacity = options.initialCapacity ?? 64;
    this.observePendingSnapshot();
    const release = ({ agent, message }: { agent: Agent; message: UserMessage }) => {
      if (agent === this.agent) this.pendingCredit.delete(message.id);
    };
    this.stopObserving = [
      this.agent.ctx.on('agent/inbox/claimed', release),
      this.agent.ctx.on('agent/inbox/discarded', release),
    ];
  }

  private observePendingSnapshot(): void {
    for (const message of [...this.agent.inbox.nextTurn, ...this.agent.inbox.nextStep]) {
      if (message.source.kind === 'arlo') this.pendingCredit.add(message.id);
    }
  }

  dispose(): void {
    for (const stop of this.stopObserving.splice(0)) stop();
  }

  get generation(): number {
    return this.currentGeneration;
  }

  getAvailableCapacity(): number {
    this.observePendingSnapshot();
    return Math.max(0, this.capacity - this.pendingCredit.size);
  }

  getInFlightCount(): number {
    this.observePendingSnapshot();
    return this.pendingCredit.size;
  }

  getSeenSequencesCount(): number {
    return this.seenSequences.size;
  }

  advanceGeneration(newGen: number): void {
    this.currentGeneration = newGen;
    this.seenSequences.clear();
    this.highestSeq = 0n;
    this.inFlightMessageIds.clear();
    // A new connection does not consume pending input in the same host.
    this.observePendingSnapshot();
  }

  private pruneOldSequences(): void {
    const minValid = this.highestSeq > this.windowSize ? this.highestSeq - this.windowSize + 1n : 1n;
    for (const s of this.seenSequences) {
      if (BigInt(s) < minValid) {
        this.seenSequences.delete(s);
      }
    }
  }

  async receiveFrame(frame: ArloDeliveryFrame): Promise<ReceiptResult> {
    // 1. Generation check: callbacks or frames from stale generations must be rejected
    if (frame.target_generation !== this.currentGeneration) {
      return {
        status: 'rejected',
        reason: ArloProtocolErrorCode.STALE_GENERATION,
      };
    }

    const seq = BigInt(frame.delivery_seq);

    // 2. Duplicate check by message ID or sequence
    if (this.processedMessageIds.has(frame.message_id)) {
      return { status: 'duplicate' };
    }
    if (this.seenSequences.has(frame.delivery_seq)) {
      return { status: 'duplicate', reason: ArloProtocolErrorCode.REPLAY_RESULT_UNAVAILABLE };
    }

    // 3. Sliding window check: exact lower bound [highestSeq - windowSize + 1, highestSeq + lookahead]
    const minValidSeq = this.highestSeq > this.windowSize ? this.highestSeq - this.windowSize + 1n : 1n;
    if (this.highestSeq > this.windowSize && seq < minValidSeq) {
      return {
        status: 'stale_sequence',
        reason: ArloProtocolErrorCode.STALE_SEQUENCE,
      };
    }

    // 4. Concurrent duplicate prevention (atomic lock in memory tick)
    if (this.inFlightMessageIds.has(frame.message_id)) {
      return { status: 'duplicate' };
    }
    if (this.getAvailableCapacity() === 0) {
      return { status: 'rejected', reason: ArloProtocolErrorCode.QUEUE_LIMIT };
    }
    this.inFlightMessageIds.add(frame.message_id);

    // CRITICAL: Pre-record sequence before host dispatch.
    // If the host accepts/inserts the message into inbox but throws an error afterwards,
    // the sequence and message ID are already locked so any retry cannot re-insert!
    this.seenSequences.add(frame.delivery_seq);
    if (seq > this.highestSeq) {
      this.highestSeq = seq;
      this.pruneOldSequences();
    }

    try {
      // 5. Host dispatch: followup call enters host inbox
      const msg = arloMessage(frame.text);
      this.pendingCredit.add(msg.id);
      this.agent.followup(msg);

      const result: ReceiptResult = { status: 'enqueued' };
      this.processedMessageIds.set(frame.message_id, result);
      return result;
    } catch (err: any) {
      // Host threw after/during insertion: record as unknown so retries cannot re-insert
      const unknownResult: ReceiptResult = {
        status: 'unknown',
        reason: err?.message || 'POST_INSERTION_ERROR',
      };
      this.processedMessageIds.set(frame.message_id, unknownResult);
      return unknownResult;
    } finally {
      this.inFlightMessageIds.delete(frame.message_id);
    }
  }

  evictResult(messageId: string): void {
    this.processedMessageIds.delete(messageId);
  }

  submitAck(deliveryId: string): AckResult {
    const current = this.ackReceipts.get(deliveryId) ?? 0;
    this.ackReceipts.set(deliveryId, current + 1);

    if (current > 0) {
      // Idempotent duplicate ACK: does not release quota again!
      return {
        status: 'acknowledged',
        duplicate: true,
        quotaReleased: false,
        retryCount: current + 1,
      };
    }

    // Acceptance and consumption are separate. Only host observations release credit.
    return {
      status: 'acknowledged',
      duplicate: false,
      quotaReleased: false,
      retryCount: 1,
    };
  }

  isSequenceSeen(seq: string): boolean {
    return this.seenSequences.has(seq);
  }
}
