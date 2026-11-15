import { AuthorizedControlClient as ControlClient } from './helpers/authorized-control.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { ArloDaemon } from '@arlo/daemon';
import {
  createPinnedHttpsAgent, readDiscoveryRecord, sendSecureArloRequest,
  validateExplicitGroupName, type RootRegistrationRequest, type RootConnection,
} from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('one Runtime cannot register the same Root Session into two Communication Groups', async () => {
  const stateDir = createTempDir('single-group');
  const daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    const control = new ControlClient({ stateDir });
    const runtime = await control.registerRuntime();
    const root: RootRegistrationRequest = {
      root_session_id: 'same-root', agent_incarnation: 'same-agent',
      plugin_generation: 1, group_name: 'first-group',
    };
    const first = await control.registerRoot(runtime.runtime_token, root);
    await assert.rejects(
      control.registerRoot(runtime.runtime_token, { ...root, group_name: 'second-group' }),
      { code: 'BINDING_MISMATCH' },
    );
    assert.equal((await control.listRoots(runtime.runtime_token)).filter(r => r.status === 'registered').length, 1);
    await control.revokeRoot(first.root_token, { endpoint_id: first.endpoint_id });
    const second = await control.registerRoot(runtime.runtime_token, { ...root, group_name: 'second-group' });
    assert.notEqual(second.endpoint_id, first.endpoint_id);
    assert.equal((await control.listRoots(runtime.runtime_token)).filter(r => r.status === 'registered').length, 1);
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('trusted registration rejects absent context, ambiguous groups and invalid project identity categories', async () => {
  const stateDir = createTempDir('group-selection');
  const daemon = new ArloDaemon({ stateDir });
  let agent: ReturnType<typeof createPinnedHttpsAgent> | undefined;
  try {
    const { port } = await daemon.start();
    const control = new ControlClient({ stateDir });
    const runtime = await control.registerRuntime();
    const root = { root_session_id: 'root', agent_incarnation: 'agent', plugin_generation: 1 };
    await assert.rejects(control.registerRoot(runtime.runtime_token, root), { code: 'GROUP_CONTEXT_REQUIRED' });
    agent = createPinnedHttpsAgent(readDiscoveryRecord(stateDir).cert_pem);
    for (const selection of [
      {},
      { group_name: 'team', project_group_id: `grp_v1_dir_${'a'.repeat(64)}` },
      { project_group_id: validateExplicitGroupName('team').groupId },
      { project_group_id: `grp_v2_git_${'a'.repeat(64)}` },
      { project_group_id: 'private-path-canary' },
      { project_group_id: [`grp_v1_git_${'a'.repeat(64)}`] },
    ]) {
      const response = await sendSecureArloRequest({
        url: `https://127.0.0.1:${port}/control/v1/roots/register`, agent,
        token: runtime.runtime_token, method: 'POST', body: JSON.stringify({ ...root, ...selection }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(JSON.parse(response.body), { error: 'INVALID_ARGUMENT' });
    }
    assert.deepEqual(await control.listRoots(runtime.runtime_token), []);
  } finally {
    agent?.destroy();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('SDK registers frozen directory defaults and only discovers and delivers within that group', async () => {
  const stateDir = createTempDir('default-group');
  const project = path.join(stateDir, 'private-project-canary');
  fs.mkdirSync(project);
  const daemon = new ArloDaemon({ stateDir });
  const connections: RootConnection[] = [];
  try {
    await daemon.start();
    const control = new ControlClient({ stateDir });
    const runtime = await control.registerRuntime();
    const register = async (id: string, selection: object) => {
      const root = await control.registerRoot(runtime.runtime_token, {
        root_session_id: id, agent_incarnation: id, plugin_generation: 1, ...selection,
      } as RootRegistrationRequest);
      const connection = control.createRootConnection(root);
      connections.push(connection);
      const received: string[] = [];
      connection.onNotification(async frame => {
        received.push(frame.text);
        await control.submitReceipt(root.root_token, {
          endpoint_id: root.endpoint_id, daemon_id: frame.daemon_id, message_id: frame.message_id,
          delivery_id: frame.delivery_id, generation: frame.target_generation,
          status: 'enqueued', native_message_id: `native-${received.length}`,
        });
      });
      await connection.connect();
      await control.confirmRootReady(root.root_token, { endpoint_id: root.endpoint_id });
      return { root, connection, received };
    };
    const context = { sessionCwd: project };
    const first = await register('first', { project_context: context });
    const second = await register('second', { project_context: context });
    const explicit = await register('explicit', { group_name: 'private-project-canary', project_context: context });
    context.sessionCwd = stateDir;
    const discovered = JSON.parse((await first.connection.listSessions())[0].text);
    assert.deepEqual(discovered.map((r: { endpoint_id: string }) => r.endpoint_id), [second.root.endpoint_id]);
    assert.equal((await first.connection.sendMessage({ to: second.root.endpoint_id, text: 'same default' })).status, 'accepted');
    assert.deepEqual(second.received, ['same default']);
    await assert.rejects(first.connection.sendMessage({ to: explicit.root.endpoint_id, text: 'cross group' }), { code: 'GROUP_MISMATCH' });
    assert.deepEqual(explicit.received, []);
    const log = fs.readFileSync(path.join(stateDir, 'daemon.log'), 'utf8');
    assert.ok(!log.includes(project));
    assert.ok(!log.includes('private-project-canary'));
  } finally {
    for (const connection of connections) connection.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
