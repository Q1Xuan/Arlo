import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCliProcessFixture } from './fixtures/cli-process.mjs';
import { cliProcess, commandProcess, componentDistribution } from './fixtures/pi-component-distribution.mjs';

const cli = process.env.ARLO_CLI_ENTRY;
const bundle = process.env.ARLO_DSH_AUTO_BUNDLE;
const ordinaryHost = process.env.ARLO_DSH_AUTO_PNPM_HOST;
const nativeTools = process.env.ARLO_DSH_AUTO_TEST_TOOLS;
const available = !!cli && !!bundle && !!ordinaryHost;
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const terminalDriver = path.resolve(import.meta.dirname, 'fixtures/cli-terminal.py');
const terminal = (args, steps, context) => commandProcess('python3', [terminalDriver,
  JSON.stringify([process.execPath, cli, ...args]), JSON.stringify(steps), '180'], context, {}, 240_000);

function existingProfile(context) {
  const home = path.join(context.directory, 'dsh-home');
  const profile = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const manifest = { name: 'existing-user-web-profile', private: true, type: 'module', custom: { preserve: true },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
  fs.mkdirSync(path.join(profile, 'history'));
  fs.writeFileSync(path.join(profile, 'history', 'retained.txt'), 'Existing native history remains.\n');
  return { home, profile, manifest };
}

async function ordinaryInstallation(context, manager = 'pnpm') {
  const owner = path.join(context.directory, 'existing-dsh-owner');
  fs.mkdirSync(owner);
  const manifest = {
    name: 'existing-native-dsh-owner', private: true, type: 'module',
    ...(manager === 'pnpm' ? { packageManager: 'pnpm@10.26.2' } : {}),
    dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.5', 'is-number': '7.0.0' }, custom: { preserve: true },
  };
  fs.writeFileSync(path.join(owner, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const npm = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  if (manager === 'npm') {
    const reference = path.resolve(process.env.ARLO_DSH_AUTO_NPM_HOST, '../../../');
    const lock = JSON.parse(fs.readFileSync(path.join(reference, 'package-lock.json'), 'utf8'));
    lock.name = manifest.name; lock.packages[''].name = manifest.name;
    fs.writeFileSync(path.join(owner, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    const result = await commandProcess(process.execPath, [npm, '--global=false', `--prefix=${owner}`, 'ci',
      '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], context,
    { npm_config_cache: process.env.ARLO_DSH_AUTO_NPM_CACHE ?? path.join(context.directory, 'npm-cache') }, 600_000);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return { owner, target: path.join(owner, 'node_modules/@deepseek-ai/dsh') };
  }
  const referenceOwner = path.resolve(ordinaryHost, '../../../');
  // Recreate the retained ordinary installation through its real frozen lock,
  // as npm ci does above. This keeps acceptance on the selected native graph
  // rather than resolving newer unrelated transitives on every test run.
  fs.copyFileSync(path.join(referenceOwner, 'pnpm-lock.yaml'), path.join(owner, 'pnpm-lock.yaml'));
  const referenceRequire = createRequire(path.join(fs.realpathSync(ordinaryHost), 'package.json'));
  const modules = referenceRequire('js-yaml').load(fs.readFileSync(path.join(referenceOwner, 'node_modules/.modules.yaml'), 'utf8'));
  const result = await commandProcess(process.execPath, [npm, '--global=false', `--prefix=${owner}`, 'exec', '--yes',
    '--ignore-scripts', '--package=pnpm@10.26.2', '--', 'pnpm', 'install', '--frozen-lockfile', '--offline', '--ignore-scripts', '--ignore-workspace',
    `--dir=${owner}`, `--store-dir=${path.dirname(modules.storeDir)}`], context, {}, 600_000);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { owner, target: path.join(owner, 'node_modules/@deepseek-ai/dsh') };
}

test('compiled CLI previews exact preparation of an ordinary unprepared rc.5 host and its existing profile', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-dsh-ordinary-preview-');
  const distribution = await componentDistribution(bundle, 'adapter-dsh');
  const selected = existingProfile(context);
  const target = fs.realpathSync(ordinaryHost);
  const owner = path.resolve(ordinaryHost, '../../../');
  const hostRequire = createRequire(path.join(target, 'package.json'));
  const backend = hostRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl');
  const untouched = [path.join(owner, 'package.json'), path.join(owner, 'pnpm-lock.yaml'), backend,
    path.join(selected.profile, 'package.json'), path.join(selected.profile, 'cordis.patch.yml')];
  const before = untouched.map(digest);
  assert.equal(fs.readFileSync(backend, 'utf8').includes('function ownershipOf('), false,
    'acceptance starts from the ordinary published backend, without an Arlo preparation patch');
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  try {
    const result = await cliProcess(cli, ['setup', '--host', 'dsh', '--target', ordinaryHost,
      '--profile', 'web', '--dsh-home', selected.home, '--json', '--experimental'], context, {}, 600_000);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.phase, 'preview');
    assert.equal(report.profile, 'web');
    assert.equal(report.preparation.manager.name, 'pnpm');
    assert.deepEqual(report.preparation.repairs.map(repair => [repair.name, repair.category]), [
      ['dsh-api-session-controller', 'trusted-session-creation'],
      ['dsh-client-ui-conversation', 'browser-submit-preparation'],
      ['dsh-session-persistence-jsonl', 'native-backend-ownership'],
      ['dsh-session-format', 'type-repair'],
      ['dsh-host-open-in-app', 'environment-presentation-repair'],
    ]);
    assert.equal(report.components.packages['@arlo/adapter-dsh'], '0.1.0');
    assert.equal(report.runtime, 'unobserved');
    assert.equal(report.communication, 'unobserved');
    assert.deepEqual(untouched.map(digest), before);
    assert.equal(fs.existsSync(report.components.directory), false);
    assert.equal(fs.existsSync(path.join(selected.profile, 'arlo-setup')), false);
  } finally { await distribution.close(); context.close(); }
});

test('the default CLI menu discovers exact ordinary DSH installations and existing profiles, and cancellation changes neither', {
  skip: !available || !process.env.ARLO_DSH_AUTO_NPM_HOST || process.platform === 'win32',
}, async () => {
  const context = createCliProcessFixture('arlo-dsh-menu-discovery-');
  const selected = existingProfile(context);
  const other = path.join(selected.home, 'profiles', 'personal');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ ...selected.manifest, name: 'other-user-profile' }));
  fs.writeFileSync(path.join(other, 'cordis.patch.yml'), '[]\n');
  const targets = [process.env.ARLO_DSH_AUTO_NPM_HOST, ordinaryHost];
  for (let index = 0; index < targets.length; index++) {
    const binDirectory = path.join(context.directory, `bin-${index}`);
    fs.mkdirSync(binDirectory);
    const manifest = JSON.parse(fs.readFileSync(path.join(targets[index], 'package.json'), 'utf8'));
    fs.symlinkSync(path.join(targets[index], manifest.bin.dsh), path.join(binDirectory, 'dsh'));
    context.env.PATH = `${binDirectory}${path.delimiter}${context.env.PATH}`;
  }
  const untouched = [...targets.map(target => path.join(path.resolve(target, '../../../'), 'package.json')),
    path.join(selected.profile, 'package.json'), path.join(selected.profile, 'cordis.patch.yml'),
    path.join(other, 'package.json'), path.join(other, 'cordis.patch.yml')];
  const before = untouched.map(digest);
  try {
    const cancelledHost = await terminal(['--dsh-home', selected.home],
      [['Choose an action', '1\n'], ['Host to connect', 'dsh\n'], ['Choose installed DSH', '0\n']], context);
    assert.equal(cancelledHost.status, 0, cancelledHost.stdout + cancelledHost.stderr);
    assert.match(cancelledHost.stdout, /Existing DSH installations/);
    for (const target of targets) assert.ok(cancelledHost.stdout.includes(fs.realpathSync(target)), cancelledHost.stdout);
    assert.match(cancelledHost.stdout, /Cancelled/);
    const cancelledProfile = await terminal(['--dsh-home', selected.home],
      [['Choose an action', '1\n'], ['Host to connect', 'dsh\n'], ['Choose installed DSH', '2\n'],
        ['Choose existing DSH profile', '0\n']], context);
    assert.equal(cancelledProfile.status, 0, cancelledProfile.stdout + cancelledProfile.stderr);
    assert.match(cancelledProfile.stdout, /Existing DSH profiles/);
    assert.ok(cancelledProfile.stdout.includes(selected.profile), cancelledProfile.stdout);
    assert.ok(cancelledProfile.stdout.includes(other), cancelledProfile.stdout);
    assert.match(cancelledProfile.stdout, /Cancelled/);
    assert.deepEqual(untouched.map(digest), before);
    assert.equal(fs.existsSync(path.join(context.directory, 'arlo')), false);
    assert.equal(fs.existsSync(path.join(selected.profile, 'arlo-setup')), false);
    const noninteractive = await cliProcess(cli, ['setup', '--host', 'dsh', '--dsh-home', selected.home, '--json'], context);
    assert.equal(noninteractive.status, 1, noninteractive.stdout + noninteractive.stderr);
    assert.equal(JSON.parse(noninteractive.stdout).error, 'HOST_SELECTION_REQUIRED');
  } finally { context.close(); }
});

test('terminal preparation preview names the exact ordinary DSH repairs and cancellation preserves the host and existing profile', {
  skip: !available || process.platform === 'win32',
}, async () => {
  const context = createCliProcessFixture('arlo-dsh-menu-confirmation-');
  const distribution = await componentDistribution(bundle, 'adapter-dsh');
  const selected = existingProfile(context);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  const owner = path.resolve(ordinaryHost, '../../../');
  const untouched = [path.join(owner, 'package.json'), path.join(owner, 'pnpm-lock.yaml'),
    path.join(selected.profile, 'package.json'), path.join(selected.profile, 'cordis.patch.yml')];
  const before = untouched.map(digest);
  try {
    for (const answer of ['n\n', '\x04', '\x03']) {
      const result = await terminal(['setup', '--host', 'dsh', '--target', ordinaryHost,
        '--profile', 'web', '--dsh-home', selected.home, '--experimental'],
      [['Apply this installation', answer]], context);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /"phase": "preview"/);
      assert.match(result.stdout, /"phase": "cancelled"/);
      assert.match(result.stdout, /@arlo\/adapter-dsh/);
      for (const repair of ['trusted-session-creation', 'browser-submit-preparation', 'native-backend-ownership',
        'type-repair', 'environment-presentation-repair']) assert.ok(result.stdout.includes(repair), result.stdout);
      assert.ok(result.stdout.includes(fs.realpathSync(ordinaryHost)), result.stdout);
      assert.ok(result.stdout.includes(selected.profile), result.stdout);
      assert.deepEqual(untouched.map(digest), before);
      assert.equal(fs.existsSync(path.join(context.directory, 'arlo')), false);
      assert.equal(fs.existsSync(path.join(selected.profile, 'arlo-setup')), false);
    }
  } finally { await distribution.close(); context.close(); }
});

test('compiled CLI automatic setup loads through the original native Host/Web route and communicates bidirectionally', {
  skip: !available || !nativeTools || process.platform === 'win32',
}, async () => {
  const context = createCliProcessFixture('arlo-dsh-ordinary-native-');
  const distribution = await componentDistribution(bundle, 'adapter-dsh');
  const selected = existingProfile(context);
  const evidenceRoot = process.env.ARLO_DSH_AUTO_EVIDENCE_ROOT ?? path.join(context.directory, 'native-evidence');
  fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  if (process.env.ARLO_BROWSER_EXECUTABLE) context.env.ARLO_BROWSER_EXECUTABLE = process.env.ARLO_BROWSER_EXECUTABLE;
  try {
    const native = await ordinaryInstallation(context);
    const launcher = path.join(native.owner, 'node_modules/.bin/dsh');
    const bin = JSON.parse(fs.readFileSync(path.join(native.target, 'package.json'), 'utf8')).bin.dsh;
    const binBefore = digest(path.join(native.target, bin));
    const other = path.join(selected.home, 'profiles/personal');
    fs.mkdirSync(other, { mode: 0o700 });
    fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ ...selected.manifest, name: 'other-native-profile' }) + '\n');
    const otherBefore = digest(path.join(other, 'package.json'));
    context.env.PATH = `${path.dirname(launcher)}${path.delimiter}${context.env.PATH}`;
    const menuArgs = ['--dsh-home', selected.home, '--experimental'];
    const applied = await terminal(menuArgs,
      [['Choose an action', '1\n'], ['Host to connect', 'dsh\n'], ['Choose installed DSH', '1\n'],
        ['Choose existing DSH profile', '2\n'], ['Apply this installation', 'y\n']], context);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.match(applied.stdout, /"phase": "configured-pending-start-or-reload"/);
    assert.ok(applied.stdout.includes(native.target), applied.stdout);
    assert.ok(applied.stdout.includes(selected.profile), applied.stdout);
    fs.writeFileSync(path.join(evidenceRoot, 'menu-install-terminal.txt'), applied.stdout);
    fs.writeFileSync(path.join(evidenceRoot, 'menu-install-command.json'), JSON.stringify({ runtime: process.execPath,
      cli, args: menuArgs, nativeLauncher: launcher, selectedPackage: native.target, selectedProfile: selected.profile,
      exit: applied.status, signal: applied.signal }, null, 2) + '\n');
    const status = await cliProcess(cli, ['setup-status', '--host', 'dsh', '--target', native.target,
      '--profile', 'web', '--dsh-home', selected.home, '--json'], context, {}, 600_000);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    const disk = JSON.parse(status.stdout);
    assert.equal(disk.phase, 'pending-start-or-reload');
    assert.equal(disk.runtime, 'unobserved');
    assert.equal(digest(path.join(other, 'package.json')), otherBefore);
    assert.equal(digest(path.join(native.target, bin)), binBefore, 'automatic preparation preserves the original compiled native bin');
    assert.equal(fs.existsSync(launcher), true, 'the original native launcher path remains available');
    const output = path.join(evidenceRoot, 'pnpm-host-web.json');
    const nativeRun = await commandProcess(process.execPath, [path.resolve(import.meta.dirname, '../web/run.mjs'),
      '--consumer', disk.components.consumer, '--selected-host', native.target, '--native-launcher', launcher,
      '--existing-dsh-home', selected.home, '--existing-profile', 'web', '--test-tools', nativeTools,
      '--fixture', path.resolve(import.meta.dirname, '../web/fixture.mjs'),
      '--isolation', path.resolve(import.meta.dirname, '../probes/isolation.mjs'), '--scratch-parent', evidenceRoot,
      '--setup-cli', cli, '--cli-setup', '--retain-access', '--round-trip', '--output', output], context, {}, 600_000);
    assert.equal(nativeRun.status, 0, nativeRun.stdout + nativeRun.stderr);
    const live = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(live.status, 'passed', live.error);
    assert.equal(live.hostRuntime.event, 'arlo-host-loaded');
    assert.equal(live.hostRuntime.runtime.version, process.versions.node);
    assert.equal(live.hostRuntime.adapter, path.join(disk.adapter.directory, 'host.mjs'));
    assert.equal(live.hostRuntime.requiredContracts, 'ready');
    assert.ok(live.roundTrip);
    assert.ok(live.checks.includes('native-dsh-busy-acceptance-claim-model-processing-associated-reply-and-both-status-queries'));
    assert.deepEqual(live.browserErrors, []);
    assert.deepEqual(live.externalBrowserRequests, []);
    assert.equal(digest(path.join(other, 'package.json')), otherBefore);
    assert.equal(fs.readFileSync(path.join(selected.profile, 'history/retained.txt'), 'utf8'), 'Existing native history remains.\n');
  } finally { await distribution.close(); context.close(); }
});

test('compiled CLI applies ordinary rc.5 preparation and registers only the selected existing native profile', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-dsh-ordinary-install-');
  const distribution = await componentDistribution(bundle, 'adapter-dsh');
  const selected = existingProfile(context);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  try {
    const native = await ordinaryInstallation(context);
    const requireBefore = createRequire(path.join(fs.realpathSync(native.target), 'package.json'));
    const backendBefore = requireBefore.resolve('@deepseek-ai/dsh-session-persistence-jsonl');
    assert.equal(fs.readFileSync(backendBefore, 'utf8').includes('function ownershipOf('), false);
    const unrelatedPackage = path.join(native.owner, 'node_modules/is-number/package.json');
    const unrelatedBefore = digest(unrelatedPackage);
    const applied = await cliProcess(cli, ['setup', '--host', 'dsh', '--target', native.target,
      '--profile', 'web', '--dsh-home', selected.home, '--json', '--experimental', '--apply'], context, {}, 600_000);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const report = JSON.parse(applied.stdout);
    assert.equal(report.phase, 'configured-pending-start-or-reload');
    assert.equal(report.preparation.state, 'prepared');
    assert.equal(report.preparation.transaction, 'configured');
    assert.equal(report.components.state, 'installed');
    assert.equal(report.components.transaction, 'configured');
    assert.equal(report.runtime, 'unobserved');
    assert.equal(report.communication, 'unobserved');
    const profileAfter = JSON.parse(fs.readFileSync(path.join(selected.profile, 'package.json'), 'utf8'));
    assert.deepEqual(profileAfter.custom, { preserve: true });
    assert.deepEqual(profileAfter.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@arlo/adapter-dsh']);
    assert.equal(fs.readFileSync(path.join(selected.profile, 'history/retained.txt'), 'utf8'), 'Existing native history remains.\n');
    assert.equal(digest(unrelatedPackage), unrelatedBefore);
    const contract = await commandProcess(process.execPath, ['--input-type=module', '-e',
      'import {createRequire} from "node:module"; import {pathToFileURL} from "node:url"; import fs from "node:fs"; import path from "node:path"; const require=createRequire(path.join(fs.realpathSync(process.argv[1]),"package.json")); const backend=await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-session-persistence-jsonl"))); console.log(typeof backend.ownershipOf);',
      native.target], context);
    assert.equal(contract.status, 0, contract.stdout + contract.stderr);
    assert.equal(contract.stdout.trim(), 'function', 'normal native reload resolves the prepared public backend contract');
    assert.equal(JSON.parse(fs.readFileSync(path.join(native.target, 'package.json'), 'utf8')).version, '0.2.1-rc.5');
    const status = await cliProcess(cli, ['setup-status', '--host', 'dsh', '--target', native.target,
      '--profile', 'web', '--dsh-home', selected.home, '--json'], context, {}, 600_000);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    const disk = JSON.parse(status.stdout);
    assert.equal(disk.phase, 'pending-start-or-reload');
    assert.equal(disk.adapter.directory, report.adapter.directory);
    assert.equal(disk.runtime, 'unobserved');
    assert.equal(disk.preparation.transaction, 'configured');
    assert.equal(disk.components.transaction, 'configured');
    const beforeRepeat = [path.join(report.preparation.directory, 'preparation.json'),
      path.join(report.components.directory, 'components.json')].map(digest);
    const repeat = await cliProcess(cli, ['setup', '--host', 'dsh', '--target', native.target,
      '--profile', 'web', '--dsh-home', selected.home, '--json', '--apply'], context, {}, 600_000);
    assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
    const repeated = JSON.parse(repeat.stdout);
    assert.equal(repeated.phase, 'already-configured-pending-reload');
    assert.equal(repeated.preparation.transaction, 'configured');
    assert.equal(repeated.components.transaction, 'configured');
    assert.deepEqual([path.join(report.preparation.directory, 'preparation.json'),
      path.join(report.components.directory, 'components.json')].map(digest), beforeRepeat);
  } finally { await distribution.close(); context.close(); }
});

test('compiled CLI prepares the exact ordinary local npm DSH owner, shares its physical modules and preserves unrelated locked packages', {
  skip: !available || !process.env.ARLO_DSH_AUTO_NPM_HOST,
}, async () => {
  const context = createCliProcessFixture('arlo-dsh-npm-install-');
  const distribution = await componentDistribution(bundle, 'adapter-dsh');
  const selected = existingProfile(context);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  try {
    const native = await ordinaryInstallation(context, 'npm');
    const hostRequire = createRequire(path.join(native.target, 'package.json'));
    const backend = hostRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl');
    assert.equal(fs.readFileSync(backend, 'utf8').includes('function ownershipOf('), false);
    const bin = JSON.parse(fs.readFileSync(path.join(native.target, 'package.json'), 'utf8')).bin.dsh;
    const binBefore = digest(path.join(native.target, bin));
    const unrelated = path.join(native.owner, 'node_modules/is-number/package.json');
    const unrelatedBefore = digest(unrelated);
    const lockBefore = JSON.parse(fs.readFileSync(path.join(native.owner, 'package-lock.json'), 'utf8'));
    const applied = await cliProcess(cli, ['setup', '--host', 'dsh', '--target', native.target,
      '--profile', 'web', '--dsh-home', selected.home, '--json', '--experimental', '--apply'], context,
    { npm_config_cache: process.env.ARLO_DSH_AUTO_NPM_CACHE ?? path.join(context.directory, 'npm-cache') }, 600_000);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const report = JSON.parse(applied.stdout);
    assert.equal(report.phase, 'configured-pending-start-or-reload');
    assert.equal(report.preparation.manager.name, 'npm');
    assert.equal(report.preparation.transaction, 'configured');
    assert.equal(report.components.manager.name, 'npm');
    assert.equal(report.components.transaction, 'configured');
    assert.equal(report.runtime, 'unobserved');
    assert.equal(report.communication, 'unobserved');
    assert.equal(digest(path.join(native.target, bin)), binBefore);
    assert.equal(digest(unrelated), unrelatedBefore);
    const lockAfter = JSON.parse(fs.readFileSync(path.join(native.owner, 'package-lock.json'), 'utf8'));
    for (const [name, record] of Object.entries(lockBefore.packages)) {
      if (name) assert.deepEqual(lockAfter.packages[name], record, `Existing locked package remains: ${name}`);
    }
    const adapterRequire = createRequire(path.join(report.adapter.directory, 'package.json'));
    for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-session-persistence-jsonl',
      '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-slots']) {
      assert.equal(fs.realpathSync(adapterRequire.resolve(name)), fs.realpathSync(hostRequire.resolve(name)), `Selected native physical module: ${name}`);
    }
    const current = JSON.parse(fs.readFileSync(path.join(selected.profile, 'package.json'), 'utf8'));
    assert.deepEqual(current.custom, selected.manifest.custom);
    assert.deepEqual(current.dsh.profile.bundles, [...selected.manifest.dsh.profile.bundles, '@arlo/adapter-dsh']);
    const status = await cliProcess(cli, ['setup-status', '--host', 'dsh', '--target', native.target,
      '--profile', 'web', '--dsh-home', selected.home, '--json'], context, {}, 600_000);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).phase, 'pending-start-or-reload');
  } finally { await distribution.close(); context.close(); }
});

test('native profile registration failure reports durable recovery and retries the same verified DSH resources while preserving later settings', {
  skip: !available || process.platform !== 'linux',
}, async () => {
  const context = createCliProcessFixture('arlo-dsh-registration-recovery-');
  const distribution = await componentDistribution(bundle, 'adapter-dsh');
  const selected = existingProfile(context);
  const modules = path.join(selected.profile, 'node_modules');
  fs.mkdirSync(modules, { mode: 0o500 });
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  try {
    const native = await ordinaryInstallation(context);
    const args = ['--host', 'dsh', '--target', native.target, '--profile', 'web', '--dsh-home', selected.home, '--json'];
    const failed = await cliProcess(cli, ['setup', ...args, '--experimental', '--apply'], context, {}, 600_000);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const report = JSON.parse(failed.stdout);
    assert.equal(report.error, 'HOST_PACKAGE_OPERATION_FAILED');
    assert.equal(report.transaction, 'prepared');
    // Native npm reports EACCES as -13, observed as the POSIX process exit 243.
    assert.deepEqual(report.failure, { code: 'HOST_PACKAGE_OPERATION_FAILED', exit: 243, signal: null, operation: 'native-install' });
    assert.equal(report.preparation.state, 'prepared');
    assert.equal(report.components.state, 'installed');
    assert.equal(report.components.transaction, 'registration-prepared');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(selected.profile, 'package.json'), 'utf8')), selected.manifest);
    const status = await cliProcess(cli, ['setup-status', ...args], context, {}, 600_000);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    const pending = JSON.parse(status.stdout);
    assert.equal(pending.phase, 'recovery-required');
    assert.equal(pending.transaction, 'prepared');
    assert.deepEqual(pending.failure, report.failure);
    assert.equal(pending.runtime, 'unobserved');
    fs.chmodSync(modules, 0o700);
    const current = JSON.parse(fs.readFileSync(path.join(selected.profile, 'package.json'), 'utf8'));
    current.custom.afterFailedSetup = true;
    fs.writeFileSync(path.join(selected.profile, 'package.json'), JSON.stringify(current, null, 2) + '\n');
    const retried = await cliProcess(cli, ['setup', ...args, '--apply'], context, {}, 600_000);
    assert.equal(retried.status, 0, retried.stdout + retried.stderr);
    const completed = JSON.parse(retried.stdout);
    assert.equal(completed.phase, 'configured-pending-start-or-reload');
    assert.equal(completed.preparation.transaction, 'configured');
    assert.equal(completed.components.transaction, 'configured');
    assert.equal(completed.preparation.directory, report.preparation.directory);
    assert.equal(completed.components.directory, report.components.directory);
    assert.equal(completed.adapter.directory, pending.adapter.directory);
    assert.equal(completed.failure, undefined);
    const after = JSON.parse(fs.readFileSync(path.join(selected.profile, 'package.json'), 'utf8'));
    assert.deepEqual(after.custom, { preserve: true, afterFailedSetup: true });
    assert.deepEqual(after.dsh.profile.bundles, [...selected.manifest.dsh.profile.bundles, '@arlo/adapter-dsh']);
    assert.equal(fs.readFileSync(path.join(selected.profile, 'history/retained.txt'), 'utf8'), 'Existing native history remains.\n');
  } finally {
    if (fs.existsSync(modules)) fs.chmodSync(modules, 0o700);
    await distribution.close(); context.close();
  }
});

test('unavailable compiled components stop DSH preflight before changing its ordinary owner or selected profile', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-dsh-preflight-failure-');
  const distribution = await componentDistribution(bundle, 'adapter-dsh');
  const selected = existingProfile(context);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  try {
    // Keep the real compiled package, with a unique harmless file so an earlier
    // valid pnpm store entry cannot satisfy this acquisition-failure fixture.
    const staging = path.join(context.directory, 'uncached-distribution');
    fs.mkdirSync(staging);
    const unpack = await commandProcess('tar', ['-xzf', path.join(bundle, 'arlo-adapter-dsh-0.1.0.tgz'), '-C', staging], context);
    assert.equal(unpack.status, 0, unpack.stdout + unpack.stderr);
    fs.writeFileSync(path.join(staging, 'package/acquisition-fixture.txt'), path.basename(context.directory) + '\n');
    const archive = path.join(context.directory, 'uncached-adapter.tgz');
    const pack = await commandProcess('tar', ['-czf', archive, '-C', staging, 'package'], context);
    assert.equal(pack.status, 0, pack.stdout + pack.stderr);
    const component = distribution.packages.get('@arlo/adapter-dsh');
    component.bytes = fs.readFileSync(archive);
    component.unavailable = true;
    const native = await ordinaryInstallation(context);
    const require = createRequire(path.join(fs.realpathSync(native.target), 'package.json'));
    const untouched = [path.join(native.owner, 'package.json'), path.join(native.owner, 'pnpm-lock.yaml'),
      path.join(native.owner, 'node_modules/.modules.yaml'), path.join(native.target, 'lib/bin.js'),
      require.resolve('@deepseek-ai/dsh-session-persistence-jsonl'), path.join(selected.profile, 'package.json'),
      path.join(selected.profile, 'cordis.patch.yml'), path.join(selected.profile, 'history/retained.txt')];
    const before = untouched.map(digest);
    const args = ['--host', 'dsh', '--target', native.target, '--profile', 'web', '--dsh-home', selected.home,
      '--experimental', '--json'];
    const failed = await cliProcess(cli, ['setup', ...args, '--apply'], context, {}, 600_000);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const report = JSON.parse(failed.stdout);
    assert.equal(report.error, 'COMPONENT_PREFLIGHT_FAILED');
    assert.deepEqual(untouched.map(digest), before);
    assert.equal(fs.existsSync(path.join(context.directory, 'arlo')), false);
    assert.equal(fs.existsSync(path.join(selected.profile, 'arlo-setup')), false);
    assert.equal(fs.existsSync(path.join(selected.profile, 'node_modules/@arlo/adapter-dsh')), false);
    distribution.packages.get('@arlo/adapter-dsh').unavailable = false;
    const preview = await cliProcess(cli, ['setup', ...args], context, {}, 600_000);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(JSON.parse(preview.stdout).phase, 'preview');
    assert.deepEqual(untouched.map(digest), before);
  } finally { await distribution.close(); context.close(); }
});

test('DSH setup preserves later program edits and refuses ambiguous preparation or component ownership', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-dsh-owned-conflicts-');
  const distribution = await componentDistribution(bundle, 'adapter-dsh');
  const selected = existingProfile(context);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  try {
    const native = await ordinaryInstallation(context);
    const require = createRequire(path.join(fs.realpathSync(native.target), 'package.json'));
    const backend = require.resolve('@deepseek-ai/dsh-session-persistence-jsonl');
    const originalBackend = fs.readFileSync(backend);
    fs.appendFileSync(backend, '\n// Later native program edit retained by the user.\n');
    const originalFiles = [path.join(native.owner, 'package.json'), path.join(native.owner, 'pnpm-lock.yaml'),
      backend, path.join(selected.profile, 'package.json'), path.join(selected.profile, 'cordis.patch.yml'),
      path.join(selected.profile, 'history/retained.txt')];
    const before = originalFiles.map(digest);
    const args = ['--host', 'dsh', '--target', native.target, '--profile', 'web', '--dsh-home', selected.home, '--json'];
    const edited = await cliProcess(cli, ['setup', ...args, '--experimental', '--apply'], context, {}, 600_000);
    assert.equal(edited.status, 1, edited.stdout + edited.stderr);
    assert.equal(JSON.parse(edited.stdout).error, 'DSH_PROGRAM_CHANGE_CONFLICT');
    assert.deepEqual(originalFiles.map(digest), before);
    assert.equal(fs.existsSync(path.join(context.directory, 'arlo')), false);
    fs.writeFileSync(backend, originalBackend);
    const setup = await cliProcess(cli, ['setup', ...args, '--experimental', '--apply'], context, {}, 600_000);
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    const applied = JSON.parse(setup.stdout);
    const preparation = path.join(applied.preparation.directory, 'preparation.json');
    const originalPreparation = fs.readFileSync(preparation);
    const ambiguous = JSON.parse(originalPreparation);
    ambiguous.files[0].owned = 'unverified';
    fs.writeFileSync(preparation, JSON.stringify(ambiguous, null, 2) + '\n');
    const retained = [path.join(native.owner, 'package.json'), path.join(native.owner, 'pnpm-lock.yaml'),
      path.join(selected.profile, 'package.json'), path.join(selected.profile, 'cordis.patch.yml'), preparation,
      path.join(applied.components.directory, 'components.json')];
    let expected = retained.map(digest);
    for (const command of ['setup-status', 'setup']) {
      const rejected = await cliProcess(cli, [command, ...args, ...(command === 'setup' ? ['--apply'] : [])], context, {}, 600_000);
      assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      assert.equal(JSON.parse(rejected.stdout).error, 'DSH_PREPARATION_OWNERSHIP_CONFLICT');
      assert.deepEqual(retained.map(digest), expected);
    }
    fs.writeFileSync(preparation, originalPreparation);
    const component = path.join(applied.adapter.directory, 'host.mjs');
    fs.appendFileSync(component, '\n// Later component edit retained by the user.\n');
    const componentBefore = digest(component);
    expected = retained.map(digest);
    for (const command of ['setup-status', 'setup']) {
      const rejected = await cliProcess(cli, [command, ...args, ...(command === 'setup' ? ['--apply'] : [])], context, {}, 600_000);
      assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      assert.equal(JSON.parse(rejected.stdout).error, 'COMPONENT_OWNERSHIP_CONFLICT');
      assert.deepEqual(retained.map(digest), expected);
      assert.equal(digest(component), componentBefore);
    }
    assert.equal(fs.readFileSync(path.join(selected.profile, 'history/retained.txt'), 'utf8'), 'Existing native history remains.\n');
  } finally { await distribution.close(); context.close(); }
});

test('native DSH preparation failure reports its durable unfinished phase and retries without replacing later owner settings', {
  skip: !available || process.platform !== 'linux',
}, async () => {
  const context = createCliProcessFixture('arlo-dsh-native-preparation-recovery-');
  const distribution = await componentDistribution(bundle, 'adapter-dsh');
  const selected = existingProfile(context);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  let locked, originalMode;
  try {
    const native = await ordinaryInstallation(context);
    locked = path.join(native.owner, 'node_modules/.pnpm');
    originalMode = fs.statSync(locked).mode & 0o777;
    fs.chmodSync(locked, 0o500);
    const bin = path.join(native.target, 'lib/bin.js');
    const binBefore = digest(bin);
    const args = ['--host', 'dsh', '--target', native.target, '--profile', 'web', '--dsh-home', selected.home,
      '--experimental', '--json'];
    const failed = await cliProcess(cli, ['setup', ...args, '--apply'], context, {}, 600_000);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const report = JSON.parse(failed.stdout);
    assert.equal(report.error, 'DSH_NATIVE_PREPARATION_FAILED');
    assert.equal(report.preparation.transaction, 'native-preparing');
    assert.deepEqual(report.preparation.failure, { code: 'PACKAGE_TOOL_FAILED', phase: 'native-preparing', exit: 243, signal: null });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(selected.profile, 'package.json'), 'utf8')), selected.manifest);
    assert.equal(fs.existsSync(path.join(selected.profile, 'node_modules/@arlo/adapter-dsh')), false);
    const status = await cliProcess(cli, ['setup-status', ...args], context, {}, 600_000);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    const pending = JSON.parse(status.stdout);
    assert.equal(pending.phase, 'recovery-required');
    assert.equal(pending.preparation.directory, report.preparation.directory);
    assert.equal(pending.preparation.transaction, 'native-preparing');
    assert.deepEqual(pending.preparation.failure, report.preparation.failure);
    assert.equal(pending.registration.state, 'unobserved');
    assert.equal(pending.configured, undefined);
    assert.equal(pending.runtime, 'unobserved');
    assert.equal(pending.communication, 'unobserved');
    fs.chmodSync(locked, originalMode);
    const owner = path.join(native.owner, 'package.json');
    const current = JSON.parse(fs.readFileSync(owner, 'utf8'));
    current.custom.afterFailedPreparation = true;
    fs.writeFileSync(owner, JSON.stringify(current, null, 2) + '\n');
    // Resolve the actual interrupted native package operation through that
    // owner's standard frozen install, then retry the same compiled CLI.
    const referenceRequire = createRequire(path.join(fs.realpathSync(ordinaryHost), 'package.json'));
    const referenceModules = referenceRequire('js-yaml').load(fs.readFileSync(path.join(path.resolve(ordinaryHost, '../../../'), 'node_modules/.modules.yaml'), 'utf8'));
    const npm = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    const restored = await commandProcess(process.execPath, [npm, '--global=false', `--prefix=${native.owner}`, 'exec', '--yes',
      '--ignore-scripts', '--package=pnpm@10.26.2', '--', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace',
      `--dir=${native.owner}`, `--store-dir=${path.dirname(referenceModules.storeDir)}`], context, {}, 600_000);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    const retry = await cliProcess(cli, ['setup', ...args, '--apply'], context, {}, 600_000);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    const completed = JSON.parse(retry.stdout);
    assert.equal(completed.phase, 'configured-pending-start-or-reload');
    assert.equal(completed.preparation.directory, report.preparation.directory);
    assert.equal(completed.preparation.transaction, 'configured');
    assert.equal(completed.preparation.failure, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(owner, 'utf8')).custom, { preserve: true, afterFailedPreparation: true });
    assert.equal(digest(bin), binBefore);
    assert.equal(fs.readFileSync(path.join(selected.profile, 'history/retained.txt'), 'utf8'), 'Existing native history remains.\n');
  } finally {
    if (locked && fs.existsSync(locked)) fs.chmodSync(locked, originalMode);
    await distribution.close(); context.close();
  }
});

test('an unaudited native npm global DSH owner is diagnosed without changing its prefix, launcher or selected profile', {
  skip: !cli || !process.env.ARLO_DSH_AUTO_GLOBAL_HOST,
}, async () => {
  const context = createCliProcessFixture('arlo-dsh-global-preserved-');
  const selected = existingProfile(context);
  const target = process.env.ARLO_DSH_AUTO_GLOBAL_HOST;
  const modules = path.resolve(target, '../../');
  const launcher = path.join(path.resolve(modules, '../../'), 'bin/dsh');
  const launcherBefore = fs.readlinkSync(launcher);
  const untouched = [path.join(target, 'package.json'), path.join(target, 'lib/bin.js'),
    path.join(modules, 'is-number/package.json'), path.join(selected.profile, 'package.json'),
    path.join(selected.profile, 'history/retained.txt')];
  const before = untouched.map(digest);
  try {
    const rejected = await cliProcess(cli, ['setup', '--host', 'dsh', '--target', target,
      '--profile', 'web', '--dsh-home', selected.home, '--experimental', '--apply', '--json'], context);
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    const report = JSON.parse(rejected.stdout);
    assert.equal(report.error, 'DSH_INSTALLATION_LAYOUT_UNSUPPORTED');
    assert.match(report.nextStep, /global|locked local/);
    assert.deepEqual(untouched.map(digest), before);
    assert.equal(fs.readlinkSync(launcher), launcherBefore);
    assert.equal(fs.existsSync(path.join(context.directory, 'arlo')), false);
    assert.equal(fs.existsSync(path.join(selected.profile, 'arlo-setup')), false);
  } finally { context.close(); }
});

// The real package operation gets its normal production deadline. Stopping
// its actual npm/pnpm tree also keeps inherited pipes open, reproducing the
// failure that a direct spawnSync timeout cannot bound.
async function stoppedNativeOperation(interrupt) {
  const context = createCliProcessFixture(interrupt ? 'arlo-dsh-native-interrupt-' : 'arlo-dsh-native-timeout-');
  const distribution = await componentDistribution(bundle, 'adapter-dsh');
  const selected = existingProfile(context);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  if (process.env.ARLO_CLI_PUBLIC_NPM_CACHE) {
    const cache = path.join(context.directory, '.npm');
    fs.cpSync(process.env.ARLO_CLI_PUBLIC_NPM_CACHE, cache, { recursive: true });
    context.env.npm_config_cache = cache;
  }
  let child, receiptFile, stopped = [];
  const evidence = fields => {
    if (!receiptFile) return;
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, ...fields }, null, 2) + '\n');
  };
  const tree = pid => {
    const result = [];
    const visit = current => {
      try {
        const command = fs.readFileSync(`/proc/${current}/cmdline`, 'utf8').replaceAll('\0', ' ');
        const stat = fs.readFileSync(`/proc/${current}/stat`, 'utf8');
        result.push({ pid: current, command, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] });
        for (const value of fs.readFileSync(`/proc/${current}/task/${current}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)) visit(Number(value));
      } catch { /* An exited process is no longer a candidate. */ }
    };
    visit(pid); return result;
  };
  const alive = row => {
    try {
      const source = fs.readFileSync(`/proc/${row.pid}/stat`, 'utf8');
      const stat = source.slice(source.lastIndexOf(')') + 2).split(' ');
      return stat[19] === row.start && stat[0] !== 'Z';
    } catch { return false; }
  };
  try {
    const native = await ordinaryInstallation(context);
    const args = ['--host', 'dsh', '--target', native.target, '--profile', 'web', '--dsh-home', selected.home, '--experimental', '--json'];
    const preview = await cliProcess(cli, ['setup', ...args], context, {}, 600_000);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    const planned = JSON.parse(preview.stdout);
    child = spawn(process.execPath, [cli, 'setup', ...args, '--apply'], { cwd: context.directory, env: context.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const closed = once(child, 'close');
    const readyDeadline = Date.now() + 180_000;
    while (Date.now() < readyDeadline) {
      let record;
      try { record = JSON.parse(fs.readFileSync(path.join(planned.preparation.directory, 'preparation.json'), 'utf8')); } catch { /* not yet preparing */ }
      const current = tree(child.pid).slice(1);
      if (record?.phase === 'native-preparing' && current.length >= 2
        && current.some(row => row.command.includes(`--dir=${native.owner}`) && row.command.includes('--frozen-lockfile'))) {
        stopped = current;
        for (const row of stopped.toReversed()) if (alive(row)) process.kill(row.pid, 'SIGSTOP');
        break;
      }
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(stopped.length >= 2, 'Stop the actual npm-exec and native pnpm descendants after the durable native preparation phase: ' + stdout + stderr);
    const stoppedAt = Date.now();
    if (process.env.ARLO_DSH_AUTO_EVIDENCE_ROOT) {
      receiptFile = path.join(process.env.ARLO_DSH_AUTO_EVIDENCE_ROOT, `${path.basename(context.directory)}-processes.json`);
      fs.writeFileSync(receiptFile, JSON.stringify({ cli, interrupt, nativeOwner: native.owner,
        preparation: planned.preparation.directory, stoppedAt: new Date(stoppedAt).toISOString(), processes: stopped }, null, 2) + '\n');
    }
    if (interrupt) child.kill('SIGINT');
    let watchdog;
    const outcome = await Promise.race([closed, new Promise(resolve => {
      watchdog = setTimeout(() => resolve(undefined), interrupt ? 10_000 : 260_000);
    })]);
    clearTimeout(watchdog);
    assert.ok(outcome, 'The production package deadline must return even when the actual descendant tree cannot handle SIGTERM');
    assert.equal(outcome[0], 1, stdout + stderr + JSON.stringify({ exit: outcome[0], signal: outcome[1] }));
    assert.ok(Date.now() - stoppedAt < (interrupt ? 10_000 : 255_000));
    assert.deepEqual(stopped.filter(alive), [], 'No stopped native package descendant survives the reported timeout');
    const report = JSON.parse(stdout);
    assert.equal(report.error, 'DSH_NATIVE_PREPARATION_FAILED');
    assert.equal(report.preparation.transaction, 'native-preparing');
    assert.deepEqual(report.preparation.failure, { code: interrupt ? 'EINTR' : 'ETIMEDOUT', phase: 'native-preparing', exit: null, signal: 'SIGKILL' });
    evidence({ failure: report.preparation.failure, failureObservedAt: new Date().toISOString() });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(selected.profile, 'package.json'), 'utf8')), selected.manifest);
    const pending = await cliProcess(cli, ['setup-status', ...args], context, {}, 600_000);
    assert.equal(pending.status, 0, pending.stdout + pending.stderr);
    assert.equal(JSON.parse(pending.stdout).phase, 'recovery-required');
    assert.deepEqual(JSON.parse(pending.stdout).preparation.failure, report.preparation.failure);
    assert.equal(JSON.parse(pending.stdout).runtime, 'unobserved');
    assert.equal(JSON.parse(pending.stdout).communication, 'unobserved');
    evidence({ freshStatus: { phase: JSON.parse(pending.stdout).phase, failure: JSON.parse(pending.stdout).preparation.failure,
      runtime: JSON.parse(pending.stdout).runtime, communication: JSON.parse(pending.stdout).communication } });
    const owner = path.join(native.owner, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(owner, 'utf8'));
    manifest.custom.afterFailure = true;
    fs.writeFileSync(owner, JSON.stringify(manifest, null, 2) + '\n');
    const referenceRequire = createRequire(path.join(fs.realpathSync(ordinaryHost), 'package.json'));
    const modules = referenceRequire('js-yaml').load(fs.readFileSync(path.join(path.resolve(ordinaryHost, '../../../'), 'node_modules/.modules.yaml'), 'utf8'));
    const npm = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    const restored = await commandProcess(process.execPath, [npm, '--global=false', `--prefix=${native.owner}`, 'exec', '--yes', '--ignore-scripts',
      '--package=pnpm@10.26.2', '--', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace',
      `--dir=${native.owner}`, `--store-dir=${path.dirname(modules.storeDir)}`], context, {}, 600_000);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    const retry = await cliProcess(cli, ['setup', ...args, '--apply'], context, {}, 600_000);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    const completed = JSON.parse(retry.stdout);
    assert.equal(completed.preparation.directory, report.preparation.directory);
    assert.equal(completed.preparation.transaction, 'configured');
    assert.equal(completed.preparation.failure, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(owner, 'utf8')).custom, { preserve: true, afterFailure: true });
    assert.equal(fs.readFileSync(path.join(selected.profile, 'history/retained.txt'), 'utf8'), 'Existing native history remains.\n');
    evidence({ recovery: { phase: completed.preparation.transaction, samePreparationResource: completed.preparation.directory === report.preparation.directory,
      laterOwnerSettingsPreserved: true, nativeHistoryPreserved: true } });
  } finally {
    for (const row of stopped.toReversed()) if (alive(row)) process.kill(row.pid, 'SIGKILL');
    if (child && child.exitCode === null && child.signalCode === null) {
      for (const row of tree(child.pid).toReversed()) if (alive(row)) process.kill(row.pid, 'SIGKILL');
      await once(child, 'close');
    }
    const cleanupDeadline = Date.now() + 5_000;
    while (stopped.some(alive) && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    evidence({ finishedAt: new Date().toISOString(), remainingLiveOwnedProcesses: stopped.filter(alive) });
    await distribution.close(); context.close();
  }

}

test('a native DSH package timeout stops its real descendant tree, reports durable failure and retries the same owner', {
  timeout: 900_000, skip: !available || process.platform !== 'linux',
}, () => stoppedNativeOperation(false));

test('interrupting native DSH preparation stops its real descendant tree, reports durable failure and retries the same owner', {
  timeout: 600_000, skip: !available || process.platform !== 'linux',
}, () => stoppedNativeOperation(true));
