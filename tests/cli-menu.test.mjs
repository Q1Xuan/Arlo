import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { once } from 'node:events';
import { createCliProcessFixture } from './fixtures/cli-process.mjs';

const cli = process.env.ARLO_CLI_ENTRY ?? fileURLToPath(new URL('../packages/daemon/bin/arlo.js', import.meta.url));
const terminalDriver = fileURLToPath(new URL('./fixtures/cli-terminal.py', import.meta.url));
function terminal(context, args, steps) {
  return spawnSync('python3', [terminalDriver, JSON.stringify([process.execPath, cli, ...args]), JSON.stringify(steps)],
    { cwd: context.directory, env: context.env, encoding: 'utf8', timeout: 15_000 });
}
function invoke(context, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: context.directory, env: context.env,
    encoding: 'utf8', timeout: 10_000 });
}

test('default terminal menu offers the four existing flows and cancel leaves user state untouched', {
  skip: process.platform === 'win32',
}, () => {
  const context = createCliProcessFixture('arlo-cli-menu-');
  try {
    const result = terminal(context, [], [['Choose an action', '0\n']]);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    for (const label of ['Installation / access setup', 'Diagnostic', 'View status', 'Uninstall', 'Cancelled']) {
      assert.ok(result.stdout.includes(label), result.stdout);
    }
    assert.deepEqual(fs.readdirSync(context.directory), []);
  } finally { context.close(); }
});

test('noninteractive default status accepts JSON options and reports an absent Daemon without a menu', () => {
  const context = createCliProcessFixture('arlo-cli-menu-');
  try {
    const result = invoke(context, ['--json', '--state-dir', context.directory]);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), { error: 'DAEMON_NOT_RUNNING' });
    assert.equal(result.stdout, '');
    assert.deepEqual(fs.readdirSync(context.directory), []);
  } finally { context.close(); }
});

test('menu setup and uninstall describe registration scope and reject a missing chosen host without mutations', {
  skip: process.platform === 'win32',
}, () => {
  const context = createCliProcessFixture('arlo-cli-menu-');
  fs.writeFileSync(path.join(context.directory, 'settings.json'), '{"theme":"dark","packages":["other-plugin"]}');
  try {
    for (const [action, scope] of [['1', /registers an existing compiled Arlo adapter/], ['4', /removes the owned host registration/]]) {
      const result = terminal(context, [], [['Choose an action', `${action}\n`], ['Host to connect', 'pi\n'],
        ['Exact installed host', `${path.join(context.directory, 'missing')}\n`],
        ['Installed compiled Arlo adapter', `${path.join(context.directory, 'adapter')}\n`]]);
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.match(result.stdout, scope);
      assert.match(result.stdout, /HOST_NOT_FOUND/);
    }
    assert.deepEqual(fs.readdirSync(context.directory), ['settings.json']);
    assert.equal(fs.readFileSync(path.join(context.directory, 'settings.json'), 'utf8'), '{"theme":"dark","packages":["other-plugin"]}');
  } finally { context.close(); }
});

test('menu cancellation also handles terminal EOF and interrupt without creating state', {
  skip: process.platform === 'win32',
}, () => {
  const context = createCliProcessFixture('arlo-cli-menu-');
  try {
    for (const answer of ['\x04', '\x03']) {
      const result = terminal(context, [], [['Choose an action', answer]]);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /Cancelled/);
      assert.deepEqual(fs.readdirSync(context.directory), []);
    }
  } finally { context.close(); }
});

test('explicit read and registration commands retain structured errors without prompting or changing a target', () => {
  const context = createCliProcessFixture('arlo-cli-menu-');
  try {
    for (const command of ['status', 'doctor']) {
      const result = invoke(context, [command, '--state-dir', context.directory, '--json']);
      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(result.stderr), { error: 'DAEMON_NOT_RUNNING' });
      assert.equal(result.stdout, '');
    }
    for (const command of ['setup', 'setup-status', 'uninstall']) {
      const result = invoke(context, [command, '--host', 'pi', '--target', path.join(context.directory, 'missing'), '--json']);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).error, 'HOST_NOT_FOUND');
    }
    assert.deepEqual(fs.readdirSync(context.directory), []);
  } finally { context.close(); }
});

test('JSON terminal use and explicit terminal commands bypass the menu', {
  skip: process.platform === 'win32',
}, () => {
  const context = createCliProcessFixture('arlo-cli-menu-');
  try {
    for (const args of [['--json'], ['status', '--json']]) {
      const result = terminal(context, [...args, '--state-dir', context.directory], []);
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.deepEqual(JSON.parse(result.stdout), { error: 'DAEMON_NOT_RUNNING' });
      assert.equal(result.stdout.includes('Choose an action'), false);
    }
  } finally { context.close(); }
});

test('serve, direct commands and menu actions observe the same real Daemon and graceful exit', {
  timeout: 25_000, skip: process.platform === 'win32',
}, async () => {
  const context = createCliProcessFixture('arlo-cli-menu-');
  const stateDir = path.join(context.directory, 'state');
  const serve = spawn(process.execPath, [cli, 'serve', '--state-dir', stateDir, '--port', '0'],
    { cwd: context.directory, env: context.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
  let output = '', errors = '';
  const exited = once(serve, 'close');
  serve.stdout.on('data', chunk => { output += chunk; });
  serve.stderr.on('data', chunk => { errors += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Daemon did not start: ${errors}`)), 10_000);
      serve.stdout.on('data', () => {
        if (output.includes('Arlo Daemon started on https://127.0.0.1:')) { clearTimeout(timer); resolve(); }
      });
      serve.once('error', error => { clearTimeout(timer); reject(error); });
      serve.once('exit', () => { clearTimeout(timer); reject(new Error(`Daemon exited before readiness: ${errors}`)); });
    });
    const status = invoke(context, ['status', '--state-dir', stateDir, '--json']);
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(status.stdout);
    assert.equal(report.status, 'ready');
    assert.equal(report.pid, serve.pid);
    assert.ok(report.port > 0);
    const doctor = invoke(context, ['doctor', '--state-dir', stateDir, '--json']);
    assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout);
    assert.equal(JSON.parse(doctor.stdout).overall_status, 'healthy');
    for (const [action, expected] of [['3', 'Arlo Daemon Status:'], ['2', 'Arlo Doctor Diagnostic Report:']]) {
      const result = terminal(context, ['--state-dir', stateDir], [['Choose an action', `${action}\n`]]);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, new RegExp(expected));
      assert.ok(result.stdout.includes(action === '3' ? 'ready' : 'HEALTHY'), result.stdout);
    }
    serve.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, errors);
    assert.match(output, /Shutting down Arlo Daemon/);
    for (const file of ['daemon.lock', 'discovery.json', 'bootstrap.token']) {
      assert.equal(fs.existsSync(path.join(stateDir, file)), false, `${file} remains after graceful exit`);
    }
    const absent = invoke(context, ['status', '--state-dir', stateDir, '--json']);
    assert.equal(absent.status, 1);
    assert.deepEqual(JSON.parse(absent.stderr), { error: 'DAEMON_NOT_RUNNING' });
  } finally {
    if (serve.exitCode === null) { serve.kill('SIGTERM'); await exited; }
    context.close();
  }
});
