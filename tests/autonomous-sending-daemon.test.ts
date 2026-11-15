import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ServerResponse } from 'node:http';
import { test } from 'node:test';
import {
  ControlClient, ArloErrorCode, MAX_DELIVERY_SEQ, MAX_REPLY_DEPTH,
  ARLO_NOTIFICATION_METHOD, ARLO_MESSAGE_ID_META_KEY,
  createPinnedHttpsAgent, readDiscoveryRecord, sendSecureArloRequest,
} from '@arlo/sdk';
import { autonomousSendingRig as rig } from './helpers/autonomous-sending-fixture.ts';

const hasCode = (code: string) => (error: unknown) =>
  (error as { code?: string; message?: string }).code === code || (error as Error).message?.includes(code);

test('private file reload selects independent root rules without issuing or replacing allowances', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    const a = await r.grant('a');
    const b = await r.grant('b');
    await r.send();
    fs.writeFileSync(a.root_configuration.config_path, JSON.stringify({ version: 1, roots: {
      [a.root_configuration.config_id!]: { mode: 'continuous', grant: 3 },
      [b.root_configuration.config_id!]: { mode: 'bounded', grant: 5 },
    } }), { mode: 0o600 });
    const applied = await r.reload();
    assert.equal(applied.mode, 'continuous');
    assert.equal(applied.next_grant, 3);
    assert.equal(applied.granted, 20);
    assert.equal(applied.used, 1);
    assert.equal(applied.period_id, a.period_id);
    assert.equal(applied.remaining, null);
    const other = await r.status('b');
    assert.equal(other.mode, 'bounded');
    assert.equal(other.next_grant, 5);
    assert.equal(other.period_id, b.period_id);
    assert.equal(other.remaining, 20);
    assert.equal((await r.grant()).period_id, a.period_id);
    for (let i = 0; i < 20; i++) assert.equal((await r.send()).status, 'accepted');
    assert.equal((await r.status()).used, 21);
    fs.writeFileSync(a.root_configuration.config_path, JSON.stringify({ version: 1, roots: {} }), { mode: 0o600 });
    const bounded = await r.reload();
    assert.equal(bounded.mode, 'bounded');
    assert.equal(bounded.next_grant, 20);
    assert.equal(bounded.used, 21);
    assert.equal(bounded.remaining, 0);
    await assert.rejects(r.send(), hasCode(ArloErrorCode.ALLOWANCE_EXHAUSTED));
  } finally { await r.close(); }
});

test('real SDK dispatch shares twenty attempts across targets and preserves message replay after exhaustion', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    const initial = await r.status();
    assert.equal(initial.mode, 'bounded');
    assert.equal(initial.knowledge, 'unknown');
    assert.equal(initial.granted, null);
    assert.equal(initial.used, null);
    assert.equal(initial.remaining, null);
    assert.equal(initial.pause_reason, ArloErrorCode.ALLOWANCE_UNKNOWN);
    assert.equal(initial.next_grant, 20);
    await assert.rejects(r.send(), hasCode(ArloErrorCode.ALLOWANCE_UNKNOWN));
    assert.equal(r.notifications.length, 0);
    const granted = await r.grant();
    assert.equal(granted.granted, 20);
    assert.equal(granted.used, 0);
    assert.equal(granted.remaining, 20);
    assert.equal(granted.knowledge, 'known');
    const sent = [];
    for (let i = 0; i < 20; i++) {
      const result = await r.send(i % 2 ? 'c' : 'b', i % 3 ? `different-${i}` : 'alternating shared text');
      assert.equal(result.status, 'accepted');
      sent.push(result);
    }
    const exhausted = await r.status();
    assert.equal(exhausted.period_id, granted.period_id);
    assert.equal(exhausted.used, 20);
    assert.equal(exhausted.remaining, 0);
    assert.equal(exhausted.pause_reason, ArloErrorCode.ALLOWANCE_EXHAUSTED);
    assert.equal(r.notifications.length, 20);
    await assert.rejects(r.send('c', 'twenty-first'), hasCode(ArloErrorCode.ALLOWANCE_EXHAUSTED));
    const replay = await r.send('b', 'alternating shared text', sent[0].message_id);
    assert.deepEqual(replay, sent[0]);
    await assert.rejects(r.send('b', 'conflicting', sent[0].message_id), hasCode(ArloErrorCode.MESSAGE_ID_CONFLICT));
    assert.equal(r.notifications.length, 20);
    assert.equal((await r.roots.get('a')!.connection.getMessageStatus(sent[0].message_id)).status, 'accepted');
    assert.equal((await r.status()).used, 20);
    const next = await r.grant();
    assert.notEqual(next.period_id, granted.period_id);
    assert.equal(next.used, 0);
    assert.equal(next.remaining, 20);
    assert.equal((await r.send()).status, 'accepted');
    assert.equal((await r.status()).used, 1);
  } finally { await r.close(); }
});

test('one remaining attempt admits at most one concurrent new dispatch', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    await r.grant();
    for (let i = 0; i < 19; i++) assert.equal((await r.send('b', `before-last-${i}`)).status, 'accepted');
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => r.send(i % 2 ? 'b' : 'c', `last-race-${i}`)));
    const accepted = results.filter(result => result.status === 'fulfilled');
    assert.equal(accepted.length, 1);
    assert.ok(results.filter(result => result.status === 'rejected').every(result =>
      result.status === 'rejected' && hasCode(ArloErrorCode.ALLOWANCE_EXHAUSTED)(result.reason)));
    assert.equal(r.notifications.length, 20);
    assert.equal((await r.status()).used, 20);
  } finally { await r.close(); }
});

for (const loseReplies of [false, true]) test(`continue request replay, races, sequence and binding checks never stack grants${loseReplies ? ' when every concurrent reply is lost' : ''}`, { timeout: 120000 }, async t => {
  const r = await rig();
  try {
    const request = await r.continueRequest();
    let dropped = 0;
    const end = ServerResponse.prototype.end;
    const injection = loseReplies ? t.mock.method(ServerResponse.prototype, 'end', function(this: ServerResponse, ...args: Parameters<ServerResponse['end']>) {
      if (this.statusCode === 200 && typeof args[0] === 'string') {
        const body = JSON.parse(args[0]);
        if (body.control_sequence === 1 && body.period_id && dropped < 6) {
          dropped++;
          this.write('{"unfinished":');
          setTimeout(() => this.destroy(), 10);
          return this;
        }
      }
      return Reflect.apply(end, this, args);
    }) : undefined;
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => r.continueWith('a', request)));
    injection?.mock.restore();
    if (loseReplies) assert.equal(dropped, 6, 'All real HTTP grant replies were deliberately lost');
    const responses = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    assert.ok(settled.every(result => result.status === 'fulfilled' || hasCode(ArloErrorCode.CONNECTION_FAILED)(result.reason)),
      'A control deadline may lose a reply, but no authoritative refusal can be hidden');
    // Real Windows ACL verification can delay every concurrent response beyond
    // the SDK deadline. Retry the complete original identity and
    // observe its one durable issuance rather than creating a replacement ID.
    responses.push(await r.continueWith('a', request));
    assert.equal(new Set(responses.map(result => result.period_id)).size, 1);
    assert.ok(responses.every(result => result.remaining === 20 && result.control_sequence === 1));
    await r.send();
    await r.continueWith('a', request);
    assert.equal((await r.status()).used, 1, 'Replayed successful control cannot reset a consumed attempt');
    await assert.rejects(r.continueWith('a', { ...request, request_id: crypto.randomUUID() }), hasCode(ArloErrorCode.STALE_CONTROL_REQUEST));
    await assert.rejects(r.continueWith('a', { ...request, request_id: crypto.randomUUID(), sequence: 3 }), hasCode(ArloErrorCode.STALE_CONTROL_REQUEST));
    await assert.rejects(r.continueWith('a', { ...request, sequence: 2 }), hasCode(ArloErrorCode.CONTROL_REQUEST_CONFLICT));
    await assert.rejects(r.continueWith('b', request), hasCode(ArloErrorCode.UNAUTHORIZED));
    await assert.rejects(r.continueWith('b', { ...request, ...r.request('b') }), hasCode(ArloErrorCode.CONTROL_REQUEST_CONFLICT));
    const beforeRotate = await r.status();
    const oldToken = r.roots.get('a')!.binding.root_token;
    await r.rotate();
    assert.equal((await r.status()).period_id, beforeRotate.period_id);
    assert.equal((await r.status()).used, 1);
    await assert.rejects(r.control().continueCollaboration(oldToken, request), error =>
      hasCode(ArloErrorCode.STALE_GENERATION)(error) || hasCode(ArloErrorCode.UNAUTHORIZED)(error));
    const fresh = await r.grant();
    assert.equal(fresh.remaining, 20, 'A new operation replaces, rather than adds to, nineteen remaining attempts');
    assert.equal(fresh.control_sequence, 2);
  } finally { await r.close(); }
});

test('real connection rotation preserves usage and a fresh daemon stays unknown until a new trusted operation', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    const oldRequest = await r.continueRequest();
    const first = await r.continueWith('a', oldRequest);
    await r.send();
    await r.send('c');
    await r.rotate();
    const resumed = await r.status();
    assert.equal(resumed.period_id, first.period_id);
    assert.equal(resumed.used, 2);
    assert.equal(resumed.remaining, 18);
    await r.restart();
    const lost = await r.status();
    assert.notEqual(lost.daemon_id, first.daemon_id);
    assert.equal(lost.knowledge, 'unknown');
    assert.equal(lost.used, null);
    assert.equal(lost.remaining, null);
    assert.equal(lost.pause_reason, ArloErrorCode.ALLOWANCE_UNKNOWN);
    assert.equal(lost.control_sequence, 1, 'The successful human request identity survives in durable control history');
    await assert.rejects(r.send(), hasCode(ArloErrorCode.ALLOWANCE_UNKNOWN));
    await assert.rejects(r.continueWith('a', { ...oldRequest, ...r.request('a') }), hasCode(ArloErrorCode.STALE_GENERATION));
    await assert.rejects(r.continueWith('a', { ...oldRequest, ...r.request('a'), daemon_id: lost.daemon_id }),
      hasCode(ArloErrorCode.CONTROL_REQUEST_CONFLICT));
    const restored = await r.grant();
    assert.equal(restored.knowledge, 'known');
    assert.equal(restored.remaining, 20);
    assert.notEqual(restored.period_id, first.period_id);
    assert.equal((await r.send()).status, 'accepted');
    assert.equal((await r.status()).used, 1);
  } finally { await r.close(); }
});

test('dispatch rejection, missing ACK and late receipt spend attempts without touching a later period', { timeout: 120000 }, async () => {
  const r = await rig({ ackTimeoutMs: 100 });
  try {
    await r.grant();
    r.receipt('not_enqueued');
    const rejected = await r.send('b', 'receiver explicitly refused after dispatch');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reason, ArloErrorCode.QUEUE_LIMIT);
    assert.equal((await r.status()).used, 1);
    r.receipt('drop');
    const unknown = await r.send('b', 'receiver queued but ACK missing');
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.reason, ArloErrorCode.ACK_TIMEOUT);
    assert.equal((await r.status()).used, 2);
    const frame = r.notifications.at(-1)!;
    const next = await r.grant();
    const receiver = r.roots.get('b')!;
    await r.control().submitReceipt(receiver.binding.root_token, {
      daemon_id: frame.daemon_id, endpoint_id: receiver.binding.endpoint_id,
      message_id: frame.message_id, delivery_id: frame.delivery_id,
      generation: frame.target_generation, status: 'enqueued', native_message_id: 'late-native',
    });
    await r.control().releaseCredit(receiver.binding.root_token, {
      endpoint_id: receiver.binding.endpoint_id, message_id: frame.message_id,
      native_message_id: 'late-native', event: 'claimed',
    });
    const evidence = await r.roots.get('a')!.connection.getMessageStatus(unknown.message_id);
    assert.equal(evidence.status, 'accepted');
    assert.equal(evidence.original_status, 'unknown');
    assert.equal(evidence.late_evidence, true);
    const after = await r.status();
    assert.equal(after.period_id, next.period_id);
    assert.equal(after.used, 0);
    assert.equal(after.remaining, 20);
    r.receipt('enqueued');
    assert.equal((await r.send()).status, 'accepted');
    assert.equal((await r.status()).used, 1);
  } finally { await r.close(); }
});

test('invalid parameters, reply and unavailable targets never consume dispatch attempts', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    await r.grant();
    const sender = r.roots.get('a')!.connection;
    for (const [args, code] of [
      [{ to: '*', text: 'invalid wildcard' }, ArloErrorCode.INVALID_ARGUMENT],
      [{ to: r.roots.get('b')!.binding.endpoint_id, text: '' }, ArloErrorCode.INVALID_ARGUMENT],
      [{ to: r.roots.get('b')!.binding.endpoint_id, text: 'x'.repeat(32 * 1024 + 1) }, ArloErrorCode.MESSAGE_TOO_LARGE],
      [{ to: 'missing-endpoint', text: 'absent' }, ArloErrorCode.TARGET_UNAVAILABLE],
      [{ to: r.roots.get('foreign')!.binding.endpoint_id, text: 'other group' }, ArloErrorCode.GROUP_MISMATCH],
      [{ to: r.roots.get('b')!.binding.endpoint_id, text: 'invalid reply', reply_to: crypto.randomUUID() }, ArloErrorCode.INVALID_REPLY],
    ] as const) {
      await assert.rejects(sender.sendMessage(args), hasCode(code));
      assert.equal((await r.status()).used, 0);
    }
    await r.control().revokeRoot(r.roots.get('c')!.binding.root_token, { endpoint_id: r.roots.get('c')!.binding.endpoint_id });
    await assert.rejects(r.send('c'), hasCode(ArloErrorCode.TARGET_UNAVAILABLE));
    assert.equal((await r.status()).used, 0);
    assert.equal(r.notifications.length, 0);
  } finally { await r.close(); }
});

test('tracking and sender pacing rejection remain separate from cumulative attempts, and continuing preserves pacing', { timeout: 120000 }, async () => {
  for (const [options, code, target] of [
    [{ maxTrackedMessages: 1 }, ArloErrorCode.ACCOUNTING_UNAVAILABLE, 'c'],
    [{ rateLimit: { sender: { perMinute: 1, burst: 1 }, receiver: { perMinute: 60000, burst: 1000 } } }, ArloErrorCode.RATE_LIMITED, 'c'],
    [{ rateLimit: { sender: { perMinute: 60000, burst: 1000 }, receiver: { perMinute: 1, burst: 1 } } }, ArloErrorCode.RATE_LIMITED, 'b'],
  ] as const) {
    const r = await rig(options);
    try {
      await r.grant();
      await r.send();
      await assert.rejects(r.send(target, 'reject before commit'), hasCode(code));
      assert.equal((await r.status()).used, 1);
      const next = await r.grant();
      assert.equal(next.used, 0);
      await assert.rejects(r.send(target, 'continue does not reset independent budgets'), hasCode(code));
      assert.equal((await r.status()).used, 0);
      assert.equal(r.notifications.length, 1);
    } finally { await r.close(); }
  }
});

test('receiver count and byte capacity refusal does not spend attempts and continue cannot release held credit', { timeout: 240000 }, async () => {
  for (const [count, body] of [[64, 'short pending input'], [32, 'x'.repeat(32 * 1024)]] as const) {
    const r = await rig();
    try {
      r.holdCredits();
      for (let i = 0; i < count; i++) {
        if (i % 20 === 0) await r.grant();
        assert.equal((await r.send('b', body)).status, 'accepted');
      }
      const before = await r.status();
      assert.equal(before.used, count % 20);
      await assert.rejects(r.send('b', body), hasCode(ArloErrorCode.QUEUE_LIMIT));
      assert.equal((await r.status()).used, before.used);
      await r.grant();
      await assert.rejects(r.send('b', body), hasCode(ArloErrorCode.QUEUE_LIMIT));
      assert.equal((await r.status()).used, 0);
      assert.equal(r.notifications.length, count);
    } finally { await r.close(); }
  }
});

test('connection loss after a real dispatch is charged while its old result remains queryable', { timeout: 120000 }, async () => {
  const r = await rig({ ackTimeoutMs: 100 });
  try {
    await r.grant();
    r.receipt('disconnect');
    const lost = await r.send('b', 'disconnect after public delivery notification');
    assert.equal(lost.status, 'unknown');
    assert.ok([ArloErrorCode.CONNECTION_LOST, ArloErrorCode.ACK_TIMEOUT].includes(lost.reason as typeof ArloErrorCode.CONNECTION_LOST));
    assert.equal(r.notifications.length, 1);
    assert.equal((await r.status()).used, 1);
    assert.equal((await r.roots.get('a')!.connection.getMessageStatus(lost.message_id)).status, 'unknown');
    await assert.rejects(r.send('b', 'target now disconnected'), hasCode(ArloErrorCode.TARGET_UNAVAILABLE));
    assert.equal((await r.status()).used, 1);
  } finally { await r.close(); }
});

test('expired message identities and unavailable durable controls never recreate dispatch or a successful grant', { timeout: 120000 }, async () => {
  let clock = 1_000_000;
  const r = await rig({ messageRecordTtlMs: 1000, now: () => clock });
  try {
    await r.grant();
    const first = await r.send('b', 'retired logical identity');
    clock += 1000;
    assert.equal((await r.roots.get('a')!.connection.getMessageStatus(first.message_id)).status, 'result_unavailable');
    await r.grant();
    await assert.rejects(r.send('b', 'retired logical identity', first.message_id), hasCode(ArloErrorCode.REPLAY_RESULT_UNAVAILABLE));
    assert.equal((await r.status()).used, 0);
    assert.equal(r.notifications.length, 1);
    const ledger = path.join(r.stateDir, 'sending-controls.json');
    fs.renameSync(ledger, `${ledger}.previous`);
    fs.mkdirSync(ledger);
    const unavailable = await r.status();
    assert.equal(unavailable.knowledge, 'unknown');
    assert.equal(unavailable.used, null);
    await assert.rejects(r.grant(), hasCode(ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE));
    assert.equal((await r.status()).remaining, null);
    await assert.rejects(r.send(), hasCode(ArloErrorCode.ALLOWANCE_UNKNOWN));
  } finally { await r.close(); }
});

test('a public HTTP transport write exception spends one attempt and preserves the original uncertain replay', { timeout: 120000 }, async t => {
  const r = await rig();
  const write = ServerResponse.prototype.write;
  let failedWrites = 0;
  try {
    await r.grant();
    const injection = t.mock.method(ServerResponse.prototype, 'write', function(this: ServerResponse, ...args: Parameters<ServerResponse['write']>) {
      if (failedWrites === 0 && typeof args[0] === 'string' && args[0].includes(ARLO_NOTIFICATION_METHOD)) {
        failedWrites++;
        throw new Error('controlled public HTTP write failure');
      }
      return Reflect.apply(write, this, args);
    });
    const original = await r.send('b', 'write fails after synchronous dispatch commit');
    injection.mock.restore();
    assert.equal(failedWrites, 1);
    assert.equal(original.status, 'unknown');
    assert.equal(original.reason, ArloErrorCode.CONNECTION_LOST);
    assert.equal(r.notifications.length, 0, 'The controlled throw precedes the actual socket write');
    assert.equal((await r.status()).used, 1);
    assert.deepEqual(await r.send('b', 'write fails after synchronous dispatch commit', original.message_id), original);
    assert.equal((await r.status()).used, 1);
    assert.equal((await r.roots.get('a')!.connection.getMessageStatus(original.message_id)).status, 'unknown');
    const receiver = r.roots.get('b')!.binding;
    await assert.rejects(r.control().confirmRootReady(receiver.root_token, {
      endpoint_id: receiver.endpoint_id, reconciled_pending_message_ids: [],
    }), hasCode(ArloErrorCode.ACCOUNTING_UNAVAILABLE));
  } finally { await r.close(); }
});

test('authenticated identity and forged model control arguments refuse before autonomous usage changes', { timeout: 120000 }, async () => {
  const r = await rig();
  let agent: ReturnType<typeof createPinnedHttpsAgent> | undefined;
  try {
    await r.grant();
    const sender = r.roots.get('a')!;
    const receiver = r.roots.get('b')!;
    const discovery = readDiscoveryRecord(r.stateDir);
    agent = createPinnedHttpsAgent(discovery.cert_pem);
    for (const [token, endpoint, generation, expected] of [
      [sender.binding.root_token, receiver.binding.endpoint_id, sender.binding.generation, ArloErrorCode.BINDING_MISMATCH],
      [sender.binding.root_token, sender.binding.endpoint_id, sender.binding.generation + 1, ArloErrorCode.STALE_GENERATION],
      [crypto.randomUUID(), sender.binding.endpoint_id, sender.binding.generation, ArloErrorCode.UNAUTHORIZED],
    ] as const) {
      const response = await sendSecureArloRequest({ url: `https://127.0.0.1:${discovery.port}/mcp`, agent,
        token, method: 'POST', headers: { 'x-arlo-endpoint-id': endpoint, 'x-arlo-generation': String(generation),
          'mcp-session-id': sender.connection.sessionId! },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call',
          params: { name: 'arlo_send_message', arguments: { to: receiver.binding.endpoint_id, text: 'wrong authenticated identity' },
            _meta: { [ARLO_MESSAGE_ID_META_KEY]: crypto.randomUUID() } } }) });
      assert.equal(JSON.parse(response.body).error, expected);
      assert.equal((await r.status()).used, 0);
    }
    for (const forged of [{ from: receiver.binding.endpoint_id }, { granted: 999 }, { request_id: crypto.randomUUID() },
      { daemon_id: discovery.daemon_id }, { sequence: 99 }, { evidence: { kind: 'session-file', session_file: sender.file } }]) {
      await assert.rejects(sender.connection.sendMessage({ to: receiver.binding.endpoint_id, text: 'forged allowance', ...forged }),
        hasCode(ArloErrorCode.INVALID_ARGUMENT));
      assert.equal((await r.status()).used, 0);
    }
    assert.equal(r.notifications.length, 0);
  } finally { agent?.destroy(); await r.close(); }
});

test('the ninth reply depth refuses before usage while shallow parent references still consume attempts', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    await r.grant('a');
    await r.grant('b');
    const first = await r.send('b', 'real reply parent');
    let parent = first;
    let sender = 'b';
    let receiver = 'a';
    for (let depth = 1; depth <= MAX_REPLY_DEPTH; depth++) {
      parent = await r.send(receiver, `real reply depth ${depth}`, undefined, sender, parent.message_id);
      assert.equal(parent.status, 'accepted');
      assert.equal(r.notifications.at(-1)!.reply_depth, depth);
      [sender, receiver] = [receiver, sender];
    }
    const before = await r.status(sender);
    await assert.rejects(r.send(receiver, 'ninth reply', undefined, sender, parent.message_id), hasCode(ArloErrorCode.REPLY_DEPTH_LIMIT));
    assert.equal((await r.status(sender)).used, before.used);
    assert.equal(r.notifications.length, MAX_REPLY_DEPTH + 1);
    const shallow = await r.send('a', 'reuse shallow association', undefined, 'b', first.message_id);
    assert.equal(shallow.status, 'accepted');
    assert.equal(r.notifications.at(-1)!.reply_depth, 1);
    assert.equal((await r.status('b')).used, before.used! + 1);
  } finally { await r.close(); }
});

test('a target delivery sequence at uint64 exhaustion refuses without consuming an attempt', { timeout: 120000 }, async () => {
  const r = await rig({ initialDeliverySeq: MAX_DELIVERY_SEQ });
  try {
    await r.grant();
    await assert.rejects(r.send(), hasCode(ArloErrorCode.SEQUENCE_EXHAUSTED));
    assert.equal((await r.status()).used, 0);
    assert.equal((await r.status()).remaining, 20);
    assert.equal(r.notifications.length, 0);
  } finally { await r.close(); }
});
