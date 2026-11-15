import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server, WebStandardStreamableHTTPServerTransport, type EventStore, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { ActiveReceptionGate } from './host-reception-gate.ts';
import { createArloClientCapabilities, createArloServerCapabilities, ARLO_PROTOCOL_OPTIONS } from './mcp-notification.ts';
import { TransportDeduplicator, type ArloDeliveryFrame, type ReceiptResult } from './reception.ts';
import { RootBindingRegistry } from './mcp-metadata.ts';
export { TransportDeduplicator, type ArloDeliveryFrame } from './reception.ts';

export interface TransportMetrics {
  requestCount: number;
  businessDispatchCount: number;
  hostEnqueueCount: number;
  duplicateSuppressedCount: number;
  faultsInjectedCount: number;
  sseReplayRequests: number;
  replayedFrames: number;
}

export interface McpStreamableHttpTestRigOptions {
  agent: Agent;
  deduplicator: TransportDeduplicator;
  secure?: {
    key: string;
    cert: string;
    fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
    rootToken: string;
    bootstrapToken: string;
    endpointId: string;
    rootSessionId: string;
    registry: RootBindingRegistry;
  };
}

// The event store is a bounded fault injector, not a production replay queue.
// Normal recovery has no history; the test explicitly arms one duplicate frame.
class ReplayFaultStore implements EventStore {
  private events = new Map<string, { streamId: string; message: JSONRPCMessage }>();
  private sequence = 0;
  replayLast = false;
  onReplay: () => void = () => {};

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const id = `event-${++this.sequence}`;
    this.events.set(id, { streamId, message });
    if (this.events.size > 64) this.events.delete(this.events.keys().next().value!);
    return id;
  }

  eventFor(messageId: string): string {
    for (const [id, event] of this.events) {
      if ('params' in event.message && event.message.params?.message_id === messageId) return id;
    }
    throw new Error('Expected notification was not written to the SSE transport');
  }

  async getStreamIdForEventId(id: string): Promise<string | undefined> {
    return this.events.get(id)?.streamId;
  }

  async replayEventsAfter(id: string, { send }: { send: (id: string, message: JSONRPCMessage) => Promise<void> }): Promise<string> {
    const event = this.events.get(id);
    if (!event) throw new Error('Unknown test event');
    if (this.replayLast) {
      this.replayLast = false;
      await send(id, event.message);
      this.onReplay();
    }
    return event.streamId;
  }
}

export class McpStreamableHttpTestRig {
  readonly agent: Agent;
  readonly deduplicator: TransportDeduplicator;
  private httpServer: http.Server | null = null;
  private serverTransport: WebStandardStreamableHTTPServerTransport | null = null;
  private mcpServer: Server | null = null;
  private clientTransport: StreamableHTTPClientTransport | null = null;
  private mcpClient: Client | null = null;
  private gate: ActiveReceptionGate | null = null;
  private port = 0;
  private shouldInject500 = false;
  private shouldDestroySocketAfterDispatch = false;
  private eventStore = new ReplayFaultStore();
  private sseOpened = Promise.withResolvers<void>();
  private recoveryStopped = Promise.withResolvers<void>();
  private receipts: Array<{ messageId: string; result: ReceiptResult }> = [];
  private receiptWaiters: Array<() => void> = [];
  private stopObserving: (() => void) | undefined;
  private secure: McpStreamableHttpTestRigOptions['secure'];
  readonly requests: Array<{ method: string; rpcMethod?: string; lastEventId?: string; wireRevision?: string }> = [];
  readonly timeline: Array<{ event: string; order: number; result?: string }> = [];
  readonly readiness: boolean[] = [];
  readonly metadata: Array<{ standardContainer: boolean; separated: boolean }> = [];
  readonly authRejections: string[] = [];
  readonly metrics: TransportMetrics = {
    requestCount: 0, businessDispatchCount: 0, hostEnqueueCount: 0,
    duplicateSuppressedCount: 0, faultsInjectedCount: 0, sseReplayRequests: 0, replayedFrames: 0,
  };

  constructor(options: McpStreamableHttpTestRigOptions) {
    this.agent = options.agent;
    this.deduplicator = options.deduplicator;
    this.secure = options.secure;
  }

  private record(event: string, result?: string): void {
    this.timeline.push({ event, order: this.timeline.length + 1, ...(result ? { result } : {}) });
  }

  get url(): string { return `${this.secure ? 'https' : 'http'}://127.0.0.1:${this.port}/mcp`; }
  get sessionId(): string { return this.clientTransport!.sessionId!; }
  get isReady(): boolean { return this.gate?.isActiveReceptionReady() ?? false; }
  get client(): Client {
    if (!this.mcpClient) throw new Error('TestRig client not started');
    return this.mcpClient;
  }

  private recordReceipt(frame: ArloDeliveryFrame, result: ReceiptResult): void {
    this.metrics.businessDispatchCount++;
    if (result.status === 'duplicate') this.metrics.duplicateSuppressedCount++;
    this.receipts.push({ messageId: frame.message_id, result });
    this.record('notification_receipt', result.status);
    for (const wake of this.receiptWaiters.splice(0)) wake();
  }

  private async waitForReceipt(messageId: string, count: number): Promise<ReceiptResult> {
    for (;;) {
      const matches = this.receipts.filter(receipt => receipt.messageId === messageId);
      if (matches.length >= count) return matches[count - 1]!.result;
      await new Promise<void>(resolve => this.receiptWaiters.push(resolve));
    }
  }

  async start(): Promise<void> {
    this.stopObserving = this.agent.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === this.agent && message.source.kind === 'arlo') {
        this.metrics.hostEnqueueCount++;
        this.record('host_inbox_inserted');
      }
    });
    this.eventStore.onReplay = () => { this.metrics.replayedFrames++; this.record('sse_duplicate_written'); };
    this.serverTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID, eventStore: this.eventStore, keepAliveMs: 0,
    });
    this.mcpServer = new Server({ name: 'mcp-test-server', version: '0.1.0' }, {
      ...ARLO_PROTOCOL_OPTIONS, capabilities: { ...createArloServerCapabilities(), tools: {} },
    });
    this.mcpServer.setRequestHandler('tools/list', async () => ({ tools: [{
      name: 'arlo_deliver_message', description: 'Deliver a fictional probe message',
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, delivery_seq: { type: 'string' } }, required: ['text', 'delivery_seq'] },
    }] }));
    this.mcpServer.setRequestHandler('tools/call', async request => {
      const args = request.params.arguments ?? {};
      const msgId = request.params._meta?.['arlo/message-id'];
      if (typeof msgId !== 'string' || typeof args.text !== 'string' || typeof args.delivery_seq !== 'string') throw new Error('INVALID_ARGUMENT');
      this.metadata.push({ standardContainer: true, separated: !('arlo/message-id' in args) && !('_meta' in args) && !('credentials' in args) });
      this.metrics.businessDispatchCount++;
      this.record('tools_call_dispatch');
      const frame: ArloDeliveryFrame = {
        protocol_version: '0.1', daemon_id: 'daemon-http-rig', message_id: msgId,
        delivery_id: `del-${args.delivery_seq}`, from_endpoint: 'ep-http-sender', to_endpoint: 'ep-root',
        group_id: 'group-default', target_generation: this.deduplicator.generation,
        delivery_seq: args.delivery_seq, text: args.text, reply_depth: 0, sent_at: new Date().toISOString(),
      };
      const result = await this.deduplicator.receiveFrame(frame);
      if (result.status === 'duplicate') this.metrics.duplicateSuppressedCount++;
      return { content: [{ type: 'text', text: result.status === 'enqueued' ? 'ENQUEUED' : `SUPPRESSED:${result.status}` }] };
    });
    await this.mcpServer.connect(this.serverTransport);
    const listener = (req: http.IncomingMessage, res: http.ServerResponse) => { void this.handleHttp(req, res); };
    this.httpServer = this.secure ? https.createServer({ key: this.secure.key, cert: this.secure.cert }, listener) : http.createServer(listener);
    await new Promise<void>(resolve => this.httpServer!.listen(0, '127.0.0.1', () => {
      this.port = (this.httpServer!.address() as import('node:net').AddressInfo).port;
      resolve();
    }));
    if (this.secure) {
      const response = await this.secure.fetch(new URL('/bootstrap', this.url), {
        method: 'POST', headers: { authorization: `Bearer ${this.secure.bootstrapToken}` }, body: '{}',
      });
      if (!response.ok) throw new Error('BOOTSTRAP_FAILED');
      await response.text();
    }
    this.clientTransport = new StreamableHTTPClientTransport(new URL(this.url), {
      // Restoration is explicit; no automatic business POST or historical SSE replay.
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 10, maxReconnectionDelay: 10, reconnectionDelayGrowFactor: 1 },
      requestInit: { redirect: 'error', ...(this.secure ? { headers: { authorization: `Bearer ${this.secure.rootToken}` } } : {}) },
      ...(this.secure ? { fetch: this.secure.fetch } : {}),
    });
    this.mcpClient = new Client({ name: 'mcp-test-client', version: '0.1.0' }, {
      ...ARLO_PROTOCOL_OPTIONS, versionNegotiation: { mode: 'legacy' }, capabilities: createArloClientCapabilities(),
    });
    this.mcpClient.onerror = error => {
      this.record('client_transport_error', error.message);
      if (error.message.includes('Maximum reconnection attempts (0)')) this.recoveryStopped.resolve();
    };
    await this.mcpClient.connect(this.clientTransport);
    this.record('handshake_complete', this.mcpClient.getNegotiatedProtocolVersion());
    await this.sseOpened.promise;
    const binding = {
      endpointId: this.secure?.endpointId ?? 'ep-root', generation: this.deduplicator.generation,
      credentialToken: this.secure?.rootToken ?? 'fictional-http-token', sessionId: this.clientTransport.sessionId!,
    };
    this.gate = new ActiveReceptionGate({
      ...binding, daemonId: 'daemon-http-rig', groupId: 'group-default',
      client: this.mcpClient, agent: this.agent, deduplicator: this.deduplicator,
      onReceipt: (frame, result) => this.recordReceipt(frame, result),
    });
    this.readiness.push(this.isReady);
    await this.gate.verifyProtocolHandshake(); this.readiness.push(this.isReady);
    this.gate.installNotificationHandler(); this.record('notification_handler_installed'); this.readiness.push(this.isReady);
    this.gate.confirmBinding(binding); this.record('root_binding_confirmed'); this.readiness.push(this.isReady);
    this.gate.verifyCapacityReadiness(); this.record('capacity_ready'); this.readiness.push(this.isReady);
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
      const rpcMethod = body ? JSON.parse(body).method as string : undefined;
      if (this.secure) {
        if (req.url === '/bootstrap') {
          if (req.headers.authorization !== `Bearer ${this.secure.bootstrapToken}`) { res.writeHead(403); res.end(); return; }
          this.record('bootstrap_authenticated');
          res.writeHead(200); res.end('{}'); return;
        }
        try {
          const token = req.headers.authorization?.replace(/^Bearer /, '');
          if (token !== this.secure.rootToken) throw new Error('UNAUTHORIZED');
          if (rpcMethod !== 'initialize') {
            const binding = this.secure.registry.validateRequest({ credentialToken: token, sessionId: req.headers['mcp-session-id'] as string });
            if (binding.endpointId !== this.secure.endpointId) throw new Error('BINDING_MISMATCH');
          }
        } catch (error) {
          this.authRejections.push((error as Error).message.split(':')[0]!);
          res.writeHead(403); res.end('ROOT_BINDING_REJECTED'); return;
        }
      }
      const lastEventId = typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined;
      this.requests.push({ method: req.method!, rpcMethod, lastEventId, wireRevision: req.headers['mcp-protocol-version'] as string | undefined });
      this.metrics.requestCount++;
      if (lastEventId) this.metrics.sseReplayRequests++;
      this.record(lastEventId ? 'sse_resume_get' : `http_${req.method}`, rpcMethod);
      if (this.shouldInject500 && rpcMethod === 'tools/call') {
        this.shouldInject500 = false; this.metrics.faultsInjectedCount++;
        res.writeHead(500); res.end('Injected HTTP 500'); return;
      }
      const drop = this.shouldDestroySocketAfterDispatch && rpcMethod === 'tools/call';
      if (drop) { this.shouldDestroySocketAfterDispatch = false; this.metrics.faultsInjectedCount++; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
        else if (value !== undefined) headers.set(key, value);
      }
      const response = await this.serverTransport!.handleRequest(new Request(this.url, { method: req.method, headers, body }));
      if (this.secure && rpcMethod === 'initialize' && response.ok) {
        this.secure.registry.registerRoot({
          rootEndpoint: this.secure.endpointId, rootSessionId: this.secure.rootSessionId,
          generation: this.deduplicator.generation, credentialToken: this.secure.rootToken,
          sessionId: this.serverTransport!.sessionId!,
        });
      }
      if (drop) {
        // Let the real SDK dispatch and finish its response, then lose it on the wire.
        await response.arrayBuffer();
        this.record('socket_destroyed_after_dispatch');
        req.socket.destroy(); return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.flushHeaders();
      if (response.body) {
        const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      } else res.end();
      if (req.method === 'GET' && response.ok && !lastEventId) this.sseOpened.resolve();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end('Probe HTTP adapter failure');
      this.record('http_adapter_error', error instanceof Error ? error.message : String(error));
    }
  }

  injectPost500Next(): void { this.shouldInject500 = true; }
  injectSocketDestroyNext(): void { this.shouldDestroySocketAfterDispatch = true; }

  async sendNotification(frame: ArloDeliveryFrame): Promise<void> {
    await this.mcpServer!.notification({ method: 'notifications/arlo/message', params: frame });
  }

  async deliverNotification(frame: ArloDeliveryFrame): Promise<ReceiptResult> {
    const count = this.receipts.filter(receipt => receipt.messageId === frame.message_id).length;
    await this.sendNotification(frame);
    return this.waitForReceipt(frame.message_id, count + 1);
  }

  async reconnectSseWithReplay(frame: ArloDeliveryFrame): Promise<{ replayed: boolean; duplicate: boolean }> {
    await this.mcpServer!.notification({ method: 'notifications/arlo/message', params: frame });
    await this.waitForReceipt(frame.message_id, 1);
    const eventId = this.eventStore.eventFor(frame.message_id);
    const getCount = this.requests.filter(request => request.method === 'GET').length;
    this.serverTransport!.closeStandaloneSSEStream();
    this.record('sse_stream_closed');
    await this.recoveryStopped.promise;
    if (this.requests.filter(request => request.method === 'GET').length !== getCount) throw new Error('Implicit SSE retry was not disabled');
    this.eventStore.replayLast = true;
    await this.clientTransport!.resumeStream(eventId);
    const replay = await this.waitForReceipt(frame.message_id, 2);
    return { replayed: this.metrics.replayedFrames === 1, duplicate: replay.status === 'duplicate' };
  }

  async close(): Promise<void> {
    this.gate?.disconnect();
    this.stopObserving?.();
    await this.mcpClient?.close();
    await this.mcpServer?.close();
    if (this.httpServer) {
      this.httpServer.closeAllConnections();
      await new Promise<void>(resolve => this.httpServer!.close(() => resolve()));
    }
  }
}
