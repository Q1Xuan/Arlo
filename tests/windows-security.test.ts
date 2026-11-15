import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ArloErrorCode } from '@arlo/sdk';
import {
  getCurrentUserSid,
  enforceWindowsAcl,
  verifyWindowsAcl,
  inspectWindowsAclBatch,
} from '../packages/daemon/src/security/index.ts';

import { createTempDir, removeTempDir, scratchDir } from './test-utils.ts';

test('getCurrentUserSid resolves the native current-user identity without environment-derived stand-ins', () => {
  const identity = getCurrentUserSid();
  assert.ok(identity, 'The current-user identity must not be empty');
  if (process.platform === 'win32') {
    assert.match(identity, /^S-1-[0-59]-\d+(?:-\d+)+$/, 'Windows must return a native SID');
  } else {
    assert.equal(identity, String(process.getuid!()), 'POSIX must return the kernel UID, not a fabricated SID');
  }
});

test('enforceWindowsAcl restricts access exclusively to current user SID and removes inheritance', () => {
  const testDir = createTempDir('sec-acl-dir');
  const testFile = path.join(testDir, 'secret.token');
  fs.writeFileSync(testFile, 'canary-token-content\n', 'utf8');

  try {
    enforceWindowsAcl(testDir, true);
    enforceWindowsAcl(testFile, false);

    const checkDir = verifyWindowsAcl(testDir);
    assert.equal(checkDir.valid, true, `Dir verification failed: ${checkDir.detail}`);

    const checkFile = verifyWindowsAcl(testFile);
    assert.equal(checkFile.valid, true, `File verification failed: ${checkFile.detail}`);

    if (process.platform === 'win32') {
      const inspected = inspectWindowsAclBatch([testDir, testFile]);
      const dirAcl = inspected[testDir];
      assert.ok(dirAcl, 'Dir ACL must be inspected');
      assert.equal(dirAcl.isReparse, false);

      const fileAcl = inspected[testFile];
      assert.ok(fileAcl, 'File ACL must be inspected');
      assert.equal(fileAcl.isReparse, false);

      const userSid = getCurrentUserSid();
      // Verify that no rules grant access to Everyone (S-1-1-0) or Users (S-1-5-32-545)
      for (const rule of [...dirAcl.rules, ...fileAcl.rules]) {
        assert.ok(!rule.startsWith('S-1-1-0:'), 'Must not grant access to Everyone');
        assert.ok(!rule.startsWith('S-1-5-32-545:'), 'Must not grant access to BUILTIN\\Users');
        assert.ok(!rule.startsWith('S-1-5-11:'), 'Must not grant access to Authenticated Users');
      }
    }
  } finally {
    removeTempDir(testDir);
  }
});

test('verifyWindowsAcl detects and rejects insecure permissions when granted to other users', () => {
  const testDir = createTempDir('sec-insecure');
  const testFile = path.join(testDir, 'exposed.token');
  fs.writeFileSync(testFile, 'exposed-content\n', 'utf8');

  try {
    enforceWindowsAcl(testFile, false);
    assert.equal(verifyWindowsAcl(testFile).valid, true);

    if (process.platform === 'win32') {
      // Intentionally grant access to Everyone (S-1-1-0)
      cp.execFileSync('icacls.exe', [testFile, '/grant', '*S-1-1-0:R'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      const result = verifyWindowsAcl(testFile);
      assert.equal(result.valid, false, 'Insecure file must be rejected');
      assert.equal(result.errorCode, ArloErrorCode.INSECURE_PERMISSIONS);
      assert.match(result.detail ?? '', /Forbidden group or public SID/);
    }
  } finally {
    removeTempDir(testDir);
  }
});

test('verifyWindowsAcl detects and rejects symbolic links and junctions (UNSAFE_LOCATION)', (t) => {
  const testDir = createTempDir('sec-symlink');
  try {
    const realFile = path.join(testDir, 'real.txt');
    let link = path.join(testDir, 'link.txt');
    fs.writeFileSync(realFile, 'canary');
    try {
      fs.symlinkSync(realFile, link, 'file');
    } catch {
      const realDir = path.join(testDir, 'real-sub');
      link = path.join(testDir, 'junction-sub');
      fs.mkdirSync(realDir);
      try { fs.symlinkSync(realDir, link, 'junction'); }
      catch { t.skip('This environment cannot create symbolic links or junctions'); return; }
    }
    assert.equal(verifyWindowsAcl(link).errorCode, ArloErrorCode.UNSAFE_LOCATION);
  } finally {
    removeTempDir(testDir);
  }
});

test('verifyWindowsAcl returns CORRUPTED_STATE for nonexistent targets', () => {
  const nonexistent = path.join(scratchDir, `nonexistent-${crypto.randomUUID()}`);
  const result = verifyWindowsAcl(nonexistent);
  assert.equal(result.valid, false);
  assert.equal(result.errorCode, ArloErrorCode.CORRUPTED_STATE);
});
