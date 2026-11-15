import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { fixture, LocalModel } from './fixture.ts';
import {
  ActiveReceptionGate,
  ARLO_PINNED_WIRE_REVISION,
} from './host-reception-gate.ts';
import {
  createArloClientCapabilities,
  createArloServerCapabilities,
  ARLO_PROTOCOL_OPTIONS,
} from './mcp-notification.ts';
import { ArloProtocolErrorCode } from './mcp-metadata.ts';
import { recordProbeEvidence } from './evidence.ts';

test('root notifications reject foreign bindings and incompatible frames, and replay enters the real host only once', async () => {
  const host = await fixture();
  let inserted = 0;
  host.ctx.on('agent/inbox/inserted', ({ agent }) => { if (agent === host.root.agent) inserted++; });
  const release = Promise.withResolvers<void>();
  const maintenance = host.root.agent.runMaintenance(() => release.promise);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: 'gate-regression', version: '1' }, { capabilities: createArloServerCapabilities(), ...ARLO_PROTOCOL_OPTIONS });
  const client = new Client({ name: 'gate-regression', version: '1' }, { capabilities: createArloClientCapabilities(), ...ARLO_PROTOCOL_OPTIONS });
  await server.connect(st);
  await client.connect(ct);
  const binding = { endpointId: 'endpoint-A', generation: 1, credentialToken: 'fictional-token', sessionId: 'mcp-A' };
  const gate = new ActiveReceptionGate({
    daemonId: 'daemon-test-1', groupId: 'group-default', ...binding, client, agent: host.root.agent, maxPending: 2 });
  try {
    await gate.verifyProtocolHandshake();
    gate.installNotificationHandler();
    gate.confirmBinding(binding);
    gate.verifyCapacityReadiness();
    const frame = {
      protocol_version: '0.1', daemon_id: 'daemon-test-1', message_id: 'message', delivery_id: 'delivery',
      from_endpoint: 'sender', to_endpoint: 'endpoint-A', group_id: 'group-default', target_generation: 1,
      delivery_seq: '1', text: 'fictional bound message', reply_depth: 0, sent_at: new Date().toISOString(),
    };
    for (const invalid of [{ to_endpoint: 'endpoint-B' }, { protocol_version: '0.2' }, { daemon_id: 'other' }, { group_id: 'other' }, { delivery_seq: 'invalid' }]) {
      await server.notification({ method: 'notifications/arlo/message', params: { ...frame, ...invalid } });
      assert.equal(host.root.agent.inbox.nextTurn.length, 0, `Must reject ${JSON.stringify(invalid)}`);
    }
    await server.notification({ method: 'notifications/arlo/message', params: frame });
    await server.notification({ method: 'notifications/arlo/message', params: frame });
    assert.equal(host.root.agent.inbox.nextTurn.length, 1);
    assert.equal(gate.isActiveReceptionReady(), true, 'A duplicate must not consume the remaining credit');
    await server.notification({ method: 'notifications/arlo/message', params: { ...frame, message_id: 'second', delivery_seq: '2' } });
    assert.equal(host.root.agent.inbox.nextTurn.length, 2);
    assert.equal(gate.isActiveReceptionReady(), false, 'Full pending input withdraws capacity readiness');
    await server.notification({ method: 'notifications/arlo/message', params: { ...frame, message_id: 'third', delivery_seq: '3' } });
    assert.equal(host.root.agent.inbox.nextTurn.length, 2, 'Capacity must be checked for each arrival');
    recordProbeEvidence('notificationGate', { pendingCount: host.root.agent.inbox.nextTurn.length, readyWhenFull: gate.isActiveReceptionReady() });
    release.resolve();
    await maintenance;
    await host.root.agent.whenIdle();
    await server.notification({ method: 'notifications/arlo/message', params: frame });
    await host.root.agent.whenIdle();
    assert.equal(inserted, 2, 'A replay after consumption still must not re-enter the host');
  } finally {
    gate.disconnect();
    await client.close();
    await server.close();
    release.resolve();
    await maintenance;
    await host.root.agent.whenIdle();
    await host.ctx.fiber.dispose();
  }
});

test('an unpinned legacy wire revision cannot make a root ready', async () => {
  const host = await fixture();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const options = { supportedProtocolVersions: ['2025-11-25'] };
  const client = new Client({ name: 'other-legacy', version: '1' }, options);
  const server = new Server({ name: 'other-legacy', version: '1' }, { ...options, capabilities: createArloServerCapabilities() });
  try {
    await server.connect(st);
    await client.connect(ct);
    assert.equal(client.getNegotiatedProtocolVersion(), '2025-11-25');
    const gate = new ActiveReceptionGate({
      daemonId: 'daemon-test-1', groupId: 'group-default', endpointId: 'endpoint-A', generation: 1,
      credentialToken: 'fictional', sessionId: 'mcp-A', client, agent: host.root.agent,
    });
    await assert.rejects(() => gate.verifyProtocolHandshake(), /UNSUPPORTED_VERSION/);
    assert.equal(gate.isActiveReceptionReady(), false);
    gate.disconnect();
  } finally {
    await client.close();
    await server.close();
    await host.ctx.fiber.dispose();
  }
});

test('Seam 3.1: 4-step readiness gate with preceding registration, wire negotiation, and lifecycle revocation', async () => {
  const model = new LocalModel();
  const rootFixture = await fixture(model);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Server configured with Arlo profile and candidate wire revision
  const server = new Server(
    { name: 'daemon-mcp-server', version: '0.1.0' },
    {
      capabilities: createArloServerCapabilities(),
      ...ARLO_PROTOCOL_OPTIONS,
    }
  );

  const client = new Client(
    { name: 'root-agent-client', version: '0.1.0' },
    {
      capabilities: createArloClientCapabilities(),
      ...ARLO_PROTOCOL_OPTIONS,
    }
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // Pre-condition: Wire revision negotiated
  const negotiatedVersion = client.getNegotiatedProtocolVersion();
  assert.equal(negotiatedVersion, ARLO_PINNED_WIRE_REVISION, 'Must negotiate the recorded wire revision');
  assert.equal(client.getProtocolEra(), 'legacy', 'Must negotiate legacy protocol era');

  // Prerequisite: Root registration
  const gate = new ActiveReceptionGate({
    daemonId: 'daemon-test-1', groupId: 'group-default',
    endpointId: 'ep-root-agent-1',
    generation: 1,
    credentialToken: 'cred-gen-1',
    sessionId: 'session-mcp-1',
    client,
    agent: rootFixture.root.agent,
    maxPending: 10,
  });

  // Before running readiness steps: not ready
  assert.equal(gate.isActiveReceptionReady(), false);

  // Step 1: Handshake verification (must match supported wire revision)
  const step1 = await gate.verifyProtocolHandshake();
  assert.equal(step1.ok, true);
  assert.equal(step1.wireRevision, negotiatedVersion);

  // Step 2: Install notification handler
  assert.equal(gate.isActiveReceptionReady(), false);
  const step2 = gate.installNotificationHandler();
  assert.equal(step2.ok, true);

  // Step 3: Binding confirmation
  assert.equal(gate.isActiveReceptionReady(), false);
  const step3 = gate.confirmBinding({
    endpointId: 'ep-root-agent-1',
    generation: 1,
    credentialToken: 'cred-gen-1',
    sessionId: 'session-mcp-1',
  });
  assert.equal(step3.ok, true);

  // Step 4: Verify capacity readiness
  assert.equal(gate.isActiveReceptionReady(), false);
  const step4 = gate.verifyCapacityReadiness();
  assert.equal(step4.ok, true);

  // NOW all 4 steps are complete -> active reception is ready!
  assert.equal(gate.isActiveReceptionReady(), true);

  // Lifecycle Revocation: Disconnect immediately retracts readiness and deactivates handler
  gate.disconnect();
  assert.equal(gate.isActiveReceptionReady(), false);

  // Notification sent after disconnect does not enter host
  const inboxBefore = rootFixture.root.agent.inbox.nextTurn.length;
  await server.notification({
    method: 'notifications/arlo/message',
    params: {
      protocol_version: '0.1',
      daemon_id: 'daemon-test-1',
      message_id: 'msg-post-disconnect',
      delivery_id: 'del-001',
      from_endpoint: 'ep-other',
      to_endpoint: 'ep-root-agent-1',
      group_id: 'group-default',
      target_generation: 1,
      delivery_seq: '1',
      text: 'should not enter host',
      reply_depth: 0,
      sent_at: new Date().toISOString(),
    },
  });

  assert.equal(rootFixture.root.agent.inbox.nextTurn.length, inboxBefore, 'No messages should enter host after disconnect');

  await client.close();
  await server.close();
  await rootFixture.ctx.fiber.dispose();
});

test('Seam 3.2: Modern revision, missing extension, and schema mismatch reject without polling; valid reception executes real host next-turn', { timeout: 10000 }, async () => {
  const model = new LocalModel();
  const host = await fixture(model);

  try {
    // 1. Modern protocol era rejection (real Client with modern prior)
    const [modClientTransport] = InMemoryTransport.createLinkedPair();
    const realModernClient = new Client({ name: 'modern-client', version: '1.0' });
    await realModernClient.connect(modClientTransport, {
      prior: {
        kind: 'modern',
        discover: { supportedVersions: ['2026-07-28'], capabilities: {} },
      },
    });
    assert.equal(realModernClient.getProtocolEra(), 'modern');
    assert.equal(realModernClient.getNegotiatedProtocolVersion(), '2026-07-28');
    const modernGate = new ActiveReceptionGate({
    daemonId: 'daemon-test-1', groupId: 'group-default',
      endpointId: 'ep-test',
      generation: 1,
      credentialToken: 'tok',
      sessionId: 'sess',
      client: realModernClient,
      agent: host.root.agent,
    });
    await assert.rejects(
      async () => modernGate.verifyProtocolHandshake(),
      (err: any) => err.message?.startsWith(ArloProtocolErrorCode.UNSUPPORTED_VERSION)
    );
    assert.equal(modernGate.isActiveReceptionReady(), false, 'Modern revision must not be ready');
    await realModernClient.close();

    // 2. Missing extension rejection (real Client + real Server handshake without arlo/session-messaging)
    const [missingClnTransport, missingSrvTransport] = InMemoryTransport.createLinkedPair();
    const missingExtServer = new Server({ name: 'missing-ext-server', version: '1.0' }, { capabilities: {} });
    const realMissingExtClient = new Client({ name: 'missing-ext-client', version: '1.0' });
    await Promise.all([missingExtServer.connect(missingSrvTransport), realMissingExtClient.connect(missingClnTransport)]);
    const missingExtGate = new ActiveReceptionGate({
    daemonId: 'daemon-test-1', groupId: 'group-default',
      endpointId: 'ep-test',
      generation: 1,
      credentialToken: 'tok',
      sessionId: 'sess',
      client: realMissingExtClient,
      agent: host.root.agent,
    });
    await assert.rejects(
      async () => missingExtGate.verifyProtocolHandshake(),
      (err: any) => err.message?.startsWith(ArloProtocolErrorCode.UNSUPPORTED_PROFILE)
    );
    assert.equal(missingExtGate.isActiveReceptionReady(), false, 'Missing extension must not be ready');
    await realMissingExtClient.close();
    await missingExtServer.close();

    // 3. Schema version mismatch rejection (real Client + real Server handshake with incompatible profile version)
    const [verClnTransport, verSrvTransport] = InMemoryTransport.createLinkedPair();
    const verMismatchServer = new Server(
      { name: 'ver-mismatch-server', version: '1.0' },
      {
        capabilities: {
          experimental: {
            'arlo/session-messaging': { version: '0.2' },
          },
        },
      }
    );
    const realVersionMismatchClient = new Client({ name: 'ver-mismatch-client', version: '1.0' });
    await Promise.all([verMismatchServer.connect(verSrvTransport), realVersionMismatchClient.connect(verClnTransport)]);
    const versionMismatchGate = new ActiveReceptionGate({
    daemonId: 'daemon-test-1', groupId: 'group-default',
      endpointId: 'ep-test',
      generation: 1,
      credentialToken: 'tok',
      sessionId: 'sess',
      client: realVersionMismatchClient,
      agent: host.root.agent,
    });
    await assert.rejects(
      async () => versionMismatchGate.verifyProtocolHandshake(),
      (err: any) => err.message?.startsWith(ArloProtocolErrorCode.UNSUPPORTED_VERSION)
    );
    assert.equal(versionMismatchGate.isActiveReceptionReady(), false, 'Version mismatch must not be ready');
    await realVersionMismatchClient.close();
    await verMismatchServer.close();

    // 4. Real host next-turn execution when ready
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server(
      { name: 'daemon-mcp-server', version: '0.1.0' },
      { capabilities: createArloServerCapabilities(), ...ARLO_PROTOCOL_OPTIONS }
    );
    const client = new Client(
      { name: 'real-host-client', version: '0.1.0' },
      { capabilities: createArloClientCapabilities(), ...ARLO_PROTOCOL_OPTIONS }
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const readyGate = new ActiveReceptionGate({
    daemonId: 'daemon-test-1', groupId: 'group-default',
      endpointId: 'ep-root-real',
      generation: 1,
      credentialToken: 'tok-real-1',
      sessionId: 'sess-real-1',
      client,
      agent: host.root.agent,
    });

    await readyGate.verifyProtocolHandshake();
    readyGate.installNotificationHandler();
    readyGate.confirmBinding({
      endpointId: 'ep-root-real',
      generation: 1,
      credentialToken: 'tok-real-1',
      sessionId: 'sess-real-1',
    });
    readyGate.verifyCapacityReadiness();
    assert.equal(readyGate.isActiveReceptionReady(), true);

    // Send valid notification
    await server.notification({
      method: 'notifications/arlo/message',
      params: {
        protocol_version: '0.1',
        daemon_id: 'daemon-test-1',
        message_id: 'msg-real-host-turn',
        delivery_id: 'del-real-001',
        from_endpoint: 'ep-remote-sender',
        to_endpoint: 'ep-root-real',
        group_id: 'group-default',
        target_generation: 1,
        delivery_seq: '1',
        text: 'real turn via arlo notification',
        reply_depth: 0,
        sent_at: new Date().toISOString(),
      },
    });

    // Wait for the host agent loop to process next-turn
    await host.root.agent.whenIdle();

    // Verify real host execution
    assert.equal(model.requests.length, 1, 'LocalModel should have received 1 request');
    const userPromptText = (model.requests[0]?.messages?.find(m => m.role === 'user') as any)?.content?.[0]?.text;
    assert.match(userPromptText, /real turn via arlo notification/);
    assert.equal(host.root.agent.inbox.nextTurn.length, 0, 'Inbox should be claimed and cleared');

    await client.close();
    await server.close();
  } finally {
    await host.ctx.fiber.dispose();
  }
});
