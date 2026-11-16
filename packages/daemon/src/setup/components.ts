import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertSafeStatePath, enforceWindowsAcl, verifyWindowsAcl } from '@arlo/sdk';
import { prepareStateDirectory } from '../storage/index.ts';
import { assertConfigurationFile, persistSetupRecord, setupTransaction } from './transaction.ts';
import { fail, type SetupOperationFailure } from './errors.ts';
import { consumerInventory, matchesOwnedProgress, validConsumerInventory, type ConsumerInventory } from './component-inventory.ts';

// One immutable release batch. Acquisition uses the user's standard registry
// configuration; this is not a latest-version or arbitrary-URL installer.
const catalog = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).arlo?.components;
export const piComponentNames: Record<string, string> = Object.fromEntries(Object.entries(catalog ?? {})
  .map(([role, entry]: [string, any]) => [role, entry.name]));
export const piRelease: Record<string, string> = Object.fromEntries(Object.values(catalog ?? {})
  .map((entry: any) => [entry.name, entry.version]));
const componentScopes = [...new Set(Object.keys(piRelease).filter(name => name.startsWith('@')).map(name => name.split('/')[0] + '/'))];
const componentName = (name: string) => componentScopes.some(scope => name.startsWith(scope));
export const piPeers = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'];
const json = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const fingerprint = (file: string): string => fs.existsSync(file) ? digest(fs.readFileSync(file)) : 'missing';
type Identity = { directory: string; version: string; manifestSha256: string };
export type HostInstallation = { directory: string; version: string; bin: string; owner: string;
  manager: 'npm' | 'pnpm'; managerVersion?: string; peers: Record<string, Identity>; evidence: Record<string, string> };
type Tool = { name: 'npm' | 'pnpm'; version: string; args: string[] };
type ReferenceKind = 'setup-record' | 'preexisting-declaration';
export type ResourceRecord = { schemaVersion: 1; id: string; kind: 'components'; host: HostInstallation;
  root: string; consumer: string; manager: Tool; packages: typeof piRelease; planSha256: string; manifestSha256: string;
  phase: 'consuming' | 'components-installed' | 'registration-prepared' | 'configured';
  references: Record<string, { target: string; phase: 'registration-prepared' | 'configured'; kind?: ReferenceKind }>;
  owned: { files: string[]; packageEntries: string[]; peerLinks: string[]; inventory?: ConsumerInventory }; borrowed: Record<string, Identity>;
  artifacts?: Record<string, { directory: string; version: string; sha256: string; resolved: string; integrity: string }>;
  consumerSha256?: string;
  cleanup?: { phase: 'removing' | 'removed'; scope: string; consumerSha256: string;
    manifestSha256: string; planSha256: string; beforeInventory?: ConsumerInventory; expectedInventory?: ConsumerInventory;
    failure?: { code: string; exit: number | null; signal: string | null; operation: string } };
  failure?: { code: string; exit: number | null; signal: string | null; operation?: string }; createdAt: string };

export function physicalPackage(from: string, name: string): string {
  for (const root of createRequire(path.join(from, 'package.json')).resolve.paths(name) ?? []) {
    const file = path.join(root, name, 'package.json');
    if (fs.existsSync(file)) {
      const directory = fs.realpathSync(path.dirname(file));
      const manifest = json(path.join(directory, 'package.json'));
      if (manifest.name !== name || typeof manifest.version !== 'string') fail('DEPENDENCY_IDENTITY_MISMATCH', `The installed ${name} manifest has a different identity. Repair the selected installation before retrying.`);
      return directory;
    }
  }
  return fail('DEPENDENCY_MISSING', `The selected installation is missing ${name}. Repair it through its own package manager; setup never installs another Pi.`);
}
export function npmCli(explicit?: string): string {
  const candidates = explicit ? [path.resolve(explicit)] : [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const found = candidates.find(file => file?.endsWith('npm-cli.js') && fs.existsSync(file));
  return found ? fs.realpathSync(found) : fail('PACKAGE_TOOL_MISSING', 'Use your existing Node/npm installation or pass its npm-cli.js using --npm-cli. Setup does not switch Node.');
}
function execute(tool: Tool, args: string[], cwd: string) {
  // Standard npm global defaults belong to discovery, not this companion.
  // CLI arguments explicitly bind consumption and npm-exec to this owner.
  const npmArgs = [tool.args[0], '--global=false', `--prefix=${cwd}`, ...tool.args.slice(1)];
  const operation = tool.name === 'pnpm' ? [...args, `--dir=${cwd}`, '--global=false'] : args;
  return spawnSync(process.execPath, [...npmArgs, ...operation], { cwd, env: process.env, encoding: 'utf8',
    windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
}
export function inspectPiInstallation(selected: string): HostInstallation {
  let directory: string, manifest: any, bin: string;
  try {
    directory = fs.realpathSync(selected);
    manifest = json(path.join(directory, 'package.json'));
    bin = fs.realpathSync(path.join(directory, manifest.bin.pi));
    const relative = path.relative(directory, bin);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !bin.endsWith('.js') || !fs.statSync(bin).isFile()) throw new Error();
  } catch { return fail('HOST_UNSUPPORTED', 'Select the actual compiled Pi package directory with a readable bin.pi inside it. No host was downloaded.'); }
  if (manifest.name !== piPeers[0] || !['1.1.0', '1.2.0', '1.3.0', '1.4.0'].includes(manifest.version)) {
    return fail('HOST_UNSUPPORTED', 'Select existing Pi 1.1.0, 1.2.0, 1.3.0 or 1.4.0; setup never installs another host.');
  }
  const parts = directory.split(path.sep);
  const virtual = parts.indexOf('.pnpm');
  const boundary = virtual >= 0 ? virtual - 1 : parts.lastIndexOf('node_modules');
  if (boundary < 0) fail('PACKAGE_MANAGER_CONFLICT', 'Locate Pi in its standard npm or pnpm installation; an unmanaged source directory cannot prove package ownership.');
  let owner = parts.slice(0, boundary).join(path.sep) || path.parse(directory).root;
  // npm global roots contain lib/node_modules on POSIX. The package lock or
  // global metadata, rather than this shape, establishes ownership below.
  const evidence: Record<string, string> = {};
  for (const name of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'node_modules/.modules.yaml', 'node_modules/.package-lock.json']) {
    const file = path.join(owner, name);
    assertConfigurationFile(file);
    evidence[file] = fingerprint(file);
  }
  const declared = fs.existsSync(path.join(owner, 'package.json')) ? json(path.join(owner, 'package.json')).packageManager : undefined;
  const modules = fs.existsSync(path.join(owner, 'node_modules/.modules.yaml')) ? fs.readFileSync(path.join(owner, 'node_modules/.modules.yaml'), 'utf8') : '';
  const hasPnpm = !!modules || fs.existsSync(path.join(owner, 'pnpm-lock.yaml'));
  const hasNpm = fs.existsSync(path.join(owner, 'package-lock.json')) || fs.existsSync(path.join(owner, 'node_modules/.package-lock.json'));
  if (hasPnpm && hasNpm || declared && !/^(npm|pnpm)@\d+\.\d+\.\d+(?:\+sha\d+\.[a-f0-9]+)?$/.test(declared)
    || declared?.startsWith('npm@') && hasPnpm || declared?.startsWith('pnpm@') && hasNpm) {
    fail('PACKAGE_MANAGER_CONFLICT', 'The selected installation has conflicting package-manager metadata. Resolve it through its owner before setup.');
  }
  const manager = hasPnpm ? 'pnpm' : 'npm';
  const managerVersion = declared?.split('@')[1].split('+')[0] ?? modules.match(/^packageManager: pnpm@(\d+\.\d+\.\d+)$/m)?.[1];
  const installedPnpm = modules.match(/^packageManager: pnpm@(\d+\.\d+\.\d+)$/m)?.[1];
  if (manager === 'pnpm' && (!managerVersion || installedPnpm && installedPnpm !== managerVersion)) fail('PACKAGE_MANAGER_CONFLICT', 'The selected pnpm owner must declare the same exact pnpm version as its installed modules.');
  if (manager === 'npm' && (!hasNpm || !fs.existsSync(path.join(owner, 'package.json')))) {
    // Global npm metadata is read using the installed standard tool. No
    // command in this module mutates the original prefix or global packages.
    const npm = npmCli();
    const root = spawnSync(process.execPath, [npm, 'root', '-g'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    const list = spawnSync(process.execPath, [npm, 'ls', '-g', '--depth=0', '--json', '--long'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    const prefix = spawnSync(process.execPath, [npm, 'prefix', '-g'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    let installed;
    try { installed = JSON.parse(list.stdout).dependencies?.[piPeers[0]]; } catch { /* bounded rejection */ }
    if (root.status !== 0 || prefix.status !== 0 || !installed?.path || fs.realpathSync(installed.path) !== directory ||
      fs.realpathSync(path.join(root.stdout.trim(), piPeers[0])) !== directory) fail('PACKAGE_MANAGER_CONFLICT', 'This Pi installation has no verifiable local lock or global npm metadata. Locate its standard owner before retrying.');
    owner = fs.realpathSync(prefix.stdout.trim());
  }
  const peers: Record<string, Identity> = {};
  evidence[bin] = fingerprint(bin);
  for (const name of piPeers) {
    const location = name === piPeers[0] ? directory : physicalPackage(directory, name);
    peers[name] = { directory: location, version: json(path.join(location, 'package.json')).version,
      manifestSha256: fingerprint(path.join(location, 'package.json')) };
  }
  return { directory, version: manifest.version, bin, owner, manager, managerVersion, peers, evidence };
}
function artifactFingerprint(directory: string): string {
  const hash = createHash('sha256');
  function visit(relative: string) {
    for (const item of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === 'node_modules') continue;
      const name = path.join(relative, item.name);
      if (item.isSymbolicLink()) fail('COMPONENT_OWNERSHIP_CONFLICT', 'An owned component contains a later redirect. Preserve it and review before retrying.');
      if (item.isDirectory()) visit(name);
      else hash.update(name).update('\0').update(fs.readFileSync(path.join(directory, name))).update('\0');
    }
  }
  visit('');
  return hash.digest('hex');
}
// Hash the owned consumer, including transitive packages and generated links.
// Borrowed peer link destinations are never followed or claimed as owned.
export function consumerFingerprint(directory: string): string {
  if (fs.lstatSync(directory).isSymbolicLink()) fail('COMPONENT_OWNERSHIP_CONFLICT', 'The owned consumer was redirected. Preserve it and review before retrying.');
  const hash = createHash('sha256');
  function visit(relative: string) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name);
      hash.update(file).update('\0');
      if (entry.isSymbolicLink()) hash.update('link').update(fs.readlinkSync(path.join(directory, file)));
      else if (entry.isDirectory()) { hash.update('directory'); visit(file); }
      else if (entry.isFile()) hash.update('file').update(fs.readFileSync(path.join(directory, file)));
      else fail('COMPONENT_OWNERSHIP_CONFLICT', 'An unexpected entry appeared inside the owned consumer. Preserve it and review before retrying.');
      hash.update('\0');
    }
  }
  visit('');
  return hash.digest('hex');
}
export function privateRecord(file: string): ResourceRecord | undefined {
  if (!fs.existsSync(file)) return;
  assertSafeStatePath(path.dirname(file));
  if (fs.lstatSync(file).isSymbolicLink() || !verifyWindowsAcl(file).valid) fail('COMPONENT_OWNERSHIP_CONFLICT', 'Preserve and repair the unsafe component ownership record.');
  try { return json(file); } catch { return fail('COMPONENT_OWNERSHIP_CONFLICT', 'Preserve and repair the unreadable component ownership record.'); }
}
export function componentDataDirectory(): string {
  const data = process.platform === 'win32' ? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local')
    : process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share');
  return path.join(path.resolve(data), 'arlo');
}

/** A standard package consumer bound to borrowed physical host identities.
 * Registration and future host preparation remain separate operations. */
export async function preparePiComponents(target: string, scope: string, selectedNpm?: string, mode: 'install' | 'inspect' = 'install') {
  if (['sdk', 'adapterSdk', 'daemon', 'piAdapter'].some(role => typeof catalog?.[role]?.name !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(catalog?.[role]?.version ?? '')) || Object.keys(piRelease).length !== 4) {
    fail('COMPONENT_CATALOG_UNAVAILABLE', 'Obtain the coordinated compiled CLI release with its exact component catalog. No package was acquired.');
  }
  const host = inspectPiInstallation(target);
  const npm = npmCli(selectedNpm);
  const npmVersion = spawnSync(process.execPath, [npm, '--version'], { encoding: 'utf8', timeout: 15_000 }).stdout.trim();
  const tool: Tool = host.manager === 'npm' ? { name: 'npm', version: npmVersion, args: [npm] }
    : { name: 'pnpm', version: host.managerVersion!, args: [npm, 'exec', '--yes', '--ignore-scripts', `--package=pnpm@${host.managerVersion}`, '--', 'pnpm'] };
  if (tool.name === 'pnpm' && mode === 'install') {
    const version = execute(tool, ['--version'], os.tmpdir());
    if (version.status !== 0 || version.stdout.trim() !== tool.version) fail('PACKAGE_TOOL_MISSING', 'The exact owner pnpm tool could not be obtained through standard npm exec. Check npm registry/tool availability; no host was changed.');
  }
  const lockName = tool.name === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
  const yaml = tool.name === 'pnpm' ? createRequire(path.join(host.directory, 'package.json'))('yaml') : undefined;
  const pnpmOptions = ['--ignore-scripts', '--ignore-workspace', '--config.auto-install-peers=false', '--strict-peer-dependencies'];
  const id = digest(JSON.stringify({ target: host.directory, peers: host.peers, packages: piRelease, manager: host.manager }));
  const root = path.join(componentDataDirectory(), 'installations', id);
  const cliRoot = fileURLToPath(new URL('../../', import.meta.url));
  const fromCli = path.relative(cliRoot, root);
  if (root.split(path.sep).includes('_npx') || !fromCli.startsWith('..') && !path.isAbsolute(fromCli)) fail('UNSAFE_COMPONENT_LOCATION', 'Use a durable current-user data home outside the compiled CLI and npx cache before retrying.');
  const consumer = path.join(root, 'consumer');
  const adapter = path.join(consumer, 'node_modules', piComponentNames.piAdapter);
  const recordFile = path.join(root, 'components.json');
  const manifest = { name: `arlo-components-${id.slice(0, 16)}`, private: true, type: 'module',
    ...(tool.name === 'pnpm' ? { packageManager: `pnpm@${tool.version}` } : {}),
    dependencies: { ...piRelease, ...Object.fromEntries(Object.entries(host.peers).map(([name, peer]) => [name, `${tool.name === 'npm' ? 'file' : 'link'}:${peer.directory}`])) } };
  const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
  const expectedOwned = { files: ['consumer/package.json', `consumer/${lockName}`], packageEntries: Object.keys(piRelease),
    peerLinks: piPeers.map(name => `consumer/node_modules/${name}`) };
  let record = privateRecord(recordFile);
  const recordedFilesMissing = () => !record?.cleanup && !!record?.artifacts && Object.values(record.artifacts)
    .some(entry => typeof entry.directory === 'string' && !fs.existsSync(entry.directory));
  function validateRecord() {
    if (!record || record.schemaVersion !== 1 || record.kind !== 'components' || record.id !== id || record.root !== root || record.consumer !== consumer
      || JSON.stringify(record.host) !== JSON.stringify(host) || JSON.stringify(record.packages) !== JSON.stringify(piRelease)
      || record.manager?.name !== tool.name || record.manager.version !== tool.version
      || !['consuming', 'components-installed', 'registration-prepared', 'configured'].includes(record.phase)
      || !record.references || typeof record.references !== 'object' || Array.isArray(record.references)
      || record.manifestSha256 !== digest(manifestBytes) || record.borrowed === undefined
      || JSON.stringify(record.borrowed) !== JSON.stringify(host.peers)
      || JSON.stringify({ files: record.owned?.files, packageEntries: record.owned?.packageEntries, peerLinks: record.owned?.peerLinks }) !== JSON.stringify(expectedOwned)
      || record.owned?.inventory !== undefined && !validConsumerInventory(record.owned.inventory)
      || !/^[a-f0-9]{64}$/.test(record.planSha256)) fail('COMPONENT_OWNERSHIP_CONFLICT', 'The durable record does not prove this exact component resource. Preserve it and review its ownership; no host changes were applied.');
    for (const [scopeDirectory, reference] of Object.entries(record.references)) {
      if (!path.isAbsolute(scopeDirectory) || reference?.target !== target || !['registration-prepared', 'configured'].includes(reference.phase)
        || reference.kind !== undefined && !['setup-record', 'preexisting-declaration'].includes(reference.kind)) fail('COMPONENT_OWNERSHIP_CONFLICT', 'A referring scope record is ambiguous. Preserve the shared resource and review before retrying.');
    }
    if (record.cleanup?.phase === 'removed') {
      if (!path.isAbsolute(record.cleanup.scope) || Object.keys(record.references).length
        || ![record.cleanup.consumerSha256, record.cleanup.manifestSha256, record.cleanup.planSha256].every(value => /^[a-f0-9]{64}$/.test(value))
        || fingerprint(path.join(consumer, 'package.json')) !== record.cleanup.manifestSha256
        || fingerprint(path.join(consumer, lockName)) !== record.cleanup.planSha256 || consumerFingerprint(consumer) !== record.cleanup.consumerSha256
        || Object.keys(piRelease).some(name => fs.existsSync(path.join(consumer, 'node_modules', name)) || json(path.join(consumer, 'package.json')).dependencies?.[name])
        || Object.values(record.artifacts ?? {}).some(entry => fs.existsSync(entry.directory))) {
        fail('COMPONENT_OWNERSHIP_CONFLICT', 'The completed cleanup record does not prove an unchanged retired consumer. Preserve later edits and review before reinstalling.');
      }
      return;
    }
    if (record.cleanup?.phase === 'removing') {
      const recordedSnapshot = fingerprint(path.join(consumer, 'package.json')) === record.cleanup.manifestSha256
        && fingerprint(path.join(consumer, lockName)) === record.cleanup.planSha256 && consumerFingerprint(consumer) === record.cleanup.consumerSha256;
      const ownedProgress = matchesOwnedProgress(consumerInventory(consumer, yaml), record.cleanup.beforeInventory, record.cleanup.expectedInventory);
      if (!path.isAbsolute(record.cleanup.scope)
        || ![record.cleanup.consumerSha256, record.cleanup.manifestSha256, record.cleanup.planSha256].every(value => /^[a-f0-9]{64}$/.test(value))
        || !recordedSnapshot && !ownedProgress) {
        fail('COMPONENT_OWNERSHIP_CONFLICT', 'The unfinished cleanup consumer changed later. Preserve its files and private record for recovery review.');
      }
      if (mode === 'install') fail('COMPONENT_RECOVERY_REVIEW_REQUIRED', 'Finish the pending component cleanup using uninstall on this exact target before requesting a new installation.');
      return;
    }
    if (fingerprint(path.join(consumer, 'package.json')) !== record.manifestSha256 || fingerprint(path.join(consumer, lockName)) !== record.planSha256) {
      fail('COMPONENT_OWNERSHIP_CONFLICT', 'The owned component manifest or lock changed later. Preserve those edits and review before retrying.');
    }
    // Read-only status can name missing recorded components. It cannot certify
    // the remaining consumer inventory or authorize overwriting it on retry.
    if (record.consumerSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(record.consumerSha256) ||
      !(mode === 'inspect' && recordedFilesMissing()) && consumerFingerprint(consumer) !== record.consumerSha256)) fail('COMPONENT_OWNERSHIP_CONFLICT', 'Owned component or transitive files changed after the recorded phase. Preserve those edits and review before retrying.');
    if (record.artifacts && !record.consumerSha256) fail('COMPONENT_OWNERSHIP_CONFLICT', 'The installed component record lacks a verifiable owned consumer inventory. Preserve it for review.');
    if (record.artifacts && (Object.keys(record.artifacts).length !== Object.keys(piRelease).length ||
      Object.keys(piRelease).some(name => !record?.artifacts?.[name]))) fail('COMPONENT_OWNERSHIP_CONFLICT', 'The component record does not enumerate the exact installed batch. Preserve it for review.');
    if (record.artifacts) for (const [name, entry] of Object.entries(record.artifacts)) {
      if (entry.version !== piRelease[name] || typeof entry.directory !== 'string' || !entry.directory.startsWith(consumer + path.sep) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.integrity !== 'string' || typeof entry.resolved !== 'string') fail('COMPONENT_OWNERSHIP_CONFLICT', 'An artifact record cannot prove an owned component inside this consumer. Preserve the resource for review.');
      if (mode === 'inspect' && !fs.existsSync(entry.directory)) continue;
      const actual = physicalPackage(adapter, name);
      if (!actual.startsWith(consumer + path.sep) || actual !== entry.directory || artifactFingerprint(actual) !== entry.sha256) fail('COMPONENT_OWNERSHIP_CONFLICT', 'An installed component changed after setup. Preserve it and review before retrying.');
    }
  }
  if (record) validateRecord();
  else if (fs.existsSync(root)) fail('COMPONENT_OWNERSHIP_CONFLICT', 'An unrecorded durable installation already exists. Preserve it and review; setup cannot claim preexisting components.');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-components-plan-'));
  enforceWindowsAcl(stage, true);
  let lockBytes: string;
  try {
    if (record && !(mode === 'install' && record.cleanup?.phase === 'removed')) lockBytes = fs.readFileSync(path.join(consumer, lockName), 'utf8');
    else if (mode === 'inspect') lockBytes = '';
    else {
      fs.writeFileSync(path.join(stage, 'package.json'), manifestBytes, { mode: 0o600 });
      const result = execute(tool, tool.name === 'npm'
        ? ['install', '--package-lock-only', '--install-links=false', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund']
        : ['install', '--lockfile-only', ...pnpmOptions], stage);
      if (result.status !== 0 || result.error) fail('COMPONENT_PLAN_FAILED', `The exact coordinated batch could not be planned by npm (exit ${result.status ?? (result.error as NodeJS.ErrnoException | undefined)?.code}, signal ${result.signal ?? 'none'}). Check the standard registry configuration and release availability; nothing was installed in the durable target.`);
      // External-folder lock entries use paths relative to their consumer.
      // Rebase those paths when moving the planned lock to the durable root.
      const lock = tool.name === 'npm' ? json(path.join(stage, lockName)) : yaml.parse(fs.readFileSync(path.join(stage, lockName), 'utf8'));
      if (tool.name === 'pnpm') {
        const dependencies = lock.importers?.['.']?.dependencies;
        for (const [name, version] of Object.entries(piRelease)) {
          const entry = dependencies?.[name];
          const packageEntry = lock.packages?.[`${name}@${version}`];
          if (entry?.specifier !== version || entry.version.split('(')[0] !== version || !packageEntry?.resolution?.integrity) fail('COMPONENT_PLAN_CONFLICT', 'The pnpm plan does not contain the exact coordinated registry batch. No durable target changed.');
        }
        for (const [name, peer] of Object.entries(host.peers)) {
          const entry = dependencies?.[name];
          if (entry?.specifier !== `link:${peer.directory}` || !entry.version?.startsWith('link:') ||
            path.resolve(stage, entry.version.slice(5)) !== peer.directory) fail('HOST_PEER_CONFLICT', 'The pnpm plan substitutes a physical host peer. No host was acquired.');
          entry.version = `link:${path.relative(consumer, peer.directory).replaceAll(path.sep, '/')}`;
        }
        if (Object.keys(lock.packages ?? {}).some(name => name.startsWith('@earendil-works/') || name.startsWith('@deepseek-ai/') ||
          componentName(name) && !Object.keys(piRelease).some(allowed => name === `${allowed}@${piRelease[allowed as keyof typeof piRelease]}`))) {
          fail('COMPONENT_PLAN_CONFLICT', 'The pnpm plan acquires another host or uncoordinated component. No target changed.');
        }
        lockBytes = yaml.stringify(lock);
      } else {
      const rebased: Record<string, any> = {};
      for (const [name, value] of Object.entries(lock.packages) as [string, any][]) {
        const key = name && !name.startsWith('node_modules/') ? path.relative(consumer, path.resolve(stage, name)).replaceAll(path.sep, '/') : name;
        if (value.link) value.resolved = path.relative(consumer, path.resolve(stage, value.resolved)).replaceAll(path.sep, '/');
        rebased[key] = value;
      }
      lock.packages = rebased;
      for (const [name, version] of Object.entries(piRelease)) {
        const entry = lock.packages[`node_modules/${name}`];
        if (!entry || entry.version !== version || entry.link || typeof entry.integrity !== 'string' || !/^https?:/.test(entry.resolved ?? '')) fail('COMPONENT_PLAN_CONFLICT', 'The package plan does not contain the exact four compiled registry components. No durable target was changed.');
      }
      for (const [name, peer] of Object.entries(host.peers)) {
        const entry = lock.packages[`node_modules/${name}`];
        if (!entry?.link || path.resolve(consumer, entry.resolved) !== peer.directory) fail('HOST_PEER_CONFLICT', 'The standard package plan would install a different physical Pi peer. No host was acquired.');
      }
      for (const key of Object.keys(lock.packages)) {
        if (!key.startsWith('node_modules/')) continue;
        const name = key.split('node_modules/').at(-1)!;
        if ((name.startsWith('@earendil-works/') || name.startsWith('@deepseek-ai/') || componentName(name)) &&
          ![...Object.keys(piRelease), ...piPeers].some(allowed => key === `node_modules/${allowed}`)) fail('COMPONENT_PLAN_CONFLICT', 'The dependency plan includes another host or uncoordinated Arlo package. Preserve the selected host and resolve the release dependencies.');
      }
      lockBytes = JSON.stringify(lock, null, 2) + '\n';
      }
    }
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
  const state = () => ({ id, directory: root, consumer, manager: { name: tool.name, version: tool.version },
    state: record?.cleanup?.phase === 'removed' ? 'removed' : record?.cleanup?.phase === 'removing' ? 'partial' : record?.artifacts ? Object.values(record.artifacts).every(entry => fs.existsSync(entry.directory)) ? 'installed' : 'missing'
      : record ? 'partial' : mode === 'inspect' ? 'missing' : 'planned', transaction: record?.cleanup?.phase ?? record?.phase ?? 'none',
    packages: piRelease, borrowed: host.peers, references: Object.keys(record?.references ?? {}),
    ...(recordedFilesMissing() ? { inventory: 'review-required' } : {}) });
  const recheck = () => {
    if (JSON.stringify(inspectPiInstallation(target)) !== JSON.stringify(host)) fail('PACKAGE_PLAN_STALE', 'The selected host, physical peers or installation metadata changed after planning. Preserve the current installation and retry.');
  };
  let resourceRelease: (() => Promise<void>) | undefined;
  async function acquire() {
    recheck();
    prepareStateDirectory(path.dirname(root));
    resourceRelease = await setupTransaction(root);
    record = privateRecord(recordFile);
    if (record) validateRecord();
  }
  async function consume() {
    recheck();
    let renewed = false;
    if (record?.cleanup?.phase === 'removed') { validateRecord(); record = undefined; renewed = true; }
    if (record) {
      validateRecord();
      if (!record.artifacts && !record.consumerSha256 && fs.existsSync(path.join(consumer, 'node_modules'))) fail('COMPONENT_RECOVERY_REVIEW_REQUIRED', 'Consumption was interrupted before its owned inventory was recorded. Preserve the partial consumer and review it before retrying; unrecorded package edits cannot be safely overwritten.');
    }
    if (record?.artifacts) return;
    if (!record) {
      prepareStateDirectory(consumer);
      fs.writeFileSync(path.join(consumer, 'package.json'), manifestBytes, { mode: 0o600, flag: renewed ? 'w' : 'wx' });
      fs.writeFileSync(path.join(consumer, lockName), lockBytes, { mode: 0o600, flag: renewed ? 'w' : 'wx' });
      record = { schemaVersion: 1, id, kind: 'components', host, root, consumer, manager: tool, packages: piRelease,
        planSha256: digest(lockBytes), manifestSha256: digest(manifestBytes), phase: 'consuming', references: {},
        owned: expectedOwned, borrowed: host.peers, createdAt: new Date().toISOString() };
    }
    persistSetupRecord(recordFile, { ...record, phase: 'consuming', failure: undefined });
    const result = execute(tool, tool.name === 'npm' ? ['ci', '--install-links=false', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund']
      : ['install', '--frozen-lockfile', ...pnpmOptions], consumer);
    if (result.status !== 0 || result.error) {
      record = { ...record, phase: 'consuming', owned: { ...record.owned, inventory: consumerInventory(consumer, yaml) },
        consumerSha256: consumerFingerprint(consumer), failure: { code: (result.error as NodeJS.ErrnoException | undefined)?.code ?? 'PACKAGE_TOOL_FAILED', exit: result.status, signal: result.signal } };
      persistSetupRecord(recordFile, record);
      fail('COMPONENT_INSTALL_FAILED', `Component consumption failed (exit ${result.status ?? (result.error as NodeJS.ErrnoException | undefined)?.code}, signal ${result.signal ?? 'none'}). Owned partial components remain at ${root}; native registration did not run. Retry setup with the same exact target after resolving the package-tool failure.`);
    }
    recheck();
    const artifacts: NonNullable<ResourceRecord['artifacts']> = {};
    const lock = tool.name === 'npm' ? json(path.join(consumer, lockName)) : yaml.parse(fs.readFileSync(path.join(consumer, lockName), 'utf8'));
    for (const [name, version] of Object.entries(piRelease)) {
      const actual = physicalPackage(adapter, name);
      const entry = json(path.join(actual, 'package.json'));
      const exported = entry.exports?.['.'];
      const compiled = typeof exported === 'string' ? exported : exported?.default;
      if (entry.name !== name || entry.version !== version || !compiled?.endsWith('.js') || !fs.existsSync(path.join(actual, compiled)) ||
        !actual.startsWith(consumer + path.sep)) fail('DEPENDENCY_IDENTITY_MISMATCH', `Installed ${name} is not the approved compiled component in the owned consumer. Registration did not run.`);
      for (const [sibling, expected] of Object.entries(entry.dependencies ?? {})) if (componentName(sibling) && piRelease[sibling] !== expected) fail('DEPENDENCY_IDENTITY_MISMATCH', 'Installed Arlo siblings are not the coordinated exact batch. Registration did not run.');
      const resolution = tool.name === 'npm' ? lock.packages[`node_modules/${name}`] : lock.packages[`${name}@${version}`].resolution;
      artifacts[name] = { directory: actual, version, sha256: artifactFingerprint(actual), resolved: resolution.resolved ?? resolution.tarball ?? `${name}@${version}`,
        integrity: resolution.integrity };
    }
    for (const [name, peer] of Object.entries(host.peers)) if (physicalPackage(adapter, name) !== peer.directory) fail('HOST_PEER_CONFLICT', 'The installed adapter resolves a different physical host peer. Installed components remain for review; native registration did not run.');
    record = { ...record, phase: 'components-installed', artifacts, owned: { ...record.owned, inventory: consumerInventory(consumer, yaml) },
      consumerSha256: consumerFingerprint(consumer), failure: undefined };
    persistSetupRecord(recordFile, record);
  }
  function registration(phase: 'registration-prepared' | 'configured', kind: ReferenceKind = 'setup-record') {
    if (!record?.artifacts) fail('COMPONENT_OWNERSHIP_CONFLICT', 'Installed component ownership is unavailable; native registration cannot be recorded as complete.');
    record = { ...record, phase: record.phase === 'configured' ? 'configured' : phase, failure: undefined, references: { ...record.references, [scope]: { target, phase, kind } } };
    persistSetupRecord(recordFile, record);
  }
  function recordFailure(failure: SetupOperationFailure) {
    if (record) { record = { ...record, failure }; persistSetupRecord(recordFile, record); }
  }
  return { host, adapter, root, id, state, recheck, acquire, consume, registration, recordFailure,
    close: async () => { fs.rmSync(stage, { recursive: true, force: true }); await resourceRelease?.(); } };
}

/** A confirmed manual declaration can borrow an existing verified resource.
 * Its reference protects shared components without owning native registration. */
export async function retainedPiComponents(adapter: string, target: string, scope: string, npm?: string) {
  const relative = path.relative(path.join(componentDataDirectory(), 'installations'), adapter).split(path.sep);
  if (!/^[a-f0-9]{64}$/.test(relative[0]) || relative[1] !== 'consumer') return;
  const components = await preparePiComponents(target, scope, npm, 'inspect');
  try {
    if (components.state().state !== 'installed' || fs.realpathSync(components.adapter) !== adapter) {
      fail('COMPONENT_OWNERSHIP_CONFLICT', 'The manual declaration cannot prove shared use of this exact owned resource. Preserve its components and native settings for review.');
    }
    return components;
  } catch (error) { await components.close(); throw error; }
}
