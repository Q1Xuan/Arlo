import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ControlClient, assertSafeStatePath } from '@arlo/sdk';
import { ClaudeCodeSidecar, type BridgeIdentity, type ClaudeCodeSidecarOptions } from '../packages/adapter-claudecode/src/index.ts';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

function headers(sidecar: ClaudeCodeSidecar, identity: BridgeIdentity): Record<string, string> {
  return {
    Authorization: `Bearer ${sidecar.token}`, 'x-session-id': identity.sessionId,
    'x-bridge-instance': identity.instanceId, 'x-bridge-generation': String(identity.generation),
    'Content-Type': 'application/json',
  };
}

async function request(sidecar: ClaudeCodeSidecar, identity: BridgeIdentity, route: string, body: unknown) {
  const response = await fetch(`${sidecar.url}/api/v1/bridge${route}`, {
    method: 'POST', headers: headers(sidecar, identity), body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function fixture(t: TestContext, peers = 0) {
  const daemon = await MessageStatusFixture.create({ roots: peers, groupName: 'commands' });
  const stateDir = createTempDir('claude-commands-');
  const sidecars: ClaudeCodeSidecar[] = [];
  t.after(async () => {
    for (const sidecar of sidecars) await sidecar.stop();
    await daemon.dispose();
    removeTempDir(stateDir);
  });
  async function add(sessionId: string, options: Partial<ClaudeCodeSidecarOptions> = {}) {
    const sidecar = new ClaudeCodeSidecar({ sessionId, stateDir, groupName: 'commands',
      controlClient: new ControlClient({ stateDir: daemon.stateDir }), ...options });
    sidecars.push(sidecar);
    await sidecar.start();
    const status = await fetch(`${sidecar.url}/api/v1/bridge/status`, {
      headers: { Authorization: `Bearer ${sidecar.token}`, 'x-session-id': sessionId },
    });
    const attached = await request(sidecar, await status.json(), '/handshake', {
      modVersion: '0.1.0', capabilities: ['prompt.submit'],
    });
    assert.equal(attached.status, 200);
    await sidecar.waitForReady(15000);
    const identity: BridgeIdentity = attached.body;
    const command = (name: string, args = '') => request(sidecar, identity, '/commands/call', { name, arguments: args, ...(['arlo-authorize', 'arlo-continue'].includes(name) ? { operationId: crypto.randomUUID() } : {}) });
    const tool = (name: string, args = {}) => request(sidecar, identity, '/tools/call', { name, arguments: args, ...(['arlo-authorize', 'arlo-continue'].includes(name) ? { operationId: crypto.randomUUID() } : {}) });
    return { sidecar, identity, command, tool };
  }
  return { add, daemon, stateDir };
}

test('human sending status preserves unknown usage when current root ownership cannot be verified', async t => {
  const f = await fixture(t);
  const root = await f.add('unverified');
  const result = await root.command('arlo-send-status');
  assert.equal(result.status, 200);
  for (const line of ['Mode: bounded', 'Period: unknown', 'Usage: unknown', 'Granted: unknown',
    'Used: unknown', 'Remaining: unknown', 'Next grant: 20', 'Pause reason: ALLOWANCE_UNKNOWN']) {
    assert.ok(result.body.text.includes(line), `Missing status: ${line}`);
  }
});

test('human continuation refuses to create an allowance for an unverified current root', async t => {
  const f = await fixture(t);
  const root = await f.add('unverified-continuation');
  const result = await root.command('arlo-continue');
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, 'ALLOWANCE_UNKNOWN');
  const status = await root.command('arlo-send-status');
  assert.match(status.body.text, /Period: unknown/);
  assert.match(status.body.text, /Remaining: unknown/);
});

test('root configuration distinguishes the authenticated current root from unproven durable ownership', async t => {
  const f = await fixture(t);
  const root = await f.add('unverified-configuration');
  const result = await root.command('arlo-root-config');
  assert.equal(result.status, 200);
  for (const line of ['Current root authenticated: true', 'Configuration ID: Unavailable',
    'Configuration location:', 'Ownership: unknown (AUTHORIZATION_REQUIRED)', 'Historical first eligibility: unknown']) {
    assert.ok(result.body.text.includes(line), `Missing configuration: ${line}`);
  }
});

test('saved cross-host participation affects sibling Sidecars without replacing roots and survives restart', async t => {
  const f = await fixture(t, 1);
  await f.daemon.control.updateRuntimeParticipation(f.daemon.runtimeToken, true);
  const peer = f.daemon.roots[0].registration.endpoint_id;
  const first = await f.add('settings-first', { crossHostEnabled: true });
  const second = await f.add('settings-second');
  const visible = async (root: typeof first) => {
    const response = await root.tool('arlo_list_sessions');
    assert.equal(response.status, 200);
    return JSON.parse(response.body.content[0].text).some((item: { endpoint_id: string }) => item.endpoint_id === peer);
  };
  assert.match((await first.command('arlo-settings')).body.text, /Cross-host communication: on/);
  assert.equal(await visible(first), true);
  assert.equal(await visible(second), true);
  const bindings = await f.daemon.control.listRoots();
  const disabled = await first.command('arlo-settings', 'off');
  assert.equal(disabled.status, 200);
  assert.match(disabled.body.text, /Cross-host communication: off/);
  assert.equal(await visible(first), false);
  assert.equal(await visible(second), false);
  assert.deepEqual(await f.daemon.control.listRoots(), bindings);

  await first.sidecar.stop();
  await second.sidecar.stop();
  const restarted = await f.add('settings-first', { crossHostEnabled: true });
  assert.match((await restarted.command('arlo-settings')).body.text, /Cross-host communication: off/);
  assert.equal(await visible(restarted), false, 'The saved human preference overrides the launch default');
});

test('an initial launch preference creates a private state directory before daemon startup', async t => {
  const directory = createTempDir('claude-settings-startup');
  const stateDir = path.join(directory, 'new-state');
  const execute = childProcess.execFileSync;
  const owned = path.toNamespacedPath(path.resolve(directory)).toLowerCase();
  t.mock.method(childProcess, 'execFileSync', (file: string, args?: readonly string[], options?: unknown) => {
    if (path.basename(file).toLowerCase() === 'icacls.exe') {
      assert.ok(typeof args?.[0] === 'string', 'An ACL operation must name its exact target');
      const target = path.toNamespacedPath(path.resolve(args[0])).toLowerCase();
      assert.ok(target === owned || target.startsWith(`${owned}${path.sep}`),
        `Refusing ACL change outside the owned startup test directory: ${args[0]}`);
    }
    return Reflect.apply(execute, childProcess, [file, args, options]);
  });
  const previousUmask = process.umask(0o022);
  let sidecar: ClaudeCodeSidecar | undefined;
  try {
    sidecar = new ClaudeCodeSidecar({ sessionId: 'settings-startup', stateDir,
      crossHostEnabled: false, autoStart: false });
    assert.doesNotThrow(() => assertSafeStatePath(stateDir));
    assert.deepEqual(sidecar.host.roots(), [], 'Saving the launch preference does not activate a root');
  } finally {
    process.umask(previousUmask);
    await sidecar?.stop();
    removeTempDir(directory);
  }
});

function field(text: string, label: string): string {
  const prefix = `${label}: `;
  const line = text.split('\n').find(value => value.startsWith(prefix));
  assert.ok(line, `Missing ${label}: ${text}`);
  return line.slice(prefix.length);
}

test('human rule reload preserves usage, reports invalid rules, and keeps continuous continuation within its period', async t => {
  const f = await fixture(t);
  const root = await f.add('synthetic-rules');
  const receiver = await f.add('rules-receiver');
  await root.command('arlo-authorize');
  const configuration = await root.command('arlo-root-config');
  assert.match(configuration.body.text, /Ownership: user-authorized/);
  const configId = field(configuration.body.text, 'Configuration ID');
  const configPath = field(configuration.body.text, 'Configuration location');
  const first = await root.command('arlo-continue');
  assert.equal(first.status, 200);
  const period = field(first.body.text, 'Period');
  const contacts = await root.tool('arlo_list_sessions');
  const target = JSON.parse(contacts.body.content[0].text)[0].endpoint_id;
  const sent = await root.tool('arlo_send_message', { to: target, text: 'Count this actual dispatch' });
  assert.equal(sent.status, 200);
  assert.equal(JSON.parse(sent.body.content[0].text).status, 'accepted');
  const rules = (mode: string, grant: number) => fs.writeFileSync(configPath,
    JSON.stringify({ version: 1, roots: { [configId]: { mode, grant } } }), { mode: 0o600 });

  rules('continuous', 7);
  const continuous = await root.command('arlo-reload-sending-rules');
  assert.equal(continuous.status, 200);
  assert.equal(field(continuous.body.text, 'Mode'), 'continuous');
  assert.equal(field(continuous.body.text, 'Period'), period);
  assert.equal(field(continuous.body.text, 'Used'), '1');
  assert.equal(field(continuous.body.text, 'Granted'), '20');
  assert.equal(field(continuous.body.text, 'Remaining'), 'unlimited');
  assert.equal(field(continuous.body.text, 'Next grant'), '7');
  const continued = await root.command('arlo-continue');
  assert.equal(field(continued.body.text, 'Period'), period);
  assert.equal(field(continued.body.text, 'Used'), '1');

  fs.writeFileSync(configPath, '{invalid-json');
  const invalid = await root.command('arlo-reload-sending-rules');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'SENDING_RULES_INVALID');
  const unchanged = await root.command('arlo-send-status');
  assert.equal(field(unchanged.body.text, 'Mode'), 'continuous');
  assert.equal(field(unchanged.body.text, 'Period'), period);
  assert.equal(field(unchanged.body.text, 'Used'), '1');
  rules('bounded', 7);
  const bounded = await root.command('arlo-reload-sending-rules');
  assert.equal(field(bounded.body.text, 'Remaining'), '19');
  assert.equal(field(bounded.body.text, 'Period'), period);
  const next = await root.command('arlo-continue');
  assert.notEqual(field(next.body.text, 'Period'), period);
  assert.equal(field(next.body.text, 'Granted'), '7');
  assert.equal(field(next.body.text, 'Used'), '0');
  assert.equal(field(next.body.text, 'Remaining'), '7');
});

test('twenty actual dispatches exhaust the bounded period while reception remains available until human continuation', async t => {
  const f = await fixture(t);
  const sender = await f.add('synthetic-exhausted-sender');
  const receiver = await f.add('synthetic-exhausted-receiver');
  await sender.command('arlo-authorize');
  await receiver.command('arlo-authorize');
  const initial = await sender.command('arlo-continue');
  assert.equal(field(initial.body.text, 'Granted'), '20');
  const initialPeriod = field(initial.body.text, 'Period');
  const senderContacts = await sender.tool('arlo_list_sessions');
  const target = JSON.parse(senderContacts.body.content[0].text)[0].endpoint_id;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await sender.tool('arlo_send_message', { to: target, text: `Dispatch ${attempt + 1}` });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body.content[0].text).status, 'accepted');
  }
  const paused = await sender.command('arlo-send-status');
  assert.equal(field(paused.body.text, 'Used'), '20');
  assert.equal(field(paused.body.text, 'Remaining'), '0');
  assert.equal(field(paused.body.text, 'Pause reason'), 'ALLOWANCE_EXHAUSTED');
  const refused = await sender.tool('arlo_send_message', { to: target, text: 'Exhausted send' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'ALLOWANCE_EXHAUSTED');

  await receiver.command('arlo-continue');
  const receiverContacts = await receiver.tool('arlo_list_sessions');
  const senderEndpoint = JSON.parse(receiverContacts.body.content[0].text)[0].endpoint_id;
  const inbound = await receiver.tool('arlo_send_message', { to: senderEndpoint, text: 'Receiving while sending is paused' });
  assert.equal(inbound.status, 200);
  assert.equal(JSON.parse(inbound.body.content[0].text).status, 'accepted');
  const pending = await fetch(`${sender.sidecar.url}/api/v1/bridge/messages/pending`, {
    headers: headers(sender.sidecar, sender.identity),
  });
  assert.equal(pending.status, 200);
  assert.equal((await pending.json()).messages[0].text, 'Receiving while sending is paused');
  const stillPaused = await sender.command('arlo-send-status');
  assert.equal(field(stillPaused.body.text, 'Period'), initialPeriod);
  assert.equal(field(stillPaused.body.text, 'Remaining'), '0');

  const resumed = await sender.command('arlo-continue');
  assert.equal(resumed.status, 200);
  assert.notEqual(field(resumed.body.text, 'Period'), initialPeriod);
  assert.equal(field(resumed.body.text, 'Granted'), '20');
  assert.equal(field(resumed.body.text, 'Used'), '0');
  assert.equal(field(resumed.body.text, 'Remaining'), '20');
  const sent = await sender.tool('arlo_send_message', { to: target, text: 'Sending resumed' });
  assert.equal(sent.status, 200);
  assert.equal(JSON.parse(sent.body.content[0].text).status, 'accepted');
});

test('explicit Claude authorization binds without granting; continue opens and replaces a durable period', async t => {
  const f = await fixture(t);
  const root = await f.add('user-authorized-root');
  const bound = await root.command('arlo-authorize');
  assert.equal(bound.status, 200);
  assert.match(bound.body.text, /用户已授权绑定/);
  assert.match(bound.body.text, /Period: unknown/);
  assert.match(bound.body.text, /Usage: unknown/);
  const config = await root.command('arlo-root-config');
  assert.match(config.body.text, /user-authorized/);
  const first = await root.command('arlo-continue');
  assert.equal(first.status, 200);
  assert.match(first.body.text, /Remaining: 20/);
  const period = first.body.text.match(/Period: (.+)/)[1];
  const next = await root.command('arlo-continue');
  assert.equal(next.status, 200);
  assert.match(next.body.text, /Remaining: 20/);
  assert.notEqual(next.body.text.match(/Period: (.+)/)[1], period);
  await root.sidecar.stop();
  const resumed = await f.add('user-authorized-root');
  const status = await resumed.command('arlo-send-status');
  assert.equal(status.status, 200);
  assert.match(status.body.text, /Remaining: 20/);
  assert.match(status.body.text, /用户已授权绑定/);
});

test('concurrent bridge retries of one human action share one period and one result', async t => {
  const f = await fixture(t), root = await f.add('same-human-action');
  await root.command('arlo-authorize');
  const operationId = crypto.randomUUID();
  const invoke = () => request(root.sidecar, root.identity, '/commands/call', { name: 'arlo-continue', arguments: '', operationId });
  const results = await Promise.all([invoke(), invoke(), invoke()]);
  assert.ok(results.every(result => result.status === 200));
  assert.equal(new Set(results.map(result => field(result.body.text, 'Period'))).size, 1);
  const replay = await invoke();
  assert.equal(replay.status, 200);
  assert.equal(field(replay.body.text, 'Period'), field(results[0].body.text, 'Period'));
});

test('a committed human continuation replays after Sidecar restart without replacing its period', async t => {
  const f = await fixture(t), root = await f.add('restarted-human-action');
  await root.command('arlo-authorize');
  const operationId = crypto.randomUUID();
  const first = await request(root.sidecar, root.identity, '/commands/call', {
    name: 'arlo-continue', arguments: '', operationId,
  });
  assert.equal(first.status, 200);
  await root.sidecar.stop();
  const resumed = await f.add('restarted-human-action');
  const replay = await request(resumed.sidecar, resumed.identity, '/commands/call', {
    name: 'arlo-continue', arguments: '', operationId,
  });
  assert.equal(replay.status, 200);
  assert.equal(field(replay.body.text, 'Period'), field(first.body.text, 'Period'));
  assert.equal(field((await resumed.command('arlo-send-status')).body.text, 'Period'),
    field(first.body.text, 'Period'));
});

test('A to B to A root switching recovers only A original committed human action', async t => {
  const f = await fixture(t), a = await f.add('action-A');
  await a.command('arlo-authorize');
  const operationId = crypto.randomUUID();
  const invoke = (identity: BridgeIdentity) => request(a.sidecar, identity, '/commands/call', {
    name: 'arlo-continue', arguments: '', operationId,
  });
  const first = await invoke(a.identity);
  assert.equal(first.status, 200);
  async function switchRoot(identity: BridgeIdentity, sessionId: string): Promise<BridgeIdentity> {
    const retired = await request(a.sidecar, identity, '/session/retire', {});
    assert.equal(retired.status, 200);
    const activated = await request(a.sidecar, retired.body, '/session/activate', { sessionId });
    assert.equal(activated.status, 200);
    const attached = await request(a.sidecar, activated.body, '/handshake', {
      modVersion: '0.1.0', capabilities: ['prompt.submit'],
    });
    assert.equal(attached.status, 200);
    await a.sidecar.waitForReady(15000);
    return attached.body;
  }
  const b = await switchRoot(a.identity, 'action-B');
  assert.equal((await invoke(b)).body.error.code, 'CONTROL_REQUEST_CONFLICT');
  const resumed = await switchRoot(b, 'action-A');
  const replay = await invoke(resumed);
  assert.equal(replay.status, 200);
  assert.equal(field(replay.body.text, 'Period'), field(first.body.text, 'Period'));
  assert.equal((await invoke(a.identity)).body.error.code, 'STALE_BINDING');
});

test('a continuous human action stays status-only when replayed after restart and a switch to bounded rules', async t => {
  const f = await fixture(t), root = await f.add('continuous-action');
  await root.command('arlo-authorize');
  const first = await root.command('arlo-continue');
  const config = (await root.command('arlo-root-config')).body.text;
  const configId = field(config, 'Configuration ID');
  const configPath = field(config, 'Configuration location');
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, roots: { [configId]: { mode: 'continuous', grant: 7 } } }));
  await root.command('arlo-reload-sending-rules');
  const operationId = crypto.randomUUID();
  const continuous = await request(root.sidecar, root.identity, '/commands/call', {
    name: 'arlo-continue', arguments: '', operationId,
  });
  assert.equal(continuous.status, 200);
  assert.equal(field(continuous.body.text, 'Period'), field(first.body.text, 'Period'));
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, roots: { [configId]: { mode: 'bounded', grant: 7 } } }));
  await root.command('arlo-reload-sending-rules');
  await root.sidecar.stop();
  const resumed = await f.add('continuous-action');
  const replay = await request(resumed.sidecar, resumed.identity, '/commands/call', {
    name: 'arlo-continue', arguments: '', operationId,
  });
  assert.equal(replay.status, 200);
  assert.equal(field(replay.body.text, 'Mode'), 'continuous');
  const current = await resumed.command('arlo-send-status');
  assert.equal(field(current.body.text, 'Period'), field(first.body.text, 'Period'));
  assert.equal(field(current.body.text, 'Remaining'), '20');
});
