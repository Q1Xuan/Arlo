import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, ArloErrorCode, captureRootConfigurationEvidence } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

async function register(control: ControlClient, id = 'durable-root') {
  const runtime = await control.registerRuntime({ host_kind: 'pi' });
  return control.registerRoot(runtime.runtime_token, {
    root_session_id: id, group_name: 'configuration-test',
    agent_incarnation: crypto.randomUUID(), plugin_generation: 1,
  });
}

test('authenticated root configuration survives a fresh daemon without proving first eligibility', async () => {
  const stateDir = createTempDir('root-configuration');
  const sessionFile = path.join(stateDir, 'public-session.jsonl');
  fs.writeFileSync(sessionFile, 'host-owned-session');
  let daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    let control = new ControlClient({ stateDir });
    let root = await register(control);
    const request = () => ({ endpoint_id: root.endpoint_id, generation: root.generation,
      evidence: { kind: 'session-file' as const, session_file: sessionFile } });
    const first = await control.getRootConfiguration(root.root_token, request());
    assert.equal(first.ownership, 'verified');
    assert.match(first.config_id!, /^rc-[0-9a-f-]{36}$/);
    assert.equal(first.root_authenticated, true);
    assert.equal(first.history, 'unknown');
    assert.equal(first.config_path, path.join(stateDir, 'autonomous-communication.json'));
    await daemon.stop();
    daemon = new ArloDaemon({ stateDir });
    await daemon.start();
    control = new ControlClient({ stateDir });
    root = await register(control);
    const restored = await control.getRootConfiguration(root.root_token, request());
    assert.equal(restored.config_id, first.config_id);
    assert.equal(restored.ownership, 'verified');
    assert.equal(restored.history, 'unknown');
    fs.appendFileSync(sessionFile, '\nnew host entry');
    assert.equal((await control.getRootConfiguration(root.root_token, request())).config_id, first.config_id);
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('copied records, reused SessionIds and simultaneous live instances cannot share root rules', async () => {
  const stateDir = createTempDir('root-owner-conflict');
  const sessionFile = path.join(stateDir, 'original.jsonl');
  const copy = path.join(stateDir, 'copy.jsonl');
  fs.writeFileSync(sessionFile, 'host-owned-session');
  fs.copyFileSync(sessionFile, copy);
  const daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    const control = new ControlClient({ stateDir });
    const first = await register(control);
    const query = (root: typeof first, file = sessionFile) => control.getRootConfiguration(root.root_token, {
      endpoint_id: root.endpoint_id, generation: root.generation,
      evidence: { kind: 'session-file', session_file: file },
    });
    const established = await query(first);
    const second = await register(control);
    const copied = await query(second, copy);
    assert.equal(copied.reason, 'OWNER_CONFLICT');
    assert.equal(copied.config_id, null);
    const simultaneous = await Promise.all([query(first), query(second)]);
    assert.equal(simultaneous[1].ownership, 'conflict');
    assert.equal((await query(first)).ownership, 'conflict');
    await control.revokeRoot(second.root_token, { endpoint_id: second.endpoint_id });
    assert.equal((await query(first)).config_id, established.config_id);
    const otherId = await register(control, 'different-session-id');
    assert.equal((await query(otherId)).reason, 'OWNER_CONFLICT');
  } finally { await daemon.stop(); removeTempDir(stateDir); }
});

test('missing, damaged and incomplete persistent history stays unknown across daemon loads', async () => {
  const stateDir = createTempDir('root-history-loss');
  const sessionFile = path.join(stateDir, 'session.jsonl');
  fs.writeFileSync(sessionFile, 'host-owned-session');
  let daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    let control = new ControlClient({ stateDir });
    let root = await register(control);
    const query = () => control.getRootConfiguration(root.root_token, {
      endpoint_id: root.endpoint_id, generation: root.generation,
      evidence: { kind: 'session-file' as const, session_file: sessionFile },
    });
    const bound = await query();
    const ledger = path.join(stateDir, 'root-bindings.json');
    const original = fs.readFileSync(ledger);
    const witness = path.join(stateDir, 'root-bindings.initialized');
    const originalWitness = fs.readFileSync(witness);
    fs.unlinkSync(witness);
    assert.equal((await query()).reason, 'HISTORY_MISSING');
    fs.writeFileSync(witness, originalWitness);
    const anotherFile = path.join(stateDir, 'another-session.jsonl');
    fs.writeFileSync(anotherFile, 'another-host-session');
    const another = await register(control, 'another-durable-root');
    await control.getRootConfiguration(another.root_token, { endpoint_id: another.endpoint_id,
      generation: another.generation, evidence: { kind: 'session-file', session_file: anotherFile } });
    fs.writeFileSync(ledger, original);
    assert.equal((await query()).reason, 'HISTORY_CORRUPT');
    fs.writeFileSync(witness, originalWitness);
    fs.writeFileSync(ledger, '{truncated');
    assert.equal((await query()).reason, 'HISTORY_CORRUPT');
    fs.writeFileSync(ledger, original);
    const incomplete = JSON.parse(original.toString());
    incomplete.records = [];
    fs.writeFileSync(ledger, JSON.stringify(incomplete));
    assert.equal((await query()).reason, 'HISTORY_CORRUPT');
    fs.writeFileSync(ledger, original);
    assert.equal((await query()).config_id, bound.config_id);
    fs.unlinkSync(ledger);
    assert.equal((await query()).reason, 'HISTORY_MISSING');
    await daemon.stop();
    daemon = new ArloDaemon({ stateDir });
    await daemon.start();
    control = new ControlClient({ stateDir });
    root = await register(control);
    const missing = await query();
    assert.equal(missing.reason, 'HISTORY_MISSING');
    assert.equal(missing.root_authenticated, true);
    assert.equal(missing.history, 'unknown');
    assert.equal(missing.config_id, null);
  } finally { await daemon.stop(); removeTempDir(stateDir); }
});

test('a full persistent binding store preserves old owners and never evicts history', async () => {
  const stateDir = createTempDir('root-binding-capacity');
  const daemon = new ArloDaemon({ stateDir, maxRootConfigurationBindings: 1 });
  try {
    await daemon.start();
    const control = new ControlClient({ stateDir });
    const first = await register(control);
    const second = await register(control, 'second-root');
    const query = (root: typeof first, name: string) => {
      const file = path.join(stateDir, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, 'host-owned-session');
      return control.getRootConfiguration(root.root_token, { endpoint_id: root.endpoint_id,
        generation: root.generation, evidence: { kind: 'session-file', session_file: file } });
    };
    const original = await query(first, 'first.jsonl');
    const full = await query(second, 'second.jsonl');
    assert.equal(full.reason, 'CAPACITY_EXHAUSTED');
    assert.equal(full.config_id, null);
    assert.equal((await query(first, 'first.jsonl')).config_id, original.config_id);
    await control.revokeRoot(first.root_token, { endpoint_id: first.endpoint_id });
    assert.equal((await query(second, 'second.jsonl')).reason, 'CAPACITY_EXHAUSTED');
  } finally { await daemon.stop(); removeTempDir(stateDir); }
});

test('configuration queries reject forged roots and generations and keep audit metadata private', async () => {
  const stateDir = createTempDir('root-binding-auth');
  const sessionFile = path.join(stateDir, 'private-path-canary.jsonl');
  fs.writeFileSync(sessionFile, 'private-content-canary');
  const daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    const control = new ControlClient({ stateDir });
    const first = await register(control);
    const second = await register(control, 'other-root');
    const request = { endpoint_id: first.endpoint_id, generation: first.generation,
      evidence: { kind: 'session-file' as const, session_file: sessionFile } };
    await assert.rejects(control.getRootConfiguration(second.root_token, request), { code: ArloErrorCode.UNAUTHORIZED });
    await assert.rejects(control.getRootConfiguration(first.root_token, { ...request, generation: 0 }), { code: ArloErrorCode.STALE_GENERATION });
    await assert.rejects(control.getRootConfiguration(first.root_token, { ...request, config_id: 'pretend-owner' } as typeof request), { code: ArloErrorCode.INVALID_ARGUMENT });
    assert.equal((await control.getRootConfiguration(first.root_token, { endpoint_id: first.endpoint_id, generation: first.generation })).reason, 'EVIDENCE_UNAVAILABLE');
    const bound = await control.getRootConfiguration(first.root_token, request);
    assert.equal(bound.ownership, 'verified');
    const log = fs.readFileSync(path.join(stateDir, 'daemon.log'), 'utf8');
    assert.ok(log.includes('ROOT_CONFIGURATION_QUERIED'));
    for (const secret of [sessionFile, 'private-content-canary', first.root_token, 'durable-root']) assert.ok(!log.includes(secret));
    const current = await control.connectRoot(first.root_token, { endpoint_id: first.endpoint_id });
    await assert.rejects(control.getRootConfiguration(first.root_token, request), { code: ArloErrorCode.STALE_GENERATION });
    assert.equal((await control.getRootConfiguration(current.root_token, { ...request, generation: current.generation })).config_id, bound.config_id);
    const pinned = captureRootConfigurationEvidence(sessionFile);
    fs.renameSync(sessionFile, `${sessionFile}.previous`);
    fs.writeFileSync(sessionFile, 'replacement-host-session');
    const replaced = await control.getRootConfiguration(current.root_token, { ...request,
      generation: current.generation, evidence: pinned });
    assert.equal(replaced.ownership, 'conflict');
    assert.equal(replaced.config_id, null);
  } finally { await daemon.stop(); removeTempDir(stateDir); }
});

test('unavailable storage and copied binding ledgers cannot report a successful owner', async () => {
  const stateDir = createTempDir('root-binding-storage');
  const otherDir = createTempDir('root-binding-copy');
  const file = path.join(stateDir, 'session.jsonl');
  fs.writeFileSync(file, 'host-owned-session');
  let daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    let control = new ControlClient({ stateDir });
    let root = await register(control);
    const query = () => control.getRootConfiguration(root.root_token, { endpoint_id: root.endpoint_id,
      generation: root.generation, evidence: { kind: 'session-file' as const, session_file: file } });
    const ledger = path.join(stateDir, 'root-bindings.json');
    fs.mkdirSync(ledger);
    assert.equal((await query()).reason, 'STORAGE_UNAVAILABLE');
    fs.rmdirSync(ledger);
    assert.equal((await query()).ownership, 'verified');
    fs.copyFileSync(ledger, path.join(otherDir, 'root-bindings.json'));
    fs.copyFileSync(path.join(stateDir, 'root-bindings.initialized'), path.join(otherDir, 'root-bindings.initialized'));
    await daemon.stop();
    daemon = new ArloDaemon({ stateDir: otherDir });
    await daemon.start();
    control = new ControlClient({ stateDir: otherDir });
    root = await register(control);
    const copied = await query();
    assert.equal(copied.reason, 'HISTORY_CORRUPT');
    assert.equal(copied.config_id, null);
  } finally { await daemon.stop(); removeTempDir(stateDir); removeTempDir(otherDir); }
});
