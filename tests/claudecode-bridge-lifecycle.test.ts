import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeCodeBridgeServer, ClaudeCodeSidecar, generateBridgeToken } from '../packages/adapter-claudecode/src/index.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

interface Identity { sessionId: string; instanceId: string; generation: number }

function headers(token: string, identity: Identity): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'x-session-id': identity.sessionId,
    'x-bridge-instance': identity.instanceId, 'x-bridge-generation': String(identity.generation),
    'Content-Type': 'application/json' };
}

async function request(server: ClaudeCodeBridgeServer, token: string, identity: Identity,
  route: string, body?: unknown, key?: string) {
  const response = await fetch(`${server.url}/api/v1/bridge${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers(token, identity), ...(key ? { 'x-idempotency-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function identity(server: ClaudeCodeBridgeServer, token: string, sessionId = server.sessionId): Promise<Identity> {
  const response = await fetch(`${server.url}/api/v1/bridge/status`, {
    headers: { Authorization: `Bearer ${token}`, 'x-session-id': sessionId },
  });
  assert.equal(response.status, 200);
  return response.json();
}

const handshake = { modVersion: '0.1.0', capabilities: ['prompt.submit'] };

test('bridge attachment consumes its generation and rejects every stale request before cached success', async (t) => {
  const token = generateBridgeToken();
  const server = new ClaudeCodeBridgeServer({ sessionId: 'root', token });
  await server.start();
  t.after(() => server.stop());
  const initial = await identity(server, token);
  assert.equal(initial.generation, 0);
  assert.equal(typeof initial.instanceId, 'string');
  const attached = await request(server, token, initial, '/handshake', handshake, 'first');
  assert.equal(attached.status, 200);
  assert.equal(attached.body.generation, 1);
  assert.equal(attached.body.contractVersion, '2.0.0');
  assert.equal((await request(server, token, initial, '/handshake', handshake, 'first')).status, 409);
  const current = attached.body as Identity;
  for (const route of ['/messages/pending', '/tools/unknown', '/commands/unknown']) {
    assert.equal((await request(server, token, initial, route)).body.error.code, 'STALE_BINDING');
    assert.equal((await request(server, token, { ...current, instanceId: 'previous-server' }, route)).status, 409);
  }
  assert.equal((await request(server, token, current, '/messages/pending')).status, 200);
  const concurrent = await Promise.all([
    request(server, token, current, '/handshake', handshake),
    request(server, token, current, '/handshake', handshake),
  ]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
});

test('retirement fences a delayed body and replacement never exposes the retired root input', async (t) => {
  const storageDir = createTempDir('cc-context-fence-');
  const sidecar = new ClaudeCodeSidecar({ sessionId: 'old-root', stateDir: storageDir, autoStart: false });
  let delayed: http.ClientRequest | undefined;
  await sidecar.start();
  t.after(async () => { delayed?.destroy(); await sidecar.stop(); removeTempDir(storageDir); });
  const server = sidecar.bridgeServer;
  const initial = await identity(server, sidecar.token);
  const attached = (await request(server, sidecar.token, initial, '/handshake', handshake)).body as Identity;
  const oldHost = sidecar.receptionHost;
  const oldRoot = sidecar.host.roots()[0];
  const prepared = oldHost.prepare({
    protocol_version: '0.1', daemon_id: 'daemon', message_id: 'queued-old', delivery_id: 'delivery',
    from_endpoint: 'sender', to_endpoint: 'receiver', group_id: 'group', target_generation: 1,
    delivery_seq: '1', text: 'only for old root', sent_at: new Date().toISOString(),
  });
  await prepared.enqueue();
  const report = JSON.stringify({ nativeMessageId: prepared.nativeMessageId, status: 'dispatching', timestamp: 1 });
  const delayedResponse = Promise.withResolvers<{ status: number; body: any }>();
  void delayedResponse.promise.catch(() => {});
  const receivedHeaders = Promise.withResolvers<void>();
  delayed = http.request(`${server.url}/api/v1/bridge/messages/settle`, {
    method: 'POST', headers: { ...headers(sidecar.token, attached), Expect: '100-continue',
      'Content-Length': String(Buffer.byteLength(report)) },
  }, response => {
    let text = '';
    response.on('data', chunk => { text += chunk; });
    response.on('end', () => delayedResponse.resolve({ status: response.statusCode!, body: JSON.parse(text) }));
  });
  delayed.on('error', delayedResponse.reject);
  delayed.once('continue', () => receivedHeaders.resolve());
  delayed.flushHeaders();
  await receivedHeaders.promise;

  const retired = await request(server, sidecar.token, attached, '/session/retire', {});
  assert.equal(retired.status, 200);
  assert.equal(retired.body.generation, attached.generation + 1);
  assert.deepEqual(sidecar.host.roots(), []);
  await assert.rejects(sidecar.runtime!.listSessions(oldRoot));
  delayed.end(report);
  assert.equal((await delayedResponse.promise).body.error.code, 'STALE_BINDING');
  assert.deepEqual(oldHost.getPendingMessages(), []);
  assert.equal((await request(server, sidecar.token, retired.body, '/messages/pending')).status, 409);
  assert.equal((await request(server, sidecar.token, retired.body, '/handshake', handshake)).status, 409);
  assert.equal((await identity(server, sidecar.token, 'new-root')).sessionId, 'old-root');

  const activated = await request(server, sidecar.token, retired.body, '/session/activate', { sessionId: 'new-root' });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.sessionId, 'new-root');
  assert.equal(activated.body.generation, retired.body.generation + 1);
  assert.equal(sidecar.sessionId, 'new-root');
  assert.equal(sidecar.host.sessionId(sidecar.host.roots()[0]), 'new-root');
  assert.notEqual(sidecar.receptionHost, oldHost);
  assert.deepEqual((await request(server, sidecar.token, activated.body, '/messages/pending')).body.messages, []);

  const retiredAgain = await request(server, sidecar.token, activated.body, '/session/retire', {});
  const revisited = await request(server, sidecar.token, retiredAgain.body, '/session/activate', { sessionId: 'old-root' });
  assert.equal(revisited.status, 200);
  assert.equal(sidecar.sessionId, 'old-root');
  assert.deepEqual((await request(server, sidecar.token, revisited.body, '/messages/pending')).body.messages, []);
});

test('stopping while the recovered bridge starts cannot leave a listener or publish a root', async (t) => {
  const storageDir = createTempDir('cc-stop-start-');
  const sidecar = new ClaudeCodeSidecar({ sessionId: 'start-race', stateDir: storageDir, autoStart: false });
  t.after(async () => { await sidecar.bridgeServer.stop().catch(() => {}); removeTempDir(storageDir); });
  const starting = sidecar.start();
  void starting.catch(() => {});
  await Promise.resolve();
  const stopping = sidecar.stop();
  await assert.rejects(starting, /stopped/);
  await stopping;
  assert.deepEqual(sidecar.host.roots(), []);
  await assert.rejects(fetch(`${sidecar.url}/api/v1/bridge/status`, {
    headers: { Authorization: `Bearer ${sidecar.token}`, 'x-session-id': sidecar.sessionId },
  }));
});

test('a failed retirement still closes the bridge and invalidates the root on stop', async (t) => {
  const storageDir = createTempDir('cc-stop-persistence-');
  const sidecar = new ClaudeCodeSidecar({ sessionId: 'failed-retirement', stateDir: storageDir, autoStart: false });
  await sidecar.start();
  t.after(async () => { await sidecar.bridgeServer.stop(); await sidecar.runtime!.dispose(); removeTempDir(storageDir); });
  const initial = await identity(sidecar.bridgeServer, sidecar.token);
  await request(sidecar.bridgeServer, sidecar.token, initial, '/handshake', handshake);
  const root = sidecar.host.roots()[0];
  fs.writeFileSync(path.join(storageDir, sidecar.sessionId, 'queue.jsonl'), '{broken\n');
  let stopping!: Promise<void>;
  assert.doesNotThrow(() => { stopping = sidecar.stop(); });
  await assert.rejects(stopping);
  assert.deepEqual(sidecar.host.roots(), []);
  await assert.rejects(sidecar.runtime!.listSessions(root));
  await assert.rejects(fetch(`${sidecar.url}/api/v1/bridge/status`, {
    headers: { Authorization: `Bearer ${sidecar.token}`, 'x-session-id': sidecar.sessionId },
  }));
});

test('activation is exclusive and a stopped bridge cannot publish late recovery', async (t) => {
  const token = generateBridgeToken();
  const recovering = Promise.withResolvers<void>();
  const recovered = Promise.withResolvers<void>();
  const server = new ClaudeCodeBridgeServer({ sessionId: 'old', token, onActivate: async () => {
    recovering.resolve();
    await recovered.promise;
    return { getPendingMessages: () => [] };
  } });
  await server.start();
  t.after(() => server.stop());
  const initial = await identity(server, token);
  const retired = await request(server, token, initial, '/session/retire', {});
  const activation = request(server, token, retired.body, '/session/activate', { sessionId: 'new' });
  void activation.catch(() => {});
  await recovering.promise;
  assert.equal((await request(server, token, retired.body, '/session/activate', { sessionId: 'competing' })).status, 409);
  assert.equal((await request(server, token, retired.body, '/messages/pending')).status, 409);
  await server.stop();
  recovered.resolve();
  await activation.catch(() => {});
  assert.equal(server.sessionId, 'old');
  await assert.rejects(server.start(), /stopped/);
});
