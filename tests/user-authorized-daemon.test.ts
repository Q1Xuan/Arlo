import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { ArloDaemon, type ArloDaemonOptions } from '@arlo/daemon';
import { ControlClient, type RootRegistrationResponse, type RootReceiptRequest, type RootConnection, ArloErrorCode } from '@arlo/sdk';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from './test-utils.ts';

async function fixture(t: TestContext, options: Partial<ArloDaemonOptions> = {}, independent = false) {
  const stateDir = createTempDir('user-authorized-');
  let daemon: ArloDaemon | undefined, control: ControlClient;
  const connections: RootConnection[] = [];
  const pending = new Set<Promise<unknown>>();
  let worker: ChildProcess | undefined;
  let workerOutput = '';
  let received = 0;
  const receivedIds: string[] = [];
  async function start() {
    if (independent) {
      worker = fork(new URL('./fixtures/user-authorized-concurrency-daemon.ts', import.meta.url), [stateDir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      workerOutput = '';
      worker.stdout!.resume();
      worker.stderr!.on('data', chunk => { workerOutput = (workerOutput + chunk).slice(-65536); });
      let timer: ReturnType<typeof setTimeout>;
      const failed = new Promise<never>((_, reject) => {
        worker!.once('exit', () => reject(new Error(`Concurrency Daemon exited before ready: ${workerOutput}`)));
        timer = setTimeout(() => { worker?.kill(); reject(new Error(`Concurrency Daemon startup deadline: ${workerOutput}`)); }, 60000);
      });
      try { assert.equal((await Promise.race([once(worker, 'message'), failed]))[0], 'ready', workerOutput); }
      finally { clearTimeout(timer!); }
    } else {
      daemon = new ArloDaemon({ ...options, stateDir, rateLimit: UNPACED_RATE_LIMIT });
      await daemon.start();
    }
    control = new ControlClient({ stateDir });
  }
  async function stop() {
    for (const c of connections.splice(0)) c.dispose();
    await Promise.allSettled([...pending]);
    if (worker) {
      if (worker.exitCode === null && worker.signalCode === null) {
        const closed = once(worker, 'exit');
        const timer = setTimeout(() => worker?.kill(), 60000);
        try {
          if (worker.connected) worker.send('stop');
          else worker.kill();
          await closed;
        } finally { clearTimeout(timer); }
      }
      assert.equal(worker.exitCode, 0, `The owned Daemon must release its handles and stop normally: ${workerOutput}`);
    } else await daemon?.stop();
  }
  t.after(async () => { try { await stop(); } finally { removeTempDir(stateDir); } });
  await start();
  async function add(id: string, host_kind = 'claudecode') {
    const runtime = await control.registerRuntime({ host_kind });
    const continuity = crypto.randomBytes(32).toString('hex');
    let binding: RootRegistrationResponse = await control.registerRoot(runtime.runtime_token, {
      root_session_id: id, group_name: 'authorization', agent_incarnation: crypto.randomUUID(), plugin_generation: 1,
      continuity_token: continuity,
    });
    let connection: RootConnection;
    const receipts = new Map<string, RootReceiptRequest>();
    async function attach() {
      connection = control.createRootConnection(binding, { heartbeat: false }); connections.push(connection);
      connection.onNotification(frame => {
        received++;
        receivedIds.push(frame.message_id);
        const receipt: RootReceiptRequest = { daemon_id: frame.daemon_id, endpoint_id: binding.endpoint_id,
          message_id: frame.message_id, delivery_id: frame.delivery_id, generation: frame.target_generation,
          status: 'enqueued', native_message_id: `native-${frame.message_id}` };
        receipts.set(frame.message_id, receipt);
        const operation = control.submitReceipt(binding.root_token, receipt);
        pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      });
      await connection.connect(); await control.confirmRootReady(binding.root_token, { endpoint_id: binding.endpoint_id });
    }
    await attach();
    const request = () => ({ endpoint_id: binding.endpoint_id, generation: binding.generation });
    const status = () => control.getRootSendingStatus(binding.root_token, request());
    const authorize = (request_id = crypto.randomUUID()) => control.authorizeRoot(binding.root_token, { ...request(), request_id });
    const continueRequest = async () => { const s = await status(); return { ...request(), request_id: crypto.randomUUID(), daemon_id: s.daemon_id, sequence: s.control_sequence + 1 }; };
    const grant = async () => control.continueCollaboration(binding.root_token, await continueRequest());
    return { get binding() { return binding; }, get connection() { return connection; }, request, status, authorize, continueRequest, grant,
      async acknowledge(messageId: string) {
        const receipt = receipts.get(messageId);
        assert.ok(receipt, 'Only an observed notification can supply a receipt');
        await control.submitReceipt(binding.root_token, receipt);
      },
      async reconnect() {
        connection.dispose();
        binding = { ...binding, ...await control.connectRoot(runtime.runtime_token, {
          endpoint_id: binding.endpoint_id, continuity_token: continuity,
        }) };
        await attach();
      } };
  }
  return { add, stateDir, get control() { return control; }, get received() { return received; }, receivedIds, async restart() { await stop(); await start(); } };
}

test('Claude ledger and committed controls survive a real daemon restart without issuing again', async t => {
  const f = await fixture(t), a = await f.add('persistent-A'), b = await f.add('persistent-B');
  assert.equal((await a.status()).root_configuration.reason, 'AUTHORIZATION_REQUIRED');
  await assert.rejects(a.grant(), { code: 'ALLOWANCE_UNKNOWN' });
  const bindId = crypto.randomUUID(), bound = await a.authorize(bindId);
  assert.equal(bound.root_configuration.ownership, 'user-authorized'); assert.equal(bound.period_id, null);
  const request = await a.continueRequest();
  const first = await f.control.continueCollaboration(a.binding.root_token, request);
  const mid = crypto.randomUUID(), payload = { to: b.binding.endpoint_id, text: 'durable charge' };
  assert.equal((await a.connection.sendMessage(payload, mid)).status, 'accepted');
  assert.equal((await a.status()).used, 1);
  assert.equal((await f.control.continueCollaboration(a.binding.root_token, request)).period_id, first.period_id);
  assert.equal((await a.status()).used, 1);
  await f.restart();
  const resumed = await f.add('persistent-A');
  const status = await resumed.status(); assert.equal(status.period_id, first.period_id); assert.equal(status.used, 1); assert.equal(status.remaining, 19);
  const replay = await f.control.continueCollaboration(resumed.binding.root_token, { ...request, ...resumed.request() });
  assert.equal(replay.period_id, first.period_id); assert.equal((await resumed.status()).used, 1);
  assert.deepEqual(await resumed.authorize(bindId), bound);
  assert.equal((await resumed.connection.sendMessage(payload, mid)).status, 'unknown');
  assert.equal((await resumed.status()).used, 1); assert.equal(f.received, 1);
  await assert.rejects(f.control.continueCollaboration(a.binding.root_token, request));
  const fresh = await resumed.grant(); assert.equal(fresh.remaining, 20); assert.notEqual(fresh.period_id, first.period_id);
});

test('authorization and continue IDs cannot be reused for another root or operation', async t => {
  const f = await fixture(t), a = await f.add('A'), b = await f.add('B');
  const id = crypto.randomUUID(); await a.authorize(id);
  await assert.rejects(b.authorize(id), { code: 'CONTROL_REQUEST_CONFLICT' });
  const request = await a.continueRequest();
  await assert.rejects(f.control.continueCollaboration(a.binding.root_token, { ...request, request_id: id }), { code: 'CONTROL_REQUEST_CONFLICT' });
  assert.equal((await a.status()).period_id, null); assert.equal((await b.status()).root_configuration.config_id, null);
});

test('concurrent Sidecars cannot write the same Claude identity; replacing an ended owner grants nothing', async t => {
  const f = await fixture(t), a = await f.add('same-id'); await a.authorize(); const first = await a.grant();
  const duplicate = await f.add('same-id');
  await assert.rejects(duplicate.status(), { code: 'BINDING_MISMATCH' });
  await assert.rejects(duplicate.authorize(), { code: 'BINDING_MISMATCH' });
  await f.control.revokeRoot(a.binding.root_token, { endpoint_id: a.binding.endpoint_id });
  const status = await duplicate.status(); assert.equal(status.period_id, first.period_id); assert.equal(status.remaining, 20);
});

test('missing or corrupt Claude history stays unknown and cannot be reinitialized by authorize', async t => {
  const f = await fixture(t), a = await f.add('history'); await a.authorize(); await a.grant();
  const file = path.join(f.stateDir, 'user-authorized-roots.json'), original = fs.readFileSync(file);
  fs.unlinkSync(file);
  assert.equal((await a.status()).knowledge, 'unknown'); await assert.rejects(a.authorize(), { code: 'CONTROL_HISTORY_UNAVAILABLE' });
  await f.restart(); const resumed = await f.add('history');
  assert.equal((await resumed.status()).root_configuration.reason, 'HISTORY_MISSING');
  await assert.rejects(resumed.authorize(), { code: 'CONTROL_HISTORY_UNAVAILABLE' });
  fs.writeFileSync(file, original, { mode: 0o600 });
  assert.equal((await resumed.status()).remaining, 20);
  fs.writeFileSync(file, '{broken');
  assert.equal((await resumed.status()).knowledge, 'unknown'); await assert.rejects(resumed.grant(), { code: 'CONTROL_HISTORY_UNAVAILABLE' });
});

test('DSH and Pi cannot opt into the user-authorized control route', async t => {
  const f = await fixture(t);
  for (const host of ['dsh', 'pi']) { const root = await f.add(host, host); await assert.rejects(root.authorize(), { code: ArloErrorCode.INVALID_ARGUMENT }); }
});

test('atomic publication failures preserve pre-commit state or replay the post-commit result', async t => {
  for (const committed of [false, true]) await t.test(committed ? 'lost commit response' : 'before commit', async t => {
    const f = await fixture(t), a = await f.add(`fault-${committed}`);
    await a.authorize(); const initial = await a.grant(); const request = await a.continueRequest();
    const rename = fs.renameSync; let armed = true;
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === path.join(f.stateDir, 'user-authorized-roots.json') && armed) {
        armed = false;
        if (committed) rename(from, to);
        throw Object.assign(new Error('Injected publication failure'), { code: 'EIO' });
      }
      return rename(from, to);
    });
    await assert.rejects(f.control.continueCollaboration(a.binding.root_token, request), { code: 'CONTROL_HISTORY_UNAVAILABLE' });
    const after = await a.status();
    assert.equal(after.control_sequence, initial.control_sequence + (committed ? 1 : 0));
    if (!committed) assert.equal(after.period_id, initial.period_id);
    const retry = await f.control.continueCollaboration(a.binding.root_token, request);
    assert.equal(retry.control_sequence, initial.control_sequence + 1);
    if (committed) assert.equal(retry.period_id, after.period_id);
    assert.equal((await a.status()).remaining, 20);
  });
});

test('a lease expiring while the snapshot is synced cannot publish a grant', async t => {
  let now = 1000;
  const f = await fixture(t, { leaseNow: () => now, leaseDurationMs: 10000 });
  const a = await f.add('expiry'); await a.authorize(); const first = await a.grant();
  const request = await a.continueRequest();
  const sync = fs.fsyncSync; let armed = true;
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    sync(fd); if (armed) { armed = false; now += 10001; }
  });
  await assert.rejects(f.control.continueCollaboration(a.binding.root_token, request), { code: 'CONTROL_HISTORY_UNAVAILABLE' });
  const replacement = await f.add('expiry');
  assert.equal((await replacement.status()).period_id, first.period_id);
  assert.equal((await replacement.status()).remaining, 20);
  await assert.rejects(a.authorize());
});

test('concurrent Claude dispatch admissions cannot overspend one shared twenty-attempt period', { timeout: 600000 }, async t => {
  // Isolate the allowance limit from lease expiry during synchronous native ACL
  // checks. Real-clock expiry and fsync-time revalidation have separate tests.
  const f = await fixture(t, {}, true);
  let a = await f.add('concurrent-sender'), b = await f.add('concurrent-receiver');
  await a.authorize(); await a.grant();
  const attempts = Array.from({ length: 24 }, (_, i) => ({
    id: crypto.randomUUID(), payload: { to: b.binding.endpoint_id, text: `attempt-${i}` },
  }));
  const results = await Promise.allSettled(attempts.map(({ id, payload }) => a.connection.sendMessage(payload, id)));
  for (const result of results) {
    if (result.status === 'fulfilled') assert.ok(['accepted', 'unknown'].includes(result.value.status));
    else assert.equal(result.reason.code, 'ALLOWANCE_EXHAUSTED');
  }
  // A lost response is neither an admission nor a refusal. Observe the actual
  // allowance and receipt identities through their public interfaces instead.
  const deadline = Date.now() + 180000;
  while (f.received < 20 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.received, 20);
  assert.equal(new Set(f.receivedIds).size, 20, 'Every admitted identity is dispatched only once');
  const admitted = attempts.filter(({ id }) => f.receivedIds.includes(id));
  assert.equal(admitted.length, 20);
  // A transport timeout can terminally dispose the SDK connection. Recover
  // the same root with continuity proof; the receiver's stream stays live.
  a.connection.dispose();
  await assert.rejects(a.connection.sendMessage(admitted[0]!.payload, admitted[0]!.id), { code: 'CHANNEL_NOT_READY' });
  await a.reconnect();
  assert.equal((await a.status()).used, 20, 'Connection recovery grants no new allowance');
  for (const { id, payload } of admitted) {
    // The concurrent burst can also lose a receipt response. Retry only the
    // original observed delivery proof; never resend the body to obtain an ACK.
    await b.acknowledge(id);
    assert.equal((await a.connection.getMessageStatus(id)).status, 'accepted');
    let replay = await a.connection.sendMessage(payload, id);
    const replayDeadline = Date.now() + 60000;
    while (replay.status === 'unknown' && Date.now() < replayDeadline) {
      replay = await a.connection.sendMessage(payload, id);
    }
    assert.equal(replay.status, 'accepted', 'Live replay must receive a definitive Daemon response before the barrier');
    assert.equal(replay.message_id, id);
  }
  // A subsequent notification on the same receiver stream is a delivery
  // barrier: all replay requests have completed before this fresh dispatch.
  const witness = await f.add('replay-witness');
  await witness.authorize(); await witness.grant();
  const sentinel = crypto.randomUUID();
  await witness.connection.sendMessage({ to: b.binding.endpoint_id, text: 'replay barrier' }, sentinel);
  const barrierDeadline = Date.now() + 180000;
  while (!f.receivedIds.includes(sentinel) && Date.now() < barrierDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.receivedIds.at(-1), sentinel, 'The receiver observes the delivery barrier');
  assert.equal(f.received, 21, 'Live replays never resend the original twenty bodies');
  // Timed-out SDK calls do not cancel already admitted durable work. Keep the
  // receiver alive until those dispatches are observed, then restart and read
  // the committed allowance through a fresh authenticated attachment.
  await f.restart();
  a = await f.add('concurrent-sender');
  assert.equal((await a.status()).used, 20);
  assert.equal((await a.status()).remaining, 0);
  for (const { id, payload } of admitted) {
    const replay = await a.connection.sendMessage(payload, id);
    assert.ok(['accepted', 'unknown'].includes(replay.status));
    assert.equal(replay.message_id, id);
  }
  assert.equal((await a.status()).used, 20, 'Replays never debit again');
  assert.equal(f.received, 21, 'Durable replays never resend the body');
  b = await f.add('concurrent-receiver');
  await assert.rejects(a.connection.sendMessage({ to: b.binding.endpoint_id, text: 'over limit' }), { code: 'ALLOWANCE_EXHAUSTED' });
});

test('prepared human continuation survives daemon restart without acquiring the new epoch', async t => {
  const f = await fixture(t), root = await f.add('prepared-before-restart');
  await root.authorize();
  const requestId = crypto.randomUUID();
  const original = await f.control.prepareContinuation(root.binding.root_token, {
    ...root.request(), request_id: requestId,
  });
  assert.equal(original.sequence, 1);
  assert.equal((await root.status()).period_id, null, 'Preparation must not grant allowance');
  await f.restart();
  const resumed = await f.add('prepared-before-restart');
  const current = await resumed.status();
  assert.notEqual(current.daemon_id, original.daemon_id);
  const recovered = await f.control.prepareContinuation(resumed.binding.root_token, {
    ...resumed.request(), request_id: requestId,
  });
  assert.equal(recovered.daemon_id, original.daemon_id);
  assert.equal(recovered.sequence, original.sequence);
  assert.equal(recovered.request_id, requestId);
  await assert.rejects(f.control.continueCollaboration(resumed.binding.root_token, recovered), {
    code: 'STALE_GENERATION',
  });
  assert.equal((await resumed.status()).period_id, null);
  const fresh = await f.control.prepareContinuation(resumed.binding.root_token, {
    ...resumed.request(), request_id: crypto.randomUUID(),
  });
  assert.equal((await f.control.continueCollaboration(resumed.binding.root_token, fresh)).remaining, 20);
});

test('a human operation identity cannot change between authorization and prepared continuation', async t => {
  const f = await fixture(t), root = await f.add('prepared-kind-conflict');
  const authorizationId = crypto.randomUUID();
  await root.authorize(authorizationId);
  await assert.rejects(f.control.prepareContinuation(root.binding.root_token, {
    ...root.request(), request_id: authorizationId,
  }), { code: 'CONTROL_REQUEST_CONFLICT' });
  const continuationId = crypto.randomUUID();
  const prepared = await f.control.prepareContinuation(root.binding.root_token, {
    ...root.request(), request_id: continuationId,
  });
  await assert.rejects(root.authorize(continuationId), { code: 'CONTROL_REQUEST_CONFLICT' });
  assert.equal((await root.status()).period_id, null);
  assert.equal((await f.control.continueCollaboration(root.binding.root_token, prepared)).remaining, 20);
});

test('a prepared human continuation rejects a changed sequence without losing its original request', async t => {
  const f = await fixture(t), root = await f.add('prepared-sequence-conflict');
  await root.authorize();
  const prepared = await f.control.prepareContinuation(root.binding.root_token, {
    ...root.request(), request_id: crypto.randomUUID(),
  });
  await assert.rejects(f.control.continueCollaboration(root.binding.root_token, {
    ...prepared, sequence: 2,
  }), { code: 'CONTROL_REQUEST_CONFLICT' });
  assert.equal((await root.status()).period_id, null);
  const first = await f.control.continueCollaboration(root.binding.root_token, prepared);
  const recovered = await f.control.prepareContinuation(root.binding.root_token, {
    ...root.request(), request_id: prepared.request_id,
  });
  assert.equal(recovered.sequence, 1);
  assert.equal((await f.control.continueCollaboration(root.binding.root_token, recovered)).period_id, first.period_id);
});
