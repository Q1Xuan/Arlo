import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ArloDaemon } from '@arlo/daemon';
import { ArloErrorCode, DaemonClient, readDiscoveryRecord } from '@arlo/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from './test-utils.ts';
import type { RecoveryCommand } from './fixtures/harness-recovery-worker.ts';

function startHarness(stateDir: string, profileDir: string, autoStart = false) {
  const child = spawn(process.execPath, [
    '--import', new URL('../probes/isolation.mjs', import.meta.url).href,
    fileURLToPath(new URL('./fixtures/harness-recovery-worker.ts', import.meta.url)),
  ], {
    cwd: profileDir, windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot,
      HOME: profileDir, USERPROFILE: profileDir, APPDATA: profileDir, LOCALAPPDATA: profileDir,
      XDG_CONFIG_HOME: profileDir, XDG_DATA_HOME: profileDir, XDG_CACHE_HOME: profileDir,
      TEMP: profileDir, TMP: profileDir, TMPDIR: profileDir, ARLO_STATE_DIR: stateDir,
      ARLO_TEST_AUTO_START: autoStart ? '1' : undefined,
      PSExecutionPolicyPreference: process.env.PSExecutionPolicyPreference,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const ready = Promise.withResolvers<number>();
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
  let sequence = 0;
  let output = '';
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.stdout!.on('data', chunk => { output = (output + chunk).slice(-65536); });
  child.stderr!.on('data', chunk => { output = (output + chunk).slice(-65536); });
  const fail = (error: Error) => {
    ready.reject(error);
    for (const request of pending.values()) request.reject(error);
  };
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`Recovery Harness exited: ${code}; ${output}`)));
  child.on('message', (message: { ready?: boolean; pid: number; id: number; result?: unknown; error?: string }) => {
    if (message.ready) ready.resolve(message.pid);
    else if (message.error) pending.get(message.id)?.reject(new Error(message.error));
    else pending.get(message.id)?.resolve(message.result);
  });
  const startupTimer = setTimeout(() => ready.reject(new Error(`Recovery Harness startup timeout; ${output}`)), 20000);
  void ready.promise.then(() => clearTimeout(startupTimer), () => clearTimeout(startupTimer));
  async function request(command: RecoveryCommand) {
    const id = ++sequence;
    const response = Promise.withResolvers<any>();
    pending.set(id, response);
    const timer = setTimeout(() => response.reject(new Error(`Recovery Harness ${command.action} timeout; ${output}`)), 20000);
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
      if (child.exitCode !== null || child.signalCode !== null) return;
      const timer = setTimeout(() => child.kill(), 5000);
      try {
        if (child.connected) await request({ action: 'stop' }).catch(() => {});
        else child.kill();
        await exited;
      } finally { clearTimeout(timer); }
    },
  };
}

async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean, description: string, timeoutMs = 12000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value: T;
  do {
    value = await read();
    if (matches(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail(`${description}: ${JSON.stringify(value)}`);
}

test('Two real Harnesses keep duplicate frames, late conflicting receipts and unloaded callbacks from repeating input', { timeout: 90000 }, async () => {
  const stateDir = createTempDir('acceptance-fault-daemon');
  const profiles = [createTempDir('acceptance-fault-a'), createTempDir('acceptance-fault-b')];
  const daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT });
  const workers: ReturnType<typeof startHarness>[] = [];
  try {
    await daemon.start();
    workers.push(...profiles.map(profile => startHarness(stateDir, profile)));
    const [a, b] = workers;
    const pids = await Promise.all(workers.map(worker => worker.ready));
    assert.equal(new Set([...pids, process.pid]).size, 3);
    await Promise.all(workers.map(worker => eventually(() => worker.request({ action: 'snapshot' }),
      value => value.attempts.some((attempt: any) => attempt.ready), 'Fault matrix readiness')));
    const tool = async (name: 'arlo_list_sessions' | 'arlo_send_message' | 'arlo_get_message_status', args: Record<string, unknown>) => {
      const result = await a.request({ action: 'tool', name, args });
      return JSON.parse(result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n'));
    };
    const target = (await tool('arlo_list_sessions', {}))[0].endpoint_id;
    await b.request({ action: 'hold' });
    assert.deepEqual(await b.request({ action: 'duplicate-next' }), { armed: true });
    assert.deepEqual(await a.request({ action: 'duplicate-next-request' }), { armed: true });
    const first = await tool('arlo_send_message', { to: target, text: 'duplicate-frame-owned-canary' });
    assert.equal(first.status, 'accepted');
    const requests = (await a.request({ action: 'snapshot' })).repeatedRequests;
    assert.equal(requests.length, 2, 'The same business UUID was submitted in two authenticated MCP requests');
    assert.ok(requests.every((result: any) => result.message_id === first.message_id && result.status === 'accepted'));
    const once = await b.request({ action: 'snapshot' });
    assert.equal(once.notifications, 1, 'Request replay cannot dispatch a second frame');
    assert.equal(once.pending.length, 1);
    assert.equal(once.inserted.length, 1);
    await b.request({ action: 'replay-last' });
    assert.deepEqual((await b.request({ action: 'snapshot' })).inserted, once.inserted);

    await b.request({ action: 'drop-ack' });
    const unknown = await tool('arlo_send_message', { to: target, text: 'late-conflict-owned-canary' });
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.reason, ArloErrorCode.ACK_TIMEOUT);
    const beforeProof = await b.request({ action: 'snapshot' });
    assert.equal(beforeProof.pending.length, 2);
    assert.equal(beforeProof.status, 'running');
    // Let the real host consume and submit its credit proof while the reception
    // ACK is still absent. Consumption alone must not fabricate acceptance.
    await b.request({ action: 'release' });
    const consumedBeforeAck = await b.request({ action: 'snapshot' });
    assert.equal(consumedBeforeAck.pending.length, 0);
    assert.ok(consumedBeforeAck.releasedMessages.includes(unknown.message_id),
      'The real consumed-input proof reaches the Daemon before the delayed ACK');
    assert.equal((await tool('arlo_get_message_status', { message_id: unknown.message_id })).status, 'unknown');
    assert.deepEqual(await b.request({ action: 'old-receipt' }), { accepted: true });
    const corrected = await tool('arlo_get_message_status', { message_id: unknown.message_id });
    assert.equal(corrected.status, 'accepted');
    assert.equal(corrected.original_status, 'unknown');
    assert.equal(corrected.late_evidence, true);
    assert.equal(unknown.status, 'unknown', 'Returned tool result is immutable');
    assert.deepEqual(await b.request({ action: 'conflict-receipt' }), { accepted: false, error: ArloErrorCode.RECEIPT_CONFLICT });
    const conflict = await tool('arlo_get_message_status', { message_id: unknown.message_id });
    assert.equal(conflict.status, 'receipt_conflict');
    assert.equal(conflict.reason, ArloErrorCode.RECEIPT_CONFLICT);
    assert.deepEqual(conflict.conflict_assertions.map((proof: any) => proof.receipt), ['enqueued', 'not_enqueued']);
    assert.deepEqual(await tool('arlo_list_sessions', {}), []);
    assert.deepEqual((await b.request({ action: 'snapshot' })).pending, []);

    await b.request({ action: 'unload' });
    await b.request({ action: 'replay-last', fresh: true });
    const unloaded = await b.request({ action: 'snapshot' });
    assert.deepEqual(unloaded.inserted, beforeProof.inserted, 'A fresh frame on the disposed callback cannot enter the host');
    assert.deepEqual(unloaded.pending, []);
    assert.equal(unloaded.childMessages, 0);
    await b.request({ action: 'release' });
    const consumed = await b.request({ action: 'snapshot' });
    assert.equal(consumed.pending.length, 0);
    for (const id of beforeProof.inserted) {
      assert.equal(consumed.messages.filter((message: any) => message.id === id).length, 1);
    }
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await daemon.stop();
    for (const profile of profiles) removeTempDir(profile);
    removeTempDir(stateDir);
  }
});

test('Two real Harnesses enforce out-of-order notification and sliding-window boundaries before host insertion', { timeout: 60000 }, async () => {
  const stateDir = createTempDir('acceptance-window-daemon');
  const profiles = [createTempDir('acceptance-window-a'), createTempDir('acceptance-window-b')];
  const daemon = new ArloDaemon({ stateDir });
  const workers: ReturnType<typeof startHarness>[] = [];
  try {
    await daemon.start();
    workers.push(...profiles.map(profile => startHarness(stateDir, profile)));
    await Promise.all(workers.map(worker => worker.ready));
    const [a, b] = workers;
    const receiver = await eventually(() => b.request({ action: 'snapshot' }),
      value => value.attempts.some((attempt: any) => attempt.ready), 'Window receiver readiness');
    await eventually(() => a.request({ action: 'snapshot' }),
      value => value.attempts.some((attempt: any) => attempt.ready), 'Window sender readiness');
    await b.request({ action: 'hold' });
    const result = await a.request({ action: 'tool', name: 'arlo_send_message',
      args: { to: receiver.endpoint_id, text: 'window-original-canary' } });
    assert.equal(JSON.parse(result.content[0].text).status, 'accepted');
    const inject = (sequence: string) => b.request({ action: 'inject-sequence', sequence });
    // The real MCP delivery supplies the frozen binding. Only its subsequent
    // transport frames are controlled; the real plugin still performs insertion.
    assert.equal((await inject('2048')).status, 'enqueued');
    assert.equal((await inject('1025')).status, 'enqueued', 'The inclusive lower edge of the default 1024-slot window is admissible');
    assert.deepEqual(await inject('1024'), { status: 'uncertain', reason: ArloErrorCode.STALE_SEQUENCE });
    assert.deepEqual(await inject('1025'), { status: 'uncertain', reason: ArloErrorCode.REPLAY_RESULT_UNAVAILABLE });
    assert.equal((await inject('2047')).status, 'enqueued', 'An unseen in-window frame may arrive out of order');
    const snapshot = await b.request({ action: 'snapshot' });
    assert.equal(snapshot.inserted.length, 4);
    assert.equal(snapshot.pending.length, 4);
    assert.equal(snapshot.status, 'running');
    assert.equal(snapshot.childMessages, 0);
    await b.request({ action: 'release' });
    const consumed = await b.request({ action: 'snapshot' });
    assert.equal(consumed.pending.length, 0);
    for (const id of snapshot.inserted) assert.equal(consumed.messages.filter((message: any) => message.id === id).length, 1);
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await daemon.stop();
    for (const profile of profiles) removeTempDir(profile);
    removeTempDir(stateDir);
  }
});

test('Real Harness model calls enforce both default endpoint rates and the eight-level reply limit', { timeout: 90000 }, async () => {
  const stateDir = createTempDir('acceptance-rates-daemon');
  const profiles = ['a', 'b', 'c', 'd'].map(name => createTempDir(`acceptance-rates-${name}`));
  // Advance only the documented clock seam: all host, plugin, TLS and MCP
  // operations remain real, and the production rate/depth limits are unchanged.
  let clock = Date.now();
  const daemon = new ArloDaemon({ stateDir, now: () => clock });
  const workers: ReturnType<typeof startHarness>[] = [];
  try {
    await daemon.start();
    workers.push(...profiles.map(profile => startHarness(stateDir, profile)));
    const pids = await Promise.all(workers.map(worker => worker.ready));
    assert.equal(new Set([...pids, process.pid]).size, 5);
    const snapshots = await Promise.all(workers.map(worker => eventually(() => worker.request({ action: 'snapshot' }),
      value => value.attempts.some((attempt: any) => attempt.ready), 'Rate receiver readiness')));
    const endpoints = snapshots.map(snapshot => snapshot.endpoint_id);
    const call = async (sender: number, target: number, text: string, reply_to?: string) => {
      const result = await workers[sender].request({ action: 'tool', name: 'arlo_send_message',
        args: { to: endpoints[target], text, ...(reply_to ? { reply_to } : {}) } });
      const body = result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
      return result.isError ? body : JSON.parse(body);
    };
    for (let i = 0; i < 4; i++) assert.equal((await call(0, 1, `sender-default-${i}`)).status, 'accepted');
    assert.match(await call(0, 1, 'sender-burst-overflow'), /RATE_LIMITED/);
    for (let i = 0; i < 4; i++) assert.equal((await call(2, 1, `receiver-default-${i}`)).status, 'accepted');
    assert.match(await call(3, 1, 'receiver-burst-overflow'), /RATE_LIMITED/);
    assert.equal((await workers[1].request({ action: 'snapshot' })).notifications, 8,
      'Neither sender-side nor receiver-side rejection dispatches a notification');
    clock += 2000;
    assert.equal((await call(3, 1, 'receiver-refill')).status, 'accepted', 'Default receiver replenishes one slot per two seconds');
    clock += 3000;
    assert.equal((await call(0, 1, 'sender-refill')).status, 'accepted', 'Default sender replenishes one slot per five seconds');

    clock += 60000;
    let sent = await call(0, 1, 'reply-depth-0');
    assert.equal(sent.status, 'accepted');
    let receiver = 1;
    for (let depth = 1; depth <= 8; depth++) {
      const incoming = (await workers[receiver].request({ action: 'snapshot' })).messages.find((message: any) =>
        message.source?.kind === 'arlo' && JSON.parse(message.content[1].text).arlo.message_id === sent.message_id);
      assert.ok(incoming, 'The receiving host retains the actual reply context');
      const context = JSON.parse(incoming.content[1].text).arlo;
      assert.equal(context.reply_depth ?? 0, depth - 1);
      assert.equal(context.from_endpoint, endpoints[1 - receiver]);
      clock += 5000;
      const next = await call(receiver, 1 - receiver, `reply-depth-${depth}`, context.message_id);
      assert.equal(next.status, 'accepted');
      assert.notEqual(next.message_id, sent.message_id);
      sent = next;
      receiver = 1 - receiver;
    }
    const beforeOverflow = (await workers[1 - receiver].request({ action: 'snapshot' })).notifications;
    clock += 5000;
    assert.match(await call(receiver, 1 - receiver, 'reply-depth-9', sent.message_id), /REPLY_DEPTH_LIMIT/);
    assert.equal((await workers[1 - receiver].request({ action: 'snapshot' })).notifications, beforeOverflow);
    assert.ok((await Promise.all(workers.map(worker => worker.request({ action: 'snapshot' }))))
      .every(snapshot => snapshot.pending.length === 0 && snapshot.childMessages === 0));
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await daemon.stop();
    for (const profile of profiles) removeTempDir(profile);
    removeTempDir(stateDir);
  }
});

test('Two independent Harness processes recover a lost ACK and repeated disconnects without reinserting host input', { timeout: 90000 }, async () => {
  const stateDir = createTempDir('recovery-process-daemon');
  const profileA = createTempDir('recovery-process-a');
  const profileB = createTempDir('recovery-process-b');
  const daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT });
  const workers: ReturnType<typeof startHarness>[] = [];
  try {
    await daemon.start();
    const a = startHarness(stateDir, profileA);
    const b = startHarness(stateDir, profileB);
    workers.push(a, b);
    const [pidA, pidB] = await Promise.all([a.ready, b.ready]);
    assert.equal(new Set([pidA, pidB, process.pid]).size, 3);
    const snapshot = () => b.request({ action: 'snapshot' });
    await Promise.all([a, b].map(worker => eventually(
      () => worker.request({ action: 'snapshot' }), value => value.attempts.some((attempt: any) => attempt.ready), 'Initial readiness')));
    const text = (message: any): string => message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
    const tool = async (name: 'arlo_list_sessions' | 'arlo_send_message' | 'arlo_get_message_status', args: Record<string, unknown>) =>
      JSON.parse(text(await a.request({ action: 'tool', name, args })));
    const sessions = await tool('arlo_list_sessions', {});
    assert.equal(sessions.length, 1);
    const target = sessions[0].endpoint_id;
    const send = (body: string) => tool('arlo_send_message', { to: target, text: body });
    const status = (messageId: string) => tool('arlo_get_message_status', { message_id: messageId });

    await b.request({ action: 'hold' });
    await b.request({ action: 'drop-ack' });
    const lost = await send('lost-ack-real-host-input');
    assert.equal(lost.status, 'unknown');
    assert.equal(lost.reason, ArloErrorCode.ACK_TIMEOUT);
    const before = await snapshot();
    assert.equal(before.pending.length, 1);
    assert.equal(before.inserted.length, 1);
    assert.equal(before.notifications, 1);
    const nativeId = before.pending[0].id;

    for (const generation of [2, 3, 4]) {
      await b.request({ action: 'disconnect' });
      const recovered = await eventually(snapshot, value => value.attempts.some(
        (attempt: any) => attempt.ready && attempt.endpoint_id === target && attempt.generation === generation), 'Same-instance recovery');
      assert.equal(recovered.pid, pidB);
      assert.equal(recovered.endpoint_id, target);
      assert.equal(recovered.generation, generation);
      assert.equal(recovered.status, 'running');
      assert.deepEqual(recovered.pending, before.pending);
      assert.deepEqual(recovered.inserted, [nativeId]);
      assert.equal(recovered.notifications, 1, 'Connection recovery must not replay message notifications');
      await b.request({ action: 'replay-last', fresh: true });
      assert.deepEqual((await snapshot()).inserted, [nativeId],
        'An old generation callback cannot borrow the reconnected binding even with a fresh frame identity');
      const readiness = recovered.attempts.find((attempt: any) => attempt.ready && attempt.generation === generation);
      assert.deepEqual(readiness.pending, [lost.message_id], 'Readiness must reconcile the retained mapping of actual host pending input');
      const corrected = await eventually(() => status(lost.message_id), value => value.status === 'accepted', 'Historical reception proof');
      assert.equal(corrected.original_status, 'unknown');
      assert.equal(corrected.late_evidence, true);
      assert.equal((await tool('arlo_list_sessions', {}))[0].endpoint_id, target);
    }
    assert.deepEqual(await b.request({ action: 'old-receipt' }), { accepted: false, error: ArloErrorCode.STALE_GENERATION },
      'Old credentials cannot submit historical proof');
    assert.equal((await send('new-message-after-recovery')).status, 'accepted');
    const afterNew = await snapshot();
    assert.equal(afterNew.pending.length, 2);
    assert.equal(afterNew.inserted.length, 2);
    assert.equal(afterNew.notifications, 2);
    assert.equal(afterNew.childMessages, 0);
    await b.request({ action: 'release' });
    const consumed = await snapshot();
    assert.equal(consumed.pending.length, 0);
    assert.equal(consumed.messages.filter((message: any) => message.id === nativeId).length, 1);
    assert.equal(consumed.inserted.length, 2);

    // Replacing only the plugin destroys continuity even with the same process,
    // Agent object and SessionId. It cannot speak for the discarded mapping.
    await b.request({ action: 'hold' });
    await b.request({ action: 'drop-ack' });
    const orphaned = await send('unknown-before-plugin-replacement');
    assert.equal(orphaned.status, 'unknown');
    const replacementBefore = await snapshot();
    await b.request({ action: 'replace-plugin' });
    const replacement = await eventually(snapshot, value => value.attempts.some(
      (attempt: any) => attempt.endpoint_id !== target && !attempt.ready), 'Replacement reconciliation failure');
    const failed = replacement.attempts.find((attempt: any) => attempt.endpoint_id !== target && !attempt.ready);
    assert.equal(failed.error, ArloErrorCode.ACCOUNTING_UNAVAILABLE);
    assert.deepEqual(replacement.pending, replacementBefore.pending);
    assert.deepEqual(replacement.inserted, replacementBefore.inserted);
    assert.equal(replacement.notifications, replacementBefore.notifications);
    assert.equal(replacement.pid, pidB);
    assert.equal((await status(orphaned.message_id)).status, 'unknown');
    assert.deepEqual(await tool('arlo_list_sessions', {}), []);
    assert.deepEqual(await b.request({ action: 'old-receipt' }), { accepted: false, error: ArloErrorCode.STALE_GENERATION });
    await b.request({ action: 'release' });
    const final = await snapshot();
    assert.equal(final.pending.length, 0);
    assert.equal(final.messages.filter((message: any) => message.content[0]?.text === 'unknown-before-plugin-replacement').length, 1);
    assert.deepEqual(final.inserted, replacementBefore.inserted);
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await daemon.stop();
    removeTempDir(profileA);
    removeTempDir(profileB);
    removeTempDir(stateDir);
  }
});

test('Two existing Harness processes survive a manually restarted Daemon without restoring old endpoints or pending proofs', { timeout: 120000 }, async () => {
  const stateDir = createTempDir('recovery-restarted-daemon');
  const profileA = createTempDir('recovery-restart-a');
  const profileB = createTempDir('recovery-restart-b');
  let daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT });
  const workers: ReturnType<typeof startHarness>[] = [];
  try {
    await daemon.start();
    const a = startHarness(stateDir, profileA);
    const b = startHarness(stateDir, profileB);
    workers.push(a, b);
    const [pidA, pidB] = await Promise.all([a.ready, b.ready]);
    assert.equal(new Set([pidA, pidB, process.pid]).size, 3);
    const [initialA, initialB] = await Promise.all([a, b].map(worker => eventually(
      () => worker.request({ action: 'snapshot' }), value => value.attempts.some((attempt: any) => attempt.ready), 'Initial readiness')));
    const text = (message: any): string => message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
    const tool = async (name: 'arlo_list_sessions' | 'arlo_send_message' | 'arlo_get_message_status', args: Record<string, unknown>) =>
      JSON.parse(text(await a.request({ action: 'tool', name, args })));
    await b.request({ action: 'hold' });
    const sent = await tool('arlo_send_message', { to: initialB.endpoint_id, text: 'retained-across-manual-daemon-restart' });
    assert.equal(sent.status, 'accepted');
    const before = await b.request({ action: 'snapshot' });
    assert.equal(before.pending.length, 1);
    assert.equal(before.inserted.length, 1);

    const daemonId = daemon.daemonId;
    await daemon.stop();
    daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT });
    await daemon.start();
    assert.notEqual(daemon.daemonId, daemonId);
    // Restart recovery can already be waiting in the default 10-second backoff,
    // then performs protected discovery, TLS authentication and registration.
    // The ordinary 12-second observation window is not a recovery SLA. Allow
    // these stages to complete under full-suite load without changing their
    // production deadlines or accepting anything short of actual readiness.
    const [recoveredA, recoveredB] = await Promise.all([
      eventually(() => a.request({ action: 'snapshot' }), value => value.attempts.some(
        (attempt: any) => attempt.endpoint_id !== initialA.endpoint_id && attempt.ready),
      'Sender registration with replacement Daemon', 45000),
      eventually(() => b.request({ action: 'snapshot' }), value => value.attempts.some(
        (attempt: any) => attempt.endpoint_id !== initialB.endpoint_id && !attempt.ready),
      'Receiver pending reconciliation with replacement Daemon', 45000),
    ]);
    assert.equal(recoveredA.pid, pidA);
    assert.equal(recoveredB.pid, pidB);
    assert.notEqual(recoveredA.endpoint_id, initialA.endpoint_id);
    assert.notEqual(recoveredB.endpoint_id, initialB.endpoint_id);
    const failed = recoveredB.attempts.find((attempt: any) => attempt.endpoint_id !== initialB.endpoint_id && !attempt.ready);
    assert.equal(failed.error, ArloErrorCode.ACCOUNTING_UNAVAILABLE);
    assert.deepEqual(failed.pending, [before.pending[0].id], 'Replacement Daemon receives the real unmapped host native ID');
    assert.deepEqual(recoveredB.pending, before.pending);
    assert.deepEqual(recoveredB.inserted, before.inserted);
    assert.equal(recoveredB.notifications, 1);
    assert.equal(recoveredB.childMessages, 0);
    assert.deepEqual(await tool('arlo_list_sessions', {}), []);
    assert.equal((await tool('arlo_get_message_status', { message_id: sent.message_id })).status, 'result_unavailable');
    await b.request({ action: 'release' });
    const consumed = await b.request({ action: 'snapshot' });
    assert.equal(consumed.pending.length, 0);
    assert.equal(consumed.messages.filter((message: any) => message.id === before.pending[0].id).length, 1);
    assert.deepEqual(consumed.inserted, before.inserted);
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await daemon.stop();
    removeTempDir(profileA);
    removeTempDir(profileB);
    removeTempDir(stateDir);
  }
});

test('Two plugins launch and reuse one shared Daemon, restart it without replay, and unload independently', { timeout: 180000 }, async () => {
  const stateDir = createTempDir('shared-harness-daemon');
  const profiles = [createTempDir('shared-harness-a'), createTempDir('shared-harness-b')];
  const workers = profiles.map(profile => startHarness(stateDir, profile, true));
  let ownedDaemon: { pid: number; daemon_id: string } | undefined;
  const read = () => readDiscoveryRecord(stateDir);
  try {
    const pids = await Promise.all(workers.map(worker => worker.ready));
    const ready = (worker: typeof workers[number]) => eventually(() => worker.request({ action: 'snapshot' }),
      value => value.attempts.some((attempt: any) => attempt.ready), 'Automatic plugin startup', 45000);
    const [a, b] = workers;
    const [initialA, initialB] = await Promise.all(workers.map(ready));
    const first = ownedDaemon = read();
    assert.equal(new Set([...pids, first.pid, process.pid]).size, 4);
    const tool = async (name: 'arlo_list_sessions' | 'arlo_send_message' | 'arlo_get_message_status', args: Record<string, unknown>) => {
      const response = await a.request({ action: 'tool', name, args });
      return JSON.parse(response.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n'));
    };
    assert.equal((await tool('arlo_list_sessions', {}))[0].endpoint_id, initialB.endpoint_id);
    await b.request({ action: 'hold' });
    const sent = await tool('arlo_send_message', { to: initialB.endpoint_id, text: 'shared-daemon-body-canary' });
    assert.equal(sent.status, 'accepted');
    const before = await b.request({ action: 'snapshot' });
    assert.equal(before.inserted.length, 1);
    // Kill only the positively authenticated fixture Daemon we just launched.
    assert.equal((await new DaemonClient({ stateDir }).getStatus()).daemon_id, first.daemon_id);
    process.kill(first.pid, 'SIGKILL');
    const [afterA, afterB] = await Promise.all([
      eventually(() => a.request({ action: 'snapshot' }), value => value.attempts.some((attempt: any) =>
        attempt.endpoint_id !== initialA.endpoint_id && attempt.ready), 'Automatic sender restart', 45000),
      eventually(() => b.request({ action: 'snapshot' }), value => value.attempts.some((attempt: any) =>
        attempt.endpoint_id !== initialB.endpoint_id && !attempt.ready), 'Automatic receiver recheck', 45000),
    ]);
    ownedDaemon = read();
    assert.notEqual(ownedDaemon.daemon_id, first.daemon_id);
    assert.equal(afterA.pid, pids[0]);
    assert.equal(afterB.pid, pids[1]);
    assert.deepEqual(afterB.inserted, before.inserted);
    assert.deepEqual(afterB.pending, before.pending);
    assert.equal(afterB.notifications, 1);
    assert.equal(afterB.attempts.find((attempt: any) => attempt.endpoint_id !== initialB.endpoint_id).error,
      ArloErrorCode.ACCOUNTING_UNAVAILABLE);
    assert.equal((await tool('arlo_get_message_status', { message_id: sent.message_id })).status, 'result_unavailable');
    await b.request({ action: 'release' });
    await b.stop();
    await new Promise(resolve => setTimeout(resolve, 11000));
    assert.equal((await new DaemonClient({ stateDir }).getStatus()).daemon_id, ownedDaemon.daemon_id,
      'One plugin unloading must leave the other plugin and Daemon alive');
    assert.equal((await a.request({ action: 'snapshot' })).pid, pids[0]);
    await a.stop();
    await eventually(async () => fs.existsSync(path.join(stateDir, 'discovery.json')), exists => !exists,
      'Automatic idle exit after last plugin unload', 30000);
    const log = fs.readFileSync(path.join(stateDir, 'daemon.log'), 'utf8');
    assert.equal(log.includes('shared-daemon-body-canary'), false);
    assert.equal(log.includes(stateDir), false);
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    if (ownedDaemon) {
      try {
        const current = await new DaemonClient({ stateDir }).getStatus();
        if (current.daemon_id === ownedDaemon.daemon_id && current.pid === ownedDaemon.pid) process.kill(ownedDaemon.pid, 'SIGKILL');
      } catch {}
    }
    for (const profile of profiles) removeTempDir(profile);
    removeTempDir(stateDir);
  }
});
