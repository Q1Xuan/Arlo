import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateBuildEnvironment, filesIn } from './private-build.mjs';
import { genericBuildLock, registryResolutions } from './generic-lock.mjs';
import { piAdapterArtifactSha256 } from '../packages/adapter-pi/src/artifact.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const root = json(path.join(repo, 'package.json'));
const names = ['sdk', 'adapter-sdk', 'daemon', 'adapter-pi'];
const manifests = names.map(name => json(path.join(repo, `packages/${name}/package.json`)));
const tooling = Object.fromEntries(['typescript', '@types/node'].map(name => [name, root.devDependencies[name]]));
let sourceLock = fs.readFileSync(path.join(repo, 'pnpm-lock.yaml'), 'utf8').replaceAll('\r\n', '\n');
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
const bundle = path.resolve(option('--out', path.join(repo, '.artifacts/pi-private')));
const output = path.resolve(option('--output', path.join(repo, `.scratch/pi-delivery-${process.platform}.json`)));
let pnpm = option('--pnpm', process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js'));
const store = option('--store');
const cache = option('--offline-cache');
const hostVersion = option('--host-version', '1.1.0');
const candidateIndex = args.indexOf('--release-candidate');
const releaseCandidate = candidateIndex >= 0;
if (releaseCandidate) args.splice(candidateIndex, 1);
assert.ok(['1.1.0', '1.2.0', '1.3.0', '1.4.0'].includes(hostVersion), 'No reviewed installation profile for this Pi version');
const candidateDir = hostVersion === '1.1.0' ? undefined : `pi-acceptance/candidates/${hostVersion}`;
const hostOverrides = candidateDir ? json(path.join(repo, candidateDir, 'package.json')).pnpm.overrides : {};
if (candidateDir) sourceLock = fs.readFileSync(path.join(repo, candidateDir, 'pnpm-lock.yaml'), 'utf8').replaceAll('\r\n', '\n');
for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) manifests.at(-1).devDependencies[name] = hostVersion;
assert.ok(command === 'build' && args.length === 0,
  'Usage: pi-delivery.mjs build [--release-candidate] [--host-version 1.1.0|1.2.0|1.3.0|1.4.0] [--out DIR] [--output REPORT] [--pnpm CLI.js] [--store DIR] [--offline-cache DIR]');
assert.equal(process.version, `v${root.engines.node}`, 'Use the pinned Node runtime');
assert.ok(!fs.existsSync(bundle), 'Output exists; choose a new --out directory');
const pnpmVersion = root.packageManager.split('@')[1];
function run(argv, cwd, env, log) {
  const result = spawnSync(process.execPath, argv, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (log) fs.writeFileSync(log, text);
  assert.ok(result.status === 0 && !result.error, `Failed ${argv[0]} (${result.status ?? result.error?.code})\n${text}`);
  return result.stdout.trim();
}
assert.equal(run([pnpm, '--version'], repo), pnpmVersion);
const storeDir = store ?? path.dirname(run([pnpm, 'store', 'path'], repo));
if (pnpm.replaceAll('\\', '/').endsWith('/corepack/dist/pnpm.js')) {
  const cacheRoot = process.env.COREPACK_HOME ?? (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'node/corepack') : path.join(os.homedir(), '.cache/node/corepack'));
  pnpm = path.join(cacheRoot, `v1/pnpm/${pnpmVersion}/bin/pnpm.cjs`);
}
assert.ok(fs.existsSync(pnpm), 'Pass an installed pnpm CLI with --pnpm');
const owner = randomUUID();
const { resources, dirs, isolatedOfflineCache, env } = createPrivateBuildEnvironment({
  prefix: 'arlo-pi-delivery-62-', metadata: { owner, issue: 62, createdAt: new Date().toISOString() },
  offlineCache: cache && path.resolve(cache), npmrc: '',
});
const pm = (argv, cwd, label, workspace = false) => run([pnpm, ...argv,
  ...(!workspace ? ['--ignore-workspace'] : []), `--config.store-dir=${storeDir}`,
  ...(cache && argv[0] === 'install' ? ['--offline', '--cache-dir', isolatedOfflineCache] : []),
], cwd, env, path.join(dirs.logs, `${label}.log`));
function importer(lock, name) {
  const body = lock.split('\nimporters:\n')[1]?.split('\npackages:\n')[0];
  assert.ok(body, 'Expected pnpm v9 importers');
  const start = body.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `Missing locked importer: ${name}`);
  const rest = body.slice(start + 1);
  const next = rest.slice(1).search(/\n  \S/);
  return (next < 0 ? rest : rest.slice(0, next + 1)).trimEnd();
}
const piImporter = importer(sourceLock, 'packages/adapter-pi');
const piSnapshot = block => {
  const match = block.match(/      '@earendil-works\/pi-coding-agent':\n        specifier: ([^\n]+)\n        version: ([^\n]+)/);
  assert.ok(match && match[1] === hostVersion, 'Expected the reviewed Pi dependency');
  return match[2];
};
const expectedPiSnapshot = piSnapshot(piImporter);
const piPeers = {};
// A direct peer can have its own peer suffix, such as SDK 1.x's zod peer.
// Preserve the outer package pin instead of collecting only nested groups.
for (let offset = expectedPiSnapshot.indexOf('('); offset >= 0 && offset < expectedPiSnapshot.length;) {
  assert.equal(expectedPiSnapshot[offset], '(', 'Expected a locked Pi peer group');
  let depth = 1;
  let end = offset + 1;
  while (end < expectedPiSnapshot.length && depth > 0) {
    if (expectedPiSnapshot[end] === '(') depth++;
    if (expectedPiSnapshot[end] === ')') depth--;
    end++;
  }
  assert.equal(depth, 0, 'Unbalanced locked Pi peer group');
  const packageId = expectedPiSnapshot.slice(offset + 1, end - 1).split('(')[0];
  const separator = packageId.lastIndexOf('@');
  assert.ok(separator > 0 && separator < packageId.length - 1, 'Expected a pinned Pi peer');
  piPeers[packageId.slice(0, separator)] = packageId.slice(separator + 1);
  offset = end;
}
const genericLock = genericBuildLock(sourceLock, manifests.slice(0, 3), tooling);
// Keep the four source importers frozen, including Pi's reviewed peer group.
// Unreferenced source-lock snapshots are never copied as packages or installed.
const buildLock = genericLock.split('\npackages:\n')[0].trimEnd() + '\n\n' + piImporter +
  '\n\npackages:\n' + sourceLock.split('\npackages:\n')[1];
const forbidden = name => name.startsWith('@deepseek-ai/') || /^(?:cordis|@cordis\/)/.test(name) ||
  (name.startsWith('@arlo/') && !manifests.some(manifest => manifest.name === name));
function within(directory, file) {
  const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(file));
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `Resolution escaped isolated directory: ${file}`);
}
function auditInstallation(directory, label, workspace = false) {
  const graph = JSON.parse(pm(['list', '--depth', 'Infinity', '--json', ...(workspace ? ['-r'] : [])], directory, `${label}-graph`, workspace));
  const seen = new Set();
  const packages = new Map();
  const piHosts = new Set();
  const omittedOptional = new Set();
  function visit(node) {
    const parentManifest = json(path.join(node.path, 'package.json'));
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, dependency] of Object.entries(node[section] ?? {})) {
        assert.ok(!forbidden(name), `DSH dependency installed: ${name}`);
        if (!fs.existsSync(dependency.path)) {
          // pnpm list includes unsupported-platform optional dependencies in
          // its dependency graph even when no package was installed.
          assert.ok(Object.hasOwn(parentManifest.optionalDependencies ?? {}, name),
            `Required dependency is missing: ${name}`);
          omittedOptional.add(`${name}@${dependency.version}`);
          continue;
        }
        within(directory, dependency.path);
        if (seen.has(dependency.path)) continue;
        seen.add(dependency.path);
        const manifest = json(path.join(dependency.path, 'package.json'));
        assert.ok(!forbidden(manifest.name), `Aliased DSH dependency installed: ${manifest.name}`);
        if (manifest.name === '@earendil-works/pi-coding-agent') {
          assert.equal(manifest.version, hostVersion);
          piHosts.add(fs.realpathSync(dependency.path));
        }
        if (candidateDir && Object.hasOwn(hostOverrides, manifest.name)) assert.equal(manifest.version, hostOverrides[manifest.name]);
        packages.set(`${manifest.name}@${manifest.version}`, { name: manifest.name, version: manifest.version });
        visit(dependency);
      }
    }
  }
  graph.forEach(visit);
  function inspect(location) {
    for (const entry of fs.readdirSync(location, { withFileTypes: true })) {
      const file = path.join(location, entry.name);
      if (entry.isSymbolicLink()) within(directory, file);
      else if (entry.isDirectory()) inspect(file);
      else if (entry.name === 'package.json') {
        const manifest = json(file);
        if (manifest.name) assert.ok(!forbidden(manifest.name), `DSH package in virtual store: ${manifest.name}`);
      }
    }
  }
  inspect(path.join(directory, 'node_modules'));
  assert.equal(piHosts.size, 1, 'Exactly one installed Pi host runtime is shared with the adapter');
  return { piHost: [...piHosts][0], packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
    omittedOptional: [...omittedOptional].sort(), graph };
}
function fingerprint() {
  const sources = ['package.json', 'pnpm-lock.yaml', 'scripts/pi-delivery.mjs', 'scripts/private-build.mjs', 'scripts/generic-lock.mjs',
    ...(candidateDir ? [`${candidateDir}/package.json`, `${candidateDir}/pnpm-lock.yaml`] : []),
    ...names.flatMap(name => filesIn(path.join(repo, `packages/${name}`), { excludeNodeModules: true }).map(file => `packages/${name}/${file}`))];
  return Object.fromEntries(sources.sort().map(file => [file, sha(fs.readFileSync(path.join(repo, file), 'utf8').replaceAll('\r\n', '\n'))]));
}
const report = { schemaVersion: 1, issue: 62, status: 'failed', startedAt: new Date().toISOString(),
  resources, owner, bundle, node: process.version, pnpm: pnpmVersion, platform: process.platform, hostVersion, steps: [],
  distribution: { kind: releaseCandidate ? 'release-candidate' : 'private-validation', publicAvailability: 'unverified', publishPermissions: 'unverified' },
  scope: 'Private build, frozen installation, declarations and import/peer checks. Native Pi acceptance runs separately.',
};
try {
  const sourceFiles = fingerprint();
  const build = path.join(resources, 'build');
  fs.mkdirSync(build);
  writeJson(path.join(build, 'package.json'), { name: 'arlo-pi-private-build', private: true, type: 'module',
    packageManager: root.packageManager, devDependencies: tooling, ...(candidateDir ? { pnpm: { overrides: hostOverrides } } : {}) });
  fs.writeFileSync(path.join(build, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  fs.writeFileSync(path.join(build, 'pnpm-lock.yaml'), buildLock);
  for (const name of names) {
    for (const file of filesIn(path.join(repo, `packages/${name}`), { excludeNodeModules: true })) {
      const target = path.join(build, 'packages', name, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repo, 'packages', name, file), target);
    }
    if (name === 'adapter-pi') writeJson(path.join(build, 'packages', name, 'package.json'), manifests.at(-1));
  }
  const emitOptions = { target: 'ES2024', strict: true, skipLibCheck: false, noEmitOnError: true,
    allowJs: true, declaration: true, rewriteRelativeImportExtensions: true, rootDir: 'packages' };
  const piResolution = { module: 'ESNext', moduleResolution: 'Bundler', customConditions: ['node'] };
  writeJson(path.join(build, 'tsconfig.core.json'), {
    compilerOptions: { ...emitOptions, module: 'NodeNext', outDir: 'compiled' },
    include: names.slice(0, 3).flatMap(name => [`packages/${name}/**/*.ts`, `packages/${name}/bin/*.js`]),
    exclude: ['**/node_modules'],
  });
  writeJson(path.join(build, 'tsconfig.pi.json'), {
    compilerOptions: { ...emitOptions, ...piResolution, outDir: 'pi-compiled' },
    include: ['packages/adapter-pi/**/*.ts'], exclude: ['**/node_modules'],
  });
  pm(['install', '--frozen-lockfile', '--ignore-scripts'], build, 'build-install', true);
  report.buildDependencies = auditInstallation(build, 'build', true);
  const buildCompiler = path.join(build, 'node_modules/typescript/bin/tsc');
  run([buildCompiler, '-p', 'tsconfig.core.json'], build, env, path.join(dirs.logs, 'compile-core.log'));
  run([buildCompiler, '-p', 'tsconfig.pi.json'], build, env, path.join(dirs.logs, 'compile-pi.log'));
  // Pi's source graph follows the workspace core exports. Only its own output
  // is packaged; the core tarballs retain their independent NodeNext output.
  fs.cpSync(path.join(build, 'pi-compiled/adapter-pi'), path.join(build, 'compiled/adapter-pi'), { recursive: true });
  report.steps.push('isolated-frozen-four-package-build-without-dsh');
  fs.mkdirSync(bundle, { recursive: true });
  const dependencies = { '@earendil-works/pi-coding-agent': hostVersion, '@earendil-works/pi-tui': hostVersion, typebox: '1.3.27', ...piPeers };
  const inventories = {};
  for (const manifest of manifests) {
    const name = manifest.name.slice('@arlo/'.length);
    const target = path.join(build, 'compiled', name);
    const exports = Object.fromEntries(Object.entries(manifest.exports).map(([key, value]) => [key,
      { types: value.replace(/\.ts$/, '.d.ts'), default: value.replace(/\.ts$/, '.js') }]));
    const resourceFiles = [...new Set([...(manifest.files ?? []).filter(file => !['src', 'bin', 'README.md'].includes(file)), 'LICENSE'])];
    for (const file of resourceFiles) {
      assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'), 'Package resource must be owned');
      fs.cpSync(file === 'LICENSE' ? path.join(repo, 'LICENSE') : path.join(build, 'packages', name, file), path.join(target, file), { recursive: true });
    }
    writeJson(path.join(target, 'package.json'), { ...manifest, exports, files: ['src', 'bin', 'README.md', ...resourceFiles], devDependencies: undefined,
      ...(name === 'daemon' ? { arlo: { ...manifest.arlo, components: Object.fromEntries(['sdk', 'adapterSdk', 'daemon', 'piAdapter'].map((role, index) =>
        [role, { name: manifests[index].name, version: manifests[index].version }])) } } : {}),
      private: releaseCandidate ? false : manifest.private, ...(releaseCandidate ? { publishConfig: { access: 'public' } } : {}),
      ...(manifest.pi ? { pi: { ...manifest.pi, extensions: manifest.pi.extensions.map(file => file.replace(/\.ts$/, '.js')) } } : {}),
      dependencies: Object.fromEntries(Object.entries(manifest.dependencies).map(([name, version]) => [name,
        version === 'workspace:*' ? manifests.find(pkg => pkg.name === name).version : version])) });
    if (name === 'daemon') fs.copyFileSync(path.join(build, 'packages/daemon/src/storage/windows-mutex.ps1'), path.join(target, 'src/storage/windows-mutex.ps1'));
    if (name === 'adapter-pi') {
      const evidence = json(path.join(build, 'packages/adapter-pi/src/environment-evidence.json'));
      evidence.adapter.artifactSha256 = piAdapterArtifactSha256(target);
      writeJson(path.join(target, 'src/environment-evidence.json'), evidence);
    }
    if (fs.existsSync(path.join(build, 'packages', name, 'README.md'))) fs.copyFileSync(path.join(build, 'packages', name, 'README.md'), path.join(target, 'README.md'));
    inventories[manifest.name] = filesIn(target);
    assert.ok(inventories[manifest.name].every(file => file === 'package.json' || file === 'README.md' ||
      (name === 'adapter-pi' && file === 'src/environment-evidence.json') || /\.(js|d\.ts|ps1)$/.test(file)
      || resourceFiles.some(resource => file === resource || file.startsWith(`${resource}/`))));
    const tarball = `arlo-${name}-${manifest.version}.tgz`;
    run([pnpm, 'pack', '--out', path.join(bundle, tarball), '--config.ignore-scripts=true'], target, env, path.join(dirs.logs, `pack-${name}.log`));
    dependencies[manifest.name] = `file:../${tarball}`;
  }
  report.steps.push('four-private-js-and-declaration-tarballs');
  const template = path.join(bundle, 'consumer');
  fs.mkdirSync(template);
  writeJson(path.join(template, 'package.json'), { name: 'arlo-pi-private-consumer', private: true, type: 'module',
    packageManager: root.packageManager, dependencies, devDependencies: tooling,
    pnpm: { overrides: { ...hostOverrides, ...Object.fromEntries(Object.entries(dependencies).filter(([name]) => name.startsWith('@arlo/'))) } } });
  fs.writeFileSync(path.join(template, 'pnpm-lock.yaml'), sourceLock.split('\nimporters:\n')[0] + '\nimporters:\n\n' +
    piImporter.replace('  packages/adapter-pi:', '  .:') + '\n\npackages:\n' + sourceLock.split('\npackages:\n')[1]);
  pm(['install', '--lockfile-only', '--ignore-scripts'], template, 'consumer-lock');
  const consumerLock = fs.readFileSync(path.join(template, 'pnpm-lock.yaml'), 'utf8').replaceAll('\r\n', '\n');
  const approved = registryResolutions(sourceLock);
  for (const [id, integrity] of Object.entries(registryResolutions(consumerLock))) assert.equal(integrity, approved[id], `Unreviewed registry dependency: ${id}`);
  assert.equal(piSnapshot(importer(consumerLock, '.')), expectedPiSnapshot, 'Consumer must preserve the reviewed Pi peer group');
  for (const [kind, packages, resolution] of [
    ['core', manifests.slice(0, 3), { module: 'NodeNext' }],
    ['pi', manifests.slice(3), piResolution],
  ]) {
    const exportNames = packages.flatMap(manifest => Object.keys(manifest.exports).map(key => manifest.name + (key === '.' ? '' : key.slice(1))));
    fs.writeFileSync(path.join(template, `exports-${kind}.ts`), exportNames.map((name, index) =>
      `import * as entry${index} from '${name}';\nvoid entry${index};`).join('\n') + '\n');
    writeJson(path.join(template, `tsconfig.${kind}.json`), { compilerOptions: { target: 'ES2024', ...resolution,
      strict: true, noEmit: true, skipLibCheck: false }, include: [`exports-${kind}.ts`] });
  }
  fs.writeFileSync(path.join(template, 'check.mjs'), `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
assert.ok(process.execArgv.includes('--experimental-import-meta-resolve'), 'Parent-aware ESM resolution must be enabled');
const resolveFrom = (name, parent = import.meta.url) => fs.realpathSync(fileURLToPath(import.meta.resolve(name, parent)));
const require = createRequire(import.meta.url);
const adapterEntry = resolveFrom('@arlo/adapter-pi');
const fromAdapter = createRequire(adapterEntry);
for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
  assert.equal(resolveFrom(name, pathToFileURL(adapterEntry).href), resolveFrom(name), name + ' must be shared with the host');
}
for (const loader of [require, fromAdapter]) {
  for (const location of loader.resolve.paths('@deepseek-ai/dsh-agent')) {
    assert.ok(!fs.existsSync(path.join(location, '@deepseek-ai')), 'No DSH dependency scope may supply an ancestor fallback');
  }
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@arlo/adapter-dsh']) {
    assert.throws(() => loader.resolve(name), { code: 'MODULE_NOT_FOUND' });
  }
}
const adapterRoot = path.dirname(path.dirname(adapterEntry));
const adapter = JSON.parse(fs.readFileSync(path.join(adapterRoot, 'package.json'), 'utf8'));
assert.deepEqual(adapter.peerDependencies, { '@earendil-works/pi-coding-agent': '*', '@earendil-works/pi-tui': '*', typebox: '*' });
const extension = path.join(adapterRoot, adapter.pi.extensions[0]);
assert.ok(extension.endsWith('.js'));
assert.equal(typeof (await import(pathToFileURL(extension).href)).default, 'function');
assert.equal(typeof (await import('@arlo/adapter-pi')).createPiAdapter, 'function');
assert.equal((await import('@earendil-works/pi-coding-agent')).VERSION, ${JSON.stringify(hostVersion)});
await import('@arlo/sdk');
await import('@arlo/daemon');
const piEntry = resolveFrom('@earendil-works/pi-coding-agent');
console.log(JSON.stringify({ adapterEntry, extension, piEntry, piVersion: (await import('@earendil-works/pi-coding-agent')).VERSION,
  piCli: path.join(path.dirname(piEntry), 'bundle/cli.js'),
  daemonEntry: resolveFrom('@arlo/daemon'), sdkEntry: resolveFrom('@arlo/sdk'), sharedPeers: true, dshResolvable: false }));
`);
  const installation = path.join(resources, 'installation');
  fs.cpSync(bundle, installation, { recursive: true });
  const consumer = path.join(installation, 'consumer');
  report.consumer = consumer;
  pm(['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], consumer, 'consumer-install');
  report.consumerDependencies = auditInstallation(consumer, 'consumer');
  for (const kind of ['core', 'pi']) run([path.join(consumer, 'node_modules/typescript/bin/tsc'), '-p', `tsconfig.${kind}.json`],
    consumer, env, path.join(dirs.logs, `declarations-${kind}.log`));
  report.entries = JSON.parse(run(['--experimental-import-meta-resolve', 'check.mjs'], consumer,
    { ...env, PI_CODING_AGENT_DIR: dirs.home, PI_TELEMETRY: 'false', PI_OFFLINE: '1' }, path.join(dirs.logs, 'imports.log')));
  report.steps.push('independent-frozen-install-types-imports-and-shared-pi-peers');
  report.piSnapshot = expectedPiSnapshot;
  assert.deepEqual(fingerprint(), sourceFiles, 'Sources changed during build');
  writeJson(path.join(bundle, 'manifest.json'), { schemaVersion: 1, private: true, sourceFiles, inventories,
    distribution: report.distribution, packages: manifests.map(({ name, version }) => ({ name, version })),
    piSnapshot: expectedPiSnapshot, files: Object.fromEntries(filesIn(bundle).map(file => [file, sha(fs.readFileSync(path.join(bundle, file)))])) });
  report.status = 'passed';
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  writeJson(output, report);
  console.log(`Pi build ${report.status}: ${output}\nConsumer: ${report.consumer ?? 'not installed'}\nResources retained: ${resources}`);
  if (report.error) console.error(report.error);
}
