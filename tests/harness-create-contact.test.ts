import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, DaemonClient, ArloError, ArloErrorCode } from '@arlo/sdk';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { fixture } from '../probes/fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('Explicit Host creation inherits the current communication group before becoming a ready contact', async () => {
  const stateDir = createTempDir('create-contact');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir, groupName: 'ordinary-default' });
    await host.ctx.plugin(plugin);
    await plugin.switchGroup(host.root.agent, 'explicit-current');
    let created = 0;
    const contact = await plugin.createContactSession(host.root.agent, async sessionId => {
      created++;
      return (await host.ctx.agents.create({
        sessionId: SessionId(sessionId),
        agentOptions: { provider: 'arlo-local', model: 'scripted' },
      })).agent;
    }, new AbortController().signal);
    assert.equal(created, 1);
    assert.equal(contact.deliverable, true);
    assert.deepEqual(await plugin.listContactSessions(host.root.agent), [contact]);
    const roots = await new DaemonClient({ stateDir }).listRoots();
    assert.equal(roots.length, 2);
    assert.equal(roots[0].group_id, roots[1].group_id);
    assert.equal(host.model.requests.length, 0, 'Creation does not send user text or call a model');
    assert.equal(host.ctx.agents.roots().length, 2, 'B is an independent root');
  } finally {
    await host.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('A first preparation failure rejects the explicit submission without retrying creation or removing B', async () => {
  const stateDir = createTempDir('create-contact-failure');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  let rejectNewRoot = false;
  class FailingControl extends ControlClient {
    override async registerRoot(token: string, request: Parameters<ControlClient['registerRoot']>[1]) {
      if (rejectNewRoot) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      return super.registerRoot(token, request);
    }
  }
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir, groupName: 'initial', controlClient: new FailingControl({ stateDir }) });
    await host.ctx.plugin(plugin);
    await plugin.switchGroup(host.root.agent, 'current');
    rejectNewRoot = true;
    let created = 0;
    await assert.rejects(plugin.createContactSession(host.root.agent, async identity => {
      created++;
      return (await host.ctx.agents.create({
        sessionId: SessionId(identity), agentOptions: { provider: 'arlo-local', model: 'scripted' },
      })).agent;
    }, new AbortController().signal), { code: ArloErrorCode.CHANNEL_NOT_READY });
    assert.equal(created, 1);
    assert.equal(host.ctx.agents.roots().length, 2);
    assert.equal(host.model.requests.length, 0);
  } finally {
    await host.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('A cancelled Host publication does not refresh or register shared communication', async () => {
  const stateDir = createTempDir('create-contact-cancelled-publication');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  const sessionId = SessionId('cancelled-before-arlo-registration');
  const controller = new AbortController();
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const accesses = { refreshes: 0, rootRegistrations: 0 };
  let pending: ReturnType<typeof host.ctx.agents.create> | undefined;
  class TrackingControl extends ControlClient {
    override refreshConnection() {
      accesses.refreshes++;
      return super.refreshConnection();
    }
    override async registerRoot(token: string, request: Parameters<ControlClient['registerRoot']>[1]) {
      accesses.rootRegistrations++;
      return super.registerRoot(token, request);
    }
  }
  try {
    await daemon.start();
    // The real Host dispatch reaches this gate before Arlo's creation listener.
    host.ctx.on('agent/created', async ({ agent, signal }) => {
      if (agent.session.id !== sessionId) return undefined;
      assert.ok(signal, 'Host publication carries the creation cancellation signal');
      entered.resolve(signal);
      await release.promise;
      return undefined;
    });
    const plugin = createArloHarnessPlugin({
      stateDir, groupName: 'initial', controlClient: new TrackingControl({ stateDir }),
    });
    await host.ctx.plugin(plugin);
    await plugin.switchGroup(host.root.agent, 'contacts');
    const diagnostic = new DaemonClient({ stateDir });
    const beforeRoots = (await diagnostic.listRoots()).filter(root => root.status === 'registered');
    assert.equal(beforeRoots.length, 1);
    assert.equal(beforeRoots[0].deliverable, true);
    assert.deepEqual(await plugin.listContactSessions(host.root.agent), []);
    const beforeAccesses = { ...accesses };
    assert.ok(beforeAccesses.refreshes > 0 && beforeAccesses.rootRegistrations > 0,
      'The original root became ready through the real control client');

    let laterPublicationSignal: AbortSignal | undefined;
    host.ctx.on('agent/created', ({ agent, signal }) => {
      if (agent.session.id === sessionId) laterPublicationSignal = signal;
      return undefined;
    });
    pending = host.ctx.agents.create({
      sessionId, signal: controller.signal,
      agentOptions: { provider: 'arlo-local', model: 'scripted' },
    });
    void pending.catch(() => {});
    const publicationSignal = await entered.promise;
    assert.equal(publicationSignal.aborted, false);
    assert.equal(host.ctx.agents.roots().length, 2, 'The pending root has entered the real Host registry');
    assert.deepEqual(accesses, beforeAccesses, 'The gate precedes Arlo registration');
    controller.abort();
    assert.equal(publicationSignal.aborted, true);
    release.resolve();
    await assert.rejects(pending, error => error === controller.signal.reason);

    assert.equal(laterPublicationSignal, publicationSignal, 'Cancellation preserves subsequent Host creation listeners');
    assert.equal(host.ctx.agents.get(sessionId), undefined, 'Host cancellation rolls back the pending root');
    assert.deepEqual(host.ctx.agents.roots(), [host.root.agent]);
    const afterRoots = (await diagnostic.listRoots()).filter(root => root.status === 'registered');
    assert.deepEqual(afterRoots.map(root => [root.endpoint_id, root.deliverable]),
      beforeRoots.map(root => [root.endpoint_id, root.deliverable]), 'The original root remains discoverable');
    assert.deepEqual(await plugin.listContactSessions(host.root.agent), []);
    assert.deepEqual(accesses, beforeAccesses, 'Cancelled publication does not access shared communication');
    assert.equal(host.model.requests.length, 0, 'Cancellation never sends input or invokes a model');
  } finally {
    controller.abort();
    release.resolve();
    await pending?.catch(() => {});
    await host.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('Cancelling readiness retains the published root and never returns it as a ready contact', async () => {
  const stateDir = createTempDir('create-contact-cancel');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let pause = false;
  class PausedControl extends ControlClient {
    override async confirmRootReady(token: string, request: Parameters<ControlClient['confirmRootReady']>[1]) {
      if (pause) { started.resolve(); await release.promise; }
      return super.confirmRootReady(token, request);
    }
  }
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir, groupName: 'initial', controlClient: new PausedControl({ stateDir }) });
    await host.ctx.plugin(plugin);
    await plugin.switchGroup(host.root.agent, 'current');
    pause = true;
    const controller = new AbortController();
    const pending = plugin.createContactSession(host.root.agent, async identity => (
      await host.ctx.agents.create({ sessionId: SessionId(identity), agentOptions: { provider: 'arlo-local', model: 'scripted' } })
    ).agent, controller.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await started.promise;
    assert.equal(host.ctx.agents.roots().length, 2);
    assert.deepEqual(await plugin.listContactSessions(host.root.agent), []);
    controller.abort();
    await rejected;
    assert.equal(host.ctx.agents.roots().length, 2, 'Cancellation does not roll back a normal published Session');
  } finally {
    release.resolve();
    await host.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('A source group change during Host creation cannot hand A an obsolete target', async () => {
  const stateDir = createTempDir('create-contact-source-change');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir, groupName: 'initial' });
    await host.ctx.plugin(plugin);
    await plugin.switchGroup(host.root.agent, 'before');
    await assert.rejects(plugin.createContactSession(host.root.agent, async identity => {
      const result = await host.ctx.agents.create({
        sessionId: SessionId(identity), agentOptions: { provider: 'arlo-local', model: 'scripted' },
      });
      await plugin.switchGroup(host.root.agent, 'after');
      return result.agent;
    }, new AbortController().signal), { code: ArloErrorCode.CHANNEL_NOT_READY });
    assert.equal(host.ctx.agents.roots().length, 2);
    assert.deepEqual(await plugin.listContactSessions(host.root.agent), []);
    assert.equal(host.model.requests.length, 0);
  } finally {
    await host.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
