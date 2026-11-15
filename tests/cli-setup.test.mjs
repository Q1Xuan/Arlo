import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../packages/daemon/bin/arlo.js', import.meta.url));
const run = args => spawnSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8' });

test('CLI setup names a missing exact host and gives a next step without changing user settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-cli-setup-'));
  try {
    const result = run(['setup', '--host', 'pi', '--target', path.join(directory, 'missing'), '--agent-dir', directory]);
    assert.equal(result.status, 1);
    assert.ok(result.stdout, result.stderr || result.error?.message);
    const report = JSON.parse(result.stdout);
    assert.equal(report.error, 'HOST_NOT_FOUND');
    assert.match(report.nextStep, /--target/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('consumed private CLI previews native registration, preserves settings on repeats and removes only owned user wiring', {
  skip: !process.env.ARLO_SETUP_INSTALL_REPORT,
}, () => {
  const installation = JSON.parse(fs.readFileSync(process.env.ARLO_SETUP_INSTALL_REPORT, 'utf8'));
  const installedCli = path.resolve(path.dirname(installation.entries.daemonEntry), '../bin/arlo.js');
  const target = path.resolve(path.dirname(installation.entries.piEntry), '..');
  const adapter = path.resolve(path.dirname(installation.entries.adapterEntry), '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-installed-setup-'));
  const settingsFile = path.join(directory, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', defaultProvider: 'private-provider', packages: [], custom: { keep: true } }));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(project, '.pi'));
  fs.writeFileSync(path.join(project, '.pi/settings.json'), '{"packages":["project-declaration"]}');
  const invoke = (command, apply = false) => {
    const result = spawnSync(process.execPath, [installedCli, command, '--host', 'pi', '--target', target,
      '--adapter', adapter, '--agent-dir', directory, '--json', ...(apply ? ['--apply'] : [])], { encoding: 'utf8', cwd: project });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  try {
    const before = fs.readFileSync(settingsFile, 'utf8');
    assert.equal(invoke('setup').phase, 'preview');
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), before);
    assert.equal(invoke('setup', true).phase, 'configured-pending-start-or-reload');
    assert.equal(invoke('setup', true).phase, 'already-configured-pending-reload');
    assert.equal(invoke('setup-status').runtime, 'unobserved');
    const configured = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(configured.packages.length, 1);
    configured.custom.afterInstall = true;
    fs.writeFileSync(settingsFile, JSON.stringify(configured));
    assert.equal(invoke('uninstall', true).phase, 'removed-pending-reload');
    assert.equal(invoke('uninstall', true).phase, 'already-removed');
    const removed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(removed, { theme: 'dark', defaultProvider: 'private-provider', packages: [], custom: { keep: true, afterInstall: true } });
    assert.equal(fs.readFileSync(path.join(project, '.pi/settings.json'), 'utf8'), '{"packages":["project-declaration"]}');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('consumed CLI preserves preexisting native Pi registration without claiming ownership', {
  skip: !process.env.ARLO_SETUP_INSTALL_REPORT,
}, () => {
  const installation = JSON.parse(fs.readFileSync(process.env.ARLO_SETUP_INSTALL_REPORT, 'utf8'));
  const installedCli = path.resolve(path.dirname(installation.entries.daemonEntry), '../bin/arlo.js');
  const target = path.resolve(path.dirname(installation.entries.piEntry), '..');
  const adapter = path.resolve(path.dirname(installation.entries.adapterEntry), '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-preexisting-setup-'));
  const file = path.join(directory, 'settings.json');
  const original = JSON.stringify({ packages: [path.relative(directory, adapter)], apiKey: 'DO_NOT_PRINT_PRIVATE_SETTINGS' });
  fs.writeFileSync(file, original);
  try {
    for (const command of ['setup', 'uninstall']) {
      const result = spawnSync(process.execPath, [installedCli, command, '--host', 'pi', '--target', target,
        '--adapter', adapter, '--agent-dir', directory, '--apply', '--json'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(JSON.parse(result.stdout).ownership, 'preexisting');
      assert.equal(result.stdout.includes('DO_NOT_PRINT_PRIVATE_SETTINGS'), false);
      assert.equal(fs.readFileSync(file, 'utf8'), original);
    }
    assert.equal(fs.existsSync(path.join(directory, 'arlo-setup')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('unsafe setup metadata location gives a private-directory next step without changing user directory permissions', {
  skip: !process.env.ARLO_SETUP_INSTALL_REPORT || process.platform === 'win32',
}, () => {
  const installation = JSON.parse(fs.readFileSync(process.env.ARLO_SETUP_INSTALL_REPORT, 'utf8'));
  const installedCli = path.resolve(path.dirname(installation.entries.daemonEntry), '../bin/arlo.js');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-unsafe-setup-'));
  const directory = path.join(parent, 'agent');
  fs.mkdirSync(directory);
  fs.chmodSync(directory, 0o775);
  const file = path.join(directory, 'settings.json');
  const original = '{"theme":"dark"}';
  fs.writeFileSync(file, original);
  try {
    const result = spawnSync(process.execPath, [installedCli, 'setup', '--host', 'pi', '--target', path.resolve(path.dirname(installation.entries.piEntry), '..'),
      '--adapter', path.resolve(path.dirname(installation.entries.adapterEntry), '..'), '--agent-dir', directory, '--apply', '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.error, 'UNSAFE_SETUP_RECORD');
    assert.match(report.nextStep, /--agent-dir/);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o775);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
