import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ArloErrorCode, ArloError } from '@arlo/sdk';
import { ArloDaemon } from '../packages/daemon/src/server/index.ts';
import {
  acquireDaemonLock,
  cleanInstanceResources,
  isProcessAlive,
} from '../packages/daemon/src/storage/index.ts';
import { verifyWindowsAcl, getCurrentUserSid, enforceWindowsAcl } from '../packages/daemon/src/security/index.ts';

import { createTempDir, removeTempDir } from './test-utils.ts';

test('ArloDaemon starts on loopback, publishes atomic discovery record, and sets secure ACLs', async () => {
  const stateDir = createTempDir('daemon-serve');
  const daemon = new ArloDaemon({ stateDir, port: 0 });

  try {
    const { port, daemonId } = await daemon.start();
    assert.ok(port > 0, 'Port must be assigned');
    assert.ok(daemonId, 'Daemon ID must be generated');

    // Verify discovery.json
    const discPath = path.join(stateDir, 'discovery.json');
    assert.ok(fs.existsSync(discPath), 'discovery.json must exist');
    const disc = JSON.parse(fs.readFileSync(discPath, 'utf8'));
    assert.equal(disc.daemon_id, daemonId);
    assert.equal(disc.port, port);
    assert.equal(disc.pid, process.pid);
    assert.equal(disc.status, 'ready');
    assert.ok(disc.cert_fingerprint, 'Cert fingerprint must be present');
    assert.ok(disc.cert_pem, 'Cert PEM must be present');

    // Verify daemon.lock
    const lockPath = path.join(stateDir, 'daemon.lock');
    assert.ok(fs.existsSync(lockPath), 'daemon.lock must exist');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lock.daemon_id, daemonId);
    assert.equal(lock.pid, process.pid);

    // Verify bootstrap.token
    const tokenPath = path.join(stateDir, 'bootstrap.token');
    assert.ok(fs.existsSync(tokenPath), 'bootstrap.token must exist');
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    assert.ok(token.length >= 32, 'Bootstrap token must have high entropy');

    // Verify ACL on all created resources
    assert.equal(verifyWindowsAcl(stateDir).valid, true, 'State dir ACL must be valid');
    assert.equal(verifyWindowsAcl(discPath).valid, true, 'Discovery record ACL must be valid');
    assert.equal(verifyWindowsAcl(lockPath).valid, true, 'Lock file ACL must be valid');
    assert.equal(verifyWindowsAcl(tokenPath).valid, true, 'Bootstrap token ACL must be valid');
    assert.equal(verifyWindowsAcl(path.join(stateDir, 'daemon.crt')).valid, true, 'Cert ACL must be valid');
    assert.equal(verifyWindowsAcl(path.join(stateDir, 'daemon.key')).valid, true, 'Key ACL must be valid');
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('Concurrent startup coordination prevents loser from overwriting active winning instance', async () => {
  const stateDir = createTempDir('daemon-concurrent');
  const winner = new ArloDaemon({ stateDir, port: 0 });

  try {
    const { port: winnerPort, daemonId: winnerId } = await winner.start();

    // Attempt to start a second daemon in the same state directory
    const loser = new ArloDaemon({ stateDir, port: 0 });
    let errorCaught: any = null;

    try {
      await loser.start();
    } catch (err) {
      errorCaught = err;
    }

    assert.ok(errorCaught, 'Second daemon must fail to start');
    assert.ok(errorCaught instanceof ArloError);
    assert.equal(errorCaught.code, ArloErrorCode.DAEMON_ALREADY_RUNNING);

    // Verify winner was NOT overwritten
    const disc = JSON.parse(fs.readFileSync(path.join(stateDir, 'discovery.json'), 'utf8'));
    assert.equal(disc.daemon_id, winnerId, 'Discovery record must still belong to winner');
    assert.equal(disc.port, winnerPort, 'Port must still belong to winner');

    const lock = JSON.parse(fs.readFileSync(path.join(stateDir, 'daemon.lock'), 'utf8'));
    assert.equal(lock.daemon_id, winnerId, 'Lock must still belong to winner');
  } finally {
    await winner.stop();
    removeTempDir(stateDir);
  }
});

test('Lock acquisition handles dead PID gracefully and refuses to kill active foreign processes', async () => {
  const stateDir = createTempDir('daemon-lock-proc');

  try {
    // 1. Dead PID recovery: PID 99999999 is dead
    const deadPid = 99999999;
    assert.equal(isProcessAlive(deadPid), false);

    const staleLockPath = path.join(stateDir, 'daemon.lock');
    fs.writeFileSync(
      staleLockPath,
      JSON.stringify({
        pid: deadPid,
        daemon_id: 'dead-daemon-uuid',
        created_at: new Date(Date.now() - 3600000).toISOString(),
        owner_sid: getCurrentUserSid(),
      }),
      'utf8'
    );
    enforceWindowsAcl(staleLockPath, false);

    // Should succeed in acquiring lock because dead PID is cleaned up
    const newDaemonId = 'new-daemon-uuid';
    const release = await acquireDaemonLock(stateDir, newDaemonId, process.pid);

    const lock = JSON.parse(fs.readFileSync(staleLockPath, 'utf8'));
    assert.equal(lock.daemon_id, newDaemonId);
    assert.equal(lock.pid, process.pid);
    await release();

    // 2. Active foreign PID: current process or explorer/system process
    // Overwrite lock with active PID but different daemon ID and no discovery record
    const dummyDaemonId = 'foreign-active-id';
    fs.writeFileSync(
      staleLockPath,
      JSON.stringify({
        pid: process.ppid || process.pid,
        daemon_id: dummyDaemonId,
        created_at: new Date().toISOString(),
        owner_sid: getCurrentUserSid(),
      }),
      'utf8'
    );
    enforceWindowsAcl(staleLockPath, false);

    if (process.platform === 'linux') {
      // The kernel lock is free: an unrelated live PID is not ownership evidence.
      const release = await acquireDaemonLock(stateDir, 'third-daemon-id', process.pid);
      try {
        assert.equal(JSON.parse(fs.readFileSync(staleLockPath, 'utf8')).daemon_id, 'third-daemon-id');
        assert.equal(isProcessAlive(process.ppid || process.pid), true);
      } finally { await release(); }
      return;
    }

    // Windows retains the conservative active-PID check in addition to its mutex.
    let error: any = null;
    try {
      await acquireDaemonLock(stateDir, 'third-daemon-id', 12345678);
    } catch (e) {
      error = e;
    }

    assert.ok(error instanceof ArloError);
    assert.equal(error.code, ArloErrorCode.LOCK_ACQUISITION_FAILED);
    // Verify foreign process is still alive!
    assert.equal(isProcessAlive(process.ppid || process.pid), true);
  } finally {
    removeTempDir(stateDir);
  }
});

test('cleanInstanceResources only removes resources owned by the specified daemon_id', () => {
  const stateDir = createTempDir('daemon-clean-scope');

  try {
    const lockPath = path.join(stateDir, 'daemon.lock');
    const discPath = path.join(stateDir, 'discovery.json');
    const tokenPath = path.join(stateDir, 'bootstrap.token');

    fs.writeFileSync(lockPath, JSON.stringify({ daemon_id: 'winner-id', pid: 100 }), { mode: 0o600 });
    fs.writeFileSync(discPath, JSON.stringify({ daemon_id: 'winner-id', port: 1234 }), { mode: 0o600 });
    fs.writeFileSync(tokenPath, 'winner-token', { mode: 0o600 });

    // Calling clean with a different daemon ID must NOT delete winner's files
    cleanInstanceResources(stateDir, 'imposter-loser-id');
    assert.ok(fs.existsSync(lockPath), 'Winner lock must not be deleted');
    assert.ok(fs.existsSync(discPath), 'Winner discovery must not be deleted');

    // Calling clean with matching daemon ID removes them
    cleanInstanceResources(stateDir, 'winner-id');
    assert.ok(!fs.existsSync(lockPath), 'Owned lock must be deleted');
    assert.ok(!fs.existsSync(discPath), 'Owned discovery must be deleted');
    assert.ok(!fs.existsSync(tokenPath), 'Owned bootstrap token must be deleted');
  } finally {
    removeTempDir(stateDir);
  }
});
