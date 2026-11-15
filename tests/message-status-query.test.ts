import { AuthorizedControlClient as ControlClient } from './helpers/authorized-control.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArloErrorCode, type ArloMessageNotificationParams } from '@arlo/sdk';
import { ArloDaemon } from '@arlo/daemon';
import { MessageStatusFixture, TestClock } from './helpers/message-status-fixture.ts';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from './test-utils.ts';

/** Submits a receipt derived from the notification frame itself. */
function receiptFrom(
  params: ArloMessageNotificationParams,
  status: 'enqueued' | 'not_enqueued' | 'uncertain',
  extra: { reason?: string; native_message_id?: string } = {}
) {
  return {
    daemon_id: params.daemon_id,
    message_id: params.message_id,
    delivery_id: params.delivery_id,
    generation: params.target_generation,
    status,
    ...extra,
  };
}

test('arlo_get_message_status returns receipt metadata for the sending root only, never message text', async () => {
  const fixture = await MessageStatusFixture.create();
  try {
    fixture.roots[1].onNotification(async (params, root) => {
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id,
        ...receiptFrom(params, 'enqueued', { native_message_id: 'native-status-1' }),
      });
    });

    const sent = await fixture.send(0, 1, 'status query secret body');
    assert.equal(sent.status, 'accepted');

    const status = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    assert.notEqual(status.status, 'result_unavailable');
    assert.equal(status.status, 'accepted');
    assert.equal(status.message_id, sent.message_id);
    assert.equal(status.from_endpoint, fixture.roots[0].registration.endpoint_id);
    assert.equal(status.to_endpoint, fixture.roots[1].registration.endpoint_id);
    assert.equal(status.original_status, 'accepted');
    assert.equal(status.native_message_id, 'native-status-1');
    assert.equal(status.delivery_seq, '1');

    // Fixed metadata only: no text, no task completion, no credential material.
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes('status query secret body'), 'query must not return the message body');
    const raw = status as unknown as Record<string, unknown>;
    assert.equal(raw.text, undefined);
    assert.equal(raw.pendingCredit, undefined);
    assert.equal(raw.root_token, undefined);
    assert.ok(!serialized.includes('root_token'), 'query must not leak credentials');
    assert.ok(!serialized.includes('mcp-sess-'), 'query must not leak MCP session IDs');
  } finally {
    await fixture.dispose();
  }
});

test('An unknown record, a foreign caller, and a replacement daemon all return RESULT_UNAVAILABLE', async () => {
  const fixture = await MessageStatusFixture.create();
  let replacementStateDir: string | undefined;
  let replacement: ArloDaemon | undefined;
  try {
    // Unknown message ID for this daemon lifetime.
    const unknown = await fixture.roots[0].connection.getMessageStatus('msg-never-sent');
    assert.equal(unknown.status, 'result_unavailable');
    assert.equal(unknown.reason, ArloErrorCode.RESULT_UNAVAILABLE);
    assert.equal(unknown.daemon_id, fixture.daemon.daemonId);
    assert.match(unknown.detail, /does not prove the message was never enqueued/i);

    // A root that did not send the message cannot observe the record.
    fixture.roots[1].onNotification(async (params, root) => {
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id,
        ...receiptFrom(params, 'enqueued'),
      });
    });
    const sent = await fixture.send(0, 1, 'owned by root zero');
    const bySender = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    assert.equal(bySender.status, 'accepted');

    const byOtherRoot = await fixture.roots[1].connection.getMessageStatus(sent.message_id);
    assert.equal(byOtherRoot.status, 'result_unavailable');
    assert.equal(byOtherRoot.reason, ArloErrorCode.RESULT_UNAVAILABLE);

    // A replacement daemon deliberately reuses the same state directory: the
    // identity changes and no record is recovered from the previous instance's
    // audit logs.
    replacementStateDir = createTempDir('message-status-replacement');
    const first = new ArloDaemon({ stateDir: replacementStateDir });
    const firstStarted = await first.start();
    const firstControl = new ControlClient({ stateDir: replacementStateDir, port: firstStarted.port });
    const firstRuntime = await firstControl.registerRuntime({ host_type: 'deepseek-harness' });
    const firstRoot = await firstControl.registerRoot(firstRuntime.runtime_token, {
      root_session_id: 'replacement-root',
      group_name: 'team-replacement',
      agent_incarnation: 'inc-replacement',
      plugin_generation: 1,
    });
    const firstConnection = firstControl.createRootConnection(firstRoot);
    await firstConnection.connect();
    await firstControl.confirmRootReady(firstRoot.root_token, { endpoint_id: firstRoot.endpoint_id });
    const beforeRestart = await firstConnection.getMessageStatus(sent.message_id);
    assert.equal(beforeRestart.status, 'result_unavailable');
    assert.equal(beforeRestart.daemon_id, first.daemonId);
    const firstDaemonId = first.daemonId;
    firstConnection.dispose();
    await first.stop();

    replacement = new ArloDaemon({ stateDir: replacementStateDir });
    const { port } = await replacement.start();
    assert.notEqual(replacement.daemonId, firstDaemonId, 'a replacement daemon must have a new identity');
    const replacementControl = new ControlClient({ stateDir: replacementStateDir, port });
    const runtime = await replacementControl.registerRuntime({ host_type: 'deepseek-harness' });
    const root = await replacementControl.registerRoot(runtime.runtime_token, {
      root_session_id: 'after-restart-root',
      group_name: 'team-replacement',
      agent_incarnation: 'inc-after-restart',
      plugin_generation: 1,
    });
    const connection = replacementControl.createRootConnection(root);
    try {
      await connection.connect();
      await replacementControl.confirmRootReady(root.root_token, { endpoint_id: root.endpoint_id });
      // The replacement cannot answer for the previous instance's records.
      const afterReplacement = await connection.getMessageStatus(sent.message_id);
      assert.equal(afterReplacement.status, 'result_unavailable');
      assert.equal(afterReplacement.daemon_id, replacement.daemonId);
    } finally {
      connection.dispose();
    }
  } finally {
    await replacement?.stop().catch(() => {});
    if (replacementStateDir) removeTempDir(replacementStateDir);
    await fixture.dispose();
  }
});

test('Late evidence clarifies unknown without rewriting the returned send result or re-dispatching', async () => {
  const fixture = await MessageStatusFixture.create();
  try {
    // No receipt at all: the send tool returns unknown at its own deadline.
    const sent = await fixture.send(0, 1, 'late evidence payload');
    assert.equal(sent.status, 'unknown');
    assert.equal(sent.reason, ArloErrorCode.ACK_TIMEOUT);

    const frame = fixture.roots[1].notifications[0];
    assert.ok(frame, 'the target observed the dispatched frame');

    const beforeLate = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (beforeLate.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(beforeLate.status, 'unknown');
    assert.equal(beforeLate.original_status, 'unknown');
    assert.equal(beforeLate.late_evidence, undefined);

    // Definitive late evidence from the original delivery clarifies unknown.
    await fixture.control.submitReceipt(fixture.roots[1].registration.root_token, {
      endpoint_id: fixture.roots[1].registration.endpoint_id,
      ...receiptFrom(frame, 'enqueued', { native_message_id: 'native-late-1' }),
    });

    const afterLate = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (afterLate.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(afterLate.status, 'accepted');
    assert.equal(afterLate.original_status, 'unknown', 'the returned tool result is never rewritten');
    assert.equal(afterLate.original_reason, ArloErrorCode.ACK_TIMEOUT);
    assert.equal(afterLate.late_evidence, true);
    assert.equal(afterLate.native_message_id, 'native-late-1');

    // Later evidence triggers no new dispatch to the target.
    assert.equal(fixture.roots[1].notifications.length, 1, 'late evidence must not re-dispatch');
    assert.equal(
      fixture.roots[1].notifications.filter((n) => n.text === 'late evidence payload').length,
      1,
      'the payload reaches the target exactly once'
    );

    // Repeating the identical definite receipt is idempotent.
    await fixture.control.submitReceipt(fixture.roots[1].registration.root_token, {
      endpoint_id: fixture.roots[1].registration.endpoint_id,
      ...receiptFrom(frame, 'enqueued', { native_message_id: 'native-late-1' }),
    });
    const afterRepeat = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (afterRepeat.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(afterRepeat.status, 'accepted');
    assert.equal(afterRepeat.original_status, 'unknown');
  } finally {
    await fixture.dispose();
  }
});

test('Uncertain receipts never downgrade a definite result and a target exit keeps accepted', async () => {
  const fixture = await MessageStatusFixture.create();
  try {
    // A definite accepted record.
    fixture.roots[1].onNotification(async (params, root) => {
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id,
        ...receiptFrom(params, 'enqueued', { native_message_id: 'native-definite' }),
      });
    });
    const accepted = await fixture.send(0, 1, 'definite accepted');
    assert.equal(accepted.status, 'accepted');

    const acceptedFrame = fixture.roots[1].notifications[0];
    // A later uncertain receipt must not reduce accepted.
    await fixture.control.submitReceipt(fixture.roots[1].registration.root_token, {
      endpoint_id: fixture.roots[1].registration.endpoint_id,
      ...receiptFrom(acceptedFrame, 'uncertain', { reason: ArloErrorCode.ENQUEUE_UNCERTAIN, native_message_id: 'native-definite' }),
    });
    const afterUncertain = await fixture.roots[0].connection.getMessageStatus(accepted.message_id);
    if (afterUncertain.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(afterUncertain.status, 'accepted', 'uncertain must not reduce a definite result');
    assert.equal(afterUncertain.original_status, 'accepted');

    // The target disappearing after confirmation does not turn accepted into
    // "never enqueued": no later evidence rewrites the recorded result.
    await fixture.control.revokeRoot(fixture.roots[1].registration.root_token, {
      endpoint_id: fixture.roots[1].registration.endpoint_id,
    });
    const afterTargetExit = await fixture.roots[0].connection.getMessageStatus(accepted.message_id);
    if (afterTargetExit.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(afterTargetExit.status, 'accepted');
    assert.equal(afterTargetExit.original_status, 'accepted');

    // A rejected record is equally protected from uncertain downgrades.
    const definiteRejection = await MessageStatusFixture.create();
    try {
      definiteRejection.roots[1].onNotification(async (params, root) => {
        await definiteRejection.control.submitReceipt(root.registration.root_token, {
          endpoint_id: root.registration.endpoint_id,
          ...receiptFrom(params, 'not_enqueued', { reason: ArloErrorCode.QUEUE_LIMIT }),
        });
      });
      const rejected = await definiteRejection.send(0, 1, 'definite rejected');
      assert.equal(rejected.status, 'rejected');

      await definiteRejection.control.submitReceipt(definiteRejection.roots[1].registration.root_token, {
        endpoint_id: definiteRejection.roots[1].registration.endpoint_id,
        ...receiptFrom(definiteRejection.roots[1].notifications[0], 'uncertain'),
      });
      const afterUncertainReject = await definiteRejection.roots[0].connection.getMessageStatus(rejected.message_id);
      if (afterUncertainReject.status === 'result_unavailable') throw new Error('expected an available record');
      assert.equal(afterUncertainReject.status, 'rejected');
      assert.equal(afterUncertainReject.original_status, 'rejected');
    } finally {
      await definiteRejection.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test('Conflicting definite assertions preserve the prior state, fault the binding, and hold credit', async () => {
  const fixture = await MessageStatusFixture.create();
  try {
    // Land the first definite assertion: accepted.
    fixture.roots[1].onNotification(async (params, root) => {
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id,
        ...receiptFrom(params, 'enqueued', { native_message_id: 'native-conflict-1' }),
      });
    });
    const sent = await fixture.send(0, 1, 'conflicting receipts');
    assert.equal(sent.status, 'accepted');
    const frame = fixture.roots[1].notifications[0];

    // A contradicting definite assertion is refused and recorded.
    await assert.rejects(
      fixture.control.submitReceipt(fixture.roots[1].registration.root_token, {
        endpoint_id: fixture.roots[1].registration.endpoint_id,
        ...receiptFrom(frame, 'not_enqueued', {
          reason: ArloErrorCode.QUEUE_LIMIT,
          native_message_id: 'native-conflict-1',
        }),
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.RECEIPT_CONFLICT
    );

    const conflicted = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (conflicted.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(conflicted.status, 'receipt_conflict');
    assert.equal(conflicted.reason, ArloErrorCode.RECEIPT_CONFLICT);
    assert.equal(conflicted.original_status, 'accepted', 'the prior recorded status is preserved');
    assert.equal(conflicted.native_message_id, 'native-conflict-1');

    // Both assertions survive verbatim; the later arrival does not overwrite.
    const assertions = conflicted.conflict_assertions ?? [];
    assert.equal(assertions.length, 2);
    assert.deepEqual(
      assertions.map((a) => [a.receipt, a.status]),
      [
        ['enqueued', 'accepted'],
        ['not_enqueued', 'rejected'],
      ]
    );
    assert.equal(assertions[1].reason, ArloErrorCode.QUEUE_LIMIT);
    assert.equal(assertions[1].delivery_id, frame.delivery_id);
    assert.ok(assertions.every((a) => a.daemon_id === fixture.daemon.daemonId));
    assert.ok(assertions.every((a) => typeof a.recorded_at === 'string' && a.recorded_at.length > 0));

    // The binding is faulted: no new deliveries to the target.
    assert.ok(
      await fixture.waitForDeliverable(1, false),
      'a receipt conflict must stop new deliveries to that binding'
    );
    await assert.rejects(
      fixture.send(0, 1, 'must not be delivered after conflict'),
      (error: { code?: string }) => error.code === ArloErrorCode.TARGET_UNAVAILABLE
    );

    // Credit stays held for conservative reconciliation instead of being
    // released on either contradictory assertion.
    await assert.rejects(
      fixture.control.releaseCredit(fixture.roots[1].registration.root_token, {
        endpoint_id: fixture.roots[1].registration.endpoint_id,
        message_id: sent.message_id,
        native_message_id: 'native-conflict-1',
        event: 'claimed',
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.ACCOUNTING_UNAVAILABLE
    );

    // Repeating the same conflict is stable and adds no further assertions.
    await assert.rejects(
      fixture.control.submitReceipt(fixture.roots[1].registration.root_token, {
        endpoint_id: fixture.roots[1].registration.endpoint_id,
        ...receiptFrom(frame, 'not_enqueued', { reason: ArloErrorCode.QUEUE_LIMIT, native_message_id: 'native-conflict-1' }),
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.RECEIPT_CONFLICT
    );
    const afterRepeat = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (afterRepeat.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(afterRepeat.status, 'receipt_conflict');
    assert.equal(afterRepeat.conflict_assertions?.length, 2);
  } finally {
    await fixture.dispose();
  }
});

test('A definite assertion contradicting an uncertain record keeps the earlier evidence', async () => {
  const fixture = await MessageStatusFixture.create();
  try {
    // The target can only report an inconclusive result.
    fixture.roots[1].onNotification(async (params, root) => {
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id,
        ...receiptFrom(params, 'uncertain', { reason: ArloErrorCode.ENQUEUE_UNCERTAIN }),
      });
    });
    const sent = await fixture.send(0, 1, 'uncertain then definite');
    assert.equal(sent.status, 'unknown');
    assert.equal(sent.reason, ArloErrorCode.ENQUEUE_UNCERTAIN);
    const frame = fixture.roots[1].notifications[0];

    // First definite assertion clarifies the unknown record.
    await fixture.control.submitReceipt(fixture.roots[1].registration.root_token, {
      endpoint_id: fixture.roots[1].registration.endpoint_id,
      ...receiptFrom(frame, 'enqueued', { native_message_id: 'native-uncertain-then-definite' }),
    });
    const clarified = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (clarified.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(clarified.status, 'accepted');
    assert.equal(clarified.original_status, 'unknown');
    assert.equal(clarified.late_evidence, true);

    // A contradicting definite assertion is still a protocol fault, and the
    // record keeps the earlier uncertain evidence alongside both assertions.
    await assert.rejects(
      fixture.control.submitReceipt(fixture.roots[1].registration.root_token, {
        endpoint_id: fixture.roots[1].registration.endpoint_id,
        ...receiptFrom(frame, 'not_enqueued', { reason: ArloErrorCode.QUEUE_LIMIT, native_message_id: 'native-uncertain-then-definite' }),
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.RECEIPT_CONFLICT
    );

    const conflicted = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (conflicted.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(conflicted.status, 'receipt_conflict');
    assert.equal(conflicted.original_status, 'unknown');
    assert.deepEqual(
      conflicted.conflict_assertions?.map((a) => [a.receipt, a.status]),
      [
        ['enqueued', 'accepted'],
        ['not_enqueued', 'rejected'],
      ]
    );
  } finally {
    await fixture.dispose();
  }
});

test('Receipts must match daemon, delivery, target instance, and original generation', async () => {
  const fixture = await MessageStatusFixture.create();
  try {
    const sent = await fixture.send(0, 1, 'binding checks');
    assert.equal(sent.status, 'unknown');
    const frame = fixture.roots[1].notifications[0];
    const token = fixture.roots[1].registration.root_token;
    const endpointId = fixture.roots[1].registration.endpoint_id;

    // message_id alone is never enough: wrong delivery id.
    await assert.rejects(
      fixture.control.submitReceipt(token, {
        endpoint_id: endpointId,
        ...receiptFrom(frame, 'enqueued'),
        delivery_id: 'del-forged',
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.BINDING_MISMATCH
    );

    // Wrong daemon instance.
    await assert.rejects(
      fixture.control.submitReceipt(token, {
        endpoint_id: endpointId,
        ...receiptFrom(frame, 'enqueued'),
        daemon_id: 'daemon-imposter',
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.BINDING_MISMATCH
    );

    // Wrong original dispatch generation.
    await assert.rejects(
      fixture.control.submitReceipt(token, {
        endpoint_id: endpointId,
        ...receiptFrom(frame, 'enqueued'),
        generation: frame.target_generation + 1,
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.BINDING_MISMATCH
    );

    // Another root cannot submit a receipt for this delivery.
    await assert.rejects(
      fixture.control.submitReceipt(fixture.roots[0].registration.root_token, {
        endpoint_id: endpointId,
        ...receiptFrom(frame, 'enqueued'),
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.UNAUTHORIZED
    );

    // None of the forged attempts changed the recorded result.
    const status = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (status.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(status.status, 'unknown');

    // The genuine receipt still applies.
    await fixture.control.submitReceipt(token, {
      endpoint_id: endpointId,
      ...receiptFrom(frame, 'enqueued', { native_message_id: 'native-binding-ok' }),
    });
    const afterGenuine = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (afterGenuine.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(afterGenuine.status, 'accepted');
  } finally {
    await fixture.dispose();
  }
});

test('Settled records expire under a bounded policy while credit-holding records stay active', async () => {
  // The retention clock is injected, so expiry is asserted exactly rather than
  // observed by sleeping against a short wall-clock window.
  const clock = new TestClock();
  const fixture = await MessageStatusFixture.create({ messageRecordTtlMs: 60_000, now: clock.now });
  try {
    fixture.roots[1].onNotification(async (params, root) => {
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id,
        ...receiptFrom(params, 'enqueued', { native_message_id: 'native-ttl-1' }),
      });
    });
    const sent = await fixture.send(0, 1, 'retention window payload');
    const status = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (status.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(status.status, 'accepted');

    // Still holding credit: the retention policy must not evict an active
    // record, even long past the retention window.
    clock.advance(10 * 60_000);
    const whileActive = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (whileActive.status === 'result_unavailable') {
      throw new Error('a record holding credit must not be evicted by the retention policy');
    }
    assert.equal(whileActive.status, 'accepted');

    // Settling the credit starts the retention window; the record is still
    // queryable immediately afterwards.
    await fixture.control.releaseCredit(fixture.roots[1].registration.root_token, {
      endpoint_id: fixture.roots[1].registration.endpoint_id,
      message_id: sent.message_id,
      native_message_id: 'native-ttl-1',
      event: 'claimed',
    });
    clock.advance(30_000);
    const justSettled = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (justSettled.status === 'result_unavailable') {
      throw new Error('settlement must not evict a record still inside its retention window');
    }
    assert.equal(justSettled.status, 'accepted');

    // Past the window from settlement, the record leaves the bounded ledger.
    clock.advance(60_000);
    const afterSettled = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    assert.equal(afterSettled.status, 'result_unavailable');
    assert.equal(afterSettled.reason, ArloErrorCode.RESULT_UNAVAILABLE);

    // Expiry is not permission to re-execute the old message. A receipt that
    // arrives for an evicted record cannot be honoured, because the original
    // dispatch result is no longer verifiable.
    await assert.rejects(
      fixture.control.submitReceipt(fixture.roots[1].registration.root_token, {
        endpoint_id: fixture.roots[1].registration.endpoint_id,
        ...receiptFrom(fixture.roots[1].notifications[0], 'enqueued'),
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.REPLAY_RESULT_UNAVAILABLE
    );
  } finally {
    await fixture.dispose();
  }
});

/**
 * Drives the tracking budget to its limit by admitting records that stay active
 * (each holds credit, so nothing is evictable), then proves admission is
 * refused. Already admitted IDs count toward the budget even after settlement.
 */
async function saturateTrackingBudget(fixture: MessageStatusFixture): Promise<void> {
  let blocked = false;
  for (let attempt = 0; attempt < 30 && !blocked; attempt++) {
    try {
      await fixture.send(0, 1, `saturate ${attempt}`);
    } catch (error) {
      if ((error as { code?: string }).code !== ArloErrorCode.ACCOUNTING_UNAVAILABLE) throw error;
      blocked = true;
    }
  }
  assert.ok(blocked, 'the tracking budget must become exhausted within the probe limit');

  // Every further admission is refused and the refusal is stable.
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(
      fixture.send(0, 1, `refused ${attempt}`),
      (error: { code?: string }) => error.code === ArloErrorCode.ACCOUNTING_UNAVAILABLE
    );
  }
}

test('Late not_enqueued releases pending capacity exactly once', async () => {
  const fixture = await MessageStatusFixture.create({ rateLimit: UNPACED_RATE_LIMIT });
  try {
    fixture.roots[1].onNotification(async (params, root) => {
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id,
        ...receiptFrom(params, 'uncertain'),
      });
    });
    const payload = 'x'.repeat(32 * 1024);
    const sent = await fixture.send(0, 1, payload);
    for (let i = 1; i < 32; i++) await fixture.send(0, 1, payload);
    await assert.rejects(fixture.send(0, 1, payload), (e: { code?: string }) => e.code === ArloErrorCode.QUEUE_LIMIT);
    const frame = fixture.frameFor(1, sent.message_id);
    for (let i = 0; i < 2; i++) {
      await fixture.control.submitReceipt(fixture.roots[1].registration.root_token, {
        endpoint_id: fixture.roots[1].registration.endpoint_id,
        ...receiptFrom(frame, 'not_enqueued', { reason: ArloErrorCode.QUEUE_LIMIT }),
      });
    }
    const clarified = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    assert.equal(clarified.status, 'rejected');
    assert.equal(clarified.original_status, 'unknown');
    assert.equal(clarified.late_evidence, true);
    await fixture.send(0, 1, payload);
    await assert.rejects(fixture.send(0, 1, payload), (e: { code?: string }) => e.code === ArloErrorCode.QUEUE_LIMIT);
  } finally { await fixture.dispose(); }
});

test('Revoking a target keeps unconsumed accepted history active beyond retention', async () => {
  const clock = new TestClock();
  const fixture = await MessageStatusFixture.create({ now: clock.now, messageRecordTtlMs: 100 });
  try {
    fixture.roots[1].onNotification(async (params, root) => {
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id,
        ...receiptFrom(params, 'enqueued'),
      });
    });
    const sent = await fixture.send(0, 1, 'delivered then target revoked');
    await fixture.control.revokeRoot(fixture.roots[1].registration.root_token, {
      endpoint_id: fixture.roots[1].registration.endpoint_id,
    });
    assert.equal((await fixture.roots[0].connection.getMessageStatus(sent.message_id)).status, 'accepted');
    // Revocation is not consumption or proof that the host instance ended.
    clock.advance(25 * 60 * 60 * 1000);
    assert.equal((await fixture.roots[0].connection.getMessageStatus(sent.message_id)).status, 'accepted');
  } finally { await fixture.dispose(); }
});

test('A conflicted binding cannot clear its fault by publishing readiness again', async () => {
  const fixture = await MessageStatusFixture.create();
  try {
    fixture.roots[1].onNotification(async (params, root) => {
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id,
        ...receiptFrom(params, 'enqueued', { native_message_id: 'native-sticky-conflict' }),
      });
    });
    const sent = await fixture.send(0, 1, 'fault that must stick');
    assert.equal(sent.status, 'accepted');
    const frame = fixture.roots[1].notifications[0];

    await assert.rejects(
      fixture.control.submitReceipt(fixture.roots[1].registration.root_token, {
        endpoint_id: fixture.roots[1].registration.endpoint_id,
        ...receiptFrom(frame, 'not_enqueued', { reason: ArloErrorCode.QUEUE_LIMIT, native_message_id: 'native-sticky-conflict' }),
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.RECEIPT_CONFLICT
    );
    assert.ok(await fixture.waitForDeliverable(1, false));

    // Re-publishing readiness must not silently resume deliveries to a binding
    // the daemon is still reconciling.
    await assert.rejects(
      fixture.control.confirmRootReady(fixture.roots[1].registration.root_token, {
        endpoint_id: fixture.roots[1].registration.endpoint_id,
        reconciled_pending_message_ids: [sent.message_id],
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.ACCOUNTING_UNAVAILABLE
    );

    const roots = await fixture.control.listRoots(fixture.runtimeToken);
    const target = roots.find((r) => r.endpoint_id === fixture.roots[1].registration.endpoint_id);
    assert.equal(target?.deliverable, false, 'the faulted binding must stay non-deliverable');
    await assert.rejects(
      fixture.send(0, 1, 'still must not be delivered'),
      (error: { code?: string }) => error.code === ArloErrorCode.TARGET_UNAVAILABLE
    );
  } finally {
    await fixture.dispose();
  }
});

test('A receipt missing the daemon or dispatch generation cannot move a recorded result', async () => {
  const fixture = await MessageStatusFixture.create();
  try {
    const sent = await fixture.send(0, 1, 'receipt envelope checks');
    const frame = fixture.roots[1].notifications[0];
    const token = fixture.roots[1].registration.root_token;
    const endpointId = fixture.roots[1].registration.endpoint_id;
    const complete = receiptFrom(frame, 'enqueued');

    // message_id plus delivery_id alone is not a receipt identity.
    await assert.rejects(
      fixture.control.submitReceipt(token, {
        endpoint_id: endpointId,
        ...complete,
        daemon_id: undefined as unknown as string,
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.INVALID_ARGUMENT
    );
    await assert.rejects(
      fixture.control.submitReceipt(token, {
        endpoint_id: endpointId,
        ...complete,
        generation: undefined as unknown as number,
      }),
      (error: { code?: string }) => error.code === ArloErrorCode.INVALID_ARGUMENT
    );

    // The record is untouched by the incomplete attempts.
    const status = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (status.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(status.status, 'unknown');

    // The complete receipt is still accepted.
    await fixture.control.submitReceipt(token, { endpoint_id: endpointId, ...complete });
    const accepted = await fixture.roots[0].connection.getMessageStatus(sent.message_id);
    if (accepted.status === 'result_unavailable') throw new Error('expected an available record');
    assert.equal(accepted.status, 'accepted');
  } finally {
    await fixture.dispose();
  }
});

test('A full tracking budget refuses new admission instead of evicting active records', async () => {
  const clock = new TestClock();
  // Three trackable records so a small number of sends can fill the ledger.
  const fixture = await MessageStatusFixture.create({
    maxTrackedMessages: 3,
    messageRecordTtlMs: 60_000,
    now: clock.now,
  });
  try {
    // Every admitted record stays active: accepted but still holding credit.
    fixture.roots[1].onNotification(async (params, root) => {
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id,
        ...receiptFrom(params, 'enqueued', { native_message_id: `native-${params.message_id}` }),
      });
    });
    const active = await fixture.send(0, 1, 'active record holding credit');
    const activeStatus = await fixture.roots[0].connection.getMessageStatus(active.message_id);
    if (activeStatus.status === 'result_unavailable') throw new Error('expected an available record');

    // Fill the remaining slots, then prove admission is refused rather than
    // dropping an active ledger entry.
    await saturateTrackingBudget(fixture);

    // The active record survived the pressure and remains queryable.
    const survivor = await fixture.roots[0].connection.getMessageStatus(active.message_id);
    if (survivor.status === 'result_unavailable') {
      throw new Error('budget pressure must not evict an active record');
    }
    assert.equal(survivor.status, 'accepted');

    // Settlement frees pending credit, but cannot discard replay protection.
    await fixture.control.releaseCredit(fixture.roots[1].registration.root_token, {
      endpoint_id: fixture.roots[1].registration.endpoint_id,
      message_id: active.message_id,
      native_message_id: `native-${active.message_id}`,
      event: 'claimed',
    });
    await assert.rejects(fixture.send(0, 1, 'tracking remains full'),
      (error: { code?: string }) => error.code === ArloErrorCode.ACCOUNTING_UNAVAILABLE);
  } finally {
    await fixture.dispose();
  }
});
