import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCliProcessFixture } from './fixtures/cli-process.mjs';
import { cliProcess, commandProcess, componentDistribution } from './fixtures/pi-component-distribution.mjs';

const cli = process.env.ARLO_CLI_ENTRY;
const host = process.env.ARLO_PI_SETUP_HOST;
const bundle = process.env.ARLO_PI_SETUP_BUNDLE;
const available = cli && host && bundle;
const driver = fileURLToPath(new URL('./fixtures/cli-terminal.py', import.meta.url));
const terminal = (args, steps, context) => commandProcess('python3', [driver, JSON.stringify([process.execPath, cli, ...args]), JSON.stringify(steps), '100'], context);
function physical(from, name) {
  const require = createRequire(path.join(from, 'package.json'));
  return fs.realpathSync(require.resolve.paths(name).map(directory => path.join(directory, name))
    .find(directory => fs.existsSync(path.join(directory, 'package.json'))));
}

test('compiled CLI installs a coordinated durable component batch into an existing Pi and recovers it across cache changes', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-pi-auto-install-');
  const distribution = await componentDistribution(bundle);
  const agentDir = path.join(context.directory, 'agent');
  fs.mkdirSync(agentDir, { mode: 0o700 });
  const original = { theme: 'dark', privateValue: 'DO_NOT_PRINT_CONFIG', packages: [], retained: { history: true } };
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify(original));
  const npmrc = path.join(context.directory, 'npmrc');
  fs.writeFileSync(npmrc, `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = npmrc;
  context.env.npm_config_cache = path.join(context.directory, 'cache-one');
  const target = fs.realpathSync(host);
  const hostBefore = fs.readFileSync(path.join(target, 'package.json'), 'utf8');
  const args = ['--host', 'pi', '--target', target, '--agent-dir', agentDir, '--json'];
  try {
    const preview = await cliProcess(cli, ['setup', ...args], context);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    const plan = JSON.parse(preview.stdout);
    assert.equal(plan.phase, 'preview');
    assert.equal(plan.components.state, 'planned');
    assert.equal(fs.existsSync(plan.components.directory), false, 'preview leaves durable target untouched');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')), original);
    const applied = await cliProcess(cli, ['setup', ...args, '--apply'], context);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const report = JSON.parse(applied.stdout);
    assert.equal(report.phase, 'configured-pending-start-or-reload');
    assert.equal(report.components.state, 'installed');
    assert.ok(report.adapter.directory.startsWith(path.join(context.directory, 'arlo', 'installations')));
    assert.equal(report.adapter.directory.includes('cache-one'), false);
    for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
      assert.equal(physical(report.adapter.directory, name), name.endsWith('pi-coding-agent') ? target : physical(target, name));
    }
    context.env.npm_config_cache = path.join(context.directory, 'cache-two');
    const status = await cliProcess(cli, ['setup-status', ...args], context);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).adapter.directory, report.adapter.directory);
    assert.equal(JSON.parse(status.stdout).phase, 'pending-start-or-reload');
    const repeat = await cliProcess(cli, ['setup', ...args, '--apply'], context);
    assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
    assert.equal(JSON.parse(repeat.stdout).phase, 'already-configured-pending-reload');
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(settings.packages.length, 1);
    assert.deepEqual({ ...settings, packages: [] }, original);
    assert.equal(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), hostBefore);
    assert.equal(applied.stdout.includes('DO_NOT_PRINT_CONFIG'), false);
  } finally { await distribution.close(); context.close(); }
});

test('terminal discovery lists physical Pi installations and the default menu installs only the explicitly selected host', {
  skip: !available || process.platform === 'win32',
}, async () => {
  const context = createCliProcessFixture('arlo-pi-discovery-');
  const distribution = await componentDistribution(bundle);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  const bins = path.join(context.directory, 'bin');
  fs.mkdirSync(bins);
  const target = fs.realpathSync(host);
  const bin = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).bin.pi;
  fs.symlinkSync(path.join(target, bin), path.join(bins, 'pi'));
  context.env.PATH = `${bins}${path.delimiter}${context.env.PATH}`;
  const other = process.env.ARLO_PI_SETUP_PNPM_HOST;
  if (other) {
    const secondBin = path.join(context.directory, 'second-bin');
    fs.mkdirSync(secondBin);
    const pkg = JSON.parse(fs.readFileSync(path.join(other, 'package.json'), 'utf8'));
    fs.symlinkSync(path.join(other, pkg.bin.pi), path.join(secondBin, 'pi'));
    context.env.PATH = `${secondBin}${path.delimiter}${context.env.PATH}`;
  }
  try {
    const result = await terminal(['setup', '--host', 'pi', '--agent-dir', context.directory], [['Choose installed Pi', '0\n']], context);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Existing Pi installations/);
    assert.ok(result.stdout.includes(target), result.stdout);
    if (other) { assert.ok(result.stdout.includes(fs.realpathSync(other)), result.stdout); assert.match(result.stdout, /  2\./); }
    assert.match(result.stdout, /npm/);
    assert.match(result.stdout, /Cancelled/);
    assert.equal(fs.existsSync(path.join(context.directory, 'arlo')), false);
    assert.equal(fs.existsSync(path.join(context.directory, 'settings.json')), false);
    const selected = await terminal(['--agent-dir', context.directory],
      [['Choose an action', '1\n'], ['Host to connect', 'pi\n'], ['Choose installed Pi', '1\n'],
        ['Apply this installation', 'y\n']], context);
    assert.equal(selected.status, 0, selected.stdout + selected.stderr);
    assert.match(selected.stdout, /"phase": "configured-pending-start-or-reload"/);
    const declaration = JSON.parse(fs.readFileSync(path.join(context.directory, 'settings.json'), 'utf8')).packages;
    assert.equal(declaration.length, 1);
    assert.equal(physical(path.resolve(context.directory, declaration[0]), '@earendil-works/pi-coding-agent'), target,
      'the chosen npm installation is used even when another physical Pi launcher appears first in PATH');
    const noninteractive = await cliProcess(cli, ['setup', '--host', 'pi', '--json'], context);
    assert.equal(noninteractive.status, 1);
    assert.equal(JSON.parse(noninteractive.stdout).error, 'HOST_SELECTION_REQUIRED');
  } finally { await distribution.close(); context.close(); }
});

test('compiled CLI consumes through the exact pnpm owner and shares its virtual-store peers without changing that host', {
  skip: !available || !process.env.ARLO_PI_SETUP_PNPM_HOST,
}, async () => {
  const context = createCliProcessFixture('arlo-pi-pnpm-install-');
  const distribution = await componentDistribution(bundle);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  context.env.npm_config_cache = path.join(context.directory, 'npm-cache');
  const target = fs.realpathSync(process.env.ARLO_PI_SETUP_PNPM_HOST);
  const before = fs.readFileSync(path.join(target, 'package.json'), 'utf8');
  try {
    const result = await cliProcess(cli, ['setup', '--host', 'pi', '--target', target, '--agent-dir', context.directory, '--apply', '--json'], context);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.components.manager.name, 'pnpm');
    assert.equal(report.components.manager.version, '10.26.2');
    for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
      assert.equal(physical(report.adapter.directory, name), name.endsWith('pi-coding-agent') ? target : physical(target, name));
    }
    assert.equal(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), before);
    assert.equal(report.hostRuntime.state, 'unobserved');
  } finally { await distribution.close(); context.close(); }
});

test('installation preview and cancellation, EOF or interrupt preserve the selected native settings and durable component target', {
  skip: !available || process.platform === 'win32',
}, async () => {
  const context = createCliProcessFixture('arlo-pi-confirmation-');
  const distribution = await componentDistribution(bundle);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  const original = '{"packages":["other-plugin"],"private":"PRESERVE_PRIVATE_CONFIGURATION"}';
  fs.writeFileSync(path.join(context.directory, 'settings.json'), original);
  try {
    for (const answer of ['n\n', '\x04', '\x03']) {
      const result = await terminal(['setup', '--host', 'pi', '--target', host, '--agent-dir', context.directory],
        [['Apply this installation', answer]], context);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /"phase": "preview"/);
      assert.match(result.stdout, /"phase": "cancelled"/);
      assert.match(result.stdout, /@arlo\/adapter-pi/);
      assert.ok(result.stdout.includes(fs.realpathSync(host)), result.stdout);
      assert.equal(fs.readFileSync(path.join(context.directory, 'settings.json'), 'utf8'), original);
      assert.equal(fs.existsSync(path.join(context.directory, 'arlo')), false);
      assert.equal(result.stdout.includes('PRESERVE_PRIVATE_CONFIGURATION'), false);
    }
  } finally { await distribution.close(); context.close(); }
});

test('missing coordinated release components fail acquisition before durable installation or native registration', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-pi-missing-components-');
  const distribution = await componentDistribution(bundle);
  distribution.packages.delete('@arlo/adapter-sdk');
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  try {
    const result = await cliProcess(cli, ['setup', '--host', 'pi', '--target', host, '--agent-dir', context.directory, '--apply', '--json'], context);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).error, 'COMPONENT_PLAN_FAILED');
    assert.equal(fs.existsSync(path.join(context.directory, 'arlo')), false);
    assert.equal(fs.existsSync(path.join(context.directory, 'settings.json')), false);
  } finally { await distribution.close(); context.close(); }
});

test('a standard dependency plan containing an uncoordinated component is rejected before any durable or native change', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-pi-component-plan-conflict-');
  const distribution = await componentDistribution(bundle);
  const sdk = distribution.packages.get('@arlo/sdk');
  sdk.manifest.dependencies = { ...sdk.manifest.dependencies, '@arlo/out-of-batch': '0.1.0' };
  distribution.packages.set('@arlo/out-of-batch', { bytes: sdk.bytes, name: 'out-of-batch',
    manifest: { name: '@arlo/out-of-batch', version: '0.1.0', dependencies: {} } });
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  try {
    const result = await cliProcess(cli, ['setup', '--host', 'pi', '--target', host,
      '--agent-dir', context.directory, '--apply', '--json'], context);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).error, 'COMPONENT_PLAN_CONFLICT');
    assert.equal(fs.existsSync(path.join(context.directory, 'arlo')), false);
    assert.equal(fs.existsSync(path.join(context.directory, 'settings.json')), false);
  } finally { await distribution.close(); context.close(); }
});

test('component consumption failure reports partial state, keeps native registration absent and retries the owned resource accurately', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-pi-component-retry-');
  const distribution = await componentDistribution(bundle);
  const adapterPackage = distribution.packages.get('@arlo/adapter-pi');
  adapterPackage.unavailable = true;
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  context.env.npm_config_cache = path.join(context.directory, 'npm-cache');
  const args = ['--host', 'pi', '--target', host, '--agent-dir', context.directory, '--json'];
  try {
    const absent = await cliProcess(cli, ['setup-status', ...args], context);
    assert.equal(absent.status, 0, absent.stdout + absent.stderr);
    assert.equal(JSON.parse(absent.stdout).components.state, 'missing');
    const failed = await cliProcess(cli, ['setup', ...args, '--apply'], context);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const failure = JSON.parse(failed.stdout);
    assert.equal(failure.error, 'COMPONENT_INSTALL_FAILED');
    assert.equal(failure.components.state, 'partial');
    assert.equal(fs.existsSync(path.join(context.directory, 'settings.json')), false);
    const status = await cliProcess(cli, ['setup-status', ...args], context);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).components.state, 'partial');
    adapterPackage.unavailable = false;
    const retry = await cliProcess(cli, ['setup', ...args, '--apply'], context);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(JSON.parse(retry.stdout).components.directory, failure.components.directory);
    assert.equal(JSON.parse(retry.stdout).phase, 'configured-pending-start-or-reload');
    assert.equal(JSON.parse(fs.readFileSync(path.join(context.directory, 'settings.json'), 'utf8')).packages.length, 1);
  } finally { await distribution.close(); context.close(); }
});

test('native registration failure preserves installed owned components and subsequent user edits while a retry completes the same integration', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-pi-native-retry-');
  const distribution = await componentDistribution(bundle);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  fs.writeFileSync(path.join(context.directory, 'settings.json'), '{"packages":[],"retained":true}');
  const lock = path.join(context.directory, 'settings.json.lock');
  fs.mkdirSync(lock);
  // Keep a competing native owner's lease live while standard package
  // acquisition runs; otherwise a slow registry can make the lock stale.
  const refreshLock = setInterval(() => {
    if (fs.existsSync(lock)) { const now = new Date(); fs.utimesSync(lock, now, now); }
  }, 500);
  const args = ['--host', 'pi', '--target', host, '--agent-dir', context.directory, '--json'];
  try {
    const failed = await cliProcess(cli, ['setup', ...args, '--apply'], context);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const failure = JSON.parse(failed.stdout);
    assert.ok(['HOST_PACKAGE_OPERATION_FAILED', 'REGISTRATION_INCOMPLETE'].includes(failure.error), failed.stdout);
    assert.equal(failure.components.state, 'installed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(context.directory, 'settings.json'), 'utf8')).packages.length, 0);
    fs.rmSync(lock, { recursive: true });
    const settings = JSON.parse(fs.readFileSync(path.join(context.directory, 'settings.json'), 'utf8'));
    settings.afterFailure = true;
    fs.writeFileSync(path.join(context.directory, 'settings.json'), JSON.stringify(settings));
    const status = await cliProcess(cli, ['setup-status', ...args], context);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).phase, 'recovery-required');
    const retry = await cliProcess(cli, ['setup', ...args, '--apply'], context);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(JSON.parse(retry.stdout).components.directory, failure.components.directory);
    const configured = JSON.parse(fs.readFileSync(path.join(context.directory, 'settings.json'), 'utf8'));
    assert.equal(configured.packages.length, 1);
    assert.equal(configured.afterFailure, true);
    assert.equal(configured.retained, true);
  } finally { clearInterval(refreshLock); await distribution.close(); context.close(); }
});

test('a manually registered adapter is reused without acquisition or owned component claims, and a different physical peer is refused', {
  skip: !available || !process.env.ARLO_PI_SETUP_PNPM_HOST,
}, async () => {
  const context = createCliProcessFixture('arlo-pi-preexisting-components-');
  const distribution = await componentDistribution(bundle);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  const owner = path.join(context.directory, 'owner');
  fs.mkdirSync(owner, { mode: 0o700 });
  const target = fs.realpathSync(host);
  const installed = await cliProcess(cli, ['setup', '--host', 'pi', '--target', target, '--agent-dir', owner, '--apply', '--json'], context);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const adapter = JSON.parse(installed.stdout).adapter.directory;
  const manual = path.join(context.directory, 'manual');
  fs.mkdirSync(manual, { mode: 0o700 });
  const original = JSON.stringify({ packages: [path.relative(manual, adapter)], preserve: 'MANUAL_IDENTITY_AND_ALLOWANCE' });
  fs.writeFileSync(path.join(manual, 'settings.json'), original);
  const args = ['--host', 'pi', '--target', target, '--agent-dir', manual, '--apply', '--json'];
  try {
    distribution.packages.clear();
    const preview = await cliProcess(cli, ['setup', '--host', 'pi', '--target', target,
      '--agent-dir', manual, '--json'], context);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    const beforeConfirmation = await cliProcess(cli, ['setup-status', '--host', 'pi', '--target', target,
      '--agent-dir', owner, '--json'], context);
    assert.equal(beforeConfirmation.status, 0, beforeConfirmation.stdout + beforeConfirmation.stderr);
    assert.equal(JSON.parse(beforeConfirmation.stdout).components.references.length, 1);
    const reused = await cliProcess(cli, ['setup', ...args], context);
    assert.equal(reused.status, 0, reused.stdout + reused.stderr);
    assert.equal(JSON.parse(reused.stdout).ownership, 'preexisting');
    assert.equal(fs.existsSync(path.join(manual, 'arlo-setup')), false);
    assert.equal(fs.readFileSync(path.join(manual, 'settings.json'), 'utf8'), original);
    const ownerStatus = await cliProcess(cli, ['setup-status', '--host', 'pi', '--target', target,
      '--agent-dir', owner, '--json'], context);
    assert.equal(ownerStatus.status, 0, ownerStatus.stdout + ownerStatus.stderr);
    assert.equal(JSON.parse(ownerStatus.stdout).components.references.length, 2,
      'an observed manual declaration is a shared use of the existing owned resource, without becoming owned native registration');
    const peerLink = path.resolve(adapter, '../..', '@earendil-works/pi-coding-agent');
    fs.unlinkSync(peerLink);
    fs.symlinkSync(fs.realpathSync(process.env.ARLO_PI_SETUP_PNPM_HOST), peerLink, 'junction');
    const conflict = await cliProcess(cli, ['setup', ...args], context);
    assert.equal(conflict.status, 1);
    assert.equal(JSON.parse(conflict.stdout).error, 'HOST_PEER_CONFLICT');
    assert.equal(fs.readFileSync(path.join(manual, 'settings.json'), 'utf8'), original);
  } finally { await distribution.close(); context.close(); }
});

test('one compiled component release selects Pi 1.1, 1.2 and 1.3 and preserves each exact physical host and peer identity', {
  skip: !available || !process.env.ARLO_PI_SETUP_OLDER_HOSTS,
}, async () => {
  const distribution = await componentDistribution(bundle);
  const context = createCliProcessFixture('arlo-pi-supported-branches-');
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  const hosts = JSON.parse(process.env.ARLO_PI_SETUP_OLDER_HOSTS);
  try {
    for (const version of ['1.1.0', '1.2.0', '1.3.0']) {
      const target = fs.realpathSync(hosts[version]);
      const agentDir = path.join(context.directory, version);
      fs.mkdirSync(agentDir, { mode: 0o700 });
      const result = await cliProcess(cli, ['setup', '--host', 'pi', '--target', target, '--agent-dir', agentDir, '--apply', '--json'], context);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.target.version, version);
      assert.equal(report.components.state, 'installed');
      assert.equal(report.adapter.version, '0.1.0');
      for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
        assert.equal(physical(report.adapter.directory, name), name.endsWith('pi-coding-agent') ? target : physical(target, name));
      }
      assert.equal(report.runtime, 'unobserved');
    }
  } finally { await distribution.close(); context.close(); }
});

test('no discovered candidate permits manual location of the existing Pi bin and rejects an entry redirected outside its package', {
  skip: !available || process.platform === 'win32',
}, async () => {
  const context = createCliProcessFixture('arlo-pi-manual-location-');
  const distribution = await componentDistribution(bundle);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  context.env.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const target = fs.realpathSync(host);
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  try {
    const result = await terminal(['setup', '--host', 'pi', '--agent-dir', context.directory],
      [['Exact installed host', `${path.join(target, manifest.bin.pi)}\n`], ['Apply this installation', 'n\n']], context);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /No verified Pi installation/);
    assert.ok(result.stdout.includes(target), result.stdout);
    assert.match(result.stdout, /"phase": "cancelled"/);
    const wrong = path.join(context.directory, 'wrong-bin');
    fs.mkdirSync(wrong);
    fs.writeFileSync(path.join(wrong, 'package.json'), JSON.stringify({ ...manifest, bin: { pi: 'entry.js' } }));
    const external = path.join(context.directory, 'external.js');
    fs.writeFileSync(external, 'throw new Error("OUTSIDE_PACKAGE_BIN_WAS_EXECUTED");');
    fs.symlinkSync(external, path.join(wrong, 'entry.js'));
    const refused = await cliProcess(cli, ['setup', '--host', 'pi', '--target', wrong, '--agent-dir', context.directory, '--apply', '--json'], context);
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).error, 'HOST_UNSUPPORTED');
    assert.equal(refused.stderr.includes('OUTSIDE_PACKAGE_BIN_WAS_EXECUTED'), false);
    assert.equal(fs.existsSync(path.join(context.directory, 'arlo')), false);
    assert.equal(fs.existsSync(path.join(context.directory, 'settings.json')), false);
  } finally { await distribution.close(); context.close(); }
});

test('npm global discovery uses the actual prefix and coordinated consumption stays in the companion despite npm prefix configuration', {
  skip: !available || !process.env.ARLO_PI_SETUP_GLOBAL_PREFIX,
}, async () => {
  const context = createCliProcessFixture('arlo-pi-global-prefix-');
  const distribution = await componentDistribution(bundle);
  const prefix = process.env.ARLO_PI_SETUP_GLOBAL_PREFIX;
  const target = path.join(prefix, 'lib/node_modules/@earendil-works/pi-coding-agent');
  const manifest = fs.readFileSync(path.join(target, 'package.json'), 'utf8');
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  context.env.npm_config_prefix = prefix;
  context.env.npm_config_global = 'true';
  try {
    const result = await cliProcess(cli, ['setup', '--host', 'pi', '--target', target, '--agent-dir', context.directory, '--apply', '--json'], context);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.components.state, 'installed');
    assert.equal(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), manifest);
    assert.equal(fs.existsSync(path.join(prefix, 'package-lock.json')), false, 'the package tool never plans in the global host owner');
    for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
      assert.equal(physical(report.adapter.directory, name), name.endsWith('pi-coding-agent') ? fs.realpathSync(target) : physical(target, name));
    }
    const discovered = await terminal(['setup', '--host', 'pi', '--agent-dir', context.directory], [['Choose installed Pi', '0\n']], context);
    assert.equal(discovered.status, 0, discovered.stdout + discovered.stderr);
    assert.ok(discovered.stdout.includes(prefix), discovered.stdout);
    assert.match(discovered.stdout, /npm global/);
  } finally { await distribution.close(); context.close(); }
});

test('malformed retained setup records and ambiguous prepared native declarations refuse component plans before durable changes', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-pi-preflight-records-');
  const distribution = await componentDistribution(bundle);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  const args = ['--host', 'pi', '--target', host, '--agent-dir', context.directory, '--apply', '--json'];
  try {
    const installed = await cliProcess(cli, ['setup', ...args], context);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const report = JSON.parse(installed.stdout);
    const recordFile = path.join(context.directory, 'arlo-setup/pi.json');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    const originalSettings = fs.readFileSync(path.join(context.directory, 'settings.json'), 'utf8');
    const componentManifest = fs.readFileSync(path.join(report.components.consumer, 'package.json'), 'utf8');
    for (const edit of [{ owned: 'invalid' }, { phase: 'unrecognized' }, { declaration: 'wrong-declaration' },
      { createdAt: 'unreadable' }, { installation: { id: 'invalid', directory: report.components.directory } }]) {
      fs.writeFileSync(recordFile, JSON.stringify({ ...record, ...edit }));
      const refused = await cliProcess(cli, ['setup', ...args], context);
      assert.equal(refused.status, 1, refused.stdout + refused.stderr);
      assert.equal(JSON.parse(refused.stdout).error, 'SETUP_OWNERSHIP_CONFLICT');
      assert.equal((refused.stdout + refused.stderr).includes('"phase": "preview"'), false, 'invalid ownership cannot authorize even a component apply plan');
      assert.equal(fs.readFileSync(path.join(context.directory, 'settings.json'), 'utf8'), originalSettings);
      assert.equal(fs.readFileSync(path.join(report.components.consumer, 'package.json'), 'utf8'), componentManifest);
    }
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, phase: 'prepared', owned: false }));
    const ambiguous = await cliProcess(cli, ['setup', ...args], context);
    assert.equal(ambiguous.status, 1, ambiguous.stdout + ambiguous.stderr);
    assert.equal(JSON.parse(ambiguous.stdout).error, 'RECOVERY_REVIEW_REQUIRED');
    assert.equal((ambiguous.stdout + ambiguous.stderr).includes('"phase": "preview"'), false);
    assert.equal(fs.readFileSync(path.join(context.directory, 'settings.json'), 'utf8'), originalSettings);
  } finally { await distribution.close(); context.close(); }
});

test('a manually registered compiled adapter with a different release version is refused without claiming or rewriting it', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-pi-manual-release-');
  const distribution = await componentDistribution(bundle);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  const owner = path.join(context.directory, 'owner');
  fs.mkdirSync(owner, { mode: 0o700 });
  try {
    const acquired = await cliProcess(cli, ['setup', '--host', 'pi', '--target', host,
      '--agent-dir', owner, '--apply', '--json'], context);
    assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
    const adapter = JSON.parse(acquired.stdout).adapter.directory;
    const manifestFile = path.join(adapter, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: '0.2.0' }));
    const manual = path.join(context.directory, 'manual');
    fs.mkdirSync(manual, { mode: 0o700 });
    const original = JSON.stringify({ packages: [path.relative(manual, adapter)], retain: true });
    fs.writeFileSync(path.join(manual, 'settings.json'), original);
    distribution.packages.clear();
    const result = await cliProcess(cli, ['setup', '--host', 'pi', '--target', host,
      '--agent-dir', manual, '--apply', '--json'], context);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).error, 'DEPENDENCY_IDENTITY_MISMATCH');
    assert.equal(fs.readFileSync(path.join(manual, 'settings.json'), 'utf8'), original);
    assert.equal(fs.existsSync(path.join(manual, 'arlo-setup')), false);
    assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).version, '0.2.0');
  } finally { await distribution.close(); context.close(); }
});

test('disk status names missing owned component files while preserving native configuration and refusing an unsafe overwrite', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-pi-missing-owned-files-');
  const distribution = await componentDistribution(bundle);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  const args = ['--host', 'pi', '--target', host, '--agent-dir', context.directory, '--json'];
  try {
    const installed = await cliProcess(cli, ['setup', ...args, '--apply'], context);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const report = JSON.parse(installed.stdout);
    const original = fs.readFileSync(path.join(context.directory, 'settings.json'), 'utf8');
    fs.rmSync(physical(report.adapter.directory, '@arlo/sdk'), { recursive: true });
    const status = await cliProcess(cli, ['setup-status', ...args], context);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    const disk = JSON.parse(status.stdout);
    assert.equal(disk.components.state, 'missing');
    assert.equal(disk.components.inventory, 'review-required');
    assert.equal(disk.configured, true);
    assert.equal(disk.phase, 'components-missing');
    assert.equal(disk.runtime, 'unobserved');
    assert.match(disk.nextStep, /review/i);
    const retry = await cliProcess(cli, ['setup', ...args, '--apply'], context);
    assert.equal(retry.status, 1, retry.stdout + retry.stderr);
    assert.equal(JSON.parse(retry.stdout).error, 'COMPONENT_OWNERSHIP_CONFLICT');
    assert.equal(fs.readFileSync(path.join(context.directory, 'settings.json'), 'utf8'), original);
    assert.equal(fs.existsSync(path.join(report.components.consumer, 'node_modules/@arlo/sdk')), false);
  } finally { await distribution.close(); context.close(); }
});
