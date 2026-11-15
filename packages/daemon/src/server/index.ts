import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ArloErrorCode,
  ArloError,
  resolveStateDir,
  resolveAuditDir,
  assertSafeStatePath,
  verifyWindowsAcl,
  inspectWindowsAclBatch,
  validateExplicitGroupName,
  validateProjectGroupId,
  validateHostKind,
  type DaemonDiscoveryRecord,
  type DaemonStatusResponse,
  type DiagnosticReport,
  type DiagnosticCheckResult,
  type RuntimeRegistrationRequest,
  type RuntimeRegistrationResponse,
  type RootRegistrationRequest,
  type RootRegistrationResponse,
  type ConnectRootRequest,
  type ConnectRootResponse,
  type RevokeRootRequest,
  type RevokeRootResponse,
  type RevokeRuntimeResponse,
  type EndpointDiagnosticInfo,
  type ReadyRootRequest,
  type ReadyRootResponse,
  type RootReceiptRequest,
  type RootReceiptResponse,
  type RootCreditReleaseRequest,
  type RootCreditReleaseResponse,
  type SessionDiscoveryItem,
  ARLO_PINNED_WIRE_REVISION,
  ARLO_PROFILE,
  ARLO_PROFILE_VERSION,
  ARLO_CROSS_HOST_CAPABILITY,
  ARLO_CROSS_HOST_CAPABILITY_VERSION,
  ARLO_MESSAGE_ID_META_KEY,
  MAX_TRACKED_MESSAGES,
  MESSAGE_RECORD_TTL_MS,
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_LEASE_DURATION_MS,
  FORBIDDEN_MODEL_ARGUMENT_KEYS,
  DEFAULT_SEND_RATE_PER_MINUTE,
  DEFAULT_SEND_BURST,
  DEFAULT_RECEIVE_RATE_PER_MINUTE,
  DEFAULT_RECEIVE_BURST,
  type RateLimitOptions,
  type RootRateLimit,
} from '@arlo/sdk';
import {
  prepareStateDirectory,
  acquireDaemonLock,
  publishDiscoveryRecord,
  cleanInstanceResources,
  writePrivateStateFile,
} from '../storage/index.ts';
import { acquireStateMutex, type StateMutexRelease } from '../storage/mutex.ts';
import { generateSelfSignedLoopbackCert } from '../security/cert.ts';
import { AuditLogger, LogEventCode } from '../logging/index.ts';
import { TokenBucket } from '../rate-limit/index.ts';
import { RootConfigurationStore, MAX_ROOT_CONFIGURATION_BINDINGS } from '../root-configuration/index.ts';
import { UserAuthorizationStore } from '../user-authorization/index.ts';
import { RootSendingStore } from '../autonomous-sending/index.ts';
import { MessageExchange, MessageAdmissionError, MessageExchangeControlError } from '../message-exchange/index.ts';

export interface ArloDaemonOptions {
  stateDir?: string;
  port?: number;
  tlsCert?: string;
  tlsKey?: string;
  /**
   * Retention for settled message records. Defaults to the 24 hour bound; tests
   * inject a short window to observe eviction without waiting.
   */
  messageRecordTtlMs?: number;
  /**
   * Total tracking budget for message records. Capacity is a configurable
   * engineering default; tests inject a small budget to observe admission
   * pressure without creating 10,000 records.
   */
  maxTrackedMessages?: number;
  /**
   * Clock for every state and ledger decision. Request telemetry keeps the real
   * clock. Tests inject a controllable clock so retention and expiry are
   * asserted deterministically instead of by sleeping.
   */
  now?: () => number;
  /**
   * Value a fresh connection generation starts its delivery sequence from. The
   * first dispatch of a generation uses `initialDeliverySeq + 1`, so the uint64
   * limit is reachable deterministically without dispatching 2^64 messages.
   */
  initialDeliverySeq?: bigint;
  /**
   * Per-root admission pacing. Defaults to the protocol constants: a sending
   * root sustains 12 messages/minute (burst 4), a receiving root sustains
   * 30 messages/minute (burst 8). Tests inject small budgets so pacing
   * boundaries are observed deterministically on the injected clock.
   */
  rateLimit?: RateLimitOptions;
  /** Monotonic clock, separate from the message retention clock. */
  leaseNow?: () => number;
  leaseDurationMs?: number;
  /** Reception deadline; injectable for controlled transport fault tests. */
  ackTimeoutMs?: number;
  /** Automatic launchers enable this; manually started daemons remain running. */
  idleTimeoutMs?: number;
  /** Runs after idle shutdown has released the listener and owned state. */
  onIdleStopped?: () => void;
  /** Bounded persistent root history. No eviction or reuse at capacity. */
  maxRootConfigurationBindings?: number;
}

export interface RuntimeRecord {
  runtimeId: string;
  runtimeToken: string;
  hostType?: string;
  hostVersion?: string;
  hostKind?: string;
  crossHostEnabled: boolean;
  participationScope?: string;
  participationRevision: string;
  active: boolean;
  registeredAt: number;
  revokedAt?: number;
  continuityToken?: string;
}

export interface EndpointRecord {
  endpointId: string;
  runtimeId: string;
  rootSessionId: string;
  displayName?: string;
  groupId: string;
  agentIncarnation: string;
  pluginGeneration: number;
  connectionGeneration: number;
  rootToken: string;
  staleTokens: Set<string>;
  mcpSessionId?: string;
  status: 'registered' | 'revoked';
  ready: boolean;
  deliverable: boolean;
  registeredAt: number;
  revokedAt?: number;

  sseStream?: ServerResponse;
  currentDeliverySeq: bigint;
  pendingMessagesCount: number;
  pendingBytes: number;
  /** Admission pacing for messages this endpoint sends. Survives rotation. */
  senderRate: TokenBucket;
  /** Admission pacing for messages dispatched to this endpoint, shared by every sender. */
  receiverRate: TokenBucket;
  continuityToken?: string;
  /** Earlier generations below this boundary lost live-instance continuity. */
  historicalGenerationFloor: number;
  leaseExpiresAt?: number;
  leaseTimer?: ReturnType<typeof setTimeout>;
}

export type { MessageStatus, ReturnedSendOutcome, MessageRecord } from '../message-exchange/index.ts';

export class ArloDaemon {
  static readonly MAX_REGISTERED_ENDPOINTS = 256;

  /** Declared argument envelope per model tool; anything else is rejected. */
  static readonly MODEL_TOOL_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
    arlo_list_sessions: [],
    arlo_send_message: ['to', 'text', 'reply_to'],
    arlo_get_message_status: ['message_id'],
  };

  readonly daemonId: string;
  readonly stateDir: string;
  private readonly auditDir: string;
  private readonly rootConfigurations: RootConfigurationStore;
  readonly messageRecordTtlMs: number;
  readonly maxTrackedMessages: number;
  readonly senderRateLimit: RootRateLimit;
  readonly receiverRateLimit: RootRateLimit;
  /** Clock for state and ledger decisions; see ArloDaemonOptions.now. */
  readonly now: () => number;
  private readonly requestedPort: number;
  private actualPort = 0;
  private server?: https.Server;
  private logger!: AuditLogger;
  private bootstrapToken!: string;
  private certPem?: string;
  private keyPem?: string;
  private certFingerprint!: string;
  private startTime = 0;
  private isShuttingDown = false;
  private releaseLock?: StateMutexRelease;
  private releaseAuditLock?: () => Promise<void>;
  private stopping?: Promise<void>;
  private readonly idleTimeoutMs?: number;
  private readonly onIdleStopped?: () => void;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly connections = new Set<Duplex>();
  private activeRequests = 0;

  private runtimes = new Map<string, RuntimeRecord>();
  private runtimeTokenToRuntime = new Map<string, RuntimeRecord>();
  private endpoints = new Map<string, EndpointRecord>();
  private rootTokenToEndpoint = new Map<string, EndpointRecord>();
  private staleTokens = new Set<string>();

  private readonly messageExchange: MessageExchange;
  private readonly rootSending: RootSendingStore;
  private readonly userAuthorization: UserAuthorizationStore;
  private readonly initialDeliverySeq: bigint;
  private readonly leaseNow: () => number;
  private readonly leaseDurationMs: number;
  private readonly ackTimeoutMs: number;

  constructor(options: ArloDaemonOptions = {}) {
    this.daemonId = crypto.randomUUID();
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.onIdleStopped = options.onIdleStopped;
    if (this.idleTimeoutMs !== undefined &&
      (!Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs <= 0 || this.idleTimeoutMs > 2_147_483_647)) {
      throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
    }
    this.requestedPort = options.port ?? 0;
    this.certPem = options.tlsCert;
    this.keyPem = options.tlsKey;
    this.messageRecordTtlMs = options.messageRecordTtlMs ?? MESSAGE_RECORD_TTL_MS;
    this.maxTrackedMessages = options.maxTrackedMessages ?? MAX_TRACKED_MESSAGES;
    // Validate through the bucket constructor even when defaults are used, so
    // a bad configuration fails at startup instead of at first admission.
    this.senderRateLimit = this.resolveRateLimit(
      options.rateLimit?.sender,
      DEFAULT_SEND_RATE_PER_MINUTE,
      DEFAULT_SEND_BURST
    );
    this.receiverRateLimit = this.resolveRateLimit(
      options.rateLimit?.receiver,
      DEFAULT_RECEIVE_RATE_PER_MINUTE,
      DEFAULT_RECEIVE_BURST
    );
    this.now = options.now ?? (() => Date.now());
    this.leaseNow = options.leaseNow ?? (() => performance.now());
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs <= 0 ||
      !Number.isSafeInteger(this.ackTimeoutMs) || this.ackTimeoutMs <= 0) {
      throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
    }
    this.initialDeliverySeq = options.initialDeliverySeq ?? 0n;
    this.stateDir = resolveStateDir(options.stateDir);
    this.auditDir = resolveAuditDir(options.stateDir);
    const bindingCapacity = options.maxRootConfigurationBindings ?? MAX_ROOT_CONFIGURATION_BINDINGS;
    if (!Number.isSafeInteger(bindingCapacity) || bindingCapacity < 1 || bindingCapacity > MAX_ROOT_CONFIGURATION_BINDINGS) {
      throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
    }
    this.rootConfigurations = new RootConfigurationStore(this.stateDir, bindingCapacity);
    this.rootSending = new RootSendingStore(this.stateDir, this.daemonId);
    this.userAuthorization = new UserAuthorizationStore(this.stateDir, this.daemonId, root => {
      const ep = this.endpoints.get(root.endpointId);
      return ep?.status === 'registered' && ep.connectionGeneration === root.generation &&
        ep.leaseExpiresAt !== undefined && this.leaseNow() < ep.leaseExpiresAt;
    });
    this.messageExchange = new MessageExchange({ daemonId: this.daemonId, now: this.now,
      messageRecordTtlMs: this.messageRecordTtlMs, maxTrackedMessages: this.maxTrackedMessages,
      ackTimeoutMs: this.ackTimeoutMs, senderRateLimit: this.senderRateLimit, receiverRateLimit: this.receiverRateLimit,
      endpoints: this.endpoints, permitsCommunication: (from, to) => this.permitsCommunication(from, to),
      replayDispatch: (endpointId, messageId, payload) => {
        const ep = this.endpoints.get(endpointId)!;
        return this.runtimes.get(ep.runtimeId)?.hostKind === 'claudecode' &&
          this.userAuthorization.replayDispatch({ endpointId, sessionId: ep.rootSessionId, generation: ep.connectionGeneration }, messageId, payload);
      },
      charge: (endpointId, messageId, payload) => {
        const ep = this.endpoints.get(endpointId)!;
        if (this.runtimes.get(ep.runtimeId)?.hostKind === 'claudecode') {
          return this.userAuthorization.charge({ endpointId, sessionId: ep.rootSessionId, generation: ep.connectionGeneration }, messageId, payload);
        }
        if (!this.rootConfigurations.hasExclusiveClaim(endpointId,
          id => this.endpoints.get(id)?.status === 'registered')) {
          this.rootSending.forget(endpointId);
          throw new ArloError(ArloErrorCode.ALLOWANCE_UNKNOWN);
        }
        this.rootSending.charge(endpointId);
      }, log: entry => this.logger.log(entry) });
  }

  private resolveRateLimit(
    override: RootRateLimit | undefined,
    defaultPerMinute: number,
    defaultBurst: number
  ): RootRateLimit {
    const perMinute = override?.perMinute ?? defaultPerMinute;
    const burst = override?.burst ?? defaultBurst;
    // Throws INVALID_ARGUMENT on non-integer or non-positive values.
    new TokenBucket(perMinute, burst);
    return { perMinute, burst };
  }

  async start(): Promise<{ port: number; daemonId: string }> {
    this.startTime = this.now();

    // 1. Prepare and secure state directory
    prepareStateDirectory(this.stateDir);
    if (this.auditDir !== this.stateDir) prepareStateDirectory(this.auditDir);

    // 2. Acquire lock with ownership protection
    this.releaseLock = await acquireDaemonLock(this.stateDir, this.daemonId, process.pid);
    try {
      if (process.platform === 'linux' && this.auditDir !== this.stateDir) {
        this.releaseAuditLock = await acquireStateMutex(this.auditDir);
      }
      return await this.startOwnedInstance();
    } catch (error) {
      await this.stop();
      if (error instanceof ArloError) throw error;
      throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
    }
  }

  private async startOwnedInstance(): Promise<{ port: number; daemonId: string }> {
    // 3. Initialize logger
    this.logger = new AuditLogger(this.auditDir, this.daemonId);
    this.logger.log({
      event: LogEventCode.LOCK_ACQUIRED,
      status: 'ok',
    });
    this.rootSending.initializeRules();
    this.userAuthorization.initializeRules();

    // 4. Save/ensure TLS credentials in state directory with secure ACL
    const certPath = path.join(this.stateDir, 'daemon.crt');
    const keyPath = path.join(this.stateDir, 'daemon.key');

    if (this.certPem && this.keyPem) {
      writePrivateStateFile(this.stateDir, 'daemon.crt', this.certPem);
      writePrivateStateFile(this.stateDir, 'daemon.key', this.keyPem);
    } else if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      // Verify ACL on existing credentials before reading
      const certAcl = verifyWindowsAcl(certPath);
      const keyAcl = verifyWindowsAcl(keyPath);
      if (!certAcl.valid || !keyAcl.valid) {
        throw new ArloError(
          certAcl.errorCode ?? keyAcl.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS,
          'Existing TLS credentials failed security verification'
        );
      }
      this.certPem = fs.readFileSync(certPath, 'utf8');
      this.keyPem = fs.readFileSync(keyPath, 'utf8');
    } else {
      // Dynamically generate unique self-signed certificate and key for loopback
      const generated = generateSelfSignedLoopbackCert(365);
      this.certPem = generated.certPem;
      this.keyPem = generated.keyPem;

      writePrivateStateFile(this.stateDir, 'daemon.crt', this.certPem);
      writePrivateStateFile(this.stateDir, 'daemon.key', this.keyPem);
    }

    const x509 = new crypto.X509Certificate(this.certPem);
    this.certFingerprint = crypto.createHash('sha256').update(x509.raw).digest('hex');

    // 5. Generate and store bootstrap token with secure ACL
    this.bootstrapToken = crypto.randomBytes(32).toString('hex');
    writePrivateStateFile(this.stateDir, 'bootstrap.token', this.bootstrapToken);

    // 6. Start HTTPS listener strictly on loopback
    await new Promise<void>((resolve, reject) => {
      this.server = https.createServer(
        {
          key: this.keyPem,
          cert: this.certPem,
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.3',
        },
        (req, res) => {
          if (this.isShuttingDown) { res.destroy(); return; }
          if (!this.releaseLock?.isHeld()) {
            res.destroy();
            void this.stop().catch(() => {});
            return;
          }
          this.cancelIdleExit();
          this.activeRequests++;
          if (process.platform === 'linux') {
            try { this.assertPrivateRuntime(); }
            catch {
              this.logger.log({ event: LogEventCode.ERROR_OCCURRED, status: 'error' });
              res.destroy();
              this.activeRequests--;
              void this.stop().catch(() => {});
              return;
            }
          }
          void this.handleRequest(req, res).finally(() => {
            this.activeRequests--;
            this.scheduleIdleExit();
          });
        }
      );

      this.server.on('connection', socket => {
        if (this.isShuttingDown) { socket.destroy(); return; }
        this.connections.add(socket);
        this.cancelIdleExit();
        socket.once('close', () => {
          this.connections.delete(socket);
          this.scheduleIdleExit();
        });
      });

      this.server.on('error', (err) => {
        this.logger.log({
          event: LogEventCode.ERROR_OCCURRED,
          status: 'error',
        });
        reject(err);
      });

      this.server.listen(this.requestedPort, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (typeof addr === 'object' && addr !== null) {
          this.actualPort = addr.port;
          resolve();
        } else {
          reject(new Error('Failed to obtain server listening port'));
        }
      });
    });

    // 7. Atomic publish of discovery record AFTER listener and auth are ready
    const discoveryRecord: DaemonDiscoveryRecord = {
      daemon_id: this.daemonId,
      pid: process.pid,
      port: this.actualPort,
      cert_fingerprint: this.certFingerprint,
      cert_pem: this.certPem,
      protocol_version: '0.1',
      status: 'ready',
      started_at: new Date(this.startTime).toISOString(),
    };
    if (!this.releaseLock?.isHeld()) throw new ArloError(ArloErrorCode.LOCK_ACQUISITION_FAILED);
    publishDiscoveryRecord(this.stateDir, discoveryRecord);

    this.logger.log({
      event: LogEventCode.DAEMON_STARTED,
      status: 'ok',
      bytes: 0,
    });

    this.scheduleIdleExit();
    return { port: this.actualPort, daemonId: this.daemonId };
  }

  private async parseJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          return reject(new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Request body too large'));
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (!data.trim()) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  private revokeEndpoint(endpoint: EndpointRecord): void {
    this.invalidateConnection(endpoint);
    endpoint.status = 'revoked';
    endpoint.revokedAt = this.now();
    // Revoking communication does not prove the host consumed its pending
    // input or ended its session: a plugin can unload while that host stays
    // alive. Keep every unresolved reservation charged to the global budget,
    // including ordinary accepted/unknown records, not just conflicts.
    // Delivery results remain queryable under the same retention rules.
  }

  private invalidateConnection(endpoint: EndpointRecord): void {
    clearTimeout(endpoint.leaseTimer);
    endpoint.leaseTimer = undefined;
    endpoint.leaseExpiresAt = undefined;
    endpoint.ready = false;
    endpoint.deliverable = false;
    this.rememberStaleToken(endpoint.rootToken, endpoint);
    this.rootTokenToEndpoint.delete(endpoint.rootToken);
    endpoint.mcpSessionId = undefined;
    const stream = endpoint.sseStream;
    endpoint.sseStream = undefined;
    stream?.end();
  }

  private renewLease(endpoint: EndpointRecord): void {
    clearTimeout(endpoint.leaseTimer);
    endpoint.leaseExpiresAt = this.leaseNow() + this.leaseDurationMs;
    this.scheduleLeaseExpiry(endpoint);
  }

  private scheduleLeaseExpiry(endpoint: EndpointRecord): void {
    const generation = endpoint.connectionGeneration;
    const expiresAt = endpoint.leaseExpiresAt;
    endpoint.leaseTimer = setTimeout(() => {
      if (endpoint.connectionGeneration !== generation || endpoint.leaseExpiresAt !== expiresAt) return;
      this.expireLeases();
      if (endpoint.leaseExpiresAt !== undefined) this.scheduleLeaseExpiry(endpoint);
    }, Math.max(1, endpoint.leaseExpiresAt! - this.leaseNow()));
    endpoint.leaseTimer.unref();
  }

  private rememberStaleToken(token: string, endpoint?: EndpointRecord): void {
    // Tombstones improve diagnostics only; removed tokens can never regain
    // authorization after leaving the bounded diagnostic cache.
    for (const tokens of [this.staleTokens, ...(endpoint ? [endpoint.staleTokens] : [])]) {
      tokens.add(token);
      while (tokens.size > 1024) tokens.delete(tokens.values().next().value!);
    }
  }

  private expireLeases(): void {
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.leaseExpiresAt !== undefined && this.leaseNow() >= endpoint.leaseExpiresAt) {
        this.invalidateConnection(endpoint);
      }
    }
  }

  /** Discovery and every new send/reply share this rule. Existing message
   * evidence and credit never pass through a participation check. */
  private permitsCommunication(from: EndpointRecord, to: EndpointRecord): boolean {
    if (from.groupId !== to.groupId) return false;
    const source = this.runtimes.get(from.runtimeId);
    const target = this.runtimes.get(to.runtimeId);
    if (!source?.active || !target?.active) return false;
    // One authenticated runtime is a known common host even for legacy clients.
    // Missing classifications on two separate runtimes prove no such relation.
    return source === target ||
      (source.hostKind !== undefined && source.hostKind === target.hostKind) ||
      (source.crossHostEnabled && target.crossHostEnabled);
  }

  private rotateRuntime(runtime: RuntimeRecord): void {
    this.runtimeTokenToRuntime.delete(runtime.runtimeToken);
    this.rememberStaleToken(runtime.runtimeToken);
    runtime.runtimeToken = crypto.randomBytes(32).toString('hex');
    this.runtimeTokenToRuntime.set(runtime.runtimeToken, runtime);
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.runtimeId === runtime.runtimeId && endpoint.status === 'registered') this.invalidateConnection(endpoint);
    }
  }

  private rotateRoot(endpoint: EndpointRecord, continuous: boolean): void {
    this.invalidateConnection(endpoint);
    endpoint.connectionGeneration += 1;
    if (!continuous) {
      endpoint.historicalGenerationFloor = endpoint.connectionGeneration;
      this.rootSending.forget(endpoint.endpointId);
      this.userAuthorization.forget(endpoint.endpointId);
    }
    endpoint.rootToken = crypto.randomBytes(32).toString('hex');
    this.rootTokenToEndpoint.set(endpoint.rootToken, endpoint);
    endpoint.currentDeliverySeq = this.initialDeliverySeq;
  }

  private static validContinuityToken(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);
  }

  private static matchesContinuityToken(expected: string | undefined, supplied: unknown): boolean {
    if (!expected || !ArloDaemon.validContinuityToken(supplied)) return false;
    const left = Buffer.from(expected);
    const right = Buffer.from(supplied);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  /**
   * Applies the declared argument envelope for model tools: no forbidden
   * property and no key outside the tool's own declared parameters may reach
   * the server.
   */
  private validateModelArguments(
    args: Record<string, unknown>,
    allowedKeys: readonly string[]
  ): { ok: true } | { ok: false; message: string } {
    for (const k of FORBIDDEN_MODEL_ARGUMENT_KEYS) {
      if (k in args) {
        return { ok: false, message: `INVALID_ARGUMENT: forbidden argument property "${k}"` };
      }
    }
    const allowed = new Set(allowedKeys);
    for (const k of Object.keys(args)) {
      if (!allowed.has(k)) {
        return { ok: false, message: `INVALID_ARGUMENT: undeclared argument property "${k}" is forbidden` };
      }
    }
    return { ok: true };
  }

  private resolveAuthorizedEndpoint(
    token: string | undefined,
    endpointId: string
  ): { ep?: EndpointRecord; statusCode?: number; error?: ArloErrorCode } {
    this.expireLeases();
    if (!token) {
      return { statusCode: 401, error: ArloErrorCode.UNAUTHORIZED };
    }
    const endpoint = this.rootTokenToEndpoint.get(token);
    const runtime = this.runtimeTokenToRuntime.get(token);
    let ep: EndpointRecord | undefined;
    if (endpoint && endpoint.endpointId === endpointId) {
      ep = endpoint;
    } else if (runtime && runtime.active) {
      ep = this.endpoints.get(endpointId);
      if (ep && ep.runtimeId !== runtime.runtimeId) ep = undefined;
    }

    if (!ep) {
      const isStale = this.staleTokens.has(token);
      return {
        statusCode: isStale ? 403 : 401,
        error: isStale ? ArloErrorCode.STALE_GENERATION : ArloErrorCode.UNAUTHORIZED,
      };
    }

    if (ep.status === 'revoked') {
      return { statusCode: 403, error: ArloErrorCode.TARGET_UNAVAILABLE };
    }

    return { ep };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.expireLeases();
    const startReqTime = Date.now();
    const requestId = crypto.randomUUID();

    // Reject browser CORS: no Access-Control-Allow-Origin header is ever emitted.
    // Also parse Origin header as URL to strictly verify loopback host.
    const origin = req.headers['origin'];
    if (origin) {
      let isLoopbackOrigin = false;
      try {
        const parsedOrigin = new URL(origin);
        if (
          parsedOrigin.hostname === '127.0.0.1' ||
          parsedOrigin.hostname === 'localhost' ||
          parsedOrigin.hostname === '::1'
        ) {
          isLoopbackOrigin = true;
        }
      } catch {}

      if (!isLoopbackOrigin) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'FORBIDDEN_ORIGIN' }));
        this.logger.log({
          event: LogEventCode.REQUEST_SERVED,
          status: 'rejected',
          request_id: requestId,
          bytes: 0,
          duration_ms: Date.now() - startReqTime,
        });
        return;
      }
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    // Check for stale generation token
    if (token && this.staleTokens.has(token)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: ArloErrorCode.STALE_GENERATION,
          message: 'Credential belongs to stale connection generation',
        })
      );
      this.logger.log({
        event: LogEventCode.AUTH_FAILURE,
        status: 'rejected',
        request_id: requestId,
        bytes: 0,
        duration_ms: Date.now() - startReqTime,
      });
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', `https://127.0.0.1:${this.actualPort}`);

    try {
      // 1. /control/v1/status
      if (req.method === 'GET' && parsedUrl.pathname === '/control/v1/status') {
        if (!token || token !== this.bootstrapToken) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          this.logger.log({
            event: LogEventCode.AUTH_FAILURE,
            status: 'rejected',
            request_id: requestId,
            bytes: 0,
            duration_ms: Date.now() - startReqTime,
          });
          return;
        }

        const activeEndpointsCount = [...this.endpoints.values()].filter((e) => e.status === 'registered').length;
        const revokedEndpointsCount = [...this.endpoints.values()].filter((e) => e.status === 'revoked').length;

        const response: DaemonStatusResponse = {
          daemon_id: this.daemonId,
          pid: process.pid,
          port: this.actualPort,
          status: this.isShuttingDown ? 'shutting_down' : 'ready',
          uptime_ms: Date.now() - this.startTime,
          protocol_version: '0.1',
          listener: 'loopback',
          active_endpoints_count: activeEndpointsCount,
          revoked_endpoints_count: revokedEndpointsCount,
        };

        const body = JSON.stringify(response);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);

        this.logger.log({
          event: LogEventCode.REQUEST_SERVED,
          status: 'ok',
          request_id: requestId,
          bytes: Buffer.byteLength(body),
          duration_ms: Date.now() - startReqTime,
        });
        return;
      }

      // 2. /control/v1/doctor
      if (req.method === 'GET' && parsedUrl.pathname === '/control/v1/doctor') {
        if (!token || token !== this.bootstrapToken) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          this.logger.log({
            event: LogEventCode.AUTH_FAILURE,
            status: 'rejected',
            request_id: requestId,
            bytes: 0,
            duration_ms: Date.now() - startReqTime,
          });
          return;
        }

        const report = this.runDoctorChecks();
        const body = JSON.stringify(report);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);

        this.logger.log({
          event: LogEventCode.DIAGNOSTIC_RUN,
          status: report.overall_status === 'healthy' ? 'ok' : 'error',
          request_id: requestId,
          bytes: Buffer.byteLength(body),
          duration_ms: Date.now() - startReqTime,
        });
        return;
      }

      // 3. /control/v1/runtimes/register
      if (req.method === 'POST' && parsedUrl.pathname === '/control/v1/runtimes/register') {
        if (!token || token !== this.bootstrapToken) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          this.logger.log({
            event: LogEventCode.AUTH_FAILURE,
            status: 'rejected',
            request_id: requestId,
            bytes: 0,
            duration_ms: Date.now() - startReqTime,
          });
          return;
        }

        const body = (await this.parseJsonBody(req)) as RuntimeRegistrationRequest;
        let hostKind: string | undefined;
        try {
          if (!body || typeof body !== 'object' || Array.isArray(body) ||
              (body.host_type !== undefined && typeof body.host_type !== 'string') ||
              (body.host_version !== undefined && typeof body.host_version !== 'string') ||
              (body.cross_host_enabled !== undefined && typeof body.cross_host_enabled !== 'boolean')) {
            throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
          }
          // The released DSH adapter used this exact value. Other display
          // aliases cannot establish a stable host classification.
          hostKind = body.host_kind === undefined
            ? body.host_type === 'deepseek-harness' ? 'deepseek-harness' : undefined
            : validateHostKind(body.host_kind);
          if (body.participation_scope !== undefined &&
              (!hostKind || typeof body.participation_scope !== 'string' || !/^[a-f0-9]{64}$/.test(body.participation_scope))) {
            throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
          }
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.INVALID_ARGUMENT }));
          return;
        }
        const runtimeId = body?.runtime_id ?? `rt-${crypto.randomUUID()}`;
        const existingRuntime = this.runtimes.get(runtimeId);
        if (existingRuntime?.active &&
          ArloDaemon.matchesContinuityToken(existingRuntime.continuityToken, body.continuity_token) &&
          existingRuntime.hostType === body.host_type && existingRuntime.hostVersion === body.host_version &&
          existingRuntime.hostKind === hostKind && existingRuntime.participationScope === body.participation_scope) {
          // A retry preserves the registered host identity and participation.
          this.rotateRuntime(existingRuntime);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ runtime_id: existingRuntime.runtimeId, runtime_token: existingRuntime.runtimeToken }));
          return;
        }
        // Retired IDs remain reserved for this daemon lifetime: a new token
        // must never inherit another registry's existing ownership scope.
        if (typeof runtimeId !== 'string' || !runtimeId || this.runtimes.has(runtimeId) ||
          (body.continuity_token !== undefined && !ArloDaemon.validContinuityToken(body.continuity_token))) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.INVALID_ARGUMENT }));
          return;
        }
        const runtimeToken = crypto.randomBytes(32).toString('hex');
        const configurationPeer = body.participation_scope === undefined ? undefined
          : [...this.runtimes.values()].find(peer => peer.active && peer.hostKind === hostKind &&
            peer.participationScope === body.participation_scope);
        const runtimeRecord: RuntimeRecord = {
          runtimeId,
          runtimeToken,
          hostType: body.host_type,
          hostVersion: body.host_version,
          hostKind,
          crossHostEnabled: configurationPeer?.crossHostEnabled ?? body.cross_host_enabled ?? false,
          participationScope: body.participation_scope,
          participationRevision: configurationPeer?.participationRevision ?? crypto.randomBytes(32).toString('hex'),
          active: true,
          registeredAt: this.now(),
          continuityToken: body.continuity_token,
        };

        this.runtimes.set(runtimeId, runtimeRecord);
        this.runtimeTokenToRuntime.set(runtimeToken, runtimeRecord);

        const response: RuntimeRegistrationResponse = {
          runtime_id: runtimeId,
          runtime_token: runtimeToken,
        };

        const resBody = JSON.stringify(response);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(resBody);

        this.logger.log({
          event: LogEventCode.RUNTIME_REGISTERED,
          status: 'ok',
          request_id: requestId,
          bytes: Buffer.byteLength(resBody),
          duration_ms: Date.now() - startReqTime,
        });
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/control/v1/runtimes/reauthenticate') {
        const body = await this.parseJsonBody(req);
        const runtime = this.runtimes.get(body?.runtime_id);
        if (token !== this.bootstrapToken || !runtime?.active ||
          !ArloDaemon.matchesContinuityToken(runtime.continuityToken, body?.continuity_token)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          return;
        }
        this.rotateRuntime(runtime);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runtime_id: runtime.runtimeId, runtime_token: runtime.runtimeToken }));
        return;
      }

      if ((req.method === 'GET' || req.method === 'POST') && parsedUrl.pathname === '/control/v1/runtimes/participation') {
        const runtime = token ? this.runtimeTokenToRuntime.get(token) : undefined;
        if (!runtime?.active) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ cross_host_enabled: runtime.crossHostEnabled, revision: runtime.participationRevision }));
          return;
        }
        const body = await this.parseJsonBody(req);
        if (!runtime.active || this.runtimeTokenToRuntime.get(token!) !== runtime) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          return;
        }
        if (!body || typeof body.cross_host_enabled !== 'boolean' ||
            typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision) ||
            Object.keys(body).some(key => key !== 'cross_host_enabled' && key !== 'revision')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.INVALID_ARGUMENT }));
          return;
        }
        if (body.revision !== runtime.participationRevision) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.STALE_GENERATION }));
          return;
        }
        // This is the admission boundary. Existing dispatches, receipts,
        // pending credit and query rights keep their original identities.
        // Even an unchanged explicit setting retires older in-flight updates.
        runtime.crossHostEnabled = body.cross_host_enabled;
        runtime.participationRevision = crypto.randomBytes(32).toString('hex');
        if (runtime.participationScope) {
          for (const peer of this.runtimes.values()) {
            if (peer.active && peer.hostKind === runtime.hostKind && peer.participationScope === runtime.participationScope) {
              peer.crossHostEnabled = runtime.crossHostEnabled;
              peer.participationRevision = runtime.participationRevision;
            }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cross_host_enabled: runtime.crossHostEnabled, revision: runtime.participationRevision }));
        return;
      }

      // 4. /control/v1/roots/register
      if (req.method === 'POST' && parsedUrl.pathname === '/control/v1/roots/register') {
        const body = (await this.parseJsonBody(req)) as RootRegistrationRequest;
        // Authorization, capacity checking and insertion must run without an
        // await between them; a body still in flight owns neither authority nor a slot.
        const runtime = token ? this.runtimeTokenToRuntime.get(token) : undefined;
        if (!runtime || !runtime.active) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          this.logger.log({
            event: LogEventCode.AUTH_FAILURE,
            status: 'rejected',
            request_id: requestId,
            bytes: 0,
            duration_ms: Date.now() - startReqTime,
          });
          return;
        }

        if (
          !body ||
          !body.root_session_id ||
          !body.agent_incarnation ||
          typeof body.plugin_generation !== 'number' ||
          (body.continuity_token !== undefined && !ArloDaemon.validContinuityToken(body.continuity_token))
        ) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: ArloErrorCode.INVALID_ARGUMENT,
              message: 'Missing required root registration fields',
            })
          );
          return;
        }

        let groupId: string;
        try {
          if ((body.group_name !== undefined) === (body.project_group_id !== undefined)) {
            throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
          }
          groupId = body.group_name !== undefined
            ? validateExplicitGroupName(body.group_name).groupId
            : validateProjectGroupId(body.project_group_id);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.INVALID_ARGUMENT }));
          return;
        }

        // A lost registration response may recover only the same live binding.
        // The exact secret and immutable identities are required; a reused host
        // session name alone never transfers an endpoint to a replacement.
        const existing = [...this.endpoints.values()].find(endpoint =>
          endpoint.status === 'registered' && endpoint.runtimeId === runtime.runtimeId &&
          endpoint.rootSessionId === String(body.root_session_id));
        if (existing) {
          if (!ArloDaemon.matchesContinuityToken(existing.continuityToken, body.continuity_token) ||
            existing.agentIncarnation !== body.agent_incarnation || existing.pluginGeneration !== body.plugin_generation ||
            existing.groupId !== groupId) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: ArloErrorCode.BINDING_MISMATCH }));
            return;
          }
          this.rotateRoot(existing, true);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ endpoint_id: existing.endpointId, generation: existing.connectionGeneration,
            root_token: existing.rootToken, group_id: existing.groupId, status: 'registered', ready: false, deliverable: false }));
          return;
        }

        const activeCount = [...this.endpoints.values()].filter((e) => e.status === 'registered').length;
        if (activeCount >= ArloDaemon.MAX_REGISTERED_ENDPOINTS) {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: ArloErrorCode.QUEUE_LIMIT,
              message: 'Maximum registered endpoints limit (256) reached',
            })
          );
          this.logger.log({
            event: LogEventCode.REQUEST_SERVED,
            status: 'rejected',
            request_id: requestId,
            bytes: 0,
            duration_ms: Date.now() - startReqTime,
          });
          return;
        }

        const endpointId = `ep-${crypto.randomUUID()}`;
        const rootToken = crypto.randomBytes(32).toString('hex');
        const record: EndpointRecord = {
          endpointId,
          runtimeId: runtime.runtimeId,
          rootSessionId: String(body.root_session_id),
          displayName: body.display_name,
          groupId,
          agentIncarnation: String(body.agent_incarnation),
          pluginGeneration: body.plugin_generation,
          connectionGeneration: 1,
          rootToken,
          staleTokens: new Set(),
          historicalGenerationFloor: 1,
          continuityToken: body.continuity_token,
          status: 'registered',
          ready: false,
          deliverable: false,
          registeredAt: this.now(),
          currentDeliverySeq: this.initialDeliverySeq,
          pendingMessagesCount: 0,
          pendingBytes: 0,
          senderRate: new TokenBucket(this.senderRateLimit.perMinute, this.senderRateLimit.burst),
          receiverRate: new TokenBucket(this.receiverRateLimit.perMinute, this.receiverRateLimit.burst),
        };

        this.endpoints.set(endpointId, record);
        this.rootTokenToEndpoint.set(rootToken, record);

        const response: RootRegistrationResponse = {
          endpoint_id: endpointId,
          generation: 1,
          root_token: rootToken,
          group_id: groupId,
          status: 'registered',
          ready: false,
          deliverable: false,
        };

        const resBody = JSON.stringify(response);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(resBody);

        this.logger.log({
          event: LogEventCode.ROOT_REGISTERED,
          status: 'ok',
          request_id: requestId,
          bytes: Buffer.byteLength(resBody),
          duration_ms: Date.now() - startReqTime,
        });
        return;
      }

      // 5. /control/v1/roots/connect (advance generation)
      if (req.method === 'POST' && parsedUrl.pathname === '/control/v1/roots/connect') {
        const body = (await this.parseJsonBody(req)) as ConnectRootRequest;
        this.expireLeases();
        if (!body || !body.endpoint_id) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.INVALID_ARGUMENT }));
          return;
        }

        const endpoint = this.endpoints.get(body.endpoint_id);
        if (!endpoint) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.TARGET_UNAVAILABLE }));
          return;
        }
        if (endpoint.status === 'revoked') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.TARGET_UNAVAILABLE }));
          return;
        }

        // Ownership verification
        const runtime = token ? this.runtimeTokenToRuntime.get(token) : undefined;
        let authorized = false;
        if (runtime && runtime.active && runtime.runtimeId === endpoint.runtimeId) {
          authorized = true;
        } else if (endpoint.rootToken === token && this.rootTokenToEndpoint.get(token) === endpoint) {
          authorized = true;
        } else if (endpoint.staleTokens.has(token ?? '')) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.STALE_GENERATION }));
          return;
        }

        if (!authorized) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          return;
        }

        const continuous = ArloDaemon.matchesContinuityToken(endpoint.continuityToken, body.continuity_token);
        if (body.continuity_token !== undefined && !continuous) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.BINDING_MISMATCH }));
          return;
        }

        this.rotateRoot(endpoint, continuous);

        const response: ConnectRootResponse = {
          endpoint_id: endpoint.endpointId,
          generation: endpoint.connectionGeneration,
          root_token: endpoint.rootToken,
        };

        const resBody = JSON.stringify(response);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(resBody);

        this.logger.log({
          event: LogEventCode.ROOT_CONNECTED,
          status: 'ok',
          request_id: requestId,
          bytes: Buffer.byteLength(resBody),
          duration_ms: Date.now() - startReqTime,
        });
        return;
      }

      // 6. /control/v1/roots/revoke
      if (req.method === 'POST' && parsedUrl.pathname === '/control/v1/roots/revoke') {
        const body = (await this.parseJsonBody(req)) as RevokeRootRequest;
        if (!body || !body.endpoint_id) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.INVALID_ARGUMENT }));
          return;
        }

        const endpoint = this.endpoints.get(body.endpoint_id);
        if (!endpoint) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.TARGET_UNAVAILABLE }));
          return;
        }

        const runtime = token ? this.runtimeTokenToRuntime.get(token) : undefined;
        let authorized = false;
        if (runtime && runtime.runtimeId === endpoint.runtimeId) {
          authorized = true;
        } else if (endpoint.rootToken === token && this.rootTokenToEndpoint.get(token) === endpoint) {
          authorized = true;
        }

        if (!authorized) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          return;
        }

        this.revokeEndpoint(endpoint);

        const response: RevokeRootResponse = {
          endpoint_id: endpoint.endpointId,
          status: 'revoked',
        };

        const resBody = JSON.stringify(response);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(resBody);

        this.logger.log({
          event: LogEventCode.ROOT_REVOKED,
          status: 'ok',
          request_id: requestId,
          bytes: Buffer.byteLength(resBody),
          duration_ms: Date.now() - startReqTime,
        });
        return;
      }

      // 7. /control/v1/runtimes/revoke
      if (req.method === 'POST' && parsedUrl.pathname === '/control/v1/runtimes/revoke') {
        const runtime = token ? this.runtimeTokenToRuntime.get(token) : undefined;
        if (!runtime || !runtime.active) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          return;
        }

        runtime.active = false;
        runtime.revokedAt = this.now();
        this.runtimeTokenToRuntime.delete(token!);
        this.rememberStaleToken(token!);

        const revokedEndpoints: string[] = [];
        for (const e of this.endpoints.values()) {
          if (e.runtimeId === runtime.runtimeId && e.status !== 'revoked') {
            this.revokeEndpoint(e);
            revokedEndpoints.push(e.endpointId);
          }
        }

        const response: RevokeRuntimeResponse = {
          runtime_id: runtime.runtimeId,
          revoked_endpoints: revokedEndpoints,
        };

        const resBody = JSON.stringify(response);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(resBody);

        this.logger.log({
          event: LogEventCode.RUNTIME_REVOKED,
          status: 'ok',
          request_id: requestId,
          bytes: Buffer.byteLength(resBody),
          duration_ms: Date.now() - startReqTime,
        });
        return;
      }

      // 8. /control/v1/roots (read-only diagnosis list)
      if (req.method === 'GET' && parsedUrl.pathname === '/control/v1/roots') {
        const isBootstrap = token && token === this.bootstrapToken;
        const runtime = token ? this.runtimeTokenToRuntime.get(token) : undefined;

        if (!isBootstrap && (!runtime || !runtime.active)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          return;
        }

        const list: EndpointDiagnosticInfo[] = [...this.endpoints.values()]
          .filter((e) => isBootstrap || e.runtimeId === runtime!.runtimeId)
          .map((e) => ({
            endpoint_id: e.endpointId,
            runtime_id: e.runtimeId,
            group_id: e.groupId,
            generation: e.connectionGeneration,
            status: e.status,
            ready: e.ready,
            deliverable: e.deliverable,
          }));

        const resBody = JSON.stringify(list);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(resBody);

        this.logger.log({
          event: LogEventCode.REQUEST_SERVED,
          status: 'ok',
          request_id: requestId,
          bytes: Buffer.byteLength(resBody),
          duration_ms: Date.now() - startReqTime,
        });
        return;
      }

      if (req.method === 'POST' && ['/control/v1/roots/configuration',
        '/control/v1/roots/sending-status', '/control/v1/roots/continue-collaboration',
        '/control/v1/roots/initialize-sending', '/control/v1/roots/authorize', '/control/v1/roots/prepare-continuation', '/control/v1/roots/reload-sending-rules'].includes(parsedUrl.pathname)) {
        const body = await this.parseJsonBody(req);
        const authorizing = parsedUrl.pathname === '/control/v1/roots/authorize';
        const preparing = parsedUrl.pathname === '/control/v1/roots/prepare-continuation';
        const continuing = parsedUrl.pathname === '/control/v1/roots/continue-collaboration';
        const sendingStatus = parsedUrl.pathname === '/control/v1/roots/sending-status';
        const initializing = parsedUrl.pathname === '/control/v1/roots/initialize-sending';
        const reloading = parsedUrl.pathname === '/control/v1/roots/reload-sending-rules';
        const allowed = ['endpoint_id', 'generation', 'evidence',
          ...(authorizing || preparing ? ['request_id'] : []),
          ...(continuing ? ['daemon_id', 'request_id', 'sequence'] : []),
          ...(initializing ? ['first_use'] : []),
          ...(reloading ? ['daemon_id', 'rules_revision'] : [])];
        const validEvidence = (evidence: any): boolean => evidence && typeof evidence === 'object' && !Array.isArray(evidence) &&
          evidence.kind === 'session-file' && typeof evidence.session_file === 'string' && path.isAbsolute(evidence.session_file) &&
          Buffer.byteLength(evidence.session_file) <= 8192 &&
          (evidence.invalid === undefined || evidence.invalid === true) &&
          ['file_identity', 'host_origin', 'file_revision'].every(key => evidence[key] === undefined ||
            typeof evidence[key] === 'string' && /^[0-9a-f]{64}$/.test(evidence[key])) &&
          Object.keys(evidence).every(key => ['kind', 'session_file', 'invalid', 'file_identity', 'host_origin', 'file_revision'].includes(key));
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).some(key => !allowed.includes(key)) ||
            typeof body.endpoint_id !== 'string' || !Number.isSafeInteger(body.generation) ||
            (authorizing || preparing) && (typeof body.request_id !== 'string' || !body.request_id || body.request_id.length > 256) ||
            continuing && (typeof body.daemon_id !== 'string' || !body.daemon_id ||
              typeof body.request_id !== 'string' || !body.request_id || body.request_id.length > 256 ||
              !Number.isSafeInteger(body.sequence) || body.sequence < 1) ||
            reloading && (typeof body.daemon_id !== 'string' || !body.daemon_id ||
              typeof body.rules_revision !== 'string' || !body.rules_revision || body.rules_revision.length > 256) ||
            body.evidence !== undefined && !validEvidence(body.evidence) ||
            body.first_use !== undefined && (!body.first_use || typeof body.first_use !== 'object' || Array.isArray(body.first_use) ||
              body.first_use.kind !== 'new-session-materialized' || !validEvidence(body.first_use.evidence) ||
              typeof body.first_use.creation_id !== 'string' || !body.first_use.creation_id || body.first_use.creation_id.length > 256 ||
              /[\u0000-\u001f\u007f]/.test(body.first_use.creation_id) ||
              Object.keys(body.first_use).some(key => !['kind', 'evidence', 'creation_id'].includes(key)))) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.INVALID_ARGUMENT }));
          return;
        }
        const auth = this.resolveAuthorizedEndpoint(token, body.endpoint_id);
        const ep = auth.ep;
        if (!ep || ep.rootToken !== token || body.generation !== ep.connectionGeneration) {
          res.writeHead(auth.statusCode ?? 403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: auth.error ?? (ep && ep.rootToken !== token
            ? ArloErrorCode.UNAUTHORIZED : ArloErrorCode.STALE_GENERATION) }));
          return;
        }
        if (this.runtimes.get(ep.runtimeId)?.hostKind === 'claudecode') {
          const root = { endpointId: ep.endpointId, sessionId: ep.rootSessionId, generation: ep.connectionGeneration };
          const revalidate = () => {
            if (this.resolveAuthorizedEndpoint(token, body.endpoint_id).ep !== ep || ep.rootToken !== token || body.generation !== ep.connectionGeneration) {
              throw new ArloError(ArloErrorCode.STALE_GENERATION);
            }
          };
          try {
            const result = authorizing ? this.userAuthorization.authorize(root, body.request_id, revalidate)
              : preparing ? this.userAuthorization.prepareContinue(root, body.request_id, revalidate)
              : continuing ? this.userAuthorization.continue(root, body, revalidate)
              : reloading ? this.userAuthorization.reload(root, body.rules_revision, body.daemon_id)
              : sendingStatus || initializing ? this.userAuthorization.status(root)
              : this.userAuthorization.configurationStatus(root);
            this.logger.log({ event: authorizing ? LogEventCode.ROOT_CONFIGURATION_QUERIED
              : continuing ? LogEventCode.COLLABORATION_CONTINUED : reloading ? LogEventCode.SENDING_RULES_RELOADED
                : LogEventCode.ROOT_SENDING_STATUS_QUERIED, status: 'user-authorized', request_id: requestId });
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
          } catch (error) {
            if (!(error instanceof ArloError)) throw error;
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: error.code, message: error.message }));
          }
          return;
        }
        if (authorizing || preparing) {
          res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: ArloErrorCode.INVALID_ARGUMENT })); return;
        }
        const status = this.rootConfigurations.query({ endpointId: ep.endpointId,
          hostKind: this.runtimes.get(ep.runtimeId)?.hostKind, sessionId: ep.rootSessionId }, body.evidence,
          endpointId => this.endpoints.get(endpointId)?.status === 'registered');
        this.rootSending.observeConfiguration(ep.endpointId, status);
        if (continuing || sendingStatus || initializing || reloading) {
          let result;
          try {
            const revalidate = () => {
              const current = this.resolveAuthorizedEndpoint(token, body.endpoint_id).ep;
              if (current !== ep || ep.rootToken !== token || body.generation !== ep.connectionGeneration) {
                throw new ArloError(ArloErrorCode.STALE_GENERATION);
              }
              const configuration = this.rootConfigurations.query({ endpointId: ep.endpointId,
                hostKind: this.runtimes.get(ep.runtimeId)?.hostKind, sessionId: ep.rootSessionId }, body.evidence,
                endpointId => this.endpoints.get(endpointId)?.status === 'registered');
              if (configuration.ownership !== 'verified' || configuration.config_id !== status.config_id) {
                throw new ArloError(ArloErrorCode.ALLOWANCE_UNKNOWN);
              }
            };
            result = continuing ? this.rootSending.continue(ep.endpointId, status, body, revalidate)
              : initializing ? this.rootSending.initialize(ep.endpointId, status, body, revalidate,
                () => status.config_id !== null && this.rootConfigurations.isNewBinding(status.config_id))
              : reloading ? this.rootSending.reload(ep.endpointId, status, body, revalidate)
              : this.rootSending.status(ep.endpointId, status);
          } catch (error) {
            if (!(error instanceof ArloError)) throw error;
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: error.code, message: error.message }));
            return;
          }
          this.logger.log({ event: continuing ? LogEventCode.COLLABORATION_CONTINUED
            : initializing ? LogEventCode.ROOT_SENDING_INITIALIZED
              : reloading ? LogEventCode.SENDING_RULES_RELOADED : LogEventCode.ROOT_SENDING_STATUS_QUERIED,
            status: initializing ? result.initial_allowance?.reason ?? 'FIRST_USE_UNPROVEN'
              : result.pause_reason === null ? 'ok' : 'rejected', request_id: requestId });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        this.logger.log({ event: LogEventCode.ROOT_CONFIGURATION_QUERIED, status: status.reason, request_id: requestId });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/control/v1/roots/heartbeat') {
        const body = await this.parseJsonBody(req);
        const auth = this.resolveAuthorizedEndpoint(token, body?.endpoint_id);
        const ep = auth.ep;
        if (!ep || ep.rootToken !== token || body.generation !== ep.connectionGeneration) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: auth.error ?? ArloErrorCode.STALE_GENERATION }));
          return;
        }
        if (!ep.mcpSessionId || !ep.sseStream || ep.sseStream.writableEnded) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.CHANNEL_NOT_READY }));
          return;
        }
        if (body.display_name !== undefined && body.display_name !== null &&
          (typeof body.display_name !== 'string' || Buffer.byteLength(body.display_name, 'utf8') > 4096)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.INVALID_ARGUMENT }));
          return;
        }
        if (body.display_name !== undefined) ep.displayName = body.display_name ?? undefined;
        this.renewLease(ep);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', lease_expires_at: ep.leaseExpiresAt,
          lease_duration_ms: this.leaseDurationMs }));
        return;
      }

      // 9. /control/v1/roots/ready
      if (req.method === 'POST' && parsedUrl.pathname === '/control/v1/roots/ready') {
        const body = (await this.parseJsonBody(req)) as ReadyRootRequest;
        if (!body || !body.endpoint_id) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.INVALID_ARGUMENT }));
          return;
        }

        const auth = this.resolveAuthorizedEndpoint(token, body.endpoint_id);
        if (!auth.ep) {
          res.writeHead(auth.statusCode ?? 401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: auth.error ?? ArloErrorCode.UNAUTHORIZED }));
          return;
        }
        const ep = auth.ep;
        if ((body.generation !== undefined && body.generation !== ep.connectionGeneration) ||
          (token !== ep.rootToken && body.generation === undefined)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.STALE_GENERATION }));
          return;
        }

        this.messageExchange.reconcileReady(ep, body);
        this.renewLease(ep);

        const response: ReadyRootResponse = {
          endpoint_id: ep.endpointId,
          status: 'ready',
          ready: true,
          deliverable: true,
        };

        const resBody = JSON.stringify(response);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(resBody);

        this.logger.log({
          event: LogEventCode.ROOT_READY,
          status: 'ok',
          request_id: requestId,
          bytes: Buffer.byteLength(resBody),
          duration_ms: Date.now() - startReqTime,
        });
        return;
      }

      // 10. /control/v1/roots/receipt
      if (req.method === 'POST' && parsedUrl.pathname === '/control/v1/roots/receipt') {
        const body = (await this.parseJsonBody(req)) as RootReceiptRequest;
        // The full dispatch identity is mandatory: a message ID on its own is
        // never enough to move a recorded result.
        if (
          !body ||
          !body.endpoint_id ||
          !body.message_id ||
          !body.delivery_id ||
          !['enqueued', 'not_enqueued', 'uncertain'].includes(body.status) ||
          (body.reason !== undefined && !Object.values(ArloErrorCode).includes(body.reason as ArloErrorCode)) ||
          !MessageExchange.validNativeMessageId(body.native_message_id) ||
          typeof body.daemon_id !== 'string' ||
          !body.daemon_id ||
          typeof body.generation !== 'number' ||
          !Number.isInteger(body.generation)
        ) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.INVALID_ARGUMENT }));
          return;
        }

        const auth = this.resolveAuthorizedEndpoint(token, body.endpoint_id);
        if (!auth.ep) {
          res.writeHead(auth.statusCode ?? 401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: auth.error ?? ArloErrorCode.UNAUTHORIZED }));
          return;
        }
        const ep = auth.ep;

        this.messageExchange.recordReceipt(ep, body, token === ep.rootToken);

        const response: RootReceiptResponse = { status: 'ok' };
        const resBody = JSON.stringify(response);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(resBody);

        this.logger.log({
          event: LogEventCode.RECEIPT_RECORDED,
          status: 'ok',
          request_id: requestId,
          bytes: Buffer.byteLength(resBody),
          duration_ms: Date.now() - startReqTime,
        });
        return;
      }

      // 11. /control/v1/roots/credit
      if (req.method === 'POST' && parsedUrl.pathname === '/control/v1/roots/credit') {
        const body = (await this.parseJsonBody(req)) as RootCreditReleaseRequest;
        if (!body || !body.endpoint_id || !body.message_id || !['claimed', 'discarded', 'snapshot'].includes(body.event) ||
          !MessageExchange.validNativeMessageId(body.native_message_id) ||
          (body.event === 'snapshot' && (!body.native_message_id || typeof body.daemon_id !== 'string' || !body.daemon_id ||
            !Number.isSafeInteger(body.generation) || body.generation! < 1 ||
            typeof body.delivery_id !== 'string' || !body.delivery_id))) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.INVALID_ARGUMENT }));
          return;
        }

        const auth = this.resolveAuthorizedEndpoint(token, body.endpoint_id);
        if (!auth.ep) {
          res.writeHead(auth.statusCode ?? 401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: auth.error ?? ArloErrorCode.UNAUTHORIZED }));
          return;
        }
        const ep = auth.ep;

        this.messageExchange.releaseCredit(ep, body, token === ep.rootToken);

        const response: RootCreditReleaseResponse = { status: 'ok' };
        const resBody = JSON.stringify(response);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(resBody);

        this.logger.log({
          event: LogEventCode.CREDIT_RELEASED,
          status: 'ok',
          request_id: requestId,
          bytes: Buffer.byteLength(resBody),
          duration_ms: Date.now() - startReqTime,
        });
        return;
      }

      // 9. /mcp (MCP Data plane over Streamable HTTP)
      if (req.method === 'POST' && parsedUrl.pathname === '/mcp') {
        if (!token || !this.rootTokenToEndpoint.has(token)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          return;
        }

        const rpc = (await this.parseJsonBody(req)) as any;
        this.expireLeases();
        // A connection can rotate or be revoked while its body is arriving.
        // All binding checks and the resulting state transition below are synchronous.
        if (this.staleTokens.has(token)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.STALE_GENERATION }));
          return;
        }
        const endpoint = this.rootTokenToEndpoint.get(token);
        if (!endpoint) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          return;
        }
        if (endpoint.status === 'revoked') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          return;
        }

        const reqEndpointId = req.headers['x-arlo-endpoint-id'];
        if (reqEndpointId && reqEndpointId !== endpoint.endpointId) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.BINDING_MISMATCH, message: 'Endpoint ID mismatch' }));
          return;
        }

        const reqGeneration = req.headers['x-arlo-generation'];
        if (reqGeneration && Number(reqGeneration) !== endpoint.connectionGeneration) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.STALE_GENERATION, message: 'Stale connection generation' }));
          return;
        }

        const reqSessionId = req.headers['mcp-session-id'];
        const sessStr = Array.isArray(reqSessionId) ? reqSessionId[0] : reqSessionId;
        if (endpoint.mcpSessionId) {
          // Once established, request MUST supply the matching session ID
          if (!sessStr || sessStr !== endpoint.mcpSessionId) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: ArloErrorCode.BINDING_MISMATCH,
                message: 'MCP session ID does not match root binding',
              })
            );
            return;
          }
        }

        const responseHeaders: Record<string, string> = { 'content-type': 'application/json' };
        if (endpoint.mcpSessionId) {
          responseHeaders['mcp-session-id'] = endpoint.mcpSessionId;
        }

        if (rpc.method === 'initialize') {
          const clientProtocolVersion = rpc.params?.protocolVersion;
          if (clientProtocolVersion && clientProtocolVersion !== ARLO_PINNED_WIRE_REVISION) {
            res.writeHead(400, responseHeaders);
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                error: {
                  code: -32602,
                  message: `${ArloErrorCode.UNSUPPORTED_VERSION}: Incompatible MCP wire revision "${clientProtocolVersion}". Expected "${ARLO_PINNED_WIRE_REVISION}"`,
                },
              })
            );
            return;
          }

          if (!endpoint.mcpSessionId) {
            if (sessStr) {
              res.writeHead(403, responseHeaders);
              res.end(JSON.stringify({ error: ArloErrorCode.BINDING_MISMATCH }));
              return;
            }
            endpoint.mcpSessionId = `mcp-sess-${crypto.randomUUID()}`;
          }
          responseHeaders['mcp-session-id'] = endpoint.mcpSessionId;

          const response = {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: ARLO_PINNED_WIRE_REVISION,
              capabilities: {
                tools: {},
                experimental: {
                  'arlo/session-messaging': { version: '0.1' },
                  [ARLO_CROSS_HOST_CAPABILITY]: { version: ARLO_CROSS_HOST_CAPABILITY_VERSION },
                },
              },
              serverInfo: { name: 'arlo-daemon', version: '0.1.0' },
            },
          };
          const resBody = JSON.stringify(response);
          res.writeHead(200, responseHeaders);
          res.end(resBody);
          return;
        }

        if (!endpoint.mcpSessionId) {
          res.writeHead(400, responseHeaders);
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              error: { code: -32002, message: 'Server not initialized: must call initialize first' },
            })
          );
          return;
        }

        if (rpc.method === 'notifications/initialized' && rpc.id === undefined) {
          // Completing MCP initialization does not publish reception readiness.
          res.writeHead(202);
          res.end();
          return;
        }

        if (rpc.method === 'tools/list') {
          // Model tools only: NO control operations
          const response = {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              tools: [
                {
                  name: 'arlo_list_sessions',
                  description: 'List other ready root sessions in the current communication group',
                  inputSchema: { type: 'object', properties: {} },
                },
                {
                  name: 'arlo_send_message',
                  description: 'Send a message to another ready root session in the same communication group',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      to: { type: 'string', description: 'Target endpoint ID' },
                      text: { type: 'string', description: 'Message text (UTF-8, max 32 KiB)' },
                      reply_to: {
                        type: 'string',
                        description:
                          'Optional message ID of an inbound message this endpoint has the right to reply to; the reply target must be that message\'s original sender',
                      },
                    },
                    required: ['to', 'text'],
                    additionalProperties: false,
                  },
                },
                {
                  name: 'arlo_get_message_status',
                  description:
                    'Query the reception status of a message this root session sent. Returns receipt metadata only, never message text or task completion.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      message_id: {
                        type: 'string',
                        description: 'Message ID returned by arlo_send_message',
                      },
                    },
                    required: ['message_id'],
                    additionalProperties: false,
                  },
                },
              ],
            },
          };
          const resBody = JSON.stringify(response);
          res.writeHead(200, responseHeaders);
          res.end(resBody);
          return;
        }

        if (rpc.method === 'tools/call') {
          const sendToolError = (message: string) => {
            res.writeHead(200, responseHeaders);
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: {
                  isError: true,
                  content: [{ type: 'text', text: message }],
                },
              })
            );
          };

          const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
          const declaredKeys = ArloDaemon.MODEL_TOOL_ARGUMENTS[rpc.params?.name as string] ?? [];
          const envelope = this.validateModelArguments(args, declaredKeys);
          if (!envelope.ok) {
            sendToolError(envelope.message);
            return;
          }

          if (rpc.params?.name === 'arlo_list_sessions') {
            const list: SessionDiscoveryItem[] = [...this.endpoints.values()]
              .filter(
                (e) =>
                  e.status === 'registered' &&
                  e.ready &&
                  e.deliverable &&
                  this.permitsCommunication(endpoint, e) &&
                  e.endpointId !== endpoint.endpointId
              )
              .map((e) => {
                const rt = this.runtimes.get(e.runtimeId);
                return {
                  endpoint_id: e.endpointId,
                  display_name: e.displayName,
                  host_type: rt?.hostType,
                  host_version: rt?.hostVersion,
                  host_kind: rt?.hostKind,
                  deliverable: true,
                };
              });

            const response = {
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(list) }],
              },
            };
            const resBody = JSON.stringify(response);
            res.writeHead(200, responseHeaders);
            res.end(resBody);
            return;
          }

          if (rpc.params?.name === 'arlo_send_message') {
            let sendResult;
            try {
              sendResult = await this.messageExchange.send(endpoint, args,
                rpc.params?._meta?.[ARLO_MESSAGE_ID_META_KEY], requestId, startReqTime);
            } catch (error) {
              if (!(error instanceof MessageAdmissionError) && !(error instanceof ArloError)) throw error;
              sendToolError(error.message);
              return;
            }
            const resBody = JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
              result: { content: [{ type: 'text', text: JSON.stringify(sendResult) }] } });
            res.writeHead(200, responseHeaders);
            res.end(resBody);
            this.logger.log({ event: LogEventCode.REQUEST_SERVED,
              status: sendResult.status === 'accepted' ? 'ok' : 'rejected', request_id: requestId,
              bytes: Buffer.byteLength(resBody), duration_ms: Date.now() - startReqTime });
            return;
          }

          if (rpc.params?.name === 'arlo_get_message_status') {
            if (typeof args.message_id !== 'string' || !args.message_id.trim()) {
              sendToolError('INVALID_ARGUMENT: "message_id" must be a non-empty string');
              return;
            }
            const result = this.messageExchange.status(endpoint, args.message_id);
            const resBody = JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
              result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
            res.writeHead(200, responseHeaders);
            res.end(resBody);
            this.logger.log({ event: LogEventCode.REQUEST_SERVED,
              status: result.status === 'receipt_conflict' ? 'error' : 'ok', request_id: requestId,
              bytes: Buffer.byteLength(resBody), duration_ms: Date.now() - startReqTime });
            return;
          }

          res.writeHead(404, responseHeaders);
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              error: { code: -32601, message: `Method not found: ${rpc.params?.name}` },
            })
          );
          return;
        }

        res.writeHead(404, responseHeaders);
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code: -32601, message: `Method not found: ${rpc.method}` },
          })
        );
        return;
      }

      // Standalone SSE stream over /mcp
      if (req.method === 'GET' && parsedUrl.pathname === '/mcp') {
        if (!token || !this.rootTokenToEndpoint.has(token)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          return;
        }

        if (this.staleTokens.has(token)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.STALE_GENERATION }));
          return;
        }

        const endpoint = this.rootTokenToEndpoint.get(token);
        if (!endpoint || endpoint.status === 'revoked') {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.UNAUTHORIZED }));
          return;
        }

        const reqEndpointId = req.headers['x-arlo-endpoint-id'];
        if (reqEndpointId && reqEndpointId !== endpoint.endpointId) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.BINDING_MISMATCH }));
          return;
        }

        const reqGeneration = req.headers['x-arlo-generation'];
        if (reqGeneration && Number(reqGeneration) !== endpoint.connectionGeneration) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.STALE_GENERATION }));
          return;
        }

        const reqSessionId = req.headers['mcp-session-id'];
        const sessStr = Array.isArray(reqSessionId) ? reqSessionId[0] : reqSessionId;
        if (!endpoint.mcpSessionId || sessStr !== endpoint.mcpSessionId) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.BINDING_MISMATCH }));
          return;
        }

        if (endpoint.sseStream && !endpoint.sseStream.writableEnded) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ArloErrorCode.BINDING_MISMATCH }));
          return;
        }
        endpoint.sseStream = res;

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'mcp-session-id': endpoint.mcpSessionId,
        });
        res.flushHeaders();

        req.on('close', () => {
          if (endpoint.sseStream === res) {
            this.invalidateConnection(endpoint);
          }
        });
        return;
      }

      // 404 for any other path
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND' }));
    } catch (err: any) {
      if (err instanceof MessageExchangeControlError && !res.headersSent) {
        res.writeHead(err.statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify(err.response));
        return;
      }
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: ArloErrorCode.CORRUPTED_STATE }));
      }
      this.logger.log({
        event: LogEventCode.ERROR_OCCURRED,
        status: 'error',
        request_id: requestId,
        bytes: 0,
        duration_ms: Date.now() - startReqTime,
      });
    }
  }

  private assertPrivateRuntime(): void {
    assertSafeStatePath(this.stateDir);
    for (const name of ['coordination.lock', 'daemon.lock', 'discovery.json', 'daemon.crt', 'daemon.key', 'bootstrap.token']) {
      const file = path.join(this.stateDir, name);
      const check = verifyWindowsAcl(file);
      if (!check.valid) throw new ArloError(check.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS);
      if (!fs.lstatSync(file).isFile()) throw new ArloError(ArloErrorCode.UNSAFE_LOCATION);
    }
    this.logger.assertSafeFiles();
  }

  private runDoctorChecks(): DiagnosticReport {
    const checks: DiagnosticCheckResult[] = [];

    const lockPath = path.join(this.stateDir, 'daemon.lock');
    const discPath = path.join(this.stateDir, 'discovery.json');
    const certPath = path.join(this.stateDir, 'daemon.crt');
    const keyPath = path.join(this.stateDir, 'daemon.key');
    const tokenPath = path.join(this.stateDir, 'bootstrap.token');
    const logPath = path.join(this.auditDir, 'daemon.log');

    // Batch inspect Windows ACLs in a single call for maximum performance and locality
    const aclMap = inspectWindowsAclBatch([
      this.stateDir,
      lockPath,
      discPath,
      certPath,
      keyPath,
      tokenPath,
      logPath,
    ]);

    // 1. State directory ACL
    const stateAcl = verifyWindowsAcl(this.stateDir, aclMap[this.stateDir]);
    checks.push({
      name: 'state_directory_acl',
      status: stateAcl.valid ? 'pass' : 'fail',
      error_code: stateAcl.errorCode,
    });

    // 2. Lock file verification
    const lockAcl = verifyWindowsAcl(lockPath, aclMap[lockPath]);
    checks.push({
      name: 'lock_file_ownership',
      status: lockAcl.valid ? 'pass' : 'fail',
      error_code: lockAcl.errorCode,
    });

    // 3. Discovery record verification
    const discAcl = verifyWindowsAcl(discPath, aclMap[discPath]);
    checks.push({
      name: 'discovery_record_acl',
      status: discAcl.valid ? 'pass' : 'fail',
      error_code: discAcl.errorCode,
    });

    // 4. TLS credentials verification
    const certAcl = verifyWindowsAcl(certPath, aclMap[certPath]);
    const keyAcl = verifyWindowsAcl(keyPath, aclMap[keyPath]);
    checks.push({
      name: 'tls_credentials_acl',
      status: certAcl.valid && keyAcl.valid ? 'pass' : 'fail',
      error_code: certAcl.errorCode ?? keyAcl.errorCode,
    });

    // 5. Bootstrap token verification
    const tokenAcl = verifyWindowsAcl(tokenPath, aclMap[tokenPath]);
    checks.push({
      name: 'bootstrap_credential_acl',
      status: tokenAcl.valid ? 'pass' : 'fail',
      error_code: tokenAcl.errorCode,
    });

    // 6. Listener verification
    checks.push({
      name: 'listener_loopback',
      status: this.server && this.actualPort > 0 ? 'pass' : 'fail',
    });

    // 7. Audit log verification
    const logAcl = fs.existsSync(logPath) ? verifyWindowsAcl(logPath, aclMap[logPath]) : { valid: true };
    checks.push({
      name: 'audit_log_rotation_and_acl',
      status: logAcl.valid ? 'pass' : 'fail',
      error_code: logAcl.errorCode,
    });

    // 8. Endpoint capacity check
    const activeCount = [...this.endpoints.values()].filter((e) => e.status === 'registered').length;
    checks.push({
      name: 'endpoint_capacity',
      status: activeCount <= ArloDaemon.MAX_REGISTERED_ENDPOINTS ? 'pass' : 'fail',
    });

    const allPassed = checks.every((c) => c.status === 'pass');

    return {
      daemon_id: this.daemonId,
      runtime: { executable: process.execPath, node: process.versions.node, platform: process.platform, arch: process.arch, pid: process.pid },
      overall_status: allPassed ? 'healthy' : 'failing',
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  async stop(): Promise<void> {
    this.stopping ??= this.stopOwnedInstance();
    return this.stopping;
  }

  private cancelIdleExit(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private canExitIdle(): boolean {
    return !this.isShuttingDown && this.connections.size === 0 && this.activeRequests === 0 &&
      this.messageExchange.canExitIdle();
  }

  private ownsPublishedInstance(): boolean {
    if (!this.releaseLock?.isHeld()) return false;
    try {
      assertSafeStatePath(this.stateDir);
      for (const name of ['daemon.lock', 'discovery.json']) {
        const file = path.join(this.stateDir, name);
        if (!fs.lstatSync(file).isFile() || !verifyWindowsAcl(file).valid) return false;
      }
      const lock = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'daemon.lock'), 'utf8'));
      const discovery = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'discovery.json'), 'utf8'));
      return lock.daemon_id === this.daemonId && lock.pid === process.pid &&
        discovery.daemon_id === this.daemonId && discovery.pid === process.pid &&
        discovery.port === this.actualPort && discovery.cert_fingerprint === this.certFingerprint;
    } catch { return false; }
  }

  private scheduleIdleExit(): void {
    if (this.idleTimeoutMs === undefined || this.idleTimer || !this.canExitIdle()) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // No await between the final checks and stop(): request and connection
      // admission closes synchronously before shutdown releases any resources.
      if (!this.canExitIdle() || !this.ownsPublishedInstance()) return;
      void this.stop().then(() => this.onIdleStopped?.()).catch(() => {});
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private async stopOwnedInstance(): Promise<void> {
    this.isShuttingDown = true;
    this.cancelIdleExit();
    for (const endpoint of this.endpoints.values()) clearTimeout(endpoint.leaseTimer);
    if (this.logger) {
      this.logger.log({
        event: LogEventCode.DAEMON_STOPPING,
        status: 'ok',
      });
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
        this.server!.closeAllConnections();
      });
    }

    // Clean resources ONLY owned by this daemon instance
    try {
      if (this.releaseLock) cleanInstanceResources(this.stateDir, this.daemonId, this.bootstrapToken);
      this.logger?.log({ event: LogEventCode.DAEMON_STOPPED, status: 'ok' });
      this.logger?.log({ event: LogEventCode.LOCK_RELEASED, status: 'ok' });
    } finally {
      this.logger?.close();
      try { await this.releaseAuditLock?.(); }
      finally {
        this.releaseAuditLock = undefined;
        await this.releaseLock?.();
        this.releaseLock = undefined;
      }
    }
  }
}
