import https from 'node:https';
import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import {
  ArloErrorCode,
  ArloError,
  type DaemonDiscoveryRecord,
  type DaemonStatusResponse,
  type DiagnosticReport,
  type RootRegistrationRequest,
} from '../protocol/index.ts';
import { resolveStateDir, readDiscoveryRecord, readBootstrapToken } from '../discovery/index.ts';
import { RootConnection } from '../root-connection/index.ts';
import { resolveCommunicationGroup, type ProjectGroupContext } from '../groups/index.ts';

export interface RootRegistrationOptions extends RootRegistrationRequest {
  /** Session creation directory / already confirmed Workspace; never process cwd. */
  project_context?: ProjectGroupContext;
}

export function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

export interface PinnedAgentOptions {
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  disableSessionResumption?: boolean;
}

export function createPinnedHttpsAgent(
  pinnedCertPem: string,
  options: PinnedAgentOptions = {}
): https.Agent {
  const x509 = new crypto.X509Certificate(pinnedCertPem);
  const pinnedFingerprint = crypto.createHash('sha256').update(x509.raw).digest('hex');

  return new https.Agent({
    ca: [pinnedCertPem],
    rejectUnauthorized: true,
    minVersion: options.minVersion ?? 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    maxCachedSessions: options.disableSessionResumption !== false ? 0 : 100,
    checkServerIdentity(_hostname, cert) {
      const serverFingerprint = crypto.createHash('sha256').update(cert.raw).digest('hex');
      if (serverFingerprint !== pinnedFingerprint) {
        const err = new ArloError(
          ArloErrorCode.PINNED_CERT_MISMATCH,
          `PINNED_CERT_MISMATCH: server certificate fingerprint does not match pinned certificate`
        );
        (err as any).code = 'ERR_TLS_CERT_ALTNAME_INVALID';
        throw err;
      }
      return undefined;
    },
  });
}

export interface SecureRequestOptions {
  url: string;
  agent: https.Agent;
  token?: string;
  body?: string;
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface SecureResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export function sendSecureArloRequest(options: SecureRequestOptions): Promise<SecureResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const resolve = (response: SecureResponse) => { clearTimeout(deadline); resolveResponse(response); };
    const reject = (error: unknown) => { clearTimeout(deadline); rejectResponse(error); };
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      return reject(new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Invalid URL'));
    }

    if (url.protocol !== 'https:') {
      return reject(new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Arlo transport strictly requires HTTPS'));
    }
    if (!isLoopback(url.hostname)) {
      return reject(new ArloError(ArloErrorCode.EXTERNAL_NETWORK_FORBIDDEN, `${url.hostname} is not loopback`));
    }

    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
    };
    if (options.token) {
      headers['authorization'] = `Bearer ${options.token}`;
    }
    if (options.body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(options.body));
    }

    const req = https.request(
      url,
      {
        method: options.method ?? (options.body ? 'POST' : 'GET'),
        agent: options.agent,
        headers,
        timeout: options.timeoutMs ?? 15000,
      },
      (res) => {
        const failResponse = () => {
          req.destroy();
          reject(new ArloError(ArloErrorCode.CONNECTION_FAILED, 'Response interrupted'));
        };
        res.once('aborted', failResponse);
        res.once('error', failResponse);
        const statusCode = res.statusCode ?? 0;
        if ([301, 302, 307, 308].includes(statusCode)) {
          reject(
            new ArloError(ArloErrorCode.REDIRECT_FORBIDDEN, `Redirects are forbidden (received HTTP ${statusCode})`)
          );
          req.destroy();
          return;
        }

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status: statusCode,
            headers: res.headers,
            body: data,
          });
        });
      }
    );

    const expire = () => {
      req.destroy();
      reject(new ArloError(ArloErrorCode.CONNECTION_FAILED, 'Request timed out'));
    };
    req.on('timeout', expire);
    // Socket inactivity alone permits an endless trickling response. Bound the
    // whole request, including connection setup and receipt of its complete body.
    deadline = setTimeout(expire, options.timeoutMs ?? 15000);

    req.on('error', (err: any) => {
      if (err instanceof ArloError) {
        return reject(err);
      }
      if (
        err.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
        err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        err.code === 'CERT_SIGNATURE_FAILURE' ||
        err.message?.includes('PINNED_CERT_MISMATCH')
      ) {
        return reject(new ArloError(ArloErrorCode.PINNED_CERT_MISMATCH, 'Certificate does not match pinned certificate'));
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        return reject(new ArloError(ArloErrorCode.DAEMON_NOT_RUNNING, 'Daemon connection refused'));
      }
      reject(new ArloError(ArloErrorCode.CONNECTION_FAILED, 'Connection to daemon failed'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

export interface DaemonClientOptions {
  stateDir?: string;
  discovery?: DaemonDiscoveryRecord;
  bootstrapToken?: string;
}

function readUnchangedDiscovery(stateDir: string, previous?: DaemonDiscoveryRecord): DaemonDiscoveryRecord {
  const current = readDiscoveryRecord(stateDir);
  if (previous && (current.daemon_id !== previous.daemon_id || current.port !== previous.port ||
      current.pid !== previous.pid || current.cert_fingerprint !== previous.cert_fingerprint)) {
    throw new ArloError(ArloErrorCode.DAEMON_NOT_RUNNING, 'Discovered instance changed');
  }
  return current;
}

function readUnchangedBootstrap(stateDir: string, previous?: string): string {
  const current = readBootstrapToken(stateDir);
  if (previous !== undefined && current !== previous) throw new ArloError(ArloErrorCode.UNAUTHORIZED);
  return current;
}

export class DaemonClient {
  private readonly stateDir?: string;
  private readonly fileDiscovery: boolean;
  private readonly fileBootstrap: boolean;
  private discoveryRecord?: DaemonDiscoveryRecord;
  private token?: string;
  private agent?: https.Agent;

  constructor(options: DaemonClientOptions = {}) {
    this.stateDir = options.stateDir ? resolveStateDir(options.stateDir) : undefined;
    this.discoveryRecord = options.discovery;
    this.token = options.bootstrapToken;
    this.fileDiscovery = options.discovery === undefined;
    this.fileBootstrap = options.bootstrapToken === undefined;
  }

  private initConnection(): { agent: https.Agent; discovery: DaemonDiscoveryRecord; token: string } {
    if (!this.discoveryRecord || (this.fileDiscovery && process.platform === 'linux')) {
      this.discoveryRecord = readUnchangedDiscovery(resolveStateDir(this.stateDir), this.discoveryRecord);
    }
    if (this.token === undefined || (this.fileBootstrap && process.platform === 'linux')) {
      this.token = readUnchangedBootstrap(resolveStateDir(this.stateDir), this.token);
    }
    if (!this.agent) {
      this.agent = createPinnedHttpsAgent(this.discoveryRecord.cert_pem, {
        minVersion: 'TLSv1.2',
        disableSessionResumption: true,
      });
    }
    return {
      agent: this.agent,
      discovery: this.discoveryRecord,
      token: this.token,
    };
  }

  private async request<T>(endpointPath: string): Promise<T> {
    const { agent, discovery, token } = this.initConnection();
    const url = `https://127.0.0.1:${discovery.port}${endpointPath}`;
    const res = await sendSecureArloRequest({
      url,
      agent,
      token,
      method: 'GET',
    });

    if (res.status === 401) {
      throw new ArloError(ArloErrorCode.UNAUTHORIZED, 'Authentication failed');
    }
    if (res.status !== 200) {
      throw new ArloError(ArloErrorCode.CONNECTION_FAILED, `Request failed with HTTP ${res.status}`);
    }

    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Invalid JSON in response');
    }
  }

  async getStatus(): Promise<DaemonStatusResponse> {
    return this.request<DaemonStatusResponse>('/control/v1/status');
  }

  async getDoctor(): Promise<DiagnosticReport> {
    return this.request<DiagnosticReport>('/control/v1/doctor');
  }

  async listRoots(): Promise<import('../protocol/index.ts').EndpointDiagnosticInfo[]> {
    return this.request<import('../protocol/index.ts').EndpointDiagnosticInfo[]>('/control/v1/roots');
  }
}

export interface ControlClientOptions {
  stateDir?: string;
  discovery?: DaemonDiscoveryRecord;
  bootstrapToken?: string;
  pinnedCertPem?: string;
  port?: number;
}

export class ControlClient {
  private readonly stateDir?: string;
  private readonly fileDiscovery: boolean;
  private readonly fileBootstrap: boolean;
  private discoveryRecord?: DaemonDiscoveryRecord;
  private bootstrapToken?: string;
  private agent?: https.Agent;
  private pinnedCertPem?: string;
  private port?: number;
  private refreshing?: Promise<string>;
  private authenticatedDaemonId?: string;
  private refreshingAgent?: https.Agent;
  private disposed = false;

  constructor(options: ControlClientOptions = {}) {
    this.stateDir = options.stateDir ? resolveStateDir(options.stateDir) : undefined;
    this.discoveryRecord = options.discovery;
    this.bootstrapToken = options.bootstrapToken;
    this.pinnedCertPem = options.pinnedCertPem;
    this.port = options.port;
    this.fileDiscovery = !options.discovery && (!options.pinnedCertPem || !options.port);
    this.fileBootstrap = options.bootstrapToken === undefined;
  }

  get daemonId(): string | undefined {
    return this.authenticatedDaemonId ?? this.discoveryRecord?.daemon_id;
  }

  /** Re-read protected discovery and authenticate a fresh pinned TLS connection.
   * Only control state is recovered here; no business request is retried. */
  refreshConnection(): Promise<string> {
    if (this.disposed) return Promise.reject(new ArloError(ArloErrorCode.CHANNEL_NOT_READY));
    return this.refreshing ??= this.refreshOnce().finally(() => { this.refreshing = undefined; });
  }

  /** Release this client's control transport, never the shared Daemon. */
  dispose(): void {
    this.disposed = true;
    this.agent?.destroy();
    this.refreshingAgent?.destroy();
    this.bootstrapToken = undefined;
    this.authenticatedDaemonId = undefined;
  }

  private async refreshOnce(): Promise<string> {
    const discovery = this.fileDiscovery ? readDiscoveryRecord(resolveStateDir(this.stateDir)) : this.discoveryRecord;
    const certPem = this.pinnedCertPem ?? discovery!.cert_pem;
    const port = this.fileDiscovery ? discovery!.port : this.port ?? discovery!.port;
    const bootstrapToken = this.fileBootstrap ? readBootstrapToken(resolveStateDir(this.stateDir)) : this.bootstrapToken!;
    const agent = createPinnedHttpsAgent(certPem);
    this.refreshingAgent = agent;
    try {
      const response = await sendSecureArloRequest({
        url: `https://127.0.0.1:${port}/control/v1/status`, agent, token: bootstrapToken,
      });
      if (this.disposed) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      if (response.status !== 200) throw new ArloError(ArloErrorCode.UNAUTHORIZED);
      const status = JSON.parse(response.body) as DaemonStatusResponse;
      if (!status.daemon_id || status.status !== 'ready' || discovery && status.daemon_id !== discovery.daemon_id) {
        throw new ArloError(ArloErrorCode.BINDING_MISMATCH);
      }
      // A new root reauthenticates discovery on its own TLS connection, but
      // other roots can still be using this runtime's control agent for ACKs,
      // readiness or heartbeats. Preserve those requests only when the newly
      // authenticated daemon, certificate and port all match the current trust.
      const sameConnectionIdentity = this.authenticatedDaemonId === status.daemon_id &&
        (this.pinnedCertPem ?? this.discoveryRecord?.cert_pem) === certPem &&
        (this.port ?? this.discoveryRecord?.port) === port;
      if (this.agent && sameConnectionIdentity) {
        agent.destroy();
      } else {
        this.agent?.destroy();
        this.agent = agent;
      }
      this.discoveryRecord = discovery;
      if (this.fileDiscovery) this.port = port;
      this.bootstrapToken = bootstrapToken;
      this.authenticatedDaemonId = status.daemon_id;
      return status.daemon_id;
    } catch (error) {
      agent.destroy();
      throw error instanceof ArloError ? error : new ArloError(ArloErrorCode.CORRUPTED_STATE);
    } finally {
      if (this.refreshingAgent === agent) this.refreshingAgent = undefined;
    }
  }

  private initConnection(needsBootstrap: boolean): { agent: https.Agent; port: number; certPem: string; bootstrapToken: string } {
    if (this.disposed) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    if (this.fileDiscovery && (!this.discoveryRecord || process.platform === 'linux')) {
      this.discoveryRecord = readUnchangedDiscovery(resolveStateDir(this.stateDir), this.discoveryRecord);
    }
    const certPem = this.pinnedCertPem ?? this.discoveryRecord!.cert_pem;
    const port = this.port ?? this.discoveryRecord!.port;
    if (needsBootstrap && (this.bootstrapToken === undefined || (this.fileBootstrap && process.platform === 'linux'))) {
      this.bootstrapToken = readUnchangedBootstrap(resolveStateDir(this.stateDir), this.bootstrapToken);
    }
    if (!this.agent) {
      this.agent = createPinnedHttpsAgent(certPem, {
        minVersion: 'TLSv1.2',
        disableSessionResumption: true,
      });
    }
    return {
      agent: this.agent,
      port,
      certPem,
      bootstrapToken: this.bootstrapToken ?? '',
    };
  }

  private async request<T>(
    endpointPath: string,
    options: { method?: string; token?: string; body?: unknown } = {}
  ): Promise<T> {
    const { agent, port, bootstrapToken } = this.initConnection(options.token === undefined);
    const token = options.token ?? bootstrapToken;
    const url = `https://127.0.0.1:${port}${endpointPath}`;
    const bodyStr = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const res = await sendSecureArloRequest({
      url,
      agent,
      token,
      method: options.method ?? (bodyStr ? 'POST' : 'GET'),
      body: bodyStr,
    });

    if (res.status !== 200) {
      try {
        const parsed = JSON.parse(res.body);
        if (parsed.error) {
          throw new ArloError(parsed.error, parsed.message);
        }
      } catch (e) {
        if (e instanceof ArloError) throw e;
      }
      if (res.status === 401) {
        throw new ArloError(ArloErrorCode.UNAUTHORIZED, 'Authentication failed');
      }
      if (res.status === 403) {
        throw new ArloError(ArloErrorCode.UNAUTHORIZED, 'Access forbidden');
      }
      if (res.status === 400) {
        throw new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Bad request');
      }
      if (res.status === 409) {
        throw new ArloError(ArloErrorCode.RECEIPT_CONFLICT, 'Conflict');
      }
      if (res.status === 429) {
        throw new ArloError(ArloErrorCode.QUEUE_LIMIT, 'Maximum registered endpoints limit reached');
      }
      if (res.status === 404) {
        throw new ArloError(ArloErrorCode.TARGET_UNAVAILABLE, 'Target resource not found');
      }
      throw new ArloError(ArloErrorCode.CONNECTION_FAILED, `Request failed with HTTP ${res.status}`);
    }

    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Invalid JSON in response');
    }
  }

  async registerRuntime(
    options: import('../protocol/index.ts').RuntimeRegistrationRequest = {}
  ): Promise<import('../protocol/index.ts').RuntimeRegistrationResponse> {
    return this.request<import('../protocol/index.ts').RuntimeRegistrationResponse>(
      '/control/v1/runtimes/register',
      {
        method: 'POST',
        body: options,
      }
    );
  }

  async reauthenticateRuntime(
    options: import('../protocol/index.ts').RuntimeReauthenticationRequest
  ): Promise<import('../protocol/index.ts').RuntimeRegistrationResponse> {
    return this.request('/control/v1/runtimes/reauthenticate', { body: options });
  }

  async getRuntimeParticipation(token: string): Promise<import('../protocol/index.ts').RuntimeParticipationState> {
    const state = await this.request<import('../protocol/index.ts').RuntimeParticipationState>(
      '/control/v1/runtimes/participation', { token });
    if (typeof state.cross_host_enabled !== 'boolean' || typeof state.revision !== 'string' || !/^[a-f0-9]{64}$/.test(state.revision)) {
      throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
    }
    return state;
  }

  /** Trusted plugin settings only; model tools cannot update participation.
   * Settings readers capture the revision before reading their shared file. */
  async updateRuntimeParticipation(token: string, enabled: boolean, revision?: string): Promise<import('../protocol/index.ts').RuntimeParticipationState> {
    const expected = revision ?? (await this.getRuntimeParticipation(token)).revision;
    return this.request('/control/v1/runtimes/participation', {
      token, body: { cross_host_enabled: enabled, revision: expected },
    });
  }

  async heartbeatRoot(
    token: string,
    options: import('../protocol/index.ts').RootHeartbeatRequest
  ): Promise<import('../protocol/index.ts').RootHeartbeatResponse> {
    return this.request('/control/v1/roots/heartbeat', { token, body: options });
  }

  async authorizeRoot(token: string, options: import('../protocol/index.ts').RootSendingRequest & { request_id: string }): Promise<import('../protocol/index.ts').RootSendingStatus> {
    return this.readSendingStatus('/control/v1/roots/authorize', token, options);
  }

  async getRootSendingStatus(token: string,
    options: import('../protocol/index.ts').RootSendingRequest
  ): Promise<import('../protocol/index.ts').RootSendingStatus> {
    return this.readSendingStatus('/control/v1/roots/sending-status', token, options);
  }

  /** Only a trusted host can attest a witnessed native creation. Replays never
   * install another period, including after lost usage or a daemon restart. */
  async initializeRootSending(token: string,
    options: import('../protocol/index.ts').InitializeRootSendingRequest
  ): Promise<import('../protocol/index.ts').RootSendingStatus> {
    return this.readSendingStatus('/control/v1/roots/initialize-sending', token, options);
  }

  /** Only the trusted human command may create a request. Keep the same ID,
   * sequence, daemon and binding when retrying an ambiguous response. */
  async prepareContinuation(token: string,
    options: import('../protocol/index.ts').RootSendingRequest & { request_id: string }
  ): Promise<import('../protocol/index.ts').ContinueCollaborationRequest> {
    const request = await this.request<import('../protocol/index.ts').ContinueCollaborationRequest>(
      '/control/v1/roots/prepare-continuation', { token, body: options });
    if (!request || request.endpoint_id !== options.endpoint_id || request.generation !== options.generation ||
        request.request_id !== options.request_id || typeof request.daemon_id !== 'string' || !request.daemon_id ||
        !Number.isSafeInteger(request.sequence) || request.sequence < 1) throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
    return request;
  }

  /** Applies the original prepared request; current status never replaces it. */
  async continueCollaboration(token: string,
    options: import('../protocol/index.ts').ContinueCollaborationRequest
  ): Promise<import('../protocol/index.ts').RootSendingStatus> {
    return this.readSendingStatus('/control/v1/roots/continue-collaboration', token, options);
  }

  /** Trusted command only; a stale snapshot cannot replace newer rules. */
  async reloadSendingRules(token: string,
    options: import('../protocol/index.ts').ReloadSendingRulesRequest
  ): Promise<import('../protocol/index.ts').RootSendingStatus> {
    return this.readSendingStatus('/control/v1/roots/reload-sending-rules', token, options);
  }

  private async readSendingStatus(route: string, token: string,
    options: import('../protocol/index.ts').RootSendingRequest
  ): Promise<import('../protocol/index.ts').RootSendingStatus> {
    const state = await this.request<import('../protocol/index.ts').RootSendingStatus>(route, { token, body: options });
    if (!state || !['bounded', 'continuous'].includes(state.mode) || typeof state.daemon_id !== 'string' ||
        typeof state.rules_revision !== 'string' || !state.rules_revision || state.rules_revision.length > 256 ||
        (state.rules_error !== null && (typeof state.rules_error !== 'string' || state.rules_error.length > 1024)) ||
        !Number.isSafeInteger(state.control_sequence) || state.control_sequence < 0 ||
        !Number.isSafeInteger(state.next_grant) || state.next_grant <= 0 ||
        !['known', 'unknown'].includes(state.knowledge) ||
        ![null, ArloErrorCode.ALLOWANCE_UNKNOWN, ArloErrorCode.ALLOWANCE_EXHAUSTED].includes(state.pause_reason) ||
        !state.root_configuration || state.root_configuration.root_authenticated !== true ||
        (state.initial_allowance !== undefined && (!state.initial_allowance ||
          !['unknown', 'available', 'consumed'].includes(state.initial_allowance.eligibility) ||
          !['FIRST_USE_UNPROVEN', 'FIRST_USE_VERIFIED', 'INITIAL_ALLOWANCE_CONSUMED',
            'OWNERSHIP_UNVERIFIED', 'HISTORY_UNAVAILABLE', 'DISPATCH_HISTORY_PRESENT', 'CAPACITY_EXHAUSTED'].includes(state.initial_allowance.reason) ||
          typeof state.initial_allowance.guidance !== 'string' || !state.initial_allowance.guidance)) ||
        (state.period_id !== null && typeof state.period_id !== 'string') ||
        (state.granted !== null && (!Number.isSafeInteger(state.granted) || state.granted <= 0)) ||
        (state.mode === 'continuous' && (state.remaining !== null || state.pause_reason !== null ||
          !['verified', 'user-authorized'].includes(state.root_configuration.ownership))) ||
        (state.knowledge === 'unknown' && (state.used !== null || state.remaining !== null ||
          state.pause_reason !== (state.mode === 'bounded' ? ArloErrorCode.ALLOWANCE_UNKNOWN : null))) ||
        (state.knowledge === 'known' && (state.period_id === null || state.granted === null ||
          !Number.isSafeInteger(state.used) || state.used! < 0 ||
          state.mode === 'bounded' && (!Number.isSafeInteger(state.remaining) ||
            state.remaining !== Math.max(0, state.granted - state.used!) ||
            state.pause_reason !== (state.remaining === 0 ? ArloErrorCode.ALLOWANCE_EXHAUSTED : null))))) {
      throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
    }
    return state;
  }

  /** Trusted adapter query only. The authenticated ready root and its current
   * generation select the owner; callers cannot provide a configuration ID. */
  async getRootConfiguration(
    token: string,
    options: import('../protocol/index.ts').RootConfigurationRequest
  ): Promise<import('../protocol/index.ts').RootConfigurationStatus> {
    const state = await this.request<import('../protocol/index.ts').RootConfigurationStatus>(
      '/control/v1/roots/configuration', { token, body: options });
    const reasons: readonly import('../protocol/index.ts').RootConfigurationReason[] = [
      'USER_AUTHORIZED', 'AUTHORIZATION_REQUIRED', 'BOUND', 'EVIDENCE_UNAVAILABLE', 'EVIDENCE_INVALID', 'OWNER_CONFLICT',
      'HISTORY_MISSING', 'HISTORY_CORRUPT', 'STORAGE_UNAVAILABLE', 'CAPACITY_EXHAUSTED',
    ];
    if (!state || state.root_authenticated !== true || state.history !== 'unknown' ||
        !['verified', 'user-authorized', 'unknown', 'conflict'].includes(state.ownership) || !reasons.includes(state.reason) ||
        typeof state.config_path !== 'string' || !state.config_path ||
        typeof state.guidance !== 'string' || !state.guidance ||
        (['verified', 'user-authorized'].includes(state.ownership)
          ? typeof state.config_id !== 'string' || !state.config_id || state.reason !== (state.ownership === 'verified' ? 'BOUND' : 'USER_AUTHORIZED')
          : state.config_id !== null)) {
      throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
    }
    return state;
  }

  async registerRoot(
    runtimeToken: string,
    options: RootRegistrationOptions
  ): Promise<import('../protocol/index.ts').RootRegistrationResponse> {
    const { project_context, ...registration } = options;
    if (registration.group_name !== undefined && registration.project_group_id !== undefined) {
      throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
    }
    if (registration.group_name === undefined && registration.project_group_id === undefined) {
      const group = await resolveCommunicationGroup(project_context);
      if (group.source === 'explicit') registration.group_name = group.groupName;
      else registration.project_group_id = group.groupId;
    }
    return this.request<import('../protocol/index.ts').RootRegistrationResponse>(
      '/control/v1/roots/register',
      {
        method: 'POST',
        token: runtimeToken,
        body: registration,
      }
    );
  }

  async connectRoot(
    token: string,
    options: import('../protocol/index.ts').ConnectRootRequest
  ): Promise<import('../protocol/index.ts').ConnectRootResponse> {
    return this.request<import('../protocol/index.ts').ConnectRootResponse>(
      '/control/v1/roots/connect',
      {
        method: 'POST',
        token,
        body: options,
      }
    );
  }

  createRootConnection(
    binding: import('../protocol/index.ts').RootRegistrationResponse,
    options: { heartbeat?: boolean; requireCrossHostParticipation?: boolean } = {}
  ): RootConnection {
    const { port, certPem } = this.initConnection(false);
    return new RootConnection({
      url: new URL(`https://127.0.0.1:${port}/mcp`),
      agent: createPinnedHttpsAgent(certPem),
      binding,
      requireCrossHostParticipation: options.requireCrossHostParticipation,
      heartbeat: options.heartbeat === false ? undefined : () => this.heartbeatRoot(binding.root_token, {
        endpoint_id: binding.endpoint_id, generation: binding.generation,
      }),
    });
  }

  async revokeRoot(
    token: string,
    options: import('../protocol/index.ts').RevokeRootRequest
  ): Promise<import('../protocol/index.ts').RevokeRootResponse> {
    return this.request<import('../protocol/index.ts').RevokeRootResponse>(
      '/control/v1/roots/revoke',
      {
        method: 'POST',
        token,
        body: options,
      }
    );
  }

  async revokeRuntime(
    runtimeToken: string
  ): Promise<import('../protocol/index.ts').RevokeRuntimeResponse> {
    return this.request<import('../protocol/index.ts').RevokeRuntimeResponse>(
      '/control/v1/runtimes/revoke',
      {
        method: 'POST',
        token: runtimeToken,
      }
    );
  }

  async confirmRootReady(
    token: string,
    options: import('../protocol/index.ts').ReadyRootRequest
  ): Promise<import('../protocol/index.ts').ReadyRootResponse> {
    return this.request<import('../protocol/index.ts').ReadyRootResponse>(
      '/control/v1/roots/ready',
      {
        method: 'POST',
        token,
        body: options,
      }
    );
  }

  async submitReceipt(
    token: string,
    receipt: import('../protocol/index.ts').RootReceiptRequest
  ): Promise<import('../protocol/index.ts').RootReceiptResponse> {
    return this.request<import('../protocol/index.ts').RootReceiptResponse>(
      '/control/v1/roots/receipt',
      {
        method: 'POST',
        token,
        body: receipt,
      }
    );
  }

  async releaseCredit(
    token: string,
    release: import('../protocol/index.ts').RootCreditReleaseRequest
  ): Promise<import('../protocol/index.ts').RootCreditReleaseResponse> {
    return this.request<import('../protocol/index.ts').RootCreditReleaseResponse>(
      '/control/v1/roots/credit',
      {
        method: 'POST',
        token,
        body: release,
      }
    );
  }

  async listRoots(token?: string): Promise<import('../protocol/index.ts').EndpointDiagnosticInfo[]> {
    return this.request<import('../protocol/index.ts').EndpointDiagnosticInfo[]>(
      '/control/v1/roots',
      {
        method: 'GET',
        token,
      }
    );
  }
}
