import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { windowsPowerShellEnv } from '@arlo/sdk';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const consoleFixture = path.join(root, 'tests/fixtures/windows-console.ps1');
const cliScript = path.join(root, 'packages/daemon/bin/arlo.js');

import { createTempDir, removeTempDir } from './test-utils.ts';

test('Real Windows processes execute serve, status, doctor, and graceful shutdown via CLI', { timeout: 60000, skip: process.platform !== 'win32' }, async () => {
  const stateDir = createTempDir('real-cli-proc');

  // A separate hidden console lets the test deliver a real Windows Ctrl+C.
  const serveProc = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', consoleFixture,
    '-Action', 'start', '-NodePath', process.execPath, '-CliPath', cliScript, '-StateDir', stateDir], {
    cwd: root, windowsHide: true, env: windowsPowerShellEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let servePid: number | undefined;
  const exited = new Promise<number | null>(resolve => serveProc.once('exit', resolve));
  const readOutput = (name: string) => fs.existsSync(path.join(stateDir, name)) ? fs.readFileSync(path.join(stateDir, name), 'utf8') : '';
  try {
    servePid = await new Promise<number>((resolve, reject) => {
      serveProc.stdout.once('data', chunk => resolve(Number(chunk.toString().trim())));
      serveProc.once('error', reject);
      serveProc.once('exit', () => reject(new Error('CLI launcher exited before startup')));
    });
    const deadline = Date.now() + 15000;
    while (!readOutput('cli.stdout').includes('Arlo Daemon started on https://127.0.0.1:')) {
      assert.ok(Date.now() < deadline && serveProc.exitCode === null, 'CLI failed to become ready');
      await delay(50);
    }
    assert.equal(readOutput('cli.stdout').includes('token'), false);

    // 2. Run real status CLI with --json
    const statusResult = cp.spawnSync(process.execPath, [cliScript, 'status', '--state-dir', stateDir, '--json'], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(statusResult.status, 0, `Status command failed: ${statusResult.stderr}`);
    const statusJson = JSON.parse(statusResult.stdout);
    assert.equal(statusJson.status, 'ready');
    assert.equal(statusJson.listener, 'loopback');
    assert.ok(statusJson.port > 0);
    assert.equal(statusJson.pid, servePid);

    // 3. Run real status CLI with human-readable output
    const statusTextResult = cp.spawnSync(process.execPath, [cliScript, 'status', '--state-dir', stateDir], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(statusTextResult.status, 0);
    assert.ok(statusTextResult.stdout.includes('Arlo Daemon Status:'));
    assert.ok(statusTextResult.stdout.includes('ready'));
    assert.ok(statusTextResult.stdout.includes('loopback'));

    // 4. Run real doctor CLI with --json
    const doctorResult = cp.spawnSync(process.execPath, [cliScript, 'doctor', '--state-dir', stateDir, '--json'], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(doctorResult.status, 0, `Doctor command failed: ${doctorResult.stderr}`);
    const doctorJson = JSON.parse(doctorResult.stdout);
    assert.equal(doctorJson.overall_status, 'healthy');
    assert.ok(doctorJson.checks.length >= 6);
    for (const c of doctorJson.checks) {
      assert.equal(c.status, 'pass', `Doctor check ${c.name} must pass`);
    }

    // 5. Run real doctor CLI with human-readable output
    const doctorTextResult = cp.spawnSync(process.execPath, [cliScript, 'doctor', '--state-dir', stateDir], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(doctorTextResult.status, 0);
    assert.ok(doctorTextResult.stdout.includes('Arlo Doctor Diagnostic Report:'));
    assert.ok(doctorTextResult.stdout.includes('HEALTHY'));
    assert.ok(doctorTextResult.stdout.includes('[PASS] state_directory_acl'));
    assert.ok(doctorTextResult.stdout.includes('[PASS] discovery_record_acl'));
    const signal = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', consoleFixture,
      '-Action', 'interrupt', '-TargetPid', String(servePid)], {
      windowsHide: true, env: windowsPowerShellEnv(), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(signal.status, 0, 'Real Ctrl+C delivery must succeed');
    const exitCode = await Promise.race([exited, delay(5000, 'timeout', { ref: false })]);
    assert.equal(exitCode, 0, 'Daemon must exit cleanly after Ctrl+C');
    assert.ok(readOutput('cli.stdout').includes('Shutting down Arlo Daemon'));
    assert.ok(readOutput('daemon.log').includes('DAEMON_STOPPED'));
    for (const name of ['daemon.lock', 'discovery.json', 'bootstrap.token']) {
      assert.equal(fs.existsSync(path.join(stateDir, name)), false, `${name} must be removed before exit`);
    }
  } finally {
    if (serveProc.exitCode === null && servePid) {
      try { process.kill(servePid); } catch {}
      await Promise.race([exited, delay(3000, undefined, { ref: false })]);
      serveProc.kill();
    }
    removeTempDir(stateDir);
  }
});

test('CLI status reports DAEMON_NOT_RUNNING when no daemon is active', () => {
  const emptyStateDir = createTempDir('cli-empty-state');

  try {
    const result = cp.spawnSync(process.execPath, [cliScript, 'status', '--state-dir', emptyStateDir, '--json'], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(result.status, 1);
    const errJson = JSON.parse(result.stderr);
    assert.equal(errJson.error, 'DAEMON_NOT_RUNNING');
  } finally {
    removeTempDir(emptyStateDir);
  }
});
