import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, ArloErrorCode, captureRootConfigurationEvidence,
  type RootRegistrationResponse, type RootFirstUseEvidence } from '@arlo/sdk';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from './test-utils.ts';

async function rig() {
  const stateDir = createTempDir('initial-sending');
  let daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT, leaseNow: () => 0 });
  let control: ControlClient;
  const roots = new Map<string, { binding: RootRegistrationResponse;
    connection: ReturnType<ControlClient['createRootConnection']>; firstUse: RootFirstUseEvidence }>();
  const receipts = new Set<Promise<unknown>>();
  const start = async () => {
    await daemon.start();
    control = new ControlClient({ stateDir });
    const runtime = await control.registerRuntime({ host_kind: 'dsh' });
    for (const name of ['sender', 'receiver']) {
      const sessionFile = path.join(stateDir, `${name}.session`);
      if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, `durable native session ${name}`);
      const binding = await control.registerRoot(runtime.runtime_token, {
        root_session_id: `initial-${name}`, group_name: 'initial-group',
        agent_incarnation: crypto.randomUUID(), plugin_generation: 1,
        continuity_token: crypto.randomUUID(),
      });
      const connection = control.createRootConnection(binding, { heartbeat: false });
      const firstUse: RootFirstUseEvidence = { kind: 'new-session-materialized',
        evidence: captureRootConfigurationEvidence(sessionFile, undefined, `immutable-native-origin-${name}`),
        creation_id: crypto.randomUUID() };
      roots.set(name, { binding, connection, firstUse });
      connection.onNotification(frame => {
        const receipt = control.submitReceipt(binding.root_token, {
          daemon_id: frame.daemon_id, endpoint_id: binding.endpoint_id, generation: frame.target_generation,
          message_id: frame.message_id, delivery_id: frame.delivery_id,
          status: 'enqueued', native_message_id: `native-${frame.message_id}`,
        });
        receipts.add(receipt);
        void receipt.then(() => receipts.delete(receipt), () => receipts.delete(receipt));
      });
      await connection.connect();
      await control.confirmRootReady(binding.root_token, { endpoint_id: binding.endpoint_id });
    }
  };
  const request = (name = 'sender') => {
    const { binding, firstUse } = roots.get(name)!;
    return { endpoint_id: binding.endpoint_id, generation: binding.generation, evidence: firstUse.evidence };
  };
  const status = (name = 'sender') => control.getRootSendingStatus(roots.get(name)!.binding.root_token, request(name));
  const initialize = (firstUse: RootFirstUseEvidence | undefined = roots.get('sender')!.firstUse) =>
    control.initializeRootSending(roots.get('sender')!.binding.root_token, { ...request(), first_use: firstUse });
  const reload = async (mode: 'bounded' | 'continuous', grant: number, name = 'sender') => {
    const current = await status(name);
    fs.writeFileSync(current.root_configuration.config_path, JSON.stringify({ version: 1,
      roots: { [current.root_configuration.config_id!]: { mode, grant } } }), { mode: 0o600 });
    return control.reloadSendingRules(roots.get(name)!.binding.root_token, {
      ...request(name), daemon_id: current.daemon_id, rules_revision: current.rules_revision,
    });
  };
  const grant = async () => {
    const current = await status();
    return control.continueCollaboration(roots.get('sender')!.binding.root_token, {
      ...request(), daemon_id: current.daemon_id, sequence: current.control_sequence + 1, request_id: crypto.randomUUID(),
    });
  };
  const send = async () => {
    const sent = await roots.get('sender')!.connection.sendMessage({
      to: roots.get('receiver')!.binding.endpoint_id, text: 'first public dispatch',
    });
    await Promise.all(receipts);
    return sent;
  };
  const stop = async () => {
    for (const root of roots.values()) root.connection.dispose();
    await Promise.allSettled(receipts);
    await daemon.stop();
  };
  try { await start(); } catch (error) { await stop(); removeTempDir(stateDir); throw error; }
  return { stateDir, roots, request, status, initialize, reload, grant, send,
    control: () => control,
    async restart() {
      await stop(); roots.clear();
      daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT, leaseNow: () => 0 });
      await start();
    },
    async close() { try { await stop(); } finally { removeTempDir(stateDir); } },
  };
}

test('trusted first-use SDK initialization grants one period and cannot reset a dispatched attempt', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    assert.equal((await r.status()).knowledge, 'unknown');
    const first = await r.initialize();
    assert.equal(first.remaining, 20);
    assert.equal(first.control_sequence, 0);
    assert.equal(first.initial_allowance?.eligibility, 'consumed');
    assert.equal((await r.send()).status, 'accepted');
    const repeated = await r.initialize();
    assert.equal(repeated.period_id, first.period_id);
    assert.equal(repeated.used, 1);
    assert.equal(repeated.remaining, 19);
  } finally { await r.close(); }
});

test('initial issuance uses the published root rule and mode changes preserve its period until explicit bounded continuation', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    const configured = await r.reload('bounded', 3);
    assert.equal(configured.knowledge, 'unknown');
    const initial = await r.initialize();
    assert.equal(initial.granted, 3);
    assert.equal(initial.remaining, 3);
    assert.equal(initial.control_sequence, 0);
    await r.send();
    const continuous = await r.reload('continuous', 7);
    assert.equal(continuous.period_id, initial.period_id);
    assert.equal(continuous.granted, 3);
    assert.equal(continuous.used, 1);
    for (let index = 0; index < 3; index++) assert.equal((await r.send()).status, 'accepted');
    const delayed = await r.initialize();
    assert.equal(delayed.period_id, initial.period_id);
    assert.equal(delayed.used, 4);
    assert.equal(delayed.remaining, null);
    const bounded = await r.reload('bounded', 7);
    assert.equal(bounded.granted, 3);
    assert.equal(bounded.used, 4);
    assert.equal(bounded.remaining, 0);
    await assert.rejects(r.send(), { code: ArloErrorCode.ALLOWANCE_EXHAUSTED });
    assert.equal((await r.initialize()).used, 4);
    const continued = await r.grant();
    assert.equal(continued.control_sequence, 1);
    assert.equal(continued.granted, 7);
    assert.equal(continued.remaining, 7);
    assert.notEqual(continued.period_id, initial.period_id);
  } finally { await r.close(); }
});

test('continuous dispatch with unknown usage remains unknown through delayed initialization and endpoint replacement', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    const continuous = await r.reload('continuous', 3);
    const configId = continuous.root_configuration.config_id;
    assert.equal(continuous.knowledge, 'unknown');
    assert.equal(continuous.period_id, null);
    assert.equal((await r.send()).status, 'accepted');
    const delayed = await r.initialize();
    assert.equal(delayed.mode, 'continuous');
    assert.equal(delayed.knowledge, 'unknown');
    assert.equal(delayed.period_id, null);
    assert.equal(delayed.used, null);
    assert.equal(delayed.initial_allowance?.reason, 'DISPATCH_HISTORY_PRESENT');
    const sender = r.roots.get('sender')!;
    await r.control().revokeRoot(sender.binding.root_token, { endpoint_id: sender.binding.endpoint_id });
    sender.connection.dispose();
    const runtime = await r.control().registerRuntime({ host_kind: 'dsh' });
    const binding = await r.control().registerRoot(runtime.runtime_token, {
      root_session_id: 'initial-sender', group_name: 'initial-group',
      agent_incarnation: crypto.randomUUID(), plugin_generation: 1,
    });
    sender.binding = binding;
    sender.connection = r.control().createRootConnection(binding, { heartbeat: false });
    await sender.connection.connect();
    await r.control().confirmRootReady(binding.root_token, { endpoint_id: binding.endpoint_id });
    const replacement = await r.initialize();
    assert.equal(replacement.root_configuration.config_id, configId);
    assert.equal(replacement.period_id, null);
    assert.equal(replacement.used, null);
    assert.equal(replacement.initial_allowance?.reason, 'DISPATCH_HISTORY_PRESENT');
    const bounded = await r.reload('bounded', 3);
    assert.equal(bounded.used, null);
    assert.equal(bounded.pause_reason, ArloErrorCode.ALLOWANCE_UNKNOWN);
    await assert.rejects(r.send(), { code: ArloErrorCode.ALLOWANCE_UNKNOWN });
    const continued = await r.grant();
    assert.equal(continued.remaining, 3);
    assert.equal(continued.control_sequence, 1);
    assert.equal((await r.send()).status, 'accepted');
  } finally { await r.close(); }
});

test('registration and incomplete first-use evidence never grant, while a trusted human operation consumes eligibility', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    const root = r.roots.get('sender')!;
    const unproven = await r.control().initializeRootSending(root.binding.root_token, r.request());
    assert.equal(unproven.knowledge, 'unknown');
    assert.equal(unproven.initial_allowance?.reason, 'FIRST_USE_UNPROVEN');
    const incomplete = await r.initialize({ ...root.firstUse,
      evidence: { kind: 'session-file', session_file: root.firstUse.evidence.session_file } });
    assert.equal(incomplete.remaining, null);
    const continued = await r.grant();
    assert.equal(continued.control_sequence, 1);
    await r.send();
    const delayed = await r.initialize();
    assert.equal(delayed.period_id, continued.period_id);
    assert.equal(delayed.used, 1);
    assert.equal(delayed.initial_allowance?.eligibility, 'consumed');
  } finally { await r.close(); }
});

test('initial eligibility survives daemon replacement without reconstructing lost usage and explicit continue restores sending', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    const initial = await r.initialize();
    await r.send();
    await r.restart();
    const replaced = await r.initialize();
    assert.notEqual(replaced.daemon_id, initial.daemon_id);
    assert.equal(replaced.period_id, initial.period_id);
    assert.equal(replaced.knowledge, 'unknown');
    assert.equal(replaced.initial_allowance?.eligibility, 'consumed');
    await assert.rejects(r.send(), { code: ArloErrorCode.ALLOWANCE_UNKNOWN });
    const continued = await r.grant();
    assert.equal(continued.control_sequence, 1);
    assert.equal(continued.remaining, 20);
    assert.notEqual(continued.period_id, initial.period_id);
    assert.equal((await r.send()).status, 'accepted');
  } finally { await r.close(); }
});

test('qualification publication failures before, during and after commit never manufacture a second initial period', { timeout: 120000 }, async t => {
  const r = await rig();
  const rename = fs.renameSync;
  try {
    const marker = path.join(r.stateDir, 'sending-controls.initialized');
    const ledger = path.join(r.stateDir, 'sending-controls.json');
    const before = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === marker) throw new Error('disk refuses qualification witness');
      return rename(from, to);
    });
    await assert.rejects(r.initialize(), { code: ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE });
    before.mock.restore();
    assert.equal((await r.status()).remaining, null);
    assert.equal((await r.status()).initial_allowance?.reason, 'FIRST_USE_UNPROVEN');
    const during = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === ledger) throw new Error('disk refuses qualification publication after witness');
      return rename(from, to);
    });
    await assert.rejects(r.initialize(), { code: ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE });
    during.mock.restore();
    const incomplete = await r.initialize();
    assert.equal(incomplete.remaining, null);
    assert.equal(incomplete.initial_allowance?.reason, 'HISTORY_UNAVAILABLE');
    await r.reload('continuous', 3);
    const querying = await r.grant();
    assert.equal(querying.mode, 'continuous');
    assert.equal(querying.used, null);
    assert.equal(querying.period_id, null);
    assert.equal(querying.initial_allowance?.reason, 'HISTORY_UNAVAILABLE');
  } finally { await r.close(); }

  const committed = await rig();
  try {
    const senderFile = committed.roots.get('sender')!.firstUse.evidence.session_file;
    const ledger = path.join(committed.stateDir, 'sending-controls.json');
    const after = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      rename(from, to);
      if (String(to) === ledger) fs.appendFileSync(senderFile, 'native session changed before opening');
    });
    await assert.rejects(committed.initialize(), { code: ArloErrorCode.ALLOWANCE_UNKNOWN });
    after.mock.restore();
    committed.roots.get('sender')!.firstUse.evidence = captureRootConfigurationEvidence(senderFile, undefined, 'immutable-native-origin-sender');
    const state = await committed.initialize();
    assert.equal(state.remaining, null);
    assert.equal(state.initial_allowance?.eligibility, 'consumed');
    assert.equal((await committed.grant()).remaining, 20);
  } finally { await committed.close(); }
});

test('missing, corrupt and cleaned sending history cannot turn an established persistent root into first use', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    await r.initialize();
    const ledger = path.join(r.stateDir, 'sending-controls.json');
    const marker = path.join(r.stateDir, 'sending-controls.initialized');
    const validHistory = fs.readFileSync(ledger, 'utf8');
    fs.writeFileSync(ledger, '{broken history');
    assert.equal((await r.initialize()).initial_allowance?.reason, 'HISTORY_UNAVAILABLE');
    fs.writeFileSync(ledger, validHistory);
    fs.unlinkSync(ledger);
    await r.restart();
    const missing = await r.initialize();
    assert.equal(missing.remaining, null);
    assert.equal(missing.initial_allowance?.reason, 'HISTORY_UNAVAILABLE');
    fs.unlinkSync(marker);
    await r.restart();
    const cleaned = await r.initialize();
    assert.equal(cleaned.remaining, null, 'A persisted binding with erased issuance history is never a newly created root');
    assert.equal(cleaned.initial_allowance?.eligibility, 'unknown');
    assert.equal((await r.grant()).remaining, 20, 'Trusted explicit continue can establish a new period without treating the old root as first use');
  } finally { await r.close(); }
});

test('full persistent history preserves legacy human grants and refuses additional automatic or human issuance without eviction', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    const continued = await r.grant();
    const ledgerPath = path.join(r.stateDir, 'sending-controls.json');
    const markerPath = path.join(r.stateDir, 'sending-controls.initialized');
    // A valid #76 history could hold 10,000 human requests plus its binding row.
    // Exercise that persisted compatibility boundary without 10,000 fsyncs.
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    ledger.records[0].sequence = 10_000;
    ledger.records[0].requests = Array.from({ length: 10_000 }, (_, index) => ({
      request_id: `legacy-human-${index + 1}`, fingerprint: 'a'.repeat(64), sequence: index + 1,
    }));
    ledger.checksum = (await import('node:crypto')).default.createHash('sha256')
      .update(JSON.stringify([ledger.version, ledger.authority, ledger.records])).digest('hex');
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    fs.writeFileSync(markerPath, `${ledger.checksum}\n`);
    const readable = await r.status();
    assert.equal(readable.period_id, continued.period_id);
    assert.equal(readable.knowledge, 'known');
    assert.equal(readable.control_sequence, 10_000);
    await assert.rejects(r.grant(), { code: ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE });
    const receiver = r.roots.get('receiver')!;
    const refused = await r.control().initializeRootSending(receiver.binding.root_token, {
      ...r.request('receiver'), first_use: receiver.firstUse,
    });
    assert.equal(refused.remaining, null);
    assert.equal(refused.initial_allowance?.reason, 'CAPACITY_EXHAUSTED');
    const configured = await r.reload('continuous', 3, 'receiver');
    const querying = await r.control().continueCollaboration(receiver.binding.root_token, {
      ...r.request('receiver'), daemon_id: configured.daemon_id,
      sequence: configured.control_sequence + 1, request_id: crypto.randomUUID(),
    });
    assert.equal(querying.mode, 'continuous');
    assert.equal(querying.used, null);
    assert.equal(querying.period_id, null);
    assert.equal(querying.initial_allowance?.reason, 'CAPACITY_EXHAUSTED');
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), JSON.stringify(ledger), 'No old eligibility or control identity is evicted');
    assert.equal((await r.status()).remaining, 20, 'Storage fullness cannot invalidate an earlier live grant');
  } finally { await r.close(); }
});

test('concurrent initial callbacks and explicit continue preserve the human period and replacement endpoints never gain an initial refill', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    const current = await r.status();
    const sender = r.roots.get('sender')!;
    const human = { ...r.request(), daemon_id: current.daemon_id, request_id: crypto.randomUUID(), sequence: 1 };
    const results = await Promise.allSettled([r.initialize(), r.initialize(),
      r.control().continueCollaboration(sender.binding.root_token, human)]);
    for (const result of results) {
      if (result.status === 'rejected') assert.equal(result.reason.code, ArloErrorCode.CONNECTION_FAILED,
        'Only an ambiguous SDK control deadline may lose a response');
    }
    const continued = await r.control().continueCollaboration(sender.binding.root_token, human);
    assert.equal(continued.control_sequence, 1);
    assert.equal(continued.remaining, 20);
    await r.send();
    assert.equal((await r.initialize()).used, 1);
    const oldEndpoint = sender.binding.endpoint_id;
    await r.control().revokeRoot(sender.binding.root_token, { endpoint_id: oldEndpoint });
    sender.connection.dispose();
    const runtime = await r.control().registerRuntime({ host_kind: 'dsh' });
    const binding = await r.control().registerRoot(runtime.runtime_token, {
      root_session_id: 'initial-sender', group_name: 'replacement-group',
      agent_incarnation: crypto.randomUUID(), plugin_generation: 1,
    });
    sender.binding = binding;
    sender.connection = r.control().createRootConnection(binding, { heartbeat: false });
    await sender.connection.connect();
    await r.control().confirmRootReady(binding.root_token, { endpoint_id: binding.endpoint_id });
    const replacement = await r.initialize();
    assert.notEqual(binding.endpoint_id, oldEndpoint);
    assert.equal(replacement.period_id, continued.period_id);
    assert.equal(replacement.remaining, null);
    assert.equal(replacement.initial_allowance?.eligibility, 'consumed');
    const explicit = await r.grant();
    assert.equal(explicit.control_sequence, 2);
    assert.equal(explicit.remaining, 20);
  } finally { await r.close(); }
});

test('surviving sending history prevents cleaned ownership history from minting a replacement configuration and initial allowance', { timeout: 120000 }, async () => {
  const r = await rig();
  try {
    const initial = await r.initialize();
    const bindingPath = path.join(r.stateDir, 'root-bindings.json');
    const markerPath = path.join(r.stateDir, 'root-bindings.initialized');
    const bindings = fs.readFileSync(bindingPath);
    const marker = fs.readFileSync(markerPath);
    fs.unlinkSync(bindingPath);
    fs.unlinkSync(markerPath);
    await r.restart();
    const lost = await r.initialize();
    assert.equal(lost.remaining, null);
    assert.equal(lost.root_configuration.reason, 'HISTORY_MISSING');
    assert.equal(lost.root_configuration.config_id, null);
    fs.writeFileSync(bindingPath, bindings);
    fs.writeFileSync(markerPath, marker);
    const restored = await r.initialize();
    assert.equal(restored.root_configuration.config_id, initial.root_configuration.config_id);
    assert.equal(restored.initial_allowance?.eligibility, 'consumed');
    assert.equal(restored.remaining, null);
    assert.equal((await r.grant()).remaining, 20);
  } finally { await r.close(); }
});
