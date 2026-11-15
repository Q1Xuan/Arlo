import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { ReceptionLedger, type ReceiptResult } from '@arlo/adapter-sdk';
import { createDshReceptionHost } from '@arlo/adapter-dsh/runtime';
import { type ArloMessageNotificationParams, type RootReceiptRequest } from '@arlo/sdk';
import { fixture } from '../probes/fixture.ts';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';

test('A retained pre-insertion rejection recovers after its ACK is lost without inventing a native message', { timeout: 60000 }, async t => {
  const rig = await MessageStatusFixture.create({ roots: 1, ackTimeoutMs: 100 });
  t.after(() => rig.dispose());
  const host = await fixture();
  t.after(() => host.ctx.fiber.dispose());
  const continuity = crypto.randomBytes(32).toString('hex');
  const registration = await rig.control.registerRoot(rig.runtimeToken, {
    root_session_id: String(host.root.agent.session.id), group_name: 'team-status',
    agent_incarnation: crypto.randomUUID(), plugin_generation: 1, continuity_token: continuity,
  });
  const deduplicator = new ReceptionLedger({
    host: createDshReceptionHost(host.root.agent), currentGeneration: registration.generation, initialCapacity: 0,
  });
  const received = Promise.withResolvers<{ frame: ArloMessageNotificationParams; receipt: ReceiptResult }>();
  const connection = rig.control.createRootConnection(registration);
  t.after(() => connection.dispose());
  connection.onNotification(async frame => {
    received.resolve({ frame, receipt: await deduplicator.receiveFrame(frame) });
    // The receiver has the rejection, but its first ACK does not reach the daemon.
  });
  await connection.connect();
  await rig.control.confirmRootReady(registration.root_token, { endpoint_id: registration.endpoint_id });
  const sent = await rig.roots[0]!.connection.sendMessage({ to: registration.endpoint_id, text: 'No capacity for this input' });
  const { frame, receipt } = await received.promise;
  assert.deepEqual(receipt, { status: 'rejected', reason: 'QUEUE_LIMIT' });
  assert.equal(sent.status, 'unknown');
  assert.equal(host.root.agent.inbox.nextTurn.length, 0);
  assert.equal(host.model.requests.length, 0);

  connection.dispose();
  const rotated = await rig.control.connectRoot(rig.runtimeToken, {
    endpoint_id: registration.endpoint_id, continuity_token: continuity,
  });
  const recovered = rig.control.createRootConnection({ ...registration, ...rotated });
  t.after(() => recovered.dispose());
  await recovered.connect();
  deduplicator.advanceGeneration(rotated.generation);
  const evidence = deduplicator.getRetainedEvidence().find(item => item.receipt.message_id === frame.message_id);
  assert.ok(evidence, 'A proven rejection remains available across transport recovery');
  assert.equal(evidence.receipt.status, 'not_enqueued');
  assert.equal(evidence.receipt.native_message_id, undefined);
  await rig.control.submitReceipt(rotated.root_token, evidence.receipt);
  await rig.control.confirmRootReady(rotated.root_token, {
    endpoint_id: registration.endpoint_id, generation: rotated.generation,
    reconciled_pending_message_ids: deduplicator.reconcilePendingMessageIds(),
  });
  const status = await rig.roots[0]!.connection.getMessageStatus(sent.message_id);
  assert.equal(status.status, 'rejected');
  assert.equal(status.original_status, 'unknown');
  assert.equal(status.late_evidence, true);
  assert.equal(status.native_message_id, undefined);
  assert.equal((await rig.control.listRoots(rig.runtimeToken)).find(root => root.endpoint_id === registration.endpoint_id)?.deliverable, true);
  assert.equal(host.model.requests.length, 0);
});

test('Historical rejections still require live continuity, full dispatch identity and any established native association', { timeout: 60000 }, async t => {
  const rig = await MessageStatusFixture.create({ roots: 1, ackTimeoutMs: 100 });
  t.after(() => rig.dispose());
  const continuity = crypto.randomBytes(32).toString('hex');
  const request = {
    root_session_id: 'historical-rejection', group_name: 'team-status',
    agent_incarnation: crypto.randomUUID(), plugin_generation: 1, continuity_token: continuity,
  };
  const registration = await rig.control.registerRoot(rig.runtimeToken, request);
  const connection = rig.control.createRootConnection(registration);
  t.after(() => connection.dispose());
  const frames: ArloMessageNotificationParams[] = [];
  connection.onNotification(frame => { frames.push(frame); });
  await connection.connect();
  await rig.control.confirmRootReady(registration.root_token, { endpoint_id: registration.endpoint_id });
  await rig.roots[0]!.connection.sendMessage({ to: registration.endpoint_id, text: 'No native message was constructed' });
  await rig.roots[0]!.connection.sendMessage({ to: registration.endpoint_id, text: 'A native message is already associated' });
  assert.equal(frames.length, 2);
  const negative = (frame: ArloMessageNotificationParams): RootReceiptRequest => ({
    daemon_id: frame.daemon_id, endpoint_id: frame.to_endpoint, message_id: frame.message_id,
    delivery_id: frame.delivery_id, generation: frame.target_generation, status: 'not_enqueued', reason: 'QUEUE_LIMIT',
  });
  const absent = negative(frames[0]!);
  const associated = negative(frames[1]!);
  await rig.control.submitReceipt(registration.root_token, {
    ...associated, status: 'uncertain', native_message_id: 'existing-native-message',
  });
  connection.dispose();
  const rotated = await rig.control.connectRoot(rig.runtimeToken, {
    endpoint_id: registration.endpoint_id, continuity_token: continuity,
  });

  await assert.rejects(rig.control.submitReceipt(registration.root_token, absent), { code: 'STALE_GENERATION' });
  await assert.rejects(rig.control.submitReceipt(rig.runtimeToken, absent), { code: 'BINDING_MISMATCH' });
  for (const changed of [
    { daemon_id: 'different-daemon' }, { delivery_id: 'different-dispatch' },
    { generation: rotated.generation },
    { status: 'enqueued' as const }, { status: 'uncertain' as const },
  ]) {
    await assert.rejects(rig.control.submitReceipt(rotated.root_token, { ...absent, ...changed }), { code: 'BINDING_MISMATCH' });
  }
  await assert.rejects(rig.control.submitReceipt(rotated.root_token, {
    ...absent, endpoint_id: rig.roots[0]!.registration.endpoint_id,
  }), { code: 'UNAUTHORIZED' });
  await assert.rejects(rig.control.submitReceipt(rotated.root_token, associated), { code: 'BINDING_MISMATCH' });
  await assert.rejects(rig.control.submitReceipt(rotated.root_token, {
    ...associated, native_message_id: 'different-native-message',
  }), { code: 'BINDING_MISMATCH' });

  // The same endpoint without continuity must not inherit even negative proof.
  const unproven = await rig.control.connectRoot(rig.runtimeToken, { endpoint_id: registration.endpoint_id });
  await assert.rejects(rig.control.submitReceipt(unproven.root_token, absent), { code: 'BINDING_MISMATCH' });
  await rig.control.revokeRoot(rig.runtimeToken, { endpoint_id: registration.endpoint_id });
  const replacement = await rig.control.registerRoot(rig.runtimeToken, {
    ...request, agent_incarnation: crypto.randomUUID(), continuity_token: crypto.randomBytes(32).toString('hex'),
  });
  await assert.rejects(rig.control.submitReceipt(replacement.root_token, {
    ...absent, endpoint_id: replacement.endpoint_id,
  }), { code: 'BINDING_MISMATCH' });
  assert.equal((await rig.roots[0]!.connection.getMessageStatus(absent.message_id)).status, 'unknown');
  assert.equal((await rig.roots[0]!.connection.getMessageStatus(associated.message_id)).status, 'unknown');
});
