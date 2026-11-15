import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArloErrorCode, MAX_SINGLE_TEXT_BYTES, type ArloMessageNotificationParams, type RootReceiptRequest } from '@arlo/sdk';
import { MessageStatusFixture, TestClock } from './helpers/message-status-fixture.ts';
import { UNPACED_RATE_LIMIT } from './test-utils.ts';

function receipt(frame: ArloMessageNotificationParams, status: RootReceiptRequest['status']): RootReceiptRequest {
  return { daemon_id: frame.daemon_id, endpoint_id: frame.to_endpoint, message_id: frame.message_id,
    delivery_id: frame.delivery_id, generation: frame.target_generation, status };
}
const rejectsWith = (code: string) => (error: { code?: string }) => error.code === code;

test('Expired results retain bounded replay protection even when the tracking budget is full', async () => {
  const clock = new TestClock();
  const f = await MessageStatusFixture.create({ now: clock.now, messageRecordTtlMs: 100, maxTrackedMessages: 2 });
  try {
    f.roots[1].onNotification(async (frame, root) => {
      await f.control.submitReceipt(root.registration.root_token, receipt(frame, 'not_enqueued'));
    });
    const first = await f.send(0, 1, 'same payload');
    clock.advance(101);
    assert.equal((await f.roots[0].connection.getMessageStatus(first.message_id)).status, 'result_unavailable');
    await assert.rejects(f.send(0, 1, 'same payload', first.message_id), rejectsWith(ArloErrorCode.REPLAY_RESULT_UNAVAILABLE));
    await assert.rejects(f.send(0, 1, 'changed payload', first.message_id), rejectsWith(ArloErrorCode.REPLAY_RESULT_UNAVAILABLE));
    const second = await f.send(0, 1, 'second');
    clock.advance(101);
    assert.equal((await f.roots[0].connection.getMessageStatus(second.message_id)).status, 'result_unavailable');
    await assert.rejects(f.send(0, 1, 'over budget'), rejectsWith(ArloErrorCode.ACCOUNTING_UNAVAILABLE));
    assert.equal(f.roots[1].notifications.length, 2);
  } finally { await f.dispose(); }
});

test('Malformed receipt status and metadata cannot change unknown or leak into queries', async () => {
  const f = await MessageStatusFixture.create();
  try {
    const root = f.roots[1];
    root.onNotification(async frame => { await f.control.submitReceipt(root.registration.root_token, receipt(frame, 'uncertain')); });
    const sent = await f.send(0, 1, 'private message');
    const frame = f.frameFor(1, sent.message_id);
    for (const invalid of [
      { status: 'bogus' }, { status: {} }, { reason: 'private canary' }, { reason: { text: 'private canary' } },
      { native_message_id: {} }, { native_message_id: '' }, { native_message_id: 'x'.repeat(1025) },
    ]) {
      await assert.rejects(f.control.submitReceipt(root.registration.root_token,
        { ...receipt(frame, 'not_enqueued'), ...invalid } as RootReceiptRequest), rejectsWith(ArloErrorCode.INVALID_ARGUMENT));
      const result = await f.roots[0].connection.getMessageStatus(sent.message_id);
      assert.equal(result.status, 'unknown');
      assert.ok(!JSON.stringify(result).includes('private canary'));
    }
    await f.control.submitReceipt(root.registration.root_token, receipt(frame, 'enqueued'));
    assert.equal((await f.roots[0].connection.getMessageStatus(sent.message_id)).status, 'accepted');
  } finally { await f.dispose(); }
});

test('Native receipt associations must match before a duplicate or conflict can be recorded', async () => {
  const f = await MessageStatusFixture.create();
  try {
    const root = f.roots[1];
    root.onNotification(async frame => { await f.control.submitReceipt(root.registration.root_token,
      { ...receipt(frame, 'enqueued'), native_message_id: 'native-A' }); });
    const sent = await f.send(0, 1, 'native association');
    const frame = f.frameFor(1, sent.message_id);
    for (const status of ['enqueued', 'not_enqueued', 'uncertain'] as const) {
      for (const native_message_id of ['native-B', undefined]) {
        await assert.rejects(f.control.submitReceipt(root.registration.root_token,
          { ...receipt(frame, status), native_message_id }), rejectsWith(ArloErrorCode.BINDING_MISMATCH));
      }
    }
    assert.equal((await f.roots[0].connection.getMessageStatus(sent.message_id)).status, 'accepted');
    assert.ok(await f.waitForDeliverable(1, true));
    await assert.rejects(f.control.submitReceipt(root.registration.root_token,
      { ...receipt(frame, 'not_enqueued'), native_message_id: 'native-A' }), rejectsWith(ArloErrorCode.RECEIPT_CONFLICT));
  } finally { await f.dispose(); }
});

test('Consumed unknown records survive expiry and establish native identity before the ACK', async () => {
  const clock = new TestClock();
  const f = await MessageStatusFixture.create({ now: clock.now, messageRecordTtlMs: 100, maxTrackedMessages: 1 });
  try {
    const root = f.roots[1];
    root.onNotification(async frame => {
      await f.control.releaseCredit(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id, message_id: frame.message_id, native_message_id: 'claimed-A', event: 'claimed',
      });
      await f.control.submitReceipt(root.registration.root_token, { ...receipt(frame, 'uncertain'), native_message_id: 'claimed-A' });
    });
    const sent = await f.send(0, 1, 'claimed before ACK');
    clock.advance(101);
    assert.equal((await f.roots[0].connection.getMessageStatus(sent.message_id)).status, 'unknown');
    await assert.rejects(f.send(0, 1, 'capacity pressure'), rejectsWith(ArloErrorCode.ACCOUNTING_UNAVAILABLE));
    const frame = f.frameFor(1, sent.message_id);
    await assert.rejects(f.control.submitReceipt(root.registration.root_token,
      { ...receipt(frame, 'enqueued'), native_message_id: 'claimed-B' }), rejectsWith(ArloErrorCode.BINDING_MISMATCH));
    await f.control.submitReceipt(root.registration.root_token, { ...receipt(frame, 'enqueued'), native_message_id: 'claimed-A' });
    const result = await f.roots[0].connection.getMessageStatus(sent.message_id);
    assert.equal(result.status, 'accepted');
    assert.equal(result.original_status, 'unknown');
    clock.advance(101);
    assert.equal((await f.roots[0].connection.getMessageStatus(sent.message_id)).status, 'result_unavailable');
  } finally { await f.dispose(); }
});

test('Rejected then accepted conflicts reserve global credit exactly once, including after target exit', async () => {
  const f = await MessageStatusFixture.create({ roots: 10, rateLimit: UNPACED_RATE_LIMIT });
  try {
    const target = f.roots[1];
    target.onNotification(async frame => { await f.control.submitReceipt(target.registration.root_token, receipt(frame, 'not_enqueued')); });
    const payload = 'x'.repeat(MAX_SINGLE_TEXT_BYTES);
    const sent = await f.send(0, 1, payload);
    const frame = f.frameFor(1, sent.message_id);
    for (let i = 0; i < 2; i++) {
      await assert.rejects(f.control.submitReceipt(target.registration.root_token,
        { ...receipt(frame, 'enqueued'), native_message_id: 'conflicting-native' }), rejectsWith(ArloErrorCode.RECEIPT_CONFLICT));
    }
    await f.control.revokeRoot(target.registration.root_token, { endpoint_id: target.registration.endpoint_id });
    for (const root of f.roots.slice(2)) {
      root.onNotification(async p => { await f.control.submitReceipt(root.registration.root_token, receipt(p, 'enqueued')); });
    }
    // 8 MiB permits 256 full-size reservations. The conflict still owns one.
    for (let i = 0; i < 255; i++) assert.equal((await f.send(0, 2 + Math.floor(i / 32), payload)).status, 'accepted');
    await assert.rejects(f.send(0, 9, payload), rejectsWith(ArloErrorCode.QUEUE_LIMIT));
  } finally { await f.dispose(); }
});
