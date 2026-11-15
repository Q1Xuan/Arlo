import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ArloDaemon } from '@arlo/daemon';
import { ArloError, ArloErrorCode, readDiscoveryRecord, verifyWindowsAcl, type ControlClient, type ArloMessageNotificationParams } from '@arlo/sdk';
import {
  bridgeBootstrapPath,
  ClaudeCodeBridgeServer,
  ClaudeCodeModDispatcher,
  ClaudeCodeReceptionHost,
  ClaudeCodeSidecar,
  correlationMarker,
  launchClaudeCodeWithSidecar,
  publishActiveBridgeBootstrap,
  readBridgeBootstrap,
  readLiveSessionId,
  SIDECAR_RECOVERY_ATTEMPTS,
  SIDECAR_RECOVERY_BUDGET_MS,
  type ClaudeModHost,
} from '../packages/adapter-claudecode/src/index.ts';
import { SIDECAR_RECOVERY_ATTEMPTS as MOD_ATTEMPTS, SIDECAR_RECOVERY_BUDGET_MS as MOD_BUDGET } from '../packages/adapter-claudecode/mod/hooks/register.js';
import { createTempDir, readDurableQueue, removeTempDir } from './test-utils.ts';

const launchSessionId = '6f0c2a1e-7b4d-4e2a-9c11-0a6b5d4e3f21';
const replacementSessionId = '91ab56c0-2d4e-4f6a-8b22-7c5d3e1f0a90';

// libuv reports every writable Windows file as 0o666 regardless of its ACL,
// so the 0o600 expectation only holds on POSIX; Windows checks the real ACL.
function assertPrivateMode(file: string): void {
  if (process.platform === 'win32') {
    assert.equal(verifyWindowsAcl(file).valid, true, `Private state ACL must be valid: ${file}`);
    return;
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
}

// A killed Windows child releases its working directory and inherited pipes
// only after the kernel reports the exit, so teardown must await it; a
// fire-and-forget kill leaves the owned fixture undeletable and holds the
// test file's stdio open. Await 'exit' only: 'close' also needs every
// inherited pipe end to close.
async function killAndAwait(child: {
  exitCode?: number | null;
  signalCode?: string | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  once: (event: 'exit', listener: () => void) => unknown;
}): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
  child.kill('SIGKILL');
  await exited;
}

async function cleanupRecoveryFixture(stateDir: string, daemon: ArloDaemon,
  stopChildren: Array<() => Promise<unknown>>): Promise<void> {
  const failures: unknown[] = [];
  // The real CLI may auto-start a shared Daemon. Keep an explicit fixture
  // instance alive until its Sidecars stop, then release it before its files.
  for (const stop of [...stopChildren, () => daemon.stop(), async () => removeTempDir(stateDir)]) {
    try { await stop(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Recovery fixture cleanup failed');
}

function frame(id: string): ArloMessageNotificationParams {
  return {
    protocol_version: '0.1', daemon_id: 'daemon-recovery', message_id: id,
    delivery_id: `delivery-${id}`, from_endpoint: 'sender', to_endpoint: 'receiver',
    group_id: 'group-recovery', target_generation: 1, delivery_seq: '1',
    text: `body-${id}`, sent_at: '2026-10-22T00:00:00.000Z',
  };
}

async function abandon(sidecar: ClaudeCodeSidecar): Promise<void> {
  await sidecar.bridgeServer.stop();
  await sidecar.runtime?.dispose();
}

async function bridgeCall(url: string, token: string, sessionId: string, path: string, init: {
  instanceId?: string; generation?: number; body?: unknown;
} = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'x-session-id': sessionId };
  if (init.instanceId !== undefined) headers['x-bridge-instance'] = init.instanceId;
  if (init.generation !== undefined) headers['x-bridge-generation'] = String(init.generation);
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${url}/api/v1/bridge${path}`, {
    method: init.body === undefined && init.instanceId === undefined ? 'GET' : init.body === undefined ? 'GET' : 'POST',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test('replacement Sidecar recovers never-submitted input once and rejects the old credential', async (t) => {
  assert.equal(MOD_ATTEMPTS, SIDECAR_RECOVERY_ATTEMPTS);
  assert.equal(MOD_BUDGET, SIDECAR_RECOVERY_BUDGET_MS);
  const stateDir = createTempDir('cc-sidecar-recovery');
  t.after(() => removeTempDir(stateDir));
  const first = new ClaudeCodeSidecar({ sessionId: launchSessionId, stateDir, autoStart: false });
  await first.start();
  const kept = first.receptionHost.prepare(frame('never-submitted'));
  assert.equal(await kept.enqueue(), 'enqueued');
  const unconfirmed = first.receptionHost.prepare(frame('unconfirmed'));
  assert.equal(await unconfirmed.enqueue(), 'enqueued');
  first.receptionHost.beginDispatch(unconfirmed.nativeMessageId);
  const settled = first.receptionHost.prepare(frame('settled'));
  assert.equal(await settled.enqueue(), 'enqueued');
  first.receptionHost.beginDispatch(settled.nativeMessageId);
  first.receptionHost.recordHandoff(settled.nativeMessageId);
  const settledRecord = readDurableQueue(stateDir, launchSessionId).find(record => record.messageId === 'settled');
  first.receptionHost.claim(settled.nativeMessageId, 'settled', correlationMarker(settledRecord!.correlationId!));
  const firstBootstrap = readBridgeBootstrap(first.bootstrapPath);
  assert.equal(firstBootstrap.status, 'active');
  assertPrivateMode(first.bootstrapPath);
  const previousToken = first.token;
  await abandon(first);

  const second = new ClaudeCodeSidecar({ sessionId: launchSessionId, stateDir, autoStart: false });
  await second.start();
  t.after(() => second.stop());
  assert.notEqual(second.token, previousToken);
  assert.deepEqual(
    readDurableQueue(stateDir, launchSessionId).map(record => [record.messageId, record.status]).sort(),
    [['never-submitted', 'enqueued'], ['settled', 'claimed'], ['unconfirmed', 'unknown']],
  );
  assert.deepEqual(second.receptionHost.getPendingMessages().map(record => record.messageId), ['never-submitted']);
  assert.equal((await bridgeCall(second.url, previousToken, launchSessionId, '/status')).status, 401);
  const stale = await bridgeCall(second.url, second.token, launchSessionId, '/messages/pending', {
    instanceId: first.bridgeServer.instanceId, generation: 0,
  });
  assert.equal(stale.status, 409);
  assert.equal(fs.existsSync(`${stateDir}/user-authorized-roots.json`), false);
});

test('context switch survives Sidecar replacement and does not revive the retired queue', async (t) => {
  const stateDir = createTempDir('cc-sidecar-context');
  t.after(() => removeTempDir(stateDir));
  const calls: string[] = [];
  const control = new Proxy({}, {
    get: (_target, property) => async () => {
      if (typeof property === 'string') calls.push(property);
      throw new ArloError(ArloErrorCode.ACCOUNTING_UNAVAILABLE);
    },
  }) as ControlClient;
  const first = new ClaudeCodeSidecar({ sessionId: launchSessionId, stateDir, controlClient: control });
  await first.start();
  const retired = first.receptionHost.prepare(frame('retired-input'));
  assert.equal(await retired.enqueue(), 'enqueued');
  const discovered = await bridgeCall(first.url, first.token, launchSessionId, '/status');
  const handshake = await bridgeCall(first.url, first.token, launchSessionId, '/handshake', {
    instanceId: String(discovered.body.instanceId), generation: Number(discovered.body.generation),
    body: { modVersion: '0.1.0', capabilities: ['prompt.submit'] },
  });
  assert.equal(handshake.body.accepted, true);
  const retiredBridge = await bridgeCall(first.url, first.token, launchSessionId, '/session/retire', {
    instanceId: String(handshake.body.instanceId), generation: Number(handshake.body.generation), body: {},
  });
  await bridgeCall(first.url, first.token, launchSessionId, '/session/activate', {
    instanceId: String(retiredBridge.body.instanceId), generation: Number(retiredBridge.body.generation),
    body: { sessionId: replacementSessionId },
  });
  const carried = first.receptionHost.prepare(frame('carried'));
  assert.equal(await carried.enqueue(), 'enqueued');
  await abandon(first);
  const second = new ClaudeCodeSidecar({
    sessionId: readLiveSessionId(stateDir, launchSessionId), launchSessionId, stateDir, autoStart: false,
  });
  await second.start();
  t.after(() => second.stop());
  assert.equal(second.sessionId, replacementSessionId);
  assert.equal(readDurableQueue(stateDir, launchSessionId).find(record => record.messageId === 'retired-input')?.status, 'discarded');
  assert.deepEqual(second.receptionHost.getPendingMessages().map(record => record.messageId), ['carried']);
  assert.equal(calls.some(name => name === 'prepareContinuation' || name === 'continueCollaboration'), false);
});

test('living Mod reattaches from private bootstrap material and submits never-submitted input once', async (t) => {
  const stateDir = createTempDir('cc-mod-recovery');
  t.after(() => removeTempDir(stateDir));
  const sessionId = launchSessionId;
  const firstHost = new ClaudeCodeReceptionHost({ sessionId, storageDir: stateDir });
  const firstToken = 'ab'.repeat(32);
  const first = new ClaudeCodeBridgeServer({ sessionId, token: firstToken, port: 0, receptionHost: firstHost });
  await first.start();
  const bootstrapFile = bridgeBootstrapPath(stateDir, sessionId);
  publishActiveBridgeBootstrap(bootstrapFile, {
    sessionId, url: first.url, token: firstToken, instanceId: first.instanceId,
  });
  const urls: string[] = [];
  const submitted: string[] = [];
  const diagnostics: string[] = [];
  const staleUrl = 'http://127.0.0.1:9';
  const staleToken = 'cd'.repeat(32);
  const host: ClaudeModHost = {
    session: { id: async () => sessionId },
    env: { get: async name => name.endsWith('URL') ? staleUrl : name.endsWith('BOOTSTRAP') ? bootstrapFile : staleToken },
    fs: { read: async file => fs.readFileSync(file, 'utf8') },
    http: { fetch: async (url, init) => {
      urls.push(url);
      const result = await fetch(url, init);
      return { status: result.status, ok: result.ok, headers: {}, text: await result.text() };
    } },
    prompt: { submit: async input => { submitted.push(input.text); return undefined; } },
    ui: { log: text => { diagnostics.push(text); } },
    clock: {
      now: async () => Date.now(),
      every: () => ({ cancel() {} }),
      after: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return { cancel: () => clearTimeout(timer) };
      },
    },
  };
  const dispatcher = new ClaudeCodeModDispatcher({ $: host });
  t.after(() => dispatcher.stop());
  await dispatcher.start();
  assert.equal(urls.some(url => url.startsWith(first.url)), true);
  assert.equal(urls.some(url => url.startsWith(staleUrl)), false);
  await first.stop();

  const secondHost = new ClaudeCodeReceptionHost({ sessionId, storageDir: stateDir });
  await secondHost.recover();
  const kept = secondHost.prepare(frame('resumed-once'));
  assert.equal(await kept.enqueue(), 'enqueued');
  const hidden = secondHost.prepare(frame('still-unknown'));
  assert.equal(await hidden.enqueue(), 'enqueued');
  secondHost.beginDispatch(hidden.nativeMessageId);
  secondHost.recordUnresolved(hidden.nativeMessageId);
  const secondToken = 'ef'.repeat(32);
  const second = new ClaudeCodeBridgeServer({
    sessionId, token: secondToken, port: 0, receptionHost: secondHost,
    onHandshake: () => { secondHost.replaceDispatcher(); },
  });
  await second.start();
  t.after(() => second.stop());
  publishActiveBridgeBootstrap(bootstrapFile, {
    sessionId, url: second.url, token: secondToken, instanceId: second.instanceId,
  });
  await dispatcher.pollOnce();
  await dispatcher.pollOnce();
  assert.equal(submitted.length, 1);
  assert.match(submitted[0]!, /body-resumed-once/);
  assert.equal(submitted.some(text => text.includes('still-unknown')), false);
  assert.equal(urls.some(url => url.startsWith(second.url)), true);
  assert.equal((await bridgeCall(second.url, firstToken, sessionId, '/status')).status, 401);
  const staleInstance = await bridgeCall(second.url, secondToken, sessionId, '/messages/pending', {
    instanceId: first.instanceId, generation: 1,
  });
  assert.equal(staleInstance.status, 409);
  assert.equal(diagnostics.some(line => line.includes(firstToken) || line.includes(secondToken)), false);
});

test('real Sidecar process keeps never-submitted input and rejects the previous credential', { timeout: 20_000 }, async (t) => {
  const stateDir = createTempDir('cc-sidecar-process');
  const daemon = new ArloDaemon({ stateDir });
  const children: ReturnType<typeof spawn>[] = [];
  t.after(() => cleanupRecoveryFixture(stateDir, daemon, children.map(child => () => killAndAwait(child))));
  await daemon.start();
  const seeded = new ClaudeCodeSidecar({ sessionId: launchSessionId, stateDir, autoStart: false });
  await seeded.start();
  const kept = seeded.receptionHost.prepare(frame('process-once'));
  assert.equal(await kept.enqueue(), 'enqueued');
  const hidden = seeded.receptionHost.prepare(frame('process-unknown'));
  assert.equal(await hidden.enqueue(), 'enqueued');
  seeded.receptionHost.beginDispatch(hidden.nativeMessageId);
  const previousToken = seeded.token;
  await abandon(seeded);

  const script = fileURLToPath(new URL('../packages/adapter-claudecode/src/sidecar-cli.ts', import.meta.url));
  const start = () => {
    let errors = '';
    const child = spawn(process.execPath, [script], {
      cwd: stateDir,
      env: {
        ...process.env,
        ARLO_CLAUDECODE_SESSION_ID: launchSessionId,
        ARLO_CLAUDECODE_STATE_DIR: stateDir,
        ARLO_CLAUDECODE_CWD: stateDir,
        ARLO_CLAUDECODE_CROSS_HOST_ENABLED: '0',
        ARLO_CLAUDECODE_STARTUP_TIMEOUT_MS: '15000',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stderr!.on('data', chunk => { errors += chunk.toString('utf8'); });
    const ready = new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout!.on('data', chunk => {
        output += chunk.toString('utf8');
        if (output.includes('"type":"ready"')) resolve();
      });
      child.once('exit', code => reject(new Error(`Sidecar exited before ready: ${code}: ${errors}`)));
    });
    return { child, ready, errors: () => errors };
  };
  const first = start();
  await first.ready;
  assert.equal(readDiscoveryRecord(stateDir).pid, process.pid, 'The real Sidecar must use the fixture-owned Daemon');
  const published = readBridgeBootstrap(bridgeBootstrapPath(stateDir, launchSessionId));
  assert.equal(published.status, 'active');
  assert.equal(first.errors().includes(previousToken), false);
  if (published.status === 'active') assert.equal(first.errors().includes(published.token), false);
  assertPrivateMode(bridgeBootstrapPath(stateDir, launchSessionId));
  first.child.kill('SIGKILL');
  await new Promise(resolve => first.child.once('exit', resolve));
  assert.equal(readDurableQueue(stateDir, launchSessionId).find(record => record.messageId === 'process-once')?.status, 'enqueued');

  const second = start();
  await second.ready;
  const replacement = readBridgeBootstrap(bridgeBootstrapPath(stateDir, launchSessionId));
  assert.equal(replacement.status, 'active');
  if (published.status !== 'active' || replacement.status !== 'active') return;
  assert.notEqual(replacement.token, published.token);
  assert.equal(second.errors().includes(replacement.token), false);
  assert.equal((await bridgeCall(replacement.url, published.token, launchSessionId, '/status')).status, 401);
  const pending = await bridgeCall(replacement.url, replacement.token, launchSessionId, '/messages/pending', {
    instanceId: replacement.instanceId, generation: 0,
  });
  const messages = pending.body.messages as Array<{ messageId: string }>;
  assert.deepEqual(messages.map(message => message.messageId), ['process-once']);
  assert.equal(readDurableQueue(stateDir, launchSessionId).find(record => record.messageId === 'process-unknown')?.status, 'unknown');
  second.child.kill('SIGKILL');
});

class HeldProcess extends EventEmitter {
  pid = 4242;
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  connected = false;
  readonly command: string;
  readonly args: string[];
  constructor(command: string, args: string[]) {
    super();
    this.command = command;
    this.args = args;
  }
  kill(signal = 'SIGTERM'): boolean {
    this.killed = true;
    this.signalCode = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
    return true;
  }
}

test('runner keeps one Claude process while a real Sidecar is killed and reattached', { timeout: 40_000 }, async (t) => {
  const stateDir = createTempDir('cc-runner-real-sidecar');
  const daemon = new ArloDaemon({ stateDir });
  let handle: Awaited<ReturnType<typeof launchClaudeCodeWithSidecar>> | undefined;
  let attaching = false;
  t.after(async () => {
    attaching = false;
    await cleanupRecoveryFixture(stateDir, daemon, [
      async () => { await handle?.stop(); },
      async () => { if (handle) await killAndAwait(handle.sidecarProcess); },
    ]);
  });
  await daemon.start();
  const seeded = new ClaudeCodeSidecar({ sessionId: launchSessionId, stateDir, autoStart: false });
  await seeded.start();
  assert.equal(await seeded.receptionHost.prepare(frame('runner-once')).enqueue(), 'enqueued');
  await abandon(seeded);
  let host: HeldProcess | undefined;
  attaching = true;
  const seen = new Set<string>();
  const attachments: string[] = [];
  const attach = async () => {
    const deadline = Date.now() + 30_000;
    while (attaching && Date.now() < deadline) {
      const file = bridgeBootstrapPath(stateDir, launchSessionId);
      if (!fs.existsSync(file)) {
        await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      try {
        const material = readBridgeBootstrap(file);
        if (material.status === 'active' && !seen.has(material.instanceId)) {
          const status = await bridgeCall(material.url, material.token, launchSessionId, '/status');
          if (status.status === 200) {
            const handshake = await bridgeCall(material.url, material.token, launchSessionId, '/handshake', {
              instanceId: String(status.body.instanceId), generation: Number(status.body.generation),
              body: { modVersion: '0.1.0', capabilities: ['prompt.submit'] },
            });
            if (handshake.status === 200 && handshake.body.accepted === true) {
              seen.add(material.instanceId);
              attachments.push(material.instanceId);
            }
          }
        }
      } catch { /* The replacement bridge is not listening yet. */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  void attach();
  handle = await launchClaudeCodeWithSidecar({
    sessionId: launchSessionId, stateDir, cwd: stateDir, groupName: 'sidecar-recovery', timeoutMs: 20_000,
    claudeCommand: process.execPath,
    spawnFn: (command, args, options) => {
      if (args[0] === '--version') {
        const probe = new HeldProcess(command, args);
        setImmediate(() => {
          probe.emit('spawn');
          probe.stdout.emit('data', Buffer.from('2.1.296 (Claude Code)\n'));
          probe.exitCode = 0;
          probe.emit('exit', 0, null);
          probe.emit('close', 0, null);
        });
        return probe;
      }
      if (String(args[0] ?? '').includes('sidecar-cli')) return spawn(command, args, options);
      host = new HeldProcess(command, args);
      setImmediate(() => host!.emit('spawn'));
      return host;
    },
  });
  assert.equal(readDiscoveryRecord(stateDir).pid, process.pid, 'The runner must use the fixture-owned Daemon');
  assert.equal(attachments.length, 1);
  assert.equal(host?.killed, false);
  const firstToken = readBridgeBootstrap(bridgeBootstrapPath(stateDir, launchSessionId));
  assert.equal(firstToken.status, 'active');
  handle.sidecarProcess.kill('SIGKILL');
  const restarted = Date.now() + 20_000;
  while (attachments.length < 2 && Date.now() < restarted) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(attachments.length, 2);
  assert.equal(host?.killed, false);
  assert.equal(host?.exitCode, null);
  const replacement = readBridgeBootstrap(bridgeBootstrapPath(stateDir, launchSessionId));
  assert.equal(replacement.status, 'active');
  if (firstToken.status !== 'active' || replacement.status !== 'active') return;
  assert.notEqual(replacement.instanceId, firstToken.instanceId);
  assert.notEqual(replacement.token, firstToken.token);
  assert.equal((await bridgeCall(replacement.url, firstToken.token, launchSessionId, '/status')).status, 401);
  const status = await bridgeCall(replacement.url, replacement.token, launchSessionId, '/status');
  assert.equal(status.status, 200);
  const pending = await bridgeCall(replacement.url, replacement.token, launchSessionId, '/messages/pending', {
    instanceId: replacement.instanceId, generation: Number(status.body.generation),
  });
  assert.equal(pending.status, 200);
  const messages = pending.body.messages as Array<{ messageId: string }>;
  assert.deepEqual(messages.map(message => message.messageId), ['runner-once']);
  assert.equal(fs.existsSync(`${stateDir}/user-authorized-roots.json`), false);
});
