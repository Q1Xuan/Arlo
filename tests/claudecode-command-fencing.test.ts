import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { ArloError } from '@arlo/sdk';
import { ClaudeCodeBridgeServer, generateBridgeToken, type BridgeIdentity } from '../packages/adapter-claudecode/src/index.ts';

function headers(token: string, identity: BridgeIdentity): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'x-session-id': identity.sessionId,
    'x-bridge-instance': identity.instanceId, 'x-bridge-generation': String(identity.generation),
    'Content-Type': 'application/json' };
}

async function request(url: string, sentHeaders: Record<string, string>, route: string, body: unknown) {
  const result = await fetch(`${url}/api/v1/bridge${route}`, {
    method: 'POST', headers: sentHeaders, body: JSON.stringify(body),
  });
  return { status: result.status, body: await result.json() };
}

test('human command bridge requires current authenticated attachment and rejects identity overrides', async t => {
  const token = generateBridgeToken();
  const server = new ClaudeCodeBridgeServer({ sessionId: 'command-root', token,
    onCommand: async () => ({ text: 'Current root status' }) });
  await server.start();
  t.after(() => server.stop());
  const current = headers(token, { sessionId: server.sessionId, instanceId: server.instanceId, generation: 0 });
  for (const [key, value, expected] of [
    ['Authorization', 'Bearer wrong', 'UNAUTHORIZED'],
    ['x-session-id', 'another-root', 'SESSION_MISMATCH'],
    ['x-bridge-instance', 'old-sidecar', 'STALE_BINDING'],
    ['x-bridge-generation', '1', 'STALE_BINDING'],
  ] as const) {
    const result = await request(server.url, { ...current, [key]: value }, '/commands/call', {
      name: 'arlo-continue', arguments: '',
    });
    assert.equal(result.body.error.code, expected);
  }
  for (const body of [
    { name: 'arlo-continue', arguments: '', sessionId: 'another-root' },
    { name: 'arlo-continue', arguments: '', grant: 100 },
    { name: 'arlo-continue', arguments: '', request_id: 'caller-request' },
    { name: 'arlo-continue', arguments: { grant: 20 } },
    { name: 'initializeRootSending', arguments: '' },
  ]) {
    const result = await request(server.url, current, '/commands/call', body);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_ARGUMENT');
  }
});

test('late human command success and failure are withheld after a Mod handshake replaces its attachment', async t => {
  for (const fails of [false, true]) {
    await t.test(fails ? 'failed operation' : 'successful operation', async t => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const token = generateBridgeToken();
      const server = new ClaudeCodeBridgeServer({ sessionId: 'late-command', token,
        onCommand: async () => {
          entered.resolve();
          await release.promise;
          if (fails) throw new ArloError('ALLOWANCE_UNKNOWN');
          return { text: 'Old root status' };
        } });
      await server.start();
      t.after(async () => { release.resolve(); await server.stop(); });
      const current = headers(token, { sessionId: server.sessionId, instanceId: server.instanceId, generation: 0 });
      const pending = request(server.url, current, '/commands/call', { name: 'arlo-send-status', arguments: '' });
      await entered.promise;
      const attached = await request(server.url, current, '/handshake', {
        modVersion: '0.1.0', capabilities: ['prompt.submit'],
      });
      assert.equal(attached.status, 200);
      release.resolve();
      const late = await pending;
      assert.equal(late.status, 409);
      assert.equal(late.body.error.code, 'STALE_BINDING');
    });
  }
});

test('a command whose body arrives after root retirement cannot continue the replacement root', async t => {
  const token = generateBridgeToken();
  const server = new ClaudeCodeBridgeServer({ sessionId: 'old-context', token,
    onCommand: async () => ({ text: 'Continued' }), onActivate: async () => undefined });
  await server.start();
  let delayed: http.ClientRequest | undefined;
  t.after(async () => { delayed?.destroy(); await server.stop(); });
  const current = headers(token, { sessionId: server.sessionId, instanceId: server.instanceId, generation: 0 });
  const body = JSON.stringify({ name: 'arlo-continue', arguments: '' });
  const result = Promise.withResolvers<{ status: number; body: any }>();
  const ready = Promise.withResolvers<void>();
  delayed = http.request(`${server.url}/api/v1/bridge/commands/call`, {
    method: 'POST', headers: { ...current, Expect: '100-continue', 'Content-Length': String(Buffer.byteLength(body)) },
  }, response => {
    let text = '';
    response.on('data', chunk => { text += chunk; });
    response.on('end', () => result.resolve({ status: response.statusCode!, body: JSON.parse(text) }));
  });
  delayed.on('error', result.reject);
  delayed.once('continue', () => ready.resolve());
  delayed.flushHeaders();
  await ready.promise;
  const retired = await request(server.url, current, '/session/retire', {});
  assert.equal(retired.status, 200);
  const replaced = await request(server.url, headers(token, retired.body), '/session/activate', { sessionId: 'new-context' });
  assert.equal(replaced.status, 200);
  delayed.end(body);
  const late = await result.promise;
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'STALE_BINDING');
});
