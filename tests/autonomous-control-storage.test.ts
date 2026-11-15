import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, ArloErrorCode } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('missing or damaged durable controls cannot report recovery or recreate successful requests', { timeout: 120000 }, async () => {
  const stateDir = createTempDir('sending-control-storage');
  const daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    const control = new ControlClient({ stateDir });
    const runtime = await control.registerRuntime({ host_kind: 'pi' });
    const root = await control.registerRoot(runtime.runtime_token, {
      root_session_id: 'durable-user-control', group_name: 'sending-storage',
      agent_incarnation: crypto.randomUUID(), plugin_generation: 1,
    });
    const file = path.join(stateDir, 'public-session.jsonl');
    fs.writeFileSync(file, 'public-host-session');
    const query = { endpoint_id: root.endpoint_id, generation: root.generation,
      evidence: { kind: 'session-file' as const, session_file: file } };
    const initial = await control.getRootSendingStatus(root.root_token, query);
    const request = { ...query, daemon_id: initial.daemon_id, request_id: crypto.randomUUID(), sequence: 1 };
    const first = await control.continueCollaboration(root.root_token, request);
    assert.equal(first.remaining, 20);
    const ledger = path.join(stateDir, 'sending-controls.json');
    const witness = path.join(stateDir, 'sending-controls.initialized');
    const original = fs.readFileSync(ledger);
    fs.unlinkSync(ledger);
    const lost = await control.getRootSendingStatus(root.root_token, query);
    assert.equal(lost.knowledge, 'unknown');
    assert.equal(lost.used, null);
    assert.equal(lost.remaining, null);
    await assert.rejects(control.continueCollaboration(root.root_token, request), { code: ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE });
    assert.equal(fs.existsSync(witness), true);
    fs.writeFileSync(ledger, '{incomplete');
    await assert.rejects(control.continueCollaboration(root.root_token, { ...request,
      request_id: crypto.randomUUID(), sequence: 2 }), { code: ArloErrorCode.CONTROL_HISTORY_UNAVAILABLE });
    fs.writeFileSync(ledger, original);
    const replay = await control.continueCollaboration(root.root_token, request);
    assert.equal(replay.knowledge, 'unknown');
    assert.equal(replay.remaining, null, 'Restoring the successful control record cannot reconstruct usage');
    const restored = await control.continueCollaboration(root.root_token, { ...request,
      request_id: crypto.randomUUID(), sequence: 2 });
    assert.equal(restored.remaining, 20);
    assert.notEqual(restored.period_id, first.period_id);
    const log = fs.readFileSync(path.join(stateDir, 'daemon.log'), 'utf8');
    for (const secret of [file, root.root_token, 'public-host-session', 'durable-user-control']) {
      assert.equal(log.includes(secret), false);
    }
  } finally { await daemon.stop(); removeTempDir(stateDir); }
});

test('a root changed during durable continuation is never opened by the stale human operation', { timeout: 120000 }, async t => {
  const stateDir = createTempDir('sending-control-root-race');
  const daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    const control = new ControlClient({ stateDir });
    const runtime = await control.registerRuntime({ host_kind: 'pi' });
    const root = await control.registerRoot(runtime.runtime_token, {
      root_session_id: 'changing-root', group_name: 'sending-storage',
      agent_incarnation: crypto.randomUUID(), plugin_generation: 1,
    });
    const file = path.join(stateDir, 'public-session.jsonl');
    const previousFile = `${file}.original`;
    fs.writeFileSync(file, 'public-original-session');
    const query = { endpoint_id: root.endpoint_id, generation: root.generation,
      evidence: { kind: 'session-file' as const, session_file: file } };
    const initial = await control.getRootSendingStatus(root.root_token, query);
    const request = { ...query, daemon_id: initial.daemon_id, request_id: crypto.randomUUID(), sequence: 1 };
    const rename = fs.renameSync;
    // File system fault injection is at the storage boundary. No private
    // daemon container, binding, ledger method or model is mocked.
    let injected = false;
    const injection = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      rename(from, to);
      if (!injected && String(to) === path.join(stateDir, 'sending-controls.json')) {
        injected = true;
        rename(file, previousFile);
        fs.writeFileSync(file, 'replacement-host-session');
      }
    });
    await assert.rejects(control.continueCollaboration(root.root_token, request), { code: ArloErrorCode.ALLOWANCE_UNKNOWN });
    injection.mock.restore();
    assert.equal(injected, true);
    fs.unlinkSync(file);
    rename(previousFile, file);
    const current = await control.getRootSendingStatus(root.root_token, query);
    assert.equal(current.knowledge, 'unknown');
    assert.equal(current.remaining, null);
    assert.equal(current.control_sequence, 1, 'The ambiguous operation remains durably consumed');
    assert.equal((await control.continueCollaboration(root.root_token, request)).knowledge, 'unknown');
    const next = await control.continueCollaboration(root.root_token, { ...request,
      request_id: crypto.randomUUID(), sequence: 2 });
    assert.equal(next.remaining, 20);
  } finally { await daemon.stop(); removeTempDir(stateDir); }
});
