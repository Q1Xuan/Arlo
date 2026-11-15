import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DaemonClient, enforceWindowsAcl, getCurrentUserSid, windowsPowerShellEnv } from '@arlo/sdk';
import { ArloDaemon } from '../packages/daemon/src/server/index.ts';
import { AuditLogger, LogEventCode, MAX_LOG_RETENTION_MS } from '../packages/daemon/src/logging/index.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

const cli = fileURLToPath(new URL('../packages/daemon/bin/arlo.js', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32' };

test('Concurrent Daemon processes publish exactly one winning instance', { ...windowsOnly, timeout: 60000 }, async () => {
  const stateDir = createTempDir('real-start-race');
  const children: cp.ChildProcess[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      const child = cp.spawn(process.execPath, [fileURLToPath(new URL('./fixtures/daemon-worker.ts', import.meta.url))], {
        windowsHide: true, env: { ...process.env, ARLO_STATE_DIR: stateDir }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      children.push(child);
      await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); });
    }
    const results = await Promise.all(children.map(child => new Promise<{ ok: boolean; daemonId?: string }>(resolve => {
      child.once('message', resolve);
      child.send('start');
    })));
    assert.equal(results.filter(result => result.ok).length, 1);
    const winner = results.find(result => result.ok)!;
    assert.equal((await new DaemonClient({ stateDir }).getStatus()).daemon_id, winner.daemonId);
    const discovery = fs.readFileSync(path.join(stateDir, 'discovery.json'), 'utf8');
    for (let i = 0; i < children.length; i++) if (!results[i].ok) {
      await new Promise<void>(resolve => { children[i].once('exit', () => resolve()); children[i].send('stop'); });
    }
    assert.equal(fs.readFileSync(path.join(stateDir, 'discovery.json'), 'utf8'), discovery);
    const winnerChild = children[results.findIndex(result => result.ok)];
    await new Promise<void>(resolve => { winnerChild.once('exit', () => resolve()); winnerChild.send('stop'); });
    for (const name of ['daemon.lock', 'discovery.json', 'bootstrap.token']) assert.equal(fs.existsSync(path.join(stateDir, name)), false);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); });
    }
    removeTempDir(stateDir);
  }
});

test('Daemon reclaims an abruptly exited process without retaining its OS mutex', { ...windowsOnly, timeout: 30000 }, async () => {
  const stateDir = createTempDir('crash-recovery');
  const child = cp.spawn(process.execPath, [fileURLToPath(new URL('./fixtures/daemon-worker.ts', import.meta.url))], {
    windowsHide: true, env: { ...process.env, ARLO_STATE_DIR: stateDir }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let replacement: ArloDaemon | undefined;
  try {
    await new Promise(resolve => child.once('message', resolve));
    const first = await new Promise<{ ok: boolean; daemonId: string }>(resolve => { child.once('message', resolve); child.send('start'); });
    assert.equal(first.ok, true);
    await new Promise(resolve => { child.once('exit', resolve); child.send('crash'); });
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), true);
    const deadline = Date.now() + 5000;
    while (true) {
      replacement = new ArloDaemon({ stateDir });
      try { await replacement.start(); break; }
      catch (error) {
        if ((error as { code?: string }).code !== 'DAEMON_ALREADY_RUNNING' || Date.now() > deadline) throw error;
        await delay(50);
      }
    }
    assert.notEqual((await new DaemonClient({ stateDir }).getStatus()).daemon_id, first.daemonId);
  } finally {
    await replacement?.stop();
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    removeTempDir(stateDir);
  }
});

test('Daemon refuses an exposed Bootstrap Credential before replacing its contents', windowsOnly, async () => {
  const stateDir = createTempDir('exposed-bootstrap');
  const tokenPath = path.join(stateDir, 'bootstrap.token');
  const daemon = new ArloDaemon({ stateDir });
  fs.writeFileSync(tokenPath, 'unchanged-canary');
  enforceWindowsAcl(tokenPath, false);
  cp.execFileSync('icacls.exe', [tokenPath, '/grant', '*S-1-1-0:R'], { windowsHide: true, stdio: 'ignore' });
  try {
    await assert.rejects(daemon.start(), { code: 'INSECURE_PERMISSIONS' });
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), 'unchanged-canary');
    assert.equal(fs.existsSync(path.join(stateDir, 'discovery.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false, 'Failed startup must release its lock');
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('SDK refuses a directory whose ancestor allows other users to replace children', windowsOnly, async () => {
  const root = createTempDir('replaceable-ancestor');
  const stateDir = path.join(root, 'state');
  const daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    cp.execFileSync('icacls.exe', [root, '/grant', '*S-1-1-0:(DC)'], { windowsHide: true, stdio: 'ignore' });
    await assert.rejects(new DaemonClient({ stateDir }).getStatus(), { code: 'UNSAFE_LOCATION' });
  } finally {
    cp.execFileSync('icacls.exe', [root, '/remove:g', '*S-1-1-0'], { windowsHide: true, stdio: 'ignore' });
    await daemon.stop();
    removeTempDir(root);
  }
});

test('SDK rejects a junction anywhere in the Discovery Record directory path', windowsOnly, async () => {
  const root = createTempDir('discovery-junction');
  const real = path.join(root, 'real');
  const link = path.join(root, 'link');
  const stateDir = path.join(real, 'state');
  const daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    fs.symlinkSync(real, link, 'junction');
    await assert.rejects(new DaemonClient({ stateDir: path.join(link, 'state') }).getStatus(), { code: 'UNSAFE_LOCATION' });
  } finally {
    await daemon.stop();
    if (fs.existsSync(link)) fs.unlinkSync(link);
    removeTempDir(root);
  }
});

test('Diagnostic Report fails when the current user cannot read the TLS private key', windowsOnly, async () => {
  const stateDir = createTempDir('doctor-denied-read');
  const daemon = new ArloDaemon({ stateDir });
  const keyPath = path.join(stateDir, 'daemon.key');
  try {
    await daemon.start();
    cp.execFileSync('icacls.exe', [keyPath, '/deny', `*${getCurrentUserSid()}:(RD)`], { windowsHide: true, stdio: 'ignore' });
    // Node can use enabled backup privileges to bypass a Deny-read ACE. Check
    // ordinary Windows access instead, without reading the private key bytes.
    const readProbe = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `try { $f = [System.IO.File]::OpenRead('${keyPath.replaceAll("'", "''")}'); $f.Dispose(); exit 0 } catch { exit 1 }`,
    ], { windowsHide: true, env: windowsPowerShellEnv() });
    assert.equal(readProbe.status, 1, 'Normal file access must be denied by the fixture ACL');
    const report = await new DaemonClient({ stateDir }).getDoctor();
    assert.equal(report.overall_status, 'failing');
    assert.equal(report.checks.find(c => c.name === 'tls_credentials_acl')?.status, 'fail');
  } finally {
    if (fs.existsSync(keyPath)) cp.execFileSync('icacls.exe', [keyPath, '/remove:d', `*${getCurrentUserSid()}`], { windowsHide: true, stdio: 'ignore' });
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('CLI reports fixed JSON errors without private paths for invalid state locations', () => {
  const root = createTempDir('cli-safe-errors');
  const invalidState = path.join(root, 'PRIVATE_PATH_CANARY');
  fs.writeFileSync(invalidState, 'canary');
  try {
    const result = cp.spawnSync(process.execPath, [cli, 'serve', '--state-dir', invalidState, '--json'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes(invalidState), false);
    assert.deepEqual(JSON.parse(result.stderr), { error: 'UNSAFE_LOCATION' });
  } finally {
    enforceWindowsAcl(invalidState, false);
    removeTempDir(root);
  }
});

test('Audit Log expires old entries even while recent writes keep its mtime fresh', () => {
  const root = createTempDir('log-entry-retention');
  const logPath = path.join(root, 'daemon.log');
  const old = new Date(Date.now() - MAX_LOG_RETENTION_MS - 86400000).toISOString();
  fs.writeFileSync(logPath, JSON.stringify({ time: old, event: 'DAEMON_STARTED' }) + '\n', { mode: 0o600 });
  fs.appendFileSync(logPath, JSON.stringify({ time: new Date().toISOString(), event: 'REQUEST_SERVED' }) + '\n');
  try {
    new AuditLogger(root, 'retention-daemon').log({ event: LogEventCode.REQUEST_SERVED, status: 'ok' });
    for (const name of ['daemon.log', 'daemon.1.log', 'daemon.2.log']) {
      const file = path.join(root, name);
      if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, 'utf8').includes(old), false);
    }
  } finally {
    removeTempDir(root);
  }
});

test('Corrupted Discovery Record certificates produce a fixed SDK and CLI error', async () => {
  const stateDir = createTempDir('corrupt-discovery-cert');
  const daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    const file = path.join(stateDir, 'discovery.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.cert_pem = 'PRIVATE_CERT_CANARY';
    fs.writeFileSync(file, JSON.stringify(record));
    await assert.rejects(new DaemonClient({ stateDir }).getStatus(), { code: 'CORRUPTED_STATE' });
    const result = cp.spawnSync(process.execPath, [cli, 'status', '--state-dir', stateDir, '--json'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), { error: 'CORRUPTED_STATE' });
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('Audit Log retention expires during an idle Daemon without another write', (t) => {
  const root = createTempDir('idle-log-retention');
  const logger = new AuditLogger(root, 'idle-daemon');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  try {
    logger.log({ event: LogEventCode.DAEMON_STARTED, status: 'ok' });
    assert.equal(fs.existsSync(path.join(root, 'daemon.log')), true);
    t.mock.timers.tick(MAX_LOG_RETENTION_MS);
    assert.equal(fs.existsSync(path.join(root, 'daemon.log')), false);
  } finally {
    logger.close();
    t.mock.timers.reset();
    removeTempDir(root);
  }
});
