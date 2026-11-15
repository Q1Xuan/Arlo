import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import { test } from 'node:test';
import { createPinnedHttpsAgent, readBootstrapToken, readDiscoveryRecord, sendSecureArloRequest } from '@arlo/sdk';
import { MessageStatusFixture, TestClock } from './helpers/message-status-fixture.ts';

test('An expired connection lease revokes readiness before the next dispatch', { timeout: 60000 }, async t => {
  const clock = new TestClock();
  const rig = await MessageStatusFixture.create({ leaseNow: clock.now });
  t.after(() => rig.dispose());
  clock.advance(20000);
  const roots = await rig.control.listRoots(rig.runtimeToken);
  assert.ok(roots.every(root => !root.ready && !root.deliverable));
  await assert.rejects(rig.control.confirmRootReady(rig.roots[1]!.registration.root_token, {
    endpoint_id: rig.roots[1]!.registration.endpoint_id,
  }), { code: 'STALE_GENERATION' });
});

test('Historical dispatch evidence requires an uninterrupted live binding proof', { timeout: 60000 }, async t => {
  const rig = await MessageStatusFixture.create({ roots: 1 });
  t.after(() => rig.dispose());
  const continuity = crypto.randomBytes(32).toString('hex');
  const receiver = await rig.control.registerRoot(rig.runtimeToken, {
    root_session_id: 'historical-root', agent_incarnation: 'historical-agent', plugin_generation: 1,
    group_name: 'team-status', continuity_token: continuity,
  });
  const connection = rig.control.createRootConnection(receiver);
  t.after(() => connection.dispose());
  const received = Promise.withResolvers<import('@arlo/sdk').ArloMessageNotificationParams>();
  connection.onNotification(frame => { received.resolve(frame); });
  await connection.connect();
  await rig.control.confirmRootReady(receiver.root_token, { endpoint_id: receiver.endpoint_id });
  const sending = rig.roots[0]!.connection.sendMessage({ to: receiver.endpoint_id, text: 'lost ACK' });
  const frame = await received.promise;
  connection.dispose();
  assert.equal((await sending).status, 'unknown');
  const rotated = await rig.control.connectRoot(rig.runtimeToken, {
    endpoint_id: receiver.endpoint_id, continuity_token: continuity,
  });
  const proof = {
    daemon_id: frame.daemon_id, endpoint_id: frame.to_endpoint, message_id: frame.message_id,
    delivery_id: frame.delivery_id, generation: frame.target_generation,
    status: 'enqueued' as const, native_message_id: 'native-retained',
  };
  await assert.rejects(rig.control.submitReceipt(receiver.root_token, proof), { code: 'STALE_GENERATION' });
  await assert.rejects(rig.control.submitReceipt(rotated.root_token, { ...proof, native_message_id: undefined }),
    { code: 'BINDING_MISMATCH' });
  assert.equal((await rig.roots[0]!.connection.getMessageStatus(frame.message_id)).status, 'unknown');
  await rig.control.submitReceipt(rotated.root_token, proof);
  assert.equal((await rig.roots[0]!.connection.getMessageStatus(frame.message_id)).status, 'accepted');
  await assert.rejects(rig.control.releaseCredit(rotated.root_token, {
    endpoint_id: receiver.endpoint_id, message_id: frame.message_id, event: 'claimed', native_message_id: 'native-retained',
  }), { code: 'BINDING_MISMATCH' });
  await rig.control.releaseCredit(rotated.root_token, { ...proof, event: 'claimed' });
  const unproven = await rig.control.connectRoot(rig.runtimeToken, { endpoint_id: receiver.endpoint_id });
  await assert.rejects(rig.control.submitReceipt(unproven.root_token, proof), { code: 'BINDING_MISMATCH' });
  await assert.rejects(rig.control.releaseCredit(unproven.root_token, {
    ...proof, event: 'claimed',
  }), { code: 'BINDING_MISMATCH' });
});

test('Readiness waiting for its body cannot publish over a newer root generation', { timeout: 60000 }, async t => {
  const rig = await MessageStatusFixture.create({ roots: 1 });
  t.after(() => rig.dispose());
  const root = rig.roots[0]!.registration;
  const discovery = readDiscoveryRecord(rig.stateDir);
  const agent = createPinnedHttpsAgent(discovery.cert_pem);
  t.after(() => agent.destroy());
  const body = Buffer.from(JSON.stringify({ endpoint_id: root.endpoint_id, generation: root.generation }));
  const pending = Promise.withResolvers<number>();
  const request = https.request(`https://127.0.0.1:${discovery.port}/control/v1/roots/ready`, {
    agent, method: 'POST', headers: {
      authorization: `Bearer ${rig.runtimeToken}`, 'content-type': 'application/json', 'content-length': body.length,
    },
  }, response => { response.resume(); response.on('end', () => pending.resolve(response.statusCode!)); });
  request.on('error', pending.reject);
  await new Promise<void>((resolve, reject) => request.write(body.subarray(0, 1), error => error ? reject(error) : resolve()));
  const rotated = await rig.control.connectRoot(rig.runtimeToken, { endpoint_id: root.endpoint_id });
  const connection = rig.control.createRootConnection({ ...root, ...rotated });
  t.after(() => connection.dispose());
  await connection.connect();
  await rig.control.confirmRootReady(rotated.root_token, { endpoint_id: root.endpoint_id, generation: rotated.generation });
  request.end(body.subarray(1));
  assert.equal(await pending.promise, 403);
  const current = (await rig.control.listRoots(rig.runtimeToken))[0]!;
  assert.equal(current.generation, rotated.generation);
  assert.equal(current.ready, true);
});

test('Only the current root connection heartbeat renews its lease', { timeout: 60000 }, async t => {
  const clock = new TestClock();
  const rig = await MessageStatusFixture.create({ leaseNow: clock.now });
  t.after(() => rig.dispose());
  const discovery = readDiscoveryRecord(rig.stateDir);
  const agent = createPinnedHttpsAgent(discovery.cert_pem);
  t.after(() => agent.destroy());
  const root = rig.roots[1]!.registration;
  const heartbeat = (generation: number) => sendSecureArloRequest({
    url: `https://127.0.0.1:${discovery.port}/control/v1/roots/heartbeat`, agent,
    token: root.root_token, body: JSON.stringify({ endpoint_id: root.endpoint_id, generation }),
  });
  clock.advance(19000);
  assert.equal((await heartbeat(root.generation)).status, 200);
  clock.advance(1000);
  const roots = await rig.control.listRoots(rig.runtimeToken);
  assert.equal(roots.find(entry => entry.endpoint_id === root.endpoint_id)?.ready, true);
  assert.equal(roots.find(entry => entry.endpoint_id !== root.endpoint_id)?.ready, false);
  assert.equal((await heartbeat(root.generation + 1)).status, 403);
  clock.advance(19000);
  assert.equal((await heartbeat(root.generation)).status, 403);
});

test('Only a current authenticated root can update its bounded discovery title', { timeout: 60000 }, async t => {
  const rig = await MessageStatusFixture.create();
  t.after(() => rig.dispose());
  const root = rig.roots[1]!.registration;
  const discovery = readDiscoveryRecord(rig.stateDir);
  const agent = createPinnedHttpsAgent(discovery.cert_pem);
  t.after(() => agent.destroy());
  const heartbeat = (displayName: unknown, token = root.root_token, generation = root.generation) => sendSecureArloRequest({
    url: `https://127.0.0.1:${discovery.port}/control/v1/roots/heartbeat`, agent, token,
    body: JSON.stringify({ endpoint_id: root.endpoint_id, generation, display_name: displayName }),
  });
  const publishedTitle = async () => {
    const content = await rig.roots[0]!.connection.listSessions();
    const roots = JSON.parse(content[0]!.text) as { endpoint_id: string; display_name?: string }[];
    return roots.find(item => item.endpoint_id === root.endpoint_id)?.display_name;
  };
  assert.equal((await heartbeat('Published')).status, 200);
  assert.equal(await publishedTitle(), 'Published');
  for (const invalid of [42, {}, ['title'], '界'.repeat(1366)]) {
    assert.equal((await heartbeat(invalid)).status, 400);
    assert.equal(await publishedTitle(), 'Published');
  }
  for (const token of [rig.runtimeToken, rig.roots[0]!.registration.root_token]) {
    assert.equal((await heartbeat('Forged', token)).status, 403);
    assert.equal(await publishedTitle(), 'Published');
  }
  assert.equal((await heartbeat('Stale', root.root_token, root.generation + 1)).status, 403);
  assert.equal(await publishedTitle(), 'Published');
  assert.equal((await heartbeat(undefined)).status, 200);
  assert.equal(await publishedTitle(), 'Published', 'Older clients omitting the title preserve it');
  const maxTitle = '界'.repeat(1365) + 'a';
  assert.equal((await heartbeat(maxTitle)).status, 200);
  assert.equal(await publishedTitle(), maxTitle);
  assert.equal((await heartbeat(null)).status, 200);
  assert.equal(await publishedTitle(), undefined);
  assert.equal(rig.roots.reduce((count, entry) => count + entry.notifications.length, 0), 0);
});

test('Runtime reauthentication requires its retained secret and invalidates previous credentials even after a lost response', { timeout: 60000 }, async t => {
  const rig = await MessageStatusFixture.create({ roots: 0 });
  t.after(() => rig.dispose());
  const secret = crypto.randomBytes(32).toString('hex');
  const runtime = await rig.control.registerRuntime({ continuity_token: secret });
  const root = await rig.control.registerRoot(runtime.runtime_token, {
    root_session_id: 'runtime-root', agent_incarnation: 'runtime-agent', plugin_generation: 1,
    group_name: 'runtime-group',
  });
  const discovery = readDiscoveryRecord(rig.stateDir);
  const agent = createPinnedHttpsAgent(discovery.cert_pem);
  t.after(() => agent.destroy());
  const reauthenticate = (proof: string) => sendSecureArloRequest({
    url: `https://127.0.0.1:${discovery.port}/control/v1/runtimes/reauthenticate`, agent,
    token: readBootstrapToken(rig.stateDir),
    body: JSON.stringify({ runtime_id: runtime.runtime_id, continuity_token: proof }),
  });
  assert.equal((await reauthenticate(crypto.randomBytes(32).toString('hex'))).status, 403);
  assert.equal((await reauthenticate(secret)).status, 200);
  const recovered = JSON.parse((await reauthenticate(secret)).body);
  assert.equal(recovered.runtime_id, runtime.runtime_id);
  await assert.rejects(rig.control.listRoots(runtime.runtime_token), { code: 'STALE_GENERATION' });
  await assert.rejects(rig.control.connectRoot(root.root_token, { endpoint_id: root.endpoint_id }), { code: 'STALE_GENERATION' });
  const connected = await rig.control.connectRoot(recovered.runtime_token, { endpoint_id: root.endpoint_id });
  assert.equal(connected.generation, root.generation + 1);
});

test('Lost registration responses recover the same identities only with the original live-instance secrets', { timeout: 60000 }, async t => {
  const rig = await MessageStatusFixture.create({ roots: 0 });
  t.after(() => rig.dispose());
  const runtimeRequest = { runtime_id: crypto.randomUUID(), continuity_token: crypto.randomBytes(32).toString('hex') };
  const firstRuntime = await rig.control.registerRuntime(runtimeRequest);
  const recoveredRuntime = await rig.control.registerRuntime(runtimeRequest);
  assert.equal(recoveredRuntime.runtime_id, firstRuntime.runtime_id);
  assert.notEqual(recoveredRuntime.runtime_token, firstRuntime.runtime_token);
  const rootRequest = { root_session_id: 'registration-root', agent_incarnation: 'registration-agent',
    plugin_generation: 1, group_name: 'registration-group', continuity_token: crypto.randomBytes(32).toString('hex') };
  const firstRoot = await rig.control.registerRoot(recoveredRuntime.runtime_token, rootRequest);
  const recoveredRoot = await rig.control.registerRoot(recoveredRuntime.runtime_token, rootRequest);
  assert.equal(recoveredRoot.endpoint_id, firstRoot.endpoint_id);
  assert.equal(recoveredRoot.generation, firstRoot.generation + 1);
  assert.notEqual(recoveredRoot.root_token, firstRoot.root_token);
  for (const changed of [{ agent_incarnation: 'replacement' }, { plugin_generation: 2 }, { group_name: 'other' },
    { continuity_token: crypto.randomBytes(32).toString('hex') }]) {
    await assert.rejects(rig.control.registerRoot(recoveredRuntime.runtime_token, { ...rootRequest, ...changed }),
      { code: 'BINDING_MISMATCH' });
  }
});
