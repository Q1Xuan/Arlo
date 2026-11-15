import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ControlClient, type RootConnection, type RootRegistrationResponse } from '@arlo/sdk';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { fixture, LocalModel } from '../probes/fixture.ts';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Recovery did not reach the expected observable state');
}

class RecoveryClock {
  private time = 0;
  private readonly timers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; at: number }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const handle = { unref() { return this; } } as ReturnType<typeof setTimeout>;
    this.timers.set(handle, { callback, at: this.time + delay });
    return handle;
  };
  clearTimeout = (handle: ReturnType<typeof setTimeout>) => { this.timers.delete(handle); };
  advanceWithoutTimers(ms: number): void { this.time += ms; }
  runDueTimers(): void {
    for (const [handle, timer] of [...this.timers]) {
      if (timer.at > this.time) continue;
      this.timers.delete(handle);
      timer.callback();
    }
  }
}

test('A live Host reconnects repeatedly and supplies a lost receipt without another insertion', { timeout: 60000 }, async (t) => {
  const rig = await MessageStatusFixture.create({ roots: 1 });
  const model = new LocalModel();
  const host = await fixture(model);
  const held = Promise.withResolvers<void>();
  t.after(async () => { held.resolve(); await host.ctx.fiber.dispose(); await rig.dispose(); });
  const started = Promise.withResolvers<void>();
  model.beforeResponse = async () => { started.resolve(); await held.promise; };
  host.root.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hold host' }], source: { kind: 'user' } }));
  await started.promise;
  const connections: RootConnection[] = [];
  let registration: RootRegistrationResponse | undefined;
  let loseReceipts = true;
  class FaultControlClient extends ControlClient {
    override createRootConnection(binding: RootRegistrationResponse) {
      registration ??= binding;
      const connection = super.createRootConnection(binding);
      connections.push(connection);
      return connection;
    }
    override async submitReceipt(...args: Parameters<ControlClient['submitReceipt']>) {
      if (loseReceipts) throw new Error('controlled receipt loss');
      return super.submitReceipt(...args);
    }
  }
  const control = new FaultControlClient({ stateDir: rig.stateDir });
  await host.ctx.plugin(createArloHarnessPlugin({ stateDir: rig.stateDir, groupName: 'team-status', controlClient: control }));
  const roots = await eventually(() => rig.control.listRoots(), list => list.some(root => root.endpoint_id === registration?.endpoint_id && root.deliverable));
  const receiver = roots.find(root => root.endpoint_id === registration?.endpoint_id)!;
  let insertions = 0;
  const stop = host.ctx.on('agent/inbox/inserted', ({ message }) => { if (message.source.kind === 'arlo') insertions++; });
  t.after(stop);
  const sent = await rig.roots[0]!.connection.sendMessage({ to: receiver.endpoint_id, text: 'only one insertion' });
  assert.equal(sent.status, 'unknown');
  assert.equal(insertions, 1);
  const pending = [...host.root.agent.inbox.nextTurn];
  loseReceipts = false;
  for (let index = 1; index <= 2; index++) {
    connections.at(-1)!.dispose();
    const recovered = await eventually(() => rig.control.listRoots(), list => list.some(root => root.endpoint_id === receiver.endpoint_id && root.generation === receiver.generation + index && root.deliverable));
    assert.equal(recovered.filter(root => root.endpoint_id === receiver.endpoint_id && root.deliverable).length, 1);
    assert.deepEqual(host.root.agent.inbox.nextTurn, pending);
    assert.equal(insertions, 1);
  }
  const status = await rig.roots[0]!.connection.getMessageStatus(sent.message_id);
  assert.equal(status.status, 'accepted');
  assert.equal(status.late_evidence, true);
  model.beforeResponse = undefined;
  held.resolve();
  await host.root.agent.whenIdle();
});

test('An unanswered heartbeat expires the local binding without waiting for the request', { timeout: 30000 }, async (t) => {
  const rig = await MessageStatusFixture.create({ roots: 1 });
  const host = await fixture();
  const heartbeatStarted = Promise.withResolvers<void>();
  const permitHeartbeat = Promise.withResolvers<void>();
  let connection: RootConnection | undefined;
  class HungHeartbeatClient extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      connection = super.createRootConnection(...args);
      return connection;
    }
    override async heartbeatRoot(...args: Parameters<ControlClient['heartbeatRoot']>) {
      heartbeatStarted.resolve();
      await permitHeartbeat.promise;
      return super.heartbeatRoot(...args);
    }
  }
  t.after(async () => { permitHeartbeat.resolve(); await host.ctx.fiber.dispose(); await rig.dispose(); });
  await host.ctx.plugin(createArloHarnessPlugin({
    stateDir: rig.stateDir, groupName: 'team-status',
    controlClient: new HungHeartbeatClient({ stateDir: rig.stateDir }),
    recovery: { heartbeatIntervalMs: 10, leaseDurationMs: 100, random: () => 0 },
  }));
  await heartbeatStarted.promise;
  const oldConnection = connection!;
  await new Promise(resolve => setTimeout(resolve, 200));
  await assert.rejects(oldConnection.listSessions(), { code: 'CHANNEL_NOT_READY' });
});

test('Real pending remains uncertain after reconnect and offline consumption carries the original dispatch proof', { timeout: 60000 }, async (t) => {
  const rig = await MessageStatusFixture.create({ roots: 1 });
  const model = new LocalModel();
  const host = await fixture(model);
  const held = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const rotationStarted = Promise.withResolvers<void>();
  const permitRotation = Promise.withResolvers<void>();
  t.after(async () => { held.resolve(); permitRotation.resolve(); await host.ctx.fiber.dispose(); await rig.dispose(); });
  model.beforeResponse = async () => { started.resolve(); await held.promise; };
  host.root.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hold host' }], source: { kind: 'user' } }));
  await started.promise;
  const connections: RootConnection[] = [];
  const credits: Parameters<ControlClient['releaseCredit']>[1][] = [];
  let pauseRotation = false;
  class ObservedClient extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      const connection = super.createRootConnection(...args);
      connections.push(connection);
      return connection;
    }
    override async connectRoot(...args: Parameters<ControlClient['connectRoot']>) {
      if (pauseRotation) { rotationStarted.resolve(); await permitRotation.promise; }
      return super.connectRoot(...args);
    }
    override async releaseCredit(...args: Parameters<ControlClient['releaseCredit']>) {
      const result = await super.releaseCredit(...args);
      credits.push(args[1]);
      return result;
    }
  }
  await host.ctx.plugin(createArloHarnessPlugin({ stateDir: rig.stateDir, groupName: 'team-status', controlClient: new ObservedClient({ stateDir: rig.stateDir }), recovery: { random: () => 0 } }));
  await eventually(() => rig.control.listRoots(), roots => roots.some(root => root.endpoint_id === connections[0]?.binding.endpoint_id && root.deliverable));
  const receiver = connections[0]!.binding;
  const stopFault = host.ctx.on('internal/dispatch', (_type, name) => { if (name === 'agent/inbox/inserted') throw new Error('post-insertion fault'); });
  t.after(stopFault);
  const unknown = await rig.roots[0]!.connection.sendMessage({ to: receiver.endpoint_id, text: 'uncertain real input' });
  stopFault();
  assert.equal(unknown.status, 'unknown');
  const nativeId = host.root.agent.inbox.nextTurn[0]!.id;
  connections.at(-1)!.dispose();
  await eventually(() => rig.control.listRoots(), roots => roots.some(root => root.endpoint_id === receiver.endpoint_id && root.generation === 2 && root.deliverable));
  assert.equal((await rig.roots[0]!.connection.getMessageStatus(unknown.message_id)).status, 'unknown');
  assert.equal(host.root.agent.inbox.nextTurn[0]!.id, nativeId);
  pauseRotation = true;
  connections.at(-1)!.dispose();
  await rotationStarted.promise;
  model.beforeResponse = undefined;
  held.resolve();
  await host.root.agent.whenIdle();
  assert.equal(credits.length, 0, 'Consumption while offline must wait for current authorized credentials');
  permitRotation.resolve();
  await eventually(() => rig.control.listRoots(), roots => roots.some(root => root.endpoint_id === receiver.endpoint_id && root.generation === 3 && root.deliverable));
  assert.equal(host.root.agent.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.id === nativeId).length, 1);
  assert.equal(credits.length, 1);
  assert.equal(credits[0]!.generation, 1);
  assert.equal(credits[0]!.message_id, unknown.message_id);
  assert.equal(credits[0]!.native_message_id, String(nativeId));
  assert.ok(credits[0]!.daemon_id && credits[0]!.delivery_id);
  assert.equal((await rig.roots[0]!.connection.getMessageStatus(unknown.message_id)).status, 'unknown');
});

test('A paused notification cannot insert after plugin unload', { timeout: 30000 }, async (t) => {
  const rig = await MessageStatusFixture.create({ roots: 1 });
  const host = await fixture();
  const arrived = Promise.withResolvers<void>();
  const permit = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let connection: RootConnection | undefined;
  t.after(async () => { permit.resolve(); await host.ctx.fiber.dispose(); await rig.dispose(); });
  class PausedClient extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      connection = super.createRootConnection(...args);
      const install = connection.onNotification.bind(connection);
      connection.onNotification = handler => install(async frame => {
        arrived.resolve();
        await permit.promise;
        await handler(frame);
        finished.resolve();
      });
      return connection;
    }
  }
  const fork = await host.ctx.plugin(createArloHarnessPlugin({ stateDir: rig.stateDir, groupName: 'team-status', controlClient: new PausedClient({ stateDir: rig.stateDir }) }));
  await eventually(() => rig.control.listRoots(), roots => roots.some(root => root.endpoint_id === connection?.binding.endpoint_id && root.deliverable));
  let insertions = 0;
  t.after(host.ctx.on('agent/inbox/inserted', ({ message }) => { if (message.source.kind === 'arlo') insertions++; }));
  const sent = rig.roots[0]!.connection.sendMessage({ to: connection!.binding.endpoint_id, text: 'paused input' });
  await arrived.promise;
  await fork.dispose();
  permit.resolve();
  await finished.promise;
  assert.equal((await sent).status, 'unknown');
  assert.equal(insertions, 0);
  assert.equal(host.root.agent.status, 'idle');
  assert.equal(host.root.agent.inbox.nextTurn.length, 0);
});

test('A delayed heartbeat cannot extend the lease and an overdue timer cannot admit a paused notification', { timeout: 30000 }, async t => {
  const clock = new RecoveryClock();
  const rig = await MessageStatusFixture.create({ roots: 1, leaseNow: clock.now, ackTimeoutMs: 100 });
  const host = await fixture();
  const heartbeatAccepted = Promise.withResolvers<void>();
  const heartbeatResponse = Promise.withResolvers<void>();
  const heartbeatReturned = Promise.withResolvers<void>();
  const notificationArrived = Promise.withResolvers<void>();
  const releaseNotification = Promise.withResolvers<void>();
  const notificationFinished = Promise.withResolvers<void>();
  let connection: RootConnection | undefined;
  class DelayedClient extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      connection = super.createRootConnection(...args);
      const install = connection.onNotification.bind(connection);
      connection.onNotification = handler => install(async frame => {
        notificationArrived.resolve();
        await releaseNotification.promise;
        await handler(frame);
        notificationFinished.resolve();
      });
      return connection;
    }
    override async heartbeatRoot(...args: Parameters<ControlClient['heartbeatRoot']>) {
      const response = await super.heartbeatRoot(...args);
      heartbeatAccepted.resolve();
      await heartbeatResponse.promise;
      heartbeatReturned.resolve();
      return response;
    }
  }
  t.after(async () => {
    heartbeatResponse.resolve(); releaseNotification.resolve();
    await host.ctx.fiber.dispose(); await rig.dispose();
  });
  await host.ctx.plugin(createArloHarnessPlugin({
    stateDir: rig.stateDir, groupName: 'team-status', controlClient: new DelayedClient({ stateDir: rig.stateDir }),
    recovery: clock,
  }));
  await eventually(() => rig.control.listRoots(), roots => roots.some(root => root.endpoint_id === connection?.binding.endpoint_id && root.deliverable));
  clock.advanceWithoutTimers(5000);
  clock.runDueTimers();
  await heartbeatAccepted.promise;
  clock.advanceWithoutTimers(14000);
  heartbeatResponse.resolve();
  await heartbeatReturned.promise;
  const sent = rig.roots[0]!.connection.sendMessage({ to: connection!.binding.endpoint_id, text: 'paused beyond lease' })
    .catch(() => ({ status: 'unknown' }));
  await notificationArrived.promise;
  clock.advanceWithoutTimers(6000);
  let insertions = 0;
  t.after(host.ctx.on('agent/inbox/inserted', ({ message }) => { if (message.source.kind === 'arlo') insertions++; }));
  releaseNotification.resolve();
  await notificationFinished.promise;
  assert.equal(insertions, 0, 'The final host guard must reject an expired lease even before its timer executes');
  assert.equal((await sent).status, 'unknown');
  assert.equal(host.root.agent.inbox.nextTurn.length, 0);
});

test('A readiness response arriving after its initial lease cannot reactivate the connection', { timeout: 30000 }, async t => {
  const clock = new RecoveryClock();
  const rig = await MessageStatusFixture.create({ roots: 0 });
  const host = await fixture();
  const accepted = Promise.withResolvers<void>();
  const permit = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  let disconnected = false;
  class DelayedReadyClient extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      const connection = super.createRootConnection(...args);
      connection.onDisconnect(() => { disconnected = true; });
      return connection;
    }
    override async confirmRootReady(...args: Parameters<ControlClient['confirmRootReady']>) {
      const result = await super.confirmRootReady(...args);
      accepted.resolve();
      await permit.promise;
      returned.resolve();
      return result;
    }
  }
  t.after(async () => { permit.resolve(); await host.ctx.fiber.dispose(); await rig.dispose(); });
  await host.ctx.plugin(createArloHarnessPlugin({
    stateDir: rig.stateDir, groupName: 'team-status', controlClient: new DelayedReadyClient({ stateDir: rig.stateDir }),
    recovery: clock,
  }));
  await accepted.promise;
  clock.advanceWithoutTimers(20000);
  permit.resolve();
  await returned.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(disconnected, true, 'Readiness uses its request-start deadline even when expiration timers are delayed');
  assert.equal(host.root.agent.status, 'idle');
});
