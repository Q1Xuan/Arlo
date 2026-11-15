import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ArloDaemon } from '@arlo/daemon';
import { DaemonClient, ArloErrorCode } from '@arlo/sdk';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from './test-utils.ts';
import type { AutonomousCommand } from './fixtures/harness-autonomous-worker.ts';

function startHarness(stateDir: string, profileDir: string, rootName: string) {
  const sessionDir = path.join(profileDir, 'sessions');
  fs.mkdirSync(sessionDir);
  const child = spawn(process.execPath, [
    '--import', new URL('../probes/isolation.mjs', import.meta.url).href,
    fileURLToPath(new URL('./fixtures/harness-autonomous-worker.ts', import.meta.url)),
  ], {
    cwd: profileDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      SystemRoot: process.env.SystemRoot,
      HOME: profileDir, USERPROFILE: profileDir, APPDATA: profileDir, LOCALAPPDATA: profileDir,
      XDG_CONFIG_HOME: profileDir, XDG_DATA_HOME: profileDir, XDG_CACHE_HOME: profileDir,
      TEMP: profileDir, TMP: profileDir, TMPDIR: profileDir,
      ARLO_STATE_DIR: stateDir, ARLO_SESSION_DIR: sessionDir, ARLO_ROOT_NAME: rootName,
      PSExecutionPolicyPreference: 'Bypass',
    },
  });
  const ready = Promise.withResolvers<number>();
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let sequence = 0;
  let output = '';
  child.stdout!.on('data', chunk => { output = (output + chunk).slice(-65536); });
  child.stderr!.on('data', chunk => { output = (output + chunk).slice(-65536); });
  const fail = (error: Error) => { ready.reject(error); for (const response of pending.values()) response.reject(error); };
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`Autonomous Harness exit ${code}: ${output}`)));
  child.on('message', (message: { ready?: boolean; pid?: number; id: number; result?: unknown; error?: string }) => {
    if (message.ready) ready.resolve(message.pid!);
    else if (message.error) pending.get(message.id)?.reject(new Error(message.error));
    else pending.get(message.id)?.resolve(message.result);
  });
  const startup = setTimeout(() => ready.reject(new Error(`Autonomous Harness startup timeout: ${output}`)), 30000);
  void ready.promise.then(() => clearTimeout(startup), () => clearTimeout(startup));
  async function request(command: AutonomousCommand) {
    const id = ++sequence;
    const response = Promise.withResolvers<any>();
    pending.set(id, response);
    const timer = setTimeout(() => response.reject(new Error(`Autonomous Harness ${command.action} timeout: ${output}`)), 90000);
    try {
      child.send({ id, command }, error => { if (error) response.reject(error); });
      return await response.promise;
    } finally { clearTimeout(timer); pending.delete(id); }
  }
  return { ready: ready.promise, request, output: () => output,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const timer = setTimeout(() => child.kill(), 10000);
      try { if (child.connected) await request({ action: 'stop' }).catch(() => child.kill()); else child.kill(); await closed; }
      finally { clearTimeout(timer); }
    } };
}

async function eventually<T>(read: () => Promise<T>, match: (value: T) => boolean, description: string): Promise<T> {
  const deadline = Date.now() + 30000;
  let value: T;
  do {
    value = await read();
    if (match(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail(`${description}: ${JSON.stringify(value!)}`);
}

const text = (result: any) => result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
const accepted = (snapshot: any) => snapshot.results.filter((result: any) => {
  try { return JSON.parse(text(result)).status === 'accepted'; } catch { return false; }
});
const inbound = (snapshot: any) => snapshot.messages.filter((message: any) => message.source?.kind === 'arlo');
const exhausted = (snapshot: any) => snapshot.results.filter((result: any) => text(result).includes(ArloErrorCode.ALLOWANCE_EXHAUSTED));

test('independent persisted DSH roots autonomously exhaust attempts, continue local reception and recover by human command', { timeout: 420000 }, async () => {
  const stateDir = createTempDir('autonomous-process-daemon');
  const profiles = [createTempDir('autonomous-process-a'), createTempDir('autonomous-process-b')];
  let daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT });
  const workers: ReturnType<typeof startHarness>[] = [];
  try {
    await daemon.start();
    workers.push(...profiles.map((profile, index) => startHarness(stateDir, profile, `autonomous-root-${index}`)));
    const [a, b] = workers;
    const pids = await Promise.all(workers.map(worker => worker.ready));
    assert.equal(new Set([...pids, process.pid]).size, 3, 'The two real DSH processes must be independent of the test driver');
    const ready = async () => eventually(() => new DaemonClient({ stateDir }).listRoots(),
      roots => roots.filter(root => root.deliverable).length === 2, 'Both persisted DSH roots become deliverable');
    await ready();
    const human = async (worker: typeof a, name: 'status' | 'continue') => {
      const result = await worker.request({ action: 'human', name });
      assert.equal(result.modelRequestsAdded, 0, 'Human control runs without creating a model request');
      return result.status;
    };
    for (const worker of workers) {
      const unknown = await human(worker, 'status');
      assert.equal(unknown.knowledge, 'unknown');
      assert.equal(unknown.remaining, null);
      assert.equal(unknown.root_configuration.ownership, 'verified');
      assert.equal((await human(worker, 'continue')).remaining, 20);
    }
    const contactsA = await a.request({ action: 'discover' });
    const contactsB = await b.request({ action: 'discover' });
    assert.equal(contactsA.length, 1);
    assert.equal(contactsB.length, 1);
    await a.request({ action: 'arm', target: contactsA[0].endpoint_id });
    await b.request({ action: 'arm', target: contactsB[0].endpoint_id });
    await a.request({ action: 'input', text: 'autonomous-start' });
    const exhaustedA = await eventually(() => a.request({ action: 'snapshot' }), snapshot =>
      accepted(snapshot).length === 20 && snapshot.results.some((result: any) => text(result).includes(ArloErrorCode.ALLOWANCE_EXHAUSTED)),
    'The local model automatically attempts and refuses the twenty-first send');
    const exhaustedB = await b.request({ action: 'snapshot' });
    assert.equal(accepted(exhaustedB).length, 20);
    assert.equal(inbound(exhaustedA).length, 20);
    assert.equal(inbound(exhaustedB).length, 20);
    for (const worker of workers) {
      const state = await human(worker, 'status');
      assert.equal(state.used, 20);
      assert.equal(state.remaining, 0);
      assert.equal(state.pause_reason, ArloErrorCode.ALLOWANCE_EXHAUSTED);
    }
    const local = await a.request({ action: 'local-work' });
    assert.equal(local.localWork, 1);
    assert.equal(local.status, 'idle');
    assert.equal(accepted(local).length, 20);
    await a.request({ action: 'input', text: 'ordinary user conversation must not continue collaboration' });
    assert.equal((await human(a, 'status')).remaining, 0);

    // Only B continues. Its new autonomous message still enters paused A's
    // existing session; A's follow-up send is refused and local work remains live.
    await human(b, 'continue');
    await b.request({ action: 'input', text: 'autonomous-start' });
    const reception = await eventually(() => a.request({ action: 'snapshot' }), snapshot => inbound(snapshot).length === 21,
      'A paused sender continues receiving and processing actual host input');
    assert.equal(reception.pending.length, 0);
    assert.equal(reception.status, 'idle');
    assert.equal((await human(a, 'status')).used, 20);
    assert.equal((await human(b, 'status')).used, 1);
    await human(a, 'continue');
    await human(b, 'continue');
    await a.request({ action: 'input', text: 'autonomous-start' });
    const second = await eventually(() => a.request({ action: 'snapshot' }), snapshot =>
      accepted(snapshot).length === 40 && inbound(snapshot).length === 41 && exhausted(snapshot).length === 3,
      'Human continue opens a complete second period');
    assert.equal((await human(a, 'status')).used, 20);
    assert.equal((await human(b, 'status')).used, 20);
    assert.equal(second.localWork, 1);

    await Promise.all(workers.map(worker => worker.request({ action: 'detach' })));
    const previousDaemonId = daemon.daemonId;
    await daemon.stop();
    daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT });
    await daemon.start();
    assert.notEqual(daemon.daemonId, previousDaemonId);
    await Promise.all(workers.map(worker => worker.request({ action: 'attach' })));
    await ready();
    for (const worker of workers) {
      const lost = await human(worker, 'status');
      assert.equal(lost.knowledge, 'unknown');
      assert.equal(lost.remaining, null);
      assert.equal(lost.pause_reason, ArloErrorCode.ALLOWANCE_UNKNOWN);
      assert.equal(lost.root_configuration.ownership, 'verified');
    }
    const freshA = await a.request({ action: 'discover' });
    const freshB = await b.request({ action: 'discover' });
    await a.request({ action: 'arm', target: freshA[0].endpoint_id });
    await b.request({ action: 'arm', target: freshB[0].endpoint_id });
    await a.request({ action: 'input', text: 'autonomous-start' });
    const stopped = await a.request({ action: 'snapshot' });
    assert.equal(accepted(stopped).length, 40);
    assert.ok(stopped.results.some((result: any) => text(result).includes(ArloErrorCode.ALLOWANCE_UNKNOWN)));
    assert.equal((await a.request({ action: 'local-work' })).localWork, 2);
    for (const worker of workers) assert.equal((await human(worker, 'continue')).remaining, 20);
    await a.request({ action: 'input', text: 'autonomous-start' });
    await eventually(() => a.request({ action: 'snapshot' }), snapshot =>
      accepted(snapshot).length === 60 && inbound(snapshot).length === 61 && exhausted(snapshot).length === 4,
      'A new trusted operation restores autonomous work after authority loss');
    const final = await Promise.all(workers.map(worker => worker.request({ action: 'snapshot' })));
    assert.ok(final.every(snapshot => snapshot.pending.length === 0 && snapshot.childMessages === 0 && snapshot.status === 'idle'));
    assert.deepEqual(final.map(snapshot => snapshot.pid), pids);
    assert.ok(workers.every(worker => !worker.output().includes('autonomous ping') && !worker.output().includes('autonomous pong')),
      'Process output does not print business messages');
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await daemon.stop();
    for (const profile of profiles) removeTempDir(profile);
    removeTempDir(stateDir);
  }
});
