import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { enforceWindowsAcl } from '@arlo/sdk';
import { consumerLockSeed, createPrivateBuildEnvironment, privateRuntimePackages } from './private-build.mjs';
import { prepareCandidateAdapter } from './dsh-candidate-adapter.mjs';
import { bindDshEnvironmentEvidence } from '../packages/adapter-dsh/delivery/environment.mjs';
import { dshWebDependencies, prepareDshWebConsumer } from '../packages/adapter-dsh/delivery/index.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const root = readJson(path.join(repo, 'package.json'));
const args = process.argv.slice(2);
const command = args.shift();
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  assert.ok(value && !value.startsWith('--'), `${name} requires a value`);
  args.splice(index, 2);
  return value;
}
const bundle = path.resolve(option('--out', path.join(repo, '.artifacts/private-web')));
const suppliedCore = option('--core');
const legacyCandidate = option('--experimental-candidate');
const hostVersion = option('--host-version', legacyCandidate ?? '0.2.0-rc.2');
assert.ok(['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.5'].includes(hostVersion), 'No reviewed installation profile for this DSH version');
assert.ok(legacyCandidate === undefined || legacyCandidate === hostVersion, 'Conflicting DSH version selectors');
const candidate = ['0.2.1-rc.2', '0.2.1-rc.5'].includes(hostVersion) ? hostVersion : undefined;
const companion = args.includes('--companion');
if (companion) args.splice(args.indexOf('--companion'), 1);
assert.ok(!companion || hostVersion === '0.2.1-rc.5', '--companion requires --host-version 0.2.1-rc.5');
const pnpmVersion = root.packageManager.split('@')[1];
const corepackHome = process.env.COREPACK_HOME ?? (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA, 'node/corepack') : path.join(os.homedir(), '.cache/node/corepack'));
const installedPnpm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/pnpm/bin/pnpm.cjs'),
  path.join(corepackHome, `v1/pnpm/${pnpmVersion}/bin/pnpm.cjs`)].find(file => file && fs.existsSync(file));
const pnpm = option('--pnpm', installedPnpm);
assert.ok(pnpm, `Pass an installed pnpm ${pnpmVersion} CLI with --pnpm`);
const store = option('--store');
const offlineCacheInput = option('--offline-cache');
const offlineCache = offlineCacheInput === undefined ? undefined : path.resolve(offlineCacheInput);
if (offlineCache) assert.ok(fs.statSync(offlineCache).isDirectory(), '--offline-cache must name an existing pnpm metadata cache');
const updateLock = args.includes('--update-lock');
if (updateLock) args.splice(args.indexOf('--update-lock'), 1);
assert.ok(!companion || !updateLock, 'Companion archives do not resolve or update a complete Web consumer lock');
assert.ok(command === 'build' && !args.length,
  'Usage: web-delivery.mjs build [--out DIR] [--core CORE_BUNDLE] [--pnpm CLI.js] [--store DIR] [--offline-cache DIR] [--update-lock] [--host-version 0.2.0-rc.2|0.2.1-rc.2|0.2.1-rc.5] [--companion (rc.5 archives only)]');
assert.equal(process.version, `v${root.engines.node}`);
assert.ok(!fs.existsSync(bundle), 'Output exists; choose a new directory to retain previous evidence');
const recipe = candidate && readJson(path.join(repo, 'web/candidates', candidate, 'package.json'));
const seed = path.join(repo, candidate ? `web/candidates/${candidate}/complete-lock.yaml` : 'web/consumer-lock.yaml');
assert.ok(companion || updateLock || fs.existsSync(seed), 'A reviewed Web lock is required; use --update-lock to deliberately resolve it');
const sourceFiles = [...(candidate ? ['scripts/dsh-candidate-adapter.mjs', ...['package.json', 'pnpm-lock.yaml', 'complete-lock.yaml', 'contact-display.cjs', ...fs.readdirSync(path.join(repo, 'web/candidates', candidate, 'patches')).map(file => `patches/${file}`)].map(file => `web/candidates/${candidate}/${file}`)] : []), 'scripts/web-delivery.mjs', 'scripts/private-build.mjs',
  'delivery/runtime-installation.mjs', 'web/verify-installation.mjs', 'package.json', 'pnpm-lock.yaml', 'web/consumer-lock.yaml'];

function run(argv, cwd, env, log) {
  const result = spawnSync(process.execPath, argv, {
    cwd, env, windowsHide: true, encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024,
  });
  if (log) fs.writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.ok(!result.error && result.status === 0,
    `Command failed (${result.status ?? result.error?.code}): ${argv[0]}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result.stdout.trim();
}
assert.equal(run([pnpm, '--version'], repo), root.packageManager.split('@')[1]);
const storeDir = store ?? path.dirname(run([pnpm, 'store', 'path'], repo));
fs.mkdirSync(bundle, { recursive: true, mode: 0o700 });
enforceWindowsAcl(bundle, true);
const { resources, dirs, isolatedOfflineCache, env } = createPrivateBuildEnvironment({
  prefix: 'arlo-web-build-',
  metadata: { owner: randomUUID(), purpose: 'Private Arlo Web package build' },
  offlineCache, npmrc: 'registry=https://registry.npmjs.org/\n',
});
env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
const pm = (argv, cwd, name) => run([pnpm, ...argv, '--ignore-workspace', '--store-dir', storeDir,
  ...(offlineCache && argv[0] === 'install' ? ['--offline', '--cache-dir', isolatedOfflineCache] : []),
], cwd, env, path.join(dirs.logs, `${name}.log`));
function resolutions(lock) {
  const section = lock.replaceAll('\r\n', '\n').split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0];
  assert.ok(section, 'Expected pnpm v9 lockfile');
  const result = {};
  for (const match of section.matchAll(/^  (?:'([^']+)'|([^'\s]+)):\s*\n([\s\S]*?)(?=^  \S|$(?![\s\S]))/gm)) {
    const id = match[1] ?? match[2];
    if (id.includes('@file:')) continue;
    const integrity = match[3].match(/resolution: \{integrity: ([^}]+)\}/)?.[1];
    assert.ok(integrity, `Missing registry integrity for ${id}`);
    result[id] = integrity;
  }
  assert.ok(Object.keys(result).length > 0);
  return result;
}
const core = path.resolve(suppliedCore ?? path.join(bundle, 'core'));
if (!suppliedCore) {
  console.log('Building the private Arlo runtime packages...');
  run([path.join(repo, 'scripts/delivery.mjs'), 'build', '--out', core, '--pnpm', pnpm, '--store', storeDir,
    ...(offlineCache ? ['--offline-cache', isolatedOfflineCache] : []),
  ], repo, env, path.join(dirs.logs, 'core-build.log'));
}
const coreManifest = readJson(path.join(core, 'manifest.json'));
for (const [file, digest] of Object.entries(coreManifest.sourceFiles)) {
  if (file.startsWith('packages/')) assert.equal(sha(fs.readFileSync(path.join(repo, file))), digest, `Stale core package source: ${file}`);
}
const localDependencies = {};
let companionAdapter;
for (const name of privateRuntimePackages) {
  const manifest = readJson(path.join(repo, `packages/${name}/package.json`));
  const archive = `arlo-${name}-${manifest.version}.tgz`;
  assert.equal(sha(fs.readFileSync(path.join(core, archive))), coreManifest.files[archive]);
  fs.copyFileSync(path.join(core, archive), path.join(bundle, archive));
  if (name === 'adapter-dsh') {
    const staging = path.join(resources, 'candidate-adapter');
    fs.mkdirSync(staging);
    const unpack = spawnSync('tar', ['-xzf', path.join(bundle, archive), '-C', staging], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr);
    if (candidate) prepareCandidateAdapter(path.join(staging, 'package'), path.join(repo, 'web/candidates', candidate), { companion });
    if (companion) companionAdapter = path.join(staging, 'package');
    bindDshEnvironmentEvidence(path.join(staging, 'package'));
    run([pnpm, 'pack', '--pack-destination', bundle], path.join(staging, 'package'), env,
      path.join(dirs.logs, 'candidate-adapter-pack.log'));
  }
  localDependencies[manifest.name] = `file:../${archive}`;
}
if (companion) {
  const reviewed = readJson(path.join(repo, 'packages/adapter-dsh/delivery/rc5-composition.json'));
  const adapter = readJson(path.join(companionAdapter, 'package.json'));
  assert.equal(reviewed.companion.hostVersion, hostVersion);
  assert.ok(Object.keys(adapter.dependencies).every(name => !name.startsWith('@deepseek-ai/')),
    'A companion must borrow native modules rather than acquire a second Host graph');
  assert.ok(Object.keys(adapter.peerDependencies).every(name => adapter.peerDependenciesMeta?.[name]?.optional === true),
    'Companion peer metadata must prevent automatic native Host acquisition');
  const routing = Object.fromEntries(['type', 'main', 'module', 'exports', 'imports', 'browser', 'bin', 'dsh']
    .filter(field => field in adapter).map(field => [field, adapter[field]]));
  assert.equal(sha(JSON.stringify(routing)), reviewed.adapter.routingSha256, 'Companion entry routing differs from the reviewed adapter');
  for (const [file, digest] of Object.entries(reviewed.adapter.files)) {
    assert.equal(sha(fs.readFileSync(path.join(companionAdapter, file))), digest, `Companion executable differs: ${file}`);
  }
  writeJson(path.join(bundle, 'manifest.json'), {
    schemaVersion: 1, hostVersion, role: 'installed-host-companion', private: true, createdAt: new Date().toISOString(),
    node: process.version, pnpm: pnpmVersion, platform: process.platform, resources,
    coreManifestSha256: sha(fs.readFileSync(path.join(core, 'manifest.json'))),
    packageChecks: { entryRouting: 'passed', reviewedAdapterFiles: Object.keys(reviewed.adapter.files).length, nativeDependencies: 'borrowed-peers' },
    sourceFiles: {
      ...Object.fromEntries(Object.entries(coreManifest.sourceFiles).filter(([file]) => file.startsWith('packages/'))),
      ...Object.fromEntries(sourceFiles.map(file => [file, sha(fs.readFileSync(path.join(repo, file)))])),
    },
    files: Object.fromEntries(Object.values(localDependencies).map(value => value.slice('file:../'.length))
      .map(file => [file, sha(fs.readFileSync(path.join(bundle, file)))])),
    scope: 'Private compiled companion archives for an existing native DSH installation; actual installation and runtime acceptance are recorded separately.',
  });
  console.log(`Built private DSH companion archives: ${bundle}\nBuild logs: ${dirs.logs}`);
  process.exit(0);
}
const consumer = path.join(bundle, 'consumer');
fs.mkdirSync(consumer);
const dshDelivery = candidate ? (() => {
  const declarations = {};
  const files = [];
  fs.mkdirSync(path.join(bundle, 'patches'));
  for (const [name, file] of Object.entries(recipe.pnpm.patchedDependencies)) {
    const target = `patches/${path.basename(file)}`;
    fs.copyFileSync(path.join(repo, 'web/candidates', candidate, file), path.join(bundle, target));
    declarations[name] = `../${target}`;
    files.push(target);
  }
  return { patchedDependencies: declarations, files };
})() : prepareDshWebConsumer(bundle);
const seedText = consumerLockSeed(fs.readFileSync(updateLock ? path.join(repo, candidate ? `web/candidates/${candidate}/pnpm-lock.yaml` : 'pnpm-lock.yaml') : seed, 'utf8'));
const registry = resolutions(seedText);
const overrides = Object.fromEntries(Object.keys(registry).map(id => [id, id.slice(id.lastIndexOf('@') + 1)]));
const manifest = {
  name: 'arlo-private-web-consumer', version: '0.1.0', private: true, type: 'module',
  packageManager: root.packageManager, engines: readJson(path.join(repo, 'packages/adapter-dsh/package.json')).engines,
  dependencies: {
    ...root.dependencies, ...dshWebDependencies,
    ...(candidate ? Object.fromEntries(Object.entries({ ...root.dependencies, ...dshWebDependencies,
      ...readJson(path.join(repo, 'packages/adapter-dsh/package.json')).dependencies,
      ...readJson(path.join(repo, 'packages/adapter-dsh/package.json')).peerDependencies,
    }).filter(([name]) => name.startsWith('@deepseek-ai/dsh')).map(([name]) => [name, candidate])) : {}),
    ...(candidate ? { ...recipe.dependencies, '@deepseek-ai/dsh-client-ui-renderer': candidate } : {}),
    '@types/node': root.devDependencies['@types/node'], typescript: root.devDependencies.typescript,
    playwright: '1.62.1', ...localDependencies,
  },
  pnpm: {
    overrides: { ...overrides, ...(candidate ? { ...recipe.pnpm.overrides, ...Object.fromEntries(Object.keys(overrides).filter(name => name.startsWith('@deepseek-ai/dsh')).map(name => [name.slice(0, name.lastIndexOf('@')), candidate])) } : {}), ...localDependencies },
    patchedDependencies: dshDelivery.patchedDependencies,
  },
};
writeJson(path.join(consumer, 'package.json'), manifest);
fs.writeFileSync(path.join(consumer, 'pnpm-lock.yaml'), seedText);
console.log(`Resolving private Web consumer: ${consumer}`);
pm(['install', '--lockfile-only', '--ignore-scripts', '--force'], consumer, 'consumer-lock');
let consumerLock = fs.readFileSync(path.join(consumer, 'pnpm-lock.yaml'), 'utf8');
const resolvedRegistry = resolutions(consumerLock);
if (!updateLock) {
  const changes = [...new Set([...Object.keys(resolvedRegistry), ...Object.keys(registry)])]
    .filter(id => resolvedRegistry[id] !== registry[id]);
  assert.equal(changes.length, 0, `Registry resolution or integrity changed from the reviewed Web lock: ${changes.join(', ')}`);
}
else {
  manifest.pnpm.overrides = { ...manifest.pnpm.overrides, ...Object.fromEntries(Object.keys(resolvedRegistry).map(id => [id, id.slice(id.lastIndexOf('@') + 1)])), ...localDependencies };
  writeJson(path.join(consumer, 'package.json'), manifest);
  pm(['install', '--lockfile-only', '--ignore-scripts'], consumer, 'pinned-consumer-lock');
  consumerLock = fs.readFileSync(path.join(consumer, 'pnpm-lock.yaml'), 'utf8');
  for (const [id, integrity] of Object.entries(resolutions(consumerLock))) {
    assert.equal(integrity, resolvedRegistry[id], `Registry integrity changed while pinning: ${id}`);
  }
  fs.mkdirSync(path.dirname(seed), { recursive: true });
  fs.writeFileSync(seed, consumerLock);
}
console.log('Installing frozen packages without lifecycle scripts...');
pm(['install', '--frozen-lockfile', '--ignore-scripts'], consumer, 'consumer-install');
const consumerRequire = createRequire(path.join(consumer, 'package.json'));
const installedDelivery = await import(pathToFileURL(consumerRequire.resolve('@arlo/adapter-dsh/delivery')).href);
const frontendSeed = candidate ? { transform: 'public-user-text-registry', version: candidate } : installedDelivery.patchWebPrimitives(consumer);
const cliVersion = run([installedDelivery.dshCliPath(consumer), '--version'], consumer, env,
  path.join(dirs.logs, 'dsh-version.log'));
if (candidate) assert.equal(cliVersion, candidate);
else installedDelivery.verifyDshVersion(cliVersion);
const copiedFiles = [];
for (const file of ['delivery/runtime-installation.mjs', 'web/verify-installation.mjs', 'web/public-api.mts',
  'web/fixture.mjs', 'web/typecheck.mjs', 'probes/isolation.mjs', 'probes/gui-network-guard.mjs']) {
  fs.mkdirSync(path.dirname(path.join(consumer, file)), { recursive: true });
  fs.copyFileSync(path.join(repo, file), path.join(consumer, file));
  copiedFiles.push(`consumer/${file}`);
}
run([path.join(consumer, 'web/typecheck.mjs'), consumer],
  consumer, env, path.join(dirs.logs, 'installed-typecheck.log'));
const composition = installedDelivery.requireDshWebComposition(consumer);
const { nativeBinding, runtime } = JSON.parse(run([path.join(consumer, 'web/verify-installation.mjs')],
  consumer, env, path.join(dirs.logs, 'native-import.log')));
const installedVersions = Object.fromEntries(Object.keys(manifest.dependencies).map(name => [name,
  readJson(path.join(consumer, 'node_modules', name, 'package.json')).version]));
const playwrightRequire = createRequire(consumerRequire.resolve('playwright/package.json'));
const browserRequirements = readJson(path.join(path.dirname(playwrightRequire.resolve('playwright-core/package.json')), 'browsers.json'));
writeJson(path.join(bundle, 'manifest.json'), {
  schemaVersion: 1, issue: hostVersion === '0.2.1-rc.5' ? 149 : candidate ? 133 : 37, hostVersion, experimentalCandidate: null, private: true, createdAt: new Date().toISOString(), node: process.version,
  pnpm: root.packageManager.split('@')[1], platform: process.platform, resources, installedVersions,
  packageManagerNetwork: { offline: offlineCache !== undefined, cacheSource: offlineCache ?? null, cacheCopy: offlineCache ? isolatedOfflineCache : null },
  installChecks: { cliVersion, contactImport: 'passed', nativeBinding, runtime, frontendSeed, composition },
  registryResolutions: resolutions(consumerLock), coreManifestSha256: sha(fs.readFileSync(path.join(core, 'manifest.json'))),
  sourceFiles: {
    ...Object.fromEntries(Object.entries(coreManifest.sourceFiles).filter(([file]) => file.startsWith('packages/'))),
    ...Object.fromEntries(sourceFiles.map(file => [file, sha(fs.readFileSync(path.join(repo, file)))])),
  },
  browserRequirements: browserRequirements.browsers.filter(browser => ['chromium', 'chromium-headless-shell'].includes(browser.name)),
  files: Object.fromEntries([...Object.values(localDependencies).map(value => value.slice('file:../'.length)),
    'consumer/package.json', 'consumer/pnpm-lock.yaml', ...dshDelivery.files, ...copiedFiles].map(file => [file, sha(fs.readFileSync(path.join(bundle, file)))])),
  scope: 'Private installed DSH Web consumer; browser and runtime acceptance must be run separately. No registry publish or global profile changes.',
});
console.log(`Built and installed private Web consumer: ${consumer}\nBuild logs: ${dirs.logs}`);
