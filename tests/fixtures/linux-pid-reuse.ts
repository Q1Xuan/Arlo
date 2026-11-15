import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '@arlo/sdk';

// The allocator knob affects only this new PID namespace. Never write it until
// both the namespace identity and its single caller-owned UID mapping are proven.
assert.equal(process.platform, 'linux');
assert.equal(process.pid, 1);
assert.equal(process.getuid!(), 0);
const callerUid = Number(process.argv[2]);
assert.ok(Number.isSafeInteger(callerUid) && callerUid >= 0);
const namespace = fs.readlinkSync('/proc/self/ns/pid');
assert.notEqual(namespace, process.argv[3]);
const uidMap = fs.readFileSync('/proc/self/uid_map', 'utf8').trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
assert.deepEqual(uidMap, [[0, callerUid, 1]]);

const watchdog = setTimeout(() => {
  process.stderr.write('Linux PID reuse namespace exceeded its 45 second lifetime\n');
  process.exit(1); // The kernel terminates remaining members when namespace PID 1 exits.
}, 45000);
const cli = fileURLToPath(new URL('../../packages/daemon/bin/arlo.js', import.meta.url));
const stateDir = path.join(process.env.XDG_RUNTIME_DIR!, 'Arlo');

function lifetime(pid: number) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  assert.notEqual(fields[0], 'Z', 'A zombie is not a live replacement');
  return { startTicks: fields[19]!, executable: fs.readlinkSync(`/proc/${pid}/exe`) };
}

function launch(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, closed, output: () => output };
}

async function ready(server: ReturnType<typeof launch>) {
  const deadline = Date.now() + 10000;
  while (!server.output().includes('Arlo Daemon started')) {
    assert.equal(server.child.exitCode, null, server.output());
    assert.equal(server.child.signalCode, null, server.output());
    assert.ok(Date.now() < deadline, 'Real CLI daemon startup deadline');
    await delay(20);
  }
}

async function stop(server: ReturnType<typeof launch> | undefined, signal: NodeJS.Signals = 'SIGTERM') {
  if (!server) return;
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill(signal);
  await server.closed;
}

let original: ReturnType<typeof launch> | undefined;
let unrelated: ReturnType<typeof launch> | undefined;
let replacement: ReturnType<typeof launch> | undefined;
try {
  original = launch(process.execPath, [cli, 'serve']);
  await ready(original);
  const originalPid = original.child.pid!;
  const originalLifetime = lifetime(originalPid);
  const lockPath = path.join(stateDir, 'daemon.lock');
  const discoveryPath = path.join(stateDir, 'discovery.json');
  const originalLock = fs.readFileSync(lockPath, 'utf8');
  const originalDiscovery = fs.readFileSync(discoveryPath, 'utf8');
  assert.equal(JSON.parse(originalLock).pid, originalPid);
  assert.equal(JSON.parse(originalDiscovery).pid, originalPid);
  await stop(original, 'SIGKILL');
  assert.equal(original.child.signalCode, 'SIGKILL');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), originalLock);
  assert.equal(fs.readFileSync(discoveryPath, 'utf8'), originalDiscovery);
  await delay(50); // Distinct kernel start ticks, even when startup is very fast.

  fs.writeFileSync('/proc/sys/kernel/ns_last_pid', String(originalPid - 1));
  unrelated = launch('/usr/bin/sleep', ['40']);
  assert.equal(unrelated.child.pid, originalPid, 'The kernel must actually assign the previous daemon PID');
  const recycledLifetime = lifetime(unrelated.child.pid!);
  assert.match(recycledLifetime.executable, /\/sleep$/);
  assert.ok(BigInt(recycledLifetime.startTicks) > BigInt(originalLifetime.startTicks));
  const inspectUnrelated = () => {
    assert.equal(unrelated!.child.exitCode, null);
    assert.equal(unrelated!.child.signalCode, null);
    assert.deepEqual(lifetime(originalPid), recycledLifetime, 'The same unrelated process lifetime must survive recovery');
  };
  inspectUnrelated();
  assert.equal(fs.readFileSync(lockPath, 'utf8'), originalLock, 'Never rewrite the stale PID to simulate reuse');
  assert.equal(fs.readFileSync(discoveryPath, 'utf8'), originalDiscovery);

  replacement = launch(process.execPath, [cli, 'serve']);
  await ready(replacement);
  const status = await new DaemonClient({ stateDir }).getStatus();
  assert.equal(status.pid, replacement.child.pid);
  assert.notEqual(status.pid, originalPid, 'The unrelated process must not be adopted as the daemon');
  assert.notEqual(status.daemon_id, JSON.parse(originalDiscovery).daemon_id);
  assert.equal(status.listener, 'loopback');
  const command = spawnSync(process.execPath, [cli, 'status', '--json'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(command.status, 0, command.stderr);
  assert.equal(JSON.parse(command.stdout).daemon_id, status.daemon_id);
  inspectUnrelated();
  await stop(replacement);
  assert.equal(replacement.child.exitCode, 0);
  inspectUnrelated();
  process.stdout.write(JSON.stringify({
    mechanism: 'unprivileged-user-mount-pid-namespace-ns_last_pid', callerUid, namespace, uidMap,
    originalPid, originalStartTicks: originalLifetime.startTicks,
    reusedPid: unrelated.child.pid, reusedStartTicks: recycledLifetime.startTicks,
    replacementDaemonPid: status.pid, staleFilesUnmodified: true,
    replacementAlive: true, authenticatedRecovery: true,
  }) + '\n');
} finally {
  await stop(replacement);
  await stop(unrelated);
  await stop(original);
  clearTimeout(watchdog);
}
