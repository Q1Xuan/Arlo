import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ArloError, ArloErrorCode, DaemonClient, resolveStateDir, enforceWindowsAcl } from '@arlo/sdk';
import { componentDataDirectory, consumerFingerprint, npmCli, privateRecord, piComponentNames, type ResourceRecord } from './components.ts';
import { assertConfigurationFile, persistSetupRecord, recordedPackageDirectory, setupTransaction } from './transaction.ts';
import { fail } from './errors.ts';
import { consumerInventory, matchesOwnedProgress, validConsumerInventory, type ConsumerInventory } from './component-inventory.ts';

const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exists = (file: string) => { try { fs.lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
const sameNames = (left: unknown, right: string[]) => Array.isArray(left) && left.length === right.length &&
  [...left].sort().every((name, index) => name === [...right].sort()[index]);
const approved = Object.fromEntries(Object.values(JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).arlo?.components ?? {})
  .map((entry: any) => [entry.name, entry.version]));

/** Consumption may fail before a native scope journal exists. Locate only an
 * exact durable resource; ownership validation still decides what can change. */
export function locateOwnedPiCleanup(target: string, selectedAdapter?: string) {
  const installations = path.join(componentDataDirectory(), 'installations');
  if (selectedAdapter) {
    const relative = path.relative(installations, selectedAdapter).split(path.sep);
    if (/^[a-f0-9]{64}$/.test(relative[0]) && relative[1] === 'consumer') {
      return { installation: { id: relative[0], directory: path.join(installations, relative[0]) }, adapter: selectedAdapter };
    }
    return;
  }
  if (!fs.existsSync(installations)) return;
  const found = [];
  for (const entry of fs.readdirSync(installations, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const root = path.join(installations, entry.name);
    const record = privateRecord(path.join(root, 'components.json'));
    if (record?.host?.directory !== target || 'family' in record.host && record.host.family !== 'pi') continue;
    const consumer = path.join(root, 'consumer');
    const artifact = record.artifacts?.[piComponentNames.piAdapter]?.directory;
    const adapter = typeof artifact === 'string' && artifact.startsWith(consumer + path.sep) ? artifact
      : recordedPackageDirectory(path.join(consumer, 'node_modules', piComponentNames.piAdapter));
    found.push({ installation: { id: entry.name, directory: root }, adapter });
  }
  if (found.length > 1) fail('COMPONENT_OWNERSHIP_CONFLICT', 'More than one durable component resource names this Pi target. Preserve them and select the exact recorded adapter with --adapter before cleanup.');
  return found[0];
}

function liveConsumerProcess(consumer: string): { pid?: number; unverified?: boolean } {
  if (process.platform !== 'linux') return { unverified: true };
  const belongs = (location: string) => location === consumer || location.startsWith(consumer + path.sep);
  try {
    let unverified = false;
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      const directory = path.join('/proc', entry);
      try {
        if (fs.statSync(directory).uid !== process.getuid?.()) continue;
        let unreadable = 0;
        let args: string[] = [], cwd = '';
        try { args = fs.readFileSync(path.join(directory, 'cmdline'), 'utf8').split('\0'); }
        catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) unreadable++; }
        try { cwd = fs.readlinkSync(path.join(directory, 'cwd')).replace(/ \(deleted\)$/, ''); }
        catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) unreadable++; }
        if (args.some(belongs) || belongs(cwd)) return { pid: Number(entry) };
        if (unreadable === 2 && fs.existsSync(directory)) unverified = true;
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) unverified = true;
      }
    }
    return { unverified };
  } catch { return { unverified: true }; }
}

function executeRemoval(record: ResourceRecord, consumer: string, selectedNpm?: string) {
  const names = [...Object.keys(record.packages), ...Object.keys(record.borrowed)];
  const operation = record.manager.name === 'npm' ? ['uninstall', ...names, '--workspaces=false',
    '--install-links=false', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund']
    : ['exec', '--yes', '--ignore-scripts', `--package=pnpm@${record.manager.version}`, '--', 'pnpm', 'remove', ...names,
      `--dir=${consumer}`, '--global=false', '--config.ignore-scripts=true', '--ignore-workspace', '--config.auto-install-peers=false',
      '--config.modules-cache-max-age=0'];
  return spawnSync(process.execPath, [npmCli(selectedNpm), '--global=false', `--prefix=${consumer}`, ...operation],
    { cwd: consumer, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
}

/** Project a standard package removal on owned files only. This copy is never
 * restored to the target, and borrowed link destinations are never copied. */
function projectRemoval(record: ResourceRecord, selectedNpm: string | undefined, yaml: any) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-cleanup-plan-'));
  enforceWindowsAcl(stage, true);
  const rebase = (from: string, to: string) => {
    for (const relative of record.manager.name === 'npm' ? ['package-lock.json', 'node_modules/.package-lock.json']
      : ['pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']) {
      const file = path.join(stage, relative);
      if (!fs.existsSync(file)) continue;
      const lock = record.manager.name === 'npm' ? JSON.parse(fs.readFileSync(file, 'utf8')) : yaml.parse(fs.readFileSync(file, 'utf8'));
      let changed = record.manager.name === 'npm';
      if (record.manager.name === 'npm') {
        const packages: Record<string, any> = {};
        for (const [key, entry] of Object.entries(lock.packages ?? {}) as [string, any][]) {
          const destination = key && !key.startsWith('node_modules/') ? path.relative(to, path.resolve(from, key)).replaceAll(path.sep, '/') : key;
          if (entry.link && typeof entry.resolved === 'string') entry.resolved = path.relative(to, path.resolve(from, entry.resolved)).replaceAll(path.sep, '/');
          packages[destination] = entry;
        }
        lock.packages = packages;
      } else {
        for (const entry of Object.values(lock.importers?.['.']?.dependencies ?? {}) as any[]) if (entry.version?.startsWith('link:')) {
          const version = `link:${path.relative(to, path.resolve(from, entry.version.slice(5))).replaceAll(path.sep, '/')}`;
          if (entry.version !== version) { changed = true; entry.version = version; }
        }
      }
      if (changed) fs.writeFileSync(file, record.manager.name === 'npm' ? JSON.stringify(lock, null, 2) + '\n' : yaml.stringify(lock));
    }
  };
  try {
    fs.cpSync(record.consumer, stage, { recursive: true, verbatimSymlinks: true, dereference: false });
    rebase(record.consumer, stage);
    for (const [name, peer] of Object.entries(record.borrowed)) {
      const link = path.join(stage, 'node_modules', name);
      if (exists(link)) { fs.unlinkSync(link); fs.symlinkSync(peer.directory, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    }
    const result = executeRemoval(record, stage, selectedNpm);
    if (result.status !== 0 || result.error) return { result };
    rebase(stage, record.consumer);
    return { result, inventory: consumerInventory(stage, yaml) };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

function validOwnership(record: ResourceRecord | undefined, id: string, root: string, consumer: string, target: string, adapter: string): record is ResourceRecord {
  const hostTarget = record?.host && 'selector' in record.host && record.host.selector && typeof record.host.selector === 'object'
    && 'packageDirectory' in record.host.selector ? record.host.selector.packageDirectory : record?.host?.directory;
  if (!record || record.schemaVersion !== 1 || record.kind !== 'components' || record.id !== id || record.root !== root || record.consumer !== consumer
    || hostTarget !== target || !['npm', 'pnpm'].includes(record.manager?.name) || !/^\d+\.\d+\.\d+$/.test(record.manager.version)
    || !['consuming', 'components-installed', 'registration-prepared', 'configured'].includes(record.phase)
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || !record.packages || Array.isArray(record.packages)
    || !record.borrowed || Array.isArray(record.borrowed) || !record.references || Array.isArray(record.references)
    || !/^[a-f0-9]{64}$/.test(record.manifestSha256) || !/^[a-f0-9]{64}$/.test(record.planSha256)
    || !record.owned || !sameNames(record.owned.packageEntries, Object.keys(record.packages))
    || !sameNames(record.owned.files, ['consumer/package.json', `consumer/${record.manager.name === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml'}`])
    || !sameNames(record.owned.peerLinks, Object.keys(record.borrowed).map(name => `consumer/node_modules/${name}`))
    || record.owned.inventory !== undefined && !validConsumerInventory(record.owned.inventory)) return false;
  if (Object.keys(record.packages).length !== 4 || Object.entries(record.packages).some(([name, version]) => approved[name] !== version)
    || JSON.stringify(record.host.peers) !== JSON.stringify(record.borrowed)) return false;
  for (const [name, peer] of Object.entries(record.borrowed)) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || typeof peer?.directory !== 'string' || !path.isAbsolute(peer.directory)
      || typeof peer.version !== 'string' || !/^[a-f0-9]{64}$/.test(peer.manifestSha256)) return false;
  }
  for (const [directory, reference] of Object.entries(record.references)) {
    if (!path.isAbsolute(directory) || reference?.target !== target || !['registration-prepared', 'configured'].includes(reference.phase)
      || reference.kind !== undefined && !['setup-record', 'preexisting-declaration'].includes(reference.kind)) return false;
  }
  if (record.artifacts) {
    if (!sameNames(Object.keys(record.artifacts), Object.keys(record.packages)) || !/^[a-f0-9]{64}$/.test(record.consumerSha256 ?? '')) return false;
    for (const [name, artifact] of Object.entries(record.artifacts)) {
      if (artifact?.version !== record.packages[name] || !artifact.directory?.startsWith(consumer + path.sep)
        || path.resolve(artifact.directory) !== artifact.directory || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || typeof artifact.integrity !== 'string' || typeof artifact.resolved !== 'string') return false;
    }
    if (!Object.values(record.artifacts).some(artifact => artifact.directory === adapter)) return false;
  } else if (!adapter.startsWith(consumer + path.sep)) return false;
  if (record.cleanup && (!['removing', 'removed'].includes(record.cleanup.phase) || !path.isAbsolute(record.cleanup.scope)
    || ![record.cleanup.consumerSha256, record.cleanup.manifestSha256, record.cleanup.planSha256].every(value => /^[a-f0-9]{64}$/.test(value))
    || record.cleanup.beforeInventory !== undefined && !validConsumerInventory(record.cleanup.beforeInventory)
    || record.cleanup.expectedInventory !== undefined && !validConsumerInventory(record.cleanup.expectedInventory))) return false;
  return true;
}

/** Plan and revoke owned packages in their companion, separately from native registration. */
export async function prepareOwnedComponentCleanup(installation: { id: string; directory: string } | undefined,
  target: string, scope: string, adapter: string, selectedNpm?: string, nativeRegistrationRemains = false) {
  if (!installation) return;
  const root = installation.directory;
  const consumer = path.join(root, 'consumer');
  const recordFile = path.join(root, 'components.json');
  const reasons: string[] = [];
  if (nativeRegistrationRemains) reasons.push('The selected manual or unowned native declaration still uses this resource. Preserve its components until that declaration is removed normally.');
  let record: ResourceRecord | undefined;
  let writable = false;
  let recordHash: string | undefined;
  try {
    const withinCli = path.relative(fileURLToPath(new URL('../../', import.meta.url)), root);
    if (!/^[a-f0-9]{64}$/.test(installation.id) || !path.isAbsolute(root) || path.resolve(root) !== root
      || path.basename(root) !== installation.id || path.basename(path.dirname(root)) !== 'installations'
      || path.basename(path.dirname(path.dirname(root))) !== 'arlo' || root.split(path.sep).includes('_npx')
      || !withinCli.startsWith('..') && !path.isAbsolute(withinCli)) throw new Error();
    record = privateRecord(recordFile);
    writable = validOwnership(record, installation.id, root, consumer, target, adapter);
    if (!writable) throw new Error();
    recordHash = hash(recordFile);
  } catch {
    reasons.push('Component ownership or a referring scope is ambiguous. Preserve the private resource and its record for review.');
  }
  const packages = writable ? Object.keys(record!.packages) : [];
  const links = writable ? Object.keys(record!.borrowed) : [];
  const lock = path.join(consumer, record?.manager?.name === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');
  let yaml: any;
  try { if (writable && record!.manager.name === 'pnpm') yaml = createRequire(path.join(record!.host.directory, 'package.json'))('yaml'); }
  catch { reasons.push('The recorded package-manager metadata cannot be read through the selected host. Preserve this resource for scope recovery review.'); }
  const ownedConsumerMatches = () => {
    assertConfigurationFile(path.join(consumer, 'package.json'));
    assertConfigurationFile(lock);
    if (!fs.existsSync(path.join(consumer, 'package.json')) || !fs.existsSync(lock)) return false;
    if (record!.cleanup?.phase === 'removing' && record!.cleanup.beforeInventory) {
      return matchesOwnedProgress(consumerInventory(consumer, yaml), record!.cleanup.beforeInventory, record!.cleanup.expectedInventory);
    }
    const proof = record!.cleanup?.phase === 'removed' ? record!.cleanup : record!;
    return hash(path.join(consumer, 'package.json')) === proof.manifestSha256 && hash(lock) === proof.planSha256
      && (consumerFingerprint(consumer) === proof.consumerSha256 || record!.cleanup === undefined
        && matchesOwnedProgress(consumerInventory(consumer, yaml), record!.owned.inventory));
  };
  const persistRecord = () => {
    if (recordHash !== undefined && hash(recordFile) !== recordHash) fail('PACKAGE_PLAN_STALE', 'Component ownership changed during cleanup. Preserve the newer record and remaining resource for review.');
    persistSetupRecord(recordFile, record!);
    recordHash = hash(recordFile);
  };
  let currentScopeStillUsed = false;
  const inspectUnrecordedDeclarations = (includeSelected: boolean) => {
    if (!writable || record!.host && 'family' in record!.host && record!.host.family === 'dsh') return;
    const files = new Set([path.join(process.cwd(), '.pi', 'settings.json'), path.join(record!.host.owner, '.pi', 'settings.json'),
      path.join(os.homedir(), '.pi', 'agent', 'settings.json')]);
    for (const directory of [scope, ...Object.keys(record!.references)]) {
      files.add(path.join(directory, '.pi', 'settings.json'));
      files.add(path.join(path.dirname(directory), '.pi', 'settings.json'));
    }
    if (includeSelected) files.add(path.join(scope, 'settings.json'));
    for (const file of files) {
      if (file === path.join(scope, 'settings.json') && !includeSelected || !fs.existsSync(file)) continue;
      try {
        assertConfigurationFile(file);
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.packages !== undefined && !Array.isArray(value.packages)
          || value.extensions !== undefined && !Array.isArray(value.extensions)) throw new Error();
        const uses = [...value.packages ?? [], ...value.extensions ?? []].some(entry => {
          const source = typeof entry === 'string' ? entry : entry && typeof entry.source === 'string' ? entry.source : undefined;
          if (!source) return false;
          if (source.startsWith('npm:') || source.startsWith('git:')) return source.includes('adapter-pi');
          return [path.dirname(file), path.dirname(path.dirname(file))].some(base => {
            const location = recordedPackageDirectory(path.resolve(base, source));
            return location === consumer || location.startsWith(consumer + path.sep);
          });
        });
        if (uses) {
          if (file === path.join(scope, 'settings.json')) currentScopeStillUsed = true;
          const reason = 'A project or unrecorded manual Pi declaration still uses this resource. Preserve its components; review that native declaration before retrying cleanup.';
          if (!reasons.includes(reason)) reasons.push(reason);
        }
      } catch {
        const reason = 'Project or unrecorded native sharing cannot be verified. Preserve the component resource and unreadable declaration for review.';
        if (!reasons.includes(reason)) reasons.push(reason);
      }
    }
  };
  inspectUnrecordedDeclarations(false);
  if (writable) {
    if (Object.keys(record!.references).some(other => other !== scope)) reasons.push('Other integration scopes still refer to these components, including manual or older references.');
    try {
      if (!ownedConsumerMatches()) throw new Error();
      for (const peer of Object.values(record!.borrowed)) if (hash(path.join(peer.directory, 'package.json')) !== peer.manifestSha256) throw new Error();
    } catch { reasons.push('The owned consumer or a borrowed identity changed. Preserve its later edits and remaining files for review.'); }
  }
  let daemon: { state: string; pid?: number; daemonId?: string; activeEndpoints?: number } = { state: 'unobserved' };
  async function inspectDaemon() {
    if (!writable || record!.cleanup?.phase === 'removed') return;
    try {
      const status = await new DaemonClient().getStatus();
      daemon = { state: 'running', pid: status.pid, daemonId: status.daemon_id, activeEndpoints: status.active_endpoints_count };
      const reason = 'A shared Daemon is still running and its component use cannot be excluded. Keep this resource until its normal shutdown or idle exit; no client or Daemon was terminated.';
      if (!reasons.includes(reason)) reasons.push(reason);
    } catch (error) {
      if (error instanceof ArloError && error.code === ArloErrorCode.DAEMON_NOT_RUNNING && !fs.existsSync(path.join(resolveStateDir(), 'daemon.lock'))) {
        daemon = { state: 'not-running' };
      } else {
        daemon = { state: 'unverified' };
        const reason = 'Shared Daemon use is unverified or still starting. Preserve this resource; inspect arlo status and retry after normal shutdown.';
        if (!reasons.includes(reason)) reasons.push(reason);
      }
    }
    const usage = liveConsumerProcess(consumer);
    if (usage.pid) {
      if (daemon.state !== 'running') daemon = { state: 'running-from-resource', pid: usage.pid };
      const reason = 'A same-user process is still running from this component resource, including a shared Daemon in another state directory. Preserve its physical origin until normal shutdown or idle exit.';
      if (!reasons.includes(reason)) reasons.push(reason);
    } else if (usage.unverified) {
      if (daemon.state === 'not-running') daemon = { state: 'unverified' };
      const reason = 'Same-user process use of the component resource cannot be verified. Preserve it for runtime review before retrying cleanup.';
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  await inspectDaemon();
  let release: (() => Promise<void>) | undefined;
  const state = () => ({ consumer, directory: root, ...(writable ? { manager: { name: record!.manager.name, version: record!.manager.version } } : {}), packages, links,
    action: reasons.length ? 'retain' : record!.cleanup?.phase === 'removed' ? 'none' : 'remove',
    state: reasons.length ? 'retained' : record!.cleanup?.phase === 'removed' ? 'removed' : record!.cleanup?.phase === 'removing' ? 'recovery-required' : 'planned',
    ...(record?.cleanup?.failure ? { failure: record.cleanup.failure } : {}), daemon, reasons });
  return { state,
    async acquire() {
      if (!writable) return;
      release = await setupTransaction(root);
      if (hash(recordFile) !== recordHash) fail('PACKAGE_PLAN_STALE', 'Shared component ownership changed after this cleanup preview. Preserve the newer record and retry.');
      if (!reasons.length && !ownedConsumerMatches()) fail('PACKAGE_PLAN_STALE', 'The component consumer changed after preview. Preserve those changes and retry.');
    },
    async remove() {
      if (!writable) return;
      if (hash(recordFile) !== recordHash) {
        writable = false;
        reasons.push('The component ownership record changed during native revocation. Preserve the newer record and resource for review.');
        return;
      }
      try {
        if (!reasons.length && !ownedConsumerMatches()) throw new Error();
      } catch { reasons.push('Owned component files changed during native revocation. Preserve those later edits for review.'); }
      await inspectDaemon();
      inspectUnrecordedDeclarations(true);
      const references = { ...record!.references };
      if (!currentScopeStillUsed) delete references[scope];
      record = { ...record!, references };
      if (record.cleanup?.phase === 'removed' || reasons.length) { persistRecord(); return; }
      const inventory = () => ({ consumerSha256: consumerFingerprint(consumer), manifestSha256: hash(path.join(consumer, 'package.json')), planSha256: hash(lock) });
      const beforeInventory = consumerInventory(consumer, yaml);
      record = { ...record, cleanup: { phase: 'removing', scope, ...inventory(), beforeInventory } };
      persistRecord();
      const projected = projectRemoval(record, selectedNpm, yaml);
      if (!projected.inventory) {
        persistSetupRecord(path.join(root, 'component-remove-failure.json'), { stage: 'package-plan', exit: projected.result.status,
          signal: projected.result.signal, stdout: projected.result.stdout, stderr: projected.result.stderr });
        record.cleanup = { ...record.cleanup!, failure: { code: (projected.result.error as NodeJS.ErrnoException | undefined)?.code ?? 'PACKAGE_TOOL_FAILED',
          exit: projected.result.status, signal: projected.result.signal, operation: 'component-remove' } };
        persistRecord();
        fail('COMPONENT_REMOVE_FAILED', 'Native registration is removed; the standard companion package-removal plan failed. The unchanged owned consumer is retained. Resolve the package-tool failure and retry uninstall.');
      }
      if (!matchesOwnedProgress(consumerInventory(consumer, yaml), beforeInventory)) {
        reasons.push('The component consumer changed while the package-removal plan was being prepared. Preserve those later edits for review.');
        fail('COMPONENT_OWNERSHIP_CONFLICT', 'Native registration is removed, but the component cleanup plan became stale. Preserve the remaining entries and retry after reviewing the changes.');
      }
      record.cleanup = { ...record.cleanup!, expectedInventory: projected.inventory };
      persistRecord();
      await inspectDaemon();
      inspectUnrecordedDeclarations(true);
      if (reasons.length) return;
      const result = executeRemoval(record, consumer, selectedNpm);
      const retainedManifest = JSON.parse(fs.readFileSync(path.join(consumer, 'package.json'), 'utf8'));
      const incomplete = [...packages, ...links].some(name => exists(path.join(consumer, 'node_modules', name)) || retainedManifest.dependencies?.[name])
        || packages.some(name => record!.artifacts?.[name] && exists(record!.artifacts[name].directory));
      const remainingInventory = consumerInventory(consumer, yaml);
      if (!matchesOwnedProgress(remainingInventory, beforeInventory, projected.inventory)) {
        persistSetupRecord(path.join(root, 'component-cleanup-review.json'), { stage: 'package-remove',
          unmatched: Object.fromEntries(Object.entries(remainingInventory).filter(([file, entry]) => !matchesOwnedProgress({ [file]: entry }, beforeInventory, projected.inventory))
            .map(([file, entry]) => [file, { current: entry, before: beforeInventory[file], expected: projected.inventory![file] }])) });
        reasons.push('The package tool left added or edited entries outside the exact owned cleanup plan. Preserve those files and the unfinished record for review.');
        fail('COMPONENT_OWNERSHIP_CONFLICT', 'Native registration is removed, but cleanup ownership changed during the package operation. Preserve the remaining entries and private record; no snapshot was restored.');
      }
      if (result.status !== 0 || result.error || incomplete) {
        persistSetupRecord(path.join(root, 'component-remove-failure.json'), { exit: result.status, signal: result.signal,
          stdout: result.stdout, stderr: result.stderr });
        record.cleanup = { ...record.cleanup!, ...inventory(), failure: { code: (result.error as NodeJS.ErrnoException | undefined)?.code ?? (incomplete && result.status === 0 ? 'COMPONENT_REMOVAL_INCOMPLETE' : 'PACKAGE_TOOL_FAILED'), exit: result.status, signal: result.signal, operation: 'component-remove' } };
        persistRecord();
        fail('COMPONENT_REMOVE_FAILED', `Native Pi registration is removed; owned component cleanup failed (exit ${result.status ?? (result.error as NodeJS.ErrnoException | undefined)?.code}, signal ${result.signal ?? 'none'}). Resolve the package-tool failure and retry uninstall on the same target.`);
      }
      record.cleanup = { phase: 'removed', scope, ...inventory() };
      persistRecord();
    },
    close: async () => { await release?.(); } };
}
