import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createAdapterRuntime, ReceptionLedger,
  type AdapterHost, type ReceptionHost, type ReceptionEvidence, type PendingInput,
} from '@arlo/adapter-sdk';
import { ArloDaemon } from '@arlo/daemon';
import { ensureSharedDaemon } from '@arlo/daemon/shared';
import {
  ControlClient, DaemonClient, enforceWindowsAcl, captureRootConfigurationEvidence,
  type ArloMessageNotificationParams, type ArloSendMessageResult,
  type ArloMessageStatusResult, type SessionDiscoveryItem,
} from '@arlo/sdk';

// This artificial host has no model, UI, inbox polling, or product integration.
// Native input and scheduling belong to the host; only its public adapter
// boundary is visible to Arlo. Each mode exposes exactly one evidence style.
type Mode = 'events' | 'snapshot';
type Root = object;
type NativeInput = PendingInput & { frame: ArloMessageNotificationParams };

function minimalHost(mode: Mode) {
  let persistenceDirectory: string | undefined;
  const live = new Set<Root>();
  const records = new WeakMap<Root, {
    id: string; title: string; reception: ReceptionHost;
    pending: NativeInput[]; inFlight: NativeInput[]; complete: boolean; received: NativeInput[]; scheduled: number;
    publish: (evidence: ReceptionEvidence) => void;
  }>();
  const created = new Set<(root: Root) => void>();
  const disposed = new Set<(root: Root) => void>();
  const host: AdapterHost<Root> = {
    roots: () => [...live],
    sessionId: root => records.get(root)!.id,
    sessionCwd: () => undefined,
    rootConfigurationEvidence(root) {
      if (!persistenceDirectory) return undefined;
      const file = path.join(persistenceDirectory, `${records.get(root)!.id}.jsonl`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, `public-fixture-root:${records.get(root)!.id}\n`, { mode: 0o600 });
      return captureRootConfigurationEvidence(file);
    },
    reception: root => records.get(root)!.reception,
    onCreated: listener => { created.add(listener); return () => { created.delete(listener); }; },
    onDisposed: listener => { disposed.add(listener); return () => { disposed.delete(listener); }; },
  };
  function add(title: string) {
    const root = Object.freeze({});
    const pending: NativeInput[] = [];
    const received: NativeInput[] = [];
    const record = {
      id: randomUUID(), title, pending, inFlight: [] as NativeInput[], complete: true, received, scheduled: 0,
      publish: (_evidence: ReceptionEvidence) => {},
      reception: undefined as unknown as ReceptionHost,
    };
    const reception: ReceptionHost = {
      instanceId: randomUUID(),
      prepare(frame) {
        const nativeMessageId = randomUUID();
        const input: NativeInput = {
          nativeMessageId, messageId: frame.message_id,
          textBytes: Buffer.byteLength(frame.text, 'utf8'), frame,
          dispatch: {
            daemon_id: frame.daemon_id, endpoint_id: frame.to_endpoint,
            message_id: frame.message_id, delivery_id: frame.delivery_id,
            generation: frame.target_generation,
          },
        };
        return {
          nativeMessageId,
          enqueue() {
            pending.push(input);
            received.push(input);
            record.scheduled++;
            return 'enqueued';
          },
        };
      },
      ...(mode === 'events' ? {
        observe(listener: (evidence: ReceptionEvidence) => void) {
          record.publish = listener;
          return () => { record.publish = () => {}; };
        },
      } : {
        snapshot(scope: { instanceId: string; generation: number }) {
          return { ...scope, complete: record.complete, pending: [...pending], inFlight: [...record.inFlight] };
        },
      }),
    };
    record.reception = reception;
    records.set(root, record);
    live.add(root);
    for (const listener of created) listener(root);
    return root;
  }
  function drain(root: Root) {
    const record = records.get(root)!;
    for (const input of record.pending.splice(0)) {
      if (mode === 'events') record.publish({
        instanceId: record.reception.instanceId, nativeMessageId: input.nativeMessageId,
        dispatch: input.dispatch!, event: 'claimed',
      });
    }
  }
  return {
    persist(directory: string) {
      persistenceDirectory = path.join(directory, 'contract-host-sessions');
      fs.mkdirSync(persistenceDirectory, { recursive: true, mode: 0o700 });
    },
    host, add, drain, read: (root: Root) => records.get(root)!,
    title: (root: Root) => records.get(root)!.title,
    listenerCount: () => created.size + disposed.size,
    remove(root: Root) {
      assert.equal(live.delete(root), true);
      for (const listener of disposed) listener(root);
    },
  };
}

function ownedState() {
  const base = path.resolve(process.env.ARLO_ACCEPTANCE_ROOT ?? os.homedir());
  const directory = fs.mkdtempSync(path.join(base, 'generic-contract-'));
  enforceWindowsAcl(directory, true);
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const owner = randomUUID();
  const marker = path.join(directory, '.contract-owner.json');
  fs.writeFileSync(marker, JSON.stringify({ owner }));
  return {
    stateDir: path.join(directory, 'state'),
    remove() {
      assert.equal(path.dirname(path.resolve(directory)), base);
      assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
      assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).owner, owner);
      assert.equal(fs.existsSync(path.join(directory, 'state', 'discovery.json')), false,
        `Retain state while its daemon still owns discovery: ${directory}`);
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean, description: string, timeoutMs = 30000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let lastObservation = 'no successful read';
  let attempts = 0;
  do {
    attempts++;
    try {
      const value = await read();
      if (matches(value)) return value;
      lastObservation = Array.isArray(value) ? `${value.length} entries` : typeof value;
    } catch (error) { lastError = error; }
    await delay(50);
  } while (Date.now() < deadline);
  const lastCode = (lastError as { code?: string } | undefined)?.code ?? 'none';
  throw new Error(`${description}; attempts=${attempts}; last_error_code=${lastCode}; last_observation=${lastObservation}`, { cause: lastError });
}

function data<T>(blocks: { text: string }[]): T {
  assert.equal(blocks.length, 1);
  return JSON.parse(blocks[0]!.text) as T;
}

function attach(fixture: ReturnType<typeof minimalHost>, stateDir: string) {
  fixture.persist(stateDir);
  return createAdapterRuntime({
    host: fixture.host, hostType: 'minimal-contract-host', hostVersion: '1',
    // Independent instances of this fixture represent the same known host.
    hostKind: 'minimal-contract-host',
    groupName: 'generic-installed-contract', getSessionTitle: fixture.title,
    stateDir, startSharedDaemon: ensureSharedDaemon,
    // Use the production idle window: Windows authentication performs real
    // ACL checks before registration and can outlast a tiny fixture timeout.
    autoStart: { idleTimeoutMs: 60000 }, recovery: { heartbeatIntervalMs: 100, leaseDurationMs: 120000 },
  });
}

for (const mode of ['events', 'snapshot'] as const) {
  test(`Installed ${mode}-only host registers, discovers exact roots, receives, replies and revokes`, { timeout: 180000 }, async () => {
    const state = ownedState();
    // This public daemon instance gives the fixture an owned graceful stop,
    // including failures with unresolved input. Shared startup authenticates
    // and reuses this exact instance; it does not start a replacement.
    // This contract checks installation and host wiring, while dedicated
    // recovery tests cover lease expiry. Leave room for real Windows ACL work.
    const daemon = new ArloDaemon({ stateDir: state.stateDir, leaseDurationMs: 120000 });
    const firstHost = minimalHost(mode);
    const secondHost = minimalHost(mode);
    const sender = firstHost.add('sender');
    const receiver = secondHost.add('same display name');
    const runtimes: ReturnType<typeof attach>[] = [];
    try {
      await daemon.start();
      const diagnostics = new DaemonClient({ stateDir: state.stateDir });
      const before = await diagnostics.getStatus();
      const first = attach(firstHost, state.stateDir);
      runtimes.push(first);
      // Windows performs synchronous ACL inspection during authentication.
      // Complete each host's startup before constructing the next fixture.
      await eventually(() => first.listContactSessions(sender), peers => peers.length === 0,
        'The first installed adapter root becomes ready');
      const second = attach(secondHost, state.stateDir);
      runtimes.push(second);
      const [target] = await eventually(() => first.listContactSessions(sender), peers => peers.length === 1,
        'Both installed adapter roots become discoverable');
      assert.ok(target);
      assert.equal(target.host_type, 'minimal-contract-host');
      assert.equal(target.deliverable, true);
      assert.equal(firstHost.read(sender).reception[mode === 'events' ? 'snapshot' : 'observe'], undefined);
      await first.continueCollaboration(sender);
      await second.continueCollaboration(receiver);

      const decoy = secondHost.add('same display name');
      const peers = await eventually(async () => data<SessionDiscoveryItem[]>(await first.listSessions(sender, {})),
        items => items.length === 2, 'A native created event registers another real root');
      assert.equal(new Set(peers.map(peer => peer.endpoint_id)).size, 2);
      assert.deepEqual(peers.map(peer => peer.display_name), ['same display name', 'same display name']);
      await assert.rejects(first.listSessions({}), { code: 'CALLER_NOT_ROOT' });
      await assert.rejects(first.sendMessage(sender, { to: target.endpoint_id, text: 'forged', root_session_id: 'another-root' }),
        { code: 'INVALID_ARGUMENT' });

      const sent = data<ArloSendMessageResult>(await first.sendMessage(sender, { to: target.endpoint_id, text: 'A fictional request' }));
      assert.equal(sent.status, 'accepted');
      const incoming = secondHost.read(receiver);
      assert.equal(incoming.pending.length, 1, 'Acceptance leaves input pending for native processing');
      assert.equal(incoming.scheduled, 1, 'Enqueue schedules existing host work without inbox polling');
      assert.equal(incoming.received[0]!.frame.text, 'A fictional request');
      assert.equal(secondHost.read(decoy).received.length, 0, 'Display names cannot retarget an exact endpoint');
      const status = data<ArloMessageStatusResult>(await first.getMessageStatus(sender, { message_id: sent.message_id }));
      assert.equal(status.status, 'accepted');
      assert.equal(status.original_status, 'accepted');
      assert.equal(status.native_message_id, incoming.pending[0]!.nativeMessageId);
      assert.equal('text' in status, false, 'Reception status contains metadata, not message content');
      const otherStatus = data<{ status: string; reason: string }>(await second.getMessageStatus(decoy, { message_id: sent.message_id }));
      assert.equal(otherStatus.reason, 'RESULT_UNAVAILABLE');

      const context = incoming.received[0]!.frame;
      await assert.rejects(second.sendMessage(decoy, { to: context.from_endpoint, text: 'unauthorized reply', reply_to: sent.message_id }),
        { code: 'INVALID_REPLY' });
      const reply = data<ArloSendMessageResult>(await second.sendMessage(receiver, {
        to: context.from_endpoint, text: 'A fictional reply', reply_to: sent.message_id,
      }));
      assert.equal(reply.status, 'accepted');
      assert.notEqual(reply.message_id, sent.message_id);
      assert.equal(firstHost.read(sender).received[0]!.frame.reply_to, sent.message_id);
      assert.equal(firstHost.read(sender).received[0]!.frame.reply_depth, 1);

      secondHost.remove(decoy);
      await eventually(() => first.listContactSessions(sender), items => items.length === 1,
        'Native disposal revokes only the removed root');
      await assert.rejects(second.listSessions(decoy), { code: 'CALLER_NOT_ROOT' });
      await second.dispose();
      assert.equal(secondHost.listenerCount(), 0);
      assert.equal(secondHost.read(receiver).pending.length, 1, 'Unloading communication preserves native pending input');
      await assert.rejects(second.listSessions(receiver), { code: 'CHANNEL_NOT_READY' });
      await eventually(() => first.listContactSessions(sender), items => items.length === 0,
        'Unloaded roots disappear from discovery');
      await assert.rejects(first.sendMessage(sender, { to: target.endpoint_id, text: 'revoked target' }), { code: 'TARGET_UNAVAILABLE' });
      const after = await diagnostics.getStatus();
      assert.equal(after.daemon_id, before.daemon_id);
      assert.equal(after.status, 'ready');
      assert.equal(after.active_endpoints_count, 1);
      assert.equal(data<ArloMessageStatusResult>(await first.getMessageStatus(sender, { message_id: sent.message_id })).status, 'accepted');
    } finally {
      for (const runtime of runtimes) await runtime.dispose();
      await daemon.stop();
      state.remove();
    }
  });
}

test('Installed event-only evidence releases capacity without duplicate insertion', async () => {
  const fixture = minimalHost('events');
  const root = fixture.add('ledger root');
  const host = fixture.read(root).reception;
  const receipts: string[] = [];
  const ledger = new ReceptionLedger({ host, currentGeneration: 1, initialCapacity: 1,
    onCredit: proof => receipts.push(proof.event) });
  const frame: ArloMessageNotificationParams = {
    protocol_version: '0.1', daemon_id: 'contract-daemon', message_id: 'contract-message',
    delivery_id: 'contract-delivery', from_endpoint: 'sender', to_endpoint: 'receiver',
    group_id: 'contract-group', target_generation: 1, delivery_seq: '1',
    text: 'Fictional input', sent_at: '2026-10-07T00:00:00.000Z',
  };
  try {
    const first = await ledger.receiveFrame(frame);
    assert.equal(first.status, 'enqueued');
    assert.equal(ledger.getAvailableCapacity(), 0);
    assert.deepEqual(await ledger.receiveFrame(frame), first);
    assert.equal(fixture.read(root).received.length, 1);
    const native = fixture.read(root).pending[0]!;
    fixture.read(root).publish({ instanceId: 'a-different-native-instance',
      nativeMessageId: native.nativeMessageId, dispatch: native.dispatch!, event: 'claimed' });
    assert.equal(ledger.getAvailableCapacity(), 0, 'An unrelated host instance cannot release pending credit');
    assert.deepEqual(receipts, []);
    fixture.drain(root);
    assert.equal(ledger.getAvailableCapacity(), 1);
    assert.deepEqual(receipts, ['claimed']);
    ledger.acknowledgeCredit(frame.message_id);
    assert.deepEqual(await ledger.receiveFrame(frame), first);
    assert.equal(fixture.read(root).received.length, 1, 'Released credit does not permit another insertion of a settled dispatch');
  } finally { ledger.dispose(); }
});

test('Installed authoritative snapshot evidence preserves uncertainty, in-flight input and original dispatch identity', async () => {
  const fixture = minimalHost('snapshot');
  const root = fixture.add('uncertain native input');
  const native = fixture.read(root);
  const prepare = native.reception.prepare;
  native.reception.prepare = frame => {
    const input = prepare(frame);
    return { nativeMessageId: input.nativeMessageId, enqueue() { input.enqueue(); return 'unknown'; } };
  };
  const ledger = new ReceptionLedger({ host: native.reception, currentGeneration: 1, initialCapacity: 1 });
  const frame: ArloMessageNotificationParams = {
    protocol_version: '0.1', daemon_id: 'snapshot-daemon', message_id: 'snapshot-message',
    delivery_id: 'snapshot-delivery', from_endpoint: 'sender', to_endpoint: 'receiver',
    group_id: 'snapshot-group', target_generation: 1, delivery_seq: '1',
    text: 'Uncertain native insertion', sent_at: '2026-10-07T00:00:00.000Z',
  };
  try {
    const original = await ledger.receiveFrame(frame);
    assert.equal(original.status, 'unknown');
    native.inFlight.push(native.pending.shift()!);
    ledger.advanceGeneration(2);
    assert.deepEqual(ledger.reconcilePendingMessageIds(), [frame.message_id],
      'Input outside the pending queue remains charged while it is still in flight');
    native.inFlight.length = 0;
    native.complete = false;
    assert.deepEqual(ledger.reconcilePendingMessageIds(), [frame.message_id],
      'Absence in an incomplete snapshot does not release credit');
    assert.equal(ledger.getRetainedEvidence()[0]!.credit, undefined);
    native.complete = true;
    assert.deepEqual(ledger.reconcilePendingMessageIds(), []);
    assert.equal(ledger.getAvailableCapacity(), 1);
    const retained = ledger.getRetainedEvidence()[0]!;
    assert.equal(retained.receipt.status, 'uncertain', 'Complete absence proves capacity, not acceptance');
    assert.equal(retained.credit?.event, 'snapshot');
    assert.equal(retained.credit?.generation, 1, 'Credit retains the original dispatch generation after reconnect');
    assert.equal(retained.credit?.delivery_id, frame.delivery_id);
    assert.equal(retained.credit?.native_message_id, native.received[0]!.nativeMessageId);
    ledger.acknowledgeCredit(frame.message_id);
    assert.equal(ledger.getRetainedEvidence()[0]!.receipt.status, 'uncertain');
    assert.equal(original.status, 'unknown', 'Snapshot and credit ACK cannot rewrite the original receive result');
    assert.equal(native.received.length, 1);
  } finally { ledger.dispose(); }
});

test('Installed snapshot-only capacity returns after authoritative native dequeue on a healthy binding', { timeout: 120000 }, async () => {
  const state = ownedState();
  // Admission pacing has separate coverage. Use the daemon's public option
  // to reach its ordinary 1 MiB pending budget without waiting for rate refill.
  const daemon = new ArloDaemon({ stateDir: state.stateDir, leaseDurationMs: 120000, rateLimit: {
    sender: { perMinute: 60000, burst: 1000 }, receiver: { perMinute: 60000, burst: 1000 },
  } });
  const fixture = minimalHost('snapshot');
  const sender = fixture.add('sender');
  const receiver = fixture.add('receiver');
  let runtime: ReturnType<typeof attach> | undefined;
  try {
    await daemon.start();
    runtime = attach(fixture, state.stateDir);
    const current = runtime;
    const [peer] = await eventually(() => current.listContactSessions(sender), peers => peers.length === 1,
      'Snapshot-only roots become ready');
    assert.ok(peer);
    const text = 'x'.repeat(32 * 1024);
    fixture.persist(state.stateDir);
    await current.continueCollaboration(sender);
    for (let count = 0; count < 32; count++) {
      if (count === 20) await current.continueCollaboration(sender);
      assert.equal(data<ArloSendMessageResult>(await current.sendMessage(sender, { to: peer.endpoint_id, text })).status, 'accepted');
    }
    assert.equal(fixture.read(receiver).pending.length, 32);
    await assert.rejects(current.sendMessage(sender, { to: peer.endpoint_id, text: 'over capacity' }), { code: 'QUEUE_LIMIT' });
    fixture.drain(receiver);
    const deadline = Date.now() + 5000;
    let recovered: ArloSendMessageResult | undefined;
    while (!recovered && Date.now() < deadline) {
      try {
        recovered = data<ArloSendMessageResult>(await current.sendMessage(sender, {
          to: peer.endpoint_id, text: 'after authoritative dequeue',
        }));
      } catch (error) {
        // Only definite pre-dispatch capacity refusal permits another attempt.
        // An unknown delivery must never make this fixture send another input.
        if ((error as { code?: string }).code !== 'QUEUE_LIMIT') throw error;
        await delay(50);
      }
    }
    assert.ok(recovered, 'A complete snapshot releases native and Daemon pending capacity without reconnecting');
    assert.equal(recovered.status, 'accepted');
    assert.equal(fixture.read(receiver).received.length, 33);
    assert.equal(fixture.read(receiver).received[32]!.frame.target_generation,
      fixture.read(receiver).received[0]!.frame.target_generation,
      'Snapshot evidence restores capacity without changing the connection generation');
    const [samePeer] = await current.listContactSessions(sender);
    assert.equal(samePeer!.endpoint_id, peer.endpoint_id, 'Capacity recovery retains the registered endpoint');
  } finally {
    await runtime?.dispose();
    await daemon.stop();
    state.remove();
  }
});

test('Installed snapshot-only unload reconciles consumed input before the next heartbeat and permits daemon idle exit', { timeout: 60000 }, async () => {
  const state = ownedState();
  let stoppedByIdle = false;
  const daemon = new ArloDaemon({ stateDir: state.stateDir, idleTimeoutMs: 15000,
    onIdleStopped: () => { stoppedByIdle = true; } });
  const fixture = minimalHost('snapshot');
  const sender = fixture.add('sender');
  const receiver = fixture.add('receiver');
  const control = new ControlClient({ stateDir: state.stateDir });
  let runtime: ReturnType<typeof attach> | undefined;
  try {
    await daemon.start();
    runtime = createAdapterRuntime({
      host: fixture.host, hostType: 'minimal-contract-host', hostVersion: '1',
      hostKind: 'minimal-contract-host',
      groupName: 'snapshot-immediate-unload', controlClient: control,
      // Leave the heartbeat outside this immediate consume/unload window.
      // Native disposal must not depend on waiting for a periodic observation.
      recovery: { heartbeatIntervalMs: 19000, leaseDurationMs: 20000 },
    });
    const current = runtime;
    const [peer] = await eventually(() => current.listContactSessions(sender), peers => peers.length === 1,
      'Snapshot-only roots register before sending');
    assert.ok(peer);
    fixture.persist(state.stateDir);
    await current.continueCollaboration(sender);
    const sent = data<ArloSendMessageResult>(await current.sendMessage(sender, {
      to: peer.endpoint_id, text: 'Consume before unloading communication',
    }));
    assert.equal(sent.status, 'accepted');
    assert.equal(fixture.read(receiver).pending.length, 1);
    fixture.drain(receiver);
    await current.dispose();
    control.dispose();
    assert.equal(fixture.read(receiver).received.length, 1);
    await eventually(async () => stoppedByIdle, stopped => stopped,
      'A complete final snapshot permits the daemon to release its own listener and state after unload', 20000);
    assert.equal(fs.existsSync(path.join(state.stateDir, 'discovery.json')), false);
  } finally {
    await runtime?.dispose();
    control.dispose();
    await daemon.stop();
    state.remove();
  }
});

test('Installed shared startup starts one authenticated daemon and unloading one host preserves another', { timeout: 150000 }, async () => {
  const state = ownedState();
  const one = minimalHost('events');
  const two = minimalHost('snapshot');
  const firstRoot = one.add('one');
  const secondRoot = two.add('two');
  const runtimes: ReturnType<typeof attach>[] = [];
  try {
    assert.equal(fs.existsSync(path.join(state.stateDir, 'discovery.json')), false);
    const first = attach(one, state.stateDir);
    runtimes.push(first);
    await eventually(() => first.listContactSessions(firstRoot), peers => peers.length === 0,
      'Injected shared startup readies the first root');
    const diagnostics = new DaemonClient({ stateDir: state.stateDir });
    const before = await diagnostics.getStatus();
    assert.notEqual(before.pid, process.pid, 'The installed shared entry starts its detached daemon');
    const second = attach(two, state.stateDir);
    runtimes.push(second);
    await eventually(() => second.listContactSessions(secondRoot), peers => peers.length === 1,
      'The second host authenticates and reuses the shared daemon');
    await first.dispose();
    await eventually(() => second.listContactSessions(secondRoot), peers => peers.length === 0,
      'Disposal revokes the first host while the second remains usable');
    const after = await diagnostics.getStatus();
    assert.equal(after.daemon_id, before.daemon_id);
    assert.equal(after.status, 'ready');
    assert.equal(after.active_endpoints_count, 1);
  } finally {
    for (const runtime of runtimes) await runtime.dispose();
    await eventually(async () => fs.existsSync(path.join(state.stateDir, 'discovery.json')), exists => !exists,
      'The shared daemon releases its own discovery after all hosts unload and idle', 75000);
    state.remove();
  }
});
