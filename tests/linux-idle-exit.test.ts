import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DaemonClient, readDiscoveryRecord } from '@arlo/sdk';
import { acceptanceProcess } from './fixtures/acceptance-process.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('Linux real Daemon cancels armed idle exit for a TCP client and releases ownership after disconnect', {
  skip: process.platform !== 'linux', timeout: 60000,
}, async () => {
  const stateDir = createTempDir('linux-idle-state');
  const profiles = [createTempDir('linux-idle-first'), createTempDir('linux-idle-replacement')];
  const idleMs = 1500;
  // This existing fixture only starts the production Daemon with an idle-time
  // seam; it uses no Windows APIs despite its historical filename.
  const daemon = acceptanceProcess('./windows-acceptance-daemon.ts', profiles[0], stateDir,
    { ARLO_TEST_IDLE_MS: String(idleMs) });
  let replacement: ReturnType<typeof acceptanceProcess> | undefined;
  let socket: net.Socket | undefined;
  try {
    const started = await daemon.ready;
    const original = readDiscoveryRecord(stateDir);
    assert.equal(original.pid, daemon.pid);
    assert.notEqual(original.pid, process.pid);
    assert.equal(original.daemon_id, started.daemonId);
    // Startup has no admitted clients, so the initial idle deadline is armed.
    // Admit a real socket partway through that window without completing TLS.
    await delay(idleMs / 4);
    socket = net.connect(started.port, '127.0.0.1');
    await once(socket, 'connect');
    await delay(idleMs + 500);
    assert.equal(socket.destroyed, false, 'The admitted TCP connection remains open beyond the idle deadline');
    assert.equal(process.kill(original.pid, 0), true, 'The independent Daemon process remains alive');
    assert.equal(readDiscoveryRecord(stateDir).daemon_id, original.daemon_id);

    const closed = once(socket, 'close');
    socket.destroy();
    await closed;
    const deadline = Date.now() + 15000;
    // Do not call the fixture stop helper until the operating system confirms
    // natural termination; disconnecting fixture IPC would otherwise mask it.
    while (true) {
      try { process.kill(original.pid, 0); }
      catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
        break;
      }
      assert.ok(Date.now() < deadline, 'The Daemon did not exit naturally after its last client disconnected');
      await delay(20);
    }
    await daemon.stop();
    for (const name of ['daemon.lock', 'discovery.json', 'bootstrap.token']) {
      assert.equal(fs.existsSync(path.join(stateDir, name)), false, `Natural idle exit removes owned ${name}`);
    }
    const entries = fs.readFileSync(path.join(stateDir, 'daemon.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(entries.some(entry => entry.event === 'DAEMON_STOPPED' && entry.daemon_id === original.daemon_id));

    replacement = acceptanceProcess('./windows-acceptance-daemon.ts', profiles[1], stateDir);
    const restarted = await replacement.ready;
    const status = await new DaemonClient({ stateDir }).getStatus();
    assert.equal(status.pid, replacement.pid);
    assert.equal(status.daemon_id, restarted.daemonId);
    assert.notEqual(status.daemon_id, original.daemon_id, 'The released kernel ownership permits a fresh authenticated Daemon');
  } finally {
    socket?.destroy();
    const cleanup = await Promise.allSettled([daemon.stop(), ...(replacement ? [replacement.stop()] : [])]);
    for (const directory of [...profiles, stateDir]) {
      try { removeTempDir(directory); }
      catch (reason) { cleanup.push({ status: 'rejected', reason }); }
    }
    const failures = cleanup.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Linux idle-exit acceptance cleanup failed');
  }
});
