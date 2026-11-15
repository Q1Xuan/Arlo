import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { createAdapterRuntime, createParticipationSettings, participationScope, type AdapterHost } from '@arlo/adapter-sdk';
import { ArloDaemon } from '@arlo/daemon';
import {
  ControlClient, ArloErrorCode,
  type ArloMessageNotificationParams, type RootConnection,
  type RootRegistrationResponse, type RuntimeRegistrationRequest, type SessionDiscoveryItem,
} from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';
import { DAEMON_CERT, DAEMON_KEY } from '../probes/tls-fixtures.ts';
import { AuthorizedControlClient } from './helpers/authorized-control.ts';

interface Peer {
  name: string;
  runtimeToken: string;
  registration: RootRegistrationResponse;
  connection: RootConnection;
  received: ArloMessageNotificationParams[];
  beforeReceipt?: (frame: ArloMessageNotificationParams) => Promise<void>;
}

async function participationFixture(t: TestContext, leaseNow?: () => number) {
  const stateDir = createTempDir('cross-host-participation');
  const daemon = new ArloDaemon({ stateDir, leaseNow });
  const control = new AuthorizedControlClient({ stateDir });
  const peers: Peer[] = [];
  t.after(async () => {
    for (const peer of peers) peer.connection.dispose();
    control.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  });
  await daemon.start();
  async function add(name: string, options: RuntimeRegistrationRequest, groupName = 'participation'): Promise<Peer> {
    const runtime = await control.registerRuntime(options);
    return addRoot(name, runtime.runtime_token, groupName);
  }
  async function addRoot(name: string, runtimeToken: string, groupName = 'participation'): Promise<Peer> {
    const registration = await control.registerRoot(runtimeToken, {
      root_session_id: name, group_name: groupName, agent_incarnation: name, plugin_generation: 1,
    });
    const connection = control.createRootConnection(registration, {
      heartbeat: false, requireCrossHostParticipation: true,
    });
    const peer: Peer = { name, runtimeToken, registration, connection, received: [] };
    peers.push(peer);
    connection.onNotification(async frame => {
      peer.received.push(frame);
      await peer.beforeReceipt?.(frame);
      await control.submitReceipt(registration.root_token, {
        daemon_id: frame.daemon_id, endpoint_id: registration.endpoint_id,
        message_id: frame.message_id, delivery_id: frame.delivery_id, generation: frame.target_generation,
        status: 'enqueued', native_message_id: `native-${frame.message_id}`,
      });
    });
    await connection.connect();
    await control.confirmRootReady(registration.root_token, { endpoint_id: registration.endpoint_id });
    return peer;
  }
  return { add, addRoot, control };
}

async function contacts(peer: Peer): Promise<SessionDiscoveryItem[]> {
  const content = await peer.connection.listSessions();
  return JSON.parse(content[0].text) as SessionDiscoveryItem[];
}

async function prepareSetting(control: ControlClient, token: string) {
  const state = await control.getRuntimeParticipation(token);
  return { effective: state.cross_host_enabled,
    apply: async (enabled: boolean) => (await control.updateRuntimeParticipation(token, enabled, state.revision)).cross_host_enabled };
}

test('changing participation gates new discovery, direct sends and replies while retaining admitted receipts', { timeout: 30000 }, async t => {
  const { add, control } = await participationFixture(t);
  const pi = await add('pi', { host_kind: 'pi' });
  const dsh = await add('dsh', { host_kind: 'deepseek-harness', cross_host_enabled: true });
  const sibling = await add('pi-sibling', { host_kind: 'pi' });
  const originalEndpoint = pi.registration.endpoint_id;
  await control.updateRuntimeParticipation(pi.runtimeToken, true);
  assert.ok((await contacts(pi)).some(item => item.endpoint_id === dsh.registration.endpoint_id));
  const sent = await pi.connection.sendMessage({ to: dsh.registration.endpoint_id, text: 'Before disabling' });
  assert.equal(sent.status, 'accepted');
  await control.updateRuntimeParticipation(pi.runtimeToken, false);
  assert.deepEqual((await contacts(pi)).map(item => item.endpoint_id), [sibling.registration.endpoint_id]);
  assert.ok(!(await contacts(dsh)).some(item => item.endpoint_id === originalEndpoint));
  await assert.rejects(pi.connection.sendMessage({ to: dsh.registration.endpoint_id, text: 'Cached endpoint' }),
    { code: ArloErrorCode.CROSS_HOST_DISABLED });
  await assert.rejects(dsh.connection.sendMessage({ to: originalEndpoint, text: 'After disabling', reply_to: sent.message_id }),
    { code: ArloErrorCode.CROSS_HOST_DISABLED });
  assert.equal((await pi.connection.getMessageStatus(sent.message_id)).status, 'accepted');
  assert.equal((await pi.connection.sendMessage({ to: sibling.registration.endpoint_id, text: 'Same host still works' })).status, 'accepted');
  assert.equal(dsh.received.length, 1);
});

test('participation updates affect every runtime sharing a host configuration and isolate other configurations', { timeout: 30000 }, async t => {
  const { add, control } = await participationFixture(t);
  const scope = 'a'.repeat(64);
  const pi = await add('pi-first', { host_kind: 'pi', participation_scope: scope });
  const sameConfig = await add('pi-second', { host_kind: 'pi', participation_scope: scope });
  const independent = await add('pi-independent', { host_kind: 'pi', participation_scope: 'b'.repeat(64) });
  const dsh = await add('dsh', { host_kind: 'deepseek-harness', cross_host_enabled: true, participation_scope: scope });
  await control.updateRuntimeParticipation(pi.runtimeToken, true);
  assert.ok((await contacts(sameConfig)).some(item => item.endpoint_id === dsh.registration.endpoint_id));
  assert.ok(!(await contacts(independent)).some(item => item.endpoint_id === dsh.registration.endpoint_id));
  await control.updateRuntimeParticipation(sameConfig.runtimeToken, false);
  assert.ok(!(await contacts(pi)).some(item => item.endpoint_id === dsh.registration.endpoint_id));
  const dshSibling = await add('dsh-sibling', { host_kind: 'deepseek-harness' });
  assert.equal((await dsh.connection.sendMessage({ to: dshSibling.registration.endpoint_id, text: 'DSH configuration stays independent' })).status, 'accepted');
});

for (const closeAfterReceipt of [false, true]) {
  for (const [senderKind, receiverKind] of [['pi', 'deepseek-harness'], ['claudecode', 'pi'], ['pi', 'claudecode'], ['claudecode', 'deepseek-harness'], ['deepseek-harness', 'claudecode']]) {
    test(`${senderKind} to ${receiverKind}: disabling ${closeAfterReceipt ? 'after' : 'before'} the accepted receipt preserves its receipt and pending credit until actual claim`, { timeout: 30000 }, async t => {
      const { add, control } = await participationFixture(t);
      const sender = await add('sender-in-flight', { host_kind: senderKind, cross_host_enabled: true });
      const receiver = await add('receiver-in-flight', { host_kind: receiverKind, cross_host_enabled: true });
      const arrived = Promise.withResolvers<ArloMessageNotificationParams>();
      const receipt = Promise.withResolvers<void>();
      t.after(() => receipt.resolve());
      receiver.beforeReceipt = async frame => { arrived.resolve(frame); await receipt.promise; };
      const sending = sender.connection.sendMessage({ to: receiver.registration.endpoint_id, text: 'Admitted before disabling' });
      const frame = await arrived.promise;
      if (!closeAfterReceipt) await control.updateRuntimeParticipation(receiver.runtimeToken, false);
      assert.equal((await sender.connection.getMessageStatus(frame.message_id)).status, 'in_flight');
      await assert.rejects(control.confirmRootReady(receiver.registration.root_token, {
        endpoint_id: receiver.registration.endpoint_id, reconciled_pending_message_ids: [],
      }), { code: ArloErrorCode.ACCOUNTING_UNAVAILABLE });
      receipt.resolve();
      assert.equal((await sending).status, 'accepted');
      if (closeAfterReceipt) await control.updateRuntimeParticipation(receiver.runtimeToken, false);
      assert.equal((await sender.connection.getMessageStatus(frame.message_id)).status, 'accepted');
      await assert.rejects(control.confirmRootReady(receiver.registration.root_token, {
        endpoint_id: receiver.registration.endpoint_id, reconciled_pending_message_ids: [],
      }), { code: ArloErrorCode.ACCOUNTING_UNAVAILABLE }, 'An accepted receipt still holds credit until claim');
      await control.releaseCredit(receiver.registration.root_token, {
        endpoint_id: receiver.registration.endpoint_id, message_id: frame.message_id,
        daemon_id: frame.daemon_id, generation: frame.target_generation, delivery_id: frame.delivery_id,
        native_message_id: `native-${frame.message_id}`, event: 'claimed',
      });
      await control.confirmRootReady(receiver.registration.root_token, {
        endpoint_id: receiver.registration.endpoint_id, reconciled_pending_message_ids: [],
      });
      assert.equal((await sender.connection.getMessageStatus(frame.message_id)).status, 'accepted');
      assert.equal(receiver.received.length, 1);
    });
  }
}

test('saved plugin settings default off, reread shared files and report effective state only after Daemon confirmation', { timeout: 30000 }, async t => {
  const { add, control } = await participationFixture(t);
  const directory = createTempDir('participation-settings');
  t.after(() => removeTempDir(directory));
  const configPath = path.join(directory, 'pi', 'arlo.json');
  const otherPath = path.join(directory, 'independent', 'arlo.json');
  const pi = await add('pi-settings', { host_kind: 'pi', participation_scope: participationScope(configPath) });
  const sibling = await add('pi-settings-sibling', { host_kind: 'pi', participation_scope: participationScope(configPath) });
  const isolated = await add('pi-settings-isolated', { host_kind: 'pi', participation_scope: participationScope(otherPath) });
  const dsh = await add('dsh-settings', { host_kind: 'deepseek-harness', cross_host_enabled: true });
  const gate = Promise.withResolvers<void>();
  let hold = false;
  let failUpdate = false;
  const first = createParticipationSettings({ configPath, pollIntervalMs: 0, prepare: async () => {
    const update = await prepareSetting(control, failUpdate ? 'invalid-runtime-token' : pi.runtimeToken);
    return { ...update, apply: async enabled => {
      if (hold) await gate.promise;
      return update.apply(enabled);
    } };
  } });
  const second = createParticipationSettings({ configPath, pollIntervalMs: 0,
    prepare: () => prepareSetting(control, sibling.runtimeToken) });
  const independent = createParticipationSettings({ configPath: otherPath, pollIntervalMs: 0,
    prepare: () => prepareSetting(control, isolated.runtimeToken) });
  t.after(() => { first.dispose(); second.dispose(); independent.dispose(); });
  assert.equal((await first.refresh()).effective, false);
  await second.refresh();
  await independent.refresh();
  hold = true;
  const enabling = first.set(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.status().effective, null);
  assert.ok(!(await contacts(pi)).some(item => item.endpoint_id === dsh.registration.endpoint_id));
  gate.resolve();
  assert.equal((await enabling).effective, true);
  assert.equal((await second.refresh()).effective, true);
  assert.equal((await independent.refresh()).effective, false);
  await second.set(false);
  assert.equal((await first.refresh()).effective, false);
  assert.ok(!(await contacts(pi)).some(item => item.endpoint_id === dsh.registration.endpoint_id));
  failUpdate = true;
  await assert.rejects(first.set(true), { code: ArloErrorCode.UNAUTHORIZED });
  assert.equal(first.status().configured, true);
  assert.equal(first.status().effective, null);
  assert.equal(first.status().error, ArloErrorCode.UNAUTHORIZED);
  assert.ok(!(await contacts(pi)).some(item => item.endpoint_id === dsh.registration.endpoint_id));
});

test('saving a shared preference confirms the Daemon state even when another session made the local status stale', { timeout: 30000 }, async t => {
  const { add, control } = await participationFixture(t);
  const directory = createTempDir('participation-stale-settings');
  t.after(() => removeTempDir(directory));
  const configPath = path.join(directory, 'arlo.json');
  const scope = participationScope(configPath);
  const firstPeer = await add('pi-first-setting', { host_kind: 'pi', participation_scope: scope });
  const secondPeer = await add('pi-stale-setting', { host_kind: 'pi', participation_scope: scope });
  const dsh = await add('dsh-setting-target', { host_kind: 'deepseek-harness', cross_host_enabled: true });
  const first = createParticipationSettings({ configPath, pollIntervalMs: 0,
    prepare: () => prepareSetting(control, firstPeer.runtimeToken) });
  const second = createParticipationSettings({ configPath, pollIntervalMs: 0,
    prepare: () => prepareSetting(control, secondPeer.runtimeToken) });
  t.after(() => { first.dispose(); second.dispose(); });
  await first.refresh();
  await second.refresh();
  await first.set(true);
  assert.equal(second.status().effective, false, 'The sibling has not reread the shared preference yet');
  assert.ok((await contacts(secondPeer)).some(item => item.endpoint_id === dsh.registration.endpoint_id));

  assert.equal((await second.set(false)).effective, false);
  assert.ok(!(await contacts(secondPeer)).some(item => item.endpoint_id === dsh.registration.endpoint_id),
    'A confirmed close must disable discovery in the Daemon, even when the local status was already off');
  await assert.rejects(firstPeer.connection.sendMessage({ to: dsh.registration.endpoint_id, text: 'After the sibling confirmed closing' }),
    { code: ArloErrorCode.CROSS_HOST_DISABLED });
});

test('a delayed shared-setting update cannot reopen participation after a sibling confirms closing', { timeout: 30000 }, async t => {
  const { add, control } = await participationFixture(t);
  const directory = createTempDir('participation-delayed-settings');
  t.after(() => removeTempDir(directory));
  const configPath = path.join(directory, 'arlo.json');
  const scope = participationScope(configPath);
  const firstPeer = await add('pi-delayed-setting', { host_kind: 'pi', participation_scope: scope });
  const secondPeer = await add('pi-closing-setting', { host_kind: 'pi', participation_scope: scope });
  const dsh = await add('dsh-delayed-target', { host_kind: 'deepseek-harness', cross_host_enabled: true });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  const first = createParticipationSettings({ configPath, pollIntervalMs: 0, prepare: async () => {
    const update = await prepareSetting(control, firstPeer.runtimeToken);
    return { ...update, apply: async enabled => {
      if (hold) { entered.resolve(); await release.promise; }
      return update.apply(enabled);
    } };
  } });
  const second = createParticipationSettings({ configPath, pollIntervalMs: 0,
    prepare: () => prepareSetting(control, secondPeer.runtimeToken) });
  t.after(() => { release.resolve(); first.dispose(); second.dispose(); });
  await first.refresh();
  await second.refresh();
  hold = true;
  const enabling = first.set(true);
  void enabling.catch(() => {});
  await entered.promise;
  assert.equal((await second.set(false)).effective, false);
  first.dispose();
  release.resolve();
  await assert.rejects(enabling, { code: ArloErrorCode.CHANNEL_NOT_READY });
  assert.ok(!(await contacts(secondPeer)).some(item => item.endpoint_id === dsh.registration.endpoint_id),
    'An old update cannot reopen discovery after closing has been acknowledged');
  await assert.rejects(firstPeer.connection.sendMessage({ to: dsh.registration.endpoint_id, text: 'After confirmed closing' }),
    { code: ArloErrorCode.CROSS_HOST_DISABLED });
  assert.equal((await second.refresh()).effective, false);
});

test('settings reread the saved preference after a delayed common-state preparation', { timeout: 30000 }, async t => {
  const { add, control } = await participationFixture(t);
  const directory = createTempDir('participation-delayed-preparation');
  t.after(() => removeTempDir(directory));
  const configPath = path.join(directory, 'arlo.json');
  const scope = participationScope(configPath);
  const firstPeer = await add('pi-preparing-setting', { host_kind: 'pi', participation_scope: scope });
  const secondPeer = await add('pi-newer-setting', { host_kind: 'pi', participation_scope: scope });
  const dsh = await add('dsh-preparing-target', { host_kind: 'deepseek-harness', cross_host_enabled: true });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const applied: boolean[] = [];
  let hold = false;
  const first = createParticipationSettings({ configPath, pollIntervalMs: 0, prepare: async () => {
    if (hold) { entered.resolve(); await release.promise; }
    const update = await prepareSetting(control, firstPeer.runtimeToken);
    return { ...update, apply: async enabled => { applied.push(enabled); return update.apply(enabled); } };
  } });
  const second = createParticipationSettings({ configPath, pollIntervalMs: 0,
    prepare: () => prepareSetting(control, secondPeer.runtimeToken) });
  t.after(() => { release.resolve(); first.dispose(); second.dispose(); });
  await first.refresh();
  hold = true;
  const enabling = first.set(true);
  await entered.promise;
  assert.equal((await second.set(false)).effective, false);
  release.resolve();
  assert.equal((await enabling).effective, false);
  assert.deepEqual(applied, [false], 'A delayed preparation never submits the superseded enabled preference');
  assert.ok(!(await contacts(firstPeer)).some(item => item.endpoint_id === dsh.registration.endpoint_id));
});

test('same-value confirmation invalidates older revisions and new runtimes inherit the current configuration', { timeout: 30000 }, async t => {
  const { add, control } = await participationFixture(t);
  const scope = 'c'.repeat(64);
  const first = await add('pi-revision-first', { host_kind: 'pi', participation_scope: scope });
  const second = await add('pi-revision-second', { host_kind: 'pi', participation_scope: scope });
  const original = await control.getRuntimeParticipation(first.runtimeToken);
  const closed = await control.updateRuntimeParticipation(second.runtimeToken, false, original.revision);
  assert.notEqual(closed.revision, original.revision);
  await assert.rejects(control.updateRuntimeParticipation(first.runtimeToken, true, original.revision),
    { code: ArloErrorCode.STALE_GENERATION });
  const joining = await add('pi-revision-joining', { host_kind: 'pi', participation_scope: scope, cross_host_enabled: true });
  assert.deepEqual(await control.getRuntimeParticipation(joining.runtimeToken), closed);
  await assert.rejects(control.getRuntimeParticipation(joining.registration.root_token), { code: ArloErrorCode.UNAUTHORIZED });
  await assert.rejects(control.updateRuntimeParticipation(first.runtimeToken, true, 'invalid-revision'),
    { code: ArloErrorCode.INVALID_ARGUMENT });
  assert.deepEqual(await control.getRuntimeParticipation(first.runtimeToken), closed);
});

test('polling reconciles common participation after the saved preference returns to its cached value', { timeout: 30000 }, async t => {
  const { add, control } = await participationFixture(t);
  const directory = createTempDir('participation-returned-settings');
  t.after(() => removeTempDir(directory));
  const configPath = path.join(directory, 'arlo.json');
  const scope = participationScope(configPath);
  const firstPeer = await add('pi-cached-setting', { host_kind: 'pi', participation_scope: scope });
  const secondPeer = await add('pi-intermediate-setting', { host_kind: 'pi', participation_scope: scope });
  const dsh = await add('dsh-cached-target', { host_kind: 'deepseek-harness', cross_host_enabled: true });
  const first = createParticipationSettings({ configPath, pollIntervalMs: 0,
    prepare: () => prepareSetting(control, firstPeer.runtimeToken) });
  const second = createParticipationSettings({ configPath, pollIntervalMs: 0,
    prepare: () => prepareSetting(control, secondPeer.runtimeToken) });
  t.after(() => { first.dispose(); second.dispose(); });
  await first.set(true);
  await second.set(false);
  // A later native save or external edit can finish before its process exits,
  // without any surviving process having applied that final file value yet.
  fs.writeFileSync(configPath, JSON.stringify({ crossHostEnabled: true }));
  second.dispose();
  assert.equal(first.status().effective, true);
  assert.equal((await first.refresh()).effective, true);
  assert.ok((await contacts(firstPeer)).some(item => item.endpoint_id === dsh.registration.endpoint_id),
    'Matching cached and saved booleans cannot hide a different Daemon state');
});

test('Discovery and new sends require a known common host or bilateral participation', { timeout: 90000 }, async t => {
  // Nine non-heartbeating peers and durable human grants can outlast a lease
  // on Windows. This permission test keeps the public monotonic lease clock
  // fixed; dedicated lease regressions exercise expiry and recovery.
  const { add } = await participationFixture(t, () => 1_000_000);
  const pi = await add('pi', { host_kind: 'pi', host_type: 'deepseek-harness' });
  const piAlias = await add('pi-alias', { host_kind: 'pi', host_type: 'Another display label', cross_host_enabled: false });
  const dsh = await add('dsh', { host_kind: 'deepseek-harness', host_type: 'deepseek-harness' });
  const legacyDsh = await add('legacy-dsh', { host_type: 'deepseek-harness' });
  const unknownA = await add('unknown-a', { host_type: 'Unknown host' });
  const unknownB = await add('unknown-b', { host_type: 'Unknown host' });
  const piOpen = await add('pi-open', { host_kind: 'pi', cross_host_enabled: true });
  const dshOpen = await add('dsh-open', { host_kind: 'deepseek-harness', cross_host_enabled: true });
  const otherGroup = await add('other-group', { host_kind: 'pi', cross_host_enabled: true }, 'other-group');

  const expected: Array<[Peer, Peer[]]> = [
    [pi, [piAlias, piOpen]], [piAlias, [pi, piOpen]],
    [dsh, [legacyDsh, dshOpen]], [legacyDsh, [dsh, dshOpen]],
    [unknownA, []], [unknownB, []],
    [piOpen, [pi, piAlias, dshOpen]], [dshOpen, [dsh, legacyDsh, piOpen]],
    [otherGroup, []],
  ];
  for (const [peer, allowed] of expected) {
    assert.deepEqual((await contacts(peer)).map(item => item.endpoint_id).sort(),
      allowed.map(item => item.registration.endpoint_id).sort(), peer.name);
  }

  for (const [source, target] of [[pi, dsh], [dsh, pi], [piOpen, dsh], [dshOpen, pi], [unknownA, unknownB]]) {
    await assert.rejects(source.connection.sendMessage({
      to: target.registration.endpoint_id, text: 'A known endpoint does not bypass participation',
    }), { code: ArloErrorCode.CROSS_HOST_DISABLED });
    assert.equal(target.received.length, 0);
  }
  await assert.rejects(piOpen.connection.sendMessage({
    to: otherGroup.registration.endpoint_id, text: 'Both opt-ins still require the same group',
  }), { code: ArloErrorCode.GROUP_MISMATCH });

  for (const [source, target] of [[pi, piAlias], [legacyDsh, dsh]]) {
    const sent = await source.connection.sendMessage({ to: target.registration.endpoint_id, text: 'Same-host delivery' });
    assert.equal(sent.status, 'accepted');
  }
  const sent = await piOpen.connection.sendMessage({ to: dshOpen.registration.endpoint_id, text: 'Both hosts participate' });
  assert.equal(sent.status, 'accepted');
  const reply = await dshOpen.connection.sendMessage({
    to: piOpen.registration.endpoint_id, text: 'Associated cross-host reply', reply_to: sent.message_id,
  });
  assert.equal(reply.status, 'accepted');
  assert.equal(piOpen.received[0].reply_to, sent.message_id);
  assert.equal(piOpen.received[0].from_endpoint, dshOpen.registration.endpoint_id);
  assert.equal((await piOpen.connection.getMessageStatus(sent.message_id)).status, 'accepted');

  for (const spoof of [{ host_kind: 'deepseek-harness' }, { cross_host_enabled: true }]) {
    const args = { to: dsh.registration.endpoint_id, text: 'Model fields cannot grant participation', ...spoof };
    await assert.rejects(pi.connection.sendMessage(args), { code: ArloErrorCode.INVALID_ARGUMENT });
  }
});

for (const initiallyEnabled of [false, true]) {
  test(`Registration retry preserves the initial ${initiallyEnabled ? 'enabled' : 'disabled'} participation preference`,
    { timeout: 30000 }, async t => {
      const { add, addRoot, control } = await participationFixture(t);
      const identity = {
        runtime_id: 'rt-pi-registration-retry', continuity_token: 'participation-continuity-token-62', host_kind: 'pi',
      };
      const original = await control.registerRuntime({ ...identity, cross_host_enabled: initiallyEnabled });
      const retried = await control.registerRuntime({ ...identity, cross_host_enabled: !initiallyEnabled });
      assert.equal(retried.runtime_id, original.runtime_id);
      assert.notEqual(retried.runtime_token, original.runtime_token, 'The same authenticated runtime rotates its credential');

      // Register roots only after the retry: no prior root or connection can
      // supply an old cached participation decision.
      const pi = await addRoot('pi-after-retry', retried.runtime_token);
      const dsh = await add('dsh-open', { host_kind: 'deepseek-harness', cross_host_enabled: true });
      for (const [source, target] of [[pi, dsh], [dsh, pi]]) {
        assert.deepEqual((await contacts(source)).map(peer => peer.endpoint_id),
          initiallyEnabled ? [target.registration.endpoint_id] : []);
        const sending = source.connection.sendMessage({
          to: target.registration.endpoint_id, text: 'The first registration fixes participation',
        });
        if (initiallyEnabled) {
          assert.equal((await sending).status, 'accepted');
          assert.equal(target.received.length, 1);
        } else {
          await assert.rejects(sending, { code: ArloErrorCode.CROSS_HOST_DISABLED });
          assert.equal(target.received.length, 0);
        }
      }
    });
}

for (const version of [undefined, '0.1', '99.0']) {
  test(`New adapters reject ${version === undefined ? 'missing' : 'unsupported'} Daemon participation before readiness`,
    { timeout: 5000 }, async t => {
      let registered = false;
      let published = false;
      const server = https.createServer({ cert: DAEMON_CERT, key: DAEMON_KEY }, (req, res) => {
        if (req.url === '/mcp' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'legacy-session' });
          res.flushHeaders();
          return;
        }
        if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const respond = (value: unknown) => {
            res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'legacy-session' });
            res.end(JSON.stringify(value));
          };
          if (req.url === '/control/v1/status') { respond({ status: 'ready', daemon_id: 'legacy-daemon' }); return; }
          if (req.url === '/control/v1/runtimes/register') {
            respond({ runtime_id: 'legacy-runtime', runtime_token: 'legacy-runtime-token' });
            return;
          }
          if (req.url === '/control/v1/roots/register') {
            registered = true;
            respond({ endpoint_id: 'legacy-root', generation: 1, root_token: 'legacy-root-token',
              group_id: 'legacy-group', status: 'registered', ready: false, deliverable: false });
            return;
          }
          if (req.url === '/control/v1/roots/ready') published = true;
          if (req.url !== '/mcp') { respond({ status: 'ok' }); return; }
          const rpc = JSON.parse(body);
          if (rpc.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
          respond({ jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'initialize' ? {
            protocolVersion: '2025-06-18', capabilities: { tools: {}, experimental: {
              'arlo/session-messaging': { version: '0.1' },
              ...(version === undefined ? {} : { 'arlo/cross-host-participation': { version } }),
            } }, serverInfo: { name: 'legacy-daemon', version: '0.1' },
          } : { content: [{ type: 'text', text: '[]' }] } });
        });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const control = new ControlClient({
        pinnedCertPem: DAEMON_CERT, bootstrapToken: 'legacy-bootstrap',
        port: (server.address() as import('node:net').AddressInfo).port,
      });
      const root = {};
      const host: AdapterHost<object> = {
        roots: () => [root], sessionId: () => 'real-root', sessionCwd: () => undefined,
        onCreated: () => () => {}, onDisposed: () => () => {},
        reception: () => ({ instanceId: 'real-root-input',
          snapshot: scope => ({ ...scope, complete: true, pending: [], inFlight: [] }),
          prepare: () => { throw new Error('An unsupported Daemon cannot deliver input'); },
        }),
      };
      const runtime = createAdapterRuntime({
        host, hostType: 'Pi display name', hostKind: 'pi', hostVersion: '1.1.0',
        groupName: 'capability', controlClient: control,
      });
      t.after(async () => {
        await runtime.dispose();
        control.dispose();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await runtime.listSessions(root); }
        catch (error) { if ((error as { code?: string }).code === ArloErrorCode.UNSUPPORTED_PROFILE) break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await assert.rejects(runtime.listSessions(root), { code: ArloErrorCode.UNSUPPORTED_PROFILE });
      await assert.rejects(runtime.listContactSessions(root), { code: ArloErrorCode.UNSUPPORTED_PROFILE });
      assert.equal(registered, true);
      assert.equal(published, false);
    });
}

for (const peerKind of ['pi', 'deepseek-harness']) {
  test(`Claude and ${peerKind} require both preferences in every direction without resetting allowance`, { timeout: 30000 }, async t => {
    const { add, control } = await participationFixture(t);
    const claude = await add('claude-matrix', { host_kind: 'claudecode' });
    const peer = await add('peer-matrix', { host_kind: peerKind });
    await control.fixtureAuthorize(claude.registration);
    await control.fixtureAuthorize(peer.registration);
    const original = await Promise.all([claude, peer].map(root => control.fixtureSendingStatus(root.registration)));
    const admitted = [0, 0];
    for (const [claudeEnabled, peerEnabled] of [[true, true], [false, true], [true, false], [false, false], [true, true]]) {
      await control.updateRuntimeParticipation(claude.runtimeToken, claudeEnabled);
      await control.updateRuntimeParticipation(peer.runtimeToken, peerEnabled);
      for (const [index, source, target] of [[0, claude, peer], [1, peer, claude]] as const) {
        const sending = source.connection.sendMessage({ to: target.registration.endpoint_id, text: 'Bilateral admission matrix' });
        if (claudeEnabled && peerEnabled) {
          assert.equal((await sending).status, 'accepted');
          admitted[index]++;
        } else {
          await assert.rejects(sending, { code: ArloErrorCode.CROSS_HOST_DISABLED });
        }
        const status = await control.fixtureSendingStatus(source.registration);
        assert.equal(status.period_id, original[index].period_id, 'Preference changes retain the allowance period');
        assert.equal(status.used, original[index].used! + admitted[index], 'Only admitted dispatch attempts consume allowance');
      }
    }
    assert.deepEqual([claude.received.length, peer.received.length], [2, 2]);
  });
}
