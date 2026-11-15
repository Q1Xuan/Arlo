import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPrivateBuildEnvironment, filesIn } from './private-build.mjs';
import { genericBuildLock, registryResolutions, pinnedOverrides } from './generic-lock.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const root = json(path.join(repo, 'package.json'));
const names = ['sdk', 'adapter-sdk', 'daemon'];
const manifests = names.map(name => json(path.join(repo, `packages/${name}/package.json`)));
const tooling = Object.fromEntries(['typescript', '@types/node'].map(name => [name, root.devDependencies[name]]));
const sourceLock = fs.readFileSync(path.join(repo, 'pnpm-lock.yaml'), 'utf8').replaceAll('\r\n', '\n');
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
const bundle = path.resolve(option('--out', path.join(repo, '.artifacts/generic')));
const output = path.resolve(option('--output', path.join(repo, `.scratch/generic-${process.platform}.json`)));
let pnpm = option('--pnpm', process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js'));
const store = option('--store');
const cache = option('--offline-cache');
assert.ok(['build', 'verify'].includes(command) && args.length === 0,
  'Usage: generic-delivery.mjs build|verify [--out DIR] [--output REPORT] [--pnpm CLI.js] [--store DIR] [--offline-cache DIR]');
assert.equal(process.version, `v${root.engines.node}`, 'Use the pinned Node runtime');
const pnpmVersion = root.packageManager.split('@')[1];
function run(argv, cwd, env, log, timeout = 300000) {
  const result = spawnSync(process.execPath, argv, { cwd, env, windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (log) fs.writeFileSync(log, text);
  assert.ok(result.status === 0 && !result.error, `Failed ${argv[0]} (${result.status ?? result.error?.code})\n${text}`);
  return result.stdout.trim();
}
assert.equal(run([pnpm, '--version'], repo), pnpmVersion);
const storeDir = store ?? path.dirname(run([pnpm, 'store', 'path'], repo));
if (pnpm.replaceAll('\\', '/').endsWith('/corepack/dist/pnpm.js')) {
  const home = process.env.COREPACK_HOME ?? (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'node/corepack') : path.join(os.homedir(), '.cache/node/corepack'));
  pnpm = path.join(home, `v1/pnpm/${pnpmVersion}/bin/pnpm.cjs`);
}
assert.ok(fs.existsSync(pnpm), 'Pass an installed pnpm CLI with --pnpm');
const owner = randomUUID();
const { resources, dirs, isolatedOfflineCache, env } = createPrivateBuildEnvironment({
  prefix: 'arlo-generic-51-', metadata: { owner, purpose: 'Generic private package validation', createdAt: new Date().toISOString() },
  offlineCache: cache && path.resolve(cache), npmrc: '',
});
const pm = (argv, cwd, label, workspace = false) => run([pnpm, ...argv,
  ...(!workspace ? ['--ignore-workspace'] : []), `--config.store-dir=${storeDir}`,
  ...(cache && argv[0] === 'install' ? ['--offline', '--cache-dir', isolatedOfflineCache] : []),
], cwd, env, path.join(dirs.logs, `${label}.log`));
const copy = (relative, destination) => {
  const target = path.join(destination, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repo, relative), target);
};
function within(directory, file) {
  const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(file));
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `Resolution escaped isolated directory: ${file}`);
}
const forbidden = name => name.startsWith('@deepseek-ai/') || /^(?:cordis|@cordis\/)/.test(name) ||
  (name.startsWith('@arlo/') && !manifests.some(pkg => pkg.name === name));
function auditInstallation(directory, label, workspace = false) {
  const graph = JSON.parse(pm(['list', '--depth', 'Infinity', '--json', ...(workspace ? ['-r'] : [])], directory, `${label}-graph`, workspace));
  const versions = new Map();
  function visit(node) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, dependency] of Object.entries(node[section] ?? {})) {
        assert.ok(!forbidden(name), `Host dependency installed: ${name}`);
        within(directory, dependency.path);
        const manifest = json(path.join(dependency.path, 'package.json'));
        assert.ok(!forbidden(manifest.name), `Aliased host dependency installed: ${manifest.name}`);
        versions.set(`${manifest.name}@${manifest.version}`, { name: manifest.name, version: manifest.version });
        visit(dependency);
      }
    }
  }
  graph.forEach(visit);
  // Inspect the actual virtual store too, including orphan packages not in list's graph.
  const moduleRoot = path.join(directory, 'node_modules');
  function inspect(location) {
    for (const entry of fs.readdirSync(location, { withFileTypes: true })) {
      const file = path.join(location, entry.name);
      if (entry.isSymbolicLink()) within(directory, file);
      else if (entry.isDirectory()) inspect(file);
      else if (entry.name === 'package.json') {
        const manifest = json(file);
        if (manifest.name) assert.ok(!forbidden(manifest.name), `Host package in installation: ${manifest.name}`);
      }
    }
  }
  inspect(moduleRoot);
  return { graph, packages: [...versions.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
function auditLock(lock) {
  const approved = registryResolutions(sourceLock);
  for (const [id, integrity] of Object.entries(registryResolutions(lock))) {
    assert.equal(integrity, approved[id], `Unreviewed registry resolution: ${id}`);
  }
}
function sourceFingerprint() {
  const sources = ['package.json', 'pnpm-lock.yaml', 'scripts/generic-delivery.mjs', 'scripts/generic-lock.mjs', 'scripts/private-build.mjs',
    'acceptance/preload.mjs', 'probes/isolation.mjs', 'probes/gui-network-guard.mjs',
    ...filesIn(path.join(repo, 'generic-delivery')).map(file => `generic-delivery/${file}`),
    ...names.flatMap(name => filesIn(path.join(repo, `packages/${name}`), { excludeNodeModules: true }).map(file => `packages/${name}/${file}`))];
  return Object.fromEntries(sources.sort().map(file => [file, sha(fs.readFileSync(path.join(repo, file), 'utf8').replaceAll('\r\n', '\n'))]));
}
const report = { schemaVersion: 1, issue: 51, command, status: 'failed', startedAt: new Date().toISOString(),
  runtime: { platform: process.platform, arch: process.arch, release: os.release(), version: os.version(), node: process.version, pnpm: pnpmVersion,
    linux: process.platform === 'linux' ? { distribution: fs.readFileSync('/etc/os-release', 'utf8'), uid: process.getuid(), wsl: /microsoft/i.test(os.release()), filesystemType: fs.statfsSync(resources).type } : null },
  resources, owner, steps: [],
  scope: 'Generic contract only; no model calls, DSH, Pi integration or cross-host interoperability claim.',
};
try {
  if (command === 'build') {
    assert.ok(!fs.existsSync(bundle), 'Output exists; choose a new --out directory');
    const sourceFiles = sourceFingerprint();
    const build = path.join(resources, 'build');
    fs.mkdirSync(build);
    writeJson(path.join(build, 'package.json'), { name: 'arlo-generic-build', private: true, type: 'module', packageManager: root.packageManager, devDependencies: tooling });
    fs.writeFileSync(path.join(build, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    fs.writeFileSync(path.join(build, 'pnpm-lock.yaml'), genericBuildLock(sourceLock, manifests, tooling));
    for (const name of names) {
      for (const file of filesIn(path.join(repo, `packages/${name}`), { excludeNodeModules: true })) copy(`packages/${name}/${file}`, build);
    }
    writeJson(path.join(build, 'tsconfig.json'), {
      compilerOptions: { target: 'ES2024', module: 'NodeNext', strict: true, skipLibCheck: false, noEmitOnError: true,
        allowJs: true, declaration: true, rewriteRelativeImportExtensions: true, rootDir: 'packages', outDir: 'compiled' },
      include: ['packages/**/*.ts', 'packages/*/bin/*.js'], exclude: ['**/node_modules'],
    });
    pm(['install', '--frozen-lockfile', '--ignore-scripts'], build, 'build-install', true);
    report.buildDependencies = auditInstallation(build, 'build', true);
    report.steps.push('isolated-generic-source-install');
    run([path.join(build, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], build, env, path.join(dirs.logs, 'compile.log'));
    report.steps.push('isolated-strict-build');
    fs.mkdirSync(bundle, { recursive: true });
    const dependencies = {};
    const inventories = {};
    for (const manifest of manifests) {
      const name = manifest.name.slice('@arlo/'.length);
      const target = path.join(build, 'compiled', name);
      const exports = Object.fromEntries(Object.entries(manifest.exports).map(([key, value]) => [key, { types: value.replace(/\.ts$/, '.d.ts'), default: value.replace(/\.ts$/, '.js') }]));
      const resourceFiles = [...new Set([...(manifest.files ?? []).filter(file => !['src', 'bin'].includes(file)), 'LICENSE'])];
      for (const file of resourceFiles) {
        assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'), 'Package resource must be owned');
        fs.cpSync(file === 'LICENSE' ? path.join(repo, 'LICENSE') : path.join(build, 'packages', name, file), path.join(target, file), { recursive: true });
      }
      writeJson(path.join(target, 'package.json'), { ...manifest, exports, files: ['src', 'bin', ...resourceFiles], devDependencies: undefined,
        dependencies: Object.fromEntries(Object.entries(manifest.dependencies).map(([name, version]) => [name,
          version === 'workspace:*' ? manifests.find(pkg => pkg.name === name).version : version])) });
      if (name === 'daemon') fs.copyFileSync(path.join(build, 'packages/daemon/src/storage/windows-mutex.ps1'), path.join(target, 'src/storage/windows-mutex.ps1'));
      inventories[manifest.name] = filesIn(target);
      assert.ok(inventories[manifest.name].every(file => file === 'package.json' || /\.(js|d\.ts|ps1)$/.test(file)
        || resourceFiles.some(resource => file === resource || file.startsWith(`${resource}/`))));
      const tarball = `arlo-${name}-${manifest.version}.tgz`;
      run([pnpm, 'pack', '--out', path.join(bundle, tarball), '--config.ignore-scripts=true'], target, env, path.join(dirs.logs, `pack-${name}.log`));
      dependencies[manifest.name] = `file:../${tarball}`;
    }
    const consumer = path.join(bundle, 'consumer');
    fs.mkdirSync(consumer);
    writeJson(path.join(consumer, 'package.json'), { name: 'arlo-generic-consumer', private: true, type: 'module', packageManager: root.packageManager,
      dependencies, devDependencies: tooling, pnpm: { overrides: { ...pinnedOverrides(sourceLock, manifests, tooling), ...dependencies } } });
    pm(['install', '--lockfile-only', '--ignore-scripts'], consumer, 'consumer-lock');
    auditLock(fs.readFileSync(path.join(consumer, 'pnpm-lock.yaml'), 'utf8'));
    for (const file of [...filesIn(path.join(repo, 'generic-delivery')).map(file => `generic-delivery/${file}`),
      'acceptance/preload.mjs', 'probes/isolation.mjs', 'probes/gui-network-guard.mjs']) copy(file, consumer);
    const exports = manifests.flatMap(manifest => Object.keys(manifest.exports).map(key => manifest.name + (key === '.' ? '' : key.slice(1))));
    fs.writeFileSync(path.join(consumer, 'generic-delivery/exports.ts'), exports.map((specifier, index) => `import * as entry${index} from '${specifier}';\nvoid entry${index};`).join('\n') + '\n');
    writeJson(path.join(consumer, 'tsconfig.json'), { compilerOptions: { target: 'ES2024', module: 'NodeNext', strict: true, noEmit: true,
      skipLibCheck: false, allowImportingTsExtensions: true }, include: ['generic-delivery/**/*.ts'] });
    fs.copyFileSync(path.join(build, 'pnpm-lock.yaml'), path.join(bundle, 'build-pnpm-lock.yaml'));
    assert.deepEqual(sourceFingerprint(), sourceFiles, 'Sources changed during build');
    writeJson(path.join(bundle, 'manifest.json'), { schemaVersion: 1, private: true, sourceFiles, inventories, exports,
      sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).stdout?.trim() || null,
      packages: manifests.map(({ name, version }) => ({ name, version })),
      files: Object.fromEntries(filesIn(bundle).map(file => [file, sha(fs.readFileSync(path.join(bundle, file)))])),
      buildDependencies: report.buildDependencies, runtime: report.runtime });
    report.steps.push('three-private-tarballs-and-frozen-consumer-lock');
  } else {
    const manifest = json(path.join(bundle, 'manifest.json'));
    report.bundleManifestSha256 = sha(fs.readFileSync(path.join(bundle, 'manifest.json')));
    for (const [file, digest] of Object.entries(manifest.files)) {
      assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'), 'Invalid bundle path');
      assert.equal(sha(fs.readFileSync(path.join(bundle, file))), digest, `Bundle integrity: ${file}`);
    }
    const installation = path.join(resources, 'installation');
    fs.cpSync(bundle, installation, { recursive: true });
    const consumer = path.join(installation, 'consumer');
    assert.ok(!fs.existsSync(path.join(consumer, 'node_modules')), 'Consumer starts without modules');
    pm(['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], consumer, 'consumer-install');
    report.consumerDependencies = auditInstallation(consumer, 'consumer');
    report.steps.push('independent-frozen-offline-install-and-dependency-audit');
    run([path.join(consumer, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], consumer, env, path.join(dirs.logs, 'declarations.log'));
    report.steps.push('all-public-export-declarations-strict');
    const negativeFile = path.join(dirs.logs, 'network-negative.json');
    const negative = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(consumer, 'probes/isolation.mjs')).href,
      '--input-type=module', '--eval', "import assert from 'node:assert/strict'; import https from 'node:https'; assert.throws(() => https.request('https://fictional-provider.invalid/'), /EXTERNAL_NETWORK_FORBIDDEN/);"],
    { cwd: consumer, env: { ...env, ARLO_LOW_LEVEL_NETWORK_FILE: negativeFile }, encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(negative.status, 1, 'The negative network control must fail closed');
    assert.equal(json(negativeFile).deniedConnections, 1);
    report.steps.push('runtime-network-negative-control');
    const runtimeEnv = { ...env, ARLO_ACCEPTANCE_ROOT: resources, ARLO_ACCEPTANCE_OWNER: owner,
      NODE_OPTIONS: `--import=${pathToFileURL(path.join(consumer, 'acceptance/preload.mjs')).href}` };
    report.testOutput = run(['--test', '--test-concurrency=1', '--test-reporter=tap', 'generic-delivery/packages.test.mjs', 'generic-delivery/contract.test.ts'],
      consumer, runtimeEnv, path.join(dirs.logs, 'contract.log'), 600000);
    report.steps.push('installed-exports-cli-and-public-host-contract');
    const processDir = path.join(resources, 'processes');
    const processes = fs.readdirSync(processDir).filter(file => file.endsWith('.process.json')).map(file => json(path.join(processDir, file)));
    for (const record of processes) {
      assert.equal(record.owner, owner);
      assert.equal(json(path.join(processDir, `${record.instance}.network.json`)).deniedConnections, 0);
    }
    report.isolation = { processCount: processes.length, deniedConnections: 0, processes,
      environment: 'Allowlisted environment; independent HOME/config/state; propagated loopback-only runtime guard; no models' };
  }
  report.status = 'passed';
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  writeJson(output, report);
  console.log(`Generic ${command} ${report.status}: ${output}\nResources retained: ${resources}`);
  if (report.error) console.error(report.error);
}
