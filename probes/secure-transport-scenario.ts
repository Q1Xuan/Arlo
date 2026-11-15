import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RootBindingRegistry } from './mcp-metadata.ts';
import { createArloClientCapabilities, ARLO_PINNED_WIRE_REVISION, ARLO_PROTOCOL_OPTIONS } from './mcp-notification.ts';
import { createPinnedFetch, type TlsObservation } from './pinned-fetch.ts';
import { DAEMON_CERT, DAEMON_KEY, IMPOSTER_CERT, IMPOSTER_KEY } from './tls-fixtures.ts';
import { McpStreamableHttpTestRig, TransportDeduplicator, type ArloDeliveryFrame } from './transport-retry-defense.ts';
import { startImposterProcess } from './imposter-process.ts';

const settle = () => new Promise(resolve => setTimeout(resolve, 100));
async function listen(server: http.Server, port = 0) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return (server.address() as AddressInfo).port;
}
async function close(server: http.Server) {
  const stopped = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await stopped;
}

// The same scenario runs on public package fixtures and on agents supplied by
// the installed Desktop Host's Cordis plugin. No private host modules are used.
export async function runSecureTransportScenario(root: Agent, otherRoot: Agent, isolatedImposter = false) {
  const tlsConnections: TlsObservation[] = [];
  const pinned = createPinnedFetch(DAEMON_CERT, event => tlsConnections.push(event));
  const registry = new RootBindingRegistry();
  const dedup = new TransportDeduplicator({ agent: root, currentGeneration: 1, initialCapacity: 2 });
  const otherDedup = new TransportDeduplicator({ agent: otherRoot, currentGeneration: 1 });
  const secure = {
    cert: DAEMON_CERT, key: DAEMON_KEY, fetch: pinned.fetch, registry,
    bootstrapToken: 'fictional-bootstrap-canary', rootToken: 'fictional-root-a-canary',
    endpointId: 'ep-root', rootSessionId: String(root.session.id),
  };
  const rig = new McpStreamableHttpTestRig({ agent: root, deduplicator: dedup, secure });
  const other = new McpStreamableHttpTestRig({ agent: otherRoot, deduplicator: otherDedup,
    secure: { ...secure, endpointId: 'ep-other', rootToken: 'fictional-root-b-canary', rootSessionId: String(otherRoot.session.id) } });
  let proxyRequests = 0;
  const proxy = http.createServer((_req, res) => { proxyRequests++; res.writeHead(502); res.end(); });
  proxy.on('connect', (_req, socket) => { proxyRequests++; socket.destroy(); });
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY', 'NO_PROXY', 'no_proxy'];
  const savedProxy = new Map(proxyKeys.map(key => [key, process.env[key]]));
  const release = Promise.withResolvers<void>();
  let maintenance: Promise<unknown> | undefined;
  const frame = (id: string, seq: number): ArloDeliveryFrame => ({
    protocol_version: '0.1', daemon_id: 'daemon-http-rig', message_id: id, delivery_id: `delivery-${id}`,
    from_endpoint: 'ep-other', to_endpoint: 'ep-root', group_id: 'group-default',
    target_generation: 1, delivery_seq: String(seq), text: `fictional text ${id}`, reply_depth: 0, sent_at: new Date().toISOString(),
  });
  const call = (id: string, seq: number) => rig.client.callTool({
    name: 'arlo_deliver_message', arguments: { text: `fictional tool text ${id}`, delivery_seq: String(seq) },
    _meta: { 'arlo/message-id': id },
  });
  try {
    const proxyPort = await listen(proxy);
    for (const key of proxyKeys) process.env[key] = key.toLowerCase() === 'no_proxy' ? ''
      : key === 'NODE_USE_ENV_PROXY' ? '1' : `http://127.0.0.1:${proxyPort}`;
    await rig.start();
    await other.start();
    const wireRevision = rig.client.getNegotiatedProtocolVersion();
    assert.equal(wireRevision, ARLO_PINNED_WIRE_REVISION);
    assert.deepEqual(rig.readiness, [false, false, false, false, true]);
    assert.notEqual(rig.sessionId, other.sessionId);
    assert.notEqual(root.session.id, otherRoot.session.id);

    // Real MCP sessions and credentials from different existing host roots.
    for (const [token, session] of [[secure.rootToken, other.sessionId], ['fictional-root-b-canary', rig.sessionId], [secure.rootToken, '']]) {
      const response = await pinned.fetch(rig.url, { method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'mcp-session-id': session!, 'content-type': 'application/json',
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'tools/call', params: {
        name: 'arlo_deliver_message', arguments: { text: 'fictional cross-root canary', delivery_seq: '90' }, _meta: { 'arlo/message-id': 'cross-root' },
      } }) });
      assert.equal(response.status, 403);
      await response.text();
    }
    assert.equal(rig.metrics.hostEnqueueCount, 0);
    assert.equal(other.metrics.hostEnqueueCount, 0);

    // Unsolicited SSE enters the installed host's actual next-turn queue.
    maintenance = root.runMaintenance(() => release.promise);
    await rig.sendNotification({ ...frame('wrong-root', 99), to_endpoint: 'ep-other' });
    assert.equal((await rig.deliverNotification(frame('first', 1))).status, 'enqueued');
    assert.equal((await rig.deliverNotification(frame('first', 1))).status, 'duplicate');
    assert.equal(rig.metrics.hostEnqueueCount, 1);
    assert.equal(root.inbox.nextTurn.length, 1);
    assert.equal((await rig.deliverNotification(frame('second', 2))).status, 'enqueued');
    assert.equal(rig.isReady, false);
    await rig.sendNotification(frame('overflow', 3));
    await settle();
    assert.equal(root.inbox.nextTurn.length, 2);
    assert.equal(rig.metrics.hostEnqueueCount, 2);
    assert.equal(dedup.submitAck('delivery-first').quotaReleased, false);
    assert.equal(dedup.submitAck('delivery-first').duplicate, true);
    assert.equal(dedup.getAvailableCapacity(), 0);
    release.resolve(); await maintenance; await root.whenIdle();
    assert.equal(dedup.getAvailableCapacity(), 2);
    assert.equal((await rig.deliverNotification(frame('first', 1))).status, 'duplicate');

    await call('normal', 4); await root.whenIdle();
    assert.equal(rig.metrics.hostEnqueueCount, 3);
    rig.injectPost500Next();
    const before500 = rig.requests.length;
    await assert.rejects(call('http500', 5), /500/);
    await settle();
    assert.equal(rig.requests.length, before500 + 1);
    assert.equal(rig.metrics.hostEnqueueCount, 3);
    rig.injectSocketDestroyNext();
    const beforeDrop = rig.requests.length;
    await assert.rejects(call('lost-response', 6), /socket hang up|ECONNRESET|aborted/);
    await settle(); await root.whenIdle();
    assert.equal(rig.requests.length, beforeDrop + 1);
    assert.equal(rig.metrics.hostEnqueueCount, 4);
    const duplicate = await call('lost-response', 6);
    assert.match(JSON.stringify(duplicate.content), /SUPPRESSED:duplicate/);
    assert.equal(rig.metrics.hostEnqueueCount, 4);
    assert.deepEqual(await rig.reconnectSseWithReplay(frame('replayed', 7)), { replayed: true, duplicate: true });
    await root.whenIdle();
    assert.equal(rig.metrics.hostEnqueueCount, 5);
    assert.equal(rig.metrics.sseReplayRequests, 1);
    assert.ok(rig.metadata.length > 0 && rig.metadata.every(event => event.standardContainer && event.separated));
    const sessionBinding = registry.validateRequest({ credentialToken: secure.rootToken, sessionId: rig.sessionId });
    assert.equal(sessionBinding.rootSessionId, String(root.session.id));
    const realUrl = rig.url;
    await rig.close(); await other.close();
    assert.equal(rig.isReady, false);

    // The exact MCP fetch path is attacked at the port it previously trusted.
    let imposterRequests = 0;
    let imposterBodyBytes = 0;
    let imposterConnections = 0;
    let imposterPid = process.pid;
    const imposter = https.createServer({ key: IMPOSTER_KEY, cert: IMPOSTER_CERT }, (req, res) => {
      imposterRequests++;
      req.on('data', chunk => { imposterBodyBytes += chunk.length; });
      req.on('end', () => res.end('{}'));
    });
    imposter.on('connection', () => imposterConnections++);
    let imposterProcess: Awaited<ReturnType<typeof startImposterProcess>> | undefined;
    try {
      if (isolatedImposter) imposterProcess = await startImposterProcess(Number(new URL(realUrl).port));
      else await listen(imposter, Number(new URL(realUrl).port));
      for (const pathname of ['/bootstrap', '/mcp']) {
        await assert.rejects(pinned.fetch(new URL(pathname, realUrl), { method: 'POST',
          headers: { authorization: 'Bearer fictional-secret-canary' }, body: '{"text":"fictional-body-canary"}',
        }), /certificate|CERT_|PINNED/i);
      }
      const reconnect = new Client({ name: 'reconnect-probe', version: '0.1' }, {
        ...ARLO_PROTOCOL_OPTIONS, versionNegotiation: { mode: 'legacy' }, capabilities: createArloClientCapabilities(),
      });
      try {
        await assert.rejects(reconnect.connect(new StreamableHTTPClientTransport(new URL(realUrl), {
          fetch: pinned.fetch, requestInit: { headers: { authorization: `Bearer ${secure.rootToken}` } },
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 10, maxReconnectionDelay: 10, reconnectionDelayGrowFactor: 1 },
        })), /certificate|CERT_|PINNED/i);
      } finally { await reconnect.close(); }
    } finally {
      if (imposterProcess) {
        const stats = await imposterProcess.stop();
        imposterConnections = stats.connections; imposterRequests = stats.requests;
        imposterBodyBytes = stats.bodyBytes; imposterPid = stats.pid;
      } else await close(imposter);
    }
    assert.ok(imposterConnections >= 3);
    assert.equal(imposterRequests, 0); assert.equal(imposterBodyBytes, 0);
    if (isolatedImposter) assert.notEqual(imposterPid, process.pid);

    let redirectTargetRequests = 0;
    const target = https.createServer({ key: DAEMON_KEY, cert: DAEMON_CERT }, (_req, res) => { redirectTargetRequests++; res.end(); });
    let redirectCode = 301;
    const redirect = https.createServer({ key: DAEMON_KEY, cert: DAEMON_CERT }, (_req, res) => {
      res.writeHead(redirectCode, { location: `https://127.0.0.1:${(target.address() as AddressInfo).port}/stolen` }); res.end();
    });
    const oldTls = https.createServer({ key: DAEMON_KEY, cert: DAEMON_CERT, maxVersion: 'TLSv1.1' });
    try {
      await listen(target); const redirectPort = await listen(redirect);
      for (const code of [301, 302, 303, 307, 308]) {
        redirectCode = code;
        await assert.rejects(pinned.fetch(`https://127.0.0.1:${redirectPort}`, { headers: { authorization: 'fictional-root-canary' } }), /REDIRECT_FORBIDDEN/);
      }
      assert.equal(redirectTargetRequests, 0);
      const tlsPort = await listen(oldTls);
      await assert.rejects(pinned.fetch(`https://127.0.0.1:${tlsPort}`), /SSL|TLS|protocol/i);
      await assert.rejects(pinned.fetch(realUrl.replace('https:', 'http:')), /HTTPS_REQUIRED/);
      assert.equal(proxyRequests, 0);
      assert.ok(tlsConnections.length >= 3);
      assert.ok(tlsConnections.every(event => !event.resumed && ['TLSv1.2', 'TLSv1.3'].includes(event.protocol!)));
      assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
    } finally { await close(redirect); await close(target); await close(oldTls); }
    return {
      wireRevision, readiness: rig.readiness,
      rootSessionsDistinct: root.session.id !== otherRoot.session.id, rootSessionPreserved: sessionBinding.rootSessionId === String(root.session.id),
      authRejections: rig.authRejections, metadata: rig.metadata,
      metrics: rig.metrics, requests: rig.requests, timeline: rig.timeline,
      tlsConnections, imposterConnections, imposterRequests, imposterBodyBytes, isolatedImposter: imposterPid !== process.pid,
      proxyRequests, redirectTargetRequests, pendingAfterClaim: dedup.getInFlightCount(),
    };
  } finally {
    release.resolve(); await maintenance;
    await rig.close(); await other.close();
    dedup.dispose(); otherDedup.dispose(); pinned.close(); await close(proxy);
    for (const [key, value] of savedProxy) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
