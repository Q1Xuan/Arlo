import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, DaemonClient, ArloErrorCode } from '@arlo/sdk';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { fixture } from '../probes/fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

async function ready(client: DaemonClient, count: number): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    if ((await client.listRoots()).filter(root => root.deliverable).length === count) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Registered roots did not become discoverable');
}

test('DSH display aliases preserve same-host contact discovery', async () => {
  const stateDir = createTempDir('dsh-participation-alias');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  const remote = await fixture();
  try {
    await daemon.start();
    const localPlugin = createArloHarnessPlugin({ stateDir, groupName: 'contacts', autoStart: false });
    const remotePlugin = createArloHarnessPlugin({
      stateDir, groupName: 'contacts', autoStart: false, hostType: 'Custom DSH display name',
    });
    await host.ctx.plugin(localPlugin);
    await remote.ctx.plugin(remotePlugin);
    await ready(new DaemonClient({ stateDir }), 2);

    const contacts = await localPlugin.listContactSessions(host.root.agent);
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].host_type, 'Custom DSH display name');
    assert.equal(contacts[0].host_kind, 'deepseek-harness');
    const reverse = await remotePlugin.listContactSessions(remote.root.agent);
    assert.equal(reverse.length, 1);
    assert.equal(reverse[0].host_kind, 'deepseek-harness');
  } finally {
    await host.ctx.fiber.dispose();
    await remote.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('A remote root publishes its first title, renames and clears it without changing its endpoint or sending input', async () => {
  const stateDir = createTempDir('contact-title-refresh');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  const remote = await fixture();
  let title: string | undefined;
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir, groupName: 'contacts' });
    await host.ctx.plugin(plugin);
    await remote.ctx.plugin(createArloHarnessPlugin({
      stateDir, groupName: 'contacts', getSessionTitle: () => title,
      recovery: { heartbeatIntervalMs: 30 },
    }));
    await ready(new DaemonClient({ stateDir }), 2);
    const [initial] = await plugin.listContactSessions(host.root.agent);
    assert.ok(initial);
    assert.equal(initial.display_name, undefined);
    for (const nextTitle of ['First title', 'Renamed remote root', '界'.repeat(1400), undefined]) {
      title = nextTitle;
      const expectedTitle = nextTitle?.startsWith('界') ? '界'.repeat(1365) : nextTitle;
      let contacts = await plugin.listContactSessions(host.root.agent);
      for (let attempt = 0; attempt < 100 && contacts[0]?.display_name !== expectedTitle; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        contacts = await plugin.listContactSessions(host.root.agent);
      }
      assert.equal(contacts.length, 1);
      assert.equal(contacts[0].display_name, expectedTitle);
      assert.equal(contacts[0].endpoint_id, initial.endpoint_id);
      assert.equal(contacts[0].deliverable, true);
    }
    assert.equal(host.model.requests.length + remote.model.requests.length, 0);
  } finally {
    await host.ctx.fiber.dispose();
    await remote.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('Host contact discovery uses the exact root identity and publishes titles without sending messages', async () => {
  const stateDir = createTempDir('harness-contacts');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  const remote = await fixture();
  const otherGroup = await fixture();
  const titles = new WeakMap<Agent, string>();
  try {
    await daemon.start();
    const localPeer = await host.ctx.agents.create({
      sessionId: SessionId('local-contact'), agentOptions: { provider: 'arlo-local', model: 'scripted' },
    });
    const untitledPeer = await host.ctx.agents.create({
      sessionId: SessionId('untitled-contact'), agentOptions: { provider: 'arlo-local', model: 'scripted' },
    });
    titles.set(localPeer.agent, 'Shared title');
    const plugin = createArloHarnessPlugin({ stateDir, groupName: 'contacts', getSessionTitle: agent => titles.get(agent) });
    await host.ctx.plugin(plugin);
    await remote.ctx.plugin(createArloHarnessPlugin({ stateDir, groupName: 'contacts', getSessionTitle: () => 'Shared title' }));
    await otherGroup.ctx.plugin(createArloHarnessPlugin({ stateDir, groupName: 'elsewhere' }));
    const diagnostic = new DaemonClient({ stateDir });
    await ready(diagnostic, 5);

    const contacts = await plugin.listContactSessions(host.root.agent);
    assert.equal(contacts.length, 3, 'Only the other deliverable roots in this communication group are contacts');
    assert.equal(new Set(contacts.map(contact => contact.endpoint_id)).size, 3);
    assert.equal(contacts.filter(contact => contact.display_name === 'Shared title').length, 2,
      'Same titles, and equal SessionIds in different registries, never collapse endpoint identities');
    assert.equal(contacts.filter(contact => contact.display_name === undefined).length, 1);
    assert.ok(contacts.every(contact => contact.deliverable));
    assert.equal(host.model.requests.length + remote.model.requests.length, 0, 'Discovery itself does not contact a model or enqueue input');
    await assert.rejects(plugin.listContactSessions(host.child.agent), { code: ArloErrorCode.CALLER_NOT_ROOT });
    await assert.rejects(plugin.listContactSessions(remote.root.agent), { code: ArloErrorCode.CALLER_NOT_ROOT });

    titles.set(localPeer.agent, 'Renamed local contact');
    const renamed = await plugin.listContactSessions(host.root.agent);
    const localEndpoint = renamed.find(contact => contact.display_name === 'Renamed local contact')!.endpoint_id;
    assert.ok(contacts.some(contact => contact.endpoint_id === localEndpoint), 'A local title change keeps the exact address');
    await untitledPeer.dispose();
    await ready(diagnostic, 4);
    assert.equal((await plugin.listContactSessions(host.root.agent)).length, 2);
  } finally {
    await host.ctx.fiber.dispose();
    await remote.ctx.fiber.dispose();
    await otherGroup.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('A host contact query cannot return an old binding after a group switch or plugin reload', async () => {
  const stateDir = createTempDir('harness-contact-lifecycle');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  const peer = await fixture();
  let pause: { started: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | undefined;
  class PausedDiscovery extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      const connection = super.createRootConnection(...args);
      const list = connection.listSessions.bind(connection);
      connection.listSessions = async () => {
        const content = await list();
        const currentPause = pause;
        if (currentPause) {
          currentPause.started.resolve();
          await currentPause.release.promise;
        }
        return content;
      };
      return connection;
    }
  }
  try {
    await daemon.start();
    const diagnostic = new DaemonClient({ stateDir });
    const plugin = createArloHarnessPlugin({ stateDir, groupName: 'contacts', controlClient: new PausedDiscovery({ stateDir }) });
    const loaded = await host.ctx.plugin(plugin);
    await peer.ctx.plugin(createArloHarnessPlugin({ stateDir, groupName: 'contacts' }));
    await ready(diagnostic, 2);
    pause = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const beforeSwitch = assert.rejects(plugin.listContactSessions(host.root.agent), { code: ArloErrorCode.CHANNEL_NOT_READY });
    await pause.started.promise;
    await plugin.switchGroup(host.root.agent, 'another-group');
    pause.release.resolve();
    await beforeSwitch;
    pause = undefined;
    assert.deepEqual(await plugin.listContactSessions(host.root.agent), []);

    pause = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const beforeUnload = assert.rejects(plugin.listContactSessions(host.root.agent), { code: ArloErrorCode.CHANNEL_NOT_READY });
    await pause.started.promise;
    await loaded.dispose();
    await assert.rejects(plugin.listContactSessions(host.root.agent), { code: ArloErrorCode.CALLER_NOT_ROOT });
    await host.ctx.plugin(plugin);
    await ready(diagnostic, 2);
    pause.release.resolve();
    await beforeUnload;
    pause = undefined;
    assert.equal((await plugin.listContactSessions(host.root.agent)).length, 1, 'A new load owns only its fresh registration');
  } finally {
    pause?.release.resolve();
    await host.ctx.fiber.dispose();
    await peer.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
