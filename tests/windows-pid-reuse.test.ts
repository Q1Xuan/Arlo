import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDaemonLock } from '@arlo/daemon/storage';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('Windows actual recycled PID cannot inherit daemon ownership or be killed during stale-lock recovery', {
  skip: process.platform !== 'win32', timeout: 180000,
}, async t => {
  const root = createTempDir('actual-pid-reuse');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const compiler = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const executable = path.join(root, 'pid-reuse.exe');
  let owner: ReturnType<typeof spawn> | undefined;
  let recycler: ReturnType<typeof spawn> | undefined;
  let ownerClosed: Promise<unknown> | undefined;
  let recyclerClosed: Promise<unknown> | undefined;
  try {
    assert.ok(fs.existsSync(compiler), 'Windows acceptance requires the native .NET Framework compiler');
    const compiled = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${executable}`,
      fileURLToPath(new URL('./fixtures/windows-pid-reuse.cs', import.meta.url))], {
      windowsHide: true, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);

    // This lifetime really claims the production daemon lock using its own PID.
    // Its abrupt exit leaves the exact file behind; no PID field is rewritten.
    owner = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/shared-startup-owner.ts', import.meta.url)), stateDir], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    ownerClosed = once(owner, 'close');
    let ownerErrors = '';
    owner.stderr!.on('data', chunk => { ownerErrors += chunk; });
    const [ready] = await Promise.race([
      once(owner, 'message', { signal: AbortSignal.any([t.signal, AbortSignal.timeout(30000)]) }),
      ownerClosed.then(() => { throw new Error(`Production lock owner exited before readiness: ${ownerErrors}`); }),
    ]);
    assert.equal(ready.locked, true);
    const originalPid = owner.pid!;
    const lockPath = path.join(stateDir, 'daemon.lock');
    const originalLock = fs.readFileSync(lockPath, 'utf8');
    assert.equal(JSON.parse(originalLock).pid, originalPid);
    const inspected = spawnSync(executable, ['inspect', String(originalPid)], {
      windowsHide: true, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(inspected.status, 0, inspected.stderr);
    const originalLifetime = JSON.parse(inspected.stdout);
    owner.kill();
    await ownerClosed;

    recycler = spawn(executable, ['recycle', String(originalPid), process.execPath, '120000', '120000'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    recyclerClosed = once(recycler, 'close');
    let errors = '';
    recycler.stderr!.on('data', chunk => { errors += chunk; });
    const lines = createInterface({ input: recycler.stdout!, signal: t.signal })[Symbol.asyncIterator]();
    const first = await lines.next();
    assert.equal(first.done, false, `Native PID allocator exited without evidence: ${errors}`);
    const recycled = JSON.parse(first.value!);
    t.diagnostic(JSON.stringify({ originalPid, originalCreated: originalLifetime.created, ...recycled }));
    if (!recycled.reused) {
      await recyclerClosed;
      assert.equal(recycler.exitCode, 0, errors);
      t.skip(`Kernel did not reuse the actual lock owner's PID within ${recycled.attempts} owned allocations / ${recycled.elapsedMs} ms; actual reuse remains unverified`);
      return;
    }
    assert.equal(recycled.pid, originalPid);
    assert.ok(BigInt(recycled.created) > BigInt(originalLifetime.created), 'The same PID must belong to a distinct later OS process lifetime');
    const inspectReplacement = async () => {
      recycler!.stdin!.write('inspect\n');
      const next = await lines.next();
      assert.equal(next.done, false, 'Replacement must remain alive throughout the ownership check');
      const evidence = JSON.parse(next.value!);
      assert.equal(evidence.alive, true);
      assert.equal(evidence.created, recycled.created);
    };
    await inspectReplacement();
    await assert.rejects(acquireDaemonLock(stateDir, randomUUID(), process.pid), { code: 'LOCK_ACQUISITION_FAILED' });
    assert.equal(fs.readFileSync(lockPath, 'utf8'), originalLock, 'A recycled live PID does not authorize replacement of the stale owner');
    await inspectReplacement();

    // Terminate only the candidate's original CreateProcess handle. Once it is
    // gone, the same production path must reclaim the stale record successfully.
    recycler.stdin!.end('stop\n');
    await recyclerClosed;
    assert.equal(recycler.exitCode, 0, errors);
    const replacementId = randomUUID();
    const release = await acquireDaemonLock(stateDir, replacementId, process.pid);
    try {
      assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).daemon_id, replacementId);
      assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
    } finally { await release(); }
    if (process.env.ARLO_ACCEPTANCE_EVIDENCE_DIR) {
      fs.writeFileSync(path.join(process.env.ARLO_ACCEPTANCE_EVIDENCE_DIR, 'pid-reuse.json'), JSON.stringify({
        originalPid, originalCreated: originalLifetime.created,
        reusedPid: recycled.pid, reusedCreated: recycled.created,
        attempts: recycled.attempts, elapsedMs: recycled.elapsedMs,
        staleLockPreserved: true, replacementAlive: true, reclaimedAfterExit: true,
      }, null, 2) + '\n');
    }
  } finally {
    if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill();
    await ownerClosed;
    recycler?.stdin?.end('stop\n');
    await recyclerClosed;
    removeTempDir(root);
  }
});
