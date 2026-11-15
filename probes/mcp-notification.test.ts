import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { recordProbeEvidence } from './evidence.ts';
import {
  ARLO_PROFILE,
  ARLO_PROFILE_VERSION,
  ARLO_PROTOCOL_OPTIONS,
  createArloClientCapabilities,
  createArloServerCapabilities,
  arloNotificationSchema,
  attachArloNotificationHandler,
  type ArloMessageNotificationParams,
} from './mcp-notification.ts';

test('Seam 1.1: MCP capability negotiation and custom schema notification dispatch', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = new Server(
    { name: 'test-daemon', version: '0.1.0' },
    { capabilities: createArloServerCapabilities(), ...ARLO_PROTOCOL_OPTIONS }
  );

  const client = new Client(
    { name: 'test-root-client', version: '0.1.0' },
    { capabilities: createArloClientCapabilities(), ...ARLO_PROTOCOL_OPTIONS }
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // 1. Verify capability exchange
  const serverCaps = client.getServerCapabilities();
  assert.ok(serverCaps?.experimental?.[ARLO_PROFILE], 'Server must declare arlo/session-messaging capability');
  assert.equal(
    serverCaps.experimental[ARLO_PROFILE].version,
    ARLO_PROFILE_VERSION,
    'Server must declare version 0.1'
  );

  const clientCaps = server.getClientCapabilities();
  assert.ok(clientCaps?.experimental?.[ARLO_PROFILE], 'Client must declare arlo/session-messaging capability');
  assert.equal(
    clientCaps.experimental[ARLO_PROFILE].version,
    ARLO_PROFILE_VERSION,
    'Client must declare version 0.1'
  );

  // 2. Attach notification handler with custom StandardSchema
  const received: ArloMessageNotificationParams[] = [];
  attachArloNotificationHandler(client, (params) => {
    received.push(params);
  });

  // 3. Valid notification dispatch
  const validPayload: ArloMessageNotificationParams = {
    protocol_version: '0.1',
    daemon_id: 'daemon-test-1',
    message_id: 'msg-0001',
    delivery_id: 'del-0001',
    from_endpoint: 'ep-sender',
    to_endpoint: 'ep-receiver',
    group_id: 'group-default',
    target_generation: 1,
    delivery_seq: '1',
    text: 'hello from sender',
    reply_depth: 0,
    sent_at: new Date().toISOString(),
  };

  await server.notification({
    method: 'notifications/arlo/message',
    params: validPayload,
  });

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], validPayload);

  // 4. Invalid notification schema: missing delivery_seq and wrong target_generation
  await server.notification({
    method: 'notifications/arlo/message',
    params: {
      protocol_version: '0.1',
      daemon_id: 'daemon-test-1',
      // missing message_id
      delivery_id: 'del-0002',
      from_endpoint: 'ep-sender',
      to_endpoint: 'ep-receiver',
      group_id: 'group-default',
      target_generation: 'not-a-number' as any,
      text: 'malformed notification',
    } as any,
  });

  // Business callback must NOT have been called for malformed payload
  assert.equal(received.length, 1, 'Malformed notification must not trigger business callback');
  recordProbeEvidence('capabilities', {
    client: clientCaps.experimental[ARLO_PROFILE], server: serverCaps.experimental[ARLO_PROFILE],
    wireRevision: client.getNegotiatedProtocolVersion(), receivedNotifications: received.length,
  });

  await client.close();
  await server.close();
});

test('Seam 1.2: Unsubscription and close prevent subsequent notification delivery', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = new Server(
    { name: 'test-daemon', version: '0.1.0' },
    { capabilities: createArloServerCapabilities(), ...ARLO_PROTOCOL_OPTIONS }
  );

  const client = new Client(
    { name: 'test-root-client', version: '0.1.0' },
    { capabilities: createArloClientCapabilities(), ...ARLO_PROTOCOL_OPTIONS }
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  let dispatchCount = 0;
  const unsubscribe = attachArloNotificationHandler(client, () => {
    dispatchCount++;
  });

  const payload: ArloMessageNotificationParams = {
    protocol_version: '0.1',
    daemon_id: 'daemon-test-1',
    message_id: 'msg-0001',
    delivery_id: 'del-0001',
    from_endpoint: 'ep-sender',
    to_endpoint: 'ep-receiver',
    group_id: 'group-default',
    target_generation: 1,
    delivery_seq: '1',
    text: 'first message',
    reply_depth: 0,
    sent_at: new Date().toISOString(),
  };

  // 1. Initial notification delivered
  await server.notification({
    method: 'notifications/arlo/message',
    params: payload,
  });
  assert.equal(dispatchCount, 1, 'Initial notification must be delivered');

  // 2. Unsubscribe stops delivery
  unsubscribe();

  await server.notification({
    method: 'notifications/arlo/message',
    params: { ...payload, message_id: 'msg-0002', delivery_seq: '2' },
  });
  assert.equal(dispatchCount, 1, 'Notification after unsubscribe must not be delivered');

  // 3. Re-subscribe resumes delivery
  attachArloNotificationHandler(client, () => {
    dispatchCount++;
  });

  await server.notification({
    method: 'notifications/arlo/message',
    params: { ...payload, message_id: 'msg-0003', delivery_seq: '3' },
  });
  assert.equal(dispatchCount, 2, 'Notification after resubscribe must be delivered');

  // 4. Close client completely halts delivery and tears down connection
  await client.close();

  await assert.rejects(
    async () => {
      await server.notification({
        method: 'notifications/arlo/message',
        params: { ...payload, message_id: 'msg-0004', delivery_seq: '4' },
      });
    },
    /closed|Not connected|failed/i
  );

  assert.equal(dispatchCount, 2, 'No notifications delivered after client close');
  await server.close();
});
