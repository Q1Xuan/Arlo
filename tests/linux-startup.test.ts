import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DaemonClient, ControlClient, createPinnedHttpsAgent, sendSecureArloRequest } from '@arlo/sdk';
import { IMPOSTER_CERT } from '../probes/tls-fixtures.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

const cli = fileURLToPath(new URL('../packages/daemon/bin/arlo.js', import.meta.url));
const linux = { skip: process.platform !== 'linux', timeout: 30000 };

function fixture() {
  const root = createTempDir('linux-startup');
  const runtime = path.join(root, 'runtime');
  const state = path.join(root, 'state');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(runtime, { mode: 0o700 });
  fs.mkdirSync(state, { mode: 0o700 });
  fs.mkdirSync(profile, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin', HOME: profile, LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_DATA_HOME: path.join(profile, 'data'),
    XDG_CACHE_HOME: path.join(profile, 'cache'), TMPDIR: profile,
    XDG_RUNTIME_DIR: runtime, XDG_STATE_HOME: state,
  };
  return { root, runtime: path.join(runtime, 'Arlo'), state: path.join(state, 'Arlo'), env };
}

function launch(env: NodeJS.ProcessEnv, args: string[] = []) {
  const child = cp.spawn(process.execPath, [cli, 'serve', ...args], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  return { child, exited, output: () => output };
}

async function ready(server: ReturnType<typeof launch>) {
  const deadline = Date.now() + 10000;
  while (!server.output().includes('Arlo Daemon started')) {
    assert.equal(server.child.exitCode, null, server.output());
    assert.ok(Date.now() < deadline, 'serve startup deadline');
    await delay(20);
  }
}

async function exited(server: ReturnType<typeof launch>) {
  const timeout = new AbortController();
  try {
    await Promise.race([
      server.exited,
      delay(10000, undefined, { signal: timeout.signal }).then(() => {
        throw new Error('CLI exit watchdog expired');
      }),
    ]);
  } finally { timeout.abort(); }
}

async function stop(server: ReturnType<typeof launch>, signal: NodeJS.Signals = 'SIGTERM') {
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill(signal);
  try { await exited(server); }
  catch (error) {
    server.child.kill('SIGKILL');
    await server.exited;
    throw error;
  }
}

test('Linux CLI and SDK share private XDG runtime discovery and persistent audit logs', linux, async () => {
  const f = fixture();
  const server = launch(f.env);
  try {
    await ready(server);
    const client = new DaemonClient({ stateDir: f.runtime });
    const status = await client.getStatus();
    assert.equal(status.pid, server.child.pid);
    assert.equal(status.listener, 'loopback');
    for (const command of ['status', 'doctor']) {
      const result = cp.spawnSync(process.execPath, [cli, command, '--json'], { env: f.env, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.daemon_id, status.daemon_id);
      if (command === 'doctor') assert.equal(report.overall_status, 'healthy');
    }
    for (const dir of [f.runtime, f.state]) {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(dir).uid, process.getuid!());
    }
    for (const name of ['coordination.lock', 'daemon.lock', 'discovery.json', 'daemon.key', 'bootstrap.token']) {
      const stat = fs.statSync(path.join(f.runtime, name));
      assert.equal(stat.mode & 0o777, 0o600, name);
      assert.equal(stat.uid, process.getuid!());
    }
    assert.ok(fs.existsSync(path.join(f.state, 'daemon.log')));
    assert.equal(fs.existsSync(path.join(f.runtime, 'daemon.log')), false);
    await stop(server);
    for (const name of ['daemon.lock', 'discovery.json', 'bootstrap.token']) {
      assert.equal(fs.existsSync(path.join(f.runtime, name)), false);
    }
    assert.ok(fs.readFileSync(path.join(f.state, 'daemon.log'), 'utf8').includes('DAEMON_STOPPED'));
  } finally {
    await stop(server);
    removeTempDir(f.root);
  }
});

test('Linux duplicate startup preserves the winner and SIGKILL permits recovery without trusting stale PID', linux, async () => {
  const f = fixture();
  const first = launch(f.env);
  let replacement: ReturnType<typeof launch> | undefined;
  try {
    await ready(first);
    const discovery = fs.readFileSync(path.join(f.runtime, 'discovery.json'), 'utf8');
    const duplicate = launch(f.env);
    await duplicate.exited;
    assert.equal(duplicate.child.exitCode, 1);
    assert.match(duplicate.output(), /DAEMON_ALREADY_RUNNING/);
    assert.equal(fs.readFileSync(path.join(f.runtime, 'discovery.json'), 'utf8'), discovery);
    await stop(first, 'SIGKILL');
    const lockPath = path.join(f.runtime, 'daemon.lock');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.pid = process.pid; // A live unrelated process must neither block recovery nor be killed.
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    replacement = launch(f.env);
    await ready(replacement);
    const status = await new DaemonClient({ stateDir: f.runtime }).getStatus();
    assert.equal(status.pid, replacement.child.pid);
    assert.notEqual(status.daemon_id, JSON.parse(discovery).daemon_id);
  } finally {
    if (replacement) await stop(replacement);
    await stop(first);
    removeTempDir(f.root);
  }
});

test('Linux serializes daemons that would share the same persistent audit files', linux, async () => {
  const f = fixture();
  const otherRuntime = path.join(f.root, 'other-runtime');
  fs.mkdirSync(otherRuntime, { mode: 0o700 });
  const first = launch(f.env);
  let second: ReturnType<typeof launch> | undefined;
  try {
    await ready(first);
    second = launch({ ...f.env, XDG_RUNTIME_DIR: otherRuntime });
    await exited(second);
    assert.equal(second.child.exitCode, 1);
    assert.match(second.output(), /DAEMON_ALREADY_RUNNING/);
    assert.equal((await new DaemonClient({ stateDir: f.runtime }).getStatus()).pid, first.child.pid);
  } finally {
    if (second) await stop(second);
    await stop(first);
    removeTempDir(f.root);
  }
});

test('Linux requires an existing absolute private XDG runtime directory', linux, async () => {
  const f = fixture();
  f.env.XDG_RUNTIME_DIR = path.join(f.root, 'missing-runtime');
  const server = launch(f.env);
  try {
    await exited(server);
    assert.equal(server.child.exitCode, 1);
    assert.equal(fs.existsSync(f.env.XDG_RUNTIME_DIR), false);
  } finally {
    await stop(server);
    removeTempDir(f.root);
  }
});

test('Linux concurrent manual starts publish exactly one complete discovery record', linux, async () => {
  const f = fixture();
  const servers = Array.from({ length: 3 }, () => launch(f.env));
  try {
    const deadline = Date.now() + 10000;
    while (servers.filter(server => server.child.exitCode !== null).length < 2) {
      if (fs.existsSync(path.join(f.runtime, 'discovery.json'))) {
        const discovery = JSON.parse(fs.readFileSync(path.join(f.runtime, 'discovery.json'), 'utf8'));
        assert.equal(discovery.status, 'ready');
        assert.ok(discovery.cert_pem.startsWith('-----BEGIN CERTIFICATE-----'));
      }
      assert.ok(Date.now() < deadline, 'concurrent startup deadline');
      await delay(20);
    }
    const winners = servers.filter(server => server.child.exitCode === null);
    assert.equal(winners.length, 1);
    await ready(winners[0]);
    const status = await new DaemonClient({ stateDir: f.runtime }).getStatus();
    assert.equal(status.pid, winners[0].child.pid);
    for (const loser of servers.filter(server => server !== winners[0])) {
      assert.equal(loser.child.exitCode, 1);
      assert.match(loser.output(), /DAEMON_ALREADY_RUNNING/);
    }
  } finally {
    await Promise.all(servers.map(server => stop(server)));
    removeTempDir(f.root);
  }
});

test('Linux pins every connection before a separate old-port imposter can receive plaintext', linux, async () => {
  const f = fixture();
  const server = launch(f.env);
  const imposter = cp.fork(fileURLToPath(new URL('./fixtures/linux-imposter.ts', import.meta.url)), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: f.env,
  });
  const imposterExited = once(imposter, 'exit');
  const inspect = async () => {
    const message = once(imposter, 'message');
    imposter.send({ command: 'inspect' });
    return (await message)[0] as { requests: number; plaintextBytes: number; tlsErrors: number };
  };
  let agent: ReturnType<typeof createPinnedHttpsAgent> | undefined;
  let positiveAgent: ReturnType<typeof createPinnedHttpsAgent> | undefined;
  try {
    await ready(server);
    const discovery = JSON.parse(fs.readFileSync(path.join(f.runtime, 'discovery.json'), 'utf8'));
    const token = fs.readFileSync(path.join(f.runtime, 'bootstrap.token'), 'utf8');
    agent = createPinnedHttpsAgent(discovery.cert_pem);
    const url = `https://127.0.0.1:${discovery.port}/control/v1/status`;
    assert.equal((await sendSecureArloRequest({ url, agent, token })).status, 200);
    await stop(server);
    const listening = once(imposter, 'message');
    imposter.send({ command: 'listen', port: discovery.port });
    assert.equal((await listening)[0].ready, true);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(() => sendSecureArloRequest({
        url, agent: agent!, token, body: 'CANARY-secret-body', timeoutMs: 3000,
      }), { code: 'PINNED_CERT_MISMATCH' });
    }
    const observed = await inspect();
    assert.equal(observed.requests, 0);
    assert.equal(observed.plaintextBytes, 0);
    // Positive control proves the separate process and its plaintext counter work.
    positiveAgent = createPinnedHttpsAgent(IMPOSTER_CERT);
    await sendSecureArloRequest({ url, agent: positiveAgent, body: 'public-fixture-control' });
    const positive = await inspect();
    assert.equal(positive.requests, 1);
    assert.ok(positive.plaintextBytes > 0);
  } finally {
    agent?.destroy();
    positiveAgent?.destroy();
    if (imposter.connected) imposter.disconnect();
    if (imposter.exitCode === null && imposter.signalCode === null) imposter.kill();
    await imposterExited;
    await stop(server);
    removeTempDir(f.root);
  }
});

test('Linux normal, diagnostic, debug and rejected requests keep audit logs private and bounded', linux, async () => {
  const f = fixture();
  const canary = 'CANARY-body-name-error-secret';
  const server = launch({ ...f.env, DEBUG: canary });
  let agent: ReturnType<typeof createPinnedHttpsAgent> | undefined;
  try {
    await ready(server);
    const client = new DaemonClient({ stateDir: f.runtime });
    await client.getStatus();
    await client.getDoctor();
    const discovery = JSON.parse(fs.readFileSync(path.join(f.runtime, 'discovery.json'), 'utf8'));
    const token = fs.readFileSync(path.join(f.runtime, 'bootstrap.token'), 'utf8');
    agent = createPinnedHttpsAgent(discovery.cert_pem);
    assert.equal((await sendSecureArloRequest({
      url: `https://127.0.0.1:${discovery.port}/control/v1/runtimes/register`, agent,
      token: canary, body: JSON.stringify({ display_name: canary }),
    })).status, 401);
    const log = path.join(f.state, 'daemon.log');
    const text = fs.readFileSync(log, 'utf8');
    for (const forbidden of [canary, token, f.root]) assert.equal(text.includes(forbidden), false);
    const fields = new Set(['time', 'event', 'daemon_id', 'request_id', 'status', 'bytes', 'duration_ms']);
    for (const line of text.trim().split('\n')) {
      const entry = JSON.parse(line);
      assert.ok(Object.keys(entry).every(key => fields.has(key)));
      assert.equal(entry.daemon_id, discovery.daemon_id);
    }
    for (let rotation = 0; rotation < 4; rotation++) {
      const previousInode = fs.statSync(log).ino;
      fs.truncateSync(log, 10 * 1024 * 1024 - 50);
      await client.getStatus();
      // The response can reach this process before the daemon finishes its
      // synchronous audit write. Wait for the new file and completed entry
      // before filling it again, rather than racing the rotation rename.
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          if (fs.statSync(log).ino !== previousInode &&
              fs.readFileSync(log, 'utf8').trim().split('\n').some(line => {
                try { return JSON.parse(line).event === 'REQUEST_SERVED'; }
                catch { return false; }
              })) break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        assert.ok(Date.now() < deadline, `audit rotation ${rotation + 1} did not complete`);
        await delay(10);
      }
    }
    const names = fs.readdirSync(f.state).filter(name => name.endsWith('.log'));
    assert.deepEqual(names.sort(), ['daemon.1.log', 'daemon.2.log', 'daemon.log']);
    for (const name of names) {
      const stat = fs.statSync(path.join(f.state, name));
      assert.ok(stat.size <= 10 * 1024 * 1024);
      assert.equal(stat.mode & 0o777, 0o600);
    }
  } finally {
    agent?.destroy();
    await stop(server);
    removeTempDir(f.root);
  }
});

test('Linux shutdown does not follow or delete a substituted discovery symlink', linux, async () => {
  const f = fixture();
  const server = launch(f.env);
  try {
    await ready(server);
    const discoveryPath = path.join(f.runtime, 'discovery.json');
    const original = fs.readFileSync(discoveryPath, 'utf8');
    const outside = path.join(f.root, 'foreign-discovery');
    fs.writeFileSync(outside, original, { mode: 0o600 });
    fs.unlinkSync(discoveryPath);
    fs.symlinkSync(outside, discoveryPath);
    await stop(server);
    assert.equal(fs.readFileSync(outside, 'utf8'), original);
    assert.ok(fs.lstatSync(discoveryPath).isSymbolicLink());
  } finally {
    await stop(server);
    removeTempDir(f.root);
  }
});

test('Linux cached SDK clients revalidate file-backed trust before transmitting any plaintext', linux, async () => {
  const f = fixture();
  fs.mkdirSync(f.runtime, { mode: 0o700 });
  const peer = cp.fork(fileURLToPath(new URL('./fixtures/linux-imposter.ts', import.meta.url)), [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: f.env,
  });
  const peerExited = once(peer, 'exit');
  const inspect = async () => {
    const message = once(peer, 'message');
    peer.send({ command: 'inspect' });
    return (await message)[0] as { requests: number; plaintextBytes: number };
  };
  try {
    const listening = once(peer, 'message');
    peer.send({ command: 'listen', port: 0 });
    const port = (await listening)[0].port;
    const discoveryPath = path.join(f.runtime, 'discovery.json');
    const tokenPath = path.join(f.runtime, 'bootstrap.token');
    fs.writeFileSync(discoveryPath, JSON.stringify({
      daemon_id: crypto.randomUUID(), pid: peer.pid, port,
      cert_pem: IMPOSTER_CERT,
      cert_fingerprint: crypto.createHash('sha256').update(new crypto.X509Certificate(IMPOSTER_CERT).raw).digest('hex'),
      protocol_version: '0.1', status: 'ready',
    }), { mode: 0o600 });
    fs.writeFileSync(tokenPath, 'CANARY-cached-bootstrap', { mode: 0o600 });
    const diagnostic = new DaemonClient({ stateDir: f.runtime });
    const control = new ControlClient({ stateDir: f.runtime });
    await diagnostic.getStatus();
    await control.registerRuntime();
    const baseline = await inspect();
    assert.equal(baseline.requests, 2, 'positive control reaches the trusted peer');
    for (const file of [discoveryPath, tokenPath]) {
      fs.chmodSync(file, 0o644);
      try {
        await assert.rejects(() => diagnostic.getStatus(), { code: 'INSECURE_PERMISSIONS' });
        await assert.rejects(() => control.registerRuntime(), { code: 'INSECURE_PERMISSIONS' });
        if (file === discoveryPath) {
          await assert.rejects(() => control.listRoots('CANARY-runtime-token'), { code: 'INSECURE_PERMISSIONS' });
        }
        assert.deepEqual(await inspect(), baseline, 'no new credentials, headers or body reached the peer');
      } finally { fs.chmodSync(file, 0o600); }
    }
  } finally {
    if (peer.connected) peer.disconnect();
    if (peer.exitCode === null && peer.signalCode === null) peer.kill();
    await peerExited;
    removeTempDir(f.root);
  }
});

test('Linux SDK propagates bootstrap permission failures instead of attempting registration', linux, async () => {
  const f = fixture();
  const server = launch(f.env);
  try {
    await ready(server);
    fs.chmodSync(path.join(f.runtime, 'bootstrap.token'), 0o644);
    await assert.rejects(() => new ControlClient({ stateDir: f.runtime }).registerRuntime(), {
      code: 'INSECURE_PERMISSIONS',
    });
  } finally {
    await stop(server);
    removeTempDir(f.root);
  }
});

test('Linux stops communication when private key permissions become unsafe', linux, async () => {
  const f = fixture();
  const server = launch(f.env);
  try {
    await ready(server);
    const client = new DaemonClient({ stateDir: f.runtime });
    await client.getStatus();
    fs.chmodSync(path.join(f.runtime, 'daemon.key'), 0o644);
    await assert.rejects(() => client.getStatus());
    await assert.rejects(() => new DaemonClient({ stateDir: f.runtime }).getStatus());
  } finally {
    await stop(server);
    removeTempDir(f.root);
  }
});

test('Linux stops communication when a runtime file is replaced by a private directory', linux, async () => {
  for (const name of ['coordination.lock', 'daemon.lock', 'discovery.json', 'daemon.crt', 'daemon.key', 'bootstrap.token']) {
    const f = fixture();
    const server = launch(f.env);
    try {
      await ready(server);
      const discovery = JSON.parse(fs.readFileSync(path.join(f.runtime, 'discovery.json'), 'utf8'));
      const token = fs.readFileSync(path.join(f.runtime, 'bootstrap.token'), 'utf8');
      // Explicit trust bypasses SDK file checks so this exercises the server guard.
      const client = new DaemonClient({ discovery, bootstrapToken: token });
      await client.getStatus();
      const target = path.join(f.runtime, name);
      fs.unlinkSync(target);
      fs.mkdirSync(target, { mode: 0o700 });
      await assert.rejects(() => client.getStatus(), name);
    } finally {
      await stop(server);
      removeTempDir(f.root);
    }
  }
});

test('Linux refuses directories in every audit file slot', linux, async () => {
  for (const name of ['daemon.log', 'daemon.1.log', 'daemon.2.log']) {
    const f = fixture();
    fs.mkdirSync(f.state, { mode: 0o700 });
    fs.mkdirSync(path.join(f.state, name), { mode: 0o700 });
    const server = launch(f.env);
    try {
      await exited(server);
      assert.equal(server.child.exitCode, 1);
      assert.match(server.output(), /UNSAFE_LOCATION/);
      assert.equal(fs.existsSync(path.join(f.runtime, 'discovery.json')), false);
    } finally {
      await stop(server);
      removeTempDir(f.root);
    }
  }
});

test('Linux refuses an unsafe audit log without modifying its target', linux, async () => {
  const f = fixture();
  fs.mkdirSync(f.state, { mode: 0o700 });
  const sentinel = path.join(f.root, 'audit-canary');
  fs.writeFileSync(sentinel, 'CANARY-original-content', { mode: 0o600 });
  fs.symlinkSync(sentinel, path.join(f.state, 'daemon.log'));
  const server = launch(f.env);
  try {
    await exited(server);
    assert.equal(server.child.exitCode, 1);
    assert.match(server.output(), /UNSAFE_LOCATION/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'CANARY-original-content');
    assert.equal(fs.existsSync(path.join(f.runtime, 'discovery.json')), false);
  } finally {
    await stop(server);
    removeTempDir(f.root);
  }
});

test('Linux rejects unsafe runtime entries before publishing discovery', linux, async t => {
  for (const scenario of ['open-directory', 'replaceable-parent', 'symlink', 'hardlink', 'open-key', 'unreadable-key']) {
    await t.test(scenario, async () => {
      const f = fixture();
      fs.mkdirSync(f.runtime, { mode: 0o700 });
      const sentinel = path.join(f.root, 'sensitive-canary');
      fs.writeFileSync(sentinel, 'CANARY-do-not-read-or-log', { mode: 0o600 });
      const key = path.join(f.runtime, 'daemon.key');
      if (scenario === 'open-directory') fs.chmodSync(f.runtime, 0o755);
      if (scenario === 'replaceable-parent') fs.chmodSync(path.dirname(f.runtime), 0o777);
      if (scenario === 'symlink') fs.symlinkSync(sentinel, key);
      if (scenario === 'hardlink') fs.linkSync(sentinel, key);
      if (scenario === 'open-key' || scenario === 'unreadable-key') {
        const mode = scenario === 'open-key' ? 0o644 : 0o000;
        fs.writeFileSync(key, 'CANARY-do-not-read-or-log', { mode });
        // Creation is filtered by umask; install the intended unsafe mode.
        fs.chmodSync(key, mode);
      }
      const server = launch(f.env);
      try {
        await exited(server);
        assert.equal(server.child.exitCode, 1, scenario);
        assert.match(server.output(), /INSECURE_PERMISSIONS|UNSAFE_LOCATION/);
        assert.equal(fs.existsSync(path.join(f.runtime, 'discovery.json')), false);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'CANARY-do-not-read-or-log');
        assert.equal(server.output().includes(f.root), false);
        assert.equal(server.output().includes('CANARY'), false);
      } finally {
        await stop(server);
        fs.chmodSync(path.dirname(f.runtime), 0o700);
        fs.chmodSync(f.runtime, 0o700);
        removeTempDir(f.root);
      }
    });
  }
});
