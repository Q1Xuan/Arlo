import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import { ArloErrorCode, MAX_REPLY_DEPTH, MAX_SINGLE_TEXT_BYTES } from '@arlo/sdk';
import { autonomousRulesRig } from './helpers/autonomous-rules-fixture.ts';

test('an invalid rules document retains the complete effective snapshot and current allowance', { timeout: 120000 }, async () => {
  const r = await autonomousRulesRig();
  try {
    const initial = await r.grant();
    const other = await r.grant('b');
    const configId = initial.root_configuration.config_id!;
    const otherId = other.root_configuration.config_id!;
    assert.equal(initial.root_configuration.config_path, r.rulesPath);
    r.writeRules({ version: 1, roots: {
      [configId]: { mode: 'continuous', grant: 3 },
      [otherId]: { mode: 'bounded', grant: 7 },
    } });
    const effective = await r.reload();
    await r.send();

    r.writeRules({ version: 1, roots: {
      [configId]: { mode: 'bounded', grant: 99 },
      [otherId]: { mode: 'continuous', grant: 0 },
    } });
    await assert.rejects(r.reload(), { code: ArloErrorCode.SENDING_RULES_INVALID });
    const unchanged = await r.status();
    assert.equal(unchanged.mode, 'continuous');
    assert.equal(unchanged.next_grant, 3);
    assert.equal(unchanged.rules_revision, effective.rules_revision);
    assert.equal(unchanged.period_id, initial.period_id);
    assert.equal(unchanged.granted, 20);
    assert.equal(unchanged.used, 1);
    assert.equal(typeof unchanged.rules_error, 'string');
    const b = await r.status('b');
    assert.equal(b.mode, 'bounded');
    assert.equal(b.next_grant, 7);
  } finally { await r.close(); }
});

test('concurrent reloads compare revisions and continuation follows the single published rule order', { timeout: 180000 }, async () => {
  const r = await autonomousRulesRig();
  try {
    const original = await r.grant();
    const id = original.root_configuration.config_id!;
    await r.send();
    r.writeRules({ version: 1, roots: { [id]: { mode: 'continuous', grant: 3 } } });
    const request = await r.reloadRequest();
    const raced = await Promise.allSettled([r.reloadWith('a', request), r.reloadWith('a', request)]);
    assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
    const failed = raced.find(result => result.status === 'rejected');
    assert.equal(failed?.status === 'rejected' && failed.reason.code, ArloErrorCode.STALE_CONTROL_REQUEST);
    r.writeRules({ version: 1, roots: { [id]: { mode: 'bounded', grant: 99 } } });
    await assert.rejects(r.reloadWith('a', request), { code: ArloErrorCode.STALE_CONTROL_REQUEST });
    const retained = await r.status();
    assert.equal(retained.mode, 'continuous');
    assert.equal(retained.next_grant, 3);
    assert.equal(retained.period_id, original.period_id);
    assert.equal(retained.used, 1);
    const currentRequest = await r.reloadRequest();
    await assert.rejects(r.reloadWith('b', currentRequest), { code: ArloErrorCode.UNAUTHORIZED });
    await assert.rejects(r.reloadWith('a', { ...currentRequest, daemon_id: crypto.randomUUID() }), { code: ArloErrorCode.STALE_GENERATION });
    await assert.rejects(r.reloadWith('a', { ...currentRequest, generation: currentRequest.generation + 1 }), { code: ArloErrorCode.STALE_GENERATION });

    r.writeRules({ version: 1, roots: { [id]: { mode: 'bounded', grant: 7 } } });
    const command = await r.continueRequest();
    const root = r.roots.get('a')!;
    const [, continued] = await Promise.all([r.reloadWith('a', currentRequest),
      r.control().continueCollaboration(root.binding.root_token, command)]);
    const ordered = await r.status();
    assert.equal(ordered.mode, 'bounded');
    assert.equal(ordered.next_grant, 7);
    if (continued.mode === 'continuous') {
      assert.equal(ordered.period_id, original.period_id);
      assert.equal(ordered.granted, 20);
      assert.equal(ordered.used, 1);
      assert.equal(ordered.control_sequence, 1);
    } else {
      assert.notEqual(ordered.period_id, original.period_id);
      assert.equal(ordered.granted, 7);
      assert.equal(ordered.used, 0);
      assert.equal(ordered.control_sequence, 2);
    }
    assert.equal((await r.send()).status, 'accepted');
    const replay = await r.control().continueCollaboration(root.binding.root_token, command);
    assert.equal(replay.period_id, ordered.period_id);
    assert.equal(replay.used, ordered.used! + 1);
    const oldToken = root.binding.root_token;
    const beforeRotate = await r.reloadRequest();
    await r.rotate();
    await assert.rejects(r.control().reloadSendingRules(oldToken, beforeRotate), error =>
      [ArloErrorCode.STALE_GENERATION, ArloErrorCode.UNAUTHORIZED].includes((error as { code: typeof ArloErrorCode.STALE_GENERATION }).code));
    await assert.rejects(r.reloadWith('a', beforeRotate), { code: ArloErrorCode.STALE_GENERATION });
    assert.equal((await r.status()).period_id, ordered.period_id);
  } finally { await r.close(); }
});

test('ambiguous live root ownership cannot inherit continuous policy or continue another instance', { timeout: 120000 }, async () => {
  const r = await autonomousRulesRig();
  try {
    const original = await r.grant();
    const id = original.root_configuration.config_id!;
    await r.send();
    r.writeRules({ version: 1, roots: { [id]: { mode: 'continuous', grant: 3 } } });
    const applied = await r.reload();
    const runtime = await r.control().registerRuntime({ host_kind: 'pi' });
    const duplicate = await r.control().registerRoot(runtime.runtime_token, {
      root_session_id: r.roots.get('a')!.sessionId, group_name: 'rules-group',
      agent_incarnation: crypto.randomUUID(), plugin_generation: 1,
    });
    const duplicateRequest = { endpoint_id: duplicate.endpoint_id, generation: duplicate.generation,
      evidence: r.request('a').evidence };
    const conflict = await r.control().getRootSendingStatus(duplicate.root_token, duplicateRequest);
    assert.equal(conflict.root_configuration.ownership, 'conflict');
    assert.equal(conflict.root_configuration.config_id, null);
    assert.equal(conflict.mode, 'bounded');
    assert.equal(conflict.used, null);
    await assert.rejects(r.send(), { code: ArloErrorCode.ALLOWANCE_UNKNOWN });
    assert.equal(r.notifications.length, 1, 'The original root is stopped before another status query');
    const blocked = await r.status();
    assert.equal(blocked.root_configuration.ownership, 'conflict');
    assert.equal(blocked.mode, 'bounded');
    assert.equal(blocked.used, null);
    await assert.rejects(r.control().reloadSendingRules(duplicate.root_token, { ...duplicateRequest,
      daemon_id: applied.daemon_id, rules_revision: applied.rules_revision }), { code: ArloErrorCode.ALLOWANCE_UNKNOWN });
    await r.control().revokeRoot(duplicate.root_token, { endpoint_id: duplicate.endpoint_id });
    const restored = await r.status();
    assert.equal(restored.root_configuration.config_id, id);
    assert.equal(restored.mode, 'continuous');
    assert.equal(restored.used, null);
    assert.equal((await r.send()).status, 'accepted');
    r.writeRules({ version: 1, roots: { [id]: { mode: 'bounded', grant: 3 } } });
    await r.reload();
    await assert.rejects(r.send(), { code: ArloErrorCode.ALLOWANCE_UNKNOWN });
    assert.equal((await r.grant()).remaining, 3);
  } finally { await r.close(); }
});

test('verified configuration alone applies a startup continuous rule without issuing or inventing a period', { timeout: 120000 }, async () => {
  const r = await autonomousRulesRig();
  try {
    let root = r.roots.get('a')!;
    const original = await r.control().getRootConfiguration(root.binding.root_token, r.request('a'));
    assert.equal(original.ownership, 'verified');
    r.writeRules({ version: 1, roots: { [original.config_id!]: { mode: 'continuous', grant: 3 } } });
    await r.restart();
    root = r.roots.get('a')!;
    const verified = await r.control().getRootConfiguration(root.binding.root_token, r.request('a'));
    assert.equal(verified.ownership, 'verified');
    assert.equal(verified.config_id, original.config_id);
    assert.equal((await r.send()).status, 'accepted');
    const current = await r.status();
    assert.equal(current.mode, 'continuous');
    assert.equal(current.next_grant, 3);
    assert.equal(current.knowledge, 'unknown');
    assert.equal(current.used, null);
    assert.equal(current.granted, null);
    assert.equal(current.remaining, null);
    assert.equal(current.period_id, null);
    assert.equal(current.control_sequence, 0);
  } finally { await r.close(); }
});

test('a changed file or root artifact during rules reading cannot publish the candidate snapshot', { timeout: 120000 }, async t => {
  const r = await autonomousRulesRig();
  try {
    const original = await r.grant();
    const id = original.root_configuration.config_id!;
    await r.send();
    const command = await r.reloadRequest();
    const candidate = { version: 1, roots: { [id]: { mode: 'continuous', grant: 3 } } };
    const read = fs.readSync;
    for (const boundary of ['rules-file', 'root-artifact'] as const) {
      r.writeRules(candidate);
      const info = fs.statSync(r.rulesPath, { bigint: true });
      const rootFile = r.roots.get('a')!.file;
      const savedRootFile = `${rootFile}.original`;
      let injected = false;
      // Fault injection stays at the operating-system read boundary. All
      // binding validation, rules publication and sending use the real daemon.
      const injection = t.mock.method(fs, 'readSync', (descriptor: number, ...args: unknown[]) => {
        const result = Reflect.apply(read, fs, [descriptor, ...args]) as number;
        const current = fs.fstatSync(descriptor, { bigint: true });
        if (!injected && result > 0 && current.dev === info.dev && current.ino === info.ino) {
          injected = true;
          if (boundary === 'rules-file') fs.writeFileSync(r.rulesPath, '{"version":1,"roots":');
          else {
            fs.renameSync(rootFile, savedRootFile);
            fs.writeFileSync(rootFile, 'replacement-host-root');
          }
        }
        return result;
      });
      try {
        await assert.rejects(r.reloadWith('a', command), { code: boundary === 'rules-file'
          ? ArloErrorCode.SENDING_RULES_INVALID : ArloErrorCode.ALLOWANCE_UNKNOWN });
      } finally {
        injection.mock.restore();
        if (boundary === 'root-artifact' && injected) {
          fs.unlinkSync(rootFile);
          fs.renameSync(savedRootFile, rootFile);
        }
      }
      assert.equal(injected, true);
      const status = await r.status();
      assert.equal(status.mode, 'bounded');
      assert.equal(status.next_grant, 20);
      assert.equal(status.rules_revision, original.rules_revision);
      assert.equal(status.period_id, original.period_id);
      assert.equal(status.used, 1);
    }
  } finally { await r.close(); }
});

test('continuous rules and reload retain reply depth, tracking capacity and deduplication protections', { timeout: 120000 }, async () => {
  const r = await autonomousRulesRig({ maxTrackedMessages: 10 });
  try {
    const a = await r.grant();
    const b = await r.grant('b');
    r.writeRules({ version: 1, roots: {
      [a.root_configuration.config_id!]: { mode: 'continuous', grant: 3 },
      [b.root_configuration.config_id!]: { mode: 'continuous', grant: 3 },
    } });
    await r.reload();
    const first = await r.send('real reply parent');
    let parent = first;
    let sender: 'a' | 'b' = 'b';
    for (let depth = 1; depth <= MAX_REPLY_DEPTH; depth++) {
      parent = await r.send(`reply depth ${depth}`, sender, undefined, parent.message_id);
      assert.equal(parent.status, 'accepted');
      assert.equal(r.notifications.at(-1)!.reply_depth, depth);
      sender = sender === 'a' ? 'b' : 'a';
    }
    await r.reload();
    const before = await r.status(sender);
    await assert.rejects(r.send('ninth reply', sender, undefined, parent.message_id), { code: ArloErrorCode.REPLY_DEPTH_LIMIT });
    assert.equal((await r.status(sender)).used, before.used);
    assert.deepEqual(await r.send('real reply parent', 'a', first.message_id), first);
    await assert.rejects(r.send('changed text', 'a', first.message_id), { code: ArloErrorCode.MESSAGE_ID_CONFLICT });
    assert.equal(r.notifications.length, 9);
    assert.equal((await r.send('tenth tracked message')).status, 'accepted');
    const full = await r.reload();
    await assert.rejects(r.send('eleventh tracked message'), { code: ArloErrorCode.ACCOUNTING_UNAVAILABLE });
    const unchanged = await r.status();
    assert.equal(unchanged.used, full.used);
    assert.equal(unchanged.period_id, a.period_id);
    assert.equal(r.notifications.length, 10);
  } finally { await r.close(); }
});

test('continuous dispatch past twenty and reload preserve pending credit until the receiver claims input', { timeout: 180000 }, async () => {
  const r = await autonomousRulesRig();
  try {
    const original = await r.grant();
    const id = original.root_configuration.config_id!;
    r.holdCredits();
    r.writeRules({ version: 1, roots: { [id]: { mode: 'continuous', grant: 100 } } });
    await r.reload();
    const fullText = 'é'.repeat(MAX_SINGLE_TEXT_BYTES / 2);
    let first: Awaited<ReturnType<typeof r.send>> | undefined;
    for (let i = 0; i < 32; i++) {
      const sent = await r.send(fullText);
      assert.equal(sent.status, 'accepted');
      first ??= sent;
    }
    assert.equal((await r.status()).used, 32);
    assert.equal((await r.status()).remaining, null);
    r.writeRules({ version: 1, roots: { [id]: { mode: 'bounded', grant: 100 } } });
    const bounded = await r.reload();
    assert.equal(bounded.granted, 20);
    assert.equal(bounded.used, 32);
    assert.equal(bounded.remaining, 0);
    assert.deepEqual(await r.send(fullText, 'a', first!.message_id), first);
    r.writeRules({ version: 1, roots: { [id]: { mode: 'continuous', grant: 100 } } });
    await r.reload();
    await assert.rejects(r.send(fullText), { code: ArloErrorCode.QUEUE_LIMIT });
    assert.equal((await r.status()).used, 32);
    assert.equal(r.notifications.length, 32);
    const receiver = r.roots.get('b')!.binding;
    await r.control().releaseCredit(receiver.root_token, {
      endpoint_id: receiver.endpoint_id, message_id: first!.message_id,
      native_message_id: `native-${first!.message_id}`, event: 'claimed',
    });
    assert.equal((await r.send(fullText)).status, 'accepted');
    assert.equal((await r.status()).used, 33);
    assert.equal(r.notifications.length, 33);
  } finally { await r.close(); }
});

test('duplicate JSON members cannot replace an invalid declaration with continuous authorization', { timeout: 120000 }, async () => {
  const r = await autonomousRulesRig();
  try {
    const original = await r.status();
    const id = original.root_configuration.config_id!;
    const request = await r.reloadRequest();
    for (const raw of [
      `{"version":1,"roots":{"${id}":{"mode":"invalid","mode":"continuous","grant":20}}}`,
      `{"version":1,"roots":{"${id}":{"mode":"invalid","\\u006dode":"continuous","grant":20}}}`,
      `{"version":2,"version":1,"roots":{"${id}":{"mode":"continuous","grant":20}}}`,
    ]) {
      fs.writeFileSync(r.rulesPath, raw, { mode: 0o600 });
      await assert.rejects(r.reloadWith('a', request), { code: ArloErrorCode.SENDING_RULES_INVALID });
      const status = await r.status();
      assert.equal(status.mode, 'bounded');
      assert.equal(status.rules_revision, original.rules_revision);
      assert.equal(status.used, null);
      await assert.rejects(r.send(), { code: ArloErrorCode.ALLOWANCE_UNKNOWN });
    }
  } finally { await r.close(); }
});

test('a continuous continuation replay stays a state query after switching back to bounded mode', { timeout: 120000 }, async () => {
  const r = await autonomousRulesRig();
  try {
    const original = await r.grant();
    const id = original.root_configuration.config_id!;
    await r.send();
    r.writeRules({ version: 1, roots: { [id]: { mode: 'continuous', grant: 3 } } });
    await r.reload();
    const command = await r.continueRequest();
    const root = r.roots.get('a')!;
    const continued = await r.control().continueCollaboration(root.binding.root_token, command);
    assert.equal(continued.period_id, original.period_id);
    assert.equal(continued.used, 1);
    assert.equal(continued.control_sequence, original.control_sequence);
    r.writeRules({ version: 1, roots: { [id]: { mode: 'bounded', grant: 3 } } });
    const bounded = await r.reload();
    assert.equal(bounded.granted, 20);
    assert.equal(bounded.used, 1);
    const replayed = await r.control().continueCollaboration(root.binding.root_token, command);
    assert.equal(replayed.period_id, original.period_id);
    assert.equal(replayed.granted, 20);
    assert.equal(replayed.used, 1);
    assert.equal(replayed.remaining, 19);
    assert.equal(replayed.control_sequence, original.control_sequence);
    await assert.rejects(r.control().continueCollaboration(root.binding.root_token, {
      ...command, sequence: command.sequence + 1,
    }), { code: ArloErrorCode.CONTROL_REQUEST_CONFLICT });
    const next = await r.grant();
    assert.equal(next.granted, 3);
    assert.equal(next.used, 0);
    assert.notEqual(next.period_id, original.period_id);
    const lateReplay = await r.control().continueCollaboration(root.binding.root_token, command);
    assert.equal(lateReplay.period_id, next.period_id);
    assert.equal(lateReplay.used, 0);
  } finally { await r.close(); }
});

test('invalid versions, modes, fields and grant values plus half-written files never publish partial rules', { timeout: 180000 }, async () => {
  const r = await autonomousRulesRig();
  try {
    const initial = await r.status();
    const id = initial.root_configuration.config_id!;
    r.writeRules({ version: 1, roots: { [id]: { mode: 'continuous', grant: 3 } } });
    const valid = await r.reload();
    const reloadRequest = await r.reloadRequest();
    const document = (rule: unknown) => ({ version: 1, roots: { [id]: rule } });
    const invalidDocuments = [
      { version: 2, roots: {} }, { version: '1', roots: {} }, { roots: {} },
      { version: 1, roots: [] }, { version: 1, roots: {}, used: 0 },
      { version: 1, roots: { 'display-name': { mode: 'continuous', grant: 3 } } },
      document({ mode: 'unlimited', grant: 3 }), document({ mode: 'continuous' }),
      ...['used', 'remaining', 'period_id', 'resume', 'granted'].map(field =>
        document({ mode: 'continuous', grant: 3, [field]: 0 })),
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', null, true].map(grant =>
        document({ mode: 'continuous', grant })),
    ];
    for (const candidate of invalidDocuments) {
      r.writeRules(candidate);
      await assert.rejects(r.reloadWith('a', reloadRequest), { code: ArloErrorCode.SENDING_RULES_INVALID });
    }
    for (const raw of ['', '{"version":1,"roots":', `{"version":1,"roots":{"${id}":{"mode":"continuous"}}`,
      `{"version":1,"roots":{"${id}":{"mode":"continuous","grant":1e309}}}`,
      `{"version":1,"roots":{"${id}":{"mode":"continuous","grant":-0}}}`]) {
      fs.writeFileSync(r.rulesPath, raw, { mode: 0o600 });
      await assert.rejects(r.reloadWith('a', reloadRequest), { code: ArloErrorCode.SENDING_RULES_INVALID });
    }
    const unchanged = await r.status();
    assert.equal(unchanged.rules_revision, valid.rules_revision);
    assert.equal(unchanged.mode, 'continuous');
    assert.equal(unchanged.next_grant, 3);
    assert.equal(unchanged.used, null);
    assert.equal(unchanged.remaining, null);
    assert.equal(typeof unchanged.rules_error, 'string');
    assert.equal((await r.send()).status, 'accepted');
    fs.unlinkSync(r.rulesPath);
    const restored = await r.reloadWith('a', reloadRequest);
    assert.equal(restored.mode, 'bounded');
    assert.equal(restored.next_grant, 20);
    assert.equal(restored.rules_error, null);
    assert.equal(restored.used, null);
    await assert.rejects(r.send(), { code: ArloErrorCode.ALLOWANCE_UNKNOWN });
  } finally { await r.close(); }
});

test('rules reload keeps both sending and receiving pacing buckets and message replay', { timeout: 120000 }, async () => {
  let now = 1_000_000;
  const r = await autonomousRulesRig({ now: () => now, rateLimit: {
    sender: { perMinute: 60, burst: 1 }, receiver: { perMinute: 30, burst: 1 },
  } });
  try {
    const original = await r.grant();
    const id = original.root_configuration.config_id!;
    const first = await r.send('original dispatch');
    r.writeRules({ version: 1, roots: { [id]: { mode: 'continuous', grant: 3 } } });
    await r.reload();
    assert.deepEqual(await r.send('original dispatch', 'a', first.message_id), first);
    assert.equal(r.notifications.length, 1);
    await assert.rejects(r.send(), error => {
      assert.equal((error as { code: string }).code, ArloErrorCode.RATE_LIMITED);
      assert.match((error as Error).message, /sending root/);
      return true;
    });
    now += 1000;
    await r.reload();
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(r.send(), error => {
        assert.equal((error as { code: string }).code, ArloErrorCode.RATE_LIMITED);
        assert.match((error as Error).message, /receiving root/);
        return true;
      });
      if (attempt === 0) await r.reload();
    }
    assert.equal((await r.status()).used, 1);
    now += 1000;
    assert.equal((await r.send()).status, 'accepted');
    assert.equal((await r.status()).used, 2);
    assert.equal(r.notifications.length, 2);
  } finally { await r.close(); }
});

test('startup honors only complete rules and continuous unknown usage stays unknown until bounded explicit continuation', { timeout: 180000 }, async () => {
  const r = await autonomousRulesRig();
  try {
    const initial = await r.grant();
    const id = initial.root_configuration.config_id!;
    await r.send();
    r.writeRules({ version: 1, roots: { [id]: { mode: 'continuous', grant: 3 } } });
    await r.reload();
    await r.restart();
    const unknown = await r.status();
    assert.equal(unknown.root_configuration.config_id, id);
    assert.equal(unknown.mode, 'continuous');
    assert.equal(unknown.next_grant, 3);
    assert.equal(unknown.knowledge, 'unknown');
    assert.equal(unknown.granted, 20);
    assert.equal(unknown.used, null);
    assert.equal(unknown.remaining, null);
    assert.equal(unknown.pause_reason, null);
    assert.equal(unknown.period_id, initial.period_id);
    assert.equal((await r.send()).status, 'accepted');
    const noop = await r.grant();
    assert.equal(noop.knowledge, 'unknown');
    assert.equal(noop.used, null);
    assert.equal(noop.period_id, initial.period_id);
    assert.equal(noop.control_sequence, initial.control_sequence);

    r.writeRules({ version: 1, roots: { [id]: { mode: 'bounded', grant: 3 } } });
    assert.equal((await r.send()).status, 'accepted', 'Unsaved publication cannot alter effective continuous mode');
    const bounded = await r.reload();
    assert.equal(bounded.mode, 'bounded');
    assert.equal(bounded.used, null);
    assert.equal(bounded.remaining, null);
    assert.equal(bounded.pause_reason, ArloErrorCode.ALLOWANCE_UNKNOWN);
    await assert.rejects(r.send(), { code: ArloErrorCode.ALLOWANCE_UNKNOWN });
    const resumed = await r.grant();
    assert.equal(resumed.knowledge, 'known');
    assert.equal(resumed.granted, 3);
    assert.equal(resumed.used, 0);
    assert.equal(resumed.remaining, 3);
    assert.notEqual(resumed.period_id, initial.period_id);
    for (let i = 0; i < 3; i++) assert.equal((await r.send()).status, 'accepted');
    await assert.rejects(r.send(), { code: ArloErrorCode.ALLOWANCE_EXHAUSTED });

    fs.writeFileSync(r.rulesPath, `{"version":1,"roots":{"${id}":{"mode":"continuous","grant":3}`);
    await r.restart();
    const fallback = await r.status();
    assert.equal(fallback.mode, 'bounded');
    assert.equal(fallback.next_grant, 20);
    assert.equal(fallback.used, null);
    assert.equal(typeof fallback.rules_error, 'string');
    await assert.rejects(r.send(), { code: ArloErrorCode.ALLOWANCE_UNKNOWN });
    r.writeRules({ version: 1, roots: { [id]: { mode: 'continuous', grant: 3 } } });
    assert.equal((await r.status()).mode, 'bounded');
    const repaired = await r.reload();
    assert.equal(repaired.rules_error, null);
    assert.equal(repaired.mode, 'continuous');
    assert.equal(repaired.used, null);
    assert.equal((await r.send()).status, 'accepted');
  } finally { await r.close(); }
});

test('changing the next grant preserves current counts and only explicit continuation replaces the full period', { timeout: 120000 }, async () => {
  const r = await autonomousRulesRig();
  try {
    const original = await r.grant();
    const id = original.root_configuration.config_id!;
    await r.send();
    r.writeRules({ version: 1, roots: { [id]: { mode: 'bounded', grant: 30 } } });
    assert.equal((await r.status()).next_grant, 20, 'Editing a file alone cannot publish a rule');
    const larger = await r.reload();
    assert.equal(larger.next_grant, 30);
    assert.equal(larger.granted, 20);
    assert.equal(larger.used, 1);
    assert.equal(larger.remaining, 19);
    assert.equal(larger.period_id, original.period_id);
    const newPeriod = await r.grant();
    assert.equal(newPeriod.granted, 30);
    assert.equal(newPeriod.used, 0);
    assert.equal(newPeriod.remaining, 30);
    assert.notEqual(newPeriod.period_id, original.period_id);
    await r.send();

    r.writeRules({ version: 1, roots: { [id]: { mode: 'bounded', grant: 3 } } });
    const smaller = await r.reload();
    assert.equal(smaller.next_grant, 3);
    assert.equal(smaller.granted, 30);
    assert.equal(smaller.used, 1);
    assert.equal(smaller.remaining, 29);
    assert.equal(smaller.period_id, newPeriod.period_id);
    const repeated = await r.reload();
    assert.equal(repeated.period_id, newPeriod.period_id);
    assert.equal(repeated.used, 1);
    const reducedPeriod = await r.grant();
    assert.equal(reducedPeriod.granted, 3);
    assert.equal(reducedPeriod.remaining, 3);

    r.writeRules({ version: 1, roots: {} });
    const defaults = await r.reload();
    assert.equal(defaults.next_grant, 20);
    assert.equal(defaults.granted, 3);
    assert.equal(defaults.period_id, reducedPeriod.period_id);
    r.writeRules({ version: 1, roots: { [id]: { mode: 'bounded', grant: Number.MAX_SAFE_INTEGER } } });
    assert.equal((await r.reload()).next_grant, 9007199254740991);
    const maximum = await r.grant();
    assert.equal(maximum.granted, 9007199254740991);
    assert.equal(maximum.remaining, 9007199254740991);
    assert.equal((await r.send()).status, 'accepted');
    assert.equal((await r.status()).remaining, 9007199254740990);
  } finally { await r.close(); }
});
