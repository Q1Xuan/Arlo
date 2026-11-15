import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CONCURRENT_IN_FLIGHT_ACKS, DEFAULT_ACK_TIMEOUT_MS, ArloErrorCode, type ArloMessageNotificationParams } from '@arlo/sdk';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';

test('The default 64 pending ACK limit is independent of per-root count and byte budgets', { timeout: 90000 }, async (t) => {
  const rig = await MessageStatusFixture.create({ roots: 3, leaseNow: () => 0,
    rootHeartbeat: false, sendRequestTimeoutMs: 90000 });
  // Isolate capacity from machine load: keep the real sockets and protocol,
  // but advance ACK deadlines explicitly instead of racing wall-clock timers.
  // Freeze transport leases too: real durable human grants must not turn this
  // capacity assertion into a machine-dependent connection-expiry assertion.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const notifications: ArloMessageNotificationParams[] = [];
  const waiting = Promise.withResolvers<void>();
  const replacement = Promise.withResolvers<void>();
  const sends: ReturnType<MessageStatusFixture['send']>[] = [];
  let settled = 0;
  const acknowledge = async (frame: ArloMessageNotificationParams) => {
    const receiver = rig.roots.find((root) => root.registration.endpoint_id === frame.to_endpoint)!;
    await rig.control.submitReceipt(receiver.registration.root_token, {
      daemon_id: frame.daemon_id,
      endpoint_id: frame.to_endpoint,
      message_id: frame.message_id,
      delivery_id: frame.delivery_id,
      generation: frame.target_generation,
      status: 'enqueued',
      native_message_id: `native-${frame.message_id}`,
    });
  };
  try {
    for (const root of rig.roots.slice(1)) {
      root.onNotification((frame) => {
        notifications.push(frame);
        if (notifications.length === MAX_CONCURRENT_IN_FLIGHT_ACKS) waiting.resolve();
        if (notifications.length === MAX_CONCURRENT_IN_FLIGHT_ACKS + 1) replacement.resolve();
      });
    }
    // Each receiver holds only 32 short messages, below both per-root limits.
    for (let i = 0; i < MAX_CONCURRENT_IN_FLIGHT_ACKS; i++) {
      const sent = rig.send(0, 1 + i % 2, `awaiting-ack-${i}`);
      sends.push(sent);
      void sent.then(() => settled++, () => settled++);
    }
    await Promise.race([
      waiting.promise,
      Promise.any(sends).then(result => assert.fail(`A send completed before the ACK window filled: ${JSON.stringify(result)}`)),
    ]);
    assert.equal(settled, 0, 'All 64 sends must still be waiting for a receipt');
    const beforeOverflow = await rig.control.fixtureSendingStatus(rig.roots[0]!.registration);
    await assert.rejects(rig.send(0, 1, 'ack-window-overflow'), (error: any) => error.code === ArloErrorCode.RATE_LIMITED);
    assert.equal(notifications.length, MAX_CONCURRENT_IN_FLIGHT_ACKS);
    const afterOverflow = await rig.control.fixtureSendingStatus(rig.roots[0]!.registration);
    assert.equal(afterOverflow.period_id, beforeOverflow.period_id);
    assert.equal(afterOverflow.used, beforeOverflow.used, 'The ACK capacity refusal consumes no autonomous attempt');

    await acknowledge(notifications[0]!);
    const resumed = rig.send(0, 1, 'one-released-ack-slot');
    sends.push(resumed);
    void resumed.catch(() => {});
    await Promise.race([
      replacement.promise,
      resumed.then(() => assert.fail('The replacement send completed before its notification')),
    ]);
    assert.equal(notifications.length, MAX_CONCURRENT_IN_FLIGHT_ACKS + 1);
    await assert.rejects(rig.send(0, 2, 'ack-window-full-again'), (error: any) => error.code === ArloErrorCode.RATE_LIMITED);

    t.mock.timers.tick(DEFAULT_ACK_TIMEOUT_MS);
    const results = await Promise.all(sends);
    assert.equal(results.filter((result) => result.status === 'accepted').length, 1);
    const timedOut = results.filter((result) => result.status === 'unknown');
    assert.equal(timedOut.length, MAX_CONCURRENT_IN_FLIGHT_ACKS);
    assert.ok(timedOut.every((result) => result.reason === ArloErrorCode.ACK_TIMEOUT));

    const nextNotification = rig.roots[2]!.nextNotification();
    const afterTimeout = rig.send(0, 2, 'after-ack-timeout');
    sends.push(afterTimeout);
    void afterTimeout.catch(() => {});
    await acknowledge(await nextNotification);
    assert.equal((await afterTimeout).status, 'accepted', 'Expired ACK waits free their ACK slots');
    const ids = rig.roots[1]!.notifications.map((frame) => frame.message_id);
    await assert.rejects(
      rig.control.confirmRootReady(rig.roots[1]!.registration.root_token, {
        endpoint_id: rig.roots[1]!.registration.endpoint_id,
        reconciled_pending_message_ids: [],
      }),
      (error: any) => error.code === ArloErrorCode.ACCOUNTING_UNAVAILABLE,
      'Neither ACK nor timeout releases the host pending credit'
    );
    assert.equal(ids.length, 33);
  } finally {
    await Promise.all(notifications.map((frame) => acknowledge(frame).catch(() => {})));
    await rig.dispose();
    await Promise.allSettled(sends);
  }
});
