import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeCodeSidecar, type ClaudeModToolHost } from '../packages/adapter-claudecode/src/index.ts';
import { register } from '../packages/adapter-claudecode/mod/hooks/register.js';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

type Hook = Parameters<Parameters<typeof register>[0]>[1];
interface CommandDefinition { name: string; description: string; argumentHint?: string; immediate?: true }

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const daemon = await MessageStatusFixture.create({ roots: 0, groupName: 'claude-commands' });
  const stateDir = createTempDir('claude-commands-');
  const sidecar = new ClaudeCodeSidecar({ sessionId: 'commands-root', stateDir, groupName: 'claude-commands', controlClient: daemon.control });
  await sidecar.start();
  let sessionId = sidecar.sessionId;
  const definitions = new Map<string, CommandDefinition>();
  const requests: string[] = [];
  const submitted: string[] = [];
  const host = {
    session: { id: async () => sessionId },
    command: { register: async (definition: CommandDefinition) => {
      definitions.set(definition.name, definition);
      return { command: definition.name };
    } },
    tool: { register: async (definition: { name: string }) => ({ tool: `mcp__arlo-adapter-claudecode__${definition.name}` }) },
    env: { get: async (name: string) => name.endsWith('URL') ? sidecar.url : sidecar.token },
    http: { fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      requests.push(new URL(url).pathname);
      const response = await fetch(url, init);
      return { status: response.status, ok: response.ok, headers: {}, text: await response.text() };
    } },
    prompt: { submit: async (input: { text: string }) => { submitted.push(input.text); return undefined; } },
    clock: {
      now: async () => Date.now(),
      every: () => ({ cancel() {} }),
      after: (delay: number, callback: () => void) => {
        const timer = setTimeout(callback, delay);
        return { cancel: () => clearTimeout(timer) };
      },
    },
    ui: { log() {} },
  } satisfies ClaudeModToolHost & { command: { register(definition: CommandDefinition): Promise<{ command: string }> } };
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
  const call = (command: string, args = '', envelope: Record<string, unknown> = {}) =>
    invoke('command.run', { command, args, origin: { kind: 'composer' }, ...envelope });
  t.after(async () => {
    await invoke('session.end', { sessionId, reason: 'prompt_input_exit' });
    await sidecar.stop();
    await daemon.dispose();
    removeTempDir(stateDir);
  });
  await invoke('session.start');
  await sidecar.waitForReady(15000);
  return { sidecar, daemon, host, requests, submitted, definitions, catches, invoke, call,
    setSessionId(value: string) { sessionId = value; } };
}

test('registered human commands show unknown allowance facts without starting a model turn', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.definitions.keys()].sort(), [
    'arlo-authorize', 'arlo-continue', 'arlo-reload-sending-rules', 'arlo-root-config', 'arlo-send-status', 'arlo-settings',
  ]);
  assert.ok([...f.definitions.values()].every(definition => definition.immediate === true));
  const result = await f.call('arlo-send-status') as { text: string };
  assert.deepEqual(Object.keys(result), ['text']);
  assert.match(result.text, /Mode: bounded/u);
  assert.match(result.text, /Period: unknown/u);
  assert.match(result.text, /Usage: unknown/u);
  assert.match(result.text, /Granted: unknown/u);
  assert.match(result.text, /Used: unknown/u);
  assert.match(result.text, /Remaining: unknown/u);
  assert.match(result.text, /Next grant: 20/u);
  assert.match(result.text, /Pause reason:/u);
  assert.deepEqual(f.submitted, []);
});

test('only engine-attested human commands can reach the Sidecar', async t => {
  const f = await fixture(t);
  const start = f.requests.length;
  for (const origin of [undefined, null, {}, ...[
    'sdk', 'plugin', 'peer', 'peer-send-message', 'scheduled-trigger', 'task-notification',
    'coordinator', 'observer', 'channel', 'auto-continuation', 'unclassified',
  ].map(kind => ({ kind }))]) {
    for (const command of f.definitions.keys()) {
      const result = await f.call(command, '', { origin }) as { text: string };
      assert.match(result.text, /PERMISSION_DENIED/u);
    }
  }
  for (const agentId of ['subagent', 'teammate', '', null]) {
    const result = await f.call('arlo-continue', '', { agentId }) as { text: string };
    assert.match(result.text, /PERMISSION_DENIED/u);
  }
  assert.equal(f.requests.length, start, 'A non-human origin cannot reach the allowance runtime');
  const remote = await f.call('arlo-send-status', '', { origin: { kind: 'bridge' } }) as { text: string };
  assert.match(remote.text, /Usage: unknown/u);
  assert.deepEqual(f.submitted, []);
  const unrelated = { command: 'status', args: '', origin: { kind: 'plugin' } };
  assert.deepEqual(await f.invoke('command.run', unrelated), unrelated);
});

test('human commands reject caller-selected roots, quotas, request ids and invalid settings', async t => {
  const f = await fixture(t);
  const start = f.requests.length;
  for (const command of f.definitions.keys()) {
    for (const args of ['20', 'root-elsewhere', '--request-id replay', '{"quota":100}', 'on off']) {
      assert.match((await f.call(command, args) as { text: string }).text, /INVALID_ARGUMENT/u);
    }
    for (const args of [null, {}, 20]) {
      const result = await f.invoke('command.run', { command, args, origin: { kind: 'composer' } }) as { text: string };
      assert.match(result.text, /INVALID_ARGUMENT/u);
    }
  }
  assert.equal(f.requests.length, start, 'Invalid commands are rejected before issuing bridge requests');
});

test('a command awaiting host identity cannot change allowance after a Mod reload', async t => {
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
  const pending = f.call('arlo-continue');
  await started.promise;
  const start = f.requests.filter(path => path.endsWith('/commands/call')).length;
  await f.invoke('session.start');
  release.resolve();
  assert.match((await pending as { text: string }).text, /STALE_BINDING/u);
  assert.equal(f.requests.filter(path => path.endsWith('/commands/call')).length, start);
  assert.match((await f.call('arlo-send-status') as { text: string }).text, /Usage: unknown/u);
});

test('late command results are withheld after reload or an actual host root change', async t => {
  const f = await fixture(t);
  for (const change of ['reload', 'session']) {
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fetchBridge = f.host.http.fetch;
    f.host.http.fetch = async (url, init) => {
      const response = await fetchBridge(url, init);
      if (url.endsWith('/commands/call')) {
        arrived.resolve();
        await release.promise;
      }
      return response;
    };
    const pending = f.call('arlo-send-status');
    await arrived.promise;
    if (change === 'reload') await f.invoke('session.start');
    else f.setSessionId('changed-without-event');
    release.resolve();
    assert.match((await pending as { text: string }).text, /STALE_BINDING|SESSION_MISMATCH/u);
    f.host.http.fetch = fetchBridge;
  }
  const start = f.requests.length;
  assert.match((await f.call('arlo-continue') as { text: string }).text, /SESSION_MISMATCH/u);
  assert.equal(f.requests.length, start);
  f.setSessionId(f.sidecar.sessionId);
});

test('a command hook failure reports unavailable without falling through or submitting model input', async t => {
  const f = await fixture(t);
  const fallback = f.catches.get('command.run');
  assert.ok(fallback);
  const start = f.requests.length;
  const result = await fallback(f.host, { command: 'arlo-continue' }, async () => {
    throw new Error('An owned command must not fall through to another implementation');
  }) as { text: string };
  assert.deepEqual(Object.keys(result), ['text']);
  assert.match(result.text, /unavailable/u);
  assert.equal(f.requests.length, start);
  assert.deepEqual(f.submitted, []);
  const unrelated = { command: 'status' };
  assert.deepEqual(await fallback(f.host, unrelated, async event => event), unrelated);
});

test('late transport failures cannot report an obsolete root error after reload or a host identity change', async t => {
  const f = await fixture(t);
  for (const change of ['reload', 'session']) {
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fetchBridge = f.host.http.fetch;
    f.host.http.fetch = async (url, init) => {
      const response = await fetchBridge(url, init);
      if (url.endsWith('/commands/call')) {
        arrived.resolve();
        await release.promise;
        throw new Error('OBSOLETE_ROOT_TRANSPORT_FAILURE');
      }
      return response;
    };
    const pending = f.call('arlo-send-status');
    await arrived.promise;
    if (change === 'reload') await f.invoke('session.start');
    else f.setSessionId('replacement-without-event');
    release.resolve();
    const result = await pending as { text: string };
    assert.match(result.text, /STALE_BINDING|SESSION_MISMATCH/u);
    assert.ok(!result.text.includes('OBSOLETE_ROOT_TRANSPORT_FAILURE'));
    f.host.http.fetch = fetchBridge;
    f.setSessionId(f.sidecar.sessionId);
  }
});

test('lost Mod command response retries one human operation instead of issuing another period', async t => {
  const f = await fixture(t);
  assert.match((await f.call('arlo-authorize') as { text: string }).text, /用户已授权绑定/);
  const fetch = f.host.http.fetch.bind(f.host.http); let loseOnce = true;
  t.mock.method(f.host.http, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const result = await fetch(...args);
    if (loseOnce && args[0].endsWith('/commands/call') && JSON.parse(args[1]?.body ?? '{}').name === 'arlo-continue') {
      loseOnce = false; throw new Error('Injected lost bridge response');
    }
    return result;
  });
  const lost = await f.call('arlo-continue') as { text: string };
  assert.match(lost.text, /Injected lost bridge response/);
  const before = (await f.call('arlo-send-status') as { text: string }).text;
  const retry = (await f.call('arlo-continue') as { text: string }).text;
  const period = (text: string) => text.match(/Period: (.+)/)![1];
  assert.equal(period(retry), period(before));
  assert.match(retry, /Remaining: 20/);
  const next = (await f.call('arlo-continue') as { text: string }).text;
  assert.notEqual(period(next), period(retry));
  assert.deepEqual(f.submitted, []);
});
