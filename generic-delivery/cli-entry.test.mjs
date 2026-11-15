import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCliProcessFixture } from '../tests/fixtures/cli-process.mjs';

const consumer = process.env.ARLO_CLI_CONSUMER_DIR;
const npx = process.env.ARLO_NPX_CLI;
const terminalDriver = fileURLToPath(new URL('../tests/fixtures/cli-terminal.py', import.meta.url));

test('standard npx executes the installed compiled bin outside the source workspace without installing a host', {
  skip: !consumer || !npx,
}, () => {
  const context = createCliProcessFixture('arlo-npx-');
  const { directory, env } = context;
  const npmrc = path.join(directory, 'npmrc');
  fs.writeFileSync(npmrc, '');
  const globalNpmrc = path.join(directory, 'global-npmrc');
  fs.writeFileSync(globalNpmrc, '');
  Object.assign(env, { NPM_CONFIG_USERCONFIG: npmrc, NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
    NPM_CONFIG_CACHE: path.join(directory, 'cache'), NPM_CONFIG_UPDATE_NOTIFIER: 'false' });
  const argv = [process.execPath, npx, '--offline', '--no', '--loglevel=silent', '--', 'arlo'];
  try {
    const result = spawnSync(argv[0], [...argv.slice(1), '--json', '--state-dir', path.join(directory, 'state')],
      { cwd: consumer, env, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { error: 'DAEMON_NOT_RUNNING' });
    assert.equal(fs.existsSync(path.join(directory, 'state')), false);
    if (process.platform !== 'win32') {
      const cancelled = spawnSync('python3', [terminalDriver, JSON.stringify(argv), JSON.stringify([['Choose an action', '0\n']])],
        { cwd: consumer, env, encoding: 'utf8', timeout: 15_000 });
      assert.equal(cancelled.status, 0, cancelled.stderr + cancelled.stdout);
      assert.match(cancelled.stdout, /Cancelled/);
    }
  } finally { context.close(); }
});

test('installed compiled CLI starts one native Daemon and recovers after its owner crashes', {
  skip: !consumer || !process.env.ARLO_CLI_ENTRY, timeout: 120_000,
}, async () => {
  const context = createCliProcessFixture('arlo-native-cli-');
  // Shell metacharacters are valid state-directory characters on both platforms.
  const stateDir = path.join(context.directory, "state's & daemon");
  const cli = process.env.ARLO_CLI_ENTRY;
  const children = [];
  function launch() {
    const child = spawn(process.execPath, [cli, 'serve', '--state-dir', stateDir, '--port', '0', '--json'],
      { cwd: consumer, env: context.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const closed = once(child, 'close');
    const server = { child, closed, output: () => output, errors: () => errors };
    children.push(server);
    return server;
  }
  async function ready(server) {
    const controller = new AbortController();
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      while (!server.output().includes('Arlo Daemon started on https://127.0.0.1:')) {
        await Promise.race([
          once(server.child.stdout, 'data', { signal }),
          server.closed.then(([code]) => { throw new Error(`CLI exited ${code} before readiness: ${server.errors()}`); }),
        ]);
      }
    } finally { controller.abort(); }
  }
  function invoke(command) {
    const result = spawnSync(process.execPath, [cli, command, '--state-dir', stateDir, '--port', '0', '--json'],
      { cwd: consumer, env: context.env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.ifError(result.error);
    return result;
  }
  try {
    const first = launch();
    await ready(first);
    const status = invoke('status');
    assert.equal(status.status, 0, status.stderr + status.stdout);
    const original = JSON.parse(status.stdout);
    assert.equal(original.status, 'ready');
    assert.equal(original.pid, first.child.pid);
    const duplicate = invoke('serve');
    assert.equal(duplicate.status, 1, duplicate.stderr + duplicate.stdout);
    assert.deepEqual(JSON.parse(duplicate.stderr), { error: 'DAEMON_ALREADY_RUNNING' });
    assert.equal(JSON.parse(invoke('status').stdout).daemon_id, original.daemon_id);

    first.child.kill('SIGKILL');
    await first.closed;
    const replacement = launch();
    await ready(replacement);
    const recovered = invoke('status');
    assert.equal(recovered.status, 0, recovered.stderr + recovered.stdout);
    const current = JSON.parse(recovered.stdout);
    assert.equal(current.status, 'ready');
    assert.equal(current.pid, replacement.child.pid);
    assert.notEqual(current.daemon_id, original.daemon_id);
  } finally {
    for (const server of children) {
      if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
      await server.closed;
    }
    context.close();
  }
});
