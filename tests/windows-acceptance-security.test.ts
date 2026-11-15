import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DaemonClient, createPinnedHttpsAgent, sendSecureArloRequest, readDiscoveryRecord,
  getCurrentUserSid, inspectWindowsAclBatch, verifyWindowsAcl } from '@arlo/sdk';
import { IMPOSTER_CERT } from '../probes/tls-fixtures.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

const windows = { skip: process.platform !== 'win32', timeout: 90000 };
const guard = pathToFileURL(fileURLToPath(new URL('../probes/isolation.mjs', import.meta.url))).href;

function fixture() {
  const root = createTempDir('windows-acceptance');
  const stateDir = path.join(root, 'state');
  const profile = path.join(root, 'profile');
  const project = path.join(root, 'project');
  for (const dir of [stateDir, profile, project]) fs.mkdirSync(dir);
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  // The child receives no provider credentials, inherited NODE_OPTIONS or host
  // plugins. Only native OS executables and this run's owned profile are visible.
  const env: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot, WINDIR: systemRoot,
    PATH: [path.dirname(process.execPath), path.join(systemRoot, 'System32'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter),
    HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'roaming'),
    LOCALAPPDATA: path.join(profile, 'local'), TEMP: profile, TMP: profile,
    XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_DATA_HOME: path.join(profile, 'data'),
    XDG_CACHE_HOME: path.join(profile, 'cache'),
    ARLO_STATE_DIR: stateDir, PSExecutionPolicyPreference: 'Bypass',
  };
  return { root, stateDir, project, env };
}

function launch(f: ReturnType<typeof fixture>, name = 'windows-acceptance-daemon.ts', extraEnv: NodeJS.ProcessEnv = {}) {
  const networkFile = path.join(f.root, `network-${crypto.randomUUID()}.json`);
  const child = cp.spawn(process.execPath, ['--import', guard,
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))], {
    env: { ...f.env, ...extraEnv, ARLO_LOW_LEVEL_NETWORK_FILE: networkFile },
    cwd: f.project, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  fs.writeFileSync(path.join(f.root, `process-${child.pid}.json`), JSON.stringify({
    pid: child.pid, parent: process.pid, fixture: name,
  }));
  return { child, exited, networkFile, output: () => output };
}

async function nextMessage(server: ReturnType<typeof launch>, command?: object) {
  const controller = new AbortController();
  try {
    const message = once(server.child, 'message', { signal: controller.signal });
    if (command) server.child.send(command);
    return await Promise.race([
      message.then(([value]) => value),
      server.exited.then(() => { throw new Error(`Acceptance process exited before reply: ${server.output()}`); }),
      delay(30000, undefined, { signal: controller.signal }).then(() => { throw new Error(`Acceptance IPC deadline: ${server.output()}`); }),
    ]);
  } finally { controller.abort(); }
}

async function awaitExit(server: ReturnType<typeof launch>) {
  const controller = new AbortController();
  try {
    await Promise.race([
      server.exited,
      delay(15000, undefined, { signal: controller.signal }).then(async () => {
        server.child.kill();
        await server.exited;
        throw new Error('Acceptance child did not stop');
      }),
    ]);
  } finally { controller.abort(); }
}

async function stop(server: ReturnType<typeof launch>) {
  if (server.child.exitCode === null && server.child.signalCode === null && server.child.connected) {
    server.child.disconnect();
  }
  await awaitExit(server);
  assert.equal(server.child.exitCode, 0, server.output());
  assert.equal(JSON.parse(fs.readFileSync(server.networkFile, 'utf8')).deniedConnections, 0,
    'Any attempted external request fails acceptance');
}

test('Windows separate old-port process receives zero plaintext before TLS refusal, with a working positive control', windows, async () => {
  const f = fixture();
  const daemon = launch(f);
  const imposter = launch(f, 'linux-imposter.ts');
  let agent: ReturnType<typeof createPinnedHttpsAgent> | undefined;
  let positiveAgent: ReturnType<typeof createPinnedHttpsAgent> | undefined;
  let primaryError: unknown;
  try {
    assert.equal((await nextMessage(daemon)).ready, true);
    const discovery = readDiscoveryRecord(f.stateDir);
    assert.equal(discovery.pid, daemon.child.pid);
    assert.notEqual(daemon.child.pid, imposter.child.pid);
    const token = fs.readFileSync(path.join(f.stateDir, 'bootstrap.token'), 'utf8');
    agent = createPinnedHttpsAgent(discovery.cert_pem);
    const url = `https://127.0.0.1:${discovery.port}/control/v1/status`;
    assert.equal((await sendSecureArloRequest({ url, agent, token })).status, 200);
    await stop(daemon);
    assert.equal((await nextMessage(imposter, { command: 'listen', port: discovery.port })).ready, true);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(sendSecureArloRequest({
        url, agent, token, body: 'CANARY-private-message-body', timeoutMs: 3000,
      }), { code: 'PINNED_CERT_MISMATCH' });
    }
    const negative = await nextMessage(imposter, { command: 'inspect' });
    assert.equal(negative.requests, 0);
    assert.equal(negative.plaintextBytes, 0, 'Neither authorization headers nor message body may reach the peer');
    positiveAgent = createPinnedHttpsAgent(IMPOSTER_CERT);
    await sendSecureArloRequest({ url, agent: positiveAgent, body: 'public-counter-control' });
    const positive = await nextMessage(imposter, { command: 'inspect' });
    assert.equal(positive.requests, 1);
    assert.ok(positive.plaintextBytes > 0, 'The peer must actually observe accepted plaintext');
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    agent?.destroy();
    positiveAgent?.destroy();
    const cleanup = await Promise.allSettled([stop(daemon), stop(imposter)]);
    const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    try { removeTempDir(f.root); } catch (error) { errors.push(error); }
    if (errors.length) {
      if (primaryError) errors.unshift(primaryError);
      throw new AggregateError(errors, errors.map(error => String(error)).join('\n'), { cause: primaryError });
    }
  }
});

test('Windows real daemon keeps state and rotated audit logs SID-private and excludes request canaries', windows, async () => {
  const f = fixture();
  const canary = `CANARY-body-token-path-${crypto.randomUUID()}`;
  const daemon = launch(f, undefined, { DEBUG: '*' });
  let agent: ReturnType<typeof createPinnedHttpsAgent> | undefined;
  const maxLogBytes = 10 * 1024 * 1024;
  const fields = new Set(['time', 'event', 'daemon_id', 'request_id', 'status', 'bytes', 'duration_ms']);
  const assertPrivate = (files: string[]) => {
    const inspections = inspectWindowsAclBatch(files);
    const sid = getCurrentUserSid();
    assert.match(sid, /^S-1-/);
    for (const file of files) {
      assert.equal(verifyWindowsAcl(file, inspections[file]).valid, true, path.basename(file));
      assert.ok(inspections[file].rules.length > 0);
      assert.ok(inspections[file].rules.every(rule => rule.startsWith(`${sid}:Allow:`)),
        `Only the native current-user SID may have an allow rule: ${path.basename(file)}`);
    }
  };
  let secrets: string[] = [];
  let daemonId: string | undefined;
  const assertLog = (text: string) => {
    for (const secret of secrets) assert.equal(text.includes(secret), false, 'Audit output contains a canary or credential');
    const entries = text.trim().split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.ok(Object.keys(entry).every(key => fields.has(key)));
      assert.equal(entry.daemon_id, daemonId);
      assert.ok(Number.isFinite(Date.parse(entry.time)));
      assert.ok(typeof entry.bytes === 'number' && entry.bytes >= 0);
      assert.ok(typeof entry.duration_ms === 'number' && entry.duration_ms >= 0);
      if (entry.request_id) assert.match(entry.request_id, /^[0-9a-f-]{36}$/);
    }
    return entries;
  };
  try {
    assert.equal((await nextMessage(daemon)).ready, true);
    const discovery = readDiscoveryRecord(f.stateDir);
    daemonId = discovery.daemon_id;
    const token = fs.readFileSync(path.join(f.stateDir, 'bootstrap.token'), 'utf8').trim();
    secrets = [canary, token, f.root, fs.readFileSync(path.join(f.stateDir, 'daemon.key'), 'utf8')];
    assertPrivate([f.stateDir, ...['daemon.lock', 'discovery.json', 'daemon.crt', 'daemon.key', 'bootstrap.token', 'daemon.log']
      .map(name => path.join(f.stateDir, name))]);
    const client = new DaemonClient({ stateDir: f.stateDir });
    assert.equal((await client.getStatus()).pid, daemon.child.pid);
    assert.equal((await client.getDoctor()).overall_status, 'healthy');
    agent = createPinnedHttpsAgent(discovery.cert_pem);
    const base = `https://127.0.0.1:${discovery.port}`;
    const registration = `${base}/control/v1/runtimes/register?path=${canary}`;
    const registered = await sendSecureArloRequest({
      url: registration, agent, token, body: JSON.stringify({ host_type: canary, host_version: canary }),
    });
    assert.equal(registered.status, 200);
    secrets.push(JSON.parse(registered.body).runtime_token);
    assert.equal((await sendSecureArloRequest({
      url: registration, agent, token: canary, body: JSON.stringify({ display_name: canary }),
    })).status, 401);
    assert.equal((await sendSecureArloRequest({
      url: registration, agent, token, body: `{invalid-${canary}`,
    })).status, 500);
    await assert.rejects(sendSecureArloRequest({
      url: registration, agent, token, body: JSON.stringify({ body: canary.repeat(1800) }),
    }));
    // After malformed and oversized requests the same authenticated daemon
    // remains usable; neither exception details nor user input enter the log.
    assert.equal((await client.getStatus()).daemon_id, daemonId);
    const log = path.join(f.stateDir, 'daemon.log');
    const initial = assertLog(fs.readFileSync(log, 'utf8'));
    for (const event of ['DAEMON_STARTED', 'DIAGNOSTIC_RUN', 'RUNTIME_REGISTERED', 'AUTH_FAILURE', 'ERROR_OCCURRED']) {
      assert.ok(initial.some(entry => entry.event === event), `Missing exercised audit event: ${event}`);
    }
    for (let rotation = 0; rotation < 4; rotation++) {
      // Seed only the byte-size boundary with valid entries. The real daemon
      // must perform each rename, retained-file eviction and SID ACL update.
      const current = fs.readFileSync(log, 'utf8');
      const entry = `${JSON.stringify(initial[0])}\n`;
      const remaining = maxLogBytes - 50 - Buffer.byteLength(current);
      const repeated = entry.repeat(Math.floor(remaining / Buffer.byteLength(entry)));
      fs.appendFileSync(log, repeated + ' '.repeat(remaining - Buffer.byteLength(repeated)));
      await client.getStatus();
      const deadline = Date.now() + 10000;
      while (true) {
        try {
          // Rotation renames the active log before creating its replacement.
          // Observe the size and event from one read of the same file.
          const snapshot = fs.readFileSync(log);
          if (snapshot.length < maxLogBytes - 50 && snapshot.includes('REQUEST_SERVED')) break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        assert.ok(Date.now() < deadline, 'Daemon did not finish audit rotation');
        await delay(20);
      }
    }
    await stop(daemon);
    const names = fs.readdirSync(f.stateDir).filter(name => name.endsWith('.log')).sort();
    assert.deepEqual(names, ['daemon.1.log', 'daemon.2.log', 'daemon.log']);
    for (const name of names) {
      const file = path.join(f.stateDir, name);
      assert.ok(fs.statSync(file).size <= maxLogBytes);
      assertLog(fs.readFileSync(file, 'utf8'));
    }
    assertPrivate(names.map(name => path.join(f.stateDir, name)));
    for (const secret of secrets) assert.equal(daemon.output().includes(secret), false);
    for (const name of ['daemon.lock', 'discovery.json', 'bootstrap.token']) {
      assert.equal(fs.existsSync(path.join(f.stateDir, name)), false, 'Graceful stop removes owned live state');
    }
  } finally {
    agent?.destroy();
    await stop(daemon);
    removeTempDir(f.root);
  }
});

test('Windows real daemon cancels idle exit for an admitted client and releases ownership after disconnect', windows, async () => {
  const f = fixture();
  const daemon = launch(f, undefined, { ARLO_TEST_IDLE_MS: '1500' });
  let socket: net.Socket | undefined;
  try {
    const started = await nextMessage(daemon);
    assert.equal(started.ready, true);
    // A real TCP connection arrives while the daemon's idle exit is armed.
    // No TLS completion or registration is necessary to cancel shutdown.
    socket = net.connect(started.port, '127.0.0.1');
    await once(socket, 'connect');
    await delay(2200);
    assert.equal(daemon.child.exitCode, null);
    assert.equal(readDiscoveryRecord(f.stateDir).daemon_id, started.daemonId);
    socket.destroy();
    await awaitExit(daemon);
    assert.equal(daemon.child.exitCode, 0);
    for (const name of ['daemon.lock', 'discovery.json', 'bootstrap.token']) {
      assert.equal(fs.existsSync(path.join(f.stateDir, name)), false);
    }
    const replacement = launch(f);
    try {
      const restarted = await nextMessage(replacement);
      assert.equal(restarted.ready, true);
      assert.notEqual(restarted.daemonId, started.daemonId);
      assert.equal(readDiscoveryRecord(f.stateDir).pid, replacement.child.pid);
    } finally { await stop(replacement); }
  } finally {
    socket?.destroy();
    await stop(daemon);
    removeTempDir(f.root);
  }
});
