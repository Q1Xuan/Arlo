import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArloDaemon } from '@arlo/daemon';
import { ArloErrorCode } from '@arlo/sdk';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from './test-utils.ts';
import type { HarnessCommand } from './fixtures/harness-worker.ts';

function startHarness(stateDir: string, profileDir: string) {
  const child = spawn(process.execPath, [
    '--import', new URL('../probes/isolation.mjs', import.meta.url).href,
    fileURLToPath(new URL('./fixtures/harness-worker.ts', import.meta.url)),
  ], {
    cwd: profileDir,
    windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot,
      HOME: profileDir, USERPROFILE: profileDir, APPDATA: profileDir, LOCALAPPDATA: profileDir,
      XDG_CONFIG_HOME: profileDir, XDG_DATA_HOME: profileDir, XDG_CACHE_HOME: profileDir,
      TEMP: profileDir, TMP: profileDir, TMPDIR: profileDir,
      ARLO_STATE_DIR: stateDir,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const ready = Promise.withResolvers<number>();
  const startupTimer = setTimeout(() => ready.reject(new Error('Harness startup timed out')), 20000);
  void ready.promise.then(() => clearTimeout(startupTimer), () => clearTimeout(startupTimer));
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
  let sequence = 0;
  let output = '';
  child.stdout!.on('data', chunk => { output = (output + chunk).slice(-65536); });
  child.stderr!.on('data', chunk => { output = (output + chunk).slice(-65536); });
  const fail = (error: Error) => {
    ready.reject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`Harness exited with code ${code}`)));
  child.on('message', (message: { ready?: boolean; pid: number; id: number; result?: unknown; error?: string }) => {
    if (message.ready) ready.resolve(message.pid);
    else if (message.error) pending.get(message.id)?.reject(new Error(message.error));
    else pending.get(message.id)?.resolve(message.result);
  });
  void ready.promise.catch(() => {});

  async function request(command: HarnessCommand) {
    const id = ++sequence;
    const response = Promise.withResolvers<any>();
    pending.set(id, response);
    const timer = setTimeout(() => response.reject(new Error(`Harness ${command.action} timed out`)), 20000);
    try {
      child.send({ id, command }, error => { if (error) response.reject(error); });
      return await response.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }

  return {
    pid: child.pid,
    ready: ready.promise,
    request,
    output: () => output,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const timer = setTimeout(() => child.kill(), 5000);
      try {
        if (child.connected) await request({ action: 'stop' }).catch(() => {});
        else child.kill();
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

test('Two independent Harness processes prove unicast delivery, pending limits and three-state results', { timeout: 180000 }, async () => {
  const stateDir = createTempDir('unicast-process-daemon');
  const profileA = createTempDir('unicast-process-a');
  const profileB = createTempDir('unicast-process-b');
  const daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT });
  const workers: ReturnType<typeof startHarness>[] = [];
  try {
    await daemon.start();
    const a = startHarness(stateDir, profileA);
    const b = startHarness(stateDir, profileB);
    workers.push(a, b);
    const [pidA, pidB] = await Promise.all([a.ready, b.ready]);
    assert.notEqual(pidA, pidB);
    assert.notEqual(pidA, process.pid);
    assert.notEqual(pidB, process.pid);

    const toolText = (message: any): string => message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
    const listed = await a.request({ action: 'tool', name: 'arlo_list_sessions', args: {} });
    const sessions = JSON.parse(toolText(listed));
    assert.equal(sessions.length, 1, 'Only the other ready root is discoverable');
    const target = sessions[0].endpoint_id;
    const send = async (text: string) => a.request({ action: 'tool', name: 'arlo_send_message', args: { to: target, text } });
    const idleText = 'cross-process-idle-secret-canary';
    const original = JSON.parse(toolText(await send(idleText)));
    assert.equal(original.status, 'accepted');
    const idle = await b.request({ action: 'snapshot' });
    assert.equal(idle.messages.filter((message: any) => message.content[0]?.text === idleText).length, 1);
    assert.deepEqual(idle.messages.find((message: any) => message.content[0]?.text === idleText).source, { kind: 'arlo', form: 'relay' });
    assert.equal(idle.childMessages, 0);
    const sender = await a.request({ action: 'snapshot' });
    assert.equal(sender.messages.some((message: any) => message.content[0]?.text === idleText), false);

    // Reply using only the context that survived into the receiving host/model.
    const inbound = idle.messages.find((message: any) => message.content[0]?.text === idleText);
    assert.ok(inbound.content[1]?.text, 'The receiving root needs model-visible reply context');
    const context = JSON.parse(inbound.content[1].text).arlo;
    assert.equal(context.message_id, original.message_id);
    const reply = JSON.parse(toolText(await b.request({
      action: 'tool', name: 'arlo_send_message',
      args: { to: context.from_endpoint, text: 'associated response', reply_to: context.message_id },
    })));
    assert.equal(reply.status, 'accepted');
    assert.notEqual(reply.message_id, original.message_id);
    const receivedReply = (await a.request({ action: 'snapshot' })).messages.find(
      (message: any) => message.content[0]?.text === 'associated response'
    );
    assert.deepEqual(receivedReply.source, { kind: 'arlo', form: 'relay' });
    const replyContext = JSON.parse(receivedReply.content[1].text).arlo;
    assert.equal(replyContext.reply_to, original.message_id);
    assert.equal(replyContext.reply_depth, 1);
    assert.equal(replyContext.message_id, reply.message_id);
    const modelInput = (await a.request({ action: 'snapshot' })).modelMessages;
    assert.ok(JSON.stringify(modelInput).includes(JSON.stringify(receivedReply.content[1].text)),
      'Reply association must reach the local model projection');

    await b.request({ action: 'fault', mode: 'wrong-group' });
    const rejectedText = 'cross-process-rejected-input';
    const rejected = JSON.parse(toolText(await send(rejectedText)));
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reason, ArloErrorCode.BINDING_MISMATCH);
    assert.equal((await b.request({ action: 'snapshot' })).messages.some((message: any) => message.content[0]?.text === rejectedText), false);
    await b.request({ action: 'fault', mode: 'none' });

    assert.equal((await b.request({ action: 'hold' })).status, 'running');
    await b.request({ action: 'fault', mode: 'after-insertion' });
    const fullText = 'B'.repeat(32 * 1024);
    const uncertain = JSON.parse(toolText(await send(fullText)));
    assert.equal(uncertain.status, 'unknown');
    assert.equal(uncertain.reason, ArloErrorCode.ENQUEUE_UNCERTAIN);
    // One uncertain and 31 accepted messages exhaust the 1 MiB pending budget.
    // Neither exception handling nor an acceptance ACK may refund this input.
    for (let i = 0; i < 31; i++) {
      assert.equal(JSON.parse(toolText(await send(fullText))).status, 'accepted');
    }
    assert.match(toolText(await send('over budget')), /QUEUE_LIMIT/);
    assert.match(toolText(await send('B'.repeat(32 * 1024 + 1))), /MESSAGE_TOO_LARGE/);
    const busy = await b.request({ action: 'snapshot' });
    assert.equal(busy.status, 'running', 'Incoming messages must not preempt the held model turn');
    assert.equal(busy.pending.length, 32);
    assert.ok(busy.pending.every((message: any) => message.content[0]?.text === fullText && message.source?.kind === 'arlo'));
    assert.equal(busy.childMessages, 0);

    assert.equal((await b.request({ action: 'release' })).status, 'idle');
    assert.equal(JSON.parse(toolText(await send('after claimed credit'))).status, 'accepted');
    assert.equal((await b.request({ action: 'snapshot' })).pending.length, 0);

    // Isolate the default count limit from bytes: 64 short inputs fit well
    // below 1 MiB, including an insertion whose receipt remains unknown.
    await b.request({ action: 'hold' });
    await b.request({ action: 'fault', mode: 'after-insertion' });
    assert.equal(JSON.parse(toolText(await send('short-0'))).status, 'unknown');
    for (let i = 1; i < 64; i++) {
      assert.equal(JSON.parse(toolText(await send(`short-${i}`))).status, 'accepted');
    }
    assert.match(toolText(await send('count-overflow')), /QUEUE_LIMIT/);
    const countFull = await b.request({ action: 'snapshot' });
    assert.equal(countFull.pending.length, 64);
    assert.ok(countFull.pending.every((message: any) => message.content[0]?.text.startsWith('short-')));
    await b.request({ action: 'release' });
    assert.equal(JSON.parse(toolText(await send('after-count-release'))).status, 'accepted');

    const logs = fs.readFileSync(path.join(stateDir, 'daemon.log'), 'utf8');
    for (const canary of [idleText, fullText, 'host-exception-secret-canary', fs.readFileSync(path.join(stateDir, 'bootstrap.token'), 'utf8').trim()]) {
      assert.equal(logs.includes(canary), false, 'Daemon logs must omit message bodies, host errors and credentials');
      assert.ok(workers.every(worker => !worker.output().includes(canary)), 'Harness stdout/stderr must omit canaries');
    }
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await daemon.stop();
    removeTempDir(profileA);
    removeTempDir(profileB);
    removeTempDir(stateDir);
  }
});

for (const transition of ['reconnect', 'reattach', 'daemon-restart'] as const) {
  test(`Real accepted and unknown host input survives ${transition} with reconciliation before readiness`, { timeout: 90000 }, async () => {
    const stateDir = createTempDir(`reentry-${transition}`);
    const profileA = createTempDir('reentry-sender');
    const profileB = createTempDir('reentry-receiver');
    let daemon = new ArloDaemon({ stateDir });
    const workers: ReturnType<typeof startHarness>[] = [];
    const toolText = (message: any): string => message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
    try {
      await daemon.start();
      const a = startHarness(stateDir, profileA);
      const b = startHarness(stateDir, profileB);
      workers.push(a, b);
      await Promise.all([a.ready, b.ready]);
      const list = async () => JSON.parse(toolText(await a.request({ action: 'tool', name: 'arlo_list_sessions', args: {} })));
      const sessions = await list();
      assert.equal(sessions.length, 1);
      const target = sessions[0].endpoint_id;
      const send = async (to: string, text: string) => a.request({ action: 'tool', name: 'arlo_send_message', args: { to, text } });
      await b.request({ action: 'hold' });
      await b.request({ action: 'fault', mode: 'after-insertion' });
      const uncertain = JSON.parse(toolText(await send(target, 'real-unknown-积压')));
      const accepted = JSON.parse(toolText(await send(target, 'real-accepted-积压')));
      assert.equal(uncertain.status, 'unknown');
      assert.equal(accepted.status, 'accepted');
      const before = await b.request({ action: 'snapshot' });
      assert.equal(before.pending.length, 2);
      assert.equal(before.status, 'running');
      const nativeIds = before.pending.map((message: any) => message.id);
      assert.equal(new Set(nativeIds).size, 2);

      let attempt: any;
      if (transition === 'reconnect') {
        attempt = await b.request({ action: 'reconnect' });
        assert.equal(attempt.endpoint_id, target);
        assert.equal(attempt.generation, 2);
      } else {
        await b.request({ action: 'detach' });
        assert.deepEqual((await b.request({ action: 'snapshot' })).pending, before.pending);
        if (transition === 'daemon-restart') {
          await a.request({ action: 'detach' });
          const previousDaemonId = daemon.daemonId;
          await daemon.stop();
          daemon = new ArloDaemon({ stateDir });
          await daemon.start();
          assert.notEqual(daemon.daemonId, previousDaemonId);
          assert.equal((await a.request({ action: 'attach' })).ready, true);
        }
        attempt = await b.request({ action: 'attach' });
        assert.notEqual(attempt.endpoint_id, target);
      }
      assert.equal(attempt.ready, false);
      assert.equal(attempt.error, ArloErrorCode.ACCOUNTING_UNAVAILABLE);
      assert.deepEqual(attempt.pending, nativeIds, 'The actual previously delivered input must reach reconciliation');
      assert.deepEqual(await list(), [], 'An unreconciled root must not reappear in discovery');
      assert.match(toolText(await send(attempt.endpoint_id, 'must-not-enter')), /TARGET_UNAVAILABLE/);

      for (const result of [uncertain, accepted]) {
        const status = JSON.parse(toolText(await a.request({
          action: 'tool', name: 'arlo_get_message_status', args: { message_id: result.message_id },
        })));
        assert.equal(status.status, transition === 'daemon-restart' ? 'result_unavailable' : result.status);
      }
      const after = await b.request({ action: 'snapshot' });
      assert.equal(after.pid, before.pid, 'The same host process must survive the transition');
      assert.equal(after.status, 'running');
      assert.deepEqual(after.pending, before.pending, 'Reconciliation cannot drop or duplicate input');
      assert.equal(after.unexpectedFrames, 0);
      assert.equal(after.childMessages, 0);
      await b.request({ action: 'release' });
      const consumed = await b.request({ action: 'snapshot' });
      assert.equal(consumed.pending.length, 0);
      for (const id of nativeIds) {
        assert.equal(consumed.messages.filter((message: any) => message.id === id).length, 1);
      }
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
      await daemon.stop();
      removeTempDir(profileA);
      removeTempDir(profileB);
      removeTempDir(stateDir);
    }
  });
}
