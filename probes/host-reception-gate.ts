import type { Client } from '@modelcontextprotocol/client';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { TransportDeduplicator, type ReceiptResult } from './reception.ts';
import {
  ARLO_PROFILE,
  ARLO_PROFILE_VERSION,
  ARLO_PINNED_WIRE_REVISION,
  attachArloNotificationHandler,
  type ArloMessageNotificationParams,
} from './mcp-notification.ts';
import { ArloProtocolErrorCode } from './mcp-metadata.ts';

export { ARLO_PINNED_WIRE_REVISION } from './mcp-notification.ts';

export interface ActiveReceptionGateOptions {
  daemonId: string;
  groupId: string;
  endpointId: string;
  generation: number;
  credentialToken: string;
  sessionId: string;
  client: Client;
  agent: Agent;
  maxPending?: number;
  onMessageReceived?: (params: ArloMessageNotificationParams) => void | Promise<void>;
  onReceipt?: (params: ArloMessageNotificationParams, result: ReceiptResult) => void;
  deduplicator?: TransportDeduplicator;
}

export class ActiveReceptionGate {
  private daemonId: string;
  private groupId: string;
  private deduplicator: TransportDeduplicator;
  private ownsDeduplicator: boolean;
  private onReceipt?: ActiveReceptionGateOptions['onReceipt'];
  readonly endpointId: string;
  private activeGeneration: number;
  private credentialToken: string;
  private sessionId: string;
  private client: Client;
  private agent: Agent;
  private maxPending: number;
  private onMessageReceived?: (params: ArloMessageNotificationParams) => void | Promise<void>;

  private step1Handshake = false;
  private step2HandlerInstalled = false;
  private step3BindingConfirmed = false;
  private step4CapacityReady = false;
  private disconnected = false;
  private unsubscribe: (() => void) | null = null;

  constructor(options: ActiveReceptionGateOptions) {
    this.daemonId = options.daemonId;
    this.groupId = options.groupId;
    this.ownsDeduplicator = options.deduplicator === undefined;
    this.deduplicator = options.deduplicator ?? new TransportDeduplicator({
      agent: options.agent, currentGeneration: options.generation, initialCapacity: options.maxPending,
    });
    this.onReceipt = options.onReceipt;
    this.endpointId = options.endpointId;
    this.activeGeneration = options.generation;
    this.credentialToken = options.credentialToken;
    this.sessionId = options.sessionId;
    this.client = options.client;
    this.agent = options.agent;
    this.maxPending = options.maxPending ?? 64;
    this.onMessageReceived = options.onMessageReceived;
  }

  get generation(): number {
    return this.activeGeneration;
  }

  async verifyProtocolHandshake(): Promise<{ ok: boolean; wireRevision?: string }> {
    if (this.disconnected) {
      throw new Error(`${ArloProtocolErrorCode.CHANNEL_NOT_READY}: gate is disconnected`);
    }

    // 1. Era check: Modern era revisions do not support unsolicited notifications
    const era = this.client.getProtocolEra?.();
    if (era === 'modern') {
      throw new Error(
        `${ArloProtocolErrorCode.UNSUPPORTED_VERSION}: negotiated modern-era protocol revision which does not support unsolicited custom notifications`
      );
    }

    // 2. Profile capability check
    const serverCaps = this.client.getServerCapabilities();
    const profile = serverCaps?.experimental?.[ARLO_PROFILE];
    if (!profile) {
      throw new Error(
        `${ArloProtocolErrorCode.UNSUPPORTED_PROFILE}: server does not declare capability ${ARLO_PROFILE}`
      );
    }
    if (profile.version !== ARLO_PROFILE_VERSION) {
      throw new Error(
        `${ArloProtocolErrorCode.UNSUPPORTED_VERSION}: profile version mismatch; expected ${ARLO_PROFILE_VERSION}, got ${profile.version}`
      );
    }

    const wireRevision = this.client.getNegotiatedProtocolVersion?.();
    if (era !== 'legacy' || wireRevision !== ARLO_PINNED_WIRE_REVISION) {
      throw new Error(`${ArloProtocolErrorCode.UNSUPPORTED_VERSION}: unsupported wire revision`);
    }
    this.step1Handshake = true;
    return { ok: true, wireRevision };
  }

  installNotificationHandler(): { ok: boolean } {
    if (this.disconnected) {
      throw new Error(`${ArloProtocolErrorCode.CHANNEL_NOT_READY}: gate is disconnected`);
    }

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    this.unsubscribe = attachArloNotificationHandler(this.client, async (params) => {
      // Disconnected or stale generation callbacks must NOT enter host
      if (this.disconnected) return;
      if (params.target_generation !== this.activeGeneration) return;
      if (params.to_endpoint !== this.endpointId || params.daemon_id !== this.daemonId || params.group_id !== this.groupId) return;
      if (!this.isActiveReceptionReady()) return;

      // Deliver to host inbox via followup
      const result = await this.deduplicator.receiveFrame(params);
      this.onReceipt?.(params, result);

      if (result.status === 'enqueued' && this.onMessageReceived) {
        await this.onMessageReceived(params);
      }
    });

    this.step2HandlerInstalled = true;
    return { ok: true };
  }

  confirmBinding(binding: {
    endpointId: string;
    generation: number;
    credentialToken: string;
    sessionId: string;
  }): { ok: boolean } {
    if (this.disconnected) {
      throw new Error(`${ArloProtocolErrorCode.CHANNEL_NOT_READY}: gate is disconnected`);
    }

    if (
      binding.endpointId !== this.endpointId ||
      binding.generation !== this.activeGeneration ||
      binding.credentialToken !== this.credentialToken ||
      binding.sessionId !== this.sessionId
    ) {
      throw new Error(`${ArloProtocolErrorCode.BINDING_MISMATCH}: binding credentials do not match active root session`);
    }

    this.step3BindingConfirmed = true;
    return { ok: true };
  }

  verifyCapacityReadiness(): { ok: boolean; reason?: string } {
    if (this.disconnected) {
      throw new Error(`${ArloProtocolErrorCode.CHANNEL_NOT_READY}: gate is disconnected`);
    }

    const currentPending = this.agent.inbox.nextTurn.length + this.agent.inbox.nextStep.length;
    if (currentPending >= this.maxPending) {
      this.step4CapacityReady = false;
      return { ok: false, reason: ArloProtocolErrorCode.QUEUE_LIMIT };
    }

    this.step4CapacityReady = true;
    return { ok: true };
  }

  isActiveReceptionReady(): boolean {
    return (
      !this.disconnected &&
      this.step1Handshake &&
      this.step2HandlerInstalled &&
      this.step3BindingConfirmed &&
      this.step4CapacityReady &&
      this.deduplicator.getAvailableCapacity() > 0
    );
  }

  disconnect(): void {
    this.disconnected = true;
    this.step1Handshake = false;
    this.step2HandlerInstalled = false;
    this.step3BindingConfirmed = false;
    this.step4CapacityReady = false;
    if (this.ownsDeduplicator) this.deduplicator.dispose();

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  advanceGeneration(newGen: number, newToken: string, newSessionId: string): void {
    this.deduplicator.advanceGeneration(newGen);
    this.activeGeneration = newGen;
    this.credentialToken = newToken;
    this.sessionId = newSessionId;

    // Reset readiness: requires re-installation and re-confirmation
    this.step2HandlerInstalled = false;
    this.step3BindingConfirmed = false;
    this.step4CapacityReady = false;

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
