import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { sendStatusDescriptor } from '../packages/adapter-dsh/client.cjs';

interface Candidate { name: string; section: string; value: string; description?: string; drill?: boolean }
interface Source {
  order?: number;
  candidates(session: { sessionId: string }, request: { query: string; signal: AbortSignal; drilled?: boolean }): Promise<Candidate[]>;
  onPick(pick: { candidate: Candidate }): { insert?: { ref: string }; text?: string; continue?: boolean } | undefined;
  header?(session: { sessionId: string }, request: { query: string }): Array<{ label: string; value: string; current?: boolean }> | undefined;
}

async function loadClient(list: () => Promise<unknown>, language = 'zh', globals: Record<string, unknown> = {},
  rootConfiguration: (sessionId: string) => Promise<unknown> = async () => { throw new Error('Unexpected root configuration query'); },
  collaboration: { sendStatus?: (sessionId: string) => Promise<unknown>; continueCollaboration?: (sessionId: string) => Promise<unknown>;
    reloadSendingRules?: (sessionId: string) => Promise<unknown> } = {}) {
  let source!: Source;
  let settings: {
    onPick(pick: unknown): { claim: { submit(args: string, ctx: unknown): Promise<{ kind: string; text: string }> } };
    matchEnter(session: { sessionId: string }, line: string): Promise<unknown>;
  } | undefined;
  let rootConfig: typeof settings;
  let sendStatus: typeof settings;
  let continueCollaboration: typeof settings;
  let reloadSendingRules: typeof settings;
  let apply!: (ctx: unknown) => Promise<void>;
  let dictionaries: Record<string, Record<string, string>>;
  let creations = 0;
  const ctx = {
    effect: (effect: () => unknown) => effect(),
    locale: {
      register: (_name: string, values: typeof dictionaries) => { dictionaries = values; },
      bind: () => (key: string, values: Record<string, string> = {}) =>
        dictionaries[language][key].replace(/\{(\w+)\}/gu, (_match, name: string) => values[name]),
    },
    remote: {
      $mount: async () => {},
      arloContact: { list, rootConfiguration, ...collaboration, create: async () => { creations++; throw new Error('Unexpected creation'); } },
    },
    conversation: { registerSubmitPreparation: () => () => {}, input: { for: () => ({ notify: () => {} }) } },
    inputTriggers: { registerSource: (value: Source & { name: string }) => {
      if (value.name === 'arlo-contact') source = value;
      else if (value.name === 'arlo-settings') settings = value as unknown as typeof settings;
      else if (value.name === 'arlo-root-config') rootConfig = value as unknown as typeof rootConfig;
      else if (value.name === 'arlo-send-status') sendStatus = value as unknown as typeof sendStatus;
      else if (value.name === 'arlo-continue') continueCollaboration = value as unknown as typeof continueCollaboration;
      else if (value.name === 'arlo-reload-sending-rules') reloadSendingRules = value as unknown as typeof settings;
      return () => {};
    } },
    inject: (_dependencies: string[], callback: (scope: unknown) => void) => callback(ctx),
  };
  runInNewContext(readFileSync(new URL('../packages/adapter-dsh/client.cjs', import.meta.url), 'utf8'), {
    AbortController, AbortSignal, crypto: { randomUUID }, setTimeout, clearTimeout,
    ...globals,
    window: { __ModuleLoader__: { load: (module: { factory: () => { apply: typeof apply } }) => { apply = module.factory().apply; } } },
  });
  await apply(ctx);
  return { source, settings, rootConfig, sendStatus, continueCollaboration, reloadSendingRules, creations: () => creations };
}

const session = { sessionId: 'sender' };
const request = () => ({ query: '', signal: new AbortController().signal });

test('manually typed native collaboration commands recognize Tab separators before any model input', async () => {
  const client = await loadClient(async () => ({ ok: true, value: [] }));
  for (const [name, command] of [['arlo-send-status', client.sendStatus], ['arlo-continue', client.continueCollaboration]] as const) {
    assert.ok(command);
    assert.ok(await command.matchEnter(session, `/${name}\t`), 'Tab whitespace must retain the native human command boundary');
    assert.ok(await command.matchEnter(session, `/${name}\tforged-root`), 'Invalid arguments stay inside the rejecting native command');
    assert.equal(await command.matchEnter(session, `/${name}-other`), undefined);
  }
  assert.equal(client.creations(), 0);
});

test('native sending codec preserves known historical grants while lost usage remains unknown', () => {
  const codec = sendStatusDescriptor.result;
  assert.equal(codec.mode, 'strict');
  assert.ok(codec.mode === 'strict');
  const parse = codec.create().parse;
  const status = { mode: 'bounded', period_id: 'old-period', knowledge: 'unknown', granted: 20,
    used: null, remaining: null, next_grant: 20, pause_reason: 'ALLOWANCE_UNKNOWN',
    rules_revision: 'rules-1', rules_error: null,
    control_sequence: 1, daemon_id: 'fresh-daemon', root_configuration: { root_authenticated: true,
      config_id: 'root-config', config_path: 'C:/private/rules.json', ownership: 'verified', history: 'unknown',
      reason: 'BOUND', guidance: 'Use an explicit human continuation to restore sending.' } };
  assert.equal(parse(status), status);
  assert.throws(() => parse({ ...status, used: 0, remaining: 20 }), /Invalid Arlo sending allowance/u);
  const known = { ...status, knowledge: 'known', used: 3, remaining: 17, pause_reason: null };
  assert.equal(parse(known), known);
  const initial = { eligibility: 'consumed', reason: 'INITIAL_ALLOWANCE_CONSUMED', guidance: 'Use /arlo-continue when paused.' };
  const initialized = { ...known, initial_allowance: initial };
  assert.equal(parse(initialized), initialized);
  for (const initial_allowance of [null, { ...initial, eligibility: ['consumed'] },
    { ...initial, reason: 'made-up-reason' }, { ...initial, guidance: {} }]) {
    assert.throws(() => parse({ ...known, initial_allowance }), /Invalid Arlo initial allowance/u);
  }
  for (const knowledge of [['known'], [['known']]]) {
    assert.throws(() => parse({ ...known, knowledge }), /Invalid Arlo sending status/u,
      'The wire enum must be a string even when an array coerces to its spelling');
  }
  for (const invalid of [
    { ...known, remaining: 20 },
    { ...known, pause_reason: 'ALLOWANCE_EXHAUSTED' },
    { ...known, used: 20, remaining: 0, pause_reason: null },
    { ...known, granted: null },
    { ...known, period_id: null },
    { ...status, pause_reason: null },
  ]) assert.throws(() => parse(invalid), /Invalid Arlo sending allowance/u);
});

test('native sending codec accepts continuous known or unknown usage without a finite balance and checks rule metadata', () => {
  assert.ok(sendStatusDescriptor.result.mode === 'strict');
  const parse = sendStatusDescriptor.result.create().parse;
  const status = { mode: 'continuous', period_id: 'issued-period', knowledge: 'known', granted: 20,
    used: 21, remaining: null, next_grant: 7, pause_reason: null, rules_revision: 'rules-2', rules_error: null,
    control_sequence: 1, daemon_id: 'daemon', root_configuration: { root_authenticated: true,
      config_id: 'root-config', config_path: 'C:/private/rules.json', ownership: 'verified', history: 'unknown',
      reason: 'BOUND', guidance: 'Edit private rules and explicitly reload them.' } };
  assert.equal(parse(status), status);
  const unknown = { ...status, knowledge: 'unknown', used: null };
  assert.equal(parse(unknown), unknown);
  for (const invalid of [
    { ...status, remaining: 20 }, { ...status, pause_reason: 'ALLOWANCE_EXHAUSTED' },
    { ...status, used: null }, { ...status, knowledge: 'unknown', used: 0 },
    { ...status, rules_revision: null }, { ...status, rules_error: ['invalid'] },
  ]) assert.throws(() => parse(invalid), /Invalid Arlo/u);
});

test('native collaboration commands accept only their composer root and never run a model', async () => {
  const queries: string[] = [];
  const grants: string[] = [];
  const unknown = { mode: 'bounded', period_id: null, knowledge: 'unknown', granted: null,
    used: null, remaining: null, next_grant: 20, pause_reason: 'ALLOWANCE_UNKNOWN',
    control_sequence: 0, daemon_id: 'daemon-1', root_configuration: { ownership: 'verified' },
    initial_allowance: { eligibility: 'unknown', reason: 'FIRST_USE_UNPROVEN',
      guidance: 'First use could not be proven. Use /arlo-continue to explicitly start a period.' } };
  const client = await loadClient(async () => ({ ok: true, value: [] }), 'en', {}, undefined, {
    sendStatus: async sessionId => { queries.push(sessionId); return { ok: true, value: unknown }; },
    continueCollaboration: async sessionId => {
      grants.push(sessionId);
      return { ok: true, value: { ...unknown, period_id: 'period-1', knowledge: 'known', granted: 20,
        used: 0, remaining: 20, pause_reason: null } };
    },
  });
  assert.ok(client.sendStatus, 'The read-only native command must be publicly registered');
  assert.ok(client.continueCollaboration, 'The trusted human recovery command must be publicly registered');
  const status = client.sendStatus.onPick({ session }).claim;
  const resume = client.continueCollaboration.onPick({ session }).claim;
  assert.equal((await status.submit('another-root', {})).kind, 'error');
  assert.equal((await resume.submit('20 another-root', {})).kind, 'error');
  assert.deepEqual(queries, []);
  assert.deepEqual(grants, []);
  const before = await status.submit('', {});
  assert.match(before.text, /FIRST_USE_UNPROVEN/u);
  assert.match(before.text, /\/arlo-continue/u);
  assert.equal(before.kind, 'success');
  assert.match(before.text, /Used: unknown/u);
  assert.match(before.text, /Remaining: unknown/u);
  assert.match(before.text, /ALLOWANCE_UNKNOWN/u);
  assert.deepEqual(queries, ['sender']);
  const restored = await resume.submit('', {});
  assert.equal(restored.kind, 'success');
  assert.match(restored.text, /Remaining: 20/u);
  assert.match(restored.text, /dispatch attempts/u);
  assert.deepEqual(grants, ['sender']);
  assert.equal(client.creations(), 0);
});

test('native rule reload rejects arguments and reports continuous mode without inventing remaining attempts', async () => {
  const reloads: string[] = [];
  const client = await loadClient(async () => ({ ok: true, value: [] }), 'en', {}, undefined, {
    reloadSendingRules: async sessionId => {
      reloads.push(sessionId);
      return { ok: true, value: { mode: 'continuous', period_id: 'issued-period', knowledge: 'known',
        granted: 20, used: 21, remaining: null, next_grant: 7, pause_reason: null,
        rules_revision: 'revision-2', rules_error: null } };
    },
  });
  assert.ok(client.reloadSendingRules, 'The native human reload command must be publicly registered');
  assert.ok(await client.reloadSendingRules.matchEnter(session, '/arlo-reload-sending-rules\t'));
  const claim = client.reloadSendingRules.onPick({ session }).claim;
  assert.equal((await claim.submit('other-root 100', {})).kind, 'error');
  assert.deepEqual(reloads, []);
  const result = await claim.submit('', {});
  assert.equal(result.kind, 'success');
  assert.match(result.text, /Mode: continuous/u);
  assert.match(result.text, /Granted: 20/u);
  assert.match(result.text, /Used: 21/u);
  assert.match(result.text, /Remaining: unlimited/u);
  assert.match(result.text, /Next grant: 7/u);
  assert.deepEqual(reloads, ['sender']);
  assert.equal(client.creations(), 0);
});

test('native root configuration command queries only its composer root and reports ownership without model input', async () => {
  const queried: string[] = [];
  const client = await loadClient(async () => ({ ok: true, value: [] }), 'en', {}, async sessionId => {
    queried.push(sessionId);
    return { ok: true, value: {
      root_authenticated: true, config_id: 'root-config-test', config_path: 'C:/private/arlo/root-config-test.json',
      ownership: 'verified', history: 'unknown', reason: 'BOUND', guidance: 'Historical first eligibility remains unknown.',
    } };
  });
  assert.ok(client.rootConfig);
  const { claim } = client.rootConfig.onPick({ session });
  const forged = await claim.submit('another-root', {});
  assert.equal(forged.kind, 'error');
  assert.equal(queried.length, 0);
  const result = await claim.submit('', {});
  assert.equal(result.kind, 'success');
  assert.deepEqual(queried, ['sender']);
  assert.match(result.text, /root-config-test/u);
  assert.match(result.text, /C:\/private\/arlo\/root-config-test.json/u);
  assert.match(result.text, /verified/u);
  assert.match(result.text, /unknown/u);
  assert.equal(client.creations(), 0);
});

test('native reload displays the trusted invalid-rule explanation and keeps other error details private', async () => {
  let reason = 'SENDING_RULES_INVALID';
  let diagnostic = 'Sending rule grant must be a positive safe integer (1..9007199254740991)';
  const client = await loadClient(async () => ({ ok: true, value: [] }), 'en', {}, undefined, {
    reloadSendingRules: async () => ({ ok: false, error: {
      code: 'arlo/contact-unavailable', details: { reason, diagnostic },
    } }),
  });
  const claim = client.reloadSendingRules!.onPick({ session }).claim;
  const invalid = await claim.submit('', {});
  assert.equal(invalid.kind, 'error');
  assert.match(invalid.text, /SENDING_RULES_INVALID/u);
  assert.match(invalid.text, /grant must be a positive safe integer/u);
  reason = 'CHANNEL_NOT_READY';
  diagnostic = 'private-path-canary';
  const unavailable = await claim.submit('', {});
  assert.match(unavailable.text, /CHANNEL_NOT_READY/u);
  assert.ok(!unavailable.text.includes('private-path-canary'));
});

test('native settings command keeps invalid preferences out of the model and gives explicit feedback', async () => {
  const client = await loadClient(async () => ({ ok: true, value: [] }));
  assert.ok(client.settings);
  const { claim } = client.settings.onPick({ session });
  const result = await claim.submit('maybe', {});
  assert.equal(result.kind, 'error');
  assert.match(result.text, /on.*off/u);
  assert.equal(client.creations(), 0);
});

test('a failed contact RPC keeps a branded explanation visible without a selectable contact or creation', async () => {
  const client = await loadClient(async () => ({ ok: false, error: { code: 'arlo/contact-list-failed', details: { reason: 'CALLER_NOT_ROOT' } } }));
  const rows = await client.source.candidates(session, request());
  assert.equal(client.source.order, -100);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].section, 'Arlo · 联系会话');
  assert.equal(rows[0].name, '当前会话尚未连接 Arlo，请重新输入 @ 重试');
  assert.equal(client.source.onPick({ candidate: rows[0] }), undefined);
  assert.equal(client.creations(), 0);
});

test('a failed contact transport keeps the native explanation visible and cancellation still closes discovery', async () => {
  const client = await loadClient(async () => { throw new Error('Contact transport disconnected'); });
  const rows = await client.source.candidates(session, { ...request(), query: 'arlo:pi:', drilled: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '当前会话尚未连接 Arlo，请重新输入 @ 重试');
  assert.equal(client.source.onPick({ candidate: rows[0] }), undefined);
  assert.equal(client.creations(), 0);

  const controller = new AbortController();
  const reason = new Error('Cancelled contact menu');
  const cancelled = await loadClient(async () => {
    controller.abort(reason);
    throw new Error('Transport aborted');
  });
  await assert.rejects(cancelled.source.candidates(session, { query: 'arlo:pi:', signal: controller.signal }),
    error => error === reason);
});

test('successful contact discovery retains new and existing contact picks', async () => {
  const client = await loadClient(async () => ({ ok: true, value: [{ endpoint_id: 'ep-target', display_name: 'Receiver', host_kind: 'deepseek-harness', deliverable: true }] }));
  const rows = await client.source.candidates(session, request());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, '新对话');
  assert.match(client.source.onPick({ candidate: rows[0] })!.insert!.ref, /^new:/u);
  assert.equal(client.source.onPick({ candidate: rows[1] })!.text, '@arlo:deepseek-harness:');
  const selected = await client.source.candidates(session, { ...request(), query: 'arlo:deepseek-harness:' });
  assert.equal(client.source.onPick({ candidate: selected[0] })!.insert!.ref, 'ep-target');
  assert.equal(client.creations(), 0);
});

test('Arlo @ groups only live permitted hosts before choosing an exact endpoint, keeping new DSH independent', async () => {
  const client = await loadClient(async () => ({ ok: true, value: [
    { endpoint_id: 'ep-pi-a', display_name: 'Same title', host_kind: 'pi', deliverable: true },
    { endpoint_id: 'ep-pi-b', display_name: 'Same title', host_kind: 'pi', deliverable: true },
  ] }));
  const rows = await client.source.candidates(session, request());
  assert.equal(rows[0].value, 'new');
  assert.deepEqual(Array.from(rows.slice(1), item => item.name), ['Pi']);
  assert.equal(client.source.onPick({ candidate: rows[1] })?.insert, undefined);
  const breadcrumb = client.source.header?.(session, { query: 'arlo:pi:' });
  assert.equal(breadcrumb?.map(item => item.label).join(' / '), 'Arlo · 联系会话 / Pi');
  assert.equal(breadcrumb?.[1]?.value, 'host:pi');
  assert.equal(breadcrumb?.[1]?.current, true);
  const endpoints = await client.source.candidates(session, { ...request(), query: 'arlo:pi:', drilled: true });
  assert.equal(endpoints.length, 2);
  assert.ok(endpoints.every(item => item.description?.includes('Pi')));
  assert.notEqual(endpoints[0].name, endpoints[1].name);
  assert.equal(client.source.onPick({ candidate: endpoints[1] })?.insert?.ref, 'ep-pi-b');
  assert.equal(client.creations(), 0);
});

test('aborted discovery and malformed successful responses remain failures', async () => {
  const controller = new AbortController();
  const reason = new Error('Cancelled discovery');
  const client = await loadClient(async () => {
    controller.abort(reason);
    return { ok: false, error: { code: 'cancelled' } };
  });
  await assert.rejects(client.source.candidates(session, { query: '', signal: controller.signal }), error => error === reason);
  const malformed = await loadClient(async () => ({ ok: true, value: [{ endpoint_id: 'ep-target' }] }));
  await assert.rejects(malformed.source.candidates(session, request()), /Invalid Arlo contact/u);
});

function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const globals = {
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++id, { due: now + delay, callback });
      return id;
    },
    clearTimeout: (timer: number) => timers.delete(timer),
  };
  return {
    globals,
    pending: () => timers.size,
    now: () => now,
    async next() {
      const entry = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
      assert.ok(entry, 'Expected a pending discovery wait');
      now = entry[1].due;
      timers.delete(entry[0]);
      entry[1].callback();
      await flushPromises();
    },
  };
}

async function flushPromises() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const unavailable = (reason: string) => ({ ok: false, error: { code: 'arlo/contact-unavailable', details: { reason } } });

test('one open menu waits for cold session activation and receives contacts without another @', async () => {
  const clock = fakeClock();
  let calls = 0;
  const client = await loadClient(async () => {
    calls++;
    return calls === 1 ? unavailable('CALLER_NOT_ROOT') : calls === 2 ? unavailable('CHANNEL_NOT_READY') : { ok: true, value: [] };
  }, 'zh', clock.globals);
  const pending = client.source.candidates(session, request());
  await flushPromises();
  await clock.next();
  await clock.next();
  const rows = await pending;
  assert.equal(rows[0].value, 'new');
  assert.equal(calls, 3);
  assert.equal(clock.pending(), 0);
  assert.equal(client.creations(), 0);
});

test('discovery waits are bounded and aborted menus stop immediately', async () => {
  const clock = fakeClock();
  let calls = 0;
  const client = await loadClient(async () => { calls++; return unavailable('CHANNEL_NOT_READY'); }, 'zh', clock.globals);
  const pending = client.source.candidates(session, request());
  await flushPromises();
  while (clock.pending()) await clock.next();
  const rows = await pending;
  assert.equal(clock.now(), 15000);
  assert.equal(rows[0].name, '当前会话尚未连接 Arlo，请重新输入 @ 重试');
  assert.equal(client.source.onPick({ candidate: rows[0] }), undefined);
  const controller = new AbortController();
  const cancelled = client.source.candidates(session, { query: '', signal: controller.signal });
  await flushPromises();
  const before = calls;
  const reason = new Error('Menu closed');
  controller.abort(reason);
  await assert.rejects(cancelled, error => error === reason);
  assert.equal(clock.pending(), 0);
  assert.equal(calls, before);
  assert.equal(client.creations(), 0);
});

test('successful discovery and permanent failures do not poll', async () => {
  for (const response of [{ ok: true, value: [] }, unavailable('GROUP_MISMATCH')]) {
    const clock = fakeClock();
    let calls = 0;
    const client = await loadClient(async () => { calls++; return response; }, 'en', clock.globals);
    await client.source.candidates(session, request());
    assert.equal(calls, 1);
    assert.equal(clock.pending(), 0);
  }
});
