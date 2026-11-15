import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAdapterRuntime, type AdapterHost, type PendingInput } from '@arlo/adapter-sdk';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, type RootConnection, type RootRegistrationResponse } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';
import { fixtureRootEvidence } from './helpers/host-continuation-fixture.ts';

// A small host with opaque object identity and an authoritative pending queue.
// No DSH object layout, host-specific event name, or runtime internals are used.
function rootsFixture(stateDir?: string) {
  type Root = { id: string; instance: string; pending: PendingInput[]; received: string[] };
  const roots: Root[] = [];
  const created = new Set<(root: Root) => void>();
  const disposed = new Set<(root: Root) => void>();
  const host: AdapterHost<Root> = {
    roots: () => roots,
    sessionId: root => root.id,
    sessionCwd: () => undefined,
    ...(stateDir === undefined ? {} : { rootConfigurationEvidence: fixtureRootEvidence(stateDir) }),
    onCreated: listener => { created.add(listener); return () => { created.delete(listener); }; },
    onDisposed: listener => { disposed.add(listener); return () => { disposed.delete(listener); }; },
    reception: root => ({
      instanceId: root.instance,
      snapshot: scope => ({ ...scope, complete: true, pending: [...root.pending], inFlight: [] }),
      prepare: frame => {
        const nativeMessageId = `native-${frame.message_id}`;
        return { nativeMessageId, enqueue: () => {
          root.received.push(frame.text);
          root.pending.push({ nativeMessageId, messageId: frame.message_id,
            textBytes: Buffer.byteLength(frame.text), dispatch: {
              daemon_id: frame.daemon_id, endpoint_id: frame.to_endpoint,
              message_id: frame.message_id, delivery_id: frame.delivery_id,
              generation: frame.target_generation,
            } });
          return 'enqueued' as const;
        } };
      },
    }),
  };
  function add(id: string): Root {
    const root = { id, instance: crypto.randomUUID(), pending: [], received: [] };
    roots.push(root);
    for (const listener of created) listener(root);
    return root;
  }
  function remove(root: Root): void {
    roots.splice(roots.indexOf(root), 1);
    for (const listener of disposed) listener(root);
  }
  return { host, add, remove };
}

async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await read(); if (matches(value)) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Public adapter did not reach the expected lifecycle state');
}
const result = (content: { text: string }[]) => JSON.parse(content[0]!.text);

test('a missing Node promise capability prevents adapter registration with a runtime diagnostic', t => {
  const descriptor = Object.getOwnPropertyDescriptor(Promise, 'withResolvers')!;
  Reflect.deleteProperty(Promise, 'withResolvers');
  t.after(() => Object.defineProperty(Promise, 'withResolvers', descriptor));
  const fixture = rootsFixture();
  assert.throws(() => createAdapterRuntime({ host: fixture.host, hostType: 'Pi', hostVersion: '1.1.0' }),
    error => error instanceof Error && /UNSUPPORTED_PROFILE/.test(error.message) &&
      error.message.includes(process.version) && error.message.includes('Promise.withResolvers'));
});

test('public root removal retires a late registration response before the same session is replaced', { timeout: 30000 }, async t => {
  const stateDir = createTempDir('public-registration-cancel');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = rootsFixture();
  const original = fixture.add('same-session');
  const registered = Promise.withResolvers<RootRegistrationResponse>();
  const release = Promise.withResolvers<void>();
  let gated = false;
  class GatedClient extends ControlClient {
    override async registerRoot(...args: Parameters<ControlClient['registerRoot']>) {
      const response = await super.registerRoot(...args);
      if (!gated) {
        gated = true;
        registered.resolve(response);
        await release.promise;
      }
      return response;
    }
  }
  const control = new GatedClient({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, hostType: 'opaque-host', hostVersion: '1',
    groupName: 'public-cancel', controlClient: control, recovery: { random: () => 0 } });
  t.after(async () => { release.resolve(); await runtime.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  const old = await registered.promise;
  fixture.remove(original);
  const replacement = fixture.add('same-session');
  release.resolve();
  const endpoints = await eventually(() => control.listRoots(), roots =>
    roots.some(root => root.endpoint_id === old.endpoint_id && root.status === 'revoked') &&
    roots.some(root => root.endpoint_id !== old.endpoint_id && root.deliverable));
  assert.equal(endpoints.filter(root => root.deliverable).length, 1);
  await assert.rejects(() => runtime.listSessions(original), /CALLER_NOT_ROOT/);
  assert.deepEqual(result(await runtime.listSessions(replacement)), []);
  assert.deepEqual(original.received, []);
});

test('public reconnect preserves pending input and its receipt without replaying business messages', { timeout: 60000 }, async t => {
  const stateDir = createTempDir('public-reconnect');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = rootsFixture(stateDir);
  const sender = fixture.add('sender');
  const receiver = fixture.add('receiver');
  const connections: RootConnection[] = [];
  class ObservedClient extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      const connection = super.createRootConnection(...args);
      connections.push(connection);
      return connection;
    }
  }
  const control = new ObservedClient({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, hostType: 'opaque-host', hostKind: 'opaque-host', hostVersion: '1',
    groupName: 'public-reconnect', controlClient: control, recovery: { random: () => 0 } });
  t.after(async () => { await runtime.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  const [peer] = await eventually(() => runtime.listContactSessions(sender), peers => peers.length === 1);
  await runtime.continueCollaboration(sender);
  const sent = result(await runtime.sendMessage(sender, { to: peer!.endpoint_id, text: 'retained pending input' }));
  assert.equal(sent.status, 'accepted');
  const pending = structuredClone(receiver.pending);
  const oldConnection = connections.find(connection => connection.binding.endpoint_id === peer!.endpoint_id)!;
  oldConnection.dispose();
  await eventually(() => control.listRoots(), roots => roots.some(root =>
    root.endpoint_id === peer!.endpoint_id && root.generation > oldConnection.binding.generation && root.deliverable));
  assert.deepEqual(receiver.pending, pending);
  assert.deepEqual(receiver.received, ['retained pending input']);
  assert.equal(result(await runtime.getMessageStatus(sender, { message_id: sent.message_id })).status, 'accepted');
  await assert.rejects(() => oldConnection.listSessions(), /CHANNEL_NOT_READY/);
  assert.equal(result(await runtime.sendMessage(sender, { to: peer!.endpoint_id, text: 'after recovery' })).status, 'accepted');
  assert.deepEqual(receiver.received, ['retained pending input', 'after recovery']);
});

test('public daemon replacement preserves pending input and refuses readiness without its old accounting', { timeout: 90000 }, async t => {
  const stateDir = createTempDir('public-daemon-replacement');
  const first = new ArloDaemon({ stateDir });
  const second = new ArloDaemon({ stateDir });
  await first.start();
  const fixture = rootsFixture(stateDir);
  const sender = fixture.add('sender');
  const receiver = fixture.add('receiver');
  const runtime = createAdapterRuntime({ host: fixture.host, hostType: 'opaque-host', hostKind: 'opaque-host', hostVersion: '1',
    groupName: 'public-restart', controlClient: new ControlClient({ stateDir }), recovery: { random: () => 0 } });
  t.after(async () => { await runtime.dispose(); await first.stop(); await second.stop(); removeTempDir(stateDir); });
  const [old] = await eventually(() => runtime.listContactSessions(sender), peers => peers.length === 1);
  await runtime.continueCollaboration(sender);
  const sent = result(await runtime.sendMessage(sender, { to: old!.endpoint_id, text: 'before daemon replacement' }));
  assert.equal(sent.status, 'accepted');
  const pending = structuredClone(receiver.pending);
  const previousEndpoints = await new ControlClient({ stateDir }).listRoots();
  await first.stop();
  await second.start();
  // A replacement daemon has no ledger for input that the host still holds.
  // Recovery must retain that input and fail closed, not invent an empty queue.
  await eventually(() => runtime.listSessions(receiver).then(
    () => undefined, (error: { code?: string }) => error.code), code => code === 'ACCOUNTING_UNAVAILABLE', 45000);
  await eventually(() => runtime.listContactSessions(sender), peers => peers.length === 0);
  const endpoints = await new ControlClient({ stateDir }).listRoots();
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints.filter(endpoint => endpoint.deliverable).length, 1);
  assert.ok(endpoints.every(endpoint => !previousEndpoints.some(oldEndpoint => oldEndpoint.endpoint_id === endpoint.endpoint_id)));
  assert.deepEqual(receiver.pending, pending);
  assert.deepEqual(receiver.received, ['before daemon replacement']);
  assert.equal(result(await runtime.getMessageStatus(sender, { message_id: sent.message_id })).status, 'result_unavailable');
  await assert.rejects(() => runtime.sendMessage(sender, { to: old!.endpoint_id, text: 'stale target' }), { code: 'TARGET_UNAVAILABLE' });
  assert.deepEqual(receiver.received, ['before daemon replacement']);
});
