import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapterRuntime, type AdapterHost, type ReceptionHost, type ReceptionEvidence, type PendingInput } from '@arlo/adapter-sdk';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, type ArloMessageNotificationParams } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';
import { fixtureRootEvidence } from './helpers/host-continuation-fixture.ts';

// An opaque root is deliberately unlike a DSH Agent. Identity and lifecycle
// evidence are supplied only through the public host boundary.
function hostFixture() {
  const root = {};
  const roots = [root];
  const host: AdapterHost<object> = {
    roots: () => roots,
    sessionId: () => 'root',
    sessionCwd: () => undefined,
    reception: () => ({ instanceId: 'native-root', prepare: () => {
      throw new Error('No delivery expected while startup is pending');
    } }),
    onCreated: () => () => {},
    onDisposed: () => () => {},
  };
  return { root, host };
}

test('public adapter cancellation aborts its startup wait and never readies the root', async () => {
  const { root, host } = hostFixture();
  const started = Promise.withResolvers<AbortSignal>();
  const runtime = createAdapterRuntime({
    host, hostType: 'test-host', hostVersion: '1', groupName: 'cancel-startup',
    stateDir: 'injected-state-directory', autoStart: { idleTimeoutMs: 12345 },
    startSharedDaemon: async options => {
      assert.equal(options.stateDir, 'injected-state-directory');
      assert.equal(options.idleTimeoutMs, 12345);
      started.resolve(options.signal);
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  });
  const signal = await started.promise;
  await runtime.dispose();
  assert.equal(signal.aborted, true);
  await assert.rejects(() => runtime.listContactSessions(root));
});

function liveHost(stateDir: string) {
  type Root = { id: string; reception: ReceptionHost; inputs: ArloMessageNotificationParams[];
    pending: PendingInput[]; observing: boolean; evidence: (value: ReceptionEvidence) => void };
  const roots: Root[] = [];
  const created = new Set<(root: Root) => void>();
  const disposed = new Set<(root: Root) => void>();
  const host: AdapterHost<Root> = {
    roots: () => roots, sessionId: root => root.id, sessionCwd: () => undefined,
    rootConfigurationEvidence: fixtureRootEvidence(stateDir),
    reception: root => root.reception,
    onCreated: listener => { created.add(listener); return () => { created.delete(listener); }; },
    onDisposed: listener => { disposed.add(listener); return () => { disposed.delete(listener); }; },
  };
  function add(id: string, outcome: 'enqueued' | 'unknown' = 'enqueued') {
    const root: Root = { id, inputs: [], pending: [], observing: false, evidence: () => {}, reception: {
      instanceId: `${id}-${Math.random()}`,
      prepare: frame => ({ nativeMessageId: `native-${frame.message_id}`, enqueue: () => {
        root.inputs.push(frame);
        root.pending.push({ nativeMessageId: `native-${frame.message_id}`, messageId: frame.message_id,
          textBytes: Buffer.byteLength(frame.text), dispatch: {
            daemon_id: frame.daemon_id, endpoint_id: frame.to_endpoint, message_id: frame.message_id,
            delivery_id: frame.delivery_id, generation: frame.target_generation,
          } });
        return outcome;
      } }),
      snapshot: scope => ({ ...scope, complete: true, pending: [...root.pending], inFlight: [] }),
      observe: listener => {
        root.observing = true;
        root.evidence = listener;
        return () => { root.observing = false; root.evidence = () => {}; };
      },
    } };
    roots.push(root);
    for (const listener of created) listener(root);
    return root;
  }
  function remove(root: Root) {
    roots.splice(roots.indexOf(root), 1);
    for (const listener of disposed) listener(root);
  }
  return { host, add, remove };
}

async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await read(); if (matches(value)) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Public adapter did not reach the expected observable state');
}
const result = (blocks: { text: string }[]) => JSON.parse(blocks[0]!.text);

test('opaque roots discover exact peers, reject forged callers, and replace identities without retargeting', { timeout: 60000 }, async t => {
  const stateDir = createTempDir('public-lifecycle');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = liveHost(stateDir);
  const sender = fixture.add('sender');
  const receiver = fixture.add('same-title');
  const runtime = createAdapterRuntime({ host: fixture.host, hostType: 'test-host', hostKind: 'test.fixture', hostVersion: '1',
    groupName: 'public-lifecycle', controlClient: new ControlClient({ stateDir }),
    startSharedDaemon: async () => { assert.fail('Custom clients must not auto-start by default'); },
  });
  t.after(async () => { await runtime.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  const [peer] = await eventually(() => runtime.listContactSessions(sender), peers => peers.length === 1, 30000);
  await runtime.continueCollaboration(sender);
  const first = result(await runtime.sendMessage(sender, { to: peer!.endpoint_id, text: 'first exact delivery' }));
  assert.equal(first.status, 'accepted');
  assert.deepEqual(receiver.inputs.map(frame => frame.text), ['first exact delivery']);
  await assert.rejects(() => runtime.listSessions({ ...sender }), /CALLER_NOT_ROOT/);
  await assert.rejects(() => runtime.sendMessage(sender, {
    to: peer!.endpoint_id, text: 'forged', root_session_id: receiver.id,
  }), /INVALID_ARGUMENT/);
  fixture.remove(receiver);
  const replacement = fixture.add('same-title');
  const [next] = await eventually(() => runtime.listContactSessions(sender), peers => peers.length === 1 && peers[0]!.endpoint_id !== peer!.endpoint_id, 30000);
  assert.notEqual(next!.endpoint_id, peer!.endpoint_id);
  await assert.rejects(() => runtime.listSessions(receiver), /CALLER_NOT_ROOT/);
  await assert.rejects(() => runtime.sendMessage(sender, { to: peer!.endpoint_id, text: 'do not retarget' }), /TARGET_UNAVAILABLE/);
  assert.equal(replacement.inputs.length, 0);
  assert.equal(result(await runtime.sendMessage(sender, { to: next!.endpoint_id, text: 'new exact delivery' })).status, 'accepted');
  assert.deepEqual(replacement.inputs.map(frame => frame.text), ['new exact delivery']);
});

test('late host evidence updates unknown reception without replay and drained roots can regroup', { timeout: 60000 }, async t => {
  const stateDir = createTempDir('public-late-evidence');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = liveHost(stateDir);
  const sender = fixture.add('sender');
  const receiver = fixture.add('receiver', 'unknown');
  const runtime = createAdapterRuntime({ host: fixture.host, hostType: 'test-host', hostKind: 'test.fixture', hostVersion: '1',
    groupName: 'late-evidence', controlClient: new ControlClient({ stateDir }),
  });
  t.after(async () => { await runtime.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  const [peer] = await eventually(() => runtime.listContactSessions(sender), peers => peers.length === 1, 30000);
  await runtime.continueCollaboration(sender);
  const sent = result(await runtime.sendMessage(sender, { to: peer!.endpoint_id, text: 'uncertain input' }));
  assert.equal(sent.status, 'unknown');
  const pending = receiver.pending[0]!;
  receiver.evidence({ instanceId: receiver.reception.instanceId, dispatch: pending.dispatch!,
    nativeMessageId: pending.nativeMessageId, event: 'enqueued' });
  const status = await eventually(async () => result(await runtime.getMessageStatus(sender, { message_id: sent.message_id })), status => status.status === 'accepted');
  assert.equal(status.late_evidence, true);
  assert.equal(sent.status, 'unknown', 'The already-returned send outcome remains immutable');
  assert.equal(receiver.inputs.length, 1);
  receiver.pending.length = 0;
  receiver.evidence({ instanceId: receiver.reception.instanceId, dispatch: pending.dispatch!,
    nativeMessageId: pending.nativeMessageId, event: 'claimed' });
  await runtime.switchGroup(receiver, 'another-group');
  assert.deepEqual(await runtime.listContactSessions(sender), []);
  assert.deepEqual(await runtime.listContactSessions(receiver), []);
});

test('suspending an attachment preserves its living root reception while disabling communication', { timeout: 60000 }, async t => {
  const stateDir = createTempDir('suspended-attachment');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const sendingHost = liveHost(stateDir);
  const receivingHost = liveHost(stateDir);
  const sender = sendingHost.add('sender');
  const receiver = receivingHost.add('receiver');
  const sendingControl = new ControlClient({ stateDir });
  const receivingControl = new ControlClient({ stateDir });
  const sending = createAdapterRuntime({ host: sendingHost.host, hostType: 'test-host', hostKind: 'pi',
    hostVersion: '1', groupName: 'suspended-attachment', controlClient: sendingControl });
  const receiving = createAdapterRuntime({ host: receivingHost.host, hostType: 'test-host', hostKind: 'pi',
    hostVersion: '1', groupName: 'suspended-attachment', controlClient: receivingControl });
  t.after(async () => {
    await receiving.dispose();
    await sending.dispose();
    receivingControl.dispose();
    sendingControl.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  });
  const [peer] = await eventually(() => sending.listContactSessions(sender), peers => peers.length === 1, 30000);
  await sending.continueCollaboration(sender);
  const sent = result(await sending.sendMessage(sender, { to: peer!.endpoint_id, text: 'Keep this accepted input across detach' }));
  assert.equal(sent.status, 'accepted');
  const pending = structuredClone(receiver.pending);
  const registeredEndpoints = (await sendingControl.listRoots()).map(root => root.endpoint_id).sort();

  const suspension = receiving.suspend();
  await assert.rejects(receiving.listSessions(receiver), { code: 'CHANNEL_NOT_READY' });
  await assert.rejects(receiving.sendMessage(receiver, { to: peer!.endpoint_id, text: 'stale tool' }), { code: 'CHANNEL_NOT_READY' });
  await suspension;
  assert.ok(receivingHost.host.roots().includes(receiver));
  assert.deepEqual(receiver.pending, pending, 'Detach cannot erase accepted pending input or its original dispatch');
  assert.equal(receiver.observing, true, 'The living root must retain its reception evidence consumer');
  assert.equal(result(await sending.getMessageStatus(sender, { message_id: sent.message_id })).status, 'accepted');
  assert.deepEqual(await sending.listContactSessions(sender), []);
  await assert.rejects(sending.sendMessage(sender, { to: peer!.endpoint_id, text: 'no new delivery' }), { code: 'TARGET_UNAVAILABLE' });
  receivingHost.add('later-root');
  await receiving.suspend();
  assert.deepEqual((await sendingControl.listRoots()).map(root => root.endpoint_id).sort(), registeredEndpoints,
    'A suspended attachment cannot register another endpoint');
  assert.equal(receiver.inputs.length, 1);

  await receiving.dispose();
  assert.equal(receiver.observing, false, 'Final disposal releases the retained evidence consumer');
  assert.deepEqual(receiver.pending, pending, 'Final cleanup still leaves native input ownership with the host');
});

for (const outcome of ['enqueued', 'unknown'] as const) {
test(`a paused runtime resumes the same root binding and ${outcome} ledger without redispatching input`, { timeout: 60000 }, async t => {
  const stateDir = createTempDir('reattached-runtime');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const sendingHost = liveHost(stateDir);
  const receivingHost = liveHost(stateDir);
  const sender = sendingHost.add('sender');
  const receiver = receivingHost.add('receiver', outcome);
  const sending = createAdapterRuntime({ host: sendingHost.host, hostType: 'pi', hostKind: 'pi',
    hostVersion: '1', groupName: 'reattachment', controlClient: new ControlClient({ stateDir }) });
  const control = new ControlClient({ stateDir });
  const receiving = createAdapterRuntime({ host: receivingHost.host, hostType: 'pi', hostKind: 'pi',
    hostVersion: '1', groupName: 'reattachment', controlClient: control });
  t.after(async () => { await receiving.dispose(); await sending.dispose(); control.dispose();
    await daemon.stop(); removeTempDir(stateDir); });
  const [peer] = await eventually(() => sending.listContactSessions(sender), peers => peers.length === 1, 30000);
  await sending.continueCollaboration(sender);
  const sent = result(await sending.sendMessage(sender, { to: peer!.endpoint_id, text: 'original input' }));
  const expectedStatus = outcome === 'enqueued' ? 'accepted' : 'unknown';
  assert.equal(sent.status, expectedStatus);
  const pending = structuredClone(receiver.pending);
  const originalGeneration = (await control.listRoots()).find(item => item.endpoint_id === peer!.endpoint_id)!.generation;
  const pausing = receiving.pause();
  await assert.rejects(receiving.listSessions(receiver), { code: 'CHANNEL_NOT_READY' });
  await pausing;
  await eventually(() => sending.listContactSessions(sender), peers => peers.length === 0);
  assert.deepEqual(receiver.pending, pending);
  assert.equal(receiver.observing, true);
  const snapshot = receiver.reception.snapshot!;
  receiver.reception.snapshot = scope => ({ ...snapshot(scope), complete: false });
  await assert.rejects(receiving.resume(), { code: 'ACCOUNTING_UNAVAILABLE' });
  assert.deepEqual(receiver.pending, pending, 'An incomplete view cannot release or forget occupancy');
  assert.deepEqual(await sending.listContactSessions(sender), []);
  receiver.reception.snapshot = snapshot;
  const originalOwner = receiver.reception;
  receiver.reception = { ...originalOwner };
  await assert.rejects(receiving.resume(), { code: 'ACCOUNTING_UNAVAILABLE' });
  receiver.reception = originalOwner;
  const stranger = receivingHost.add('stranger');
  await assert.rejects(receiving.resume(), { code: 'ACCOUNTING_UNAVAILABLE' });
  receivingHost.remove(stranger);
  await receiving.resume();
  const [resumed] = await sending.listContactSessions(sender);
  assert.equal(resumed!.endpoint_id, peer!.endpoint_id, 'Reattachment must prove continuity of the original endpoint');
  assert.ok((await control.listRoots()).find(item => item.endpoint_id === peer!.endpoint_id)!.generation > originalGeneration);
  assert.deepEqual(receiver.pending, pending, 'Neither snapshot reconciliation nor runner replacement can redispatch input');
  assert.equal(receiver.inputs.length, 1);
  assert.equal(result(await sending.getMessageStatus(sender, { message_id: sent.message_id })).status, expectedStatus);
  const [claimed] = receiver.pending.splice(0);
  receiver.evidence({ instanceId: receiver.reception.instanceId, nativeMessageId: claimed!.nativeMessageId,
    dispatch: claimed!.dispatch!, event: 'claimed' });
  assert.equal(result(await sending.sendMessage(sender, { to: resumed!.endpoint_id, text: 'new input' })).status, expectedStatus);
  assert.equal(receiver.inputs.length, 2);
});
}

test('a paused runtime retains its pending input when a participation update finds a replacement daemon', { timeout: 60000 }, async t => {
  const stateDir = createTempDir('paused-participation-daemon-replacement');
  const firstDaemon = new ArloDaemon({ stateDir });
  const replacementDaemon = new ArloDaemon({ stateDir });
  await firstDaemon.start();
  const fixture = liveHost(stateDir);
  const sender = fixture.add('sender');
  const receiver = fixture.add('receiver');
  const control = new ControlClient({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, hostType: 'test-host', hostKind: 'pi',
    hostVersion: '1', groupName: 'paused-participation', controlClient: control });
  t.after(async () => {
    await runtime.dispose();
    control.dispose();
    await firstDaemon.stop();
    await replacementDaemon.stop();
    removeTempDir(stateDir);
  });
  const [peer] = await eventually(() => runtime.listContactSessions(sender), peers => peers.length === 1, 30000);
  await runtime.continueCollaboration(sender);
  const sent = result(await runtime.sendMessage(sender, { to: peer!.endpoint_id, text: 'Retain this original input' }));
  assert.equal(sent.status, 'accepted');
  const pending = structuredClone(receiver.pending);
  await runtime.pause();
  await firstDaemon.stop();
  await replacementDaemon.start();

  await assert.rejects(runtime.setCrossHostEnabled(true), { code: 'ACCOUNTING_UNAVAILABLE' });
  assert.deepEqual(receiver.pending, pending, 'Changing participation cannot discard input admitted by the original Daemon');
  assert.equal(receiver.observing, true, 'The paused root retains its original reception evidence consumer');
  await assert.rejects(runtime.resume(), { code: 'ACCOUNTING_UNAVAILABLE' });
  await assert.rejects(runtime.listSessions(receiver), { code: 'CHANNEL_NOT_READY' });
  assert.deepEqual(await control.listRoots(), [], 'The setting update cannot register replacement root bindings');
  assert.deepEqual(receiver.pending, pending, 'Failed resumption cannot clear the original pending input or dispatch proof');
  assert.equal(receiver.inputs.length, 1, 'Neither settings nor resumption redispatches the accepted input');
});

for (const retirement of ['runtime', 'native-root'] as const) {
  test(`snapshot-only ${retirement} disposal settles a just-drained input before the next heartbeat`, { timeout: 60000 }, async t => {
    const stateDir = createTempDir(`snapshot-${retirement}-disposal`);
    const stopped = Promise.withResolvers<void>();
    const daemon = new ArloDaemon({ stateDir, idleTimeoutMs: 15000, onIdleStopped: stopped.resolve });
    await daemon.start();
    const fixture = liveHost(stateDir);
    const sender = fixture.add('sender');
    const receiver = fixture.add('snapshot-receiver');
    delete receiver.reception.observe;
    const control = new ControlClient({ stateDir });
    const runtime = createAdapterRuntime({ host: fixture.host, hostType: 'snapshot-test', hostKind: 'test.fixture', hostVersion: '1',
      groupName: 'snapshot-disposal', controlClient: control,
      recovery: { heartbeatIntervalMs: 20000, leaseDurationMs: 30000 },
    });
    t.after(async () => { await runtime.dispose(); control.dispose(); await daemon.stop(); removeTempDir(stateDir); });
    const [peer] = await eventually(() => runtime.listContactSessions(sender), peers => peers.length === 1, 30000);
    await runtime.continueCollaboration(sender);
    const sent = result(await runtime.sendMessage(sender, { to: peer!.endpoint_id, text: 'Drain immediately before disposal' }));
    assert.equal(sent.status, 'accepted');
    assert.equal(receiver.pending.length, 1);
    receiver.pending.length = 0;
    if (retirement === 'native-root') fixture.remove(receiver);
    await runtime.dispose();
    control.dispose();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([stopped.promise, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Snapshot disposal left daemon credit pending')), 20000);
      })]);
    } finally { clearTimeout(deadline); }
  });
}

test('snapshot disposal still revokes when an injected credit client throws synchronously', { timeout: 45000 }, async t => {
  const stateDir = createTempDir('snapshot-disposal-throw');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = liveHost(stateDir);
  const sender = fixture.add('sender');
  const receiver = fixture.add('receiver');
  delete receiver.reception.observe;
  class ThrowingCreditClient extends ControlClient {
    override releaseCredit(): ReturnType<ControlClient['releaseCredit']> {
      throw new Error('Injected synchronous credit failure');
    }
  }
  const control = new ThrowingCreditClient({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, hostType: 'snapshot-test', hostKind: 'test.fixture', hostVersion: '1',
    groupName: 'snapshot-disposal', controlClient: control,
    recovery: { heartbeatIntervalMs: 20000, leaseDurationMs: 30000 },
  });
  t.after(async () => { await runtime.dispose(); control.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  const [peer] = await eventually(() => runtime.listContactSessions(sender), peers => peers.length === 1, 30000);
  await runtime.continueCollaboration(sender);
  assert.equal(result(await runtime.sendMessage(sender, { to: peer!.endpoint_id, text: 'One pending input' })).status, 'accepted');
  receiver.pending.length = 0;
  await runtime.dispose();
  await assert.rejects(runtime.listSessions(sender), { code: 'CHANNEL_NOT_READY' });
  assert.ok((await control.listRoots()).every(root => root.status === 'revoked'), 'Accounting failure cannot skip runtime revocation');
});
