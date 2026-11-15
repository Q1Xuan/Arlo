import assert from 'node:assert/strict';
import { test } from 'node:test';
import https from 'node:https';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, RootConnection, createPinnedHttpsAgent, readDiscoveryRecord, readBootstrapToken } from '@arlo/sdk';
import { DAEMON_CERT, DAEMON_KEY, IMPOSTER_CERT, IMPOSTER_KEY } from '../probes/tls-fixtures.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('A connected root has an established subscription and closing it invalidates callbacks exactly once', async (t) => {
  const rig = await MessageStatusFixture.create();
  t.after(() => rig.dispose());
  const receiver = rig.roots[1]!;
  let disconnected = 0;
  receiver.connection.onDisconnect(() => { disconnected++; });
  await receiver.connection.mcpClient.close();
  assert.equal(disconnected, 1);
  receiver.connection.dispose();
  assert.equal(disconnected, 1);
  await assert.rejects(receiver.connection.listSessions(), { code: 'CHANNEL_NOT_READY' });
  assert.equal(await rig.waitForDeliverable(1, false), true);
});

test('A daemon that declines the notification subscription fails initialization instead of hanging or publishing readiness', async () => {
  const server = https.createServer({ cert: DAEMON_CERT, key: DAEMON_KEY }, (req, res) => {
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const rpc = JSON.parse(body);
      if (rpc.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'refused-subscription' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {
        protocolVersion: '2025-06-18', capabilities: { experimental: { 'arlo/session-messaging': { version: '0.1' } } },
        serverInfo: { name: 'controlled-transport', version: '1' },
      } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const control = new ControlClient({ pinnedCertPem: DAEMON_CERT, port: (server.address() as import('node:net').AddressInfo).port });
  const connection = control.createRootConnection({ endpoint_id: 'endpoint', generation: 1, root_token: 'credential',
    group_id: 'group', status: 'registered', ready: false, deliverable: false }, { heartbeat: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      connection.connect().then(() => 'ready', () => 'failed'),
      new Promise(resolve => { timer = setTimeout(() => resolve('hung'), 1000); }),
    ]);
    assert.equal(result, 'failed');
  } finally {
    clearTimeout(timer);
    connection.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Every fresh control and root TLS connection rejects an impostor on the old port before credentials reach HTTP', async () => {
  const stateDir = createTempDir('sdk-recovery-tls');
  const daemon = new ArloDaemon({ stateDir });
  let requests = 0;
  let bytes = 0;
  const impostor = https.createServer({ cert: IMPOSTER_CERT, key: IMPOSTER_KEY }, (req, res) => {
    requests++;
    req.on('data', chunk => { bytes += chunk.length; });
    res.end('{}');
  });
  try {
    const { port } = await daemon.start();
    const control = new ControlClient({ discovery: readDiscoveryRecord(stateDir), bootstrapToken: readBootstrapToken(stateDir) });
    await control.refreshConnection();
    const runtime = await control.registerRuntime();
    const binding = await control.registerRoot(runtime.runtime_token, {
      root_session_id: 'tls-root', group_name: 'tls-recovery', agent_incarnation: 'tls-agent', plugin_generation: 1,
    });
    await daemon.stop();
    await new Promise<void>(resolve => impostor.listen(port, '127.0.0.1', resolve));
    await assert.rejects(control.refreshConnection(), { code: 'PINNED_CERT_MISMATCH' });
    const connection = control.createRootConnection(binding);
    try { await assert.rejects(connection.connect()); } finally { connection.dispose(); }
    assert.equal(requests, 0);
    assert.equal(bytes, 0);
  } finally {
    impostor.closeAllConnections();
    await new Promise<void>(resolve => impostor.close(() => resolve()));
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('Refreshing a control connection authenticates the currently discovered daemon after restart', async () => {
  const stateDir = createTempDir('sdk-recovery');
  const first = new ArloDaemon({ stateDir });
  const second = new ArloDaemon({ stateDir });
  try {
    const original = await first.start();
    const control = new ControlClient({ stateDir });
    assert.equal(await control.refreshConnection(), original.daemonId);
    const runtime = await control.registerRuntime();
    await first.stop();
    const replacement = await second.start();
    assert.notEqual(replacement.daemonId, original.daemonId);
    assert.equal(await control.refreshConnection(), replacement.daemonId);
    await assert.rejects(control.listRoots(runtime.runtime_token), { code: 'UNAUTHORIZED' });
    assert.ok((await control.registerRuntime()).runtime_token);
  } finally {
    await first.stop();
    await second.stop();
    removeTempDir(stateDir);
  }
});

for (const replacement of [false, true]) test(replacement
  ? 'Refreshing a changed Daemon cancels requests authenticated to the previous instance'
  : 'Refreshing the same authenticated Daemon preserves another root heartbeat already in flight', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let daemonId = 'same-authenticated-daemon';
  const server = https.createServer({ cert: DAEMON_CERT, key: DAEMON_KEY }, async (req, res) => {
    req.resume();
    if (req.url === '/control/v1/status') {
      res.end(JSON.stringify({ daemon_id: daemonId, status: 'ready' }));
      return;
    }
    entered.resolve();
    await release.promise;
    res.end(JSON.stringify({ lease_duration_ms: 20000 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const control = new ControlClient({
    pinnedCertPem: DAEMON_CERT, port: (server.address() as import('node:net').AddressInfo).port,
    bootstrapToken: 'local-bootstrap-canary',
  });
  try {
    await control.refreshConnection();
    const heartbeat = control.heartbeatRoot('local-root-canary', { endpoint_id: 'another-root', generation: 1 });
    void heartbeat.catch(() => {});
    await entered.promise;
    if (replacement) daemonId = 'replacement-authenticated-daemon';
    assert.equal(await control.refreshConnection(), daemonId);
    release.resolve();
    if (replacement) await assert.rejects(heartbeat, { code: 'DAEMON_NOT_RUNNING' });
    else assert.equal((await heartbeat).lease_duration_ms, 20000,
      'Refreshing for another root cannot cancel this root\'s authenticated heartbeat');
  } finally {
    release.resolve();
    control.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('A root rejects business synchronously after its lease deadline even before the timer runs', async t => {
  const rig = await MessageStatusFixture.create({ roots: 0 });
  t.after(() => rig.dispose());
  const registration = await rig.control.registerRoot(rig.runtimeToken, {
    root_session_id: 'stalled-timer-root', group_name: 'lease', agent_incarnation: 'stalled-timer-agent', plugin_generation: 1,
  });
  const discovery = readDiscoveryRecord(rig.stateDir);
  let now = 0;
  const connection = new RootConnection({
    url: new URL(`https://127.0.0.1:${discovery.port}/mcp`), agent: createPinnedHttpsAgent(discovery.cert_pem),
    binding: registration,
    heartbeat: () => rig.control.heartbeatRoot(registration.root_token, { endpoint_id: registration.endpoint_id, generation: registration.generation }),
    lease: {
      now: () => now,
      setTimeout: () => ({ unref() { return this; } } as ReturnType<typeof setTimeout>),
      clearTimeout: () => {},
    },
  });
  t.after(() => connection.dispose());
  await connection.connect();
  await rig.control.confirmRootReady(registration.root_token, { endpoint_id: registration.endpoint_id });
  let disconnected = false;
  connection.onDisconnect(() => { disconnected = true; });
  now = 20000;
  const listing = connection.listSessions();
  assert.equal(disconnected, true, 'The business guard itself expires the binding; it does not wait for I/O or a timer');
  await assert.rejects(listing, { code: 'CHANNEL_NOT_READY' });
});
