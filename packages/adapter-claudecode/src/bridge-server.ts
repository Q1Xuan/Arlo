import http from 'node:http';
import crypto from 'node:crypto';
import { ArloError } from '@arlo/sdk';
import {
  BRIDGE_CONTRACT_VERSION,
  BRIDGE_ERROR_CODES,
  BridgeRequestError,
  correlationMarker,
  type BridgeContractConfig,
  type BridgeErrorResponse,
  type BridgeStatusResponse,
  type BridgeHandshakeResponse,
  type BridgeSettleResponse,
  type BridgeClaimResponse,
  type BridgeHandshakeRequest,
  type BridgeSettleRequest,
  type BridgeClaimRequest,
  type BridgeIdentity,
  type BridgeToolCallRequest,
  type BridgeToolCallResponse,
  type BridgeCommandRequest,
} from './contract.ts';

interface BridgeResponse {
  status: number;
  body: unknown;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeRequestError(400, 'INVALID_ARGUMENT', 'Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function handshakeBody(value: unknown): BridgeHandshakeRequest {
  const body = objectBody(value);
  if (body.modVersion !== '0.1.0' || !Array.isArray(body.capabilities) ||
      !body.capabilities.every((item) => typeof item === 'string') || !body.capabilities.includes('prompt.submit')) {
    throw new BridgeRequestError(400, 'INVALID_ARGUMENT', 'Expected Mod version 0.1.0 and prompt.submit capability');
  }
  return body as unknown as BridgeHandshakeRequest;
}

function toolCallBody(value: unknown): BridgeToolCallRequest {
  const body = objectBody(value);
  if (typeof body.name !== 'string' || !['arlo_list_sessions', 'arlo_send_message', 'arlo_get_message_status'].includes(body.name) ||
      !Object.hasOwn(body, 'arguments') || Object.keys(body).some(key => key !== 'name' && key !== 'arguments')) {
    throw new BridgeRequestError(400, 'INVALID_ARGUMENT', 'Expected a supported tool name and arguments');
  }
  return body as unknown as BridgeToolCallRequest;
}

function commandBody(value: unknown): BridgeCommandRequest {
  const body = objectBody(value);
  if (typeof body.name !== 'string' || !['arlo-authorize', 'arlo-send-status', 'arlo-continue',
    'arlo-reload-sending-rules', 'arlo-settings', 'arlo-root-config'].includes(body.name) ||
      typeof body.arguments !== 'string' ||
      (body.operationId !== undefined && (typeof body.operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.operationId))) ||
      Object.keys(body).some(key => !['name', 'arguments', 'operationId'].includes(key))) {
    throw new BridgeRequestError(400, 'INVALID_ARGUMENT', 'Expected a supported human command and arguments');
  }
  const args = body.arguments.trim();
  if (body.name === 'arlo-settings' ? !['', 'on', 'off'].includes(args) : args !== '') {
    throw new BridgeRequestError(400, 'INVALID_ARGUMENT', body.name === 'arlo-settings'
      ? 'Use /arlo-settings with on, off, or no arguments.' : `Use /${body.name} with no arguments.`);
  }
  return { name: body.name as BridgeCommandRequest['name'], arguments: args,
    ...(body.operationId === undefined ? {} : { operationId: body.operationId as string }) };
}

function settleBody(value: unknown): BridgeSettleRequest {
  const body = objectBody(value);
  if (typeof body.nativeMessageId !== 'string' || !body.nativeMessageId.trim() ||
      (body.messageId !== undefined && (typeof body.messageId !== 'string' || !body.messageId.trim())) ||
      typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp) || body.timestamp < 0 ||
      (body.reason !== undefined && typeof body.reason !== 'string') ||
      typeof body.status !== 'string' || !['enqueued', 'dispatching', 'submitting', 'discarded', 'unknown'].includes(body.status)) {
    throw new BridgeRequestError(400, 'INVALID_ARGUMENT', 'Invalid message report; claimed settlement belongs to #88');
  }
  return body as unknown as BridgeSettleRequest;
}

function claimBody(value: unknown): BridgeClaimRequest {
  const body = objectBody(value);
  if (typeof body.nativeMessageId !== 'string' || !body.nativeMessageId.trim() ||
      (body.messageId !== undefined && (typeof body.messageId !== 'string' || !body.messageId.trim())) ||
      typeof body.correlationMarker !== 'string' || !body.correlationMarker.trim() ||
      typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp) || body.timestamp < 0 ||
      (body.turnId !== undefined && (typeof body.turnId !== 'string' || !body.turnId.trim()))) {
    throw new BridgeRequestError(400, 'INVALID_ARGUMENT', 'Invalid claim evidence; a correlation marker is required');
  }
  return body as unknown as BridgeClaimRequest;
}

function canonicalBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalBody);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalBody(item)]));
  }
  return value;
}

export class ClaudeCodeBridgeServer {
  private currentSessionId: string;
  readonly instanceId = crypto.randomUUID();
  private generation = 0;
  private readonly token: string;
  private readonly host: string;
  private readonly configuredPort: number;
  private receptionHost?: BridgeContractConfig['receptionHost'];
  private readonly onHandshake?: () => void;
  private readonly onRetire?: () => void;
  private readonly onActivate?: BridgeContractConfig['onActivate'];
  private readonly onToolCall?: BridgeContractConfig['onToolCall'];
  private readonly onCommand?: BridgeContractConfig['onCommand'];
  private state: BridgeStatusResponse['status'] = 'active';
  private activating = false;
  private server?: http.Server;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private boundPort = 0;
  private readonly idempotencyCache = new Map<string, BridgeResponse & { fingerprint: string; generation: number }>();

  constructor(config: BridgeContractConfig) {
    if (!config.sessionId) throw new Error('sessionId is required');
    if (!config.token) throw new Error('token is required');
    this.currentSessionId = config.sessionId;
    this.token = config.token;
    this.host = config.host || '127.0.0.1';
    this.configuredPort = config.port ?? 0;
    this.receptionHost = config.receptionHost;
    this.onHandshake = config.onHandshake;
    this.onRetire = config.onRetire;
    this.onActivate = config.onActivate;
    this.onToolCall = config.onToolCall;
    this.onCommand = config.onCommand;
  }

  get sessionId(): string {
    return this.currentSessionId;
  }

  get port(): number {
    return this.boundPort;
  }

  get url(): string {
    return `http://${this.host}:${this.boundPort}`;
  }

  start(): Promise<void> {
    if (this.state === 'stopped') return Promise.reject(new Error('Bridge is stopped'));
    return this.starting ??= new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          const response = this.errorResponse(err);
          this.sendJson(res, response.status, response.body);
        });
      });

      server.on('error', reject);
      this.server = server;

      server.listen(this.configuredPort, this.host, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          this.boundPort = address.port;
        }
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.state !== 'stopped') {
      this.state = 'stopped';
      this.advanceGeneration();
    }
    return this.stopping = (async () => {
      await this.starting?.catch(() => {});
      const server = this.server;
      if (!server?.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        server.closeAllConnections();
      });
    })();
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  }

  private errorResponse(error: unknown): BridgeResponse {
    if (error instanceof SyntaxError) {
      error = new BridgeRequestError(400, 'INVALID_ARGUMENT', 'Malformed JSON payload');
    }
    const known = error instanceof BridgeRequestError ? error : undefined;
    const runtimeError = error instanceof ArloError ? error : undefined;
    return {
      status: known?.statusCode ?? (runtimeError ? 400 : 500),
      body: { error: {
        code: known?.code ?? runtimeError?.code ?? BRIDGE_ERROR_CODES.INTERNAL_ERROR,
        message: known?.message ?? runtimeError?.message ?? 'Unexpected internal Sidecar failure',
        details: null,
      } } satisfies BridgeErrorResponse,
    };
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) {
      return undefined;
    }
    return JSON.parse(text) as unknown;
  }

  private safeCompareToken(provided: string): boolean {
    const expectedBuf = Buffer.from(this.token);
    const providedBuf = Buffer.from(provided);
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  }

  private identity(): BridgeIdentity {
    return { sessionId: this.sessionId, instanceId: this.instanceId, generation: this.generation };
  }

  private advanceGeneration(): void {
    this.generation++;
    this.idempotencyCache.clear();
  }

  private assertActive(): void {
    if (this.state !== 'active') {
      throw new BridgeRequestError(409, 'CONFLICT', 'Bridge context is not active');
    }
  }

  private assertCurrent(req: http.IncomingMessage): void {
    const instance = req.headers['x-bridge-instance'];
    const generation = req.headers['x-bridge-generation'];
    if (typeof instance !== 'string' || !instance.trim() || typeof generation !== 'string' ||
        !/^(0|[1-9]\d*)$/.test(generation) || !Number.isSafeInteger(Number(generation))) {
      throw new BridgeRequestError(400, 'INVALID_ARGUMENT', 'Bridge instance and generation headers are required');
    }
    if (req.headers['x-session-id'] !== this.sessionId || instance !== this.instanceId || Number(generation) !== this.generation) {
      throw new BridgeRequestError(409, 'STALE_BINDING', 'Bridge binding has been replaced');
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new BridgeRequestError(401, 'UNAUTHORIZED', 'Missing or malformed Authorization header');
    }

    const providedToken = authHeader.slice('Bearer '.length).trim();
    if (!this.safeCompareToken(providedToken)) {
      throw new BridgeRequestError(401, 'UNAUTHORIZED', 'Invalid bridge bearer token');
    }

    const sessionIdHeader = req.headers['x-session-id'];
    if (!sessionIdHeader) {
      throw new BridgeRequestError(400, 'INVALID_ARGUMENT', 'Missing x-session-id header');
    }

    const url = new URL(req.url || '/', this.url);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase();
    const isStatus = method === 'GET' && pathname === '/api/v1/bridge/status';
    if (sessionIdHeader !== this.sessionId && !(isStatus && this.state === 'draining')) {
      throw new BridgeRequestError(403, 'SESSION_MISMATCH', 'Session ID does not match bridge session binding');
    }

    if (isStatus) {
      const statusResponse: BridgeStatusResponse = {
        ...this.identity(),
        status: this.state,
        version: '0.1.0',
        contractVersion: BRIDGE_CONTRACT_VERSION,
      };
      this.sendJson(res, 200, statusResponse);
      return;
    }

    this.assertCurrent(req);

    if (method === 'POST' && pathname === '/api/v1/bridge/session/activate') {
      const raw = await this.readJsonBody(req);
      this.assertCurrent(req);
      const body = objectBody(raw);
      if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
        throw new BridgeRequestError(400, 'INVALID_ARGUMENT', 'A verified host sessionId is required');
      }
      if (this.state !== 'draining' || this.activating || !this.onActivate) {
        throw new BridgeRequestError(409, 'CONFLICT', 'Bridge context cannot be activated');
      }
      this.activating = true;
      try {
        const reception = await this.onActivate(body.sessionId);
        this.assertCurrent(req);
        this.currentSessionId = body.sessionId;
        this.receptionHost = reception;
        this.advanceGeneration();
        this.state = 'active';
        this.sendJson(res, 200, { ...this.identity(), accepted: true, contractVersion: BRIDGE_CONTRACT_VERSION });
      } finally {
        this.activating = false;
      }
      return;
    }

    this.assertActive();

    if (method === 'POST' && pathname === '/api/v1/bridge/commands/call') {
      const raw = await this.readJsonBody(req);
      this.assertCurrent(req);
      this.assertActive();
      const body = commandBody(raw);
      if (!this.onCommand) throw new BridgeRequestError(404, 'NOT_FOUND', 'Human commands are not available');
      let result;
      try {
        result = await this.onCommand(body, this.identity());
      } finally {
        this.assertCurrent(req);
        this.assertActive();
      }
      this.sendJson(res, 200, result);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/bridge/tools/call') {
      const raw = await this.readJsonBody(req);
      this.assertCurrent(req);
      this.assertActive();
      const body = toolCallBody(raw);
      if (!this.onToolCall) throw new BridgeRequestError(404, 'NOT_FOUND', 'Model tools are not available');
      let content: BridgeToolCallResponse['content'];
      try {
        content = await this.onToolCall(body, this.identity());
      } finally {
        // Errors belong to this attachment too; neither outcome may escape
        // after a handshake, retirement or context replacement.
        this.assertCurrent(req);
        this.assertActive();
      }
      this.sendJson(res, 200, { content } satisfies BridgeToolCallResponse);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/bridge/session/retire') {
      await this.readJsonBody(req);
      this.assertCurrent(req);
      this.assertActive();
      this.state = 'draining';
      this.advanceGeneration();
      if (this.onRetire) this.onRetire();
      else this.receptionHost?.retire?.();
      this.sendJson(res, 200, { ...this.identity(), status: 'draining', contractVersion: BRIDGE_CONTRACT_VERSION });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/bridge/messages/pending') {
      const messages = this.receptionHost
        ? this.receptionHost.getPendingMessages().map((record) => ({
            nativeMessageId: record.nativeMessageId,
            messageId: record.messageId,
            text: record.text,
            ...(record.correlationId === undefined ? {} : { correlationMarker: correlationMarker(record.correlationId) }),
            fromEndpoint: record.fromEndpoint,
            enqueuedAt: record.enqueuedAt,
          }))
        : [];
      this.sendJson(res, 200, { messages });
      return;
    }

    const isHandshake = pathname === '/api/v1/bridge/handshake';
    const isClaim = pathname === '/api/v1/bridge/messages/claim';
    if (method === 'POST' && (isHandshake || isClaim || pathname === '/api/v1/bridge/messages/settle')) {
      const raw = await this.readJsonBody(req);
      this.assertCurrent(req);
      this.assertActive();
      const requestGeneration = this.generation;
      const body = isHandshake ? handshakeBody(raw) : isClaim ? claimBody(raw) : settleBody(raw);
      const idempotencyKey = req.headers['x-idempotency-key'];
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim())) {
        throw new BridgeRequestError(400, 'INVALID_ARGUMENT', 'Invalid x-idempotency-key header');
      }
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([pathname, canonicalBody(raw)])).digest('hex');
      if (idempotencyKey) {
        const cached = this.idempotencyCache.get(idempotencyKey);
        if (cached && cached.generation === requestGeneration) {
          if (cached.fingerprint !== fingerprint) {
            throw new BridgeRequestError(409, 'CONFLICT', 'Idempotency key belongs to a different request');
          }
          this.sendJson(res, cached.status, cached.body);
          return;
        }
      }

      // All mutations below are synchronous. Concurrent requests can interleave
      // while reading bodies, but cannot run between this check and cache fill.
      let response: BridgeResponse;
      try {
        if (isHandshake) {
          this.advanceGeneration();
          this.receptionHost?.replaceDispatcher?.();
          this.onHandshake?.();
          response = { status: 200, body: {
            ...this.identity(), accepted: true, contractVersion: BRIDGE_CONTRACT_VERSION,
          } satisfies BridgeHandshakeResponse };
        } else if (isClaim) {
          const evidence = body as BridgeClaimRequest;
          const host = this.receptionHost;
          if (!host?.claim) throw new BridgeRequestError(404, 'NOT_FOUND', 'Message does not exist');
          host.claim(evidence.nativeMessageId, evidence.messageId, evidence.correlationMarker);
          response = { status: 200, body: {
            claimed: true, idempotencyKey, nativeMessageId: evidence.nativeMessageId, status: 'claimed',
          } satisfies BridgeClaimResponse };
        } else {
          const report = body as BridgeSettleRequest;
          const host = this.receptionHost;
          if (!host) throw new BridgeRequestError(404, 'NOT_FOUND', 'Message does not exist');
          const transition = {
            enqueued: host.cancelDispatch,
            dispatching: host.beginDispatch,
            submitting: host.recordHandoff,
            discarded: host.recordNotEntered,
            unknown: host.recordUnresolved,
          }[report.status];
          if (!transition) throw new BridgeRequestError(409, 'CONFLICT', 'Message transition is not supported');
          transition.call(host, report.nativeMessageId, report.messageId);
          response = { status: 200, body: {
            settled: false, idempotencyKey, nativeMessageId: report.nativeMessageId, status: report.status,
          } satisfies BridgeSettleResponse };
        }
      } catch (error) {
        response = this.errorResponse(error);
      }
      if (idempotencyKey) this.idempotencyCache.set(idempotencyKey, { ...response, fingerprint, generation: requestGeneration });
      this.sendJson(res, response.status, response.body);
      return;
    }

    throw new BridgeRequestError(404, 'NOT_FOUND', 'Endpoint not found');
  }
}
