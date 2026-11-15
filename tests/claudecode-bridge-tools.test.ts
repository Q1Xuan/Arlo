import assert from 'node:assert/strict';
import http from 'node:http';
import { test, type TestContext } from 'node:test';
import { ControlClient, ArloError } from '@arlo/sdk';
import {
  ClaudeCodeBridgeServer,
  ClaudeCodeSidecar,
  generateBridgeToken,
  type BridgeIdentity,
} from '../packages/adapter-claudecode/src/index.ts';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

type BridgeTarget = Pick<ClaudeCodeSidecar, 'url' | 'token'>;

function headers(sidecar: BridgeTarget, identity: BridgeIdentity): Record<string, string> {
  return {
    Authorization: `Bearer ${sidecar.token}`,
    'x-session-id': identity.sessionId,
    'x-bridge-instance': identity.instanceId,
    'x-bridge-generation': String(identity.generation),
    'Content-Type': 'application/json',
  };
}

async function request(sidecar: BridgeTarget, identity: BridgeIdentity, route: string, body: unknown) {
  const response = await fetch(`${sidecar.url}/api/v1/bridge${route}`, {
    method: 'POST', headers: headers(sidecar, identity), body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function attach(sidecar: ClaudeCodeSidecar): Promise<BridgeIdentity> {
  await sidecar.start();
  const status = await fetch(`${sidecar.url}/api/v1/bridge/status`, {
    headers: { Authorization: `Bearer ${sidecar.token}`, 'x-session-id': sidecar.sessionId },
  });
  const result = await request(sidecar, await status.json(), '/handshake', {
    modVersion: '0.1.0', capabilities: ['prompt.submit'],
  });
  assert.equal(result.status, 200);
  await sidecar.waitForReady(15000);
  return result.body;
}

async function sidecarFixture(t: TestContext) {
  const daemon = await MessageStatusFixture.create({ roots: 0 });
  const stateDir = createTempDir('bridge-tools');
  const sidecars: ClaudeCodeSidecar[] = [];
  t.after(async () => {
    for (const sidecar of sidecars) await sidecar.stop();
    await daemon.dispose();
    removeTempDir(stateDir);
  });
  async function add(sessionId: string, groupName = 'bridge-tool-group', controlClient: ControlClient = daemon.control) {
    const before = new Set((await daemon.control.listRoots()).map(root => root.endpoint_id));
    const sidecar = new ClaudeCodeSidecar({
      sessionId, groupName, stateDir, controlClient,
    });
    sidecars.push(sidecar);
    const identity = await attach(sidecar);
    const registration = (await daemon.control.listRoots()).find(root => !before.has(root.endpoint_id));
    assert.ok(registration);
    return { sidecar, identity, endpointId: registration.endpoint_id };
  }
  return { add, daemonStateDir: daemon.stateDir };
}

test('bridge model tools use the live root and its communication group through the real daemon', async t => {
  const fixture = await sidecarFixture(t);
  const sender = await fixture.add('sender');
  const receiver = await fixture.add('receiver');
  await fixture.add('unrelated', 'another-group');

  const listed = await request(sender.sidecar, sender.identity, '/tools/call', {
    name: 'arlo_list_sessions', arguments: {},
  });
  assert.equal(listed.status, 200);
  const sessions = JSON.parse(listed.body.content[0].text);
  assert.deepEqual(sessions.map((session: { endpoint_id: string }) => session.endpoint_id), [receiver.endpointId]);
  let sentMessageId: string;

  await t.test('runtime argument whitelist and validation errors survive the bridge', async () => {
    for (const [name, args, code] of [
      ['arlo_list_sessions', { sessionId: 'receiver' }, 'INVALID_ARGUMENT'],
      ['arlo_list_sessions', { agentId: 'model-identity' }, 'INVALID_ARGUMENT'],
      ['arlo_send_message', { to: receiver.endpointId, text: 'forged', from: 'receiver' }, 'INVALID_ARGUMENT'],
      ['arlo_send_message', { to: receiver.endpointId, text: 'forged', _meta: {} }, 'INVALID_ARGUMENT'],
      ['arlo_send_message', { to: '*', text: 'broadcast' }, 'INVALID_ARGUMENT'],
      ['arlo_send_message', { to: receiver.endpointId, text: '' }, 'INVALID_ARGUMENT'],
      ['arlo_send_message', { to: receiver.endpointId, text: 'x'.repeat(32769) }, 'MESSAGE_TOO_LARGE'],
      ['arlo_get_message_status', { message_id: 'unknown', sender: 'receiver' }, 'INVALID_ARGUMENT'],
      ['arlo_get_message_status', { message_id: '' }, 'INVALID_ARGUMENT'],
    ] as const) {
      const result = await request(sender.sidecar, sender.identity, '/tools/call', { name, arguments: args });
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, code);
    }
    const pending = await fetch(`${receiver.sidecar.url}/api/v1/bridge/messages/pending`, {
      headers: headers(receiver.sidecar, receiver.identity),
    });
    assert.deepEqual((await pending.json()).messages, []);
  });

  await t.test('a full endpoint send reaches the receiver and only its sending root can query the receipt', async () => {
    const sent = await request(sender.sidecar, sender.identity, '/tools/call', {
      name: 'arlo_send_message', arguments: { to: sessions[0].endpoint_id, text: 'sent through the daemon' },
    });
    assert.equal(sent.status, 200);
    const outcome = JSON.parse(sent.body.content[0].text);
    sentMessageId = outcome.message_id;
    assert.equal(outcome.status, 'accepted');
    assert.equal(typeof outcome.message_id, 'string');
    const pending = await fetch(`${receiver.sidecar.url}/api/v1/bridge/messages/pending`, {
      headers: headers(receiver.sidecar, receiver.identity),
    });
    const messages = (await pending.json()).messages;
    assert.deepEqual(messages.map((message: { messageId: string; text: string; fromEndpoint: string }) => ({
      messageId: message.messageId, text: message.text, fromEndpoint: message.fromEndpoint,
    })), [{ messageId: outcome.message_id, text: 'sent through the daemon', fromEndpoint: sender.endpointId }]);

    const query = { name: 'arlo_get_message_status', arguments: { message_id: outcome.message_id } };
    const own = await request(sender.sidecar, sender.identity, '/tools/call', query);
    assert.equal(own.status, 200);
    assert.equal(JSON.parse(own.body.content[0].text).status, 'accepted');
    const other = await request(receiver.sidecar, receiver.identity, '/tools/call', query);
    assert.equal(other.status, 200);
    assert.equal(JSON.parse(other.body.content[0].text).status, 'result_unavailable');
  });

  await t.test('production first sending allowance remains unknown until trusted configuration is implemented', async () => {
    const production = await fixture.add('unconfigured', 'bridge-tool-group',
      new ControlClient({ stateDir: fixture.daemonStateDir }));
    const sent = await request(production.sidecar, production.identity, '/tools/call', {
      name: 'arlo_send_message', arguments: { to: receiver.endpointId, text: 'requires human allowance' },
    });
    assert.equal(sent.status, 400);
    assert.equal(sent.body.error.code, 'ALLOWANCE_UNKNOWN');
  });

  await t.test('a replaced host context cannot adopt the retired root message status', async () => {
    const retired = await request(sender.sidecar, sender.identity, '/session/retire', {});
    assert.equal(retired.status, 200);
    const replaced = await request(sender.sidecar, retired.body, '/session/activate', { sessionId: 'replacement' });
    assert.equal(replaced.status, 200);
    await sender.sidecar.waitForReady(15000);
    const query = { name: 'arlo_get_message_status', arguments: { message_id: sentMessageId } };
    const late = await request(sender.sidecar, sender.identity, '/tools/call', query);
    assert.equal(late.body.error.code, 'SESSION_MISMATCH');
    const current = await request(sender.sidecar, replaced.body, '/tools/call', query);
    assert.equal(current.status, 200);
    assert.equal(JSON.parse(current.body.content[0].text).status, 'result_unavailable');
  });
});

test('late tool success and errors are fenced by the immutable request generation', async t => {
  for (const fails of [false, true]) {
    await t.test(fails ? 'late runtime error' : 'late success', async t => {
      const entered = Promise.withResolvers<BridgeIdentity>();
      const complete = Promise.withResolvers<void>();
      const token = generateBridgeToken();
      const server = new ClaudeCodeBridgeServer({
        sessionId: 'late-root', token,
        onToolCall: async (_request, identity) => {
          entered.resolve(identity);
          await complete.promise;
          if (fails) throw new ArloError('ALLOWANCE_UNKNOWN');
          return [{ type: 'text', text: '[]' }];
        },
      });
      await server.start();
      t.after(async () => { complete.resolve(); await server.stop(); });
      const target = { url: server.url, token };
      const identity = { sessionId: server.sessionId, instanceId: server.instanceId, generation: 0 };
      const pending = request(target, identity, '/tools/call', { name: 'arlo_list_sessions', arguments: {} });
      assert.deepEqual(await entered.promise, identity);
      const next = await request(target, identity, '/handshake', { modVersion: '0.1.0', capabilities: ['prompt.submit'] });
      assert.equal(next.status, 200);
      complete.resolve();
      const late = await pending;
      assert.equal(late.status, 409);
      assert.equal(late.body.error.code, 'STALE_BINDING');
    });
  }
});

test('bridge rejects tool wrapper identity and malformed names before dispatch', async t => {
  const token = generateBridgeToken();
  const server = new ClaudeCodeBridgeServer({
    sessionId: 'wrapper-root', token,
    onToolCall: async () => [{ type: 'text', text: '[]' }],
  });
  await server.start();
  t.after(() => server.stop());
  // The callback is the public bridge boundary; these requests must be
  // rejected even when an available handler would return success.
  const target = { url: server.url, token };
  const identity = { sessionId: server.sessionId, instanceId: server.instanceId, generation: 0 };
  for (const body of [
    { name: ['arlo_list_sessions'], arguments: {} },
    { name: 'arlo_list_sessions', arguments: {}, sessionId: 'forged-root' },
    { name: 'arlo_list_sessions', arguments: {}, agentId: 'forged-agent' },
    { name: 'arlo_list_sessions' },
    { name: 'continueCollaboration', arguments: {} },
    null,
  ]) {
    const response = await request(target, identity, '/tools/call', body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_ARGUMENT');
  }
});

test('model tools require authentication, the current root, instance and generation', async t => {
  const token = generateBridgeToken();
  const server = new ClaudeCodeBridgeServer({ sessionId: 'gated-root', token,
    onToolCall: async () => [{ type: 'text', text: '[]' }],
  });
  await server.start();
  t.after(() => server.stop());
  const target = { url: server.url, token };
  const identity = { sessionId: server.sessionId, instanceId: server.instanceId, generation: 0 };
  for (const [header, value, status, code] of [
    ['Authorization', undefined, 401, 'UNAUTHORIZED'],
    ['Authorization', 'Bearer wrong', 401, 'UNAUTHORIZED'],
    ['x-session-id', undefined, 400, 'INVALID_ARGUMENT'],
    ['x-session-id', 'other-root', 403, 'SESSION_MISMATCH'],
    ['x-bridge-instance', undefined, 400, 'INVALID_ARGUMENT'],
    ['x-bridge-instance', 'previous-sidecar', 409, 'STALE_BINDING'],
    ['x-bridge-generation', undefined, 400, 'INVALID_ARGUMENT'],
    ['x-bridge-generation', '00', 400, 'INVALID_ARGUMENT'],
    ['x-bridge-generation', '9', 409, 'STALE_BINDING'],
  ] as const) {
    const sentHeaders = headers(target, identity);
    if (value === undefined) delete sentHeaders[header];
    else sentHeaders[header] = value;
    const response = await fetch(`${server.url}/api/v1/bridge/tools/call`, {
      method: 'POST', headers: sentHeaders, body: JSON.stringify({ name: 'arlo_list_sessions', arguments: {} }),
    });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
});

test('retirement fences a tool body that began before context replacement', async t => {
  const token = generateBridgeToken();
  const server = new ClaudeCodeBridgeServer({ sessionId: 'delayed-root', token,
    onToolCall: async () => [{ type: 'text', text: '[]' }],
    onActivate: async () => undefined,
  });
  await server.start();
  let delayed: http.ClientRequest | undefined;
  t.after(async () => { delayed?.destroy(); await server.stop(); });
  const target = { url: server.url, token };
  const identity = { sessionId: server.sessionId, instanceId: server.instanceId, generation: 0 };
  const body = JSON.stringify({ name: 'arlo_send_message', arguments: { to: 'ep-target', text: 'stale' } });
  const response = Promise.withResolvers<{ status: number; body: any }>();
  const receivedHeaders = Promise.withResolvers<void>();
  delayed = http.request(`${server.url}/api/v1/bridge/tools/call`, {
    method: 'POST', headers: { ...headers(target, identity), Expect: '100-continue',
      'Content-Length': String(Buffer.byteLength(body)) },
  }, incoming => {
    let text = '';
    incoming.on('data', chunk => { text += chunk; });
    incoming.on('end', () => response.resolve({ status: incoming.statusCode!, body: JSON.parse(text) }));
  });
  delayed.on('error', response.reject);
  delayed.once('continue', () => receivedHeaders.resolve());
  delayed.flushHeaders();
  await receivedHeaders.promise;
  const retired = await request(target, identity, '/session/retire', {});
  assert.equal(retired.status, 200);
  const replaced = await request(target, retired.body, '/session/activate', { sessionId: 'next-root' });
  assert.equal(replaced.status, 200);
  delayed.end(body);
  const result = await response.promise;
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'STALE_BINDING');
});

test('unknown tool failures do not expose internal messages or forged runtime error codes', async t => {
  const token = generateBridgeToken();
  const server = new ClaudeCodeBridgeServer({ sessionId: 'error-root', token,
    onToolCall: async () => { throw Object.assign(new Error('private credential and path'), { code: 'ALLOWANCE_UNKNOWN' }); },
  });
  await server.start();
  t.after(() => server.stop());
  const result = await request({ url: server.url, token }, {
    sessionId: server.sessionId, instanceId: server.instanceId, generation: 0,
  }, '/tools/call', { name: 'arlo_list_sessions', arguments: {} });
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: {
    code: 'INTERNAL_ERROR', message: 'Unexpected internal Sidecar failure', details: null,
  } });
});
