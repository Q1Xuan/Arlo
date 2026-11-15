import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { ArloDaemon } from '@arlo/daemon';
import { captureRootConfigurationEvidence, ControlClient } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('public persistence evidence pins the validated open file even when its path is replaced', () => {
  const directory = createTempDir('root-configuration-evidence');
  const sessionFile = path.join(directory, 'public-session.jsonl');
  fs.writeFileSync(sessionFile, 'original public session');
  const descriptor = fs.openSync(sessionFile, 'r');
  try {
    const validated = captureRootConfigurationEvidence(sessionFile, descriptor);
    assert.equal(validated.kind, 'session-file');
    assert.equal(validated.session_file, sessionFile);
    assert.match(validated.file_identity!, /^[0-9a-f]{64}$/);
    fs.appendFileSync(sessionFile, '\nnew public session entry');
    assert.equal(captureRootConfigurationEvidence(sessionFile).file_identity, validated.file_identity,
      'Appending legitimate session history does not replace the persistent owner');

    fs.renameSync(sessionFile, path.join(directory, 'original-session.jsonl'));
    fs.writeFileSync(sessionFile, 'a different public session');
    assert.equal(captureRootConfigurationEvidence(sessionFile, descriptor).file_identity, validated.file_identity,
      'The proof continues to identify the artifact that the host actually validated');
    assert.notEqual(captureRootConfigurationEvidence(sessionFile).file_identity, validated.file_identity,
      'Reusing a path does not silently reuse physical persistence ownership');
  } finally {
    fs.closeSync(descriptor);
    removeTempDir(directory);
  }
});

test('public persistence evidence distinguishes immutable host origins within the same physical file', () => {
  const directory = createTempDir('root-configuration-origin');
  const sessionFile = path.join(directory, 'public-session.jsonl');
  fs.writeFileSync(sessionFile, 'public session artifact');
  try {
    const originalOrigin = JSON.stringify(['same-session-id', '2026-10-17T01:00:00Z', directory, null]);
    const replacementOrigin = JSON.stringify(['same-session-id', '2026-10-17T02:00:00Z', directory, null]);
    const original = captureRootConfigurationEvidence(sessionFile, undefined, originalOrigin);
    const replacement = captureRootConfigurationEvidence(sessionFile, undefined, replacementOrigin);
    assert.equal(replacement.file_identity, original.file_identity);
    assert.match(original.host_origin!, /^[0-9a-f]{64}$/);
    assert.notEqual(replacement.host_origin, original.host_origin,
      'The same SessionId in another public immutable origin is a different owner');
    assert.equal(captureRootConfigurationEvidence(sessionFile, undefined, originalOrigin).host_origin, original.host_origin,
      'Reloading the same immutable public origin preserves its owner evidence');
    assert.ok(!JSON.stringify(original).includes('2026-10-17T01:00:00Z'), 'Raw immutable header values stay out of wire evidence');
  } finally {
    removeTempDir(directory);
  }
});

test('the real SDK and Daemon reject a replaced artifact before establishing persistent root ownership', async () => {
  const directory = createTempDir('root-configuration-pinned-query');
  const stateDir = path.join(directory, 'daemon');
  const sessionFile = path.join(directory, 'public-session.jsonl');
  const originalFile = path.join(directory, 'original-session.jsonl');
  fs.writeFileSync(sessionFile, 'public host validated this session');
  const descriptor = fs.openSync(sessionFile, 'r');
  const daemon = new ArloDaemon({ stateDir });
  const control = new ControlClient({ stateDir });
  try {
    await daemon.start();
    const runtime = await control.registerRuntime({ host_kind: 'pi' });
    const root = await control.registerRoot(runtime.runtime_token, {
      root_session_id: 'pinned-root', group_name: 'pinned-configuration',
      agent_incarnation: crypto.randomUUID(), plugin_generation: 1,
    });
    const evidence = captureRootConfigurationEvidence(sessionFile, descriptor);
    fs.renameSync(sessionFile, originalFile);
    fs.writeFileSync(sessionFile, 'unvalidated replacement');
    const request = { endpoint_id: root.endpoint_id, generation: root.generation, evidence };
    const rejected = await control.getRootConfiguration(root.root_token, request);
    assert.equal(rejected.root_authenticated, true);
    assert.equal(rejected.ownership, 'conflict');
    assert.equal(rejected.reason, 'OWNER_CONFLICT');
    assert.equal(rejected.config_id, null);
    assert.equal(rejected.history, 'unknown');

    fs.unlinkSync(sessionFile);
    fs.renameSync(originalFile, sessionFile);
    // Restoring a path can change write metadata. The host validates the
    // restored artifact again and captures its current revision before reuse.
    const restored = await control.getRootConfiguration(root.root_token, {
      ...request, evidence: captureRootConfigurationEvidence(sessionFile, descriptor),
    });
    assert.equal(restored.ownership, 'verified');
    assert.equal(restored.reason, 'BOUND');
    assert.ok(restored.config_id);
    assert.equal(restored.history, 'unknown');
  } finally {
    fs.closeSync(descriptor);
    control.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});

test('the real SDK and Daemon reject an in-place overwrite after host validation without binding stale ownership', async () => {
  const directory = createTempDir('root-configuration-revision-query');
  const stateDir = path.join(directory, 'daemon');
  const sessionFile = path.join(directory, 'public-session.jsonl');
  fs.writeFileSync(sessionFile, 'the public host validated this original session');
  const daemon = new ArloDaemon({ stateDir });
  const control = new ControlClient({ stateDir });
  try {
    await daemon.start();
    const runtime = await control.registerRuntime({ host_kind: 'pi' });
    const root = await control.registerRoot(runtime.runtime_token, {
      root_session_id: 'revision-root', group_name: 'revision-configuration',
      agent_incarnation: crypto.randomUUID(), plugin_generation: 1,
    });
    const original = captureRootConfigurationEvidence(sessionFile);
    fs.writeFileSync(sessionFile, 'a different session overwrote the same inode after validation');
    const fresh = captureRootConfigurationEvidence(sessionFile);
    assert.equal(fresh.file_identity, original.file_identity, 'The physical file remained in place');
    const request = { endpoint_id: root.endpoint_id, generation: root.generation, evidence: original };
    const rejected = await control.getRootConfiguration(root.root_token, request);
    assert.equal(rejected.root_authenticated, true);
    assert.equal(rejected.ownership, 'unknown');
    assert.equal(rejected.reason, 'EVIDENCE_INVALID');
    assert.equal(rejected.config_id, null);
    assert.equal(rejected.history, 'unknown');

    const current = await control.getRootConfiguration(root.root_token, { ...request, evidence: fresh });
    assert.equal(current.ownership, 'verified');
    assert.equal(current.reason, 'BOUND');
    assert.ok(current.config_id, 'Rejecting stale evidence did not reserve ownership for an unverified revision');
  } finally {
    control.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});
