import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type RootCreditReleaseRequest } from '@arlo/sdk';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';

test('Snapshot credit requires its authorized original dispatch and never turns an unknown receipt into acceptance', { timeout: 30000 }, async t => {
  const rig = await MessageStatusFixture.create({ roots: 2, ackTimeoutMs: 100 });
  t.after(() => rig.dispose());
  const [sender, receiver] = rig.roots;
  receiver.onNotification(frame => rig.control.submitReceipt(receiver.registration.root_token, {
    daemon_id: frame.daemon_id, endpoint_id: frame.to_endpoint, message_id: frame.message_id,
    delivery_id: frame.delivery_id, generation: frame.target_generation,
    native_message_id: `native-${frame.message_id}`, status: 'uncertain',
  }).then(() => {}));
  const sent = await rig.send(0, 1, 'Unknown insertion may later leave the complete snapshot');
  assert.equal(sent.status, 'unknown');
  const frame = rig.frameFor(1, sent.message_id);
  const proof: RootCreditReleaseRequest = {
    daemon_id: frame.daemon_id, endpoint_id: frame.to_endpoint, message_id: frame.message_id,
    delivery_id: frame.delivery_id, generation: frame.target_generation,
    native_message_id: `native-${frame.message_id}`, event: 'snapshot',
  };
  for (const key of ['daemon_id', 'delivery_id', 'generation', 'native_message_id'] as const) {
    const incomplete = { ...proof };
    delete incomplete[key];
    await assert.rejects(rig.control.releaseCredit(receiver.registration.root_token, incomplete), { code: 'INVALID_ARGUMENT' });
  }
  for (const forged of [
    { ...proof, daemon_id: 'different-daemon' }, { ...proof, delivery_id: 'different-delivery' },
    { ...proof, generation: frame.target_generation + 1 }, { ...proof, native_message_id: 'different-native' },
    { ...proof, endpoint_id: sender.registration.endpoint_id },
  ]) {
    await assert.rejects(rig.control.releaseCredit(receiver.registration.root_token, forged),
      error => ['BINDING_MISMATCH', 'UNAUTHORIZED'].includes((error as { code: string }).code));
  }
  await assert.rejects(rig.control.releaseCredit(sender.registration.root_token, proof), { code: 'UNAUTHORIZED' });
  await rig.control.confirmRootReady(receiver.registration.root_token, {
    endpoint_id: frame.to_endpoint, generation: frame.target_generation, reconciled_pending_message_ids: [sent.message_id],
  });
  await rig.control.releaseCredit(receiver.registration.root_token, proof);
  await rig.control.releaseCredit(receiver.registration.root_token, proof);
  await rig.control.confirmRootReady(receiver.registration.root_token, {
    endpoint_id: frame.to_endpoint, generation: frame.target_generation, reconciled_pending_message_ids: [],
  });
  const status = await sender.connection.getMessageStatus(sent.message_id);
  assert.ok(status.status === 'unknown');
  assert.equal(status.original_status, 'unknown');
  const receipt = { ...proof, daemon_id: frame.daemon_id, generation: frame.target_generation, delivery_id: frame.delivery_id };
  await rig.control.submitReceipt(receiver.registration.root_token, { ...receipt, status: 'enqueued' });
  await assert.rejects(rig.control.submitReceipt(receiver.registration.root_token, { ...receipt, status: 'not_enqueued' }),
    { code: 'RECEIPT_CONFLICT' });
  await assert.rejects(rig.control.releaseCredit(receiver.registration.root_token, proof), { code: 'ACCOUNTING_UNAVAILABLE' });
});
