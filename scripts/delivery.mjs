import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { consumerLockSeed, createPrivateBuildEnvironment, filesIn, privateRuntimePackages } from './private-build.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const rootManifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const pnpmVersion = rootManifest.packageManager.split('@')[1];
const packageManifests = privateRuntimePackages.map(name =>
  JSON.parse(fs.readFileSync(path.join(repo, `packages/${name}/package.json`), 'utf8')));
const args = process.argv.slice(2);
const command = args.shift();
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}
const bundle = path.resolve(option('--out', path.join(repo, '.artifacts/private-mvp')));
const output = path.resolve(option('--output', path.join(repo, `.scratch/delivery-${process.platform}.json`)));
const pnpm = option('--pnpm', process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js'));
const storeDir = option('--store', undefined);
const offlineCacheInput = option('--offline-cache');
const offlineCache = offlineCacheInput === undefined ? undefined : path.resolve(offlineCacheInput);
if (offlineCache) assert.ok(fs.statSync(offlineCache).isDirectory(), '--offline-cache must name an existing pnpm metadata cache');
if (args.length || !['build', 'verify'].includes(command)) throw new Error('Usage: delivery.mjs build|verify [--out DIR] [--output REPORT] [--pnpm CLI.js] [--store DIR] [--offline-cache DIR]');
assert.equal(process.version, `v${rootManifest.engines.node}`, 'Use the pinned Node runtime');
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceLock = fs.readFileSync(path.join(repo, 'pnpm-lock.yaml'), 'utf8').replaceAll('\r\n', '\n');
function registryPins(lock) {
  const section = lock.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0];
  assert.ok(section, 'Expected pnpm v9 lockfile');
  return Object.fromEntries([...section.matchAll(/^  (?:'([^']+)'|([^'\s]+)):\s*$/gm)].map(([, quoted, plain]) => {
    const id = quoted ?? plain;
    const at = id.lastIndexOf('@');
    return [id, id.slice(at + 1)];
  }));
}
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function runNode(argv, cwd, env, log) {
  const result = spawnSync(process.execPath, argv, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  if (log) fs.writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.status !== 0 || result.error) throw new Error(`Command failed (${result.status ?? result.error?.code}): ${argv[0]}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result.stdout.trim();
}
// Resolve the pinned package manager before replacing HOME; no provider/config
// environment is inherited by build tools or the installed runtime.
assert.equal(runNode([pnpm, '--version'], repo), pnpmVersion);
// `store path` includes pnpm's internal v10 directory; --store-dir expects
// its parent, otherwise a clean installation searches the wrong cache.
const resolvedStore = storeDir ?? path.dirname(runNode([pnpm, 'store', 'path'], repo));
// Corepack's shim needs a cache; use the already installed CLI directly.
let pnpmCli = pnpm;
if (pnpm.replaceAll('\\', '/').endsWith('/corepack/dist/pnpm.js')) {
  const corepackHome = process.env.COREPACK_HOME ?? (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'node/corepack') : path.join(os.homedir(), '.cache/node/corepack'));
  pnpmCli = path.join(corepackHome, `v1/pnpm/${pnpmVersion}/bin/pnpm.cjs`);
}
assert.ok(fs.existsSync(pnpmCli), `Pass the installed pnpm ${pnpmVersion} CLI using --pnpm`);

const owner = randomUUID();
const { resources: resourceRoot, dirs, isolatedOfflineCache, env } = createPrivateBuildEnvironment({
  prefix: 'arlo-delivery-18-',
  metadata: { owner, purpose: 'Arlo issue 18 delivery', createdAt: new Date().toISOString() },
  offlineCache, npmrc: '',
});
const packageManager = (argv, cwd, name) => runNode([pnpmCli, ...argv, '--ignore-workspace', '--store-dir', resolvedStore,
  ...(offlineCache && argv[0] === 'install' ? ['--offline', '--cache-dir', isolatedOfflineCache] : []),
], cwd, env, path.join(dirs.logs, `${name}.log`));
function copy(relative, targetRoot) {
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repo, relative), target);
}
if (command === 'build') {
  assert.ok(!fs.existsSync(bundle), 'Output exists; use --out with a new directory to retain previous evidence');
  fs.mkdirSync(bundle, { recursive: true });
  writeJson(path.join(bundle, '.arlo-owner.json'), { owner, purpose: 'Arlo private delivery bundle' });
  const compiled = path.join(resourceRoot, 'compiled');
  runNode([path.join(repo, 'node_modules/typescript/bin/tsc'), '-p', path.join(repo, 'tsconfig.build.json'), '--outDir', compiled], repo, env, path.join(dirs.logs, 'build.log'));
  const dependencies = {};
  const inventories = {};
  for (const manifest of packageManifests) {
    const name = manifest.name.slice('@arlo/'.length);
    const tarball = `arlo-${name}-${manifest.version}.tgz`;
    const target = path.join(compiled, name);
    const exports = Object.fromEntries(Object.entries(manifest.exports).map(([key, value]) => [key,
      typeof value === 'string' && value.endsWith('.ts')
        ? { types: value.replace(/\.ts$/, '.d.ts'), default: value.replace(/\.ts$/, '.js') }
        : value,
    ]));
    const packageFiles = [...new Set([...(manifest.files ?? ['src', 'bin']), 'LICENSE'])];
    const copiedFiles = [];
    for (const file of packageFiles.filter(file => !['src', 'bin'].includes(file))) {
      assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/u).includes('..'), 'Invalid package file');
      const source = file === 'LICENSE' ? path.join(repo, 'LICENSE') : path.join(repo, 'packages', name, file);
      const destination = path.join(target, file);
      const sourceFiles = fs.statSync(source).isDirectory()
        ? filesIn(source).map(entry => `${file}/${entry}`) : [file];
      // Package-owned non-compiled files are explicit inputs, never workspace links.
      assert.ok(!fs.lstatSync(source).isSymbolicLink(), 'Package file must not be a workspace link');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, { recursive: true });
      copiedFiles.push(...sourceFiles);
    }
    writeJson(path.join(target, 'package.json'), {
      ...manifest, exports, files: packageFiles, devDependencies: undefined,
      dependencies: Object.fromEntries(Object.entries(manifest.dependencies).map(([key, value]) =>
        [key, value === 'workspace:*' ? packageManifests.find(pkg => pkg.name === key).version : value])),
    });
    if (name === 'daemon') fs.copyFileSync(path.join(repo, 'packages/daemon/src/storage/windows-mutex.ps1'), path.join(target, 'src/storage/windows-mutex.ps1'));
    const inventory = filesIn(target);
    assert.ok(inventory.every(file => file === 'package.json' || /\.(js|d\.ts|ps1)$/.test(file) || copiedFiles.includes(file)),
      'Only emitted code, declarations, the owned Windows helper and explicit package files may be packed');
    inventories[manifest.name] = inventory;
    // pack writes only a local tarball, never invokes publish or lifecycle scripts.
    runNode([pnpmCli, 'pack', '--out', path.join(bundle, tarball), '--config.ignore-scripts=true'], target, env, path.join(dirs.logs, `pack-${name}.log`));
    dependencies[manifest.name] = `file:../${tarball}`;
  }
  const consumer = path.join(bundle, 'consumer');
  fs.mkdirSync(consumer);
  writeJson(path.join(consumer, 'package.json'), {
    name: 'arlo-private-installation', version: packageManifests[0].version, private: true, type: 'module',
    packageManager: rootManifest.packageManager, engines: packageManifests[0].engines,
    dependencies: { ...rootManifest.dependencies, ...dependencies },
    devDependencies: Object.fromEntries(Object.entries(rootManifest.devDependencies).filter(([key]) => !key.startsWith('@arlo/'))),
    pnpm: { overrides: { ...registryPins(sourceLock), ...dependencies },
      patchedDependencies: rootManifest.pnpm?.patchedDependencies },
  });
  for (const file of Object.values(rootManifest.pnpm?.patchedDependencies ?? {})) copy(file, consumer);
  // Reuse the reviewed resolution graph as the starting point. The frozen
  // consumer lock then records tarball integrity and all peer/transitive pins.
  fs.writeFileSync(path.join(consumer, 'pnpm-lock.yaml'), consumerLockSeed(sourceLock));
  packageManager(['install', '--lockfile-only', '--ignore-scripts'], consumer, 'consumer-lock');
  const installedPins = registryPins(fs.readFileSync(path.join(consumer, 'pnpm-lock.yaml'), 'utf8').replaceAll('\r\n', '\n'));
  // Local tarballs are new; every registry resolution must still be from the
  // reviewed graph, including integrity verified by the subsequent install.
  for (const [id, version] of Object.entries(installedPins)) {
    if (!id.includes('@file:')) assert.equal(registryPins(sourceLock)[id], version, `Unapproved dependency: ${id}`);
  }
  for (const file of ['probes/fixture.ts', 'probes/isolation.mjs', 'probes/gui-network-guard.mjs', 'acceptance/preload.mjs',
    ...filesIn(path.join(repo, 'delivery')).map(file => `delivery/${file}`)]) copy(file, consumer);
  writeJson(path.join(consumer, 'tsconfig.json'), {
    compilerOptions: { target: 'ES2024', module: 'NodeNext', strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: false },
    include: ['delivery/**/*.ts', 'probes/fixture.ts'],
  });
  // This consumer proves that the common reception package and its public
  // declarations work without installing a DSH host or the Daemon package.
  const adapterConsumer = path.join(bundle, 'adapter-consumer');
  fs.mkdirSync(adapterConsumer);
  const adapterDependencies = Object.fromEntries(['@arlo/adapter-sdk', '@arlo/sdk'].map(name => [name, dependencies[name]]));
  writeJson(path.join(adapterConsumer, 'package.json'), {
    name: 'arlo-private-adapter-consumer', version: packageManifests[0].version, private: true, type: 'module',
    packageManager: rootManifest.packageManager, engines: packageManifests[0].engines,
    dependencies: adapterDependencies,
    devDependencies: { '@types/node': rootManifest.devDependencies['@types/node'], typescript: rootManifest.devDependencies.typescript },
    pnpm: { overrides: { ...registryPins(sourceLock), ...adapterDependencies } },
  });
  packageManager(['install', '--lockfile-only', '--ignore-scripts'], adapterConsumer, 'adapter-consumer-lock');
  const adapterPins = registryPins(fs.readFileSync(path.join(adapterConsumer, 'pnpm-lock.yaml'), 'utf8').replaceAll('\r\n', '\n'));
  for (const [id, version] of Object.entries(adapterPins)) {
    if (!id.includes('@file:')) assert.equal(registryPins(sourceLock)[id], version, `Unapproved adapter dependency: ${id}`);
  }
  copy('delivery/adapter-consumer.test.ts', adapterConsumer);
  writeJson(path.join(adapterConsumer, 'tsconfig.json'), {
    compilerOptions: { target: 'ES2024', module: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false },
    include: ['delivery/adapter-consumer.test.ts'],
  });
  const contents = Object.fromEntries(filesIn(bundle).filter(file => file !== '.arlo-owner.json').map(file => [file, sha(fs.readFileSync(path.join(bundle, file)))]));
  const sourceFiles = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json', 'scripts/delivery.mjs', 'scripts/private-build.mjs',
    ...privateRuntimePackages.flatMap(name => filesIn(path.join(repo, `packages/${name}`), { excludeNodeModules: true })
      .map(file => `packages/${name}/${file}`))];
  writeJson(path.join(bundle, 'manifest.json'), {
    schemaVersion: 1, private: true, node: process.version, pnpm: pnpmVersion,
    packageManagerNetwork: { offline: offlineCache !== undefined, cacheSource: offlineCache ?? null, cacheCopy: offlineCache ? isolatedOfflineCache : null },
    sourceLockSha256: sha(fs.readFileSync(path.join(repo, 'pnpm-lock.yaml'))), inventories, files: contents,
    sourceFiles: Object.fromEntries(sourceFiles.map(file => [file, sha(fs.readFileSync(path.join(repo, file)))])),
    scope: 'Local installation only; Harness runtime packages, not Desktop launcher or provider integration',
  });
  console.log(`Built private bundle: ${bundle}\nBuild resources retained: ${resourceRoot}`);
} else {
  const manifest = json(path.join(bundle, 'manifest.json'));
  const report = {
    schemaVersion: 1, issue: 18, startedAt: new Date().toISOString(), status: 'failed',
    platform: process.platform, osRelease: os.release(), osVersion: os.version(), node: process.version, pnpm: pnpmVersion,
    linux: process.platform === 'linux' ? { osRelease: fs.readFileSync('/etc/os-release', 'utf8'), uid: process.getuid(), filesystemType: fs.statfsSync(resourceRoot).type, wsl: /microsoft/i.test(os.release()) } : null,
    bundleManifestSha256: sha(fs.readFileSync(path.join(bundle, 'manifest.json'))), resourceRoot, owner,
    steps: [], isolation: null, cleanup: 'Owned resources retained for review; no recursive deletion or process-ID termination.',
  };
  try {
    for (const [file, digest] of Object.entries(manifest.files)) {
      assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'), 'Invalid bundle entry');
      assert.equal(sha(fs.readFileSync(path.join(bundle, file))), digest, `Bundle integrity: ${file}`);
    }
    const installation = path.join(resourceRoot, 'installation');
    fs.cpSync(bundle, installation, { recursive: true });
    const consumer = path.join(installation, 'consumer');
    assert.ok(!fs.existsSync(path.join(consumer, 'node_modules')), 'Install starts without node_modules');
    packageManager(['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], consumer, 'install');
    report.steps.push({ name: 'clean-frozen-offline-install', status: 'passed' });
    runNode([path.join(consumer, 'node_modules/typescript/bin/tsc'), '-p', path.join(consumer, 'tsconfig.json')], consumer, env, path.join(dirs.logs, 'typecheck.log'));
    report.steps.push({ name: 'installed-public-types', status: 'passed' });
    const runtimeEnv = { ...env, ARLO_ACCEPTANCE_ROOT: resourceRoot, ARLO_ACCEPTANCE_OWNER: owner,
      NODE_OPTIONS: `--import=${pathToFileURL(path.join(consumer, 'acceptance/preload.mjs')).href}` };
    const adapterConsumer = path.join(installation, 'adapter-consumer');
    assert.ok(!fs.existsSync(path.join(adapterConsumer, 'node_modules')), 'Adapter install starts without node_modules');
    packageManager(['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], adapterConsumer, 'adapter-install');
    const installedAdapterPackages = fs.readdirSync(path.join(adapterConsumer, 'node_modules/.pnpm'));
    assert.ok(installedAdapterPackages.every(name => !name.startsWith('@deepseek-ai+') &&
      !/^@arlo\+(?:daemon|adapter-dsh|harness-adapter|dsh-contact)@/.test(name)), 'Independent adapter consumption must not install a DSH host or Daemon');
    runNode([path.join(adapterConsumer, 'node_modules/typescript/bin/tsc'), '-p', path.join(adapterConsumer, 'tsconfig.json')],
      adapterConsumer, env, path.join(dirs.logs, 'adapter-typecheck.log'));
    report.adapterTestOutput = runNode(['--test', '--test-reporter=tap', '--test-concurrency=1', 'delivery/adapter-consumer.test.ts'],
      adapterConsumer, runtimeEnv, path.join(dirs.logs, 'adapter-tests.log'));
    report.steps.push({ name: 'independent-adapter-sdk-install-types-and-runtime-without-dsh', status: 'passed' });
    const negative = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(consumer, 'probes/isolation.mjs')).href,
      '--input-type=module', '--eval', "import assert from 'node:assert/strict'; import https from 'node:https'; assert.throws(() => https.request('https://fictional-provider.invalid/'), /EXTERNAL_NETWORK_FORBIDDEN/);"],
    { cwd: consumer, env: { ...env, ARLO_LOW_LEVEL_NETWORK_FILE: path.join(dirs.logs, 'negative-network.json') }, windowsHide: true });
    assert.equal(negative.status, 1);
    assert.equal(json(path.join(dirs.logs, 'negative-network.json')).deniedConnections, 1);
    report.steps.push({ name: 'provider-network-negative-control', status: 'passed' });
    const testOutput = runNode(['--test', '--test-reporter=tap', '--test-concurrency=1', 'delivery/packages.test.mjs', 'delivery/demo.test.ts'], consumer, runtimeEnv, path.join(dirs.logs, 'installed-tests.log'));
    report.testOutput = testOutput;
    report.steps.push({ name: 'installed-cli-and-two-real-hosts', status: 'passed' });
    // Removal resolves remaining peer metadata even with a populated store.
    // Registry access here uses isolated config; runtime/model networking stays guarded.
    packageManager(['remove', ...privateRuntimePackages.map(name => `@arlo/${name}`), '--config.ignore-scripts=true'], consumer, 'uninstall');
    runNode(['--input-type=module', '--eval', `import assert from 'node:assert/strict'; await import('@deepseek-ai/cordis'); for (const name of ${JSON.stringify(privateRuntimePackages)}) await assert.rejects(import('@arlo/' + name + (name === 'adapter-dsh' ? '/runtime' : '')), { code: 'ERR_MODULE_NOT_FOUND' });`], consumer, runtimeEnv, path.join(dirs.logs, 'uninstalled-imports.log'));
    report.steps.push({ name: 'local-package-uninstall-preserves-host-dependencies', status: 'passed' });
    const processDir = path.join(resourceRoot, 'processes');
    const records = fs.readdirSync(processDir).filter(file => file.endsWith('.process.json')).map(file => json(path.join(processDir, file)));
    assert.ok(records.length >= 5, 'Actual CLI, host and daemon processes must be observed');
    report.isolation = { processCount: records.length, deniedConnections: 0, environment: 'Allowlist; isolated HOME/config/state/project; controlled local model only', processes: records };
    for (const record of records) {
      assert.equal(record.owner, owner);
      assert.equal(json(path.join(processDir, `${record.instance}.network.json`)).deniedConnections, 0);
    }
    report.status = 'passed';
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    writeJson(output, report);
    console.log(`Delivery ${report.status}: ${output}\nResources: ${resourceRoot}`);
  }
}
