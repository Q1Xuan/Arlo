import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ArloDaemon } from '@arlo/daemon';
import { ArloErrorCode, SETTLED_RECEIPT_CACHE_LIMIT } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';
import type { TrackingCommand } from './fixtures/harness-tracking-worker.ts';

function startHarness(stateDir: string, profileDir: string) {
  const networkFile = path.join(profileDir, 'network.json');
  const child = spawn(process.execPath, [
    '--import', new URL('../probes/isolation.mjs', import.meta.url).href,
    fileURLToPath(new URL('./fixtures/harness-tracking-worker.ts', import.meta.url)),
  ], {
    cwd: profileDir, windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot,
      HOME: profileDir, USERPROFILE: profileDir, APPDATA: profileDir, LOCALAPPDATA: profileDir,
      XDG_CONFIG_HOME: profileDir, XDG_DATA_HOME: profileDir, XDG_CACHE_HOME: profileDir,
      TEMP: profileDir, TMP: profileDir, TMPDIR: profileDir, ARLO_STATE_DIR: stateDir,
      ARLO_LOW_LEVEL_NETWORK_FILE: networkFile,
      PSExecutionPolicyPreference: process.env.PSExecutionPolicyPreference,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const ready = Promise.withResolvers<number>();
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
  let sequence = 0;
  let output = '';
  let outputBytes = 0;
  let overflow = false;
  let forced = false;
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  const fail = (error: Error) => {
    ready.reject(error);
    for (const request of pending.values()) request.reject(error);
  };
  const capture = (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 65536) {
      overflow = true;
      child.kill();
      fail(new Error('Tracking Harness output capture overflow'));
    } else output += chunk;
  };
  child.stdout!.on('data', capture);
  child.stderr!.on('data', capture);
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`Tracking Harness exited: ${code}; ${output}`)));
  child.on('message', (message: { ready?: boolean; pid: number; id: number; result?: unknown; error?: string }) => {
    if (message.ready) ready.resolve(message.pid);
    else if (message.error) pending.get(message.id)?.reject(new Error(message.error));
    else pending.get(message.id)?.resolve(message.result);
  });
  const startupTimer = setTimeout(() => ready.reject(new Error(`Tracking Harness startup timeout; ${output}`)), 20000);
  void ready.promise.then(() => clearTimeout(startupTimer), () => clearTimeout(startupTimer));
  async function request(command: TrackingCommand) {
    const id = ++sequence;
    const response = Promise.withResolvers<any>();
    pending.set(id, response);
    const timer = setTimeout(() => response.reject(new Error(`Tracking Harness ${command.action} timeout; ${output}`)), 30000);
    try {
      child.send({ id, command }, error => { if (error) response.reject(error); });
      return await response.promise;
    } finally {
      pending.delete(id);
      clearTimeout(timer);
    }
  }
  return {
    ready: ready.promise, request,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const forceStop = () => { forced = true; child.kill(); };
        const timer = setTimeout(forceStop, 5000);
        try {
          if (child.connected) await request({ action: 'stop' }).catch(forceStop);
          else forceStop();
          await exited;
        } finally { clearTimeout(timer); }
      }
      assert.equal(overflow, false, 'Host output must fit the bounded capture');
      assert.equal(forced, false, 'The real Harness must exit normally');
      assert.equal(child.exitCode, 0, output);
      assert.ok(fs.existsSync(networkFile), 'The host network guard must produce evidence');
      assert.equal(JSON.parse(fs.readFileSync(networkFile, 'utf8')).deniedConnections, 0,
        'Any attempted supplier request fails standalone acceptance too');
    },
  };
}

async function readyHarness(worker: ReturnType<typeof startHarness>) {
  const deadline = Date.now() + 15000;
  do {
    const snapshot = await worker.request({ action: 'snapshot' });
    if (snapshot.ready) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail('Tracking Harness did not become ready');
}

test('Two real Harnesses evict settled receipts without replay and bound global tracking across active and retired records', { timeout: 600000 }, async () => {
  const stateDir = createTempDir('tracking-daemon');
  const profiles = [createTempDir('tracking-a'), createTempDir('tracking-b')];
  const workers: ReturnType<typeof startHarness>[] = [];
  const cacheLimit = SETTLED_RECEIPT_CACHE_LIMIT;
  const trackingLimit = cacheLimit + 4;
  let clock = Date.now();
  // Exercise the production receiver's unchanged 1,024-entry cache. Only the
  // Daemon's documented budget/retention/clock seams shorten the larger limits.
  const daemon = new ArloDaemon({
    stateDir, maxTrackedMessages: trackingLimit, messageRecordTtlMs: 1000, now: () => clock,
    rateLimit: {
      sender: { perMinute: 60000, burst: trackingLimit + 1 },
      receiver: { perMinute: 60000, burst: trackingLimit + 1 },
    },
  });
  try {
    await daemon.start();
    workers.push(...profiles.map(profile => startHarness(stateDir, profile)));
    const pids = await Promise.all(workers.map(worker => worker.ready));
    assert.equal(new Set([...pids, process.pid]).size, 3);
    const [a, b] = workers;
    const roots = await Promise.all(workers.map(readyHarness));
    const endpoints = roots.map(root => root.endpoint_id as string);
    const body = (result: any) => result.content.filter((block: any) => block.type === 'text')
      .map((block: any) => block.text).join('\n');
    const tool = async (sender: number, name: 'arlo_list_sessions' | 'arlo_send_message' | 'arlo_get_message_status', args: Record<string, unknown>) => {
      const [result] = await workers[sender].request({ action: 'tools', calls: [{ name, args }] });
      return result.isError ? body(result) : JSON.parse(body(result));
    };
    const send = (sender: number, text: string) => tool(sender, 'arlo_send_message', { to: endpoints[1 - sender], text });
    const status = (sender: number, messageId: string) => tool(sender, 'arlo_get_message_status', { message_id: messageId });
    assert.equal((await tool(0, 'arlo_list_sessions', {}))[0].endpoint_id, endpoints[1]);

    const firstText = 'receipt-cache-first-owned-canary';
    const first = await send(0, firstText);
    assert.equal(first.status, 'accepted');
    let snapshot = await b.request({ action: 'snapshot' });
    const firstNativeId = snapshot.inserted[0];
    assert.deepEqual(snapshot.pending, []);
    assert.ok(snapshot.releasedMessages.includes(first.message_id));
    // Batches remain below the real 64-message pending and in-flight limits;
    // the local model emits every tool call through the real ToolRuntime.
    // Match each durable human grant's twenty attempts so the next driver
    // batch does not discard the eight remaining attempts of a 20+12 split.
    for (let offset = 1; offset < cacheLimit; offset += 20) {
      const count = Math.min(20, cacheLimit - offset);
      const results = await a.request({ action: 'tools', calls: Array.from({ length: count }, (_, index) => ({
        name: 'arlo_send_message', args: { to: endpoints[1], text: `receipt-cache-owned-${offset + index}` },
      })) });
      assert.equal(results.length, count);
      for (const result of results) {
        assert.ok(!result.isError, body(result));
        assert.equal(JSON.parse(body(result)).status, 'accepted');
      }
      snapshot = await b.request({ action: 'snapshot' });
      assert.deepEqual(snapshot.pending, []);
      assert.equal(snapshot.releasedMessages.length, offset + count);
    }
    assert.equal(snapshot.inserted.length, cacheLimit);
    assert.deepEqual(await b.request({ action: 'replay-first-frame' }), { status: 'enqueued', native_message_id: firstNativeId });

    assert.equal((await send(0, 'receipt-cache-overflow-owned-canary')).status, 'accepted');
    snapshot = await b.request({ action: 'snapshot' });
    assert.equal(snapshot.inserted.length, cacheLimit + 1);
    assert.equal(snapshot.releasedMessages.length, cacheLimit + 1);
    assert.deepEqual(await b.request({ action: 'replay-first-frame' }), {
      status: 'uncertain', reason: ArloErrorCode.STALE_SEQUENCE,
    }, 'The oldest settled receipt was evicted; the sequence window still refuses insertion');
    assert.equal((await status(0, first.message_id)).status, 'accepted', 'An uncertain replay cannot downgrade a determined Daemon result');

    await a.request({ action: 'replay-request', messageId: first.message_id });
    assert.deepEqual(await send(0, firstText), first, 'The retained business result answers an authenticated MCP replay');
    clock += 1000;
    assert.equal((await status(0, first.message_id)).status, 'result_unavailable');
    await a.request({ action: 'replay-request', messageId: first.message_id });
    assert.match(await send(0, firstText), /REPLAY_RESULT_UNAVAILABLE/);
    assert.equal((await b.request({ action: 'snapshot' })).notifications, cacheLimit + 1,
      'Neither receipt eviction nor expired result replay dispatches another notification');

    const reverse = await send(1, 'global-tracking-reverse-owned-canary');
    assert.equal(reverse.status, 'accepted');
    assert.equal((await a.request({ action: 'snapshot' })).releasedMessages.length, 1);
    await b.request({ action: 'hold' });
    const active = await send(0, 'global-tracking-held-owned-canary');
    assert.equal(active.status, 'accepted');
    await b.request({ action: 'drop-ack' });
    const unknown = await send(0, 'global-tracking-unknown-owned-canary');
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.reason, ArloErrorCode.ACK_TIMEOUT);
    const full = await b.request({ action: 'snapshot' });
    assert.equal(full.pending.length, 2);
    assert.equal(full.notifications, cacheLimit + 3);
    assert.match(await send(0, 'global-tracking-overflow-owned-canary'), /ACCOUNTING_UNAVAILABLE/);
    clock += 1000;
    assert.equal((await status(0, active.message_id)).status, 'accepted', 'TTL cannot evict held credit');
    assert.equal((await status(0, unknown.message_id)).status, 'unknown', 'TTL cannot evict uncertain activity');
    assert.deepEqual((await b.request({ action: 'snapshot' })).pending, full.pending,
      'Tracking saturation neither drops nor consumes accepted host input');

    await b.request({ action: 'release' });
    clock += 1000;
    assert.equal((await status(1, reverse.message_id)).status, 'result_unavailable');
    assert.equal((await status(0, active.message_id)).status, 'result_unavailable');
    assert.equal((await status(0, unknown.message_id)).status, 'unknown', 'Consumption alone is not acceptance evidence');
    assert.match(await send(0, 'global-tracking-after-consumption-owned-canary'), /ACCOUNTING_UNAVAILABLE/);
    assert.match(await send(1, 'global-tracking-other-sender-owned-canary'), /ACCOUNTING_UNAVAILABLE/,
      'Both sending roots share the same bounded tracking ledger');
    const final = await Promise.all(workers.map(worker => worker.request({ action: 'snapshot' })));
    assert.equal(final[0].notifications, 1);
    assert.equal(final[1].notifications, cacheLimit + 3);
    assert.equal(final[0].inserted.length + final[1].inserted.length, trackingLimit);
    for (const host of final) {
      assert.deepEqual(host.pending, []);
      assert.equal(host.childMessages, 0);
      assert.equal(new Set(host.inserted).size, host.inserted.length);
      assert.deepEqual([...host.consumed].sort(), [...host.inserted].sort(), 'Every admitted native input is consumed exactly once');
    }
  } finally {
    const cleanup = await Promise.allSettled(workers.map(worker => worker.stop()));
    cleanup.push(...await Promise.allSettled([daemon.stop()]));
    for (const directory of [...profiles, stateDir]) {
      try { removeTempDir(directory); }
      catch (reason) { cleanup.push({ status: 'rejected', reason }); }
    }
    const failures = cleanup.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Tracking acceptance cleanup or isolation failed');
  }
});
