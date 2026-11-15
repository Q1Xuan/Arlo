import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  ArloErrorCode,
  ControlClient,
  DaemonClient,
  MAX_ROOT_PENDING_BYTES,
  MAX_ROOT_PENDING_MESSAGES,
  MAX_SINGLE_TEXT_BYTES,
  type ArloMessageNotificationParams,
  type ReadyRootRequest,
} from '@arlo/sdk';
import { ArloDaemon } from '@arlo/daemon';
import { ReceptionLedger } from '@arlo/adapter-sdk';
import { createDshReceptionHost, createArloHarnessPlugin, arloMessage } from '@arlo/adapter-dsh/runtime';
import { fixture, LocalModel } from '../probes/fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

interface FrameOverrides {
  messageId?: string;
  seq?: string;
  text?: string;
}

function makeFrame(overrides: FrameOverrides = {}): ArloMessageNotificationParams {
  const seq = overrides.seq ?? '1';
  return {
    protocol_version: '0.1',
    daemon_id: 'daemon-capacity',
    message_id: overrides.messageId ?? `msg-${seq}`,
    delivery_id: `del-${overrides.messageId ?? seq}`,
    from_endpoint: 'ep-sender',
    to_endpoint: 'ep-root',
    group_id: 'group-capacity',
    target_generation: 1,
    delivery_seq: seq,
    text: overrides.text ?? `text-${seq}`,
    sent_at: '2026-01-01T00:00:00.000Z',
  };
}

/** One text block per message; only text blocks carry bytes the budget counts. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isArloMessage(message: { source?: unknown }): boolean {
  return (message.source as { kind?: string } | undefined)?.kind === 'arlo';
}

function arloPendingIn(host: Awaited<ReturnType<typeof fixture>>): number {
  return [...host.root.agent.inbox.nextTurn, ...host.root.agent.inbox.nextStep].filter(
    isArloMessage
  ).length;
}

test('The per-root byte budget counts UTF-8 bytes, refuses overflow, and keeps a rejected frame rejected after release', async () => {
  const model = new LocalModel();
  const host = await fixture(model);
  const heldTurn = Promise.withResolvers<void>();
  const turnStarted = Promise.withResolvers<void>();
  model.beforeResponse = () => { turnStarted.resolve(); return heldTurn.promise; };
  const deduplicator = new ReceptionLedger({
    host: createDshReceptionHost(host.root.agent),
    currentGeneration: 1,
  });
  let insertions = 0;
  const stopCounting = host.ctx.on('agent/inbox/inserted', ({ message }) => {
    if (isArloMessage(message)) insertions++;
  });
  // Legal 32 KiB frames fill the byte budget before the 64-message limit.
  // Counting UTF-16 characters instead would leave half the budget unused.
  const text = 'é'.repeat(MAX_SINGLE_TEXT_BYTES / 2);
  const frameCount = MAX_ROOT_PENDING_BYTES / utf8Bytes(text);
  const frame = (seq: number) =>
    makeFrame({ messageId: `msg-byte-${seq}`, seq: String(seq), text });
  try {
    host.root.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'hold the local turn while byte capacity is tested' }],
      source: { kind: 'user' },
    }));
    await turnStarted.promise;
    const results = [];
    for (let seq = 1; seq <= frameCount; seq++) {
      const result = await deduplicator.receiveFrame(frame(seq));
      assert.equal(result.status, 'enqueued', `frame ${seq} must be enqueued`);
      results.push(result);
    }
    assert.equal(insertions, frameCount, 'The real host received every frame');

    const overflowFrame = frame(frameCount + 1);
    const overflow = await deduplicator.receiveFrame(overflowFrame);
    assert.equal(overflow.status, 'rejected');
    assert.equal(overflow.reason, ArloErrorCode.QUEUE_LIMIT);
    const insertionsAtOverflow = insertions;

    const releasedNativeId = results[0]!.native_message_id;
    const releasedMessage = host.root.agent.inbox.nextTurn.find(message => String(message.id) === releasedNativeId);
    assert.ok(releasedMessage);
    assert.equal(host.root.agent.inbox.remove(releasedMessage.id), true);
    assert.ok(!deduplicator.reconcilePendingMessageIds().includes('msg-byte-1'));
    assert.deepEqual(
      await deduplicator.receiveFrame(overflowFrame),
      overflow,
      'A byte-rejected frame keeps its retained result after credit becomes available'
    );
    assert.equal(insertions, insertionsAtOverflow, 'The retained rejection must not insert late');

    const successor = await deduplicator.receiveFrame(frame(frameCount + 2));
    assert.equal(successor.status, 'enqueued', 'A new frame uses the freed byte credit');
    assert.equal(insertions, insertionsAtOverflow + 1);
    assert.equal(host.root.agent.inbox.remove(releasedMessage.id), false);
    assert.ok(!deduplicator.reconcilePendingMessageIds().includes('msg-byte-1'));
    assert.deepEqual(
      await deduplicator.receiveFrame(frame(frameCount + 3)),
      overflow,
      'A duplicate removal and reconciliation cannot admit another frame'
    );
    assert.equal(insertions, insertionsAtOverflow + 1);
  } finally {
    stopCounting();
    deduplicator.dispose();
    model.beforeResponse = undefined;
    heldTurn.resolve();
    await host.root.agent.whenIdle();
    await host.ctx.fiber.dispose();
  }
});

test('A paused host accumulates bounded backlog and a re-attached adapter observes the same occupancy', { timeout: 20000 }, async () => {
  const model = new LocalModel();
  const host = await fixture(model);
  const hold = Promise.withResolvers<void>();
  let turnStarted = false;
  model.beforeResponse = async () => {
    if (turnStarted) await hold.promise;
  };
  const deduplicator = new ReceptionLedger({ host: createDshReceptionHost(host.root.agent), currentGeneration: 1 });
  let insertions = 0;
  const stopCounting = host.ctx.on('agent/inbox/inserted', ({ message }) => {
    if (isArloMessage(message)) insertions++;
  });
  try {
    // Keep the host busy inside a real turn so delivered input stays pending.
    turnStarted = true;
    host.root.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: 'turn that keeps the host busy' }],
        source: { kind: 'arlo', form: 'relay' },
      })
    );
    for (let i = 0; i < 100 && host.root.agent.status !== 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(host.root.agent.status, 'running');

    const small = 'é'.repeat(512); // 1,024 bytes UTF-8
    const large = 'é'.repeat(1024); // 2,048 bytes UTF-8
    const frames = [
      makeFrame({ messageId: 'msg-busy-1', seq: '1', text: small }),
      makeFrame({ messageId: 'msg-busy-2', seq: '2', text: large }),
    ];
    for (const frame of frames) {
      const result = await deduplicator.receiveFrame(frame);
      assert.equal(result.status, 'enqueued');
    }
    assert.equal(deduplicator.getAvailableCapacity(), 62);
    assert.equal(arloPendingIn(host), 2, 'The busy host holds the delivered input');

    // An undecided insertion consumes the same occupancy as a settled one.
    const stopThrowing = host.ctx.on('internal/dispatch', (_type, name) => {
      if (name === 'agent/inbox/inserted') throw new Error('post-insert-canary');
    });
    const uncertain = await deduplicator.receiveFrame(
      makeFrame({ messageId: 'msg-busy-3', seq: '3', text: small })
    );
    stopThrowing();
    assert.equal(uncertain.status, 'unknown');
    assert.equal(uncertain.reason, ArloErrorCode.ENQUEUE_UNCERTAIN);
    assert.equal(deduplicator.getAvailableCapacity(), 61, 'The undecided record holds its credit');

    const fullText = 'é'.repeat(MAX_SINGLE_TEXT_BYTES / 2);
    for (let seq = 4; seq <= 34; seq++) {
      assert.equal((await deduplicator.receiveFrame(makeFrame({ seq: String(seq), text: fullText }))).status, 'enqueued');
    }
    const remaining = MAX_ROOT_PENDING_BYTES - utf8Bytes(small) * 2 - utf8Bytes(large) - 31 * utf8Bytes(fullText);
    const fittingText = 'é'.repeat(remaining / 2);
    const overflowFrame = makeFrame({ seq: '35', text: `${fittingText}x` });
    const queueLimit = { status: 'rejected', reason: ArloErrorCode.QUEUE_LIMIT };
    assert.deepEqual(
      await deduplicator.receiveFrame(overflowFrame),
      queueLimit,
      'The unknown insertion must retain its bytes: even one excess byte is refused'
    );

    // Re-attachment enforces the same byte boundary using the public inbox,
    // without a diagnostic getter into either adapter's accounting.
    const reattached = new ReceptionLedger({ host: createDshReceptionHost(host.root.agent), currentGeneration: 1 });
    try {
      assert.equal(reattached.getPendingMessageIds().length, 34);
      assert.equal(reattached.getAvailableCapacity(), 30);
      assert.deepEqual(await reattached.receiveFrame(overflowFrame), queueLimit);
      assert.equal(arloPendingIn(host), 34, 'Re-attachment must not consume or clear host input');
      const insertionsBeforeRefill = insertions;
      assert.equal(
        (await deduplicator.receiveFrame(makeFrame({ seq: '36', text: fittingText }))).status,
        'enqueued',
        'Exactly the remaining bytes still fit'
      );
      const oneMoreByte = makeFrame({ seq: '37', text: 'x' });
      assert.deepEqual(await deduplicator.receiveFrame(oneMoreByte), queueLimit);
      assert.deepEqual(await reattached.receiveFrame(oneMoreByte), queueLimit);
      assert.equal(insertions, insertionsBeforeRefill + 1);
    } finally {
      reattached.dispose();
    }
  } finally {
    stopCounting();
    deduplicator.dispose();
    hold.resolve();
    await host.root.agent.whenIdle().catch(() => {});
    await host.ctx.fiber.dispose();
  }
});

async function assertReentryReconciles(backlog: ReturnType<typeof arloMessage>[]): Promise<void> {
  const stateDir = createTempDir('harness-domain-reentry');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  interface ReadyAttempt {
    request: ReadyRootRequest;
    error?: unknown;
  }
  const attempts: ReadyAttempt[] = [];
  const firstFailure = Promise.withResolvers<ReadyAttempt>();
  class ObservedControlClient extends ControlClient {
    override async confirmRootReady(token: string, request: ReadyRootRequest) {
      const attempt: ReadyAttempt = { request };
      attempts.push(attempt);
      try {
        const response = await super.confirmRootReady(token, request);
        return response;
      } catch (error) {
        attempt.error = error;
        firstFailure.resolve(attempt);
        throw error;
      }
    }
  }
  try {
    const { port } = await daemon.start();
    const controlClient = new ObservedControlClient({ stateDir, port });
    const userClient = new DaemonClient({ stateDir });

    const fork = await host.ctx.plugin(
      createArloHarnessPlugin({ groupName: 'domain-reentry', stateDir, controlClient })
    );
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      const roots = await userClient.listRoots();
      ready = roots.some((r: any) => r.ready && r.deliverable);
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'The initial attachment must become deliverable');
    assert.equal(attempts.length, 1, 'The first attachment publishes readiness once');
    assert.equal(attempts[0]!.request.reconciled_pending_message_ids?.length ?? 0, 0);

    // Controlled leftover input stays in the real host across runtime exit.
    // A full backlog must reach reconciliation, not a local capacity refusal.
    host.root.agent.inbox.splice('next-turn', Infinity, 0, backlog);
    await fork.dispose();

    await host.ctx.plugin(
      createArloHarnessPlugin({ groupName: 'domain-reentry', stateDir, controlClient })
    );
    const failed = await Promise.race([
      firstFailure.promise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10000)),
    ]);
    assert.ok(failed, 'The re-attached plugin must attempt readiness and be refused');
    assert.equal(
      (failed.error as { code?: string } | undefined)?.code,
      ArloErrorCode.ACCOUNTING_UNAVAILABLE,
      'A re-entering domain with unaccounted host pending must not publish readiness'
    );
    assert.deepEqual(failed.request.reconciled_pending_message_ids, backlog.map((message) => String(message.id)));
    assert.deepEqual(host.root.agent.inbox.nextTurn, backlog, 'A refused re-entry must preserve host input');
    assert.ok((await userClient.listRoots()).every((root) => !root.ready && !root.deliverable));
  } finally {
    await host.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
}

test('A byte-full backlog reaches daemon reconciliation when the plugin re-attaches', { timeout: 30000 }, async () => {
  const text = 'é'.repeat(MAX_SINGLE_TEXT_BYTES / 2);
  await assertReentryReconciles(
    Array.from({ length: MAX_ROOT_PENDING_BYTES / utf8Bytes(text) }, () => arloMessage(text))
  );
});

test('A count-full backlog reaches daemon reconciliation when the plugin re-attaches', { timeout: 30000 }, async () => {
  await assertReentryReconciles(
    Array.from({ length: MAX_ROOT_PENDING_MESSAGES }, (_, i) => arloMessage(`left-behind ${i}`))
  );
});
