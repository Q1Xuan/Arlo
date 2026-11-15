import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const cli = path.resolve(process.env.ARLO_DSH_SETUP_CLI ?? 'packages/daemon/bin/arlo.js');

test('DSH preserves another native pnpm profile plugin while registering and removing Arlo', {
  skip: !process.env.ARLO_DSH_SETUP_CONSUMER || !process.env.ARLO_DSH_SETUP_PNPM,
}, () => {
  const consumer = path.resolve(process.env.ARLO_DSH_SETUP_CONSUMER);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-dsh-pnpm-profile-'));
  const profile = path.join(home, 'profiles/web');
  const other = path.join(home, 'user-plugin');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  fs.mkdirSync(other);
  const otherManifest = '{"name":"user-plugin","version":"1.0.0","custom":"preserve"}';
  fs.writeFileSync(path.join(other, 'package.json'), otherManifest);
  const original = { private: true, packageManager: 'pnpm@10.26.2', dependencies: { 'user-plugin': 'link:../../user-plugin' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify(original));
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
  try {
    const installed = spawnSync(process.execPath, [process.env.ARLO_DSH_SETUP_PNPM, 'install', '--ignore-scripts'], { cwd: profile, encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    for (const command of ['setup', 'uninstall']) {
      const result = spawnSync(process.execPath, [process.env.ARLO_DSH_SETUP_CLI ?? cli, command, '--host', 'dsh',
        '--target', path.join(consumer, 'node_modules/@deepseek-ai/dsh'), '--adapter', path.join(consumer, 'node_modules/@arlo/adapter-dsh'),
        '--profile', 'web', '--dsh-home', home, '--apply', '--json'], { encoding: 'utf8', timeout: 180_000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).packageManager.name, 'pnpm');
      assert.equal(fs.realpathSync(path.join(profile, 'node_modules/user-plugin')), other);
      assert.equal(fs.readFileSync(path.join(other, 'package.json'), 'utf8'), otherManifest);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8')), original);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('DSH CLI refuses missing prepared lock and browser resources without changing a profile', {
  skip: !process.env.ARLO_DSH_SETUP_CONSUMER,
}, () => {
  const consumer = path.resolve(process.env.ARLO_DSH_SETUP_CONSUMER);
  const hostRequire = createRequire(path.join(consumer, 'node_modules/@deepseek-ai/dsh/package.json'));
  const asset = path.join(path.dirname(hostRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist/index.html');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-dsh-missing-preparation-'));
  const profile = path.join(home, 'profiles/web');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const original = '{"private":true,"custom":{"preserve":true},"dsh":{"profile":{"bundles":[]}}}';
  fs.writeFileSync(path.join(profile, 'package.json'), original);
  try {
    for (const missing of [path.join(consumer, 'pnpm-lock.yaml'), asset]) {
      const saved = `${missing}.arlo-test-before-missing`;
      fs.renameSync(missing, saved);
      try {
        const result = spawnSync(process.execPath, [process.env.ARLO_DSH_SETUP_CLI ?? cli, 'setup', '--host', 'dsh',
          '--target', path.join(consumer, 'node_modules/@deepseek-ai/dsh'), '--adapter', path.join(consumer, 'node_modules/@arlo/adapter-dsh'),
          '--profile', 'web', '--dsh-home', home, '--apply', '--json'], { encoding: 'utf8' });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.hostPreparation.ready, false);
        assert.match(report.nextStep, /does not patch the host/);
        assert.equal(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), original);
        assert.deepEqual(fs.readdirSync(profile), ['package.json']);
      } finally { fs.renameSync(saved, missing); }
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('DSH CLI registers one local native bundle and safely removes owned profile wiring', {
  skip: !process.env.ARLO_DSH_SETUP_CONSUMER,
}, () => {
  const consumer = path.resolve(process.env.ARLO_DSH_SETUP_CONSUMER);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-dsh-registration-'));
  const profile = path.join(directory, 'profiles', 'web');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const file = path.join(profile, 'package.json');
  const original = { name: 'user-web-profile', private: true, type: 'module', custom: { preserve: true },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
  fs.writeFileSync(file, JSON.stringify(original));
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
  fs.mkdirSync(path.join(directory, 'profiles/other'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'profiles/other/package.json'), '{"custom":"other-profile"}');
  const args = ['--host', 'dsh', '--target', path.join(consumer, 'node_modules/@deepseek-ai/dsh'),
    '--adapter', path.join(consumer, 'node_modules/@arlo/adapter-dsh'), '--profile', 'web', '--dsh-home', directory, '--json'];
  const invoke = (command, apply = false) => {
    const result = spawnSync(process.execPath, [process.env.ARLO_DSH_SETUP_CLI ?? cli, command, ...args, ...(apply ? ['--apply'] : [])], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  try {
    assert.equal(invoke('setup').phase, 'preview');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
    assert.equal(invoke('setup', true).phase, 'configured-pending-start-or-reload');
    assert.equal(invoke('setup', true).phase, 'already-configured-pending-reload');
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(current.dsh.profile.bundles, [...original.dsh.profile.bundles, '@arlo/adapter-dsh']);
    assert.equal(fs.realpathSync(path.join(profile, 'node_modules/@arlo/adapter-dsh')),
      fs.realpathSync(path.join(consumer, 'node_modules/@arlo/adapter-dsh')));
    assert.equal(invoke('setup-status').runtime, 'unobserved');
    current.custom.after = true;
    fs.writeFileSync(file, JSON.stringify(current));
    assert.equal(invoke('uninstall', true).phase, 'removed-pending-reload');
    assert.equal(invoke('uninstall', true).phase, 'already-removed');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...original, custom: { preserve: true, after: true } });
    assert.equal(fs.existsSync(path.join(profile, 'node_modules/@arlo/adapter-dsh')), false);
    assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), '[]\n');
    assert.equal(fs.readFileSync(path.join(directory, 'profiles/other/package.json'), 'utf8'), '{"custom":"other-profile"}');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('DSH setup stops before a package plan would prune an existing profile module', {
  skip: !process.env.ARLO_DSH_SETUP_CONSUMER,
}, () => {
  const consumer = path.resolve(process.env.ARLO_DSH_SETUP_CONSUMER);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-dsh-plan-'));
  const profile = path.join(home, 'profiles/web');
  const plugin = path.join(profile, 'node_modules/user-plugin');
  fs.mkdirSync(plugin, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(plugin, 'package.json'), '{"name":"user-plugin","version":"1.0.0"}');
  const original = '{"name":"user-profile","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}';
  fs.writeFileSync(path.join(profile, 'package.json'), original);
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
  try {
    const result = spawnSync(process.execPath, [process.env.ARLO_DSH_SETUP_CLI ?? cli, 'setup', '--host', 'dsh',
      '--target', path.join(consumer, 'node_modules/@deepseek-ai/dsh'), '--adapter', path.join(consumer, 'node_modules/@arlo/adapter-dsh'),
      '--profile', 'web', '--dsh-home', home, '--apply', '--json'], { encoding: 'utf8' });
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 1, JSON.stringify({ status: result.status, error: report.error, phase: report.phase }));
    assert.equal(report.error, 'PROFILE_PACKAGE_CHANGE_CONFLICT');
    assert.equal(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), original);
    assert.equal(fs.existsSync(path.join(plugin, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(profile, 'node_modules/@arlo/adapter-dsh')), false);
    assert.equal(fs.existsSync(path.join(profile, 'arlo-setup/dsh.json')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('DSH setup requires an explicit profile before any installation or configuration mutation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-dsh-profile-'));
  try {
    const result = spawnSync(process.execPath, [cli, 'setup', '--host', 'dsh', '--target', path.join(directory, 'missing'),
      '--adapter', path.join(directory, 'missing-adapter'), '--dsh-home', directory, '--apply', '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.error, 'PROFILE_SELECTION_REQUIRED');
    assert.match(report.nextStep, /--profile/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a prepared DSH host stays ready when the new adapter has not yet been consumed', {
  skip: !process.env.ARLO_DSH_SETUP_CONSUMER,
}, () => {
  const consumer = path.resolve(process.env.ARLO_DSH_SETUP_CONSUMER);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-dsh-host-ready-'));
  const profile = path.join(directory, 'profiles', 'web');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), '{"private":true,"dsh":{"profile":{"bundles":[]}}}');
  const link = path.join(consumer, 'node_modules/@arlo/adapter-dsh');
  const saved = `${link}.arlo-before-first-setup`;
  fs.renameSync(link, saved);
  try {
    const result = spawnSync(process.execPath, [cli, 'setup-status', '--host', 'dsh', '--target', path.join(consumer, 'node_modules/@deepseek-ai/dsh'),
      '--adapter', path.join(directory, 'missing-adapter'), '--profile', 'web', '--dsh-home', directory, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.error, 'ADAPTER_NOT_FOUND');
    assert.equal(report.hostPreparation.ready, true);
    assert.equal(report.hostPreparation.requiredContracts.scope, 'host-preparation');
    assert.equal(report.hostPreparation.hostSupportPolicy, 'formal');
    assert.ok(report.hostPreparation.dependencyClosure.installedPackages > 100);
    assert.deepEqual(fs.readdirSync(profile), ['package.json']);
  } finally { fs.renameSync(saved, link); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('DSH setup refuses a missing selected profile without initializing it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-dsh-missing-profile-'));
  const source = process.env.ARLO_DSH_SETUP_CONSUMER ?? path.resolve('.artifacts/dsh-rc5/consumer');
  try {
    const result = spawnSync(process.execPath, [cli, 'setup', '--host', 'dsh', '--target', path.join(source, 'node_modules/@deepseek-ai/dsh'),
      '--adapter', path.join(source, 'node_modules/@arlo/adapter-dsh'), '--profile', 'my-existing-profile', '--dsh-home', directory,
      '--apply', '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.error, 'PROFILE_NOT_FOUND');
    assert.match(report.nextStep, /profile/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
