import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  launchClaudeCodeWithSidecar,
  type RunnerLaunchOptions,
  type SpawnedChildProcess,
  type SpawnFunction,
} from '../packages/adapter-claudecode/src/runner.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

const sessionId = '2ccf8247-e03e-44aa-b32e-55b87550f677';
const modDirectory = fileURLToPath(new URL('../packages/adapter-claudecode/mod', import.meta.url));

class MockChild extends EventEmitter implements SpawnedChildProcess {
  pid = 1234;
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  connected = true;
  shutdownRequested = false;

  readonly command: string;
  readonly args: string[];
  readonly options: Parameters<SpawnFunction>[2];

  constructor(command: string, args: string[], options: Parameters<SpawnFunction>[2]) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
  }

  finish(code: number | null = 0, signal: string | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  kill(signal = 'SIGTERM'): boolean {
    this.killed = true;
    this.finish(null, signal);
    return true;
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    if ((message as { type?: string }).type === 'shutdown') {
      this.shutdownRequested = true;
      this.finish();
    }
    callback?.(null);
    return true;
  }
}

function fixture(config: { version?: string; hangVersion?: boolean; hangSidecar?: boolean; failHost?: boolean; failVersion?: boolean; noAttachment?: boolean; failReplacement?: boolean } = {}) {
  const children: MockChild[] = [];
  const spawnFn: SpawnFunction = (command, args, options) => {
    const child = new MockChild(command, args, options);
    children.push(child);
    const sidecarLaunch = String(args[0] ?? '').includes('sidecar-cli');
    const versionProbe = args[0] === '--version';
    const hostLaunch = !sidecarLaunch && !versionProbe;
    setImmediate(() => {
      if (versionProbe && config.failVersion || hostLaunch && config.failHost) {
        child.emit('error', Object.assign(new Error('synthetic spawn failure'), { code: 'ENOENT' }));
        child.emit('close', -1, null);
        return;
      }
      child.emit('spawn');
      if (versionProbe && !config.hangVersion) {
        child.stdout.emit('data', Buffer.from((config.version ?? '2.1.296 (Claude Code)') + '\n'));
        child.finish();
      } else if (sidecarLaunch) {
        const replacement = children.filter(item => String(item.args[0] ?? '').includes('sidecar-cli')).length > 1;
        if (replacement && config.failReplacement) {
          child.finish(1);
          return;
        }
        if (!config.hangSidecar || replacement) {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'ready', port: 54321, url: 'http://127.0.0.1:54321', token: 'synthetic-sidecar-token' }) + '\n'));
          if (replacement && !config.noAttachment) {
            child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'attached', sessionId }) + '\n'));
          }
        }
      } else if (hostLaunch && !config.noAttachment) {
        children.find(item => String(item.args[0] ?? '').includes('sidecar-cli'))
          ?.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'attached', sessionId }) + '\n'));
      }
    });
    return child;
  };
  const launch = (overrides: Partial<RunnerLaunchOptions> = {}) => launchClaudeCodeWithSidecar({
    sessionId, claudeCommand: process.execPath, spawnFn, timeoutMs: 100, ...overrides,
  });
  return { children, launch };
}

test('runner binds the real host session and loads the shipped Mod by default', async (t) => {
  const f = fixture();
  const handle = await f.launch();
  t.after(() => handle.stop());
  const sidecar = f.children[1]!;
  const host = f.children[2]!;
  assert.deepEqual(host.args, ['--session-id', sessionId, '--plugin-dir', modDirectory]);
  assert.equal(host.options.stdio, 'inherit');
  assert.equal(sidecar.command, process.execPath);
  assert.equal(sidecar.options.env?.ARLO_CLAUDECODE_GROUP_NAME, undefined);
  assert.equal(sidecar.options.env?.ARLO_CLAUDECODE_CWD, process.cwd());
  assert.equal(sidecar.options.env?.ARLO_CLAUDECODE_CROSS_HOST_ENABLED, '0');
  assert.equal(sidecar.options.env?.ARLO_CLAUDECODE_BRIDGE_TOKEN, undefined);
  assert.equal(host.options.env?.ARLO_CLAUDECODE_BRIDGE_TOKEN, handle.token);
});

test('runner freezes one launch directory and passes explicit communication preferences', async (t) => {
  const directory = createTempDir('cc-runner-cwd');
  t.after(() => removeTempDir(directory));
  const f = fixture();
  const handle = await f.launch({ cwd: directory, groupName: 'test-group', crossHostEnabled: true });
  t.after(() => handle.stop());
  for (const child of f.children) assert.equal(child.options.cwd, directory);
  assert.equal(f.children[1]!.options.env?.ARLO_CLAUDECODE_CWD, directory);
  assert.equal(f.children[1]!.options.env?.ARLO_CLAUDECODE_GROUP_NAME, 'test-group');
  assert.equal(f.children[1]!.options.env?.ARLO_CLAUDECODE_CROSS_HOST_ENABLED, '1');
});

test('runner preserves compatible plugin arguments without loading Arlo twice', async (t) => {
  const f = fixture();
  const handle = await f.launch({ claudeArgs: ['--session-id', sessionId, '--plugin-dir', modDirectory, '--model', 'haiku'] });
  t.after(() => handle.stop());
  assert.deepEqual(f.children[2]!.args, ['--session-id', sessionId, '--plugin-dir', modDirectory, '--model', 'haiku']);
});

test('runner rejects launch arguments outside the fresh interactive root contract before spawning', async () => {
  for (const args of [
    ['--session-id', '084bcaee-c6e0-46db-865d-677e13b6f8d7'], ['--resume', sessionId], ['--continue'],
    ['-p', 'hello'], ['--print'], ['--input-format', 'stream-json'], ['--output-format=json'], ['--disable-plugins'],
  ]) {
    const f = fixture();
    await assert.rejects(f.launch({ claudeArgs: args }), /session|interactive|plugin/i);
    assert.equal(f.children.length, 0);
  }
  await assert.rejects(fixture().launch({ sessionId: 'not-a-uuid' }), /UUID/);
});

test('runner requires the exact pinned host version', async () => {
  const f = fixture({ version: '2.1.2960 (Claude Code)' });
  await assert.rejects(f.launch(), /2\.1\.296 is required/);
  assert.equal(f.children.length, 1);
});

test('runner kills a timed out version probe', async () => {
  const f = fixture({ hangVersion: true });
  await assert.rejects(f.launch({ timeoutMs: 20 }), /Timeout/);
  assert.equal(f.children[0]!.killed, true);
});

test('runner handles version spawn errors without an unhandled process error', async () => {
  const f = fixture({ failVersion: true });
  await assert.rejects(f.launch(), /synthetic spawn failure/);
  assert.equal(f.children.length, 1);
});

test('runner tears down the Sidecar when startup times out or the host cannot spawn', async () => {
  for (const config of [{ hangSidecar: true }, { failHost: true }]) {
    const f = fixture(config);
    await assert.rejects(f.launch({ timeoutMs: 20 }), /Timeout|synthetic spawn failure/);
    assert.ok(f.children[1]!.shutdownRequested || f.children[1]!.killed);
  }
});

async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Sidecar supervision');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('runner restarts only the Sidecar and keeps the same Claude process', async (t) => {
  const f = fixture();
  const handle = await f.launch({ timeoutMs: 1000 });
  t.after(() => handle.stop());
  const host = f.children[2]!;
  const first = f.children[1]!;
  first.finish(1);
  await until(() => f.children.length >= 4 && f.children[3]!.exitCode === null);
  assert.equal(host.killed, false);
  assert.equal(host.exitCode, null);
  assert.equal(handle.claudeProcess, host);
  assert.equal(handle.sidecarProcess, f.children[3]);
  assert.equal(f.children.filter(child => String(child.args[0] ?? '').includes('sidecar-cli') && child.exitCode === null).length, 1);
});

test('runner cancels Sidecar restart when the Claude process exits', async (t) => {
  const f = fixture();
  const handle = await f.launch({ timeoutMs: 1000 });
  t.after(() => handle.stop());
  f.children[1]!.finish(1);
  f.children[2]!.finish(0);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(f.children.length, 3);
});

test('runner stops Sidecar restarts at the attempt bound and leaves Claude alive', { timeout: 20_000 }, async (t) => {
  const directory = createTempDir('cc-runner-recovery');
  t.after(() => removeTempDir(directory));
  const f = fixture({ failReplacement: true });
  const handle = await f.launch({ timeoutMs: 1000, stateDir: directory });
  t.after(() => handle.stop());
  const host = f.children[2]!;
  f.children[1]!.finish(1);
  await until(() => {
    try {
      return fs.readFileSync(handle.bridgeBootstrapPath!, 'utf8').includes('"exhausted"');
    } catch {
      return false;
    }
  }, 15_000);
  const spawned = f.children.filter(child => String(child.args[0] ?? '').includes('sidecar-cli')).length;
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(f.children.filter(child => String(child.args[0] ?? '').includes('sidecar-cli')).length, spawned);
  assert.equal(spawned, 6);
  assert.equal(host.killed, false);
  assert.equal(host.exitCode, null);
  const record = fs.readFileSync(handle.bridgeBootstrapPath!, 'utf8');
  assert.equal(record.includes('synthetic-sidecar-token'), false);
  assert.match(record, /durable ledger were kept/);
});

test('runner requests graceful Sidecar shutdown when the real host exits', async () => {
  const f = fixture();
  const handle = await f.launch();
  f.children[2]!.finish();
  await handle.stop();
  assert.equal(f.children[1]!.shutdownRequested, true);
});

test('runner does not report success when the Mod never attaches', async () => {
  const f = fixture({ noAttachment: true });
  await assert.rejects(f.launch({ timeoutMs: 20 }), /Timeout.*Mod to attach/);
  assert.equal(f.children[1]!.shutdownRequested, true);
  assert.equal(f.children[2]!.killed, true);
});

test('Windows npm launcher resolves to the native executable without a shell', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = createTempDir('cc-runner-npm');
  t.after(() => removeTempDir(directory));
  const executable = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'synthetic executable, intercepted by the process fixture');
  fs.writeFileSync(path.join(directory, 'claude.cmd'), '@echo off\r\n');
  const f = fixture();
  const handle = await f.launch({ claudeCommand: 'claude', env: { PATH: directory } });
  t.after(() => handle.stop());
  assert.equal(f.children[0]!.command, executable);
  assert.equal(f.children[2]!.command, executable);
});

test('actual Sidecar CLI starts without an explicit group and exits through IPC', { timeout: 10000 }, async (t) => {
  const directory = createTempDir('cc-runner-cli');
  const env = { ...process.env };
  delete env.ARLO_CLAUDECODE_GROUP_NAME;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../packages/adapter-claudecode/src/sidecar-cli.ts', import.meta.url))], {
    cwd: directory,
    env: {
      ...env, ARLO_CLAUDECODE_SESSION_ID: sessionId, ARLO_CLAUDECODE_STATE_DIR: directory,
      ARLO_CLAUDECODE_CWD: directory, ARLO_CLAUDECODE_CROSS_HOST_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    try { await closed; } finally { removeTempDir(directory); }
  });
  let output = '';
  let errors = '';
  child.stderr!.on('data', chunk => { errors += chunk; });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', chunk => {
      output += chunk;
      if (output.includes('"type":"ready"')) resolve();
    });
    void closed.then(code => reject(new Error(`Sidecar exited before ready: ${code}: ${errors}`)), reject);
  });
  await ready;
  // No Mod handshake is sent: this test must not register a root or start a daemon.
  child.send({ type: 'shutdown' });
  assert.equal(await closed, 0);
});
