import crypto from 'node:crypto';
import type {
  PendingInput, ReceptionDispatch, ReceptionEvidence, ReceptionHost,
} from '@arlo/adapter-sdk';
import type { ArloMessageNotificationParams } from '@arlo/sdk';
import type { CustomMessageEntryDraft } from '@earendil-works/pi-coding-agent';

interface OwnedInput {
  pending: PendingInput & { dispatch: ReceptionDispatch };
  draft: CustomMessageEntryDraft;
}

export interface PiInputConsumer {
  /** Checks the native root object and this particular extension attachment. */
  current(): boolean;
  idle(): boolean;
  sendControl(text: string): void;
  unavailable(reason: 'PI_CONTROL_DELIVERY_UNCONFIRMED'): void;
  /** Restore reception only after a retained native control actually arrives. */
  recover?(): Promise<void>;
  changed(pending: number, cancelled: number): void;
}

/** Only the attachment that acquired this handle may consume or stop input. */
export interface PiInputAttachment {
  activate(): void;
  /** Present a late final callback; ordinary callbacks remain synchronous. */
  recoverControl(token: string): Promise<void> | undefined;
  control(token: string): Omit<CustomMessageEntryDraft, 'type'> | undefined;
  deferControl(token: string): boolean;
  beforeSettle(): CustomMessageEntryDraft[];
  settled(aborted: boolean): void;
  operationFinished(): void;
  cancelPending(): void;
  detach(): void;
}

const CONTROL_PREFIX = '[arlo-control:';
const MAX_WAKE_ATTEMPTS = 3;
const WAKE_WAIT_MS = 1000;

/**
 * One live root owns this input source. Consumers are disposable attachments.
 * Business input never enters Pi's native steering or follow-up queues.
 */
export class PiInputSource implements ReceptionHost {
  readonly instanceId = crypto.randomUUID();
  private readonly pending = new Map<string, OwnedInput>();
  private readonly observers = new Set<(evidence: ReceptionEvidence) => void>();
  private consumer?: PiInputConsumer;
  private attachment?: object;
  private accepting = true;
  private consuming = true;
  private closed = false;
  private wake?: { text: string; afterOperation: boolean };
  private recoveryWake?: { text: string; afterOperation: boolean };
  private wakeAttempts = 0;
  private timer?: ReturnType<typeof setTimeout>;

  get pendingCount(): number {
    return this.pending.size;
  }

  attach(consumer: PiInputConsumer, options: { suspended?: boolean } = {}): PiInputAttachment {
    if (this.consumer || this.closed) throw new Error('Arlo input already has an attachment');
    const attachment = this.attachment = {};
    this.consumer = consumer;
    this.accepting = true;
    this.consuming = !options.suspended;
    const current = () => this.attachment === attachment && consumer.current();
    return {
      activate: () => {
        if (!current()) return;
        this.consuming = true;
        this.updateStatus();
        this.schedule();
      },
      recoverControl: token => {
        if (!current() || this.accepting || this.recoveryWake?.text !== token || !consumer.recover) return;
        const wake = this.recoveryWake;
        // Registration can publish ready before its response returns. Admit
        // notifications throughout restoration, just like a suspended reload,
        // but keep all bodies owned here until restoration completes.
        this.accepting = true;
        return consumer.recover().then(() => {
          if (!current() || this.recoveryWake !== wake) return;
          this.recoveryWake = undefined;
          this.accepting = this.consuming = true;
          this.updateStatus();
          this.schedule();
        }, error => {
          if (current() && this.recoveryWake === wake) this.accepting = false;
          throw error;
        });
      },
      control: token => current() ? this.control(token) : undefined,
      deferControl: token => current() && this.deferControl(token),
      beforeSettle: () => current() ? this.beforeSettle() : [],
      settled: aborted => { if (current()) this.settled(aborted); },
      operationFinished: () => { if (current()) this.operationFinished(); },
      cancelPending: () => { if (current()) this.cancelPending(); },
      // Detachment still works after the caller has invalidated its identity.
      detach: () => { if (this.attachment === attachment) this.detach(); },
    };
  }

  prepare(frame: ArloMessageNotificationParams) {
    const consumer = this.consumer;
    const attachment = this.attachment;
    const nativeMessageId = crypto.randomUUID();
    const dispatch: ReceptionDispatch = {
      daemon_id: frame.daemon_id,
      endpoint_id: frame.to_endpoint,
      message_id: frame.message_id,
      delivery_id: frame.delivery_id,
      generation: frame.target_generation,
    };
    const input: OwnedInput = {
      pending: { nativeMessageId, messageId: frame.message_id, textBytes: Buffer.byteLength(frame.text, 'utf8'), dispatch },
      draft: {
        type: 'custom_message', customType: 'arlo-message', display: true,
        content: [
          { type: 'text', text: frame.text },
          { type: 'text', text: JSON.stringify({ arlo: {
            message_id: frame.message_id, from_endpoint: frame.from_endpoint,
            ...(frame.reply_to === undefined ? {} : { reply_to: frame.reply_to, reply_depth: frame.reply_depth }),
          } }) },
        ],
        details: { message_id: frame.message_id, from_endpoint: frame.from_endpoint, reply_to: frame.reply_to },
      },
    };
    let outcome: 'enqueued' | 'not_enqueued' | undefined;
    return {
      nativeMessageId,
      enqueue: (): 'enqueued' | 'not_enqueued' => {
        if (outcome) return outcome;
        if (!this.accepting || this.attachment !== attachment || !consumer?.current()) return outcome = 'not_enqueued';
        this.pending.set(nativeMessageId, input);
        outcome = 'enqueued';
        this.emit(input, 'enqueued');
        // Reception evidence is complete before any callback can schedule Pi.
        queueMicrotask(() => {
          if (this.attachment !== attachment) return;
          this.updateStatus(); this.schedule();
        });
        return 'enqueued';
      },
    };
  }

  snapshot(scope: { instanceId: string; generation: number }) {
    return {
      instanceId: this.instanceId, generation: scope.generation, complete: true,
      pending: [...this.pending.values()].map(input => ({ ...input.pending, dispatch: { ...input.pending.dispatch } })),
      // Direct provider drafts are permanently handed off. They never return
      // to pending; there is no second queue or reversible transfer to count.
      inFlight: [],
    };
  }

  observe(listener: (evidence: ReceptionEvidence) => void): () => void {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }

  /** The native command callback immediately hands a returned message to Pi. */
  control(token: string): Omit<CustomMessageEntryDraft, 'type'> | undefined {
    if (!this.live() || this.wake?.text !== token || !this.consumer!.idle()) return;
    if (this.pending.size === 0) {
      this.invalidateWake();
      return;
    }
    const drafts = this.claim();
    // Pi's direct custom-message handoff accepts one message. Preserve every
    // source descriptor when several pending inputs share the provider call.
    return {
      customType: 'arlo-message', display: true,
      content: drafts.flatMap(draft => typeof draft.content === 'string'
        ? [{ type: 'text' as const, text: draft.content }] : draft.content),
      details: { messages: drafts.map(draft => draft.details) },
    };
  }

  /** The command arrived; waiting for native completion is not lost delivery. */
  deferControl(token: string): boolean {
    if (!this.live() || this.wake?.text !== token) return false;
    clearTimeout(this.timer);
    this.timer = undefined;
    return true;
  }

  beforeSettle(): CustomMessageEntryDraft[] {
    return this.live() ? this.claim() : [];
  }

  settled(aborted: boolean): void {
    if (!this.live()) return;
    if (aborted) {
      this.cancelPending();
      return;
    }
    this.schedule();
  }

  /** Pi reports compaction before releasing its slot, without agent_settled. */
  operationFinished(): void {
    this.schedule(true);
  }

  /** Called at a proven user-cancellation boundary, never on mere teardown. */
  cancelPending(): void {
    if (!this.consumer?.current()) return;
    this.updateStatus(this.drain('discarded').length);
  }

  /** Stop all new work while retaining the living root's queue and evidence. */
  detach(): void {
    this.accepting = false;
    this.consuming = false;
    this.invalidateWake();
    this.recoveryWake = undefined;
    this.consumer = undefined;
    this.attachment = undefined;
  }

  /** Final root teardown, while observers still hold the original authority. */
  close(): void {
    this.closed = true;
    this.detach();
    this.drain('discarded');
  }

  private live(): boolean {
    return this.accepting && this.consuming && this.consumer?.current() === true;
  }

  private emit(input: OwnedInput, event: ReceptionEvidence['event']): void {
    for (const observer of this.observers) {
      try {
        observer({ instanceId: this.instanceId, nativeMessageId: input.pending.nativeMessageId,
          dispatch: { ...input.pending.dispatch }, event });
      } catch { /* Observation failure cannot undo an input transition. */ }
    }
  }

  private updateStatus(cancelled = 0): void {
    if (!this.live() && !(cancelled > 0 && this.consumer?.current())) return;
    try { this.consumer!.changed(this.pending.size, cancelled); } catch {}
  }

  private drain(event: 'claimed' | 'discarded'): OwnedInput[] {
    this.invalidateWake();
    const inputs = [...this.pending.values()];
    this.pending.clear();
    for (const input of inputs) this.emit(input, event);
    return inputs;
  }

  private claim(): CustomMessageEntryDraft[] {
    const inputs = this.drain('claimed');
    this.updateStatus();
    return inputs.map(input => input.draft);
  }

  private invalidateWake(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.wake = undefined;
    this.wakeAttempts = 0;
  }

  private schedule(afterOperation = false): void {
    if (!this.live()) return;
    if (this.wake) {
      this.wake.afterOperation ||= afterOperation;
      return;
    }
    if (this.timer) return;
    // Busy arrivals remain owned here. Pi defers settlement controls through
    // later settled handlers. Timeout stops delivery attempts; only an actual
    // late callback may restore the suspended attachment.
    // A completion control also covers arrivals in later compaction handlers;
    // it waits for Pi's actual idle boundary even if nothing is pending yet.
    if (!afterOperation && (this.pending.size === 0 || !this.consumer!.idle())) return;
    this.wakeAttempts++;
    const wake = { text: `${CONTROL_PREFIX}${crypto.randomUUID()}]`, afterOperation };
    this.wake = wake;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.live() || this.wake !== wake) return;
      if (this.wakeAttempts >= MAX_WAKE_ATTEMPTS) {
        // Delivery attempts end here. The final body-free callback has a
        // separate lifetime, fenced by this attachment. Cancellation revokes
        // its claim token but still permits body-free reception recovery.
        this.accepting = this.consuming = false;
        this.recoveryWake = wake;
        this.consumer!.unavailable('PI_CONTROL_DELIVERY_UNCONFIRMED');
        return;
      }
      // Stale command tokens are handled without entering Pi's prompt
      // preflight. Retrying the control never retransmits a business body.
      this.wake = undefined;
      this.schedule(wake.afterOperation);
    }, WAKE_WAIT_MS);
    this.timer.unref?.();
    try { this.consumer!.sendControl(wake.text); }
    catch { /* Only this body-free control action may be retried. */ }
  }
}
