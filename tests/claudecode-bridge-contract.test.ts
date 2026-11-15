import { fetchCurrentBridge } from './helpers/claudecode-bridge-client.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ClaudeCodeBridgeServer,
  generateBridgeToken,
  type BridgeContractConfig,
  BRIDGE_ERROR_CODES,
  ClaudeCodeReceptionHost,
} from '../packages/adapter-claudecode/src/index.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('Bridge Server - Ephemeral Token & Contract Verification (Seam A)', async (t) => {
  const sessionId = 'session-cc-test-01';
  const token = generateBridgeToken();
  const server = new ClaudeCodeBridgeServer({
    sessionId,
    token,
    port: 0, // ephemeral port
    host: '127.0.0.1',
  });

  await server.start();
  const baseUrl = server.url;

  t.after(async () => {
    await server.stop();
  });

  await t.test('rejects request without Authorization header', async () => {
    const res = await fetchCurrentBridge(`${baseUrl}/api/v1/bridge/status`, {
      headers: {
        'x-session-id': sessionId,
      },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, BRIDGE_ERROR_CODES.UNAUTHORIZED);
    assert.match(body.error.message, /Missing or malformed Authorization header/i);
  });

  await t.test('rejects request with malformed Authorization header', async () => {
    const res = await fetchCurrentBridge(`${baseUrl}/api/v1/bridge/status`, {
      headers: {
        'Authorization': 'Basic invalid-auth',
        'x-session-id': sessionId,
      },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, BRIDGE_ERROR_CODES.UNAUTHORIZED);
  });

  await t.test('rejects request with wrong Bearer token', async () => {
    const res = await fetchCurrentBridge(`${baseUrl}/api/v1/bridge/status`, {
      headers: {
        'Authorization': 'Bearer wrong-token-12345',
        'x-session-id': sessionId,
      },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, BRIDGE_ERROR_CODES.UNAUTHORIZED);
    assert.match(body.error.message, /Invalid bridge bearer token/i);
  });

  await t.test('rejects request with mismatched session ID', async () => {
    const res = await fetchCurrentBridge(`${baseUrl}/api/v1/bridge/status`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-session-id': 'different-session-id',
      },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, BRIDGE_ERROR_CODES.SESSION_MISMATCH);
    assert.match(body.error.message, /Session ID does not match/i);
  });

  await t.test('rejects request with missing session ID header', async () => {
    const res = await fetchCurrentBridge(`${baseUrl}/api/v1/bridge/status`, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, BRIDGE_ERROR_CODES.INVALID_ARGUMENT);
    assert.match(body.error.message, /Missing x-session-id header/i);
  });

  await t.test('accepts valid authenticated request matching session identity', async () => {
    const res = await fetchCurrentBridge(`${baseUrl}/api/v1/bridge/status`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-session-id': sessionId,
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.status, 'active');
    assert.equal(typeof body.version, 'string');
  });

  await t.test('handshake endpoint validates session and returns bridge contract info', async () => {
    const res = await fetchCurrentBridge(`${baseUrl}/api/v1/bridge/handshake`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-session-id': sessionId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        modVersion: '0.1.0',
        capabilities: ['prompt.submit'],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.accepted, true);
    assert.equal(body.contractVersion, '2.0.0');
  });

  await t.test('a new attachment generation may reuse an old idempotency key', async () => {
    const idempotencyKey = 'idem-key-001';
    const payload = {
      modVersion: '0.1.0',
      capabilities: ['prompt.submit'],
    };

    const res1 = await fetchCurrentBridge(`${baseUrl}/api/v1/bridge/handshake`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-session-id': sessionId,
        'x-idempotency-key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.accepted, true);

    // Repeat with identical idempotency key
    const res2 = await fetchCurrentBridge(`${baseUrl}/api/v1/bridge/handshake`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-session-id': sessionId,
        'x-idempotency-key': idempotencyKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.generation, body1.generation + 1);
    assert.equal(body2.instanceId, body1.instanceId);
  });

  await t.test('rejects malformed JSON with INVALID_ARGUMENT', async () => {
    const res = await fetchCurrentBridge(`${baseUrl}/api/v1/bridge/messages/settle`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-session-id': sessionId,
        'Content-Type': 'application/json',
      },
      body: '{',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, BRIDGE_ERROR_CODES.INVALID_ARGUMENT);
  });

  await t.test('retrieves pending messages and settles via bridge server', async () => {
    let settledNativeId: string | undefined;
    let settledEvent: string | undefined;

    const mockReceptionHost = {
      getPendingMessages: () => [
        {
          nativeMessageId: 'native-100',
          messageId: 'msg-100',
          text: 'Hello from bridge',
          fromEndpoint: 'sender-ep',
          dispatch: { endpoint_id: 'sender-ep', daemon_id: 'daemon-1' },
          enqueuedAt: '2026-10-18T00:00:00.000Z',
        },
      ],
      beginDispatch: (nativeId: string) => {
        settledNativeId = nativeId;
        settledEvent = 'dispatching';
      },
      settle: async (nativeId: string, event: 'claimed' | 'discarded') => {
        settledNativeId = nativeId;
        settledEvent = event;
      },
    };

    const hostServer = new ClaudeCodeBridgeServer({
      sessionId: 'session-host-test',
      token,
      port: 0,
      receptionHost: mockReceptionHost,
    });
    await hostServer.start();

    try {
      // 1. Fetch pending messages
      const getRes = await fetchCurrentBridge(`${hostServer.url}/api/v1/bridge/messages/pending`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-session-id': 'session-host-test',
        },
      });
      assert.equal(getRes.status, 200);
      const getBody = await getRes.json();
      assert.equal(getBody.messages.length, 1);
      assert.equal(getBody.messages[0].nativeMessageId, 'native-100');
      assert.equal(getBody.messages[0].text, 'Hello from bridge');

      const settleRes = await fetchCurrentBridge(`${hostServer.url}/api/v1/bridge/messages/settle`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-session-id': 'session-host-test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          nativeMessageId: 'native-100',
          status: 'dispatching',
          timestamp: Date.now(),
        }),
      });
      assert.equal(settleRes.status, 200);
      const settleBody = await settleRes.json();
      assert.equal(settleBody.settled, false);
      assert.equal(settledNativeId, 'native-100');
      assert.equal(settledEvent, 'dispatching');

      const claimed = await fetchCurrentBridge(`${hostServer.url}/api/v1/bridge/messages/settle`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-session-id': 'session-host-test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          nativeMessageId: 'native-100',
          status: 'claimed',
          timestamp: Date.now(),
        }),
      });
      assert.equal(claimed.status, 400);
      const claimedBody = await claimed.json();
      assert.equal(claimedBody.error.code, BRIDGE_ERROR_CODES.INVALID_ARGUMENT);
      assert.equal(settledEvent, 'dispatching');
    } finally {
      await hostServer.stop();
    }
  });
});

test('bridge validates real input identity, transitions, and concurrent idempotent reports', async (t) => {
  const storageDir = createTempDir('cc-bridge-reports-');
  t.after(() => removeTempDir(storageDir));
  const receptionHost = new ClaudeCodeReceptionHost({ sessionId: 'reports', storageDir });
  const prepared = receptionHost.prepare({
    protocol_version: '0.1', daemon_id: 'daemon', message_id: 'message', delivery_id: 'delivery',
    from_endpoint: 'sender', to_endpoint: 'receiver', group_id: 'group', target_generation: 1,
    delivery_seq: '1', text: 'payload', sent_at: new Date().toISOString(),
  });
  await prepared.enqueue();
  let handshakes = 0;
  // The test supplies the same session token through the public HTTP boundary.
  const token = generateBridgeToken();
  const authenticated = new ClaudeCodeBridgeServer({
    sessionId: 'reports', token, receptionHost,
    onHandshake: () => { handshakes += 1; },
  });
  await authenticated.start();
  t.after(() => authenticated.stop());
  const headers = { Authorization: `Bearer ${token}`, 'x-session-id': 'reports', 'Content-Type': 'application/json' };
  const post = async (body: unknown, key?: string, route = '/messages/settle') => {
    const response = await fetchCurrentBridge(`${authenticated.url}/api/v1/bridge${route}`, {
      method: 'POST', headers: { ...headers, ...(key ? { 'x-idempotency-key': key } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const report = { nativeMessageId: prepared.nativeMessageId, messageId: 'message', status: 'dispatching', timestamp: 1 };

  for (const malformed of [null, [], {}, { ...report, nativeMessageId: 1 }, { ...report, timestamp: 'now' },
    { ...report, reason: {} }, { ...report, status: 'claimed' }]) {
    const response = await post(malformed);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_ARGUMENT');
    assert.equal(response.body.error.details, null);
  }
  assert.equal((await post({ ...report, nativeMessageId: 'missing' })).status, 404);
  assert.equal((await post({ ...report, messageId: 'wrong-message' })).status, 409);
  assert.equal((await post({ ...report, status: 'submitting' })).status, 409);
  assert.equal(receptionHost.getPendingMessages().length, 1);

  const pending = await fetchCurrentBridge(`${authenticated.url}/api/v1/bridge/messages/pending`, { headers });
  assert.equal((await pending.json()).messages[0].fromEndpoint, 'sender');
  const results = await Promise.all([post(report, 'arm'), post(report, 'arm')]);
  assert.equal(results[0].status, 200);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await post(report, 'other-arm')).status, 409);
  assert.equal((await post({ ...report, status: 'unknown' }, 'arm')).status, 409);
  const handshake = { modVersion: '0.1.0', capabilities: ['prompt.submit'] };
  assert.equal((await post(handshake, 'arm', '/handshake')).status, 409);
  assert.equal(handshakes, 0);
  assert.equal((await post({ ...report, status: 'enqueued' }, 'cancel')).status, 200);
  assert.equal(receptionHost.getPendingMessages()[0]?.nativeMessageId, prepared.nativeMessageId);
  const recovered = new ClaudeCodeReceptionHost({ sessionId: 'reports', storageDir });
  await recovered.recover();
  assert.equal(recovered.getPendingMessages()[0]?.nativeMessageId, prepared.nativeMessageId);

  for (const malformed of [null, {}, { modVersion: 'wrong', capabilities: ['prompt.submit'] },
    { modVersion: '0.1.0', capabilities: [] }, { modVersion: '0.1.0', capabilities: 'prompt.submit' }]) {
    assert.equal((await post(malformed, undefined, '/handshake')).status, 400);
  }
  assert.equal(handshakes, 0);
  const handshakesResponses = await Promise.all([post(handshake, 'hello', '/handshake'), post(handshake, 'hello', '/handshake')]);
  assert.deepEqual(handshakesResponses.map(response => response.status).sort(), [200, 409]);
  assert.equal(handshakesResponses.find(response => response.status === 409)!.body.error.code, 'STALE_BINDING');
  assert.equal(handshakes, 1);
});

