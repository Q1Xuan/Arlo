import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { ControlClient, type RootConnection } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

// Tests exact production snapshot code in a separately owned daemon process.
// SIGKILL validates process death, not power loss or storage-device guarantees.
test('actual daemon death before/after publication preserves one human control', { skip: !['linux', 'win32'].includes(process.platform), timeout: 240000 }, async t => {
  for (const phase of ['before', 'after']) await t.test(phase, async t => {
    const stateDir = createTempDir('claude-crash-');
    let child: ChildProcess | undefined, connection: RootConnection | undefined;
    async function launch() {
      child = fork(new URL('./fixtures/user-authorized-crash-daemon.ts', import.meta.url), [stateDir, phase], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let errors = ''; child.stderr?.on('data', data => { errors += String(data); });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Daemon start timeout: ${errors}`)), process.platform === 'win32' ? 60000 : 10000);
        child!.once('error', reject);
        child!.once('exit', () => { clearTimeout(timer); reject(new Error(`Daemon exited: ${errors}`)); });
        child!.once('message', message => { clearTimeout(timer); if (message === 'ready') resolve(); else reject(new Error('Not ready')); });
      });
    }
    t.after(async () => {
      connection?.dispose();
      if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'exit'); child.send('shutdown'); await closed; }
      removeTempDir(stateDir);
    });
    async function attach() {
      const control = new ControlClient({ stateDir });
      const runtime = await control.registerRuntime({ host_kind: 'claudecode' });
      const binding = await control.registerRoot(runtime.runtime_token, { root_session_id: 'crash-root', group_name: 'crash', agent_incarnation: crypto.randomUUID(), plugin_generation: 1 });
      connection = control.createRootConnection(binding, { heartbeat: false }); await connection.connect();
      await control.confirmRootReady(binding.root_token, { endpoint_id: binding.endpoint_id });
      const request = { endpoint_id: binding.endpoint_id, generation: binding.generation };
      return { control, binding, request, status: () => control.getRootSendingStatus(binding.root_token, request) };
    }
    await launch(); const original = await attach();
    await original.control.authorizeRoot(original.binding.root_token, { ...original.request, request_id: crypto.randomUUID() });
    const initial = await original.status();
    const request = { ...original.request, daemon_id: initial.daemon_id, sequence: 1, request_id: crypto.randomUUID() };
    const armed = once(child!, 'message'); child!.send('arm'); assert.equal((await armed)[0], 'armed');
    const died = once(child!, 'exit');
    const pending = original.control.continueCollaboration(original.binding.root_token, request);
    // Attach rejection handling before the daemon disappears.
    const refused = assert.rejects(pending);
    const [code, signal] = await died;
    if (process.platform === 'win32') assert.ok(code !== 0 || signal !== null, 'Forced daemon death must be unsuccessful');
    else assert.equal(signal, 'SIGKILL');
    await refused;
    connection!.dispose();
    await launch(); const resumed = await attach();
    const recovered = await resumed.status();
    assert.equal(recovered.control_sequence, phase === 'after' ? 1 : 0);
    assert.equal(recovered.remaining, phase === 'after' ? 20 : null);
    if (phase === 'before') {
      // Old epoch had no committed operation. Its old daemon identity cannot
      // authorize a fresh effect; the person must make a new explicit control.
      await assert.rejects(resumed.control.continueCollaboration(resumed.binding.root_token, { ...request, ...resumed.request }), { code: 'STALE_GENERATION' });
      const fresh = await resumed.control.continueCollaboration(resumed.binding.root_token, { ...request, ...resumed.request, daemon_id: recovered.daemon_id, request_id: crypto.randomUUID() });
      assert.equal(fresh.remaining, 20);
    } else {
      const replay = await resumed.control.continueCollaboration(resumed.binding.root_token, { ...request, ...resumed.request });
      assert.equal(replay.period_id, recovered.period_id); assert.equal(replay.control_sequence, 1);
    }
  });
});
