import { encodeCommunicationGroup } from '../groups/encoding.ts';

export const ArloErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  PINNED_CERT_MISMATCH: 'PINNED_CERT_MISMATCH',
  CHANNEL_NOT_READY: 'CHANNEL_NOT_READY',
  TARGET_UNAVAILABLE: 'TARGET_UNAVAILABLE',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  CORRUPTED_STATE: 'CORRUPTED_STATE',
  UNSAFE_LOCATION: 'UNSAFE_LOCATION',
  INVALID_OWNERSHIP: 'INVALID_OWNERSHIP',
  INSECURE_PERMISSIONS: 'INSECURE_PERMISSIONS',
  REDIRECT_FORBIDDEN: 'REDIRECT_FORBIDDEN',
  EXTERNAL_NETWORK_FORBIDDEN: 'EXTERNAL_NETWORK_FORBIDDEN',
  DAEMON_NOT_RUNNING: 'DAEMON_NOT_RUNNING',
  DAEMON_ALREADY_RUNNING: 'DAEMON_ALREADY_RUNNING',
  LOCK_ACQUISITION_FAILED: 'LOCK_ACQUISITION_FAILED',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  CALLER_NOT_ROOT: 'CALLER_NOT_ROOT',
  BINDING_MISMATCH: 'BINDING_MISMATCH',
  STALE_GENERATION: 'STALE_GENERATION',
  QUEUE_LIMIT: 'QUEUE_LIMIT',
  RATE_LIMITED: 'RATE_LIMITED',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  UNSUPPORTED_PROFILE: 'UNSUPPORTED_PROFILE',
  GROUP_MISMATCH: 'GROUP_MISMATCH',
  CROSS_HOST_DISABLED: 'CROSS_HOST_DISABLED',
  GROUP_CONTEXT_REQUIRED: 'GROUP_CONTEXT_REQUIRED',
  GROUP_DIRECTORY_UNAVAILABLE: 'GROUP_DIRECTORY_UNAVAILABLE',
  GIT_RESOLUTION_FAILED: 'GIT_RESOLUTION_FAILED',
  GIT_METADATA_INVALID: 'GIT_METADATA_INVALID',
  MESSAGE_TOO_LARGE: 'MESSAGE_TOO_LARGE',
  MESSAGE_ID_CONFLICT: 'MESSAGE_ID_CONFLICT',
  RECEIPT_CONFLICT: 'RECEIPT_CONFLICT',
  ACCOUNTING_UNAVAILABLE: 'ACCOUNTING_UNAVAILABLE',
  RESULT_UNAVAILABLE: 'RESULT_UNAVAILABLE',
  ACK_TIMEOUT: 'ACK_TIMEOUT',
  CONNECTION_LOST: 'CONNECTION_LOST',
  ENQUEUE_UNCERTAIN: 'ENQUEUE_UNCERTAIN',
  STALE_SEQUENCE: 'STALE_SEQUENCE',
  REPLAY_RESULT_UNAVAILABLE: 'REPLAY_RESULT_UNAVAILABLE',
  SEQUENCE_EXHAUSTED: 'SEQUENCE_EXHAUSTED',
  INVALID_REPLY: 'INVALID_REPLY',
  REPLY_DEPTH_LIMIT: 'REPLY_DEPTH_LIMIT',
  ALLOWANCE_EXHAUSTED: 'ALLOWANCE_EXHAUSTED',
  ALLOWANCE_UNKNOWN: 'ALLOWANCE_UNKNOWN',
  CONTROL_REQUEST_CONFLICT: 'CONTROL_REQUEST_CONFLICT',
  STALE_CONTROL_REQUEST: 'STALE_CONTROL_REQUEST',
  CONTROL_HISTORY_UNAVAILABLE: 'CONTROL_HISTORY_UNAVAILABLE',
  SENDING_RULES_INVALID: 'SENDING_RULES_INVALID',
} as const;

export type ArloErrorCode = (typeof ArloErrorCode)[keyof typeof ArloErrorCode];

export const ARLO_PINNED_WIRE_REVISION = '2025-06-18' as const;
export const ARLO_PROFILE = 'arlo/session-messaging' as const;
export const ARLO_PROFILE_VERSION = '0.1' as const;
export const ARLO_CROSS_HOST_CAPABILITY = 'arlo/cross-host-participation' as const;
export const ARLO_CROSS_HOST_CAPABILITY_VERSION = '0.2' as const;
export const ARLO_NOTIFICATION_METHOD = 'notifications/arlo/message' as const;
export const ARLO_MESSAGE_ID_META_KEY = 'arlo/message-id' as const;

export const MAX_SINGLE_TEXT_BYTES = 32 * 1024;
export const MAX_ROOT_PENDING_MESSAGES = 64;
export const MAX_ROOT_PENDING_BYTES = 1024 * 1024;
export const MAX_INSTANCE_PENDING_BYTES = 8 * 1024 * 1024;
export const MAX_CONCURRENT_IN_FLIGHT_ACKS = 64;
export const MAX_TRACKED_MESSAGES = 10000;
export const DEFAULT_ACK_TIMEOUT_MS = 10000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
export const DEFAULT_LEASE_DURATION_MS = 20000;
/**
 * Deadline for the status query tool call. It must exceed the reception
 * acknowledgement wait, because a query can be queued behind a dispatch that is
 * still waiting for its receipt. A deadline shorter than that wait turns a
 * successful query into a transport failure and hides late evidence.
 */
export const MESSAGE_STATUS_QUERY_TIMEOUT_MS = DEFAULT_ACK_TIMEOUT_MS + 5000;
export const MAX_WINDOW_SIZE = 1024;
// Bounded retention for settled message records. A record that still holds
// credit or an unresolved receipt is an active ledger entry and is never
// evicted by this policy.
export const MESSAGE_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

// A delivery sequence is a uint64 that never wraps. A target connection
// generation must be replaced before the counter is exhausted; while it cannot
// be replaced, new dispatch stops instead of reusing or wrapping sequence numbers.
export const MAX_DELIVERY_SEQ = 2n ** 64n - 1n;

// Settled receipts are ordinary cache: bounded per root and time-limited.
// Records that still track an undecided outcome or pending credit are activity
// records and never expire as ordinary cache.
export const SETTLED_RECEIPT_CACHE_LIMIT = 1024;
export const SETTLED_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

// Per-root admission pacing. A sending root sustains 12 messages per minute
// with an immediate burst of 4; a receiving root sustains 30 per minute with
// a burst of 8 shared by every sender converging on it. Pacing complements
// the count, byte and tracking budgets; it never replaces them.
export const DEFAULT_SEND_RATE_PER_MINUTE = 12;
export const DEFAULT_SEND_BURST = 4;
export const DEFAULT_RECEIVE_RATE_PER_MINUTE = 30;
export const DEFAULT_RECEIVE_BURST = 8;

export interface RootRateLimit {
  /** Sustained admissions per minute; a positive safe integer. */
  perMinute: number;
  /** Positive integer burst, at most floor(Number.MAX_SAFE_INTEGER / 60_000). */
  burst: number;
}

export interface RateLimitOptions {
  /** Pacing for every root acting as a sender. Defaults to the send constants. */
  sender?: RootRateLimit;
  /** Pacing for every root acting as a receiver. Defaults to the receive constants. */
  receiver?: RootRateLimit;
}

// Maximum reply chain depth. The daemon computes each reply's depth from its
// own known association; the model can neither supply nor forge it. A message
// that is not a reply sits at depth 0, and a reply to a depth-8 message is
// rejected with REPLY_DEPTH_LIMIT instead of creating depth 9.
export const MAX_REPLY_DEPTH = 8;

export interface ReceiptRetentionOptions {
  /** Maximum settled receipts kept for one root. Default 1,024. */
  limit?: number;
  /** How long a settled receipt is kept before ordinary eviction. Default 24 hours. */
  ttlMs?: number;
}

export const FORBIDDEN_MODEL_ARGUMENT_KEYS = [
  'from',
  'group',
  'group_id',
  'sender',
  'credentials',
  'registration',
  'ack',
  '_meta',
  'daemon_id',
  'target_generation',
] as const;

export class ArloError extends Error {
  readonly code: ArloErrorCode;

  constructor(code: ArloErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ArloError';
    this.code = code;
  }
}

export function validateExplicitGroupName(rawName: unknown): { groupId: string; groupName: string } {
  if (typeof rawName !== 'string') {
    throw new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Group name must be a string');
  }
  // Check before trimming: trim() would otherwise hide leading/trailing tabs,
  // line breaks and other forbidden whitespace in the original configuration.
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(rawName)) {
    throw new ArloError(
      ArloErrorCode.INVALID_ARGUMENT,
      'Group name must not contain control characters or newlines'
    );
  }
  const nfc = rawName.normalize('NFC');
  const trimmed = nfc.trim();
  if (trimmed.length === 0) {
    throw new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Group name must not be empty');
  }
  const codePointLength = [...trimmed].length;
  if (codePointLength < 1 || codePointLength > 64) {
    throw new ArloError(
      ArloErrorCode.INVALID_ARGUMENT,
      `Group name length must be between 1 and 64 Unicode characters (got ${codePointLength})`
    );
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new ArloError(
      ArloErrorCode.INVALID_ARGUMENT,
      'Group name must not be a path or contain path separators'
    );
  }
  const groupId = encodeCommunicationGroup('exp', trimmed);
  return { groupId, groupName: trimmed };
}

export interface DaemonDiscoveryRecord {
  daemon_id: string;
  pid: number;
  port: number;
  cert_fingerprint: string;
  cert_pem: string;
  protocol_version: string;
  status: 'ready' | 'shutting_down';
  started_at: string;
}

export interface DaemonStatusResponse {
  daemon_id: string;
  pid: number;
  port: number;
  status: 'ready' | 'shutting_down';
  uptime_ms: number;
  protocol_version: string;
  listener: 'loopback';
  active_endpoints_count?: number;
  revoked_endpoints_count?: number;
}

export interface DiagnosticCheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail?: string;
  error_code?: ArloErrorCode;
}

export interface DiagnosticReport {
  daemon_id?: string;
  runtime?: { executable: string; node: string; platform: string; arch: string; pid: number };
  overall_status: 'healthy' | 'degraded' | 'failing';
  checks: DiagnosticCheckResult[];
  timestamp: string;
}

export interface RuntimeRegistrationRequest {
  runtime_id?: string;
  /** Process-local random proof, retained only for this live runtime. */
  continuity_token?: string;
  host_type?: string;
  host_version?: string;
  /** Stable adapter identity, independent of configurable presentation metadata. */
  host_kind?: string;
  /** Cross-host communication requires both runtimes to opt in. Defaults to false. */
  cross_host_enabled?: boolean;
  /** Opaque hash of this adapter's shared plugin configuration location. */
  participation_scope?: string;
}

export interface RuntimeRegistrationResponse {
  runtime_id: string;
  runtime_token: string;
}

export interface RuntimeParticipationState {
  cross_host_enabled: boolean;
  /** Opaque compare-and-swap revision for the trusted host configuration. */
  revision: string;
}

export interface RuntimeReauthenticationRequest {
  runtime_id: string;
  continuity_token: string;
}

/** Host kinds are adapter-owned identifiers, not user-visible aliases. */
export function validateHostKind(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value)) {
    throw new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Host kind must be a canonical adapter identifier');
  }
  return value;
}

export interface RootRegistrationRequest {
  root_session_id: string;
  display_name?: string;
  /** Trusted explicit configuration, mutually exclusive with project_group_id. */
  group_name?: string;
  /** Resolved by the trusted SDK/Adapter; paths never enter the wire request. */
  project_group_id?: string;
  agent_incarnation: string;
  plugin_generation: number;
  /** Random proof retained with this exact live Agent binding. */
  continuity_token?: string;
}

export interface RootRegistrationResponse {
  endpoint_id: string;
  generation: number;
  root_token: string;
  group_id: string;
  status: 'registered';
  ready: boolean;
  deliverable: boolean;
}

export interface ConnectRootRequest {
  endpoint_id: string;
  continuity_token?: string;
}

export interface RootHeartbeatRequest {
  endpoint_id: string;
  generation: number;
  /** Omit to retain the published title; null clears it. At most 4096 UTF-8 bytes. */
  display_name?: string | null;
}

export interface RootHeartbeatResponse {
  status: 'ok';
  lease_expires_at: number;
  lease_duration_ms: number;
}

/** Public host persistence evidence, supplied only by the trusted adapter.
 * Host kind and SessionId come from the authenticated root binding. The daemon
 * verifies the file's physical identity independently; native format validity
 * is established by the trusted host through its public persistence API. */
export interface RootConfigurationEvidence {
  kind: 'session-file';
  session_file: string;
  /** Physical artifact fingerprint captured by the trusted host when it
   * validates the session. The daemon compares it to its own observation. */
  file_identity?: string;
  /** Revision observed with file_identity during host validation. Changes in
   * size or write metadata invalidate that observation without changing owner. */
  file_revision?: string;
  /** Digest of immutable public host origin fields, independent of physical
   * file identity. Raw native header values never enter this request. */
  host_origin?: string;
  /** The public host persistence API rejected this durable artifact. */
  invalid?: true;
}

export interface RootConfigurationRequest {
  endpoint_id: string;
  generation: number;
  evidence?: RootConfigurationEvidence;
}

/** Trusted host command, never a model tool argument. */
export interface RootSendingRequest extends RootConfigurationRequest {}

/** Trusted host attestation from a witnessed, durably saved native creation.
 * Registration or the absence of daemon history is never such evidence. */
export interface RootFirstUseEvidence {
  kind: 'new-session-materialized';
  evidence: RootConfigurationEvidence;
  creation_id: string;
}

export interface InitializeRootSendingRequest extends RootSendingRequest {
  first_use?: RootFirstUseEvidence;
}

export interface RootInitialAllowanceStatus {
  eligibility: 'unknown' | 'available' | 'consumed';
  reason: 'FIRST_USE_UNPROVEN' | 'FIRST_USE_VERIFIED' | 'INITIAL_ALLOWANCE_CONSUMED'
    | 'OWNERSHIP_UNVERIFIED' | 'HISTORY_UNAVAILABLE' | 'DISPATCH_HISTORY_PRESENT' | 'CAPACITY_EXHAUSTED';
  guidance: string;
}

/** Retries retain the complete identity. Reading status or reconnecting grants nothing. */
export interface ContinueCollaborationRequest extends RootSendingRequest {
  daemon_id: string;
  request_id: string;
  sequence: number;
}

/** Compare the effective snapshot before reading and publishing a replacement. */
export interface ReloadSendingRulesRequest extends RootSendingRequest {
  daemon_id: string;
  rules_revision: string;
}

export interface RootSendingStatus {
  daemon_id: string;
  mode: 'bounded' | 'continuous';
  period_id: string | null;
  knowledge: 'known' | 'unknown';
  granted: number | null;
  used: number | null;
  remaining: number | null;
  next_grant: number;
  rules_revision: string;
  /** A rejected file leaves the last effective snapshot intact. */
  rules_error: string | null;
  pause_reason: 'ALLOWANCE_EXHAUSTED' | 'ALLOWANCE_UNKNOWN' | null;
  /** Last durably committed human control sequence. */
  control_sequence: number;
  root_configuration: RootConfigurationStatus;
  /** Optional so SDK clients can still read a daemon predating auto issuance. */
  initial_allowance?: RootInitialAllowanceStatus;
}

export type RootConfigurationReason =
  | 'BOUND'
  | 'USER_AUTHORIZED'
  | 'AUTHORIZATION_REQUIRED'
  | 'EVIDENCE_UNAVAILABLE'
  | 'EVIDENCE_INVALID'
  | 'OWNER_CONFLICT'
  | 'HISTORY_MISSING'
  | 'HISTORY_CORRUPT'
  | 'STORAGE_UNAVAILABLE'
  | 'CAPACITY_EXHAUSTED';

/** Trusted human-command result. Authentication of the current root does not
 * prove prior issuance history, and this query grants no sending allowance. */
export interface RootConfigurationStatus {
  root_authenticated: true;
  config_id: string | null;
  config_path: string;
  ownership: 'verified' | 'user-authorized' | 'unknown' | 'conflict';
  history: 'unknown';
  reason: RootConfigurationReason;
  guidance: string;
}

export interface ConnectRootResponse {
  endpoint_id: string;
  generation: number;
  root_token: string;
}

export interface RevokeRootRequest {
  endpoint_id: string;
}

export interface RevokeRootResponse {
  endpoint_id: string;
  status: 'revoked';
}

export interface RevokeRuntimeResponse {
  runtime_id: string;
  revoked_endpoints: string[];
}

export interface EndpointDiagnosticInfo {
  endpoint_id: string;
  runtime_id: string;
  group_id: string;
  generation: number;
  status: 'registered' | 'revoked';
  ready: boolean;
  deliverable: boolean;
}

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { value: Output } | { issues: ReadonlyArray<{ message: string }> };
  };
}

export interface ArloMessageNotificationParams {
  protocol_version: string;
  daemon_id: string;
  message_id: string;
  delivery_id: string;
  from_endpoint: string;
  to_endpoint: string;
  group_id: string;
  target_generation: number;
  delivery_seq: string;
  text: string;
  sent_at: string;
  /** Authorised parent message ID, present only on associated replies. */
  reply_to?: string;
  /** Depth computed by the daemon from its own known association. */
  reply_depth?: number;
}

export const arloNotificationSchema: StandardSchemaV1<ArloMessageNotificationParams> = {
  '~standard': {
    version: 1,
    vendor: 'arlo',
    validate(value: unknown) {
      if (!value || typeof value !== 'object') {
        return { issues: [{ message: 'Params must be an object' }] };
      }
      const v = value as Record<string, unknown>;
      const requiredStringProps = [
        'protocol_version',
        'daemon_id',
        'message_id',
        'delivery_id',
        'from_endpoint',
        'to_endpoint',
        'group_id',
        'delivery_seq',
        'text',
        'sent_at',
      ];
      for (const prop of requiredStringProps) {
        if (typeof v[prop] !== 'string' || !v[prop]) {
          return { issues: [{ message: `Field "${prop}" must be a non-empty string` }] };
        }
      }
      if (v.protocol_version !== ARLO_PROFILE_VERSION) {
        return { issues: [{ message: 'UNSUPPORTED_VERSION: incompatible notification profile' }] };
      }
      if (!/^[1-9]\d*$/.test(v.delivery_seq as string)) {
        return { issues: [{ message: 'delivery_seq must be a positive canonical decimal integer' }] };
      }
      if (typeof v.target_generation !== 'number' || !Number.isInteger(v.target_generation)) {
        return { issues: [{ message: 'Field "target_generation" must be an integer' }] };
      }
      // The daemon emits the association as one indivisible pair: a parent
      // reference always carries its derived depth (a reply is at least one
      // level below its parent), and a bare depth without a parent never
      // occurs on the wire.
      if (v.reply_to !== undefined) {
        if (typeof v.reply_to !== 'string' || !v.reply_to) {
          return { issues: [{ message: 'Field "reply_to" must be a non-empty string when present' }] };
        }
        if (
          typeof v.reply_depth !== 'number' ||
          !Number.isInteger(v.reply_depth) ||
          v.reply_depth < 1 ||
          v.reply_depth > MAX_REPLY_DEPTH
        ) {
          return {
            issues: [{ message: `Field "reply_depth" must be an integer between 1 and ${MAX_REPLY_DEPTH} when "reply_to" is present` }],
          };
        }
      } else if (v.reply_depth !== undefined) {
        return { issues: [{ message: 'Field "reply_depth" without "reply_to" is not a valid frame' }] };
      }
      return { value: v as unknown as ArloMessageNotificationParams };
    },
  },
};

export interface ArloSendMessageArgs {
  to: string;
  text: string;
  /**
   * Optional reply association: the message ID of an inbound message the
   * current endpoint has the right to reply to. The daemon authorises the
   * association and computes the reply depth; the model supplies only this ID.
   */
  reply_to?: string;
}

export interface ArloSendMessageResult {
  status: 'accepted' | 'rejected' | 'unknown';
  message_id: string;
  reason?: string;
}

export interface ArloGetMessageStatusArgs {
  message_id: string;
}

/**
 * One definite assertion that contradicts the receiving binding's own existing
 * definite assertion. Both sides are kept verbatim; the later arrival never
 * overwrites the earlier record.
 */
export interface ArloReceiptAssertion {
  receipt: 'enqueued' | 'not_enqueued';
  status: 'accepted' | 'rejected';
  daemon_id?: string;
  delivery_id: string;
  target_generation?: number;
  native_message_id?: string;
  reason?: string;
  recorded_at: string;
}

/** An inconclusive receipt retained as evidence without asserting a result. */
export interface ArloUncertainAssertion {
  receipt: 'uncertain';
  daemon_id?: string;
  delivery_id: string;
  target_generation?: number;
  native_message_id?: string;
  reason?: string;
  recorded_at: string;
}

export type ArloRecordedAssertion = ArloReceiptAssertion | ArloUncertainAssertion;

export interface ArloMessageStatusResult {
  /**
   * Current receipt state. `receipt_conflict` means two definite assertions
   * contradict each other and the binding is faulted.
   */
  status: 'in_flight' | 'accepted' | 'rejected' | 'unknown' | 'receipt_conflict';
  daemon_id: string;
  message_id: string;
  /**
   * The outcome the send tool already returned to the model. Late evidence
   * never rewrites it.
   */
  original_status?: 'accepted' | 'rejected' | 'unknown';
  original_reason?: string;
  /**
   * True when definitive evidence arrived only after the send tool result had
   * already been returned.
   */
  late_evidence?: boolean;
  from_endpoint: string;
  to_endpoint: string;
  group_id: string;
  target_generation: number;
  delivery_seq: string;
  sent_at: string;
  native_message_id?: string;
  reason?: string;
  /** Both definite assertions, verbatim, when the binding is faulted. */
  conflict_assertions?: ArloReceiptAssertion[];
}

/** Query result for a message record that is expired, unknown, or not owned. */
export interface ArloMessageStatusUnavailable {
  status: 'result_unavailable';
  reason: 'RESULT_UNAVAILABLE';
  daemon_id: string;
  message_id: string;
  /** Explanation that never contains message text or credentials. */
  detail: string;
}

export type ArloMessageStatusQueryResult = ArloMessageStatusResult | ArloMessageStatusUnavailable;

export interface ReadyRootRequest {
  endpoint_id: string;
  generation?: number;
  reconciled_pending_message_ids?: string[];
}

export interface ReadyRootResponse {
  endpoint_id: string;
  status: 'ready';
  ready: true;
  deliverable: true;
}

/**
 * A receipt must carry the full dispatch identity. `daemon_id` and `generation`
 * are required: a receipt that names only a message ID must never be able to
 * move a recorded result.
 */
export interface RootReceiptRequest {
  daemon_id: string;
  endpoint_id: string;
  message_id: string;
  delivery_id: string;
  generation: number;
  status: 'enqueued' | 'not_enqueued' | 'uncertain';
  reason?: string;
  native_message_id?: string;
}

export interface RootReceiptResponse {
  status: 'ok';
}

/**
 * Model-tool query for a message this root sent. The caller never supplies its
 * own identity, daemon, group, or receipt; the daemon derives all of them from
 * the authenticated binding.
 */
export interface MessageStatusRequest {
  message_id: string;
}

export interface RootCreditReleaseRequest {
  endpoint_id: string;
  message_id: string;
  native_message_id?: string;
  /** Full original dispatch identity is required across generations and for snapshots. */
  daemon_id?: string;
  generation?: number;
  delivery_id?: string;
  /** snapshot proves no pending/in-flight input remains, never acceptance or consumption. */
  event: 'claimed' | 'discarded' | 'snapshot';
}

export interface RootCreditReleaseResponse {
  status: 'ok';
}

export interface SessionDiscoveryItem {
  endpoint_id: string;
  display_name?: string;
  host_type?: string;
  host_version?: string;
  host_kind?: string;
  deliverable: boolean;
}
