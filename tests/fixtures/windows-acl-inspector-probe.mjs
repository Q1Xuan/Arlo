import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

// The subprocess keeps the suite's permission preload even when emulating
// Windows on another OS. Mocks never start an executable or alter permissions.
assert.match(process.env.NODE_OPTIONS ?? '', /permission-preload\.mjs/);
const target = process.env.ARLO_ACL_PROBE_TARGET;
assert.ok(target);
const source = process.env.ARLO_ACL_SOURCE_URL ?? new URL('../../packages/sdk/src/security/index.ts', import.meta.url).href;
const { inspectWindowsAclBatch } = await import(source);
const mode = process.env.ARLO_ACL_PROBE_MODE;
const fakeFd = 654321;
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalWrite = fs.writeSync;
const originalClose = fs.closeSync;
const inspection = { owner: 'S-1-5-21-1-2-3-1001', rules: [], isReparse: false, canRead: true };

cp.spawn = () => {
  const child = Object.assign(new EventEmitter(), {
    pid: mode === 'spawn-error' ? undefined : 123456789,
    exitCode: null, killed: false,
    unref() {},
    kill() { this.killed = true; },
  });
  if (mode === 'spawn-error') {
    process.nextTick(() => child.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })));
  }
  return child;
};

if (mode === 'spawn-error') {
  // Do not spend the inspector's native 30-second deadline proving a missing
  // executable. The error event still occurs only after inspection returns.
  let ticks = 0;
  Date.now = () => ++ticks * 30000;
} else {
  assert.equal(mode, 'esm');
  assert.ok(process.execArgv.includes('--input-type=module'));
  fs.openSync = function(filename, ...args) {
    return String(filename).startsWith('\\\\.\\pipe\\') ? fakeFd : originalOpen.call(this, filename, ...args);
  };
  fs.readSync = function(fd, buffer, ...args) {
    if (fd !== fakeFd) return originalRead.call(this, fd, buffer, ...args);
    // Keep the production watchdog alive long enough to boot under the
    // caller's ESM flags, so an incompatible worker reports its error.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    return buffer.write(`${JSON.stringify({ [target]: inspection })}\n`);
  };
  fs.writeSync = function(fd, bytes, ...args) {
    return fd === fakeFd ? bytes.length : originalWrite.call(this, fd, bytes, ...args);
  };
  fs.closeSync = function(fd) {
    if (fd !== fakeFd) return originalClose.call(this, fd);
  };
}

Object.defineProperty(process, 'platform', { value: 'win32' });
const result = inspectWindowsAclBatch([target]);
assert.deepEqual(result, mode === 'spawn-error' ? {} : { [target]: inspection });
console.log('INSPECTION_RESULT', JSON.stringify(result));
// An unhandled ChildProcess/Worker error can arrive after the sync API returns.
await new Promise(resolve => setTimeout(resolve, 100));
console.log('CALLER_ALIVE');
