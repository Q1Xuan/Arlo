import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AuditLogger,
  LogEventCode,
  MAX_LOG_FILE_SIZE,
  MAX_LOG_FILES,
} from '../packages/daemon/src/logging/index.ts';
import { verifyWindowsAcl } from '../packages/daemon/src/security/index.ts';

import { createTempDir, removeTempDir } from './test-utils.ts';

test('AuditLogger writes strictly compliant JSON lines with allowed fields only', () => {
  const stateDir = createTempDir('log-schema');
  const daemonId = 'test-daemon-uuid-1234';
  const logger = new AuditLogger(stateDir, daemonId);

  try {
    logger.log({
      event: LogEventCode.DAEMON_STARTED,
      status: 'ok',
      bytes: 1024,
      duration_ms: 12.5,
    });

    logger.log({
      event: LogEventCode.AUTH_FAILURE,
      status: 'rejected',
      request_id: 'req-uuid-999',
    });

    const logPath = path.join(stateDir, 'daemon.log');
    assert.ok(fs.existsSync(logPath));

    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);

    const allowedKeys = new Set(['time', 'event', 'daemon_id', 'request_id', 'status', 'bytes', 'duration_ms']);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.time, 'Time must be present');
      assert.ok(parsed.event, 'Event must be present');
      assert.equal(parsed.daemon_id, daemonId);
      assert.ok(parsed.status, 'Status must be present');
      assert.equal(typeof parsed.bytes, 'number');
      assert.equal(typeof parsed.duration_ms, 'number');

      for (const key of Object.keys(parsed)) {
        assert.ok(allowedKeys.has(key), `Key '${key}' is forbidden in audit log`);
      }
    }

    // Verify ACL on log file
    const aclCheck = verifyWindowsAcl(logPath);
    assert.equal(aclCheck.valid, true);
  } finally {
    removeTempDir(stateDir);
  }
});

test('AuditLogger rotates files when reaching 10 MiB and retains at most 3 files', () => {
  const stateDir = createTempDir('log-rotation');
  const daemonId = 'rotation-daemon-id';
  const logger = new AuditLogger(stateDir, daemonId);

  try {
    const logPath = path.join(stateDir, 'daemon.log');
    const log1 = path.join(stateDir, 'daemon.1.log');
    const log2 = path.join(stateDir, 'daemon.2.log');

    // Simulate a file close to 10 MiB limit
    fs.writeFileSync(logPath, Buffer.alloc(MAX_LOG_FILE_SIZE - 50, 'a'), { mode: 0o600 });

    // Writing next entry triggers rotation: daemon.log -> daemon.1.log
    logger.log({
      event: LogEventCode.REQUEST_SERVED,
      status: 'ok',
      bytes: 100,
    });

    assert.ok(fs.existsSync(log1), 'daemon.1.log must exist after first rotation');
    assert.ok(fs.existsSync(logPath), 'new daemon.log must exist');

    // Fill daemon.log again and trigger second rotation
    fs.writeFileSync(logPath, Buffer.alloc(MAX_LOG_FILE_SIZE - 50, 'b'));
    logger.log({
      event: LogEventCode.REQUEST_SERVED,
      status: 'ok',
      bytes: 100,
    });

    assert.ok(fs.existsSync(log2), 'daemon.2.log must exist after second rotation');
    assert.ok(fs.existsSync(log1), 'daemon.1.log must exist');
    assert.ok(fs.existsSync(logPath), 'daemon.log must exist');

    // Fill daemon.log again and trigger third rotation (daemon.2.log is removed and replaced)
    fs.writeFileSync(logPath, Buffer.alloc(MAX_LOG_FILE_SIZE - 50, 'c'));
    logger.log({
      event: LogEventCode.REQUEST_SERVED,
      status: 'ok',
      bytes: 100,
    });

    // Check that there are at most 3 log files and no daemon.3.log
    assert.ok(!fs.existsSync(path.join(stateDir, 'daemon.3.log')), 'Must never create daemon.3.log');
    assert.ok(fs.existsSync(logPath));
    assert.ok(fs.existsSync(log1));
    assert.ok(fs.existsSync(log2));
  } finally {
    removeTempDir(stateDir);
  }
});

test('AuditLogger removes log files older than 7 days during cleanup', () => {
  const stateDir = createTempDir('log-retention');
  const daemonId = 'retention-daemon-id';
  const logger = new AuditLogger(stateDir, daemonId);

  try {
    const log2 = path.join(stateDir, 'daemon.2.log');
    fs.writeFileSync(log2, 'old log content\n', { mode: 0o600 });

    // Set mtime to 8 days ago
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(log2, eightDaysAgo, eightDaysAgo);

    logger.cleanOldLogs();

    assert.ok(!fs.existsSync(log2), 'Log file older than 7 days must be pruned');
  } finally {
    removeTempDir(stateDir);
  }
});
