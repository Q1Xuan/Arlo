import { AuthorizedControlClient as ControlClient } from './helpers/authorized-control.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ArloDaemon } from '@arlo/daemon';
import { DaemonClient, ArloErrorCode, type ArloMessageNotificationParams, type RootRegistrationResponse } from '@arlo/sdk';
import { createArloHarnessPlugin, fixture } from './helpers/authorized-dsh-fixture.ts';
import { LocalModel } from '../probes/fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Communication condition was not met');
}

async function invoke(host: Awaited<ReturnType<typeof fixture>>, name: string, args = {}) {
  const id = ToolCallId(crypto.randomUUID());
  const argumentsText = JSON.stringify(args);
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
  host.model.script.push(chunks);
  host.root.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run communication tool' }], source: { kind: 'arlo', form: 'relay' } }));
  await host.root.agent.whenIdle();
  const event = host.root.agent.session.snapshotEvents().find(
    (entry: any) => entry.type === 'tool/result' && entry.data.message.toolCallId === id
  ) as any;
  assert.ok(event, 'Host records the communication tool result');
  const text = event.data.message.content[0].text;
  return event.data.message.isError ? { error: text } : JSON.parse(text);
}

test('Harness uses immutable session creation directory and freezes late confirmed Workspace changes', async () => {
  const stateDir = createTempDir('adapter-project-state');
  const project = createTempDir('adapter-project');
  const otherProject = createTempDir('adapter-other-project');
  const daemon = new ArloDaemon({ stateDir });
  const first = await fixture();
  const second = await fixture();
  let lateWorkspace: string | undefined;
  try {
    await daemon.start();
    await first.root.dispose();
    first.root = await first.ctx.agents.create({
      sessionId: SessionId('project-root'), meta: { cwd: project },
      agentOptions: { provider: 'arlo-local', model: 'scripted' },
    });
    await first.ctx.plugin(createArloHarnessPlugin({ stateDir, getConfirmedWorkspaceDirectory: () => lateWorkspace }));
    await second.ctx.plugin(createArloHarnessPlugin({ stateDir, getConfirmedWorkspaceDirectory: () => project }));
    const diagnostic = new DaemonClient({ stateDir });
    await waitFor(() => diagnostic.listRoots(), roots => roots.filter(root => root.ready).length === 2);
    const peers = await invoke(first, 'arlo_list_sessions');
    assert.equal(peers.length, 1);
    lateWorkspace = otherProject;
    assert.deepEqual(await invoke(first, 'arlo_list_sessions'), peers);
    const sent = await invoke(first, 'arlo_send_message', { to: peers[0].endpoint_id, text: 'frozen project delivery' });
    assert.equal(sent.status, 'accepted');
    await second.root.agent.whenIdle();
    assert.ok(JSON.stringify(second.root.agent.session.snapshotEvents()).includes('frozen project delivery'));
  } finally {
    await first.dispose();
    await second.dispose();
    await daemon.stop();
    removeTempDir(otherProject);
    removeTempDir(project);
    removeTempDir(stateDir);
  }
});

test('Trusted explicit switch replaces the endpoint and its discoverability before joining the new group', async () => {
  const stateDir = createTempDir('adapter-switch-state');
  const daemon = new ArloDaemon({ stateDir });
  const switching = await fixture();
  const previousPeer = await fixture();
  const nextPeer = await fixture();
  const revocationStarted = Promise.withResolvers<void>();
  const permitRevocation = Promise.withResolvers<void>();
  let oldHandler: ((frame: ArloMessageNotificationParams) => void | Promise<void>) | undefined;
  let oldFrame: ArloMessageNotificationParams | undefined;
  class DelayedControlClient extends ControlClient {
    override createRootConnection(registration: RootRegistrationResponse) {
      const connection = super.createRootConnection(registration);
      const install = connection.onNotification.bind(connection);
      connection.onNotification = handler => {
        oldHandler ??= handler;
        return install(frame => { oldFrame ??= frame; return handler(frame); });
      };
      return connection;
    }
    override async revokeRoot(token: string, request: Parameters<ControlClient['revokeRoot']>[1]) {
      revocationStarted.resolve();
      await permitRevocation.promise;
      return super.revokeRoot(token, request);
    }
  }
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir, groupName: 'previous', controlClient: new DelayedControlClient({ stateDir }) });
    await switching.ctx.plugin(plugin);
    await previousPeer.ctx.plugin(createArloHarnessPlugin({ stateDir, groupName: 'previous' }));
    await nextPeer.ctx.plugin(createArloHarnessPlugin({ stateDir, groupName: 'next' }));
    const diagnostic = new DaemonClient({ stateDir });
    await waitFor(() => diagnostic.listRoots(), roots => roots.filter(root => root.ready).length === 3);
    const oldEndpoint = (await invoke(previousPeer, 'arlo_list_sessions'))[0].endpoint_id;
    assert.equal((await invoke(previousPeer, 'arlo_send_message', { to: oldEndpoint, text: 'old group input' })).status, 'accepted');
    await switching.root.agent.whenIdle();
    const transition = plugin.switchGroup(switching.root.agent, 'next');
    await revocationStarted.promise;
    assert.deepEqual(await invoke(nextPeer, 'arlo_list_sessions'), [], 'New membership waits for completed revocation');
    permitRevocation.resolve();
    await transition;
    assert.deepEqual(await invoke(previousPeer, 'arlo_list_sessions'), []);
    const newEndpoint = (await invoke(nextPeer, 'arlo_list_sessions'))[0].endpoint_id;
    assert.notEqual(newEndpoint, oldEndpoint);
    assert.ok(oldHandler && oldFrame);
    await oldHandler(oldFrame);
    const staleSend = await invoke(previousPeer, 'arlo_send_message', { to: oldEndpoint, text: 'stale target' });
    assert.match(staleSend.error, /TARGET_UNAVAILABLE/);
    const accepted = await invoke(nextPeer, 'arlo_send_message', { to: newEndpoint, text: 'new group delivery' });
    assert.equal(accepted.status, 'accepted');
    await switching.root.agent.whenIdle();
    const events = JSON.stringify(switching.root.agent.session.snapshotEvents());
    assert.ok(events.includes('new group delivery'));
    assert.ok(!events.includes('stale target'));
    assert.equal(switching.root.agent.session.snapshotEvents().filter((event: any) =>
      event.type === 'user/message' && event.data.content?.[0]?.text === 'old group input').length, 1,
    'A captured old notification callback cannot replay input after replacement');
    await assert.rejects(plugin.switchGroup(switching.child.agent, 'previous'), { code: ArloErrorCode.CALLER_NOT_ROOT });
  } finally {
    permitRevocation.resolve();
    await switching.dispose();
    await previousPeer.dispose();
    await nextPeer.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('Missing trusted directory never uses process cwd and can recover through explicit user group selection', async () => {
  const stateDir = createTempDir('adapter-no-context');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir });
    await host.ctx.plugin(plugin);
    assert.match((await invoke(host, 'arlo_list_sessions')).error, /GROUP_CONTEXT_REQUIRED/);
    const diagnostic = new DaemonClient({ stateDir });
    assert.deepEqual(await diagnostic.listRoots(), []);
    await plugin.switchGroup(host.root.agent, 'user-selected');
    assert.deepEqual(await invoke(host, 'arlo_list_sessions'), []);
    assert.equal((await diagnostic.listRoots()).filter(root => root.ready).length, 1);
  } finally {
    await host.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
