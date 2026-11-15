import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createAdapterRuntime, type AdapterHost, type ReceptionHost } from '@arlo/adapter-sdk';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, ArloError, ArloErrorCode, captureRootConfigurationEvidence } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

function rootsFixture() {
  type Root = { id: string; reception: ReceptionHost };
  const roots: Root[] = [];
  const created = new Set<(root: Root) => void>();
  const disposed = new Set<(root: Root) => void>();
  const host: AdapterHost<Root> = {
    roots: () => roots,
    sessionId: root => root.id,
    sessionCwd: () => undefined,
    reception: root => root.reception,
    onCreated: listener => { created.add(listener); return () => { created.delete(listener); }; },
    onDisposed: listener => { disposed.add(listener); return () => { disposed.delete(listener); }; },
  };
  function add(id: string): Root {
    const root = { id, reception: {
      instanceId: crypto.randomUUID(),
      snapshot: scope => ({ ...scope, complete: true, pending: [], inFlight: [] }),
      prepare: () => { throw new Error('Configuration queries must not enqueue input'); },
    } satisfies ReceptionHost };
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

async function ready(control: ControlClient, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    // The runtime authenticates a fresh pinned control connection at startup;
    // a concurrent diagnostic on that same client may lose its earlier socket.
    try {
      if ((await control.listRoots()).filter(root => root.deliverable).length === count) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Public roots did not become ready');
}

test('a newly witnessed public host root gets its initial allowance before readiness', async t => {
  const stateDir = createTempDir('adapter-initial-allowance');
  const sessionFile = path.join(stateDir, 'host-session.jsonl');
  fs.writeFileSync(sessionFile, 'new public host session');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = rootsFixture();
  Object.assign(fixture.host, {
    rootFirstUseEvidence: () => ({ kind: 'new-session-materialized', creation_id: crypto.randomUUID(),
      evidence: captureRootConfigurationEvidence(sessionFile, undefined, 'new immutable host origin') }),
  });
  fixture.host.rootConfigurationEvidence = () =>
    captureRootConfigurationEvidence(sessionFile, undefined, 'new immutable host origin');
  const control = new ControlClient({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, groupName: 'initial-allowance',
    hostType: 'opaque-host', hostKind: 'opaque-host', hostVersion: '1', controlClient: control });
  t.after(async () => { await runtime.dispose(); control.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  const root = fixture.add('new-root');
  await ready(control);
  const initial = await runtime.getRootSendingStatus(root);
  assert.equal(initial.knowledge, 'known');
  assert.equal(initial.granted, 20);
  assert.equal(initial.remaining, 20);
  assert.equal(initial.control_sequence, 0, 'Automatic first use does not impersonate a human command');
});

test('an unsaved public host root stays ready and initializes once its creation becomes durable', async t => {
  const stateDir = createTempDir('adapter-deferred-initial-allowance');
  const sessionFile = path.join(stateDir, 'host-session.jsonl');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = rootsFixture();
  const origin = 'new deferred immutable host origin';
  const creationId = crypto.randomUUID();
  const currentEvidence = () => fs.existsSync(sessionFile)
    ? captureRootConfigurationEvidence(sessionFile, undefined, origin) : undefined;
  fixture.host.rootConfigurationEvidence = currentEvidence;
  fixture.host.rootFirstUseEvidence = () => {
    const evidence = currentEvidence();
    return evidence && { kind: 'new-session-materialized', creation_id: creationId, evidence };
  };
  const control = new ControlClient({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, groupName: 'deferred-initial-allowance',
    hostType: 'opaque-host', hostKind: 'opaque-host', hostVersion: '1', controlClient: control });
  t.after(async () => { await runtime.dispose(); control.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  const root = fixture.add('new-root');
  await ready(control);
  const before = await runtime.getRootSendingStatus(root);
  assert.equal(before.knowledge, 'unknown');
  assert.equal(before.root_configuration.reason, 'EVIDENCE_UNAVAILABLE');
  assert.equal(await runtime.initializeRootSending(root), undefined);

  fs.writeFileSync(sessionFile, 'newly durable native session');
  const [first, concurrent] = await Promise.all([
    runtime.initializeRootSending(root), runtime.initializeRootSending(root),
  ]);
  assert.equal(first?.knowledge, 'known');
  assert.equal(first?.remaining, 20);
  assert.equal(first?.control_sequence, 0);
  assert.equal(concurrent?.period_id, first?.period_id);
  assert.equal(await runtime.initializeRootSending(root), undefined);
  const repeated = await runtime.getRootSendingStatus(root);
  assert.equal(repeated.period_id, first?.period_id);
  assert.equal(repeated.remaining, 20);
  await assert.rejects(() => runtime.initializeRootSending({ ...root }), { code: ArloErrorCode.CALLER_NOT_ROOT });
});

test('failed first-use storage leaves reception ready and repair requires explicit human continuation', async t => {
  const stateDir = createTempDir('adapter-failed-initial-allowance');
  const sessionFile = path.join(stateDir, 'host-session.jsonl');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = rootsFixture();
  const origin = 'new failed immutable host origin';
  let storageFailed = true;
  const currentEvidence = () => fs.existsSync(sessionFile)
    ? captureRootConfigurationEvidence(sessionFile, undefined, origin) : undefined;
  fixture.host.rootConfigurationEvidence = currentEvidence;
  fixture.host.rootFirstUseEvidence = () => {
    if (storageFailed) throw new Error('Public native storage failed');
    const evidence = currentEvidence();
    return evidence && { kind: 'new-session-materialized', creation_id: crypto.randomUUID(), evidence };
  };
  const control = new ControlClient({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, groupName: 'failed-initial-allowance',
    hostType: 'opaque-host', hostKind: 'opaque-host', hostVersion: '1', controlClient: control });
  t.after(async () => { await runtime.dispose(); control.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  const root = fixture.add('new-root');
  await ready(control);
  assert.equal((await runtime.getRootSendingStatus(root)).knowledge, 'unknown');

  storageFailed = false;
  fs.writeFileSync(sessionFile, 'repaired native session');
  assert.equal(await runtime.initializeRootSending(root), undefined);
  await runtime.pause();
  await runtime.resume();
  const repaired = await runtime.getRootSendingStatus(root);
  assert.equal(repaired.root_configuration.ownership, 'verified');
  assert.equal(repaired.knowledge, 'unknown');
  assert.equal(repaired.control_sequence, 0);
  const continued = await runtime.continueCollaboration(root);
  assert.equal(continued.remaining, 20);
  assert.equal(continued.control_sequence, 1);
});

test('deferred first-use proof cannot initialize a newer connection generation', async t => {
  const stateDir = createTempDir('adapter-stale-initial-allowance');
  const sessionFile = path.join(stateDir, 'host-session.jsonl');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = rootsFixture();
  const origin = 'new fenced immutable host origin';
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let materialized = false;
  fixture.host.rootConfigurationEvidence = () => materialized
    ? captureRootConfigurationEvidence(sessionFile, undefined, origin) : undefined;
  fixture.host.rootFirstUseEvidence = async () => {
    if (!materialized) return undefined;
    entered.resolve();
    await release.promise;
    return { kind: 'new-session-materialized', creation_id: crypto.randomUUID(),
      evidence: captureRootConfigurationEvidence(sessionFile, undefined, origin) };
  };
  const control = new ControlClient({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, groupName: 'stale-initial-allowance',
    hostType: 'opaque-host', hostKind: 'opaque-host', hostVersion: '1', controlClient: control });
  t.after(async () => { release.resolve(); await runtime.dispose(); control.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  const root = fixture.add('new-root');
  await ready(control);
  fs.writeFileSync(sessionFile, 'new native session whose proof is delayed');
  materialized = true;
  const stale = assert.rejects(runtime.initializeRootSending(root), { code: ArloErrorCode.CHANNEL_NOT_READY });
  await entered.promise;
  await runtime.pause();
  await runtime.resume();
  release.resolve();
  await stale;
  const after = await runtime.getRootSendingStatus(root);
  assert.equal(after.knowledge, 'unknown');
  assert.equal(after.control_sequence, 0);
  assert.equal(await runtime.initializeRootSending(root), undefined);
  assert.equal((await runtime.continueCollaboration(root)).remaining, 20);
});

test('trusted sending commands begin unknown and concurrent human continuation opens only one full period', async t => {
  const stateDir = createTempDir('adapter-collaboration-period');
  const sessionFile = path.join(stateDir, 'host-session.jsonl');
  fs.writeFileSync(sessionFile, 'durable public host session');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = rootsFixture();
  const root = fixture.add('root');
  fixture.host.rootConfigurationEvidence = () => captureRootConfigurationEvidence(sessionFile);
  const control = new ControlClient({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, groupName: 'sending-state',
    hostType: 'opaque-host', hostKind: 'opaque-host', hostVersion: '1', controlClient: control });
  t.after(async () => { await runtime.dispose(); control.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  await ready(control);

  const before = await runtime.getRootSendingStatus(root);
  assert.equal(before.knowledge, 'unknown');
  assert.equal(before.used, null);
  assert.equal(before.remaining, null);
  assert.equal(before.pause_reason, 'ALLOWANCE_UNKNOWN');
  assert.equal(before.root_configuration.ownership, 'verified');
  await assert.rejects(() => runtime.continueCollaboration({ ...root }), { code: ArloErrorCode.CALLER_NOT_ROOT });
  await assert.rejects(() => runtime.reloadSendingRules({ ...root }), { code: ArloErrorCode.CALLER_NOT_ROOT });
  const restored = await Promise.all([runtime.continueCollaboration(root), runtime.continueCollaboration(root)]);
  assert.equal(restored[0].period_id, restored[1].period_id);
  assert.equal(restored[0].knowledge, 'known');
  assert.equal(restored[0].granted, 20);
  assert.equal(restored[0].remaining, 20);
  assert.equal(restored[0].used, 0);
  assert.equal(restored[0].control_sequence, 1);
  const later = await runtime.continueCollaboration(root);
  assert.notEqual(later.period_id, restored[0].period_id);
  assert.equal(later.remaining, 20, 'A new explicit human command replaces rather than adds the old allowance');
  assert.equal(later.control_sequence, 2);
  fixture.remove(root);
  await assert.rejects(() => runtime.getRootSendingStatus(root), { code: ArloErrorCode.CALLER_NOT_ROOT });
  await assert.rejects(() => runtime.continueCollaboration(root), { code: ArloErrorCode.CALLER_NOT_ROOT });
  await assert.rejects(() => runtime.reloadSendingRules(root), { code: ArloErrorCode.CALLER_NOT_ROOT });
});

test('an explicit continuation retry after a lost control response retains the original durable grant request', async t => {
  const stateDir = createTempDir('adapter-collaboration-retry');
  const sessionFile = path.join(stateDir, 'host-session.jsonl');
  fs.writeFileSync(sessionFile, 'durable actual host session');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = rootsFixture();
  const root = fixture.add('root');
  fixture.host.rootConfigurationEvidence = () => captureRootConfigurationEvidence(sessionFile);
  const requests: Parameters<ControlClient['continueCollaboration']>[1][] = [];
  class LostResponseControl extends ControlClient {
    override async continueCollaboration(...args: Parameters<ControlClient['continueCollaboration']>) {
      requests.push(args[1]);
      const result = await super.continueCollaboration(...args);
      if (requests.length === 1) throw new ArloError(ArloErrorCode.CONNECTION_LOST);
      return result;
    }
  }
  const control = new LostResponseControl({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, groupName: 'control-retry',
    hostType: 'opaque-host', hostKind: 'opaque-host', hostVersion: '1', controlClient: control });
  t.after(async () => { await runtime.dispose(); control.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  await ready(control);
  await assert.rejects(() => runtime.continueCollaboration(root), { code: ArloErrorCode.CONNECTION_LOST });
  const committed = await runtime.getRootSendingStatus(root);
  assert.equal(committed.control_sequence, 1);
  const retried = await runtime.continueCollaboration(root);
  assert.equal(retried.period_id, committed.period_id);
  assert.equal(retried.control_sequence, 1);
  assert.deepEqual(requests[0], requests[1]);
});

test('trusted configuration query authenticates only the actual ready root and does not invent persistent history', async t => {
  const stateDir = createTempDir('root-configuration-adapter');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = rootsFixture();
  const root = fixture.add('root');
  const control = new ControlClient({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, groupName: 'configuration',
    hostType: 'opaque-host', hostKind: 'opaque-host', hostVersion: '1', controlClient: control });
  t.after(async () => { await runtime.dispose(); control.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  await ready(control);

  const status = await runtime.getRootConfiguration(root);
  assert.equal(status.root_authenticated, true);
  assert.equal(status.ownership, 'unknown');
  assert.equal(status.history, 'unknown');
  assert.equal(status.config_id, null);
  assert.equal(status.reason, 'EVIDENCE_UNAVAILABLE');
  assert.ok(status.config_path);
  assert.ok(status.guidance);
  await assert.rejects(() => runtime.listSessions(root, { config_id: 'someone-else' }), { code: ArloErrorCode.INVALID_ARGUMENT });
  await assert.rejects(() => runtime.getRootConfiguration({ ...root }), { code: ArloErrorCode.CALLER_NOT_ROOT });
  fixture.remove(root);
  await assert.rejects(() => runtime.getRootConfiguration(root), { code: ArloErrorCode.CALLER_NOT_ROOT });
});

test('trusted configuration evidence cannot cross a group switch while the public host flush is pending', async t => {
  const stateDir = createTempDir('root-configuration-evidence-lifecycle');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = rootsFixture();
  const root = fixture.add('root');
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.host.rootConfigurationEvidence = async () => {
    started.resolve();
    await release.promise;
    return undefined;
  };
  const control = new ControlClient({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, groupName: 'original',
    hostType: 'opaque-host', hostKind: 'opaque-host', hostVersion: '1', controlClient: control });
  t.after(async () => { release.resolve(); await runtime.dispose(); control.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  await ready(control);

  const query = assert.rejects(() => runtime.getRootConfiguration(root), { code: ArloErrorCode.CHANNEL_NOT_READY });
  const continuation = assert.rejects(() => runtime.continueCollaboration(root), { code: ArloErrorCode.CHANNEL_NOT_READY });
  const reload = assert.rejects(() => runtime.reloadSendingRules(root), { code: ArloErrorCode.CHANNEL_NOT_READY });
  await started.promise;
  await runtime.switchGroup(root, 'replacement');
  release.resolve();
  await query;
  await continuation;
  await reload;
  assert.equal((await runtime.getRootSendingStatus(root)).control_sequence, 0, 'A command from the retired connection grants nothing');
  const current = await runtime.getRootConfiguration(root);
  assert.equal(current.root_authenticated, true);
  assert.equal(current.history, 'unknown');
});

test('trusted configuration results cannot escape after the root is removed during a real daemon query', async t => {
  const stateDir = createTempDir('root-configuration-result-lifecycle');
  const daemon = new ArloDaemon({ stateDir });
  await daemon.start();
  const fixture = rootsFixture();
  const root = fixture.add('root');
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class GatedControlClient extends ControlClient {
    override async getRootConfiguration(...args: Parameters<ControlClient['getRootConfiguration']>) {
      const response = await super.getRootConfiguration(...args);
      started.resolve();
      await release.promise;
      return response;
    }
  }
  const control = new GatedControlClient({ stateDir });
  const runtime = createAdapterRuntime({ host: fixture.host, groupName: 'configuration',
    hostType: 'opaque-host', hostKind: 'opaque-host', hostVersion: '1', controlClient: control });
  t.after(async () => { release.resolve(); await runtime.dispose(); control.dispose(); await daemon.stop(); removeTempDir(stateDir); });
  await ready(control);

  const query = assert.rejects(() => runtime.getRootConfiguration(root), { code: ArloErrorCode.CHANNEL_NOT_READY });
  await started.promise;
  fixture.remove(root);
  release.resolve();
  await query;
  await assert.rejects(() => runtime.getRootConfiguration(root), { code: ArloErrorCode.CALLER_NOT_ROOT });
});
