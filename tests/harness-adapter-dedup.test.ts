import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  ArloErrorCode,
  MAX_TRACKED_MESSAGES,
  type ArloMessageNotificationParams,
} from '@arlo/sdk';
import { ReceptionLedger, type ReceiptResult } from '@arlo/adapter-sdk';
import { createDshReceptionHost } from '@arlo/adapter-dsh/runtime';
import { fixture, LocalModel } from '../probes/fixture.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

interface FrameOverrides {
  messageId?: string;
  seq?: string;
  text?: string;
  generation?: number;
  deliveryId?: string;
  from?: string;
  to?: string;
  group?: string;
}

function makeFrame(overrides: FrameOverrides = {}): ArloMessageNotificationParams {
  const seq = overrides.seq ?? '1';
  return {
    protocol_version: '0.1',
    daemon_id: 'daemon-retention',
    message_id: overrides.messageId ?? `msg-${seq}`,
    delivery_id: overrides.deliveryId ?? `del-${seq}`,
    from_endpoint: overrides.from ?? 'ep-sender',
    to_endpoint: overrides.to ?? 'ep-root',
    group_id: overrides.group ?? 'group-retention',
    target_generation: overrides.generation ?? 1,
    delivery_seq: seq,
    text: overrides.text ?? `text-${seq}`,
    sent_at: '2026-01-01T00:00:00.000Z',
  };
}

// The exported adapter seam is the contract the plugin relies on: it owns
// reception registration, the per-generation replay window and the settled
// receipt cache. Host insertion is counted through real host events, never
// through a simulated adapter.
async function withDeduplicator(
  options: { windowSize?: number; initialCapacity?: number; limit?: number; ttlMs?: number; generation?: number },
  body: (ctx: {
    host: Awaited<ReturnType<typeof fixture>>;
    deduplicator: ReceptionLedger;
    insertions: () => number;
    advanceClock: (ms: number) => void;
    consumeInbox: (receipt: ReceiptResult) => void;
  }) => Promise<void>
): Promise<void> {
  const model = new LocalModel();
  const host = await fixture(model);
  const heldTurn = Promise.withResolvers<void>();
  const turnStarted = Promise.withResolvers<void>();
  model.beforeResponse = () => { turnStarted.resolve(); return heldTurn.promise; };
  let clock = Date.UTC(2026, 0, 1);
  const deduplicator = new ReceptionLedger({
    host: createDshReceptionHost(host.root.agent),
    windowSize: options.windowSize,
    currentGeneration: options.generation ?? 1,
    initialCapacity: options.initialCapacity,
    settledReceiptRetention: { limit: options.limit, ttlMs: options.ttlMs },
    now: () => clock,
  });
  let insertions = 0;
  const stopCounting = host.ctx.on('agent/inbox/inserted', ({ message }) => {
    if ((message.source as { kind?: string } | undefined)?.kind === 'arlo') insertions++;
  });
  try {
    // Keep real business input pending until the test explicitly removes it.
    // This local user turn does not consume the Arlo reception budget.
    host.root.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'hold the local turn while reception is tested' }],
      source: { kind: 'user' },
    }));
    await turnStarted.promise;
    await body({
      host,
      deduplicator,
      insertions: () => insertions,
      advanceClock: (ms) => { clock += ms; },
      consumeInbox: (receipt) => {
        const inbox = host.root.agent.inbox;
        const message = [...inbox.nextTurn, ...inbox.nextStep].find(input => String(input.id) === receipt.native_message_id);
        assert.ok(message, 'The native message is still pending before removal');
        assert.equal(inbox.remove(message.id), true);
      },
    });
  } finally {
    stopCounting();
    deduplicator.dispose();
    model.beforeResponse = undefined;
    heldTurn.resolve();
    await host.root.agent.whenIdle();
    await host.ctx.fiber.dispose();
  }
}

function releaseCredit(deduplicator: ReceptionLedger, receipt: ReceiptResult): void {
  assert.ok(receipt.native_message_id, 'an enqueued receipt must expose its native message ID');
  deduplicator.reconcilePendingMessageIds();
  const proof = deduplicator.getRetainedEvidence().find(item => item.credit?.native_message_id === receipt.native_message_id);
  assert.ok(proof?.credit, 'The real host discard supplies the associated credit proof');
  deduplicator.acknowledgeCredit(proof.credit.message_id);
}

test('Simultaneous duplicate frames insert into the host exactly once and share the retained result', async () => {
  await withDeduplicator({ windowSize: 8 }, async ({ deduplicator, insertions }) => {
    const frame = makeFrame({ messageId: 'msg-shared', seq: '1' });

    // No await between the two calls: both must observe the same reservation.
    const first = deduplicator.receiveFrame(frame);
    const second = deduplicator.receiveFrame(frame);
    const [a, b] = await Promise.all([first, second]);

    assert.equal(a.status, 'enqueued');
    assert.deepEqual(b, a, 'A concurrent duplicate frame reuses the original receipt');
    assert.equal(insertions(), 1, 'A concurrent duplicate frame must not insert twice');

    const repeat = await deduplicator.receiveFrame(frame);
    assert.deepEqual(repeat, a, 'A repeated frame keeps returning the original receipt');
    assert.equal(insertions(), 1);
  });
});

test('Reusing a retained message ID with different content, owner, or association reports MESSAGE_ID_CONFLICT', async () => {
  await withDeduplicator({ windowSize: 8 }, async ({ deduplicator, insertions }) => {
    const original = makeFrame({ messageId: 'msg-owner', seq: '1', text: 'original text' });
    const accepted = await deduplicator.receiveFrame(original);
    assert.equal(accepted.status, 'enqueued');
    assert.equal(insertions(), 1);

    const variants: Array<[string, ArloMessageNotificationParams]> = [
      ['content', { ...original, text: 'different text' }],
      ['owner', { ...original, from_endpoint: 'ep-impostor' }],
      ['association', { ...original, delivery_id: 'del-other' }],
      ['target', { ...original, to_endpoint: 'ep-other' }],
      ['group', { ...original, group_id: 'group-other' }],
      ['sequence', { ...original, delivery_seq: '2' }],
      ['reply_parent', { ...original, reply_to: 'msg-other-parent', reply_depth: 1 }],
      ['reply_depth', { ...original, reply_depth: 2 }],
    ];

    for (const [axis, variant] of variants) {
      const conflict = await deduplicator.receiveFrame(variant);
      assert.equal(conflict.status, 'rejected', `${axis} mismatch must be refused`);
      assert.equal(conflict.reason, ArloErrorCode.MESSAGE_ID_CONFLICT, `${axis} mismatch must not be hidden by dedup`);
      assert.equal(insertions(), 1, `${axis} mismatch must not reach the host`);
    }

    // A refused conflict never consumed its sequence number.
    const later = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-later', seq: '2' }));
    assert.equal(later.status, 'enqueued');
    assert.equal(insertions(), 2);

    const retained = await deduplicator.receiveFrame(original);
    assert.deepEqual(retained, accepted, 'The original receipt survives conflicting reuse');
    assert.equal(insertions(), 2);
  });
});

test('A capacity rejection remains final when pending credit becomes available', async () => {
  await withDeduplicator({ initialCapacity: 1 }, async ({ deduplicator, insertions, consumeInbox, advanceClock }) => {
    const held = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-held', seq: '1' }));
    assert.equal(held.status, 'enqueued');
    const frame = makeFrame({ messageId: 'msg-refused', seq: '2' });
    const refused = await deduplicator.receiveFrame(frame);
    assert.deepEqual(refused, { status: 'rejected', reason: ArloErrorCode.QUEUE_LIMIT });

    consumeInbox(held);
    releaseCredit(deduplicator, held);
    assert.equal(deduplicator.getAvailableCapacity(), 1);
    assert.deepEqual(await deduplicator.receiveFrame(frame), refused, 'Released credit does not reopen a refused dispatch');
    assert.equal(insertions(), 1);

    advanceClock(DAY_MS);
    assert.deepEqual(await deduplicator.receiveFrame(frame), {
      status: 'duplicate', reason: ArloErrorCode.REPLAY_RESULT_UNAVAILABLE,
    }, 'The sequence still protects a refused dispatch after its receipt expires');
    assert.equal(insertions(), 1);
    assert.equal((await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-new', seq: '3' }))).status, 'enqueued');
    assert.equal(insertions(), 2, 'New business can use the released credit');
  });
});

test('Synchronous host observers cannot insert a conflicting retained ID again', async () => {
  await withDeduplicator({}, async ({ host, deduplicator, insertions }) => {
    const frame = makeFrame({ messageId: 'msg-reentrant', seq: '1' });
    let conflict: Promise<ReceiptResult> | undefined;
    let duplicate: Promise<ReceiptResult> | undefined;
    let reentered = false;
    const stopReentry = host.ctx.on('agent/inbox/inserted', () => {
      if (reentered) return;
      reentered = true;
      conflict = deduplicator.receiveFrame({ ...frame, text: 'conflicting text', delivery_seq: '2' });
      duplicate = deduplicator.receiveFrame(frame);
    });
    try {
      const first = await deduplicator.receiveFrame(frame);
      assert.equal(first.status, 'enqueued');
      assert.deepEqual(await conflict, { status: 'rejected', reason: ArloErrorCode.MESSAGE_ID_CONFLICT });
      assert.deepEqual(await duplicate, { status: 'unknown', reason: ArloErrorCode.ENQUEUE_UNCERTAIN },
        'An insertion still on the stack cannot yet promise a definite result');
      assert.equal(insertions(), 1);
      assert.deepEqual(await deduplicator.receiveFrame(frame), first, 'Completion replaces the provisional result');
      assert.equal(insertions(), 1);
    } finally {
      stopReentry();
    }
  });
});

test('A tracking-budget rejection stays protected after settled receipts expire', async () => {
  // Raise only the settled-cache limit to exercise the independent tracking
  // budget without needing 10,000 live host inputs.
  await withDeduplicator(
    { initialCapacity: 1, limit: MAX_TRACKED_MESSAGES },
    async ({ deduplicator, insertions, consumeInbox, advanceClock }) => {
      const held = await deduplicator.receiveFrame(makeFrame({ seq: '1' }));
      assert.equal(held.status, 'enqueued');
      for (let seq = 2; seq <= MAX_TRACKED_MESSAGES; seq++) {
        assert.equal((await deduplicator.receiveFrame(makeFrame({ seq: String(seq) }))).reason, ArloErrorCode.QUEUE_LIMIT);
      }
      const frame = makeFrame({ seq: String(MAX_TRACKED_MESSAGES + 1) });
      assert.deepEqual(await deduplicator.receiveFrame(frame), {
        status: 'rejected', reason: ArloErrorCode.ACCOUNTING_UNAVAILABLE,
      });

      consumeInbox(held);
      releaseCredit(deduplicator, held);
      advanceClock(DAY_MS);
      assert.deepEqual(await deduplicator.receiveFrame(frame), {
        status: 'duplicate', reason: ArloErrorCode.REPLAY_RESULT_UNAVAILABLE,
      });
      assert.equal(insertions(), 1, 'Budget recovery cannot reopen the refused dispatch');
      assert.equal((await deduplicator.receiveFrame(makeFrame({ seq: String(MAX_TRACKED_MESSAGES + 2) }))).status, 'enqueued',
        'Expired settled receipts free tracking space for new business');
      assert.equal(insertions(), 2);
    }
  );
});

test('The per-generation window accepts in-window out-of-order frames and refuses seen or pre-window frames', async () => {
  await withDeduplicator({ windowSize: 4 }, async ({ deduplicator, insertions }) => {
    assert.equal((await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-10', seq: '10' }))).status, 'enqueued');
    assert.equal((await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-8', seq: '8' }))).status, 'enqueued',
      'A frame inside the window may arrive out of order');
    assert.equal(insertions(), 2);

    const seenSequence = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-unseen', seq: '10' }));
    assert.equal(seenSequence.status, 'duplicate', 'A seen sequence must not be admitted again');
    assert.equal(seenSequence.reason, ArloErrorCode.REPLAY_RESULT_UNAVAILABLE);
    assert.equal(insertions(), 2);

    assert.equal((await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-20', seq: '20' }))).status, 'enqueued');
    const belowWindow = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-16', seq: '16' }));
    assert.equal(belowWindow.status, 'stale_sequence', 'A frame before the window must not be re-delivered');
    assert.equal(belowWindow.reason, ArloErrorCode.STALE_SEQUENCE);
    assert.equal(insertions(), 3);

    assert.equal((await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-17', seq: '17' }))).status, 'enqueued',
      'The exact lower window bound is still admissible');
    assert.equal(insertions(), 4);
  });
});

test('A settled receipt evicted from the cache cannot re-enter the host and reports an unrecoverable result', async () => {
  await withDeduplicator({ windowSize: 8, limit: 2, ttlMs: DAY_MS }, async ({ deduplicator, insertions, consumeInbox }) => {
    const receipts: ReceiptResult[] = [];
    for (const seq of ['1', '2', '3']) {
      const receipt = await deduplicator.receiveFrame(makeFrame({ messageId: `msg-${seq}`, seq }));
      assert.equal(receipt.status, 'enqueued');
      consumeInbox(receipt);
      releaseCredit(deduplicator, receipt);
      receipts.push(receipt);
    }
    assert.equal(insertions(), 3);

    // The original frame is replayed after its receipt was evicted. Getting an
    // unrecoverable result back (rather than the original receipt) is itself
    // the evidence that the oldest settled receipt left the bounded cache.
    const replayed = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-1', seq: '1' }));
    assert.notEqual(replayed.status, 'enqueued', 'An evicted receipt must not be turned back into a new insertion');
    assert.equal(replayed.reason, ArloErrorCode.REPLAY_RESULT_UNAVAILABLE);
    assert.equal(insertions(), 3, 'Cache eviction is not a licence to re-execute the old frame');

    // The two most recent receipts are still inside the bound and answer idempotently.
    for (const seq of ['2', '3']) {
      const retained = await deduplicator.receiveFrame(makeFrame({ messageId: `msg-${seq}`, seq }));
      assert.deepEqual(retained, receipts[Number(seq) - 1]);
    }
    assert.equal(insertions(), 3);
  });
});

test('Ordinary cache eviction never drops records holding pending credit or an undecided result', async () => {
  await withDeduplicator(
    { windowSize: 8, limit: 1, ttlMs: DAY_MS },
    async ({ deduplicator, insertions, consumeInbox, advanceClock }) => {
      const held = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-held', seq: '1' }));
      assert.equal(held.status, 'enqueued');

      for (const seq of ['2', '3']) {
        const settled = await deduplicator.receiveFrame(makeFrame({ messageId: `msg-${seq}`, seq }));
        assert.equal(settled.status, 'enqueued');
        consumeInbox(settled);
        releaseCredit(deduplicator, settled);
      }
      assert.equal(insertions(), 3);

      // A full retention period passes, then the next admission sweeps.
      advanceClock(DAY_MS);
      const fresh = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-4', seq: '4' }));
      assert.equal(fresh.status, 'enqueued');
      consumeInbox(fresh);
      releaseCredit(deduplicator, fresh);
      assert.equal(insertions(), 4);

      // An expired settled receipt no longer answers; the activity record does.
      const expired = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-3', seq: '3' }));
      assert.notEqual(expired.status, 'enqueued', 'A settled receipt expires after its retention window');
      assert.deepEqual(deduplicator.getPendingMessageIds(), ['msg-held']);
      assert.equal(deduplicator.getAvailableCapacity(), 63, 'Eviction must not release pending credit');

      const repeat = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-held', seq: '1' }));
      assert.deepEqual(repeat, held, 'The retained activity record still answers with its original receipt');
      assert.equal(insertions(), 4);
    }
  );
});

test('The settled receipt cache holds its documented 1,024-entry bound', { timeout: 120000 }, async () => {
  // No injected bound here: this exercises the shipped default.
  await withDeduplicator(
    { windowSize: 2048, initialCapacity: 4096 },
    async ({ deduplicator, insertions, consumeInbox }) => {
      let newest: ReceiptResult | undefined;
      for (let i = 1; i <= 1025; i++) {
        const receipt = await deduplicator.receiveFrame(makeFrame({ messageId: `msg-${i}`, seq: String(i) }));
        assert.equal(receipt.status, 'enqueued');
        consumeInbox(receipt);
        releaseCredit(deduplicator, receipt);
        newest = receipt;
      }
      assert.equal(insertions(), 1025);

      // Entry 1 is now one past the documented bound.
      const evicted = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-1', seq: '1' }));
      assert.notEqual(evicted.status, 'enqueued', 'The 1,025th settled receipt pushes the oldest out of the cache');

      // Entry 1,025 is still inside it and answers with its original receipt.
      const retained = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-1025', seq: '1025' }));
      assert.deepEqual(retained, newest);
      assert.equal(insertions(), 1025, 'Neither replay reaches the host');
    }
  );
});

test('A settled receipt stops answering once its retention window passes, even while idle', async () => {
  await withDeduplicator(
    { windowSize: 8 },
    async ({ deduplicator, insertions, consumeInbox, advanceClock }) => {
      const frame = makeFrame({ messageId: 'msg-idle', seq: '1' });
      const receipt = await deduplicator.receiveFrame(frame);
      assert.deepEqual(await deduplicator.receiveFrame(frame), receipt, 'Inside the window the receipt is idempotent');
      consumeInbox(receipt);
      releaseCredit(deduplicator, receipt);

      // Nothing else happens: only the retention window elapses.
      advanceClock(DAY_MS);
      const afterWindow = await deduplicator.receiveFrame(frame);
      assert.notEqual(afterWindow.status, 'enqueued', 'The 24 hour bound is an upper bound, not a lazy sweep');
      assert.equal(deduplicator.getAvailableCapacity(), 64, 'An expired settled receipt holds no credit');
      assert.equal(insertions(), 1);
    }
  );
});

test('A new connection generation does not reuse the previous replay window', async () => {
  await withDeduplicator({ windowSize: 4 }, async ({ deduplicator, insertions }) => {
    assert.equal((await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-g1-1', seq: '1' }))).status, 'enqueued');
    assert.equal((await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-g1-2', seq: '2' }))).status, 'enqueued');

    deduplicator.advanceGeneration(2);

    const stale = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-late', seq: '3', generation: 1 }));
    assert.equal(stale.status, 'rejected');
    assert.equal(stale.reason, ArloErrorCode.STALE_GENERATION);
    assert.equal(insertions(), 2, 'An old-generation frame must not reach the host');

    assert.equal((await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-g2-1', seq: '1', generation: 2 }))).status,
      'enqueued', 'A new generation starts a fresh window');
    assert.equal(insertions(), 3);

    const replay = await deduplicator.receiveFrame(makeFrame({ messageId: 'msg-g2-dup', seq: '1', generation: 2 }));
    assert.equal(replay.status, 'duplicate');
    assert.equal(replay.reason, ArloErrorCode.REPLAY_RESULT_UNAVAILABLE);
    assert.equal(insertions(), 3);
  });
});

test('An invalidated binding is refused before insertion and releases its reservation', async () => {
  await withDeduplicator({ windowSize: 4 }, async ({ deduplicator, insertions }) => {
    const frame = makeFrame({ messageId: 'msg-invalidated', seq: '1' });
    const refused = await deduplicator.receiveFrame(frame, () => false);
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.reason, ArloErrorCode.CHANNEL_NOT_READY);
    assert.equal(insertions(), 0, 'An invalidated callback must not reach the host');

    // Nothing was inserted, so the sequence is free for the retry on a live binding.
    const retried = await deduplicator.receiveFrame(frame, () => true);
    assert.equal(retried.status, 'enqueued');
    assert.equal(insertions(), 1);
  });
});

test('A host exception after insertion keeps an uncertain receipt that eviction cannot discard', async () => {
  await withDeduplicator({ windowSize: 4, limit: 0, ttlMs: 0 }, async ({ host, deduplicator, insertions }) => {
    const stopThrowing = host.ctx.on('internal/dispatch', (_type, name) => {
      if (name === 'agent/inbox/inserted') throw new Error('post-insertion-canary');
    });
    try {
      const frame = makeFrame({ messageId: 'msg-uncertain', seq: '1' });
      const first = await deduplicator.receiveFrame(frame);
      assert.equal(first.status, 'unknown');
      assert.equal(first.reason, ArloErrorCode.ENQUEUE_UNCERTAIN);
      // The injected failure also blocks observer dispatch, so insertion is
      // proven by the real host inbox instead of by the event counter.
      assert.equal(insertions(), 0, 'The injected failure suppresses the insertion observer');
      assert.equal(host.root.agent.inbox.nextTurn.length, 1, 'The real host inserted the message before throwing');

      const repeat = await deduplicator.receiveFrame(frame);
      assert.deepEqual(repeat, first, 'An undecided receipt is retained even under maximum cache pressure');
      assert.equal(host.root.agent.inbox.nextTurn.length, 1, 'An uncertain result must never cause a second insertion');
    } finally {
      stopThrowing();
    }
  });
});
