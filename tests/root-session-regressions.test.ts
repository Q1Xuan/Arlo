import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { ArloDaemon } from '@arlo/daemon';
import {
  ControlClient, createPinnedHttpsAgent, readDiscoveryRecord, sendSecureArloRequest,
  validateExplicitGroupName, type RuntimeRegistrationRequest, type RootRegistrationRequest, type RootRegistrationResponse, type RootConnection,
} from '@arlo/sdk';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { createPinnedFetch } from '../probes/pinned-fetch.ts';
import { fixture, LocalModel, toolResponse } from '../probes/fixture.ts';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createTempDir, removeTempDir } from './test-utils.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail('Expected lifecycle transition did not complete');
}

test('Root Session registration preserves ownership, capacity, Unicode and current MCP bindings', async t => {
  const stateDir = createTempDir('root-regressions');
  const daemon = new ArloDaemon({ stateDir });
  let agent: https.Agent | undefined;
  try {
    const { port } = await daemon.start();
    const control = new ControlClient({ stateDir });
    agent = createPinnedHttpsAgent(readDiscoveryRecord(stateDir).cert_pem);
    // Observe real incoming bytes to place lifecycle changes exactly inside the
    // body-read await. The observer never changes the daemon's request handling.
    const server = Reflect.get(daemon, 'server') as https.Server;
    const rootBody = (id: string, group = 'review-regressions') => ({
      root_session_id: id, group_name: group, agent_incarnation: id, plugin_generation: 1,
    });
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
    const mcp = (token: string, body = initialize) => sendSecureArloRequest({
      url: `https://127.0.0.1:${port}/mcp`, agent: agent!, token, body: JSON.stringify(body),
    });
    async function pauseBody(token: string, pathname: string, body: unknown, splitAt = 1) {
      const bytes = Buffer.from(JSON.stringify(body));
      const received = deferred<void>();
      const observe = (req: import('node:http').IncomingMessage) => {
        if (req.url === pathname) req.once('data', () => received.resolve());
      };
      server.on('request', observe);
      const result = deferred<{ status: number; body: any }>();
      const request = https.request(`https://127.0.0.1:${port}${pathname}`, {
        agent, method: 'POST', headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(bytes.length),
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => result.resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      request.on('error', () => { received.resolve(); result.resolve({ status: 0, body: {} }); });
      request.write(bytes.subarray(0, splitAt));
      await received.promise;
      server.off('request', observe);
      return { finish: () => request.end(bytes.subarray(splitAt)), result: result.promise };
    }

    await t.test('Plugin configuration and Daemon registration both reject hidden group line breaks', async () => {
      const rt = await control.registerRuntime();
      try {
        for (const groupName of ['\nteam', 'team\n', '\tteam\t', 'team\u2028other', 'team\u2029other']) {
          assert.throws(() => createArloHarnessPlugin({ groupName, stateDir }), { code: 'INVALID_ARGUMENT' });
          await assert.rejects(control.registerRoot(rt.runtime_token, rootBody('invalid-group', groupName)), { code: 'INVALID_ARGUMENT' });
        }
        assert.deepEqual(await control.listRoots(rt.runtime_token), []);
      } finally { await control.revokeRuntime(rt.runtime_token); }
    });

    await t.test('Unicode Communication Group survives a split inside a UTF-8 character', async () => {
      const rt = await control.registerRuntime();
      try {
        const body = rootBody('unicode-root', '研发');
        const split = Buffer.from(JSON.stringify(body)).indexOf(Buffer.from('研')) + 1;
        const pending = await pauseBody(rt.runtime_token, '/control/v1/roots/register', body, split);
        pending.finish();
        const result = await pending.result;
        assert.equal(result.status, 200);
        assert.equal(result.body.group_id, validateExplicitGroupName('研发').groupId);
      } finally { await control.revokeRuntime(rt.runtime_token); }
    });

    await t.test('Runtime revocation rejects an already pending root registration', async () => {
      const rt = await control.registerRuntime();
      const pending = await pauseBody(rt.runtime_token, '/control/v1/roots/register', rootBody('revoked-runtime'));
      await control.revokeRuntime(rt.runtime_token);
      pending.finish();
      const result = await pending.result;
      // Clean up on the unfixed implementation without masking the assertion.
      if (result.status === 200) await control.revokeRoot(result.body.root_token, { endpoint_id: result.body.endpoint_id });
      assert.ok([401, 403].includes(result.status), `Expected rejection, got ${result.status}`);
      assert.equal((await control.listRoots()).filter(r => r.runtime_id === rt.runtime_id && r.status === 'registered').length, 0);
    });

    await t.test('Old MCP initialization cannot overwrite a new connection generation', async () => {
      const rt = await control.registerRuntime();
      try {
        const root = await control.registerRoot(rt.runtime_token, rootBody('generation-root'));
        const pending = await pauseBody(root.root_token, '/mcp', initialize);
        const next = await control.connectRoot(rt.runtime_token, { endpoint_id: root.endpoint_id });
        pending.finish();
        assert.equal((await pending.result).status, 403);
        assert.equal((await mcp(next.root_token)).status, 200);
      } finally { await control.revokeRuntime(rt.runtime_token); }
    });

    await t.test('Root revocation rejects an MCP request already waiting for its body', async () => {
      const rt = await control.registerRuntime();
      try {
        const root = await control.registerRoot(rt.runtime_token, rootBody('revoked-root'));
        const pending = await pauseBody(root.root_token, '/mcp', initialize);
        await control.revokeRoot(rt.runtime_token, { endpoint_id: root.endpoint_id });
        pending.finish();
        assert.equal((await pending.result).status, 403);
      } finally { await control.revokeRuntime(rt.runtime_token); }
    });

    await t.test('Concurrent registrations cannot exceed the 256 Endpoint limit', async () => {
      const rt = await control.registerRuntime();
      try {
        for (let i = 0; i < 255; i++) await control.registerRoot(rt.runtime_token, rootBody(`bulk-${i}`));
        const first = await pauseBody(rt.runtime_token, '/control/v1/roots/register', rootBody('bulk-255'));
        const second = await pauseBody(rt.runtime_token, '/control/v1/roots/register', rootBody('bulk-256'));
        first.finish();
        second.finish();
        const results = await Promise.all([first.result, second.result]);
        assert.deepEqual(results.map(r => r.status).sort(), [200, 429]);
        assert.equal((await control.listRoots()).filter(r => r.status === 'registered').length, 256);
      } finally { await control.revokeRuntime(rt.runtime_token); }
    });

    await t.test('Duplicate Runtime IDs cannot acquire an existing ownership scope', async () => {
      const rt = await control.registerRuntime({ runtime_id: 'fixed-regression-runtime' });
      try {
        const root = await control.registerRoot(rt.runtime_token, rootBody('owned-root'));
        await assert.rejects(control.registerRuntime({ runtime_id: rt.runtime_id }), { code: 'INVALID_ARGUMENT' });
        assert.equal((await control.listRoots(rt.runtime_token))[0].endpoint_id, root.endpoint_id);
      } finally { await control.revokeRuntime(rt.runtime_token); }
      await assert.rejects(control.registerRuntime({ runtime_id: rt.runtime_id }), { code: 'INVALID_ARGUMENT' });
    });

    await t.test('Pinned MCP SDK completes initialization and calls root tools', async () => {
      const rt = await control.registerRuntime();
      const pinned = createPinnedFetch(readDiscoveryRecord(stateDir).cert_pem);
      const client = new Client({ name: 'regression-client', version: '0.1' }, {
        supportedProtocolVersions: ['2025-06-18'], versionNegotiation: { mode: 'legacy' },
        capabilities: { experimental: { 'arlo/session-messaging': { version: '0.1' } } },
      });
      try {
        const root = await control.registerRoot(rt.runtime_token, rootBody('sdk-root'));
        const transport = new StreamableHTTPClientTransport(new URL(`https://127.0.0.1:${port}/mcp`), {
          fetch: pinned.fetch, requestInit: { headers: {
            authorization: `Bearer ${root.root_token}`, 'x-arlo-endpoint-id': root.endpoint_id, 'x-arlo-generation': String(root.generation),
          } }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        });
        await client.connect(transport);
        assert.ok(transport.sessionId);
        const result = await client.callTool({ name: 'arlo_list_sessions', arguments: {} });
        assert.deepEqual(result.content, [{ type: 'text', text: '[]' }]);
        assert.equal((await control.listRoots(rt.runtime_token))[0].ready, false);
      } finally { await client.close(); pinned.close(); await control.revokeRuntime(rt.runtime_token); }
    });

    await t.test('Plugin unload compensates a late Runtime registration response', async () => {
      const arrived = deferred<void>();
      const release = deferred<void>();
      let oldToken: string | undefined;
      let revocations = 0;
      class DelayedClient extends ControlClient {
        async registerRuntime(options: RuntimeRegistrationRequest = {}) {
          const result = await super.registerRuntime(options);
          oldToken = result.runtime_token;
          arrived.resolve();
          await release.promise;
          return result;
        }
        async revokeRuntime(token: string) {
          const result = await super.revokeRuntime(token);
          revocations++;
          return result;
        }
      }
      const delayed = new DelayedClient({ stateDir });
      const host = await fixture();
      try {
        const fork = await host.ctx.plugin(createArloHarnessPlugin({ groupName: 'late-runtime', controlClient: delayed }));
        await arrived.promise;
        await fork.dispose();
        const replacement = await host.ctx.plugin(createArloHarnessPlugin({ groupName: 'late-runtime', stateDir }));
        await until(async () => (await control.listRoots()).some(r => r.status === 'registered'));
        release.resolve();
        await until(() => revocations === 1);
        await assert.rejects(control.listRoots(oldToken), { code: 'STALE_GENERATION' });
        assert.equal((await control.listRoots()).filter(r => r.status === 'registered').length, 1);
        await replacement.dispose();
        await until(async () => (await control.listRoots()).every(r => r.status === 'revoked'));
      } finally {
        release.resolve();
        await host.ctx.fiber.dispose();
        if (oldToken) await control.revokeRuntime(oldToken).catch(() => {});
      }
    });

    await t.test('Agent disposal compensates a late root registration response', async () => {
      const arrived = deferred<void>();
      const release = deferred<void>();
      let endpointId: string | undefined;
      class DelayedRootClient extends ControlClient {
        async registerRoot(token: string, request: RootRegistrationRequest) {
          const result = await super.registerRoot(token, request);
          endpointId = result.endpoint_id;
          arrived.resolve();
          await release.promise;
          return result;
        }
      }
      const host = await fixture();
      try {
        const fork = await host.ctx.plugin(createArloHarnessPlugin({
          groupName: 'late-root', controlClient: new DelayedRootClient({ stateDir }),
        }));
        await arrived.promise;
        await host.root.dispose();
        release.resolve();
        await until(async () => (await control.listRoots()).find(r => r.endpoint_id === endpointId)?.status === 'revoked');
        await fork.dispose();
      } finally { release.resolve(); await host.ctx.fiber.dispose(); }
    });

    await t.test('Disposing one root cancels its handshake without closing another root', async () => {
      const rt = await control.registerRuntime();
      const first = control.createRootConnection(await control.registerRoot(rt.runtime_token, rootBody('cancelled-handshake')));
      const second = control.createRootConnection(await control.registerRoot(rt.runtime_token, rootBody('surviving-connection')));
      try {
        await second.connect();
        const connecting = first.connect();
        first.dispose();
        await assert.rejects(connecting, { code: 'CHANNEL_NOT_READY' });
        await assert.rejects(first.listSessions(), { code: 'CHANNEL_NOT_READY' });
        assert.deepEqual(await second.listSessions(), [{ type: 'text', text: '[]' }]);
      } finally { first.dispose(); second.dispose(); await control.revokeRuntime(rt.runtime_token); }
    });

    await t.test('Agent replacement and registry shutdown revoke old Root Session bindings', async () => {
      const registrations: { request: RootRegistrationRequest; response: RootRegistrationResponse }[] = [];
      class TrackingClient extends ControlClient {
        async registerRoot(token: string, request: RootRegistrationRequest) {
          const response = await super.registerRoot(token, request);
          registrations.push({ request, response });
          return response;
        }
      }
      const host = await fixture();
      try {
        await host.ctx.plugin(createArloHarnessPlugin({ groupName: 'replace-root', controlClient: new TrackingClient({ stateDir }) }));
        await until(() => registrations.length === 1);
        const oldBinding = registrations[0];
        const oldAgent = host.root.agent;
        await host.root.dispose();
        const replacement = await host.ctx.agents.create({
          sessionId: oldAgent.session.id, agentOptions: { provider: 'arlo-local', model: 'scripted' },
        });
        await until(() => registrations.length === 2);
        const newBinding = registrations[1];
        assert.notEqual(replacement.agent, oldAgent);
        assert.equal(newBinding.request.root_session_id, oldBinding.request.root_session_id);
        assert.notEqual(newBinding.request.agent_incarnation, oldBinding.request.agent_incarnation);
        assert.notEqual(newBinding.response.endpoint_id, oldBinding.response.endpoint_id);
        await until(async () => (await control.listRoots()).find(r => r.endpoint_id === oldBinding.response.endpoint_id)?.status === 'revoked');
        assert.equal((await mcp(oldBinding.response.root_token)).status, 403);
        assert.equal((await control.listRoots()).find(r => r.endpoint_id === newBinding.response.endpoint_id)?.status, 'registered');
        await host.ctx.fiber.dispose();
        await until(async () => (await control.listRoots()).every(r => r.status === 'revoked'));
        assert.equal((await mcp(newBinding.response.root_token)).status, 403);
      } finally { await host.ctx.fiber.dispose(); }
    });

    await t.test('Real plugin roots have independent MCP Sessions and tools traverse their binding', async () => {
      const connections: RootConnection[] = [];
      class TrackingConnectionClient extends ControlClient {
        createRootConnection(binding: RootRegistrationResponse) {
          const connection = super.createRootConnection(binding);
          connections.push(connection);
          return connection;
        }
      }
      const calls: { method: string; endpoint?: string; session?: string }[] = [];
      const observe = (req: import('node:http').IncomingMessage) => {
        if (req.url !== '/mcp' || req.method !== 'POST') return;
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          calls.push({ method: JSON.parse(Buffer.concat(chunks).toString()).method,
            endpoint: req.headers['x-arlo-endpoint-id'] as string, session: req.headers['mcp-session-id'] as string });
        });
      };
      server.on('request', observe);
      const model = new LocalModel();
      const host = await fixture(model);
      try {
        const root2 = await host.ctx.agents.create({ sessionId: SessionId('second-connected-root'), agentOptions: { provider: 'arlo-local', model: 'scripted' } });
        const fork = await host.ctx.plugin(createArloHarnessPlugin({
          groupName: 'connected-roots', controlClient: new TrackingConnectionClient({ stateDir }),
        }));
        await until(() => connections.length === 2);
        // Receiving notifications/initialized at the server does not mean its
        // HTTP response has reached either client. Await the actual handshakes.
        await Promise.all(connections.map(connection => connection.connect()));
        const initialized = calls.filter(c => c.method === 'notifications/initialized');
        assert.equal(initialized.length, 2);
        assert.equal(new Set(initialized.map(c => c.endpoint)).size, 2);
        assert.equal(new Set(initialized.map(c => c.session)).size, 2);
        assert.ok(initialized.every(c => c.endpoint && c.session));
        await until(async () => {
          const roots = await control.listRoots();
          return connections.every(connection => roots.some(root =>
            root.endpoint_id === connection.binding.endpoint_id && root.ready && root.deliverable));
        });
        for (const root of [host.root, root2]) {
          model.script.push(toolResponse('arlo_list_sessions'));
          root.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'list sessions' }], source: { kind: 'arlo', form: 'relay' } }));
          await root.agent.whenIdle();
        }
        const toolCalls = calls.filter(c => c.method === 'tools/call');
        assert.equal(toolCalls.length, 2);
        assert.equal(new Set(toolCalls.map(c => c.endpoint)).size, 2);
        assert.ok(toolCalls.every(c => initialized.some(i => i.endpoint === c.endpoint && i.session === c.session)));
        assert.ok((await control.listRoots()).filter(r => r.status === 'registered').every(r => r.ready && r.deliverable));
        await fork.dispose();
        await until(async () => (await control.listRoots()).every(r => r.status === 'revoked'));
      } finally { server.off('request', observe); await host.ctx.fiber.dispose(); }
    });
  } finally { agent?.destroy(); await daemon.stop(); removeTempDir(stateDir); }
});
