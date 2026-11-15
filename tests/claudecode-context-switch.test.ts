import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeCodeSidecar, type ClaudeModToolHost } from '../packages/adapter-claudecode/src/index.ts';
import { register } from '../packages/adapter-claudecode/mod/hooks/register.js';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';
import { createTempDir, durableStatus, removeTempDir } from './test-utils.ts';

async function until<T>(read: () => T | Promise<T>, label: string): Promise<Exclude<T, false | null | undefined>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value as Exclude<T, false | null | undefined>;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('shipped Mod rotates the Daemon endpoint on clear without session.start and fences the old handoff', { timeout: 60_000 }, async (t) => {
  const fixture = await MessageStatusFixture.create({ roots: 1, groupName: 'cc-context-switch' });
  t.after(() => fixture.dispose());
  await fixture.control.updateRuntimeParticipation(fixture.runtimeToken, true);
  const storageDir = createTempDir('cc-context-switch');
  t.after(() => removeTempDir(storageDir));
  const sidecar = new ClaudeCodeSidecar({
    sessionId: 'before-clear', groupName: 'cc-context-switch', stateDir: storageDir,
    controlClient: fixture.control, crossHostEnabled: true, cwd: storageDir,
  });
  await sidecar.start();
  t.after(() => sidecar.stop());
  let sessionId = 'before-clear';
  const timers: Array<{ cancelled: boolean; callback: () => void }> = [];
  const submitted: string[] = [];
  const diagnostics: string[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<{ drop: string }>();
  t.after(() => release.resolve({ drop: 'test cleanup' }));
  const host: ClaudeModToolHost = {
    command: { register: async definition => ({ command: definition.name }) },
    tool: { register: async definition => ({ tool: `mcp__arlo-adapter-claudecode__${definition.name}` }) },
    session: { id: async () => sessionId },
    env: { get: async name => name.endsWith('_URL') ? sidecar.url : sidecar.token },
    http: { fetch: async (url, init) => {
      const response = await fetch(url, init);
      return { ok: response.ok, status: response.status, headers: {}, text: await response.text() };
    } },
    ui: { log: text => { diagnostics.push(text); } },
    prompt: { submit: async input => {
      submitted.push(input.text);
      if (submitted.length === 1) { entered.resolve(); return release.promise; }
      return { drop: 'completed fixture handoff' };
    } },
    clock: {
      now: async () => Date.now(),
      every: (_delay, callback) => {
        const timer = { cancelled: false, callback }; timers.push(timer);
        return { cancel: () => { timer.cancelled = true; } };
      },
      after: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return { cancel: () => clearTimeout(timer) };
      },
    },
  };
  type Hook = Parameters<Parameters<typeof register>[0]>[1];
  const hooks = new Map<string, Hook>();
  register((name, hook) => { hooks.set(name, hook); return { catch() {} }; });
  const next = async (event: unknown) => event;
  await hooks.get('session.start')!(host, {}, next);
  await sidecar.waitForReady();
  const sender = fixture.roots[0]!;
  const oldEndpoint = await until(async () => (await fixture.control.listRoots())
    .find(root => root.endpoint_id !== sender.registration.endpoint_id && root.ready && root.deliverable), 'original endpoint');
  const originalRoot = sidecar.host.roots()[0]!;
  await sidecar.runtime!.initializeRootSending(originalRoot);
  const allowanceBeforeReload = await sidecar.runtime!.getRootSendingStatus(originalRoot);
  await hooks.get('session.start')!(host, {}, next);
  assert.equal(sidecar.host.roots()[0], originalRoot);
  assert.deepEqual(await sidecar.runtime!.getRootSendingStatus(originalRoot), allowanceBeforeReload);
  assert.equal((await fixture.control.listRoots()).filter(root => root.endpoint_id !== sender.registration.endpoint_id && root.status !== 'revoked').length, 1);
  const first = await sender.connection.sendMessage({ to: oldEndpoint.endpoint_id, text: 'old handoff' });
  const queued = await sender.connection.sendMessage({ to: oldEndpoint.endpoint_id, text: 'old queued input' });
  assert.equal(first.status, 'accepted');
  assert.equal(queued.status, 'accepted');
  timers.find(timer => !timer.cancelled)!.callback();
  await entered.promise;
  await hooks.get('session.end')!(host, { reason: 'clear', sessionId: 'before-clear' } as Parameters<Hook>[1], async event => {
    sessionId = 'after-clear';
    return event;
  });
  await until(() => sidecar.sessionId === 'after-clear', 'new verified context').catch(error => { throw new Error(`${error}: ${diagnostics.join('; ')}`); });
  await sidecar.waitForReady();
  const newEndpoint = await until(async () => {
    const roots = await fixture.control.listRoots();
    return roots.find(root => root.endpoint_id === oldEndpoint.endpoint_id)?.status === 'revoked' && roots
      .find(root => root.endpoint_id !== sender.registration.endpoint_id && root.endpoint_id !== oldEndpoint.endpoint_id && root.ready && root.deliverable);
  }, 'old endpoint retirement and new endpoint');
  assert.notEqual(newEndpoint.endpoint_id, oldEndpoint.endpoint_id);
  assert.equal(durableStatus(storageDir, 'before-clear', first.message_id), 'unknown');
  assert.equal(durableStatus(storageDir, 'before-clear', queued.message_id), 'discarded');
  release.resolve({ drop: 'late refusal from old host call' });
  const fresh = await sender.connection.sendMessage({ to: newEndpoint.endpoint_id, text: 'new context input' });
  assert.equal(fresh.status, 'accepted');
  timers.find(timer => !timer.cancelled)!.callback();
  await until(() => submitted.length === 2, 'new context handoff');
  assert.match(submitted[0]!, /old handoff/);
  assert.match(submitted[1]!, /new context input/);
  assert.equal(durableStatus(storageDir, 'before-clear', first.message_id), 'unknown');
  assert.equal(timers.filter(timer => !timer.cancelled).length, 1);
  await hooks.get('session.end')!(host, { reason: 'exit', sessionId } as Parameters<Hook>[1], next);
});
