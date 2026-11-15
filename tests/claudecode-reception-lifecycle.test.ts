import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ReceptionLedger, type ReceptionEvidence } from '@arlo/adapter-sdk';
import type { ArloMessageNotificationParams } from '@arlo/sdk';
import { ClaudeCodeReceptionHost } from '../packages/adapter-claudecode/src/index.ts';
import { createTempDir, readDurableQueue, removeTempDir } from './test-utils.ts';

function frame(seq: number): ArloMessageNotificationParams {
  return {
    protocol_version: '0.1', daemon_id: 'daemon-lifecycle',
    message_id: `message-${seq}`, delivery_id: `delivery-${seq}`,
    from_endpoint: 'sender', to_endpoint: 'receiver', group_id: 'group-lifecycle',
    target_generation: 1, delivery_seq: String(seq), text: `Lifecycle input ${seq}`,
    sent_at: new Date().toISOString(),
  };
}

test('retiring a live reception discards queued input and preserves unresolved handoff credits', async (t) => {
  const storageDir = createTempDir('cc-retirement-');
  t.after(() => removeTempDir(storageDir));
  const sessionId = 'retired-session';
  const host = new ClaudeCodeReceptionHost({ sessionId, storageDir });
  const ledger = new ReceptionLedger({ host, currentGeneration: 1, initialCapacity: 6 });
  const evidence: ReceptionEvidence[] = [];
  host.observe(item => evidence.push(item));
  const nativeIds: string[] = [];
  for (let seq = 1; seq <= 6; seq++) {
    const result = await ledger.receiveFrame(frame(seq));
    assert.equal(result.status, 'enqueued');
    nativeIds.push(result.native_message_id!);
  }
  host.beginDispatch(nativeIds[1]);
  host.beginDispatch(nativeIds[2]);
  host.recordHandoff(nativeIds[2]);
  host.beginDispatch(nativeIds[3]);
  host.recordUnresolved(nativeIds[3]);
  await host.settle(nativeIds[4], 'claimed');
  await host.settle(nativeIds[5], 'discarded');
  const terminalBefore = readDurableQueue(storageDir, sessionId).slice(4);
  evidence.length = 0;

  host.retire();

  assert.deepEqual(readDurableQueue(storageDir, sessionId).map(record => record.status),
    ['discarded', 'unknown', 'unknown', 'unknown', 'claimed', 'discarded']);
  assert.deepEqual(readDurableQueue(storageDir, sessionId).slice(4), terminalBefore);
  assert.deepEqual(evidence.map(item => [item.nativeMessageId, item.event]), [[nativeIds[0], 'discarded']]);
  assert.deepEqual(host.getPendingMessages(), []);
  assert.deepEqual(ledger.reconcilePendingMessageIds(), ['message-2', 'message-3', 'message-4']);
  assert.equal(ledger.getAvailableCapacity(), 3);
  assert.equal(ledger.getUnconfirmedCredits().find(item => item.message_id === 'message-1')?.event, 'discarded');

  host.retire();
  assert.equal(evidence.length, 1, 'Retirement is idempotent');
});

test('a retired reception rejects delayed enqueues, reports, dispatches and settlement', async (t) => {
  const storageDir = createTempDir('cc-retired-fence-');
  t.after(() => removeTempDir(storageDir));
  const sessionId = 'retired-fence';
  const host = new ClaudeCodeReceptionHost({ sessionId, storageDir });
  const queued = host.prepare(frame(1));
  await queued.enqueue();
  host.beginDispatch(queued.nativeMessageId);
  host.recordHandoff(queued.nativeMessageId);
  const delayed = host.prepare(frame(2));
  host.retire();
  const queueFile = path.join(storageDir, sessionId, 'queue.jsonl');
  const before = fs.readFileSync(queueFile, 'utf8');

  assert.equal(await delayed.enqueue(), 'not_enqueued');
  assert.equal(await host.prepare(frame(3)).enqueue(), 'not_enqueued');
  for (const report of [
    () => host.beginDispatch(queued.nativeMessageId),
    () => host.cancelDispatch(queued.nativeMessageId),
    () => host.recordHandoff(queued.nativeMessageId),
    () => host.recordNotEntered(queued.nativeMessageId),
    () => host.recordUnresolved(queued.nativeMessageId),
    () => host.claim(queued.nativeMessageId, 'message-1', 'irrelevant marker'),
  ]) assert.throws(report, /retired/i);
  await assert.rejects(host.settle(queued.nativeMessageId, 'claimed'), /retired/i);
  await assert.rejects(host.settle(queued.nativeMessageId, 'discarded'), /retired/i);
  await host.recover();
  assert.deepEqual(host.getPendingMessages(), []);
  assert.equal(fs.readFileSync(queueFile, 'utf8'), before);
});

test('replacing the Mod dispatcher preserves the root and queued input without replaying old handoffs', async (t) => {
  const storageDir = createTempDir('cc-dispatcher-replacement-');
  t.after(() => removeTempDir(storageDir));
  const sessionId = 'live-session';
  const host = new ClaudeCodeReceptionHost({ sessionId, storageDir });
  const ledger = new ReceptionLedger({ host, currentGeneration: 1, initialCapacity: 5 });
  const evidence: ReceptionEvidence[] = [];
  host.observe(item => evidence.push(item));
  const nativeIds: string[] = [];
  for (let seq = 1; seq <= 4; seq++) {
    nativeIds.push((await ledger.receiveFrame(frame(seq))).native_message_id!);
  }
  host.beginDispatch(nativeIds[1]);
  host.beginDispatch(nativeIds[2]);
  host.recordHandoff(nativeIds[2]);
  host.beginDispatch(nativeIds[3]);
  host.recordUnresolved(nativeIds[3]);
  const instanceId = host.instanceId;
  const markers = readDurableQueue(storageDir, sessionId).map(record => record.correlationId);

  host.replaceDispatcher();

  assert.equal(host.instanceId, instanceId);
  assert.deepEqual(host.getPendingMessages().map(record => record.messageId), ['message-1']);
  assert.deepEqual(readDurableQueue(storageDir, sessionId).map(record => record.status),
    ['enqueued', 'unknown', 'unknown', 'unknown']);
  assert.deepEqual(readDurableQueue(storageDir, sessionId).map(record => record.correlationId), markers);
  assert.equal(evidence.length, 0);
  assert.equal(ledger.getAvailableCapacity(), 1);
  assert.equal((await ledger.receiveFrame(frame(5))).status, 'enqueued');
  host.beginDispatch(nativeIds[0]);
  assert.deepEqual(host.getPendingMessages().map(record => record.messageId), ['message-5']);
  host.retire();
  assert.throws(() => host.replaceDispatcher(), /retired/i);
});

test('failed retirement stays closed without proving discard and retries the whole durable transition', async (t) => {
  const storageDir = createTempDir('cc-retirement-failure-');
  t.after(() => removeTempDir(storageDir));
  const sessionId = 'failed-retirement';
  const host = new ClaudeCodeReceptionHost({ sessionId, storageDir });
  const ledger = new ReceptionLedger({ host, currentGeneration: 1, initialCapacity: 3 });
  const first = await ledger.receiveFrame(frame(1));
  const second = await ledger.receiveFrame(frame(2));
  host.beginDispatch(second.native_message_id!);
  const evidence: ReceptionEvidence[] = [];
  host.observe(item => evidence.push(item));
  const before = readDurableQueue(storageDir, sessionId);
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('EBUSY retiring queue'); });

  assert.throws(() => host.retire(), /Queue write failed/);
  assert.deepEqual(host.getPendingMessages(), []);
  assert.deepEqual(readDurableQueue(storageDir, sessionId), before);
  assert.equal(evidence.length, 0);
  assert.equal(ledger.getAvailableCapacity(), 0, 'Unconfirmed retirement cannot prove free capacity');
  assert.deepEqual(ledger.reconcilePendingMessageIds(), ['message-1', 'message-2']);
  assert.equal(await host.prepare(frame(3)).enqueue(), 'not_enqueued');
  assert.throws(() => host.beginDispatch(first.native_message_id!), /retired/i);
  await host.recover();
  assert.deepEqual(host.getPendingMessages(), []);
  rename.mock.restore();

  host.retire();
  assert.deepEqual(readDurableQueue(storageDir, sessionId).map(record => record.status), ['discarded', 'unknown']);
  assert.deepEqual(evidence.map(item => item.event), ['discarded']);
  assert.deepEqual(ledger.reconcilePendingMessageIds(), ['message-2']);
});

test('retirement before deferred recovery settles the existing ledger without reviving old pending input', async (t) => {
  const storageDir = createTempDir('cc-retire-before-recover-');
  t.after(() => removeTempDir(storageDir));
  const sessionId = 'recovering-session';
  const options = { sessionId, storageDir };
  const previous = new ClaudeCodeReceptionHost(options);
  await previous.prepare(frame(1)).enqueue();
  const handed = previous.prepare(frame(2));
  await handed.enqueue();
  previous.beginDispatch(handed.nativeMessageId);
  previous.recordHandoff(handed.nativeMessageId);
  const recovered = new ClaudeCodeReceptionHost(options);
  const recovery = Promise.resolve().then(() => recovered.recover());

  recovered.retire();
  await recovery;

  assert.deepEqual(readDurableQueue(storageDir, sessionId).map(record => record.status), ['discarded', 'unknown']);
  assert.deepEqual(recovered.getPendingMessages(), []);
  const snapshot = recovered.snapshot({ instanceId: recovered.instanceId, generation: 1 });
  assert.deepEqual(snapshot.pending, []);
  assert.deepEqual(snapshot.inFlight.map(record => record.messageId), ['message-2']);
  const restarted = new ClaudeCodeReceptionHost(options);
  await restarted.recover();
  assert.deepEqual(restarted.getPendingMessages(), []);
});

test('failed dispatcher replacement fences handoff mutations until the replacement is durably recorded', async (t) => {
  const storageDir = createTempDir('cc-dispatcher-failure-');
  t.after(() => removeTempDir(storageDir));
  const sessionId = 'failed-dispatcher';
  const host = new ClaudeCodeReceptionHost({ sessionId, storageDir });
  const ledger = new ReceptionLedger({ host, currentGeneration: 1, initialCapacity: 3 });
  const queued = await ledger.receiveFrame(frame(1));
  const handed = await ledger.receiveFrame(frame(2));
  host.beginDispatch(handed.native_message_id!);
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('EBUSY replacing dispatcher'); });

  assert.throws(() => host.replaceDispatcher(), /Queue write failed/);
  assert.deepEqual(host.getPendingMessages(), []);
  assert.equal(ledger.getAvailableCapacity(), 0);
  assert.equal(await host.prepare(frame(3)).enqueue(), 'not_enqueued');
  assert.throws(() => host.cancelDispatch(handed.native_message_id!), /replacement/i);
  await assert.rejects(host.settle(queued.native_message_id!, 'discarded'), /replacement/i);
  rename.mock.restore();

  host.replaceDispatcher();
  assert.deepEqual(readDurableQueue(storageDir, sessionId).map(record => record.status), ['enqueued', 'unknown']);
  assert.deepEqual(host.getPendingMessages().map(record => record.messageId), ['message-1']);
  assert.equal(ledger.getAvailableCapacity(), 1);
});

test('an unconfirmed retirement publication retains discard evidence for its successful retry', async (t) => {
  const storageDir = createTempDir('cc-retirement-publication-');
  t.after(() => removeTempDir(storageDir));
  const sessionId = 'retirement-publication';
  const host = new ClaudeCodeReceptionHost({ sessionId, storageDir });
  const ledger = new ReceptionLedger({ host, currentGeneration: 1, initialCapacity: 2 });
  await ledger.receiveFrame(frame(1));
  const evidence: ReceptionEvidence[] = [];
  host.observe(item => evidence.push(item));
  const sessionDir = path.join(storageDir, sessionId);
  const queueFile = path.join(sessionDir, 'queue.jsonl');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  const directoryDescriptors = new Set<number>();
  // Exercise the real rename/directory-sync boundary even on Windows.
  const openMock = t.mock.method(fs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (file === sessionDir) {
      const fd = open(queueFile, 'r');
      directoryDescriptors.add(fd);
      return fd;
    }
    const fd = open(file, flags, mode);
    directoryDescriptors.delete(fd);
    return fd;
  });
  const syncMock = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    if (directoryDescriptors.has(fd)) throw new Error('EIO syncing retirement publication');
    return sync(fd);
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  try {
    assert.throws(() => host.retire(), /publication could not be confirmed/);
    assert.deepEqual(readDurableQueue(storageDir, sessionId).map(record => record.status), ['discarded']);
    assert.equal(evidence.length, 0);
    assert.equal(ledger.getAvailableCapacity(), 0);
  } finally {
    openMock.mock.restore();
    syncMock.mock.restore();
    Object.defineProperty(process, 'platform', platform);
  }

  host.retire();
  assert.deepEqual(evidence.map(item => item.event), ['discarded']);
  assert.equal(ledger.getUnconfirmedCredits()[0]?.event, 'discarded');
  assert.deepEqual(ledger.reconcilePendingMessageIds(), []);
});

test('retirement can finish accounting after a dispatcher replacement failed', async (t) => {
  const storageDir = createTempDir('cc-retire-failed-dispatcher-');
  t.after(() => removeTempDir(storageDir));
  const sessionId = 'retire-failed-dispatcher';
  const host = new ClaudeCodeReceptionHost({ sessionId, storageDir });
  const ledger = new ReceptionLedger({ host, currentGeneration: 1, initialCapacity: 2 });
  await ledger.receiveFrame(frame(1));
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('EBUSY replacing dispatcher'); });
  assert.throws(() => host.replaceDispatcher(), /Queue write failed/);
  rename.mock.restore();

  host.retire();

  assert.deepEqual(ledger.reconcilePendingMessageIds({ requireComplete: true }), []);
  assert.equal(ledger.getUnconfirmedCredits()[0]?.event, 'discarded');
  assert.deepEqual(host.getPendingMessages(), []);
});
