import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { ArloDaemon } from '@arlo/daemon';
import { DaemonClient } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('An authorized temporary Windows user cannot read or change real Daemon private state', {
  skip: process.platform !== 'win32' ? 'Requires native Windows SID ACLs'
    : process.env.ARLO_ALLOW_TEMPORARY_USER !== '1' ? 'Requires explicit authorization to create and remove an isolated temporary Windows user' : false,
  timeout: 90000,
}, async t => {
  const stateDir = createTempDir('cross-user-state');
  const daemon = new ArloDaemon({ stateDir });
  const script = fileURLToPath(new URL('./fixtures/windows-cross-user.ps1', import.meta.url));
  const options = {
    windowsHide: true, encoding: 'utf8' as const, timeout: 60000,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ARLO_ALLOW_TEMPORARY_USER: '1',
      HOME: stateDir, USERPROFILE: stateDir, APPDATA: stateDir, LOCALAPPDATA: stateDir,
      TEMP: stateDir, TMP: stateDir, PSExecutionPolicyPreference: 'Bypass' },
  };
  try {
    const started = await daemon.start();
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-StateDirectory', stateDir], options);
    assert.equal(result.status, 0, result.stderr);
    const proof = JSON.parse(result.stdout.trim());
    assert.notEqual(proof.testSid, proof.ownerSid);
    assert.equal(proof.positiveControl, true);
    assert.equal(proof.accountRemoved, true);
    assert.equal(proof.createDenied, true);
    assert.equal(proof.attempts.length, 6);
    assert.ok(proof.attempts.every((entry: { accessDenied: boolean; bytesRead: number }) => entry.accessDenied && entry.bytesRead === 0));
    assert.equal((await new DaemonClient({ stateDir }).getStatus()).daemon_id, started.daemonId);
    if (process.env.ARLO_ACCEPTANCE_EVIDENCE_DIR) {
      fs.writeFileSync(path.join(process.env.ARLO_ACCEPTANCE_EVIDENCE_DIR, 'cross-user.json'), JSON.stringify(proof));
    }
    t.diagnostic(JSON.stringify(proof));
  } finally {
    await daemon.stop();
    const cleanup = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-StateDirectory', stateDir, '-Cleanup'], options);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    removeTempDir(stateDir);
  }
});
