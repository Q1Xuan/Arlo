import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ReceptionLedger, type ReceptionEvidence } from '@arlo/adapter-sdk';
import type { ArloMessageNotificationParams } from '@arlo/sdk';
import {
  ClaudeCodeReceptionHost,
  ClaudeCodeQueueStorage,
  type ClaudeCodeStorageOptions,
} from '../packages/adapter-claudecode/src/index.ts';
import { createTempDir, durableStatus, readDurableQueue, removeTempDir } from './test-utils.ts';

function createFrame(seq: number, text = `hello ${seq}`): ArloMessageNotificationParams {
  return {
    protocol_version: '0.1',
    daemon_id: 'daemon-test',
    message_id: `msg-${seq}`,
    delivery_id: `del-${seq}`,
    from_endpoint: 'sender-endpoint',
    to_endpoint: 'cc-receiver-endpoint',
    group_id: 'group-test',
    target_generation: 1,
    delivery_seq: String(seq),
    text,
    sent_at: new Date().toISOString(),
  };
}

test('Durable Reception Host & Storage (Seam B)', async (t) => {
  const tempDir = createTempDir('cc-reception-test-');
  const sessionId = 'session-cc-durable-01';

  t.after(() => {
    removeTempDir(tempDir);
  });

  await t.test('persists message to disk before returning enqueued', async () => {
    const host = new ClaudeCodeReceptionHost({
      sessionId,
      storageDir: tempDir,
    });

    const frame = createFrame(1, 'Durable payload 1');
    const prepared = host.prepare(frame);
    assert.ok(prepared.nativeMessageId, 'nativeMessageId must be generated');

    // Before enqueue(), message is not yet durable
    let snapshot = host.snapshot({ instanceId: host.instanceId, generation: 1 });
    assert.equal(snapshot.pending.length, 0);

    const outcome = await prepared.enqueue();
    assert.equal(outcome, 'enqueued', 'Must return enqueued on success');

    // Immediately check disk storage
    const queueFile = path.join(tempDir, sessionId, 'queue.jsonl');
    assert.ok(fs.existsSync(queueFile), 'Queue file must exist on disk');
    const content = fs.readFileSync(queueFile, 'utf8');
    assert.match(content, /msg-1/, 'Message ID must be present in queue file');
    assert.match(content, /Durable payload 1/, 'Payload text must be present on disk');

    // Host snapshot reflects pending message
    snapshot = host.snapshot({ instanceId: host.instanceId, generation: 1 });
    assert.equal(snapshot.pending.length, 1);
    assert.equal(snapshot.pending[0].messageId, 'msg-1');
  });

  await t.test('recovers unconsumed enqueued messages after crash / host restart', async () => {
    const restartDir = path.join(tempDir, 'restart-test');
    fs.mkdirSync(restartDir, { recursive: true });

    // Host 1: enqueues 2 messages and "crashes"
    const host1 = new ClaudeCodeReceptionHost({
      sessionId: 'session-restart-01',
      storageDir: restartDir,
    });
    const p1 = host1.prepare(createFrame(10, 'Crash test 10'));
    const p2 = host1.prepare(createFrame(11, 'Crash test 11'));
    assert.equal(await p1.enqueue(), 'enqueued');
    assert.equal(await p2.enqueue(), 'enqueued');

    // Host 2: New process instance starts with same storageDir
    const host2 = new ClaudeCodeReceptionHost({
      sessionId: 'session-restart-01',
      storageDir: restartDir,
    });
    await host2.recover();

    const pending = host2.getPendingMessages();
    assert.equal(pending.length, 2, 'Must recover exactly 2 pending messages');
    assert.equal(pending[0].messageId, 'msg-10');
    assert.equal(pending[1].messageId, 'msg-11');
    const snapshot = host2.snapshot({ instanceId: host2.instanceId, generation: 1 });
    assert.equal(snapshot.pending.length, 2);
    assert.equal(snapshot.inFlight.length, 0);
  });

  await t.test('returns not_enqueued on storage failure (no uncommitted ACKs)', async () => {
    const failDir = path.join(tempDir, 'fail-test');
    const host = new ClaudeCodeReceptionHost({
      sessionId: 'session-fail-01',
      storageDir: failDir,
      // Inject faulty writer that fails
      faultInjection: {
        failWrites: true,
      },
    });

    const prepared = host.prepare(createFrame(99, 'Will fail'));
    const outcome = await prepared.enqueue();
    assert.equal(outcome, 'not_enqueued', 'Must return not_enqueued if disk write fails');

    const snapshot = host.snapshot({ instanceId: host.instanceId, generation: 1 });
    assert.equal(snapshot.pending.length, 0, 'No uncommitted pending messages allowed');
  });

  await t.test('integrates with ReceptionLedger for accepted confirmation and claim evidence', async () => {
    const ledgerDir = path.join(tempDir, 'ledger-test');
    const host = new ClaudeCodeReceptionHost({
      sessionId: 'session-ledger-01',
      storageDir: ledgerDir,
    });

    const evidences: ReceptionEvidence[] = [];
    host.observe((e) => evidences.push(e));

    const ledger = new ReceptionLedger({
      host,
      currentGeneration: 1,
    });

    const frame = createFrame(20, 'Ledger integration');
    const receipt = await ledger.receiveFrame(frame);
    assert.equal(receipt.status, 'enqueued', 'Ledger confirms enqueued only after host succeeds');

    // Claim the message
    const snapshot = host.snapshot({ instanceId: host.instanceId, generation: 1 });
    assert.equal(snapshot.pending.length, 1);
    const nativeId = snapshot.pending[0].nativeMessageId;

    await host.settle(nativeId, 'claimed');

    // Evidence published
    assert.ok(evidences.some((e) => e.nativeMessageId === nativeId && e.event === 'claimed'));

    // Capacity released
    const afterSnapshot = host.snapshot({ instanceId: host.instanceId, generation: 1 });
    assert.equal(afterSnapshot.pending.length, 0, 'Claimed message releases pending capacity');
  });

  await t.test('state transitions: enqueued -> submitting moves message from pending to inFlight in snapshot', async () => {
    const stateDir = path.join(tempDir, 'state-transition-test');
    const host = new ClaudeCodeReceptionHost({
      sessionId: 'session-state-01',
      storageDir: stateDir,
    });

    const prepared = host.prepare(createFrame(30, 'State transition payload'));
    await prepared.enqueue();

    // 1. Initial enqueued state -> in pending
    let snapshot = host.snapshot({ instanceId: host.instanceId, generation: 1 });
    assert.equal(snapshot.pending.length, 1, 'Enqueued message must be in pending');
    assert.equal(snapshot.inFlight.length, 0, 'No in-flight messages initially');
    const nativeId = prepared.nativeMessageId;

    // 2. Dispatch, then record the returned handoff. Both stay in flight.
    host.beginDispatch(nativeId);
    host.recordHandoff(nativeId);
    snapshot = host.snapshot({ instanceId: host.instanceId, generation: 1 });
    assert.equal(snapshot.pending.length, 0, 'Submitting message leaves pending');
    assert.equal(snapshot.inFlight.length, 1, 'Submitting message enters inFlight');
    assert.equal(snapshot.inFlight[0].nativeMessageId, nativeId);

    // 3. Settle as claimed -> leaves both
    await host.settle(nativeId, 'claimed');
    snapshot = host.snapshot({ instanceId: host.instanceId, generation: 1 });
    assert.equal(snapshot.pending.length, 0);
    assert.equal(snapshot.inFlight.length, 0);
  });

  await t.test('crash recovery: resumes never-submitted messages and keeps in-flight messages unknown', async () => {
    const crashDir = path.join(tempDir, 'crash-recovery-test');
    const host1 = new ClaudeCodeReceptionHost({
      sessionId: 'session-crash-01',
      storageDir: crashDir,
    });

    const waiting = host1.prepare(createFrame(41, 'Never submitted before crash'));
    await waiting.enqueue();
    const prepared = host1.prepare(createFrame(40, 'Message in-flight during crash'));
    await prepared.enqueue();
    host1.beginDispatch(prepared.nativeMessageId);
    const handed = host1.prepare(createFrame(42, 'Handed off before crash'));
    await handed.enqueue();
    const submittedMarker = readDurableQueue(crashDir, 'session-crash-01')
      .find((record) => record.messageId === 'msg-42')!.correlationId;
    host1.beginDispatch(handed.nativeMessageId);
    host1.recordHandoff(handed.nativeMessageId);

    // Snapshot on crashed host shows inFlight
    const snap1 = host1.snapshot({ instanceId: host1.instanceId, generation: 1 });
    assert.equal(snap1.pending.length, 1);
    assert.equal(snap1.inFlight.length, 2);

    // Host 1 abruptly crashes / stops without settling.
    // Host 2 starts on the same durable storage directory.
    const host2 = new ClaudeCodeReceptionHost({
      sessionId: 'session-crash-01',
      storageDir: crashDir,
    });
    await host2.recover();

    const snap2 = host2.snapshot({ instanceId: host2.instanceId, generation: 1 });
    assert.equal(snap2.pending.length, 1);
    assert.equal(snap2.inFlight.length, 2);
    const recovered = host2.getPendingMessages();
    assert.equal(recovered.length, 1, 'Never-submitted message resumes scheduling');
    assert.equal(recovered[0].nativeMessageId, waiting.nativeMessageId);
    const records = readDurableQueue(crashDir, 'session-crash-01');
    assert.equal(records.find((record) => record.messageId === 'msg-40')?.status, 'unknown');
    assert.equal(records.find((record) => record.messageId === 'msg-41')?.status, 'enqueued');
    // A handoff that crashed before its claim was proven ends unknown. Its
    // business text is never submitted again, and its marker is not reissued.
    assert.equal(records.find((record) => record.messageId === 'msg-42')?.status, 'unknown');
    assert.equal(records.find((record) => record.messageId === 'msg-42')?.correlationId, submittedMarker);
  });
});

test('durable queue repairs only a torn final record before accepting more input', async (t) => {
  const storageDir = createTempDir('cc-torn-tail-');
  t.after(() => removeTempDir(storageDir));
  const options = { sessionId: 'torn-tail', storageDir };
  const first = new ClaudeCodeReceptionHost(options);
  await first.prepare(createFrame(101)).enqueue();
  const queueFile = path.join(storageDir, options.sessionId, 'queue.jsonl');
  fs.appendFileSync(queueFile, '{"nativeMessageId":"interrupted');

  const recovered = new ClaudeCodeReceptionHost(options);
  await recovered.recover();
  assert.equal(await recovered.prepare(createFrame(102)).enqueue(), 'enqueued');
  const restarted = new ClaudeCodeReceptionHost(options);
  await restarted.recover();
  assert.deepEqual(restarted.getPendingMessages().map((record) => record.messageId), ['msg-101', 'msg-102']);
});

test('durable queue rejects complete malformed records instead of proving their absence', async (t) => {
  const storageDir = createTempDir('cc-corrupt-queue-');
  t.after(() => removeTempDir(storageDir));
  const options = { sessionId: 'corrupt-queue', storageDir };
  const host = new ClaudeCodeReceptionHost(options);
  await host.prepare(createFrame(103)).enqueue();
  const queueFile = path.join(storageDir, options.sessionId, 'queue.jsonl');
  const valid = fs.readFileSync(queueFile, 'utf8');
  const malformedStatus = JSON.stringify({ ...JSON.parse(valid), status: ['enqueued'] }) + '\n';
  for (const malformed of ['broken-json\n', '{}\n', 'null\n', malformedStatus]) {
    fs.writeFileSync(queueFile, malformed + valid);
    await assert.rejects(new ClaudeCodeReceptionHost(options).recover(), /corrupt|invalid/i);
    assert.equal(fs.readFileSync(queueFile, 'utf8'), malformed + valid);
  }
});

test('short writes never acknowledge a truncated queue record', async (t) => {
  const storageDir = createTempDir('cc-short-write-');
  t.after(() => removeTempDir(storageDir));
  const options = { sessionId: 'short-write', storageDir };
  const originalWrite = fs.writeSync;
  t.mock.method(fs, 'writeSync', (fd: number, data: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
    if (typeof data === 'string') return originalWrite(fd, data.slice(0, 9));
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const offset = typeof args[0] === 'number' ? args[0] : 0;
    return originalWrite(fd, buffer, offset, Math.min(9, buffer.length - offset));
  });
  const host = new ClaudeCodeReceptionHost(options);
  assert.equal(await host.prepare(createFrame(104, '多字节 payload')).enqueue(), 'enqueued');
  const recovered = new ClaudeCodeReceptionHost(options);
  await recovered.recover();
  assert.equal(recovered.getPendingMessages()[0]?.text, '多字节 payload');
});

test('a staging fsync failure leaves the authoritative queue unchanged and cannot replay rejected input', async (t) => {
  const storageDir = createTempDir('cc-fsync-failure-');
  t.after(() => removeTempDir(storageDir));
  const options = { sessionId: 'fsync-failure', storageDir };
  const host = new ClaudeCodeReceptionHost(options);
  assert.equal(await host.prepare(createFrame(105)).enqueue(), 'enqueued');
  const queueFile = path.join(storageDir, options.sessionId, 'queue.jsonl');
  const before = fs.readFileSync(queueFile, 'utf8');
  const sync = t.mock.method(fs, 'fsyncSync', () => { throw new Error('EIO after complete write'); });
  assert.equal(await host.prepare(createFrame(106)).enqueue(), 'not_enqueued');
  sync.mock.restore();
  assert.equal(fs.readFileSync(queueFile, 'utf8'), before);
  const recovered = new ClaudeCodeReceptionHost(options);
  await recovered.recover();
  assert.deepEqual(recovered.getPendingMessages().map((record) => record.messageId), ['msg-105']);
});

test('failed dispatch persistence leaves input pending and retry durably reserves it', async (t) => {
  const storageDir = createTempDir('cc-transition-failure-');
  t.after(() => removeTempDir(storageDir));
  const options = { sessionId: 'transition-failure', storageDir };
  const host = new ClaudeCodeReceptionHost(options);
  const prepared = host.prepare(createFrame(107));
  await prepared.enqueue();
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('EBUSY replacing queue'); });
  assert.throws(() => host.beginDispatch(prepared.nativeMessageId), (error: unknown) =>
    error instanceof Error && error.cause instanceof Error && /EBUSY/.test(error.cause.message));
  assert.equal(host.getPendingMessages().length, 1);
  rename.mock.restore();
  host.beginDispatch(prepared.nativeMessageId);
  const recovered = new ClaudeCodeReceptionHost(options);
  await recovered.recover();
  assert.equal(recovered.getPendingMessages().length, 0);
  assert.equal(durableStatus(storageDir, 'transition-failure', 'msg-107'), 'unknown');
  const snapshot = recovered.snapshot({ instanceId: recovered.instanceId, generation: 1 });
  assert.deepEqual(snapshot.pending, []);
  assert.equal(snapshot.inFlight.length, 1);
});

test('storage refuses zero-byte writes without changing the queue', async (t) => {
  const storageDir = createTempDir('cc-zero-write-');
  t.after(() => removeTempDir(storageDir));
  const options = { sessionId: 'zero-write', storageDir };
  const host = new ClaudeCodeReceptionHost(options);
  await host.prepare(createFrame(108)).enqueue();
  const storage = new ClaudeCodeQueueStorage(options);
  const before = fs.readFileSync(storage.queueFile, 'utf8');
  t.mock.method(fs, 'writeSync', () => 0);
  assert.equal(await host.prepare(createFrame(109)).enqueue(), 'not_enqueued');
  assert.equal(fs.readFileSync(storage.queueFile, 'utf8'), before);
});

test('recovery preserves a complete final JSON record whose newline is missing', async (t) => {
  const storageDir = createTempDir('cc-missing-newline-');
  t.after(() => removeTempDir(storageDir));
  const options = { sessionId: 'missing-newline', storageDir };
  const host = new ClaudeCodeReceptionHost(options);
  await host.prepare(createFrame(110)).enqueue();
  const queueFile = path.join(storageDir, options.sessionId, 'queue.jsonl');
  fs.truncateSync(queueFile, fs.statSync(queueFile).size - 1);
  const recovered = new ClaudeCodeReceptionHost(options);
  await recovered.recover();
  assert.deepEqual(recovered.getPendingMessages().map((record) => record.messageId), ['msg-110']);
  assert.equal(fs.readFileSync(queueFile, 'utf8').endsWith('\n'), true);
});

test('a post-publication directory sync failure reports unknown and keeps input capacity', async (t) => {
  const storageDir = createTempDir('cc-directory-sync-');
  t.after(() => removeTempDir(storageDir));
  const options = { sessionId: 'directory-sync', storageDir };
  const host = new ClaudeCodeReceptionHost(options);
  await host.prepare(createFrame(111)).enqueue();
  const sessionDir = path.join(storageDir, options.sessionId);
  const queueFile = path.join(sessionDir, 'queue.jsonl');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  const directoryDescriptors = new Set<number>();
  // Emulate directory descriptors on Windows so the POSIX durability failure
  // exercises the same publish/fsync boundary on every development platform.
  t.mock.method(fs, 'openSync', (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (file === sessionDir) {
      const fd = open(queueFile, 'r');
      directoryDescriptors.add(fd);
      return fd;
    }
    const fd = open(file, flags, mode);
    directoryDescriptors.delete(fd);
    return fd;
  });
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    if (directoryDescriptors.has(fd)) throw new Error('EIO syncing directory after rename');
    return sync(fd);
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  try {
    assert.equal(await host.prepare(createFrame(112)).enqueue(), 'unknown');
    assert.equal(host.snapshot({ instanceId: host.instanceId, generation: 1 }).pending.length, 2);
    const recovered = new ClaudeCodeReceptionHost(options);
    await recovered.recover();
    assert.deepEqual(recovered.getPendingMessages().map((record) => record.messageId), ['msg-111', 'msg-112']);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});


test('recovered input retains local count and byte limits across repeated Sidecar replacements', async t => {
  const dir = createTempDir('cc-recovered-capacity');
  t.after(() => removeTempDir(dir));
  for (const limit of ['count', 'bytes']) {
    const options = { sessionId: `capacity-${limit}`, storageDir: dir };
    let host = new ClaudeCodeReceptionHost(options);
    const count = limit === 'count' ? 64 : 4;
    const text = limit === 'count' ? 'test' : 'x'.repeat(256 * 1024);
    for (let i = 0; i < count; i++) {
      const input = host.prepare(createFrame(i + 1, text));
      assert.equal(await input.enqueue(), 'enqueued');
      if (i < count - 1) host.beginDispatch(input.nativeMessageId);
    }
    for (let restart = 0; restart < 2; restart++) {
      host = new ClaudeCodeReceptionHost(options);
      await host.recover();
      const snapshot = host.snapshot({ instanceId: host.instanceId, generation: 1 });
      assert.equal(snapshot.inFlight.length, count - 1, 'unknown inputs still occupy the full local snapshot');
      assert.equal(snapshot.pending.length, 1);
      assert.equal(await host.prepare(createFrame(100 + restart, 'overflow')).enqueue(), 'not_enqueued');
      assert.equal(readDurableQueue(dir, options.sessionId).length, count);
      const ledger = new ReceptionLedger({ host: host.endpointReception, currentGeneration: 1 });
      assert.deepEqual(ledger.reconcilePendingMessageIds(), [], 'old dispatch ids do not become new endpoint credit');
      assert.equal((await ledger.receiveFrame(createFrame(200 + restart, 'overflow'))).status, 'rejected');
      ledger.dispose();
    }
    const waiting = host.getPendingMessages()[0]!;
    host.beginDispatch(waiting.nativeMessageId);
    host.recordNotEntered(waiting.nativeMessageId);
    assert.equal(await host.prepare(createFrame(300, text)).enqueue(), 'enqueued', 'settled input releases its local capacity');
    assert.equal(await host.prepare(createFrame(301, 'overflow')).enqueue(), 'not_enqueued');
  }
});
