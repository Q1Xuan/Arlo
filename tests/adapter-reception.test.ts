import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReceptionLedger, type ReceptionHost, type PendingInput, type PendingSnapshot, type ReceptionScope, type ReceptionEvidence } from '@arlo/adapter-sdk';
import { type ArloMessageNotificationParams } from '@arlo/sdk';

function frame(seq = 1): ArloMessageNotificationParams {
  return {
    protocol_version: '0.1', daemon_id: 'daemon', message_id: `msg-${seq}`,
    delivery_id: `delivery-${seq}`, from_endpoint: 'sender', to_endpoint: 'receiver',
    group_id: 'group', target_generation: 1, delivery_seq: String(seq),
    text: `message ${seq}`, sent_at: '2026-01-01T00:00:00.000Z',
  };
}

function pending(message = frame()): PendingInput {
  return {
    nativeMessageId: `native-${message.message_id}`, messageId: message.message_id,
    textBytes: Buffer.byteLength(message.text),
    dispatch: { daemon_id: message.daemon_id, endpoint_id: message.to_endpoint,
      generation: message.target_generation, message_id: message.message_id, delivery_id: message.delivery_id },
  };
}

function snapshotHost() {
  let view: (scope: ReceptionScope) => PendingSnapshot = scope => ({ ...scope, complete: true, pending: [], inFlight: [] });
  const inputs: PendingInput[] = [];
  const host: ReceptionHost = {
    instanceId: 'snapshot-host',
    snapshot: scope => view(scope),
    prepare: message => ({
      nativeMessageId: pending(message).nativeMessageId,
      enqueue() { inputs.push(pending(message)); return 'enqueued'; },
    }),
  };
  return { host, inputs, view: (read: typeof view) => { view = read; } };
}

test('Public reception reserves identity before synchronous reentry and never inserts a duplicate', async () => {
  const inputs: string[] = [];
  let nested: Promise<unknown> | undefined;
  const host: ReceptionHost = {
    instanceId: 'host-instance',
    snapshot: scope => ({ ...scope, complete: true, pending: [], inFlight: [] }),
    prepare: message => ({
      nativeMessageId: `native-${message.message_id}`,
      enqueue() {
        inputs.push(message.text);
        nested = ledger.receiveFrame(message);
        return 'enqueued';
      },
    }),
  };
  const ledger = new ReceptionLedger({ host, currentGeneration: 1 });
  const result = await ledger.receiveFrame(frame());
  assert.equal(result.status, 'enqueued');
  assert.deepEqual(await nested, { status: 'unknown', reason: 'ENQUEUE_UNCERTAIN' });
  assert.deepEqual(await ledger.receiveFrame(frame()), result);
  assert.deepEqual(inputs, ['message 1']);
  ledger.dispose();
});

test('A complete snapshot cannot release a reservation while enqueue is still in flight', async () => {
  const gate = Promise.withResolvers<'enqueued'>();
  const host: ReceptionHost = {
    instanceId: 'async-host',
    snapshot: scope => ({ ...scope, complete: true, pending: [], inFlight: [] }),
    prepare: () => ({ nativeMessageId: 'native', enqueue: () => gate.promise }),
  };
  const ledger = new ReceptionLedger({ host, currentGeneration: 1, initialCapacity: 1 });
  const receiving = ledger.receiveFrame(frame());
  assert.deepEqual(ledger.reconcilePendingMessageIds(), ['msg-1']);
  assert.throws(() => ledger.reconcilePendingMessageIds({ requireComplete: true }), { code: 'ACCOUNTING_UNAVAILABLE' },
    'Even an apparently complete empty snapshot cannot hide an outstanding enqueue');
  assert.equal((await ledger.receiveFrame(frame(2))).reason, 'QUEUE_LIMIT');
  gate.resolve('enqueued');
  assert.equal((await receiving).status, 'enqueued');
  assert.deepEqual(ledger.reconcilePendingMessageIds(), []);
  ledger.dispose();
});

for (const outcome of ['enqueued', 'unknown'] as const) {
test(`Transport recovery without a snapshot preserves ${outcome} input credit while reattachment requires complete accounting`, async () => {
  const inserted: string[] = [];
  const host: ReceptionHost = {
    instanceId: 'event-only-host',
    prepare: message => ({ nativeMessageId: pending(message).nativeMessageId,
      enqueue() { inserted.push(message.message_id); return outcome; } }),
  };
  const ledger = new ReceptionLedger({ host, currentGeneration: 1, initialCapacity: 1 });
  try {
    assert.equal((await ledger.receiveFrame(frame())).status, outcome);
    const originalEvidence = ledger.getRetainedEvidence();
    ledger.advanceGeneration(2);
    assert.throws(() => ledger.reconcilePendingMessageIds({ requireComplete: true }),
      { code: 'ACCOUNTING_UNAVAILABLE' }, 'Reattachment cannot treat a missing host snapshot as a complete queue');
    assert.deepEqual(ledger.reconcilePendingMessageIds({ requireComplete: true, allowMissingSnapshot: true }), ['msg-1']);
    assert.equal(ledger.getAvailableCapacity(), 0, 'Transport recovery retains the original pending reservation');
    assert.deepEqual(ledger.getUnconfirmedCredits(), [], 'Missing evidence cannot release credit');
    assert.deepEqual(ledger.getRetainedEvidence(), originalEvidence, 'Recovery preserves the original receipt and dispatch identity');
    assert.equal((await ledger.receiveFrame({ ...frame(2), target_generation: 2 })).reason, 'QUEUE_LIMIT');
    assert.deepEqual(inserted, ['msg-1'], 'An unverified occupied slot cannot accept another body');
  } finally { ledger.dispose(); }
});
}

test('Allowing a missing snapshot during transport recovery cannot bypass an incomplete provided snapshot', async () => {
  const rig = snapshotHost();
  const ledger = new ReceptionLedger({ host: rig.host, currentGeneration: 1, initialCapacity: 1 });
  try {
    assert.equal((await ledger.receiveFrame(frame())).status, 'enqueued');
    rig.view(scope => ({ ...scope, complete: false, pending: [], inFlight: [] }));
    ledger.advanceGeneration(2);
    assert.throws(() => ledger.reconcilePendingMessageIds({ requireComplete: true, allowMissingSnapshot: true }),
      { code: 'ACCOUNTING_UNAVAILABLE' });
    assert.deepEqual(ledger.getPendingMessageIds(), ['msg-1'], 'An incomplete empty view cannot erase original occupancy');
    assert.equal(ledger.getAvailableCapacity(), 0);
    assert.deepEqual(ledger.getUnconfirmedCredits(), [], 'No absence proof is available to release credit');
    assert.deepEqual(rig.inputs.map(input => input.messageId), ['msg-1']);
  } finally { ledger.dispose(); }
});

test('Snapshot-only hosts must prove complete identity and include input outside the pending queue', async () => {
  const rig = snapshotHost();
  const ledger = new ReceptionLedger({ host: rig.host, currentGeneration: 1, initialCapacity: 1 });
  await ledger.receiveFrame(frame());
  const input = rig.inputs[0];
  const invalidViews = [
    (scope: ReceptionScope) => ({ ...scope, complete: false, pending: [], inFlight: [] }),
    (scope: ReceptionScope) => ({ ...scope, instanceId: 'replacement', complete: true, pending: [], inFlight: [] }),
    (scope: ReceptionScope) => ({ ...scope, generation: 0, complete: true, pending: [], inFlight: [] }),
    (scope: ReceptionScope) => ({ ...scope, complete: true, pending: [], inFlight: [input] }),
    (scope: ReceptionScope) => ({ ...scope, complete: true, pending: [{ ...input, nativeMessageId: 'wrong-native' }], inFlight: [] }),
    (scope: ReceptionScope) => ({ ...scope, complete: true, pending: [{ ...input, messageId: 'wrong-message' }], inFlight: [] }),
    (scope: ReceptionScope) => ({ ...scope, complete: true, pending: [{ ...input, dispatch: { ...input.dispatch!, generation: 2 } }], inFlight: [] }),
  ];
  for (const read of invalidViews) {
    rig.view(read);
    assert.deepEqual(ledger.reconcilePendingMessageIds(), ['msg-1']);
    assert.equal(ledger.getAvailableCapacity(), 0);
  }
  rig.view(scope => ({ ...scope, complete: true, pending: [], inFlight: [] }));
  assert.deepEqual(ledger.reconcilePendingMessageIds(), []);
  assert.equal(ledger.getAvailableCapacity(), 1);
  assert.equal(ledger.getRetainedEvidence()[0].receipt.status, 'enqueued');
  assert.equal(ledger.getRetainedEvidence()[0].credit?.event, 'snapshot', 'Absence does not invent a claimed/discarded event');
  assert.equal(ledger.getUnconfirmedCredits().length, 1, 'Snapshot release must reach the daemon before it is forgotten');
  ledger.acknowledgeCredit('msg-1');
  assert.deepEqual(ledger.getUnconfirmedCredits(), []);
  ledger.dispose();
});

test('A snapshot releases unknown input credit without inventing acceptance and preserves the original dispatch across recovery', async () => {
  const ledger = new ReceptionLedger({ currentGeneration: 1, settledReceiptRetention: { limit: 0, ttlMs: 0 },
    host: { instanceId: 'unknown-snapshot',
      prepare: message => ({ nativeMessageId: pending(message).nativeMessageId, enqueue: () => 'unknown' }),
      snapshot: scope => ({ ...scope, complete: true, pending: [], inFlight: [] }),
    },
  });
  assert.equal((await ledger.receiveFrame(frame())).status, 'unknown');
  ledger.advanceGeneration(2);
  assert.deepEqual(ledger.reconcilePendingMessageIds(), []);
  const [proof] = ledger.getUnconfirmedCredits();
  assert.equal(proof.event, 'snapshot');
  assert.equal(proof.generation, 1, 'Reconciliation never rewrites the dispatch generation');
  assert.equal(ledger.getRetainedEvidence()[0].receipt.status, 'uncertain');
  ledger.acknowledgeCredit(proof.message_id);
  assert.deepEqual(ledger.getUnconfirmedCredits(), []);
  assert.equal(ledger.getRetainedEvidence()[0].receipt.status, 'uncertain', 'Unknown remains activity after credit acknowledgement');
  ledger.dispose();
});

test('Synchronous consumption survives an enqueue exception and retains credit proof until acknowledgement', async () => {
  let listener: (evidence: ReceptionEvidence) => void = () => {};
  const credits: string[] = [];
  const host: ReceptionHost = {
    instanceId: 'event-host',
    observe: receive => { listener = receive; return () => {}; },
    prepare: message => ({
      nativeMessageId: pending(message).nativeMessageId,
      enqueue() {
        const input = pending(message);
        listener({ instanceId: host.instanceId, dispatch: input.dispatch!, nativeMessageId: input.nativeMessageId, event: 'claimed' });
        throw new Error('host throws after consumption');
      },
    }),
  };
  const ledger = new ReceptionLedger({ host, currentGeneration: 1, settledReceiptRetention: { limit: 0, ttlMs: 0 },
    onCredit: proof => { credits.push(proof.message_id); } });
  assert.equal((await ledger.receiveFrame(frame())).status, 'unknown');
  assert.equal(ledger.getAvailableCapacity(), 64);
  assert.deepEqual(credits, ['msg-1']);
  const proof = ledger.getRetainedEvidence()[0];
  assert.equal(proof.receipt.status, 'uncertain');
  assert.equal(proof.credit?.event, 'claimed');
  ledger.acknowledgeCredit('msg-1');
  assert.equal(ledger.getRetainedEvidence().length, 1, 'Unknown remains activity after credit acknowledgement');
  assert.equal((await ledger.receiveFrame(frame())).status, 'unknown');
  assert.deepEqual(credits, ['msg-1']);
  ledger.dispose();
});

test('Credit requires the exact instance, dispatch and native identity; unacknowledged credit cannot be evicted', async () => {
  const rig = snapshotHost();
  const ledger = new ReceptionLedger({ host: rig.host, currentGeneration: 1, settledReceiptRetention: { limit: 0, ttlMs: 0 } });
  await ledger.receiveFrame(frame());
  const input = rig.inputs[0];
  const evidence: ReceptionEvidence = { instanceId: rig.host.instanceId, dispatch: input.dispatch!, nativeMessageId: input.nativeMessageId, event: 'discarded' };
  const wrong = [
    { ...evidence, instanceId: 'different-instance' }, { ...evidence, nativeMessageId: 'different-native' },
    ...(['daemon_id', 'endpoint_id', 'message_id', 'delivery_id'] as const).map(key => ({ ...evidence, dispatch: { ...evidence.dispatch, [key]: 'wrong' } })),
    { ...evidence, dispatch: { ...evidence.dispatch, generation: 2 } },
  ];
  for (const proof of wrong) assert.equal(ledger.observeEvidence(proof), false);
  assert.equal(ledger.getAvailableCapacity(), 63);
  assert.equal(ledger.getRetainedEvidence().length, 1, 'Activity survives a zero settled cache');
  assert.equal(ledger.observeEvidence(evidence), true);
  assert.equal(ledger.observeEvidence(evidence), false);
  assert.equal(ledger.getRetainedEvidence().length, 1, 'Unacknowledged release remains recoverable');
  ledger.acknowledgeCredit('another-message');
  assert.equal(ledger.getRetainedEvidence().length, 1);
  ledger.acknowledgeCredit('msg-1');
  assert.equal(ledger.getRetainedEvidence().length, 0);
  assert.equal((await ledger.receiveFrame(frame())).reason, 'REPLAY_RESULT_UNAVAILABLE');
  assert.equal(rig.inputs.length, 1);
  ledger.dispose();
});

test('Revocation during preparation prevents enqueue and saved callbacks cannot enter a replacement', async () => {
  const delivered: string[] = [];
  let active = true;
  const host: ReceptionHost = {
    instanceId: 'old-instance',
    snapshot: scope => ({ ...scope, complete: true, pending: [], inFlight: [] }),
    prepare: message => {
      active = false;
      return { nativeMessageId: 'old-native', enqueue() { delivered.push(message.text); return 'enqueued'; } };
    },
  };
  const old = new ReceptionLedger({ host, currentGeneration: 1 });
  assert.equal((await old.receiveFrame(frame(), () => active)).reason, 'CHANNEL_NOT_READY');
  assert.deepEqual(delivered, []);
  old.dispose();
  const rig = snapshotHost();
  const replacement = new ReceptionLedger({ host: rig.host, currentGeneration: 1 });
  assert.equal((await old.receiveFrame(frame(2))).reason, 'CHANNEL_NOT_READY');
  assert.equal((await replacement.receiveFrame(frame(2))).status, 'enqueued');
  assert.deepEqual(rig.inputs.map(input => input.messageId), ['msg-2']);
  replacement.advanceGeneration(2);
  assert.equal((await replacement.receiveFrame(frame(3))).reason, 'STALE_GENERATION');
  replacement.dispose();
});

test('A host cannot reuse an active native identity for another dispatch', async () => {
  const inserted: string[] = [];
  const host: ReceptionHost = {
    instanceId: 'reused-native',
    prepare: message => ({ nativeMessageId: 'same-native', enqueue() { inserted.push(message.message_id); return 'enqueued'; } }),
  };
  const ledger = new ReceptionLedger({ host, currentGeneration: 1 });
  assert.equal((await ledger.receiveFrame(frame())).status, 'enqueued');
  assert.equal((await ledger.receiveFrame(frame(2))).reason, 'MESSAGE_ID_CONFLICT');
  assert.deepEqual(inserted, ['msg-1']);
  assert.deepEqual(ledger.getPendingMessageIds(), ['msg-1']);
  ledger.dispose();
});

test('Receipt evidence inside an enqueue that later throws cannot prematurely publish acceptance', async () => {
  const published: string[] = [];
  const evidence: ReceptionEvidence = { instanceId: 'throwing-host', dispatch: pending().dispatch!, nativeMessageId: pending().nativeMessageId, event: 'enqueued' };
  const ledger = new ReceptionLedger({
    currentGeneration: 1,
    host: { instanceId: evidence.instanceId, prepare: () => ({ nativeMessageId: evidence.nativeMessageId,
      enqueue() { ledger.observeEvidence(evidence); throw new Error('after insertion'); } }) },
    onReceipt: proof => { published.push(proof.status); },
  });
  assert.equal((await ledger.receiveFrame(frame())).status, 'unknown');
  assert.deepEqual(published, []);
  assert.equal(ledger.getAvailableCapacity(), 63);
  assert.equal(ledger.observeEvidence(evidence), true, 'A subsequent authoritative observation may settle the uncertainty');
  assert.deepEqual(published, ['enqueued']);
  ledger.dispose();
});

test('Unavailable snapshot evidence stops admission with a fixed result and preserves held credit', async () => {
  const rig = snapshotHost();
  const ledger = new ReceptionLedger({ host: rig.host, currentGeneration: 1 });
  assert.equal((await ledger.receiveFrame(frame())).status, 'enqueued');
  rig.view(() => { throw new Error('private-host-canary'); });
  assert.deepEqual(await ledger.receiveFrame(frame(2)), { status: 'rejected', reason: 'ACCOUNTING_UNAVAILABLE' });
  assert.equal(ledger.getAvailableCapacity(), 0);
  assert.deepEqual(ledger.reconcilePendingMessageIds(), ['msg-1']);
  assert.deepEqual(rig.inputs.map(input => input.messageId), ['msg-1']);
  rig.view(scope => ({ ...scope, complete: true, pending: rig.inputs, inFlight: [] }));
  assert.equal(ledger.getAvailableCapacity(), 63);
  assert.equal((await ledger.receiveFrame(frame(2))).reason, 'ACCOUNTING_UNAVAILABLE', 'Rejected dispatch stays final');
  ledger.dispose();
});

test('All synchronous receipt assertions settle together before zero-cache eviction or credit release', async () => {
  const published: string[] = [];
  const proof = { instanceId: 'batch-host', dispatch: pending().dispatch!, nativeMessageId: pending().nativeMessageId };
  const ledger = new ReceptionLedger({ currentGeneration: 1, initialCapacity: 1,
    settledReceiptRetention: { limit: 0, ttlMs: 0 },
    host: { instanceId: proof.instanceId, prepare: () => ({ nativeMessageId: proof.nativeMessageId,
      enqueue() {
        ledger.observeEvidence({ ...proof, event: 'not_enqueued' });
        ledger.observeEvidence({ ...proof, event: 'enqueued' });
        return 'unknown';
      } }) },
    onReceipt: receipt => { published.push(receipt.status); },
  });
  assert.equal((await ledger.receiveFrame(frame())).reason, 'RECEIPT_CONFLICT');
  assert.deepEqual(ledger.getPendingMessageIds(), ['msg-1']);
  assert.equal(ledger.getAvailableCapacity(), 0);
  assert.deepEqual(ledger.getRetainedEvidence().map(item => item.receipt.status).sort(), ['enqueued', 'not_enqueued']);
  assert.ok(published.includes('enqueued') && published.includes('not_enqueued'));
  ledger.dispose();
});

test('A late acceptance contradicting rejection restores conservative pending credit', async () => {
  const proof = { instanceId: 'late-conflict', dispatch: pending().dispatch!, nativeMessageId: pending().nativeMessageId };
  const ledger = new ReceptionLedger({ currentGeneration: 1, initialCapacity: 1,
    host: { instanceId: proof.instanceId, snapshot: scope => ({ ...scope, complete: true, pending: [], inFlight: [] }),
      prepare: () => ({ nativeMessageId: proof.nativeMessageId, enqueue: () => 'not_enqueued' }) },
  });
  assert.equal((await ledger.receiveFrame(frame())).status, 'rejected');
  assert.equal(ledger.getAvailableCapacity(), 1);
  assert.equal(ledger.observeEvidence({ ...proof, event: 'enqueued' }), true);
  assert.deepEqual(ledger.getPendingMessageIds(), ['msg-1']);
  assert.equal(ledger.getAvailableCapacity(), 0);
  assert.throws(() => ledger.reconcilePendingMessageIds({ requireComplete: true }), { code: 'ACCOUNTING_UNAVAILABLE' });
  assert.equal((await ledger.receiveFrame(frame(2))).reason, 'RECEIPT_CONFLICT');
  ledger.dispose();
});
