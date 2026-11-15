import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonClient, readDiscoveryRecord } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';
import type { AcceptanceCommand } from './fixtures/windows-acceptance-worker.ts';

function startHarness(stateDir: string, profile: string, sessionId?: string) {
  const networkDir = path.join(profile, 'network');
  fs.mkdirSync(networkDir);
  // NODE_OPTIONS is deliberately authored here, not inherited. The production
  // shared-Daemon launcher inherits it, so each process gets its own denial log.
  const guard = `process.env.ARLO_LOW_LEVEL_NETWORK_FILE = process.env.ARLO_ACCEPTANCE_NETWORK_DIR + '/' + process.pid + '.json'; await import(${JSON.stringify(new URL('../probes/isolation.mjs', import.meta.url).href)});`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/windows-acceptance-worker.ts', import.meta.url))], {
    cwd: profile, windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot,
      HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
      XDG_CONFIG_HOME: profile, XDG_DATA_HOME: profile, XDG_CACHE_HOME: profile,
      TEMP: profile, TMP: profile, TMPDIR: profile,
      PSExecutionPolicyPreference: 'Bypass',
      ARLO_STATE_DIR: stateDir, ARLO_ACCEPTANCE_NETWORK_DIR: networkDir,
      ...(sessionId ? { ARLO_ACCEPTANCE_SESSION_ID: sessionId } : {}),
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(guard)}`,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const ready = Promise.withResolvers<{ pid: number; sessionId: string }>();
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
  let sequence = 0;
  let output = '';
  let forcedStop = false;
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => { output += chunk; });
  const fail = (error: Error) => {
    ready.reject(error);
    for (const response of pending.values()) response.reject(error);
  };
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`Acceptance Harness exit ${code}`)));
  child.on('message', (message: any) => {
    if (message.ready) ready.resolve(message);
    else if (message.error) pending.get(message.id)?.reject(new Error(message.error));
    else pending.get(message.id)?.resolve(message.result);
  });
  const startupTimer = setTimeout(() => ready.reject(new Error('Acceptance Harness startup timeout')), 30000);
  void ready.promise.then(() => clearTimeout(startupTimer), () => clearTimeout(startupTimer));
  async function request(command: AcceptanceCommand) {
    const id = ++sequence;
    const response = Promise.withResolvers<any>();
    pending.set(id, response);
    const timer = setTimeout(() => response.reject(new Error(`Acceptance Harness ${command.action} timeout`)), 30000);
    try {
      child.send({ id, command }, error => { if (error) response.reject(error); });
      return await response.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  return {
    ready: ready.promise, request,
    output: () => output,
    networkDir,
    exitedNormally: () => child.exitCode === 0 && !forcedStop,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const timer = setTimeout(() => { forcedStop = true; child.kill(); }, 35000);
      try {
        if (child.connected) await request({ action: 'stop' }).catch(() => {});
        else child.kill();
        await exited;
      } finally { clearTimeout(timer); }
    },
  };
}

async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean, description: string, timeoutMs = 30000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (matches(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail(description);
}

function toolValue(message: any): any {
  assert.notEqual(message.isError, true, 'Expected a successful model tool result');
  return JSON.parse(message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n'));
}

async function environment(run: (a: ReturnType<typeof startHarness>, b: ReturnType<typeof startHarness>, client: DaemonClient, stateDir: string) => Promise<void>, independentSessionIds = false) {
  const stateDir = createTempDir('windows-host-state');
  const profiles = [createTempDir('windows-host-a'), createTempDir('windows-host-b')];
  const workers = profiles.map(profile => startHarness(stateDir, profile, independentSessionIds ? path.basename(profile) : undefined));
  const client = new DaemonClient({ stateDir });
  let daemon: ReturnType<typeof readDiscoveryRecord> | undefined;
  try {
    const identities = await Promise.all(workers.map(worker => worker.ready));
    // Native discovery inspection must not compete with the initial binding.
    // Observe the real adapter callback first, then verify Daemon state once.
    await eventually(() => Promise.all(workers.map(worker => worker.request({ action: 'snapshot' }))),
      states => states.every(state => state.bindingReady), 'Both actual Harness roots become ready');
    const roots = await client.listRoots();
    assert.equal(roots.filter(root => root.ready).length, 2);
    daemon = readDiscoveryRecord(stateDir);
    const bootstrapCanary = fs.readFileSync(path.join(stateDir, 'bootstrap.token'), 'utf8').trim();
    assert.ok(bootstrapCanary);
    assert.equal(new Set([...identities.map(identity => identity.pid), daemon.pid, process.pid]).size, 4);
    if (independentSessionIds) assert.notEqual(identities[0].sessionId, identities[1].sessionId, 'Independent persisted roots have distinct public SessionIds');
    else assert.equal(identities[0].sessionId, identities[1].sessionId, 'Independent registries deliberately reuse SessionId');
    assert.equal(new Set(roots.map(root => root.runtime_id)).size, 2);
    await run(workers[0], workers[1], client, stateDir);
    await Promise.all(workers.map(worker => worker.stop()));
    assert.ok(workers.every(worker => worker.exitedNormally()), 'Both Harnesses finish graceful plugin cleanup');
    await eventually(async () => fs.existsSync(path.join(stateDir, 'discovery.json')), exists => !exists,
      'After consumed input and immediate plugin unload, the shared Daemon exits naturally');
    await eventually(async () => { try { process.kill(daemon!.pid, 0); return false; } catch { return true; } }, stopped => stopped, 'Owned Daemon process terminates before resource cleanup');
    const files = workers.flatMap(worker => fs.readdirSync(worker.networkDir).map(name => path.join(worker.networkDir, name)));
    for (const pid of [...identities.map(identity => identity.pid), daemon.pid]) {
      assert.ok(files.some(file => path.basename(file) === `${pid}.json`), 'Every Harness and the shared Daemon has an active network guard');
    }
    for (const file of files) assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).deniedConnections, 0, 'Any attempted external request fails acceptance');
    const logs = fs.readFileSync(path.join(stateDir, 'daemon.log'), 'utf8');
    for (const canary of ['acceptance-request-body-canary', 'acceptance-reply-body-canary', 'acceptance-busy-body-canary', 'acceptance-forged-body-canary', 'acceptance-forged-credential-canary', bootstrapCanary, stateDir]) {
      assert.equal(logs.includes(canary), false);
      assert.ok(workers.every(worker => !worker.output().includes(canary)));
    }
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    // Only kill the positively authenticated daemon belonging to this fixture.
    try {
      const current = await client.getStatus();
      const owned = daemon ?? readDiscoveryRecord(stateDir);
      if (current.daemon_id === owned.daemon_id && current.pid === owned.pid) process.kill(owned.pid, 'SIGKILL');
    } catch {}
    for (const profile of profiles) removeTempDir(profile);
    removeTempDir(stateDir);
  }
}

test('Two real Harness processes discover, send and contextually reply through the shared Daemon without preemption', { timeout: 120000 }, async () => {
  await environment(async (a, b) => {
    const originalA = await a.request({ action: 'snapshot' });
    const originalB = await b.request({ action: 'snapshot' });
    await b.request({ action: 'arm-reply', requestText: 'acceptance-request-body-canary', replyText: 'acceptance-reply-body-canary' });
    // The sending model has no target ID. Its next tool call must use the real
    // discovery result projected by Harness; B extracts reply IDs the same way.
    const roundtrip = await a.request({ action: 'discover-send', text: 'acceptance-request-body-canary' });
    const original = toolValue(roundtrip.result);
    assert.equal(original.status, 'accepted');
    const received = await eventually(() => a.request({ action: 'snapshot' }), value => value.messages.some((message: any) => message.content[0]?.text === 'acceptance-reply-body-canary'), 'Idle root actively wakes and receives a contextual reply');
    const receiver = await b.request({ action: 'snapshot' });
    const inbound = receiver.messages.find((message: any) => message.content[0]?.text === 'acceptance-request-body-canary');
    const reply = received.messages.find((message: any) => message.content[0]?.text === 'acceptance-reply-body-canary');
    assert.deepEqual(inbound.source, { kind: 'arlo', form: 'relay' });
    assert.deepEqual(reply.source, { kind: 'arlo', form: 'relay' });
    const context = JSON.parse(reply.content[1].text).arlo;
    assert.equal(context.reply_to, original.message_id);
    assert.equal(context.reply_depth, 1);
    assert.notEqual(context.message_id, original.message_id);
    assert.equal(receiver.replyDecision.message_id, original.message_id);
    assert.equal(receiver.replyDecision.from_endpoint, JSON.parse(inbound.content[1].text).arlo.from_endpoint);
    assert.equal(received.created, originalA.created);
    assert.equal(receiver.created, originalB.created);
    assert.equal(received.childMessages.length, 0);
    assert.equal(receiver.childMessages.length, 0);

    const held = await b.request({ action: 'hold' });
    const sent = toolValue((await a.request({ action: 'discover-send', text: 'acceptance-busy-body-canary' })).result);
    assert.equal(sent.status, 'accepted');
    const busy = await b.request({ action: 'snapshot' });
    assert.equal(busy.status, 'running');
    assert.equal(busy.requests, held.requests, 'Pending delivery cannot start an extra model request');
    assert.equal(busy.active, 1);
    assert.equal(busy.maxActive, 1);
    assert.equal(busy.aborted, 0, 'Incoming input cannot cancel the current model generation');
    assert.deepEqual(busy.pending.map((message: any) => message.content[0]?.text), ['acceptance-busy-body-canary']);
    assert.equal(busy.claimed.includes(busy.pending[0].id), false);
    const released = await b.request({ action: 'release' });
    assert.equal(released.status, 'idle');
    assert.equal(released.requests, held.requests + 1, 'Busy message is processed in exactly one subsequent turn');
    assert.equal(released.maxActive, 1);
    assert.equal(released.aborted, 0);
    assert.deepEqual(released.pending, []);
    assert.equal(released.claimed.filter((id: string) => id === busy.pending[0].id).length, 1);
    assert.equal(released.created, originalB.created, 'Reception never creates or restores an Agent');
    const history = await b.request({ action: 'unload-history' });
    assert.deepEqual(history.messages, released.messages, 'Native serialized history remains readable after plugin unload');
    assert.equal(history.agentCount, released.agentCount);
    assert.equal(history.status, 'idle');
  }, true);
});

test('Real Harness identities resist child callers, forged fields, replacement and duplicate integrations', { timeout: 120000 }, async () => {
  await environment(async (a, b, client) => {
    const tool = (worker: typeof a, name: string, args: Record<string, unknown> = {}, caller: 'root' | 'child' | 'second' = 'root') => worker.request({ action: 'tool', name, args, caller });
    const target = toolValue(await tool(a, 'arlo_list_sessions'))[0];
    const sender = toolValue(await tool(b, 'arlo_list_sessions'))[0];
    assert.equal(target.display_name, sender.display_name, 'Same names never collapse distinct roots');
    assert.notEqual(target.endpoint_id, sender.endpoint_id);
    const before = await b.request({ action: 'snapshot' });
    const childAttempt = await tool(a, 'arlo_send_message', { to: target.endpoint_id, text: 'acceptance-forged-body-canary', from_endpoint: sender.endpoint_id }, 'child');
    assert.equal(childAttempt.isError, true);
    assert.match(JSON.stringify(childAttempt), /CALLER_NOT_ROOT/);
    for (const forged of [
      { from_endpoint: target.endpoint_id }, { root_session_id: 'fictional-root' },
      { group_id: 'different-group' }, { root_token: 'acceptance-forged-credential-canary' },
      { source: { kind: 'user' } }, { reply_depth: 0 },
    ]) {
      const attempt = await tool(a, 'arlo_send_message', { to: target.endpoint_id, text: 'acceptance-forged-body-canary', ...forged });
      assert.equal(attempt.isError, true);
      assert.match(JSON.stringify(attempt), /INVALID_ARGUMENT/);
    }
    const after = await b.request({ action: 'snapshot' });
    assert.deepEqual(after.messages, before.messages, 'Forged model metadata never reaches another host');
    assert.equal(after.requests, before.requests);
    await a.request({ action: 'duplicate-plugin' });
    assert.equal((await client.listRoots()).filter(root => root.ready && root.status === 'registered').length, 2);
    assert.equal(toolValue(await tool(a, 'arlo_list_sessions')).length, 1, 'Duplicate plugin does not duplicate discovery or borrow an identity');
    await a.request({ action: 'create-second' });
    await eventually(() => a.request({ action: 'snapshot' }), state => state.secondBindingReady,
      'Second root in the same Harness registers independently');
    assert.equal((await client.listRoots()).filter(root => root.ready && root.status === 'registered').length, 3);
    const others = toolValue(await tool(b, 'arlo_list_sessions'));
    assert.equal(others.length, 2);
    const second = others.find((endpoint: any) => endpoint.endpoint_id !== sender.endpoint_id);
    assert.ok(second);
    const authorized = await b.request({ action: 'continue' });
    assert.equal(authorized.continued, true);
    assert.equal(authorized.status.knowledge, 'known');
    assert.equal(authorized.status.remaining, 20);
    const delivered = toolValue(await tool(b, 'arlo_send_message', { to: second.endpoint_id, text: 'second-root-only' }));
    assert.equal(delivered.status, 'accepted');
    const host = await a.request({ action: 'snapshot' });
    assert.equal(host.messages.some((message: any) => message.content[0]?.text === 'second-root-only'), false);
    assert.equal(host.secondMessages.filter((message: any) => message.content[0]?.text === 'second-root-only').length, 1);
    assert.equal(host.childMessages.some((message: any) => message.content[0]?.text === 'second-root-only'), false);

    await a.request({ action: 'replace-root' });
    await eventually(() => a.request({ action: 'snapshot' }), state => state.bindingReady,
      'Replacement root becomes ready');
    const replacedRoots = await client.listRoots();
    assert.ok(replacedRoots.some(root => root.endpoint_id === sender.endpoint_id && root.status === 'revoked'));
    assert.equal(replacedRoots.filter(root => root.ready && root.status === 'registered').length, 3,
      'Agent replacement revokes old endpoint before publishing the replacement');
    const replaced = toolValue(await tool(b, 'arlo_list_sessions')).find((endpoint: any) => endpoint.display_name === sender.display_name);
    assert.ok(replaced);
    assert.notEqual(replaced.endpoint_id, sender.endpoint_id);
    const stale = await tool(b, 'arlo_send_message', { to: sender.endpoint_id, text: 'stale-agent-must-not-receive' });
    assert.equal(stale.isError, true);
    assert.match(JSON.stringify(stale), /TARGET_UNAVAILABLE/);
    const fresh = toolValue(await tool(b, 'arlo_send_message', { to: replaced.endpoint_id, text: 'replacement-root-only' }));
    assert.equal(fresh.status, 'accepted');
    const replacement = await a.request({ action: 'snapshot' });
    assert.equal(replacement.messages.filter((message: any) => message.content[0]?.text === 'replacement-root-only').length, 1);
    assert.equal(replacement.messages.some((message: any) => message.content[0]?.text === 'stale-agent-must-not-receive'), false);
    assert.equal(replacement.secondMessages.some((message: any) => message.content[0]?.text === 'replacement-root-only'), false);
  });
});

test('Independent persisted Harnesses sharing a SessionId keep an ownership conflict paused without merging endpoints',
  { timeout: 120000 }, async () => {
    await environment(async (a, b) => {
      const target = toolValue(await b.request({ action: 'tool', name: 'arlo_list_sessions', args: {}, caller: 'root' }))[0];
      const sender = toolValue(await a.request({ action: 'tool', name: 'arlo_list_sessions', args: {}, caller: 'root' }))[0];
      assert.notEqual(target.endpoint_id, sender.endpoint_id);
      const granted = await b.request({ action: 'continue' });
      assert.equal(granted.continued, true);
      assert.equal(granted.status.root_configuration.ownership, 'verified');
      assert.equal(granted.status.knowledge, 'known');
      assert.equal(granted.status.remaining, 20);
      const conflicting = await a.request({ action: 'sending-status' });
      assert.equal(conflicting.root_configuration.reason, 'OWNER_CONFLICT');
      assert.equal(conflicting.root_configuration.ownership, 'conflict');
      assert.equal(conflicting.knowledge, 'unknown');
      assert.equal(conflicting.used, null);
      assert.equal(conflicting.remaining, null);
      assert.equal(conflicting.pause_reason, 'ALLOWANCE_UNKNOWN');
      assert.deepEqual(await a.request({ action: 'continue' }), { continued: false, error: 'ALLOWANCE_UNKNOWN' });
      assert.equal((await b.request({ action: 'sending-status' })).period_id, granted.status.period_id);
      const attempted = await a.request({ action: 'tool', name: 'arlo_send_message',
        args: { to: sender.endpoint_id, text: 'conflicting-root-must-not-send' }, caller: 'root' });
      assert.equal(attempted.isError, true);
      assert.match(JSON.stringify(attempted), /ALLOWANCE_UNKNOWN/u);
      const received = toolValue(await b.request({ action: 'tool', name: 'arlo_send_message',
        args: { to: target.endpoint_id, text: 'ownership-conflict-can-still-receive' }, caller: 'root' }));
      assert.equal(received.status, 'accepted');
      const paused = await eventually(() => a.request({ action: 'snapshot' }), snapshot =>
        snapshot.messages.some((message: any) => message.content[0]?.text === 'ownership-conflict-can-still-receive'),
      'A root with unknown sending allowance still actively receives input');
      assert.equal(paused.messages.filter((message: any) => message.content[0]?.text === 'ownership-conflict-can-still-receive').length, 1);
      assert.deepEqual(paused.childMessages, []);
      assert.equal((await a.request({ action: 'sending-status' })).knowledge, 'unknown');
      const remaining = await b.request({ action: 'sending-status' });
      assert.equal(remaining.period_id, granted.status.period_id);
      assert.equal(remaining.used, 1);
      assert.equal(remaining.remaining, 19);
    });
  });
