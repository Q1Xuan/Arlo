import https from 'node:https';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  ArloError,
  ArloErrorCode,
  ARLO_PINNED_WIRE_REVISION,
  ARLO_NOTIFICATION_METHOD,
  ARLO_MESSAGE_ID_META_KEY,
  ARLO_CROSS_HOST_CAPABILITY,
  ARLO_CROSS_HOST_CAPABILITY_VERSION,
  arloNotificationSchema,
  MESSAGE_STATUS_QUERY_TIMEOUT_MS,
  type RootRegistrationResponse,
  type ArloMessageNotificationParams,
  type ArloSendMessageArgs,
  type ArloSendMessageResult,
  type ArloMessageStatusQueryResult,
} from '../protocol/index.ts';
import { ConnectionLease, type ConnectionLeaseOptions } from '../connection-lease/index.ts';
import { assertNodeRuntime } from '../runtime/index.ts';

interface RootConnectionOptions {
  url: URL;
  agent: https.Agent;
  binding: RootRegistrationResponse;
  /** New adapters require policy enforcement before publishing root readiness. */
  requireCrossHostParticipation?: boolean;
  heartbeat?: () => Promise<{ lease_duration_ms: number }>;
  lease?: Omit<ConnectionLeaseOptions, 'heartbeat' | 'onExpire'>;
}

/**
 * Inactivity deadline for receiving the MCP server's response headers. It must
 * outlast the daemon's own reception-acknowledgement wait (10 s), because a send
 * still waiting for its receipt is a normal request, not a dead connection. The
 * callback below disarms it once the response arrives, so it bounds the wait for
 * a response rather than the lifetime of the response stream, which belongs to
 * the caller and to this connection's AbortSignal. MCP per-call timeouts remain
 * the outer bound.
 */
const MCP_INITIAL_RESPONSE_TIMEOUT_MS = 20000;

function matchArloError(rawText: string, fallback: ArloErrorCode): ArloError {
  const tokens = new Set(rawText.split(/\W+/));
  for (const code of Object.values(ArloErrorCode)) {
    if (tokens.has(code)) {
      return new ArloError(code, rawText);
    }
  }
  return new ArloError(fallback, rawText);
}

// Owns one MCP Session and one HTTPS agent. Disposing a root cancels only its
// requests; other roots and the Runtime control client keep their connections.
export class RootConnection {
  private readonly options: RootConnectionOptions;
  private readonly client = new Client({ name: 'arlo-sdk', version: '0.1.0' }, {
    supportedProtocolVersions: [ARLO_PINNED_WIRE_REVISION],
    versionNegotiation: { mode: 'legacy' },
    capabilities: { experimental: {
      'arlo/session-messaging': { version: '0.1' },
      [ARLO_CROSS_HOST_CAPABILITY]: { version: ARLO_CROSS_HOST_CAPABILITY_VERSION },
    } },
  });
  private readonly lifetime = new AbortController();
  private readonly transport: StreamableHTTPClientTransport;
  private connecting?: Promise<void>;
  private connected = false;
  private readonly subscribed: ReturnType<typeof Promise.withResolvers<void>>;
  private readonly disconnectHandlers = new Set<() => void>();
  private lease?: ConnectionLease;

  constructor(options: RootConnectionOptions) {
    assertNodeRuntime();
    this.subscribed = Promise.withResolvers<void>();
    this.options = options;
    this.transport = new StreamableHTTPClientTransport(options.url, {
      fetch: (input, init) => this.fetch(input, init),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    // The MCP library reports a lost GET stream via onerror even when its
    // implicit reconnect budget is zero. Treat it as terminal for this binding.
    this.client.onclose = () => this.dispose();
    this.client.onerror = () => this.dispose();
    void this.subscribed.promise.catch(() => {});
  }

  connect(): Promise<void> {
    return this.connecting ??= this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      this.assertActive();
      await this.client.connect(this.transport);
      await this.subscribed.promise;
      this.assertActive();
      const profile = this.client.getServerCapabilities()?.experimental?.['arlo/session-messaging'];
      if (!profile || typeof profile !== 'object' || !('version' in profile) || profile.version !== '0.1') {
        throw new ArloError(ArloErrorCode.UNSUPPORTED_PROFILE);
      }
      if (this.options.requireCrossHostParticipation) {
        const participation = this.client.getServerCapabilities()?.experimental?.[ARLO_CROSS_HOST_CAPABILITY];
        if (!participation || typeof participation !== 'object' || !('version' in participation) ||
            participation.version !== ARLO_CROSS_HOST_CAPABILITY_VERSION) {
          throw new ArloError(ArloErrorCode.UNSUPPORTED_PROFILE, 'Daemon does not support cross-host participation');
        }
      }
      this.connected = true;
      this.startHeartbeat();
    } catch (error) {
      const disposed = this.lifetime.signal.aborted;
      this.dispose();
      if (disposed) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      throw error instanceof ArloError ? error : new ArloError(ArloErrorCode.CONNECTION_FAILED);
    }
  }

  get binding(): RootRegistrationResponse {
    return this.options.binding;
  }

  get sessionId(): string | undefined {
    return (this.transport as any).sessionId;
  }

  get mcpClient(): Client {
    return this.client;
  }

  onDisconnect(handler: () => void): () => void {
    if (this.lifetime.signal.aborted) handler();
    else this.disconnectHandlers.add(handler);
    return () => { this.disconnectHandlers.delete(handler); };
  }

  onNotification(handler: (params: ArloMessageNotificationParams) => void | Promise<void>): () => void {
    this.client.setNotificationHandler(
      ARLO_NOTIFICATION_METHOD,
      { params: arloNotificationSchema as any },
      (params: any) => {
        if (!this.lifetime.signal.aborted && (!this.lease || this.lease.isValid())) return handler(params);
      }
    );
    return () => {
      this.client.removeNotificationHandler(ARLO_NOTIFICATION_METHOD);
    };
  }

  async sendMessage(
    args: ArloSendMessageArgs,
    messageId?: string
  ): Promise<ArloSendMessageResult> {
    const msgId = messageId ?? crypto.randomUUID();
    this.assertActive();
    if (!this.connected) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    try {
      const result = await this.client.callTool(
        {
          name: 'arlo_send_message',
          arguments: args as unknown as Record<string, unknown>,
          _meta: {
            [ARLO_MESSAGE_ID_META_KEY]: msgId,
          },
        } as any,
        { timeout: 15000 }
      );
      if (result.isError) {
        const errText = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
        throw matchArloError(errText, ArloErrorCode.CORRUPTED_STATE);
      }
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : undefined;
      if (!text) throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
      return JSON.parse(text) as import('../protocol/index.ts').ArloSendMessageResult;
    } catch (error: any) {
      const rawText = `${error?.message ?? ''} ${error?.text ?? ''}`;
      const failure = error instanceof ArloError ? error : matchArloError(rawText, ArloErrorCode.CONNECTION_FAILED);
      if ([ArloErrorCode.CHANNEL_NOT_READY, ArloErrorCode.CONNECTION_FAILED, ArloErrorCode.CONNECTION_LOST].some(code => code === failure.code)) {
        // The request may already have reached the daemon. Keep its identity
        // queryable; a transport failure never authorizes a second send.
        return { status: 'unknown', message_id: msgId, reason: ArloErrorCode.CONNECTION_LOST };
      }
      throw failure;
    }
  }

  async listSessions(): Promise<{ type: 'text'; text: string }[]> {
    this.assertActive();
    if (!this.connected) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    try {
      const result = await this.client.callTool({ name: 'arlo_list_sessions', arguments: {} }, { timeout: 5000 });
      this.assertActive();
      if (result.isError) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      return result.content.map(block => {
        if (block.type !== 'text') throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
        return { type: 'text', text: block.text };
      });
    } catch (error) {
      this.assertActive();
      throw error instanceof ArloError ? error : new ArloError(ArloErrorCode.CONNECTION_FAILED);
    }
  }

  /**
   * Queries the reception status of a message this root session sent. The
   * daemon derives the sender from the authenticated binding, so no identity
   * argument is accepted or forwarded.
   */
  async getMessageStatus(messageId: string): Promise<ArloMessageStatusQueryResult> {
    this.assertActive();
    if (!this.connected) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    if (typeof messageId !== 'string' || !messageId) {
      throw new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'message_id must be a non-empty string');
    }
    try {
      const result = await this.client.callTool(
        { name: 'arlo_get_message_status', arguments: { message_id: messageId } },
        { timeout: MESSAGE_STATUS_QUERY_TIMEOUT_MS }
      );
      this.assertActive();
      if (result.isError) {
        const errText = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
        throw matchArloError(errText, ArloErrorCode.CORRUPTED_STATE);
      }
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : undefined;
      if (!text) throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
      return JSON.parse(text) as ArloMessageStatusQueryResult;
    } catch (error: any) {
      this.assertActive();
      throw error instanceof ArloError ? error : new ArloError(ArloErrorCode.CONNECTION_FAILED);
    }
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.connected = false;
    this.lifetime.abort();
    this.lease?.stop();
    this.subscribed.reject(new ArloError(ArloErrorCode.CHANNEL_NOT_READY));
    this.options.agent.destroy();
    for (const handler of this.disconnectHandlers) {
      try { handler(); } catch { /* One observer cannot keep credentials live. */ }
    }
    this.disconnectHandlers.clear();
    void this.client.close().catch(() => {});
  }

  private startHeartbeat(): void {
    if (!this.options.heartbeat || this.lifetime.signal.aborted) return;
    this.lease = new ConnectionLease({ ...this.options.lease, heartbeat: this.options.heartbeat, onExpire: () => this.dispose() });
  }

  private assertActive(): void {
    if (this.lifetime.signal.aborted || this.lease && !this.lease.isValid()) {
      throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    }
  }

  // Use Node HTTPS with the already pinned agent, never global fetch or proxies.
  // Responses remain streams so the MCP SDK can own their cancellation/lifetime.
  private async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    this.assertActive();
    const url = new URL(input);
    if (url.href !== this.options.url.href || url.protocol !== 'https:' || url.hostname !== '127.0.0.1') {
      throw new ArloError(ArloErrorCode.EXTERNAL_NETWORK_FORBIDDEN);
    }
    if (init.body != null && typeof init.body !== 'string') throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.options.binding.root_token}`);
    headers.set('x-arlo-endpoint-id', this.options.binding.endpoint_id);
    headers.set('x-arlo-generation', String(this.options.binding.generation));
    const signal = init.signal ? AbortSignal.any([init.signal, this.lifetime.signal]) : this.lifetime.signal;
    return new Promise<Response>((resolve, reject) => {
      const request = https.request(url, {
        agent: this.options.agent, method: init.method ?? 'GET', headers: Object.fromEntries(headers), signal,
      }, response => {
        request.setTimeout(0);
        const status = response.statusCode!;
        if (init.method === 'GET') {
          if (status !== 200 || !response.headers['content-type']?.includes('text/event-stream') ||
              response.headers['mcp-session-id'] !== this.sessionId) {
            const error = new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
            this.subscribed.reject(error);
            response.destroy();
            reject(error);
            return;
          }
          this.subscribed.resolve();
          response.once('close', () => this.dispose());
        }
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new ArloError(ArloErrorCode.REDIRECT_FORBIDDEN));
          return;
        }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(item => responseHeaders.append(key, item));
          else if (value !== undefined) responseHeaders.set(key, value);
        }
        const noBody = init.method === 'HEAD' || [204, 205, 304].includes(status);
        if (noBody) response.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
      });
      // Only the wait for response headers is bounded; the response stream's
      // lifetime belongs to the caller and to this connection's AbortSignal.
      request.setTimeout(MCP_INITIAL_RESPONSE_TIMEOUT_MS, () =>
        request.destroy(new ArloError(ArloErrorCode.CONNECTION_FAILED))
      );
      request.on('error', () => reject(new ArloError(
        this.lifetime.signal.aborted ? ArloErrorCode.CHANNEL_NOT_READY : ArloErrorCode.CONNECTION_FAILED,
      )));
      request.end(init.body ?? undefined);
    });
  }
}
