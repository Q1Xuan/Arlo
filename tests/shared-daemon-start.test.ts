import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { ControlClient, ArloErrorCode, getCurrentUserSid, readDiscoveryRecord } from '@arlo/sdk';
import { writePrivateStateFile } from '@arlo/daemon/storage';
import { ensureSharedDaemon } from '@arlo/daemon/shared';
import { ArloDaemon } from '@arlo/daemon/server';
import { IMPOSTER_CERT, IMPOSTER_KEY } from '../probes/tls-fixtures.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

const exec = promisify(execFile);
const starter = fileURLToPath(new URL('./fixtures/shared-starter.ts', import.meta.url));

test('independent callers converge on one authenticated daemon which survives caller exit', { timeout: 150000 }, async () => {
  const stateDir = createTempDir('shared-start');
  // Each caller pays its own PowerShell inspector boot; one logical processor
  // serializes those with the daemon start and can exceed the 30s default
  // budget (observed 32.6s), so scale only there and keep CI on the default.
  const starterArgs = os.cpus().length === 1 ? [starter, stateDir, '90000'] : [starter, stateDir];
  let pid: number | undefined;
  try {
    const callers = await Promise.all([0, 1, 2].map(() => exec(process.execPath, starterArgs, { windowsHide: true })));
    const ids = callers.map(result => JSON.parse(result.stdout).daemonId);
    assert.equal(new Set(ids).size, 1);
    const discovery = readDiscoveryRecord(stateDir);
    pid = discovery.pid;
    assert.notEqual(pid, process.pid);
    const client = new ControlClient({ stateDir });
    try { assert.equal(await client.refreshConnection(), ids[0]); }
    finally { client.dispose(); }
  } finally {
    if (pid) { try { process.kill(pid); } catch {} }
    await delay(500);
    removeTempDir(stateDir);
  }
});

test('corrupt discovery fails closed without replacing protected state', async () => {
  const stateDir = createTempDir('shared-corrupt');
  try {
    writePrivateStateFile(stateDir, 'discovery.json', '{broken');
    await assert.rejects(ensureSharedDaemon({ stateDir }), { code: ArloErrorCode.CORRUPTED_STATE });
    assert.equal(fs.readFileSync(path.join(stateDir, 'discovery.json'), 'utf8'), '{broken');
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false);
  } finally { removeTempDir(stateDir); }
});

test('an already cancelled caller never starts a shared daemon', async () => {
  const stateDir = createTempDir('shared-cancel');
  try {
    await assert.rejects(ensureSharedDaemon({ stateDir, signal: AbortSignal.abort() }), {
      code: ArloErrorCode.CONNECTION_FAILED,
    });
    assert.equal(fs.existsSync(path.join(stateDir, 'discovery.json')), false);
  } finally { removeTempDir(stateDir); }
});

test('a crashed shared daemon is replaced through OS ownership', { timeout: 60000 }, async () => {
  const stateDir = createTempDir('shared-restart');
  let pid: number | undefined;
  try {
    const before = await ensureSharedDaemon({ stateDir, idleTimeoutMs: 10000 });
    pid = readDiscoveryRecord(stateDir).pid;
    process.kill(pid, 'SIGKILL');
    await delay(1000);
    const after = await ensureSharedDaemon({ stateDir, idleTimeoutMs: 10000 });
    pid = readDiscoveryRecord(stateDir).pid;
    assert.notEqual(after, before);
  } finally {
    if (pid) { try { process.kill(pid); } catch {} }
    await delay(500);
    removeTempDir(stateDir);
  }
});

test('Windows live PID lock residue fails closed instead of stealing ownership', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async () => {
  const stateDir = createTempDir('shared-live-pid');
  try {
    const lock = JSON.stringify({ pid: process.pid, daemon_id: 'unrelated-instance',
      created_at: new Date().toISOString(), owner_sid: getCurrentUserSid() });
    writePrivateStateFile(stateDir, 'daemon.lock', lock);
    await assert.rejects(ensureSharedDaemon({ stateDir }), { code: ArloErrorCode.LOCK_ACQUISITION_FAILED });
    assert.equal(fs.readFileSync(path.join(stateDir, 'daemon.lock'), 'utf8'), lock);
  } finally { removeTempDir(stateDir); }
});

test('a port takeover fails TLS before receiving bootstrap credentials and does not start a replacement', { timeout: 45000 }, async () => {
  const stateDir = createTempDir('shared-imposter');
  const daemon = new ArloDaemon({ stateDir });
  let requests = 0;
  const imposter = https.createServer({ key: IMPOSTER_KEY, cert: IMPOSTER_CERT }, (_req, res) => {
    requests++;
    res.end('{}');
  });
  try {
    await daemon.start();
    const discovery = readDiscoveryRecord(stateDir);
    await daemon.stop();
    await new Promise<void>(resolve => imposter.listen(discovery.port, '127.0.0.1', resolve));
    writePrivateStateFile(stateDir, 'discovery.json', JSON.stringify(discovery));
    writePrivateStateFile(stateDir, 'bootstrap.token', 'a'.repeat(64));
    await assert.rejects(ensureSharedDaemon({ stateDir }), { code: ArloErrorCode.PINNED_CERT_MISMATCH });
    assert.equal(requests, 0);
    assert.equal(readDiscoveryRecord(stateDir).daemon_id, discovery.daemon_id);
  } finally {
    imposter.closeAllConnections();
    await new Promise<void>(resolve => imposter.close(() => resolve()));
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('a non-regular credential file prevents reuse of an authenticated daemon', { timeout: 45000 }, async () => {
  const stateDir = createTempDir('shared-unsafe-key');
  const daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    const keyPath = path.join(stateDir, 'daemon.key');
    fs.unlinkSync(keyPath);
    fs.mkdirSync(keyPath, { mode: 0o700 });
    await assert.rejects(ensureSharedDaemon({ stateDir }), { code: ArloErrorCode.UNSAFE_LOCATION });
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('a startup owner crashing before discovery does not strand another caller', { timeout: 60000 }, async () => {
  const stateDir = createTempDir('shared-startup-crash');
  const owner = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/shared-startup-owner.ts', import.meta.url)), stateDir], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let pid: number | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      owner.once('message', () => resolve());
      owner.once('error', reject);
      owner.once('exit', () => reject(new Error('Startup fixture exited before locking')));
    });
    assert.equal(fs.existsSync(path.join(stateDir, 'discovery.json')), false);
    const starting = ensureSharedDaemon({ stateDir, idleTimeoutMs: 10000 });
    await delay(2000);
    owner.kill('SIGKILL');
    const daemonId = await starting;
    const discovery = readDiscoveryRecord(stateDir);
    pid = discovery.pid;
    assert.equal(discovery.daemon_id, daemonId);
    assert.notEqual(pid, owner.pid);
  } finally {
    owner.kill();
    if (pid) { try { process.kill(pid); } catch {} }
    await delay(500);
    removeTempDir(stateDir);
  }
});

test('a first caller creates a missing private state directory', { timeout: 45000 }, async () => {
  const parent = createTempDir('shared-missing');
  const stateDir = path.join(parent, 'new-state');
  let pid: number | undefined;
  try {
    const daemonId = await ensureSharedDaemon({ stateDir, idleTimeoutMs: 10000 });
    const discovery = readDiscoveryRecord(stateDir);
    pid = discovery.pid;
    assert.equal(discovery.daemon_id, daemonId);
  } finally {
    if (pid) { try { process.kill(pid); } catch {} }
    await delay(500);
    removeTempDir(parent);
  }
});

test('Linux automatic startup keeps runtime credentials and persistent audit storage separate', {
  skip: process.platform !== 'linux', timeout: 45000,
}, async () => {
  const parent = createTempDir('shared-xdg');
  const runtime = path.join(parent, 'runtime');
  const state = path.join(parent, 'state');
  fs.mkdirSync(runtime, { mode: 0o700 });
  fs.mkdirSync(state, { mode: 0o700 });
  const runtimeDir = path.join(runtime, 'Arlo');
  const auditDir = path.join(state, 'Arlo');
  let pid: number | undefined;
  try {
    // No explicit stateDir or inherited ARLO_STATE_DIR: exercise the same
    // defaults as an automatically starting host in a fresh Linux login.
    const result = await exec(process.execPath, [starter], {
      env: { PATH: '/usr/bin:/bin', HOME: parent, LANG: 'C.UTF-8',
        XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: state },
    });
    const discovery = readDiscoveryRecord(runtimeDir);
    pid = discovery.pid;
    assert.equal(discovery.daemon_id, JSON.parse(result.stdout).daemonId);
    assert.ok(fs.existsSync(path.join(auditDir, 'daemon.log')));
    assert.equal(fs.existsSync(path.join(runtimeDir, 'daemon.log')), false);
    for (const name of ['daemon.key', 'bootstrap.token', 'discovery.json']) {
      assert.ok(fs.existsSync(path.join(runtimeDir, name)));
      assert.equal(fs.existsSync(path.join(auditDir, name)), false);
    }
    assert.ok(fs.existsSync(path.join(auditDir, 'coordination.lock')));
    await assert.rejects(exec('/usr/bin/flock', [
      '--exclusive', '--nonblock', path.join(auditDir, 'coordination.lock'), '/usr/bin/true',
    ]), { code: 1 });
  } finally {
    if (pid) { try { process.kill(pid); } catch {} }
    await delay(500);
    removeTempDir(parent);
  }
});
