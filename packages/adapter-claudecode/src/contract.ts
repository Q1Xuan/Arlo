import crypto from 'node:crypto';
import type { ArloErrorCode } from '@arlo/sdk';

export const BRIDGE_CONTRACT_VERSION = '2.0.0';

export const CLAUDE_CODE_VERSION = '2.1.296';

export const PROMPT_SUBMIT_TIMEOUT_MS = 10_000;

/**
 * A submitted prompt carries its own correlation marker. The host wraps
 * plugin-origin text, so claim evidence is the marker's presence in the turn
 * input, never a verbatim comparison of the whole prompt.
 *
 * The Sidecar owns this format: it mints the identifier, formats the marker and
 * verifies a reported marker against its own record. The Mod never formats one;
 * it embeds the marker the bridge handed it and looks for that same string, so
 * the format lives in exactly one file.
 */
export const CORRELATION_MARKER_PREFIX = '[arlo-correlation:';

export const CORRELATION_MARKER_SUFFIX = ']';

/** Unclaimed handoffs cannot be proven after this window and end unknown. */
export const CLAIM_EVIDENCE_TIMEOUT_MS = 30_000;

/** Generates one unforgeable per-message correlation identifier. */
export function generateCorrelationId(): string {
  return crypto.randomUUID();
}

export function correlationMarker(correlationId: string): string {
  return `${CORRELATION_MARKER_PREFIX}${correlationId}${CORRELATION_MARKER_SUFFIX}`;
}

export const BRIDGE_ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  SESSION_MISMATCH: 'SESSION_MISMATCH',
  STALE_BINDING: 'STALE_BINDING',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[keyof typeof BRIDGE_ERROR_CODES];

export class BridgeRequestError extends Error {
  readonly statusCode: number;
  readonly code: BridgeErrorCode;

  constructor(statusCode: number, code: BridgeErrorCode, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface BridgeErrorResponse {
  error: {
    code: BridgeErrorCode | ArloErrorCode;
    message: string;
    details?: unknown;
  };
}

export interface BridgeIdentity {
  sessionId: string;
  instanceId: string;
  generation: number;
}

export interface BridgeStatusResponse extends BridgeIdentity {
  status: 'active' | 'draining' | 'stopped';
  version: string;
  contractVersion: string;
}

export interface BridgeHandshakeRequest {
  modVersion: string;
  capabilities: string[];
}

export interface BridgeHandshakeResponse extends BridgeIdentity {
  accepted: boolean;
  contractVersion: string;
}

export interface BridgeActivateRequest {
  /** Identity verified by the host after the previous context finished. */
  sessionId: string;
}

export interface BridgeRetireResponse extends BridgeIdentity {
  status: 'draining';
  contractVersion: string;
}

export interface BridgeMessageItem {
  nativeMessageId: string;
  messageId: string;
  text: string;
  /**
   * This message's own marker, embedded in the submitted prompt and reported
   * back as claim evidence. Always present from this Sidecar.
   */
  correlationMarker?: string;
  fromEndpoint?: string;
  enqueuedAt: string;
}

export interface BridgePendingMessagesResponse {
  messages: BridgeMessageItem[];
}

export interface BridgeSettleRequest {
  nativeMessageId: string;
  messageId?: string;
  status: 'enqueued' | 'dispatching' | 'submitting' | 'discarded' | 'unknown';
  timestamp: number;
  reason?: string;
}

export interface BridgeSettleResponse {
  settled: boolean;
  idempotencyKey?: string;
  nativeMessageId: string;
  status: string;
}

/**
 * Claim evidence: the host turn input that ingested this message carried its
 * correlation marker. The Sidecar verifies the marker against its own record.
 */
export interface BridgeClaimRequest {
  nativeMessageId: string;
  messageId?: string;
  /** The marker the Mod observed in the host turn input. */
  correlationMarker: string;
  timestamp: number;
  /** The observed host turn whose input carried the marker. */
  turnId?: string;
}

export interface BridgeClaimResponse {
  claimed: boolean;
  idempotencyKey?: string;
  nativeMessageId: string;
  status: 'claimed';
}

export interface BridgeToolCallRequest {
  name: 'arlo_list_sessions' | 'arlo_send_message' | 'arlo_get_message_status';
  arguments: unknown;
}

export interface BridgeToolCallResponse {
  content: Array<{ type: 'text'; text: string }>;
}

export interface BridgeCommandRequest {
  name: 'arlo-authorize' | 'arlo-send-status' | 'arlo-continue' | 'arlo-reload-sending-rules' | 'arlo-settings' | 'arlo-root-config';
  arguments: string;
  /** Trusted Mod action identity, outside the slash-command argument string. */
  operationId?: string;
}

export interface BridgeCommandResponse {
  text: string;
}

export interface BridgeContractConfig {
  sessionId: string;
  token: string;
  port?: number;
  host?: string;
  onHandshake?: () => void;
  onRetire?: () => void;
  onActivate?: (sessionId: string) => Promise<BridgeContractConfig['receptionHost']>;
  onToolCall?: (request: BridgeToolCallRequest, identity: BridgeIdentity) => Promise<BridgeToolCallResponse['content']>;
  onCommand?: (request: BridgeCommandRequest, identity: BridgeIdentity) => Promise<BridgeCommandResponse>;
  receptionHost?: {
    retire?(): void;
    replaceDispatcher?(): void;
    getPendingMessages(): Array<{
      nativeMessageId: string;
      messageId: string;
      text: string;
      /** The stored correlation identifier; the bridge formats its marker. */
      correlationId?: string;
      fromEndpoint?: string;
      dispatch?: { endpoint_id?: string; daemon_id?: string };
      enqueuedAt: string;
    }>;
    beginDispatch?(nativeMessageId: string, messageId?: string): void;
    cancelDispatch?(nativeMessageId: string, messageId?: string): void;
    recordHandoff?(nativeMessageId: string, messageId?: string): void;
    recordNotEntered?(nativeMessageId: string, messageId?: string): void;
    recordUnresolved?(nativeMessageId: string, messageId?: string): void;
    claim?(nativeMessageId: string, messageId: string | undefined, correlationMarker: string): void;
  };
}

/**
 * Generates an ephemeral 256-bit high-entropy secret bearer token.
 */
export function generateBridgeToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
