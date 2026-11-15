import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArloDaemon } from '@arlo/daemon';
import {
  ControlClient,
  ArloErrorCode,
  MAX_SINGLE_TEXT_BYTES,
  type ArloMessageNotificationParams,
  type RootRegistrationResponse,
} from '@arlo/sdk';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';

type RootConnection = ReturnType<ControlClient['createRootConnection']>;

// Exactly the single-text limit in UTF-8 bytes: 'é' is two bytes, so a
// char-counting budget would see half of this and the arithmetic below would
// not line up.
const FULL_TEXT = 'é'.repeat(MAX_SINGLE_TEXT_BYTES / 2);

interface Rig {
  daemon: ArloDaemon;
  control: MessageStatusFixture['control'];
  sender: RootRegistrationResponse;
  receivers: RootRegistrationResponse[];
  senderConn: RootConnection;
  receiverConns: RootConnection[];
  notifications: ArloMessageNotificationParams[];
  fixture: MessageStatusFixture;
}

interface RigOptions {
  receiverCount: number;
  autoReceipt?: boolean;
  maxTrackedMessages?: number;
  messageRecordTtlMs?: number;
  now?: () => number;
}

async function startRig(options: RigOptions): Promise<Rig> {
  const fixture = await MessageStatusFixture.create({
    roots: options.receiverCount + 1,
    maxTrackedMessages: options.maxTrackedMessages,
    messageRecordTtlMs: options.messageRecordTtlMs,
    now: options.now,
  });
  const notifications: ArloMessageNotificationParams[] = [];
  const receivers = fixture.roots.slice(1);
  for (const root of receivers) {
    root.onNotification(async (params) => {
      notifications.push(params);
      if (options.autoReceipt !== false) {
        await fixture.control.submitReceipt(root.registration.root_token, {
          daemon_id: params.daemon_id,
          endpoint_id: root.registration.endpoint_id,
          message_id: params.message_id,
          delivery_id: params.delivery_id,
          generation: params.target_generation,
          status: 'enqueued',
          native_message_id: `native-${params.message_id}`,
        });
      }
    });
  }
  return {
    fixture,
    daemon: fixture.daemon,
    control: fixture.control,
    sender: fixture.roots[0]!.registration,
    receivers: receivers.map((root) => root.registration),
    senderConn: fixture.roots[0]!.connection,
    receiverConns: receivers.map((root) => root.connection),
    notifications,
  };
}

async function stopRig(rig: Rig): Promise<void> {
  await rig.fixture.dispose();
}

function rejectsWith(code: ArloErrorCode) {
  return (error: unknown) => (error as { code?: ArloErrorCode }).code === code;
}

function releaseFor(
  rig: Rig,
  frame: { message_id: string },
  receiver: RootRegistrationResponse,
  event: 'claimed' | 'discarded' = 'claimed'
): Promise<{ status: string }> {
  return rig.control.releaseCredit(receiver.root_token, {
    endpoint_id: receiver.endpoint_id,
    message_id: frame.message_id,
    native_message_id: `native-${frame.message_id}`,
    event,
  });
}

test('Per-root pending bytes cap at 1 MiB of UTF-8 text and recover only through credit release', { timeout: 60000 }, async () => {
  const rig = await startRig({ receiverCount: 1 });
  try {
    const target = rig.receivers[0]!.endpoint_id;
    const sent: string[] = [];
    for (let i = 0; i < 32; i++) {
      const result = await rig.senderConn.sendMessage({ to: target, text: FULL_TEXT });
      assert.equal(result.status, 'accepted', `message ${i + 1} must fit the per-root byte budget`);
      sent.push(result.message_id);
    }
    assert.equal(rig.notifications.length, 32);

    // 32 × 32 KiB is exactly 1 MiB, so one more byte-carrying message cannot fit.
    await assert.rejects(
      rig.senderConn.sendMessage({ to: target, text: FULL_TEXT }),
      rejectsWith(ArloErrorCode.QUEUE_LIMIT)
    );
    assert.equal(rig.notifications.length, 32, 'A refused dispatch never reaches the host');

    // A trusted consumption proof frees exactly one message's bytes.
    await releaseFor(rig, { message_id: sent[0]! }, rig.receivers[0]!);
    const recovered = await rig.senderConn.sendMessage({ to: target, text: FULL_TEXT });
    assert.equal(recovered.status, 'accepted', 'The freed bytes admit exactly one more message');
    assert.equal(rig.notifications.length, 33);

    // Repeating the consumption proof must not free the budget a second time.
    await releaseFor(rig, { message_id: sent[0]! }, rig.receivers[0]!);
    await assert.rejects(
      rig.senderConn.sendMessage({ to: target, text: FULL_TEXT }),
      rejectsWith(ArloErrorCode.QUEUE_LIMIT),
      'A duplicate release must not double-free the byte budget'
    );
    assert.equal(rig.notifications.length, 33);
  } finally {
    await stopRig(rig);
  }
});

test('The 8 MiB instance budget spans every registered root and refills only when credits settle', { timeout: 240000 }, async () => {
  const rig = await startRig({ receiverCount: 9 });
  try {
    // Eight roots × 32 messages × 32 KiB = exactly 8 MiB. The ninth root stays
    // empty so its own budget cannot mask a missing instance-wide limit.
    const spare = rig.receivers[8]!;
    for (const receiver of rig.receivers.slice(0, 8)) {
      for (let i = 0; i < 32; i++) {
        const result = await rig.senderConn.sendMessage({ to: receiver.endpoint_id, text: FULL_TEXT });
        assert.equal(result.status, 'accepted');
      }
    }
    assert.equal(rig.notifications.length, 8 * 32);

    const beforeRefusal = await rig.control.fixtureSendingStatus(rig.sender);
    await assert.rejects(
      rig.senderConn.sendMessage({ to: spare.endpoint_id, text: FULL_TEXT }),
      rejectsWith(ArloErrorCode.QUEUE_LIMIT),
      'The instance budget refuses admission even to an empty root'
    );
    assert.equal(rig.notifications.length, 8 * 32, 'The refused dispatch never reaches the host');
    const afterRefusal = await rig.control.fixtureSendingStatus(rig.sender);
    assert.equal(afterRefusal.period_id, beforeRefusal.period_id);
    assert.equal(afterRefusal.used, beforeRefusal.used, 'The global capacity refusal consumes no autonomous attempt');

    // Credit released by one root becomes available to another, exactly once.
    const released = rig.notifications[0]!;
    await releaseFor(rig, released, rig.receivers[0]!);
    const recovered = await rig.senderConn.sendMessage({
      to: spare.endpoint_id,
      text: FULL_TEXT,
    });
    assert.equal(recovered.status, 'accepted', 'Settled credits refill the instance budget');
    await releaseFor(rig, released, rig.receivers[0]!);
    await assert.rejects(
      rig.senderConn.sendMessage({ to: spare.endpoint_id, text: FULL_TEXT }),
      rejectsWith(ArloErrorCode.QUEUE_LIMIT),
      'A duplicate proof cannot refill the instance budget again'
    );
    assert.equal(rig.notifications.length, 8 * 32 + 1);

    // Revoking communication is not proof that the host consumed its backlog.
    await rig.control.revokeRoot(rig.receivers[0]!.root_token, {
      endpoint_id: rig.receivers[0]!.endpoint_id,
    });
    await assert.rejects(
      rig.senderConn.sendMessage({ to: spare.endpoint_id, text: FULL_TEXT }),
      rejectsWith(ArloErrorCode.QUEUE_LIMIT),
      'A revoked root must retain its unresolved share of the instance budget'
    );
    assert.equal(rig.notifications.length, 8 * 32 + 1);
  } finally {
    await stopRig(rig);
  }
});

test('Out-of-order receipts, consumption proofs, and conflicts keep admission bounded by the ledger', { timeout: 60000 }, async () => {
  let clock = Date.UTC(2026, 0, 1);
  const rig = await startRig({
    receiverCount: 2,
    autoReceipt: false,
    maxTrackedMessages: 4,
    messageRecordTtlMs: 200,
    now: () => clock,
  });
  try {
    const targetB = rig.receivers[0]!.endpoint_id;
    const targetC = rig.receivers[1]!.endpoint_id;
    const receiptFor = (
      frame: ArloMessageNotificationParams,
      receiver: RootRegistrationResponse,
      status: 'enqueued' | 'not_enqueued'
    ) =>
      rig.control.submitReceipt(receiver.root_token, {
        daemon_id: frame.daemon_id,
        endpoint_id: receiver.endpoint_id,
        message_id: frame.message_id,
        delivery_id: frame.delivery_id,
        generation: frame.target_generation,
        status,
        native_message_id: `native-${frame.message_id}`,
      });

    // m1: ACK, then consumption, then repeated proofs — all idempotent.
    await rig.senderConn.sendMessage({ to: targetB, text: 'm1' });
    const m1 = rig.notifications[0]!;
    await receiptFor(m1, rig.receivers[0]!, 'enqueued');
    await releaseFor(rig, m1, rig.receivers[0]!);
    await releaseFor(rig, m1, rig.receivers[0]!);
    await receiptFor(m1, rig.receivers[0]!, 'enqueued');

    // m2: consumption before the ACK, then the late definite receipt.
    await rig.senderConn.sendMessage({ to: targetB, text: 'm2' });
    const m2 = rig.notifications[1]!;
    await releaseFor(rig, m2, rig.receivers[0]!);
    await receiptFor(m2, rig.receivers[0]!, 'enqueued');

    // m3: contradicting definite receipts are a protocol fault on C.
    await rig.senderConn.sendMessage({ to: targetC, text: 'm3' });
    const m3 = rig.notifications[2]!;
    await receiptFor(m3, rig.receivers[1]!, 'enqueued');
    await assert.rejects(receiptFor(m3, rig.receivers[1]!, 'not_enqueued'), rejectsWith(ArloErrorCode.RECEIPT_CONFLICT));

    // The ledger now holds three IDs (m1, m2 settled; m3 conflicted-active).
    await rig.senderConn.sendMessage({ to: targetB, text: 'm4' });
    const m4 = rig.notifications[3]!;
    await receiptFor(m4, rig.receivers[0]!, 'enqueued');

    await assert.rejects(
      rig.senderConn.sendMessage({ to: targetB, text: 'm5' }),
      rejectsWith(ArloErrorCode.ACCOUNTING_UNAVAILABLE),
      'A full tracking budget refuses new admission instead of evicting records'
    );

    // Expiry moves settled results into the retired set; the budget stays full.
    clock += 1000;
    await assert.rejects(
      rig.senderConn.sendMessage({ to: targetB, text: 'm6' }),
      rejectsWith(ArloErrorCode.ACCOUNTING_UNAVAILABLE),
      'Expired results keep their replay-protection budget'
    );
    assert.equal(rig.notifications.length, 4, 'Refused dispatches never reach a host');
    assert.equal((await rig.senderConn.getMessageStatus(m1.message_id)).status, 'result_unavailable');
    assert.equal((await rig.senderConn.getMessageStatus(m2.message_id)).status, 'result_unavailable');
    assert.equal((await rig.senderConn.getMessageStatus(m3.message_id)).status, 'receipt_conflict');
    assert.equal((await rig.senderConn.getMessageStatus(m4.message_id)).status, 'accepted');
  } finally {
    await stopRig(rig);
  }
});
