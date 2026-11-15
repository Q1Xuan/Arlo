import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdapterRuntime, type AdapterHost, type ReceptionEvidence } from '@arlo/adapter-sdk';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, type RootConnection, type ArloMessageNotificationParams } from '@arlo/sdk';
import { PiInputSource } from '../packages/adapter-pi/src/index.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';
import { TestClock } from './helpers/message-status-fixture.ts';
import { fixtureRootEvidence } from './helpers/host-continuation-fixture.ts';

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for expected observable state');
}

test('Pi recovers an expired heartbeat lease with the same input instance and rejects old callbacks and credentials',
  { timeout: 60000 }, async t => {
    const stateDir = createTempDir('pi-rec-lease');
    const clock = new TestClock();
    const daemon = new ArloDaemon({ stateDir, leaseNow: clock.now });
    await daemon.start();
    t.after(async () => { await daemon.stop(); removeTempDir(stateDir); });

    type Root = { id: string; input: PiInputSource; ready: boolean };
    const sender: Root = { id: 'lease-sender', input: new PiInputSource(), ready: false };
    const receiver: Root = { id: 'lease-receiver', input: new PiInputSource(), ready: false };
    for (const root of [sender, receiver]) root.input.attach({
      current: () => true, idle: () => false, sendControl: () => {}, unavailable: () => {}, changed: () => {},
    });
    const instanceId = receiver.input.instanceId;
    let frame: ArloMessageNotificationParams | undefined;
    const prepare = receiver.input.prepare.bind(receiver.input);
    receiver.input.prepare = notification => { frame = notification; return prepare(notification); };

    const connections: RootConnection[] = [];
    const callbacks = new Map<RootConnection, (frame: ArloMessageNotificationParams) => void | Promise<void>>();
    const credits: Parameters<ControlClient['releaseCredit']>[1][] = [];
    const heartbeatStarted = Promise.withResolvers<void>();
    const permitHeartbeat = Promise.withResolvers<void>();
    const rotationStarted = Promise.withResolvers<void>();
    const permitRotation = Promise.withResolvers<void>();
    const creditRetried = Promise.withResolvers<void>();
    const permitCreditResponse = Promise.withResolvers<void>();
    let originalMessageId: string | undefined;
    let originalCreditStarted = false;
    let holdHeartbeat = false;
    let receiverEndpoint: string | undefined;
    let runtimeToken = '';
    class LeaseClient extends ControlClient {
      override async registerRuntime(...args: Parameters<ControlClient['registerRuntime']>) {
        const registration = await super.registerRuntime(...args);
        runtimeToken = registration.runtime_token;
        return registration;
      }
      override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
        const connection = super.createRootConnection(...args);
        connections.push(connection);
        const install = connection.onNotification.bind(connection);
        connection.onNotification = callback => { callbacks.set(connection, callback); return install(callback); };
        return connection;
      }
      override async heartbeatRoot(...args: Parameters<ControlClient['heartbeatRoot']>) {
        if (holdHeartbeat && args[1].endpoint_id === receiverEndpoint) {
          heartbeatStarted.resolve();
          await permitHeartbeat.promise;
        }
        return super.heartbeatRoot(...args);
      }
      override async connectRoot(...args: Parameters<ControlClient['connectRoot']>) {
        if (args[1].endpoint_id === receiverEndpoint) {
          rotationStarted.resolve();
          await permitRotation.promise;
        }
        return super.connectRoot(...args);
      }
      override async releaseCredit(...args: Parameters<ControlClient['releaseCredit']>) {
        const result = await super.releaseCredit(...args);
        if (args[1].message_id === originalMessageId) {
          if (!originalCreditStarted) {
            originalCreditStarted = true;
            // The Daemon has settled the original proof, but the runtime has
            // not received its acknowledgment when heartbeat reconciliation runs.
            await permitCreditResponse.promise;
          } else {
            creditRetried.resolve();
            permitCreditResponse.resolve();
          }
        }
        credits.push(args[1]);
        return result;
      }
    }
    const control = new LeaseClient({ stateDir });
    const runtime = createAdapterRuntime<Root>({
      host: {
        roots: () => [sender, receiver], sessionId: root => root.id, sessionCwd: () => undefined,
      rootConfigurationEvidence: fixtureRootEvidence(stateDir),
        reception: root => root.input, onCreated: () => () => {}, onDisposed: () => () => {},
      },
      hostType: 'pi', hostKind: 'pi', hostVersion: '1.1.0', groupName: 'pi-lease-recovery',
      controlClient: control, recovery: { heartbeatIntervalMs: 50, random: () => 0 },
      onReady: (root, ready) => { root.ready = ready; },
    });
    t.after(async () => {
      holdHeartbeat = false;
      permitHeartbeat.resolve();
      permitRotation.resolve();
      permitCreditResponse.resolve();
      sender.input.close();
      receiver.input.close();
      await runtime.dispose();
    });
    await eventually(() => Promise.resolve(sender.ready && receiver.ready), Boolean);
    receiverEndpoint = (await runtime.listContactSessions(sender)).find(peer => peer.display_name === receiver.id)!.endpoint_id;
    const oldConnection = connections.find(connection => connection.binding.endpoint_id === receiverEndpoint)!;
    const oldBinding = oldConnection.binding;
    await runtime.continueCollaboration(sender);
    await runtime.continueCollaboration(receiver);
    const sent = JSON.parse((await runtime.sendMessage(sender, { to: receiverEndpoint, text: 'PI_LEASE_PENDING' }))[0]!.text);
    assert.equal(sent.status, 'accepted');
    originalMessageId = sent.message_id;
    const before = JSON.parse((await runtime.getMessageStatus(sender, { message_id: sent.message_id }))[0]!.text);
    const pending = receiver.input.snapshot({ instanceId, generation: oldBinding.generation }).pending;
    assert.equal(pending.length, 1);

    holdHeartbeat = true;
    await heartbeatStarted.promise;
    // Only the daemon's monotonic lease clock advances. The live transport is
    // invalidated by its real expiry check, before the local lease timer fires.
    clock.advance(20_000);
    const expired = await control.listRoots(runtimeToken);
    assert.ok(expired.every(root => !root.ready && !root.deliverable));
    await rotationStarted.promise;
    assert.equal(receiver.ready, false);
    await assert.rejects(oldConnection.listSessions(), { code: 'CHANNEL_NOT_READY' });
    const probe = new ControlClient({ stateDir });
    t.after(() => probe.dispose());
    await assert.rejects(probe.heartbeatRoot(oldBinding.root_token, {
      endpoint_id: oldBinding.endpoint_id, generation: oldBinding.generation,
    }), { code: 'STALE_GENERATION' });
    assert.ok(frame);
    await callbacks.get(oldConnection)!({ ...frame, message_id: 'stale-notification', delivery_id: 'stale-delivery', delivery_seq: '2' });
    assert.deepEqual(receiver.input.snapshot({ instanceId, generation: oldBinding.generation }).pending, pending,
      'An expired callback cannot insert another body or change the original native association');

    holdHeartbeat = false;
    permitHeartbeat.resolve();
    permitRotation.resolve();
    await eventually(() => Promise.resolve(sender.ready && receiver.ready), Boolean);
    const recovered = connections.findLast(connection => connection.binding.endpoint_id === receiverEndpoint)!;
    assert.notEqual(recovered, oldConnection);
    assert.ok(recovered.binding.generation > oldBinding.generation);
    assert.notEqual(recovered.binding.root_token, oldBinding.root_token);
    assert.equal(receiver.input.instanceId, instanceId);
    assert.deepEqual(receiver.input.snapshot({ instanceId, generation: recovered.binding.generation }).pending, pending);
    const status = JSON.parse((await runtime.getMessageStatus(sender, { message_id: sent.message_id }))[0]!.text);
    assert.deepEqual(status, before, 'Lease recovery preserves the original accepted dispatch and native input ID');
    assert.equal(sent.status, 'accepted');
    await assert.rejects(probe.confirmRootReady(oldBinding.root_token, {
      endpoint_id: oldBinding.endpoint_id, generation: oldBinding.generation,
    }), { code: 'STALE_GENERATION' });

    const fresh = JSON.parse((await runtime.sendMessage(sender, { to: receiverEndpoint, text: 'PI_LEASE_FRESH' }))[0]!.text);
    assert.equal(fresh.status, 'accepted');
    const reply = JSON.parse((await runtime.sendMessage(receiver, {
      to: before.from_endpoint, reply_to: sent.message_id, text: 'PI_LEASE_REPLY',
    }))[0]!.text);
    assert.equal(reply.status, 'accepted');
    const replies = sender.input.beforeSettle();
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0]!.details, {
      message_id: reply.message_id, from_endpoint: receiverEndpoint, reply_to: sent.message_id,
    });
    const claimed = receiver.input.beforeSettle();
    assert.equal(claimed.length, 2, 'The original and fresh body are each handed off once');
    assert.deepEqual(receiver.input.beforeSettle(), []);
    assert.deepEqual(sender.input.beforeSettle(), []);
    await creditRetried.promise;
    await eventually(() => Promise.resolve(credits), proofs => [sent, fresh, reply].every(result =>
      proofs.some(proof => proof.message_id === result.message_id && proof.event === 'claimed')));
    const originalProofs = await eventually(() => Promise.resolve(credits.filter(proof =>
      proof.message_id === sent.message_id)), proofs => proofs.length >= 2);
    // Idempotent accounting retries may repeat a proof; they never create a
    // second Pi claim or change its original dispatch/native association.
    for (const proof of originalProofs) assert.deepEqual(proof, {
      ...pending[0]!.dispatch, native_message_id: pending[0]!.nativeMessageId, event: 'claimed',
    });
  });

test('Pi root recovers connection after transport drop, retains pending input, and notifies ready state', { timeout: 60000 }, async t => {
  const stateDir = createTempDir('pi-rec-1');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  t.after(async () => { await daemon.stop(); removeTempDir(stateDir); });

  const controls: string[] = [];
  const input = new PiInputSource();
  let idle = false;
  let active = true;
  input.attach({
    current: () => active,
    idle: () => idle,
    sendControl: token => { controls.push(token); },
    unavailable: () => {},
    changed: () => {},
  });

  type Root = { id: string; input: PiInputSource; ready: boolean };
  const receiverRoot: Root = { id: 'pi-receiver-root', input, ready: false };
  const senderRoot: Root = { id: 'pi-sender-root', input: new PiInputSource(), ready: false };
  senderRoot.input.attach({ current: () => true, idle: () => true, sendControl: () => {}, unavailable: () => {}, changed: () => {} });

  const roots = [senderRoot, receiverRoot];
  const host: AdapterHost<Root> = {
    roots: () => roots,
    sessionId: r => r.id,
    sessionCwd: () => undefined,
      rootConfigurationEvidence: fixtureRootEvidence(stateDir),
    reception: r => r.input,
    onCreated: () => () => {},
    onDisposed: () => () => {},
  };

  const connections: RootConnection[] = [];
  class TrackingControlClient extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      const connection = super.createRootConnection(...args);
      connections.push(connection);
      return connection;
    }
  }

  const controlClient = new TrackingControlClient({ stateDir });
  const readyChanges: { id: string; ready: boolean }[] = [];

  const runtime = createAdapterRuntime<Root>({
    host,
    hostType: 'pi',
    hostKind: 'pi',
    hostVersion: '1.1.0',
    groupName: 'pi-recovery-group',
    controlClient,
    onReady: (live, ready) => {
      live.ready = ready;
      readyChanges.push({ id: live.id, ready });
    },
  });
  t.after(() => runtime.dispose());

  // 1. Wait for both roots to become ready
  await eventually(() => Promise.resolve(senderRoot.ready && receiverRoot.ready), Boolean, 30000);
  assert.equal(receiverRoot.ready, true);
  assert.equal(senderRoot.ready, true);

  const peers = await runtime.listContactSessions(senderRoot);
  const receiverPeer = peers.find(p => p.display_name === receiverRoot.id)!;
  const receiverEndpoint = receiverPeer.endpoint_id;
  const receiverConn = connections.find(c => c.binding.endpoint_id === receiverEndpoint)!;
  assert.ok(receiverConn);

  // 2. Sender delivers a message to Pi while receiver is busy/idle=false
  await runtime.continueCollaboration(senderRoot);
  const sendRes = await runtime.sendMessage(senderRoot, {
    to: receiverEndpoint,
    text: 'PI_RECOVER_PENDING: message retained across transport loss',
  });
  const sent = JSON.parse(sendRes[0]!.text);
  assert.equal(sent.status, 'accepted');
  assert.equal(input.pendingCount, 1);

  // 3. Sever receiver connection while input is pending
  receiverConn.dispose();
  assert.equal(receiverRoot.ready, false);
  assert.equal(readyChanges.findLast(c => c.id === receiverRoot.id)?.ready, false);
  assert.equal(input.pendingCount, 1, 'Pending input must be preserved during disconnection');

  // 4. Wait for receiver reconnection and ready notification
  await eventually(() => Promise.resolve(receiverRoot.ready), Boolean, 30000);
  assert.equal(receiverRoot.ready, true);
  assert.equal(readyChanges.findLast(c => c.id === receiverRoot.id)?.ready, true);
  assert.equal(input.pendingCount, 1, 'Reconnection must not drop pending input');

  // 5. Query message status from sender after receiver recovers
  const statusRes = await runtime.getMessageStatus(senderRoot, { message_id: sent.message_id });
  const status = JSON.parse(statusRes[0]!.text);
  assert.equal(status.status, 'accepted');

  // 6. Native Pi model becomes idle and claims the message
  idle = true;
  input.operationFinished();
  await eventually(() => Promise.resolve(controls.length), len => len > 0);
  const wakeToken = controls.at(-1)!;
  const claimed = input.control(wakeToken);
  assert.ok(claimed);
  assert.match(JSON.stringify(claimed.content), /PI_RECOVER_PENDING/);
  assert.equal(input.pendingCount, 0);

  // Claimed message cannot be claimed again
  assert.equal(input.control(wakeToken), undefined);

  // 7. Verify new send/receive works after recovery
  const sentAfterRes = await runtime.sendMessage(senderRoot, {
    to: receiverEndpoint,
    text: 'PI_AFTER_RECOVERY: fresh message',
  });
  const sentAfter = JSON.parse(sentAfterRes[0]!.text);
  assert.equal(sentAfter.status, 'accepted');
  assert.equal(input.pendingCount, 1);
});

test('Uncertain send across disconnect returns unknown, retains ID, and recovers late evidence after reconnect', { timeout: 60000 }, async t => {
  const stateDir = createTempDir('pi-rec-2');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  t.after(async () => { await daemon.stop(); removeTempDir(stateDir); });

  const senderInput = new PiInputSource();
  senderInput.attach({ current: () => true, idle: () => true, sendControl: () => {}, unavailable: () => {}, changed: () => {} });
  const receiverInput = new PiInputSource();
  receiverInput.attach({ current: () => true, idle: () => false, sendControl: () => {}, unavailable: () => {}, changed: () => {} });

  type Root = { id: string; input: PiInputSource; ready: boolean };
  const senderRoot: Root = { id: 'sender-uncertain', input: senderInput, ready: false };
  const receiverRoot: Root = { id: 'receiver-uncertain', input: receiverInput, ready: false };

  const roots = [senderRoot, receiverRoot];
  const connections: RootConnection[] = [];

  class InterceptingClient extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      const conn = super.createRootConnection(...args);
      connections.push(conn);
      return conn;
    }
  }

  const runtime = createAdapterRuntime<Root>({
    host: {
      roots: () => roots,
      sessionId: r => r.id,
      sessionCwd: () => undefined,
      rootConfigurationEvidence: fixtureRootEvidence(stateDir),
      reception: r => r.input,
      onCreated: () => () => {},
      onDisposed: () => () => {},
    },
    hostType: 'pi',
    hostKind: 'pi',
    hostVersion: '1.1.0',
    groupName: 'pi-recovery-group',
    controlClient: new InterceptingClient({ stateDir }),
    onReady: (r, ready) => { r.ready = ready; },
  });
  t.after(() => runtime.dispose());

  await eventually(() => Promise.resolve(senderRoot.ready && receiverRoot.ready), Boolean, 30000);

  const peers = await runtime.listContactSessions(senderRoot);
  const receiverPeer = peers.find(p => p.display_name === receiverRoot.id)!;
  const receiverConn = connections.find(c => c.binding.endpoint_id === receiverPeer.endpoint_id)!;
  const senderConn = connections.find(c => c.binding.endpoint_id !== receiverPeer.endpoint_id)!;

  // Wrap receiverInput.prepare so that after receiver enqueues the message, receiver's connection is severed before receipt reaches daemon
  let receiverDisposed = false;
  const originalPrepare = receiverInput.prepare.bind(receiverInput);
  receiverInput.prepare = (frame) => {
    const prep = originalPrepare(frame);
    return {
      nativeMessageId: prep.nativeMessageId,
      enqueue: () => {
        const res = prep.enqueue();
        if (!receiverDisposed) {
          receiverDisposed = true;
          receiverConn.dispose();
        }
        return res;
      },
    };
  };

  // Sender dispatches; target disconnects while delivery is in flight
  await runtime.continueCollaboration(senderRoot);
  const outcomeText = await runtime.sendMessage(senderRoot, {
    to: receiverConn.binding.endpoint_id,
    text: 'UNCERTAIN_DELIVERY: check late evidence',
  });
  const outcome = JSON.parse(outcomeText[0]!.text);
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.reason, 'CONNECTION_LOST');
  assert.ok(outcome.message_id);

  // Wait for receiver to reconnect and submit retained receipt
  await eventually(() => Promise.resolve(receiverRoot.ready), Boolean, 30000);

  // Query message status with original message ID
  const queryResultText = await runtime.getMessageStatus(senderRoot, { message_id: outcome.message_id });
  const status = JSON.parse(queryResultText[0]!.text);
  assert.equal(status.status, 'accepted');
  assert.equal(status.late_evidence, true);
  assert.equal(status.original_status, 'unknown');
  const retained = receiverInput.snapshot({ instanceId: receiverInput.instanceId, generation: status.target_generation }).pending;
  assert.equal(retained.length, 1, 'Recovery does not enqueue the uncertain body again');
  assert.equal(retained[0]!.nativeMessageId, status.native_message_id);
  assert.equal(retained[0]!.dispatch?.message_id, outcome.message_id);

  // The originally returned send outcome remains unchanged
  assert.equal(outcome.status, 'unknown');
});

test('Contradictory receipts halt new deliveries, retain conservative occupancy, and reflect conflict', { timeout: 60000 }, async t => {
  const stateDir = createTempDir('pi-rec-3');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  t.after(async () => { await daemon.stop(); removeTempDir(stateDir); });

  let observerListener: ((evidence: ReceptionEvidence) => void) | undefined;
  let lastNotificationFrame: ArloMessageNotificationParams | undefined;
  const instanceId = 'conflicted-instance';

  const host = {
    instanceId,
    prepare: (frame: ArloMessageNotificationParams) => {
      lastNotificationFrame = frame;
      return {
        nativeMessageId: 'native-msg-conflict',
        enqueue: () => 'enqueued' as const,
      };
    },
    snapshot: (scope: { instanceId: string; generation: number }) => ({
      instanceId,
      generation: scope.generation,
      complete: true,
      pending: [],
      inFlight: [],
    }),
    observe: (listener: (evidence: ReceptionEvidence) => void) => {
      observerListener = listener;
      return () => { observerListener = undefined; };
    },
  };

  type Root = { id: string; ready: boolean };
  const senderRoot: Root = { id: 'sender-conflict', ready: false };
  const receiverRoot: Root = { id: 'receiver-conflict', ready: false };

  const senderInput = new PiInputSource();
  senderInput.attach({ current: () => true, idle: () => true, sendControl: () => {}, unavailable: () => {}, changed: () => {} });

  const connections: RootConnection[] = [];
  class ConflictedClient extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      const conn = super.createRootConnection(...args);
      connections.push(conn);
      return conn;
    }
  }

  const runtime = createAdapterRuntime<Root>({
    host: {
      roots: () => [senderRoot, receiverRoot],
      sessionId: r => r.id,
      sessionCwd: () => undefined,
      rootConfigurationEvidence: fixtureRootEvidence(stateDir),
      reception: r => r === senderRoot ? senderInput : host,
      onCreated: () => () => {},
      onDisposed: () => () => {},
    },
    hostType: 'pi',
    hostKind: 'pi',
    hostVersion: '1.1.0',
    groupName: 'pi-recovery-group',
    controlClient: new ConflictedClient({ stateDir }),
    onReady: (r, ready) => { r.ready = ready; },
  });
  t.after(() => runtime.dispose());

  await eventually(() => Promise.resolve(senderRoot.ready && receiverRoot.ready), Boolean, 30000);

  const peers = await runtime.listContactSessions(senderRoot);
  const receiverPeer = peers.find(p => p.display_name === receiverRoot.id)!;
  const receiverConn = connections.find(c => c.binding.endpoint_id === receiverPeer.endpoint_id)!;

  // Send a message to receiver
  await runtime.continueCollaboration(senderRoot);
  const sentRes = await runtime.sendMessage(senderRoot, {
    to: receiverConn.binding.endpoint_id,
    text: 'CONFLICTING_DELIVERY',
  });
  const sent = JSON.parse(sentRes[0]!.text);
  assert.equal(sent.status, 'accepted');

  // Simulate contradictory evidence arriving from host observer
  assert.ok(observerListener);
  assert.ok(lastNotificationFrame);
  observerListener({
    instanceId,
    dispatch: {
      daemon_id: lastNotificationFrame.daemon_id,
      endpoint_id: lastNotificationFrame.to_endpoint,
      message_id: sent.message_id,
      delivery_id: lastNotificationFrame.delivery_id,
      generation: lastNotificationFrame.target_generation,
    },
    nativeMessageId: 'native-msg-conflict',
    event: 'not_enqueued', // contradicts enqueued!
  });

  // Querying message status reflects conflict / error
  const status = await eventually(async () => {
    const statusRes = await runtime.getMessageStatus(senderRoot, { message_id: sent.message_id });
    return JSON.parse(statusRes[0]!.text);
  }, s => s.status === 'receipt_conflict', 15000);
  assert.equal(status.status, 'receipt_conflict');

  // Trigger reconnect by disposing connection
  receiverConn.dispose();

  // Reconnection fails because of conflict
  await eventually(async () => {
    try {
      await runtime.listSessions(receiverRoot);
      return false;
    } catch (err: any) {
      return err?.code === 'RECEIPT_CONFLICT' || err?.code === 'ACCOUNTING_UNAVAILABLE';
    }
  }, Boolean, 15000);

  assert.equal(receiverRoot.ready, false);
});

test('Incomplete snapshot during reconnect throws ACCOUNTING_UNAVAILABLE and prevents readiness', { timeout: 60000 }, async t => {
  const stateDir = createTempDir('pi-rec-4');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  t.after(async () => { await daemon.stop(); removeTempDir(stateDir); });

  let snapshotComplete = true;
  const instanceId = 'incomplete-snapshot-instance';

  const host = {
    instanceId,
    prepare: () => ({
      nativeMessageId: 'native-snap',
      enqueue: () => 'enqueued' as const,
    }),
    snapshot: (scope: { instanceId: string; generation: number }) => ({
      instanceId,
      generation: scope.generation,
      complete: snapshotComplete,
      pending: [],
      inFlight: [],
    }),
  };

  type Root = { id: string; ready: boolean };
  const root: Root = { id: 'pi-snapshot-root', ready: false };
  let connection: RootConnection | undefined;

  class SnapshotClient extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      connection = super.createRootConnection(...args);
      return connection;
    }
  }

  const runtime = createAdapterRuntime<Root>({
    host: {
      roots: () => [root],
      sessionId: r => r.id,
      sessionCwd: () => undefined,
      rootConfigurationEvidence: fixtureRootEvidence(stateDir),
      reception: () => host,
      onCreated: () => () => {},
      onDisposed: () => () => {},
    },
    hostType: 'pi',
    hostKind: 'pi',
    hostVersion: '1.1.0',
    groupName: 'pi-recovery-group',
    controlClient: new SnapshotClient({ stateDir }),
    onReady: (r, ready) => { r.ready = ready; },
  });
  t.after(() => runtime.dispose());

  await eventually(() => Promise.resolve(root.ready), Boolean, 30000);

  // Now make snapshot incomplete
  snapshotComplete = false;

  // Drop connection to trigger reconnect
  connection!.dispose();

  // Reconnect attempt must fail because snapshot is incomplete
  await eventually(async () => {
    try {
      await runtime.listSessions(root);
      return false;
    } catch (err: any) {
      return err?.code === 'ACCOUNTING_UNAVAILABLE';
    }
  }, Boolean, 15000);

  assert.equal(root.ready, false);
});

test('Replacement of daemon returns result_unavailable for historical messages and accounts pending safely', { timeout: 60000 }, async t => {
  const stateDir = createTempDir('pi-rec-daemon-replace');
  const firstDaemon = new ArloDaemon({ stateDir });
  const secondDaemon = new ArloDaemon({ stateDir });
  await firstDaemon.start();
  t.after(async () => {
    await firstDaemon.stop().catch(() => {});
    await secondDaemon.stop().catch(() => {});
    removeTempDir(stateDir);
  });

  const receiverInput = new PiInputSource();
  receiverInput.attach({ current: () => true, idle: () => false, sendControl: () => {}, unavailable: () => {}, changed: () => {} });
  const senderInput = new PiInputSource();
  senderInput.attach({ current: () => true, idle: () => true, sendControl: () => {}, unavailable: () => {}, changed: () => {} });

  type Root = { id: string; input: PiInputSource; ready: boolean };
  const receiverRoot: Root = { id: 'receiver-daemon-replace', input: receiverInput, ready: false };
  const senderRoot: Root = { id: 'sender-daemon-replace', input: senderInput, ready: false };

  const runtime = createAdapterRuntime<Root>({
    host: {
      roots: () => [senderRoot, receiverRoot],
      sessionId: r => r.id,
      sessionCwd: () => undefined,
      rootConfigurationEvidence: fixtureRootEvidence(stateDir),
      reception: r => r.input,
      onCreated: () => () => {},
      onDisposed: () => () => {},
    },
    hostType: 'pi',
    hostKind: 'pi',
    hostVersion: '1.1.0',
    groupName: 'pi-recovery-group',
    controlClient: new ControlClient({ stateDir }),
    onReady: (r, ready) => { r.ready = ready; },
  });
  t.after(() => runtime.dispose());

  await eventually(() => Promise.resolve(senderRoot.ready && receiverRoot.ready), Boolean, 30000);

  const peers = await runtime.listContactSessions(senderRoot);
  const receiverPeer = peers.find(p => p.display_name === receiverRoot.id)!;

  // Send a message before daemon replacement
  await runtime.continueCollaboration(senderRoot);
  const sentRes = await runtime.sendMessage(senderRoot, {
    to: receiverPeer.endpoint_id,
    text: 'MESSAGE_BEFORE_REPLACEMENT',
  });
  const sent = JSON.parse(sentRes[0]!.text);
  assert.equal(sent.status, 'accepted');
  assert.equal(receiverInput.pendingCount, 1);

  // Stop first daemon and start replacement daemon
  await firstDaemon.stop();
  await secondDaemon.start();

  // Receiver holding unverified pending input fails closed on replacement daemon
  await eventually(() => runtime.listSessions(receiverRoot).then(
    () => false, (error: { code?: string }) => error.code === 'ACCOUNTING_UNAVAILABLE'), Boolean, 30000);

  // Sender without pending input reconnects successfully to replacement daemon
  await eventually(() => runtime.listContactSessions(senderRoot).then(() => true, () => false), Boolean, 30000);

  // Historical message query against replacement daemon returns result_unavailable
  const statusRes = await runtime.getMessageStatus(senderRoot, { message_id: sent.message_id });
  const status = JSON.parse(statusRes[0]!.text);
  assert.equal(status.status, 'result_unavailable');

  // Pending input is retained safely, not lost
  assert.equal(receiverInput.pendingCount, 1);
});
