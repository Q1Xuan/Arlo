import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeCodeSidecar, type ClaudeModHost } from '../packages/adapter-claudecode/src/index.ts';
import { register } from '../packages/adapter-claudecode/mod/hooks/register.js';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

type Hook = Parameters<Parameters<typeof register>[0]>[1];
interface ToolDefinition { name: string; description: string; inputSchema?: Record<string, unknown>; isDeferred?: boolean }

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const daemon = await MessageStatusFixture.create({ roots: 0, groupName: 'claude-tools' });
  const stateDir = createTempDir('claude-tools-');
  const sidecar = new ClaudeCodeSidecar({ sessionId: 'tools-root', stateDir, groupName: 'claude-tools', controlClient: daemon.control });
  await sidecar.start();
  let sessionId = sidecar.sessionId;
  const definitions = new Map<string, ToolDefinition>();
  const requests: string[] = [];
  const host = {
    command: { register: async (definition: { name: string }) => ({ command: definition.name }) },
    session: { id: async () => sessionId },
    tool: { register: async (definition: ToolDefinition) => {
      definitions.set(definition.name, definition);
      return { tool: `mcp__arlo-adapter-claudecode__${definition.name}` };
    } },
    env: { get: async (name: string) => name.endsWith('URL') ? sidecar.url : sidecar.token },
    http: { fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      requests.push(new URL(url).pathname);
      const response = await fetch(url, init);
      return { status: response.status, ok: response.ok, headers: {}, text: await response.text() };
    } },
    prompt: { submit: async () => undefined },
    clock: {
      now: async () => Date.now(),
      every: () => ({ cancel() {} }),
      after: (delay: number, callback: () => void) => {
        const timer = setTimeout(callback, delay);
        return { cancel: () => clearTimeout(timer) };
      },
    },
    ui: { log() {} },
  } satisfies ClaudeModHost & { tool: { register(definition: ToolDefinition): Promise<{ tool: string }> }; command: { register(definition: { name: string }): Promise<{ command: string }> } };
  const hooks = new Map<string, Hook>();
  const catches = new Map<string, Hook>();
  register((event, handler) => {
    hooks.set(event, handler);
    return { catch: (handler: Hook) => { catches.set(event, handler); } };
  });
  const invoke = (event: string, input: Record<string, unknown> = {}, next = async (value: unknown) => value) => {
    assert.ok(hooks.has(event), `Mod must handle ${event}`);
    return hooks.get(event)!(host, input, next);
  };
  t.after(async () => {
    await invoke('session.end', { sessionId, reason: 'prompt_input_exit' });
    await sidecar.stop();
    await daemon.dispose();
    removeTempDir(stateDir);
  });
  const call = (name: string, args: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) =>
    invoke('tool.call', { ...args, tool: `mcp__arlo-adapter-claudecode__${name}`, tool_use_id: 'tool-use', ...envelope });
  await invoke('session.start');
  await sidecar.waitForReady(15000);
  return { sidecar, daemon, host, requests, definitions, catches, invoke, call, setSessionId(value: string) { sessionId = value; } };
}

test('registered Claude model tools discover roots in the current communication group', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.definitions.keys()].sort(), ['arlo_get_message_status', 'arlo_list_sessions', 'arlo_send_message']);
  for (const definition of f.definitions.values()) {
    assert.equal(definition.isDeferred, false);
    assert.equal(definition.inputSchema?.additionalProperties, false);
  }
  assert.deepEqual((f.definitions.get('arlo_send_message')!.inputSchema as any).required, ['to', 'text']);
  const peer = new ClaudeCodeSidecar({ sessionId: 'peer-root', stateDir: f.sidecar.storageDir, groupName: 'claude-tools', controlClient: f.daemon.control });
  await peer.start();
  t.after(() => peer.stop());
  const { ClaudeCodeModDispatcher } = await import('../packages/adapter-claudecode/src/mod.ts');
  const peerHost: ClaudeModHost = { ...f.host, session: { id: async () => peer.sessionId },
    env: { get: async name => name.endsWith('URL') ? peer.url : peer.token } };
  const peerMod = new ClaudeCodeModDispatcher({ $: peerHost });
  await peerMod.start();
  t.after(() => peerMod.stop());
  await peer.waitForReady(15000);
  const result = await f.call('arlo_list_sessions') as { result: string };
  const sessions = JSON.parse(result.result) as { endpoint_id: string }[];
  assert.equal(sessions.length, 1);
  assert.match(sessions[0]!.endpoint_id, /^ep-/u);
  assert.ok(f.requests.includes('/api/v1/bridge/tools/call'));
  const sent = await f.call('arlo_send_message', { to: sessions[0]!.endpoint_id, text: 'from the live Claude root' }) as { result: string };
  const message = JSON.parse(sent.result);
  assert.equal(message.status, 'accepted');
  const status = await f.call('arlo_get_message_status', { message_id: message.message_id }) as { result: string };
  assert.equal(JSON.parse(status.result).status, 'accepted');
});

test('engine-stamped subagent and teammate calls are denied in the Mod before reaching the bridge', async t => {
  const f = await fixture(t);
  const before = await f.sidecar.runtime!.getRootSendingStatus(f.sidecar.host.roots()[0]!);
  const start = f.requests.length;
  for (const agentId of ['subagent-1', 'teammate-1', '', null]) {
    for (const name of f.definitions.keys()) {
      const result = await f.call(name, { to: 'ep-recipient', text: 'forbidden send' }, { agentId }) as { deny: string };
      assert.match(result.deny, /PERMISSION_DENIED/u);
    }
  }
  assert.equal(f.requests.length, start, 'Denied callers cannot even issue an HTTP bridge request');
  const after = await f.sidecar.runtime!.getRootSendingStatus(f.sidecar.host.roots()[0]!);
  assert.deepEqual(after, before, 'Denied callers cannot consume the root allowance');
});

test('model arguments cannot choose a root, bridge generation or allowance', async t => {
  const f = await fixture(t);
  for (const args of [
    { sessionId: 'another-root' }, { from: 'another-root' }, { agent_id: 'main' },
    { generation: 1 }, { credentials: f.sidecar.token }, { grant: 100 },
  ]) {
    const result = await f.call('arlo_list_sessions', args) as { deny: string };
    assert.match(result.deny, /INVALID_ARGUMENT/u);
    assert.ok(!result.deny.includes(f.sidecar.token));
  }
  const root = await f.call('arlo_list_sessions', {}, { agentId: undefined, requestMeta: {}, consent: 'host consent' }) as { result: string };
  assert.deepEqual(JSON.parse(root.result), []);
  const unrelated = { tool: 'Read', agentId: 'subagent', file_path: 'local.txt' };
  assert.deepEqual(await f.invoke('tool.call', unrelated), unrelated, 'Local tools preserve the host behavior');
});

test('an old tool callback cannot send after same-context Mod reload', async t => {
  const f = await fixture(t);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const readIdentity = f.host.session.id;
  f.host.session.id = async () => {
    f.host.session.id = readIdentity;
    started.resolve();
    await release.promise;
    return readIdentity();
  };
  const pending = f.call('arlo_send_message', { to: 'ep-recipient', text: 'old callback' });
  await started.promise;
  const start = f.requests.filter(path => path.endsWith('/tools/call')).length;
  await f.invoke('session.start');
  release.resolve();
  const result = await pending as { deny: string };
  assert.match(result.deny, /STALE_BINDING/u);
  assert.equal(f.requests.filter(path => path.endsWith('/tools/call')).length, start);
  assert.deepEqual(JSON.parse((await f.call('arlo_list_sessions') as { result: string }).result), []);
});

test('a late tool result is withheld after reload or a changed actual host session', async t => {
  const f = await fixture(t);
  for (const change of ['reload', 'session']) {
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fetchBridge = f.host.http.fetch;
    f.host.http.fetch = async (url, init) => {
      const response = await fetchBridge(url, init);
      if (url.endsWith('/tools/call')) {
        arrived.resolve();
        await release.promise;
      }
      return response;
    };
    const pending = f.call('arlo_list_sessions');
    await arrived.promise;
    if (change === 'reload') await f.invoke('session.start');
    else f.setSessionId('changed-without-event');
    release.resolve();
    const result = await pending as { deny: string };
    assert.match(result.deny, /STALE_BINDING|SESSION_MISMATCH/u);
    f.host.http.fetch = fetchBridge;
  }
  const before = f.requests.length;
  assert.match((await f.call('arlo_send_message', { to: 'ep-recipient', text: 'wrong root' }) as { deny: string }).deny, /SESSION_MISMATCH/u);
  assert.equal(f.requests.length, before);
  f.setSessionId(f.sidecar.sessionId);
});

test('host hook failures explicitly deny Arlo tools without retrying a send', async t => {
  const f = await fixture(t);
  const fallback = f.catches.get('tool.call');
  assert.ok(fallback, 'The official host skips failed hooks unless a catch guard refuses the tool');
  const start = f.requests.length;
  const fallbackResult = await fallback(f.host, { tool: 'mcp__arlo-adapter-claudecode__arlo_send_message' },
    async () => { throw new Error('A failed owned tool must not invoke the fallback implementation'); }) as { deny: string };
  assert.match(fallbackResult.deny, /unknown.*not.*resend/u);
  assert.equal(f.requests.length, start);
  const unrelated = { tool: 'Read' };
  assert.deepEqual(await fallback(f.host, unrelated, async event => event), unrelated);
});
