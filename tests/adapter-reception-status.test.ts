import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReceptionLedger, receiptOutcome, type ReceptionHost, type ReceptionDispatch } from '@arlo/adapter-sdk';
import { ArloErrorCode, type ArloMessageNotificationParams, type RootReceiptRequest } from '@arlo/sdk';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';

function dispatch(frame: ArloMessageNotificationParams): ReceptionDispatch {
  return {
    daemon_id: frame.daemon_id,
    endpoint_id: frame.to_endpoint,
    message_id: frame.message_id,
    delivery_id: frame.delivery_id,
    generation: frame.target_generation,
  };
}

test('Public reception forwards explicit late acceptance to the real daemon without another dispatch', async () => {
  const rig = await MessageStatusFixture.create();
  const target = rig.roots[1];
  const inserted: string[] = [];
  const receiptSubmissions: Promise<unknown>[] = [];
  // A contract fixture for an independent host, with no host-specific runtime.
  // It has inserted input but cannot confirm acceptance until later evidence.
  const host: ReceptionHost = {
    instanceId: 'late-evidence-host',
    prepare: frame => ({
      nativeMessageId: `native-${frame.message_id}`,
      enqueue() {
        inserted.push(frame.message_id);
        return 'unknown';
      },
    }),
  };
  const ledger = new ReceptionLedger({
    host,
    currentGeneration: target.registration.generation,
    onReceipt: proof => {
      receiptSubmissions.push(rig.control.submitReceipt(target.registration.root_token, proof));
    },
  });
  try {
    target.onNotification(async frame => {
      const received = await ledger.receiveFrame(frame);
      await rig.control.submitReceipt(target.registration.root_token, {
        ...dispatch(frame), ...receiptOutcome(received),
      });
    });
    const sent = await rig.send(0, 1, 'late evidence through the public adapter');
    assert.equal(sent.status, 'unknown');
    assert.equal(sent.reason, ArloErrorCode.ENQUEUE_UNCERTAIN);
    const before = await rig.roots[0].connection.getMessageStatus(sent.message_id);
    assert.equal(before.status, 'unknown');
    assert.equal(before.original_status, 'unknown');
    assert.equal(before.late_evidence, undefined);

    const frame = rig.frameFor(1, sent.message_id);
    assert.equal(ledger.observeEvidence({
      instanceId: host.instanceId,
      dispatch: dispatch(frame),
      nativeMessageId: `native-${sent.message_id}`,
      event: 'enqueued',
    }), true);
    await Promise.all(receiptSubmissions);

    const clarified = await rig.roots[0].connection.getMessageStatus(sent.message_id);
    assert.equal(clarified.status, 'accepted');
    assert.equal(clarified.original_status, 'unknown');
    assert.equal(clarified.original_reason, ArloErrorCode.ENQUEUE_UNCERTAIN);
    assert.equal(clarified.late_evidence, true);
    assert.equal(clarified.native_message_id, `native-${sent.message_id}`);
    assert.equal(sent.status, 'unknown', 'Later evidence cannot rewrite the returned send result');

    const replay = await rig.send(0, 1, frame.text, sent.message_id);
    assert.equal(replay.message_id, sent.message_id);
    assert.equal(target.notifications.length, 1, 'Late evidence and sender replay must not redispatch');
    assert.deepEqual(inserted, [sent.message_id], 'The host receives exactly one input');
  } finally {
    ledger.dispose();
    await rig.dispose();
  }
});

test('Public reception preserves contradictory receipts and the real daemon stops deliveries to the binding', async () => {
  const rig = await MessageStatusFixture.create();
  const target = rig.roots[1];
  const inserted: string[] = [];
  const receiptSubmissions: Promise<unknown>[] = [];
  const host: ReceptionHost = {
    instanceId: 'conflicting-evidence-host',
    prepare: frame => ({
      nativeMessageId: `native-${frame.message_id}`,
      enqueue() {
        inserted.push(frame.message_id);
        return 'enqueued';
      },
    }),
  };
  const ledger = new ReceptionLedger({
    host,
    currentGeneration: target.registration.generation,
    onReceipt: proof => {
      receiptSubmissions.push(rig.control.submitReceipt(target.registration.root_token, proof));
    },
  });
  try {
    target.onNotification(async frame => {
      const received = await ledger.receiveFrame(frame);
      await rig.control.submitReceipt(target.registration.root_token, {
        ...dispatch(frame), ...receiptOutcome(received),
      });
    });
    const sent = await rig.send(0, 1, 'contradictory public reception evidence');
    assert.equal(sent.status, 'accepted');
    await Promise.all(receiptSubmissions);
    receiptSubmissions.length = 0;

    const frame = rig.frameFor(1, sent.message_id);
    assert.equal(ledger.observeEvidence({
      instanceId: host.instanceId,
      dispatch: dispatch(frame),
      nativeMessageId: `native-${sent.message_id}`,
      event: 'not_enqueued',
    }), true);
    await assert.rejects(Promise.all(receiptSubmissions),
      (error: { code?: string }) => error.code === ArloErrorCode.RECEIPT_CONFLICT);

    // Recovery retains the complete original identities for both assertions.
    const retained = ledger.getRetainedEvidence();
    assert.deepEqual(retained.map(entry => entry.receipt.status), ['enqueued', 'not_enqueued']);
    for (const { receipt } of retained) {
      const { status: _status, reason: _reason, native_message_id, ...identity } = receipt;
      assert.deepEqual(identity, dispatch(frame));
      assert.equal(native_message_id, `native-${sent.message_id}`);
    }

    const conflicted = await rig.roots[0].connection.getMessageStatus(sent.message_id);
    assert.equal(conflicted.status, 'receipt_conflict');
    assert.equal(conflicted.reason, ArloErrorCode.RECEIPT_CONFLICT);
    assert.equal(conflicted.original_status, 'accepted');
    assert.deepEqual(conflicted.conflict_assertions?.map(assertion => [assertion.receipt, assertion.status]), [
      ['enqueued', 'accepted'],
      ['not_enqueued', 'rejected'],
    ]);
    assert.ok(await rig.waitForDeliverable(1, false), 'Receipt conflict must fault the live binding');
    await assert.rejects(rig.send(0, 1, 'must not reach a conflicted host'),
      (error: { code?: string }) => error.code === ArloErrorCode.TARGET_UNAVAILABLE);
    assert.equal(target.notifications.length, 1);
    assert.deepEqual(inserted, [sent.message_id]);
  } finally {
    ledger.dispose();
    await rig.dispose();
  }
});

for (const scenario of [
  { observed: 'not_enqueued', returned: 'enqueued' },
  { observed: 'enqueued', returned: 'not_enqueued' },
] as const) {
  test(`Synchronous ${scenario.observed} evidence contradicting ${scenario.returned} reaches the daemon and retains recovery proof`, async () => {
    const rig = await MessageStatusFixture.create();
    const target = rig.roots[1];
    const attempted: string[] = [];
    const observed: boolean[] = [];
    const receiptErrors: unknown[] = [];
    const creditSubmissions: Promise<{ error?: unknown }>[] = [];
    const handled = Promise.withResolvers<void>();
    let receiptTail = Promise.resolve();
    // Receipt callbacks are synchronous; the consumer sends their proofs in
    // order and records protocol failures without rejecting a host callback.
    const submit = (proof: RootReceiptRequest): void => {
      receiptTail = receiptTail.then(async () => {
        try {
          await rig.control.submitReceipt(target.registration.root_token, proof);
        } catch (error) {
          receiptErrors.push(error);
        }
      });
    };
    const host: ReceptionHost = {
      instanceId: `synchronous-${scenario.observed}-host`,
      prepare: frame => ({
        nativeMessageId: `native-${frame.message_id}`,
        enqueue() {
          attempted.push(frame.message_id);
          observed.push(ledger.observeEvidence({
            instanceId: host.instanceId,
            dispatch: dispatch(frame),
            nativeMessageId: `native-${frame.message_id}`,
            event: scenario.observed,
          }));
          return scenario.returned;
        },
      }),
    };
    const ledger = new ReceptionLedger({
      host,
      currentGeneration: target.registration.generation,
      initialCapacity: 1,
      onReceipt: submit,
      onCredit: proof => {
        creditSubmissions.push(rig.control.releaseCredit(target.registration.root_token, proof)
          .then(() => ({}), error => ({ error })));
      },
    });
    try {
      target.onNotification(async frame => {
        const received = await ledger.receiveFrame(frame);
        submit({
          ...dispatch(frame),
          ...receiptOutcome(received),
          native_message_id: `native-${frame.message_id}`,
        });
        await receiptTail;
        handled.resolve();
      });
      const sent = await rig.send(0, 1, 'synchronous contradictory reception evidence');
      // A first receipt can settle send before both contradictory assertions
      // arrive. Query only after every receipt for this dispatch was submitted.
      await handled.promise;
      assert.deepEqual(observed, [true]);
      const conflicted = await rig.roots[0].connection.getMessageStatus(sent.message_id);
      assert.equal(conflicted.status, 'receipt_conflict');
      assert.equal(conflicted.reason, ArloErrorCode.RECEIPT_CONFLICT);
      assert.deepEqual(conflicted.conflict_assertions?.map(proof => proof.receipt).sort(),
        ['enqueued', 'not_enqueued']);
      assert.ok(receiptErrors.some(error =>
        (error as { code?: string }).code === ArloErrorCode.RECEIPT_CONFLICT));
      assert.ok(await rig.waitForDeliverable(1, false));
      await assert.rejects(rig.send(0, 1, 'must not be admitted after synchronous conflict'),
        (error: { code?: string }) => error.code === ArloErrorCode.TARGET_UNAVAILABLE);
      assert.equal(target.notifications.length, 1);
      assert.deepEqual(attempted, [sent.message_id]);

      assert.deepEqual(ledger.getPendingMessageIds(), [sent.message_id],
        'Contradictory rejection cannot prove that the accepted input is absent');
      assert.equal(ledger.getAvailableCapacity(), 0,
        'The conflicting input must retain its pending reservation');
      const frame = rig.frameFor(1, sent.message_id);
      assert.equal(ledger.observeEvidence({
        instanceId: host.instanceId,
        dispatch: dispatch(frame),
        nativeMessageId: `native-${sent.message_id}`,
        event: 'claimed',
      }), true);
      const creditResults = await Promise.all(creditSubmissions);
      assert.deepEqual(creditResults.map(result => (result.error as { code?: string } | undefined)?.code),
        [ArloErrorCode.ACCOUNTING_UNAVAILABLE], 'The daemon keeps conflicted credit for reconciliation');

      const retained = ledger.getRetainedEvidence();
      assert.deepEqual(retained.map(entry => entry.receipt.status).sort(), ['enqueued', 'not_enqueued']);
      assert.deepEqual(retained.find(entry => entry.credit)?.credit, {
        ...dispatch(frame),
        native_message_id: `native-${sent.message_id}`,
        event: 'claimed',
      }, 'A conflict must not hide consumption proof whose transport was not acknowledged');
    } finally {
      ledger.dispose();
      await rig.dispose();
    }
  });
}
