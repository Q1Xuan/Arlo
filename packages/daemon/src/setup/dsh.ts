import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stdin } from 'node:process';
import { assertConfigurationFile, persistSetupRecord, recordedPackageDirectory, setupTransaction } from './transaction.ts';
import { assertSafeStatePath, enforceWindowsAcl, verifyWindowsAcl, ArloError } from '@arlo/sdk';
import { inspectDshHostPreparation, type DshHostPreparationReport } from '../../setup-dsh/host-preparation.mjs';
import { planDshInstallation, inspectDshPreparationRecovery, dshKnownAdapterNames } from './dsh-installation.ts';
import { SetupError, type SetupOperationFailure } from './errors.ts';
import { askSetup } from './pi-discovery.ts';

type Options = Record<string, string | boolean>;
type RecordState = { schemaVersion: 1; kind: 'dsh'; target: string; adapter: string; profile: string; home: string;
  owned: boolean; phase: 'prepared' | 'configured' | 'removing' | 'removed'; dependency?: string; rowSha256?: string; manager: 'npm' | 'pnpm'; createdAt: string;
  installation?: import('../../setup-dsh/installed-host.mjs').DshInstallationSelector;
  preparation?: { id: string; directory: string }; components?: { id: string; directory: string };
  experimentalCompatibility?: boolean; failure?: SetupOperationFailure };
class DshSetupError extends Error {
  readonly code: string;
  readonly nextStep: string;
  constructor(code: string, nextStep: string) { super(code); this.code = code; this.nextStep = nextStep; }
}
function fail(code: string, nextStep: string): never { throw new DshSetupError(code, nextStep); }
const json = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
function directory(value: string | undefined, code: string, nextStep: string): string {
  try { if (value && fs.statSync(value).isDirectory()) return fs.realpathSync(value); } catch { /* bounded diagnostic below */ }
  return fail(code, nextStep);
}
function installationDirectory(target: string): string {
  const parts = target.split(path.sep);
  const pnpm = parts.indexOf('.pnpm');
  const boundary = pnpm >= 0 ? pnpm - 1 : parts.lastIndexOf('node_modules');
  if (boundary < 0) return fail('DSH_INSTALLATION_MISSING', 'Select the DSH package inside its reviewed installed consumer; no host is copied or prepared by setup.');
  return parts.slice(0, boundary).join(path.sep) || path.parse(target).root;
}
function profileManifest(file: string): any {
  assertConfigurationFile(file);
  try {
    const manifest = json(file);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error();
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (manifest[field] !== undefined && (!manifest[field] || typeof manifest[field] !== 'object' || Array.isArray(manifest[field])
        || Object.values(manifest[field]).some(value => typeof value !== 'string'))) throw new Error();
    }
    const bundles = manifest.dsh?.profile?.bundles;
    if (bundles !== undefined && (!Array.isArray(bundles) || bundles.some(value => typeof value !== 'string'))) throw new Error();
    return manifest;
  } catch { return fail('CONFIGURATION_UNREADABLE', 'Repair the selected profile package.json without replacing its other settings, then retry.'); }
}
function writeRecord(file: string, record: RecordState): void {
  const parent = path.dirname(file);
  if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) fail('UNSAFE_SETUP_RECORD', 'Use a private real directory for DSH setup metadata.');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  enforceWindowsAcl(parent, true);
  assertSafeStatePath(parent);
  if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !verifyWindowsAcl(file).valid)) fail('UNSAFE_SETUP_RECORD', 'Review the unsafe private setup record before retrying.');
  persistSetupRecord(file, record);
}
function readRecord(file: string, target: string, adapter: string, profile: string, home: string): RecordState | undefined {
  if (!fs.existsSync(file)) return;
  assertSafeStatePath(path.dirname(file));
  if (fs.lstatSync(file).isSymbolicLink() || !verifyWindowsAcl(file).valid) return fail('UNSAFE_SETUP_RECORD', 'Preserve the unsafe private record and repair its ownership before retrying.');
  let record;
  try { record = json(file); } catch { return fail('SETUP_RECORD_UNREADABLE', 'Preserve and repair the private record; no profile setting was replaced.'); }
  if (!record || record.schemaVersion !== 1 || record.kind !== 'dsh' || record.target !== target || record.adapter !== adapter
    || record.profile !== profile || record.home !== home || typeof record.owned !== 'boolean'
    || !['prepared', 'configured', 'removing', 'removed'].includes(record.phase) || !['npm', 'pnpm'].includes(record.manager)
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || record.owned && typeof record.dependency !== 'string'
    || record.rowSha256 !== undefined && (typeof record.rowSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.rowSha256))
    || record.failure !== undefined && (!record.failure || !['HOST_PACKAGE_OPERATION_FAILED', 'REGISTRATION_INCOMPLETE'].includes(record.failure.code)
      || record.failure.exit !== null && !Number.isInteger(record.failure.exit)
      || record.failure.signal !== null && typeof record.failure.signal !== 'string'
      || !['native-install', 'native-remove'].includes(record.failure.operation))) {
    return fail('SETUP_OWNERSHIP_CONFLICT', 'The private record does not prove ownership of this exact target/profile. Preserve it and review the selected profile; no configuration changed.');
  }
  return record;
}
function npmCli(explicit?: string): string {
  const candidates = explicit ? [path.resolve(explicit)] : [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const found = candidates.find(file => file && file.endsWith('npm-cli.js') && fs.existsSync(file));
  if (!found) return fail('PACKAGE_TOOL_MISSING', 'Use your existing Node/npm installation or pass its exact npm-cli.js using --npm-cli. Setup does not install or switch Node.');
  return fs.realpathSync(found);
}
function packageManager(profile: string, manifest: any, consumer: string, npm: string): { name: 'npm' | 'pnpm'; executable: string; args: string[]; version?: string } {
  const hasPnpm = fs.existsSync(path.join(profile, 'pnpm-lock.yaml')) || fs.existsSync(path.join(profile, 'node_modules/.modules.yaml'));
  const hasNpm = fs.existsSync(path.join(profile, 'package-lock.json'));
  if (hasPnpm && hasNpm) return fail('PACKAGE_MANAGER_CONFLICT', 'The selected profile has both npm and pnpm lockfiles. Resolve its actual package-manager ownership before setup; no packages changed.');
  const declared = manifest.packageManager;
  if (declared !== undefined && (typeof declared !== 'string' || !/^(?:npm|pnpm)@\d+\.\d+\.\d+(?:\+sha(?:224|256|512)\.[a-f0-9]+)?$/.test(declared))) {
    return fail('PACKAGE_MANAGER_CONFLICT', 'The selected profile declares an unknown package manager. Resolve it through DSH before setup.');
  }
  const name = declared?.startsWith('pnpm@') || hasPnpm ? 'pnpm' : 'npm';
  if (declared?.startsWith('npm@') && hasPnpm || declared?.startsWith('pnpm@') && hasNpm) return fail('PACKAGE_MANAGER_CONFLICT', 'The selected profile manager and lockfile disagree; preserve them and resolve the conflict first.');
  if (name === 'npm') return { name, executable: process.execPath, args: [npm, '--global=false', `--prefix=${profile}`] };
  const hostManager = json(path.join(consumer, 'package.json')).packageManager;
  const version = (declared ?? hostManager)?.match(/^pnpm@(\d+\.\d+\.\d+)(?:\+sha(?:224|256|512)\.[a-f0-9]+)?$/)?.[1];
  if (!version) return fail('PACKAGE_MANAGER_CONFLICT', 'A pnpm profile requires its own or its prepared installation\'s exact declared pnpm version; setup will not guess a developer toolchain.');
  const local = path.join(path.dirname(process.execPath), 'node_modules/pnpm/bin/pnpm.cjs');
  if (fs.existsSync(local)) {
    const installed = json(path.resolve(local, '../../package.json')).version;
    if (installed === version) return { name, executable: process.execPath, args: [local, '--global=false', `--dir=${profile}`], version };
  }
  return { name, executable: process.execPath, args: [npm, '--global=false', `--prefix=${profile}`, 'exec', '--yes', '--ignore-scripts', `--package=pnpm@${version}`, '--', 'pnpm', '--global=false', `--dir=${profile}`], version };
}
function validatePackagePlan(profileDir: string, adapter: string, manager: ReturnType<typeof packageManager>, hostRequire: NodeJS.Require, remove: boolean): void {
  const planFiles = ['package.json', 'package-lock.json', 'pnpm-lock.yaml'];
  planFiles.forEach(file => assertConfigurationFile(path.join(profileDir, file)));
  const modules = path.join(profileDir, 'node_modules');
  if (fs.existsSync(modules) && fs.lstatSync(modules).isSymbolicLink()) fail('PROFILE_TARGET_CONFLICT', 'The profile node_modules directory is redirected. Select and prepare its actual owner through DSH before retrying.');
  const beforeFiles = Object.fromEntries(planFiles.map(file => [file, fs.existsSync(path.join(profileDir, file))
    ? fs.readFileSync(path.join(profileDir, file), 'utf8') : undefined]));
  if (manager.name === 'npm') {
    const args = remove ? ['uninstall', '@arlo/adapter-dsh'] : ['install', adapter, '--install-links=false'];
    const result = spawnSync(manager.executable, [...manager.args, ...args, '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--dry-run', '--json'],
      { cwd: profileDir, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
    let plan;
    try { const start = result.stdout.startsWith('{') ? 0 : result.stdout.indexOf('\n{') + 1; plan = JSON.parse(result.stdout.slice(start)); }
    catch { fail('PACKAGE_PLAN_UNAVAILABLE', 'The selected npm could not produce a readable package plan. Preserve the profile and inspect its native package-manager logs.'); }
    const expected = remove ? plan.remove : plan.add;
    if (result.status !== 0 || result.error || plan.added !== (remove ? 0 : 1) || plan.removed !== (remove ? 1 : 0) || plan.changed !== 0
      || !Array.isArray(expected) || expected.length !== 1 || expected[0].name !== '@arlo/adapter-dsh'
      || path.resolve(expected[0].path) !== path.join(profileDir, 'node_modules/@arlo/adapter-dsh')) {
      fail('PROFILE_PACKAGE_CHANGE_CONFLICT', 'The standard package plan would change existing profile modules. Reconcile this profile through DSH before setup; only the intended local Arlo link may be added or removed.');
    }
  } else {
    // Lock-only planning occurs on an independent private copy. Dereferencing
    // links avoids a staged node_modules path that could write into the user tree.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-dsh-plan-'));
    enforceWindowsAcl(stage, true);
    if (process.platform !== 'win32') fs.chmodSync(stage, 0o700);
    try {
      const planned = path.join(stage, 'profile');
      fs.mkdirSync(planned);
      for (const file of planFiles) if (beforeFiles[file] !== undefined) fs.writeFileSync(path.join(planned, file), beforeFiles[file], { mode: 0o600 });
      // pnpm remove has no lockfile-only mode. Plan that removal through a
      // manifest change in this private copy followed by its standard solver.
      if (remove) {
        const stagedFile = path.join(planned, 'package.json');
        const staged = profileManifest(stagedFile);
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
          if (staged[field]) delete staged[field]['@arlo/adapter-dsh'];
        }
        fs.writeFileSync(stagedFile, JSON.stringify(staged));
      }
      const args = remove ? ['install'] : ['add', `link:${adapter}`];
      const stagedArgs = manager.args.map(argument => argument === `--dir=${profileDir}` ? `--dir=${planned}`
        : argument === `--prefix=${profileDir}` ? `--prefix=${planned}` : argument);
      const result = spawnSync(manager.executable, [...stagedArgs, ...args, '--lockfile-only', '--ignore-scripts', '--ignore-workspace'],
        { cwd: planned, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
      if (result.status !== 0 || result.error) {
        const reason = `${result.stdout ?? ''}${result.stderr ?? ''}`.match(/ERR_PNPM_[A-Z_]+/)?.[0] ?? 'PACKAGE_TOOL_FAILED';
        fail('PACKAGE_PLAN_UNAVAILABLE', `The selected pnpm could not validate an isolated lock-only plan (${reason}, exit ${result.status ?? 'unknown'}). Preserve the profile and inspect its package-manager prerequisites.`);
      }
      const yaml = hostRequire('js-yaml');
      const stripOwnedRoot = (lock: any): any => {
        const value = structuredClone(lock);
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
          const dependencies = value.importers?.['.']?.[field];
          if (dependencies) { delete dependencies['@arlo/adapter-dsh']; if (!Object.keys(dependencies).length) delete value.importers['.'][field]; }
        }
        return value;
      };
      const before = beforeFiles['pnpm-lock.yaml'] ? yaml.load(beforeFiles['pnpm-lock.yaml']) : undefined;
      const after = yaml.load(fs.readFileSync(path.join(planned, 'pnpm-lock.yaml'), 'utf8'));
      const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
      if (before && JSON.stringify(ordered(stripOwnedRoot(before))) !== JSON.stringify(ordered(stripOwnedRoot(after)))) {
        fail('PROFILE_PACKAGE_CHANGE_CONFLICT', 'The isolated standard package plan would alter existing pnpm dependencies, patches or peer identities. Preserve the profile and reconcile it through DSH; setup only links the consumed Arlo package.');
      }
      if (!before && Object.keys(profileManifest(path.join(profileDir, 'package.json')).dependencies ?? {}).length) {
        fail('PROFILE_PACKAGE_CHANGE_CONFLICT', 'Existing pnpm profile dependencies have no lock proving their identities. Prepare a stable profile through DSH before setup.');
      }
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  if (planFiles.some(file => (fs.existsSync(path.join(profileDir, file)) ? fs.readFileSync(path.join(profileDir, file), 'utf8') : undefined) !== beforeFiles[file])) {
    fail('PACKAGE_PLAN_STALE', 'The selected profile changed while its plan was checked. Preserve the current edits and retry; setup does not restore an older snapshot.');
  }
}
function nativeOperation(target: string, home: string, profile: string, adapter: string, manager: ReturnType<typeof packageManager>, remove: boolean): { exit: number | null; signal: string | null } {
  const action = manager.name === 'npm'
    ? remove ? ['uninstall', '@arlo/adapter-dsh'] : ['install', adapter, '--install-links=false']
    : remove ? ['remove', '@arlo/adapter-dsh'] : ['add', `link:${adapter}`];
  const flags = manager.name === 'npm' ? ['--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps']
    : ['--config.ignore-scripts=true'];
  const bridge = path.resolve(import.meta.dirname, '../../setup-dsh/native-profile.mjs');
  const result = spawnSync(process.execPath, [bridge, target, manager.executable, JSON.stringify(manager.args),
    'plugin', '--profile', profile, ...action, ...flags], { cwd: path.join(home, 'profiles', profile),
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, encoding: 'utf8', windowsHide: true,
    timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new SetupError('HOST_PACKAGE_OPERATION_FAILED',
    `The selected DSH profile ${remove ? 'remove' : 'install'} operation failed (exit ${result.status ?? (result.error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown'}, signal ${result.signal ?? 'none'}). Inspect that profile's private native package-manager log and setup record; no success was recorded.`,
    { code: 'HOST_PACKAGE_OPERATION_FAILED', exit: result.status, signal: result.signal, operation: remove ? 'native-remove' : 'native-install' });
  return { exit: result.status, signal: result.signal };
}
function summary(report: any): object | undefined {
  if (!report) return;
  return { ready: report.ready, hostVersion: report.hostVersion, hostSupportPolicy: report.hostSupportPolicy,
    requiredContracts: report.requiredContracts, inspectionRuntime: report.runtime, dependencyClosure: report.dependencyClosure,
    environmentEvidence: report.environmentEvidence, installation: report.installation,
    reason: report.reason, missing: report.checks?.filter((check: any) => !check.ok) };
}
function contactDigest(rows: any[]): string {
  return createHash('sha256').update(JSON.stringify(rows.map(row => ({ id: row.id, name: row.name,
    disabled: row.disabled ?? false, config: row.config })))).digest('hex');
}
function removeOwnedLink(link: string, adapter: string): void {
  try {
    if (!fs.lstatSync(link).isSymbolicLink() || recordedPackageDirectory(link) !== adapter) {
      fail('CONFIGURATION_CHANGED', 'The retained package path is no longer the owned local link. Preserve it and inspect the profile before retrying.');
    }
    fs.unlinkSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Profile-only setup over the owning DSH's public native package manager. */
export async function runDshSetupCli(command: string, options: Options): Promise<number> {
  let hostPreparation: DshHostPreparationReport | undefined;
  let release: (() => Promise<void>) | undefined;
  let installation: Awaited<ReturnType<typeof planDshInstallation>> | undefined;
  let scopeRecord: { file: string; value: RecordState } | undefined;
  const output = (value: object) => console.log(JSON.stringify(value, null, 2));
  try {
    const profile = options['--profile'] as string;
    const selectedHome = path.resolve(options['--dsh-home'] as string ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile) || !fs.existsSync(path.join(selectedHome, 'profiles', profile, 'package.json'))) {
      fail('PROFILE_NOT_FOUND', 'Select an existing profile with --profile NAME and its owning --dsh-home DIR. Create or prepare profiles through DSH before setup; no profile was initialized.');
    }
    const home = directory(selectedHome, 'PROFILE_NOT_FOUND', 'Select the existing DSH home for this profile.');
    const profileDir = path.join(home, 'profiles', profile);
    const actualProfile = fs.realpathSync(profileDir);
    if (fs.lstatSync(profileDir).isSymbolicLink() || (process.platform === 'win32' ? actualProfile.toLowerCase() !== profileDir.toLowerCase() : actualProfile !== profileDir)) fail('PROFILE_TARGET_CONFLICT', 'The selected profile or its parent is redirected. Select its owning DSH home and real profile; setup does not follow ambiguous profile targets.');
    const file = path.join(profileDir, 'package.json');
    const recordFile = path.join(profileDir, 'arlo-setup', 'dsh.json');
    const checkpoint = (value: RecordState) => { writeRecord(recordFile, value); scopeRecord = { file: recordFile, value }; };
    const recordFingerprint = () => fs.existsSync(recordFile) ? createHash('sha256').update(fs.readFileSync(recordFile)).digest('hex') : 'missing';
    const initialRecordFingerprint = recordFingerprint();
    const initial = profileManifest(file);
    let current = initial;
    const selectedTarget = options['--target'] as string;
    if (!selectedTarget) fail('HOST_NOT_FOUND', 'Select the exact existing DSH package directory with --target; no host is downloaded.');
    const hasManualAdapter = dshKnownAdapterNames.some(name => ({ ...initial.dependencies, ...initial.optionalDependencies, ...initial.devDependencies })[name] !== undefined
      || initial.dsh?.profile?.bundles?.includes(name));
    if (!options['--adapter'] && !fs.existsSync(recordFile) && !hasManualAdapter
      && (command === 'setup-status' || command === 'setup' && !fs.existsSync(selectedTarget))) {
      const recovery = inspectDshPreparationRecovery(selectedTarget);
      if (recovery) {
        output({ host: 'dsh', scope: 'profile', profile, profileDir, home, ...recovery,
          phase: 'recovery-required', registration: { state: 'unobserved', ownership: 'not-recorded' },
          transaction: 'none', runtime: 'unobserved', communication: 'unobserved',
          ...(command === 'setup' ? { error: 'DSH_PREPARATION_RECOVERY_REQUIRED' } : {}) });
        return command === 'setup-status' ? 0 : 1;
      }
    }
    let target = directory(options['--target'] as string, 'HOST_NOT_FOUND', 'Select the exact existing DSH package directory with --target; no host is downloaded.');
    let adapterSelection = options['--adapter'] as string | undefined;
    let retainedAutomatic: RecordState | undefined;
    if (!adapterSelection && fs.existsSync(recordFile)) {
      try { retainedAutomatic = json(recordFile); } catch { fail('SETUP_RECORD_UNREADABLE', 'Preserve and repair the private native setup record before selecting its retained adapter.'); }
      if (!retainedAutomatic?.installation || !retainedAutomatic.components || !retainedAutomatic.preparation
        || retainedAutomatic.kind !== 'dsh' || retainedAutomatic.schemaVersion !== 1 || retainedAutomatic.profile !== profile
        || retainedAutomatic.home !== home || retainedAutomatic.target !== retainedAutomatic.installation.packageDirectory
        || typeof retainedAutomatic.experimentalCompatibility !== 'boolean') fail('SETUP_OWNERSHIP_CONFLICT', 'The retained native record cannot identify an automatic installation. Preserve it and select its exact original adapter with --adapter.');
    }
    const automatic = !adapterSelection && (command === 'setup' || !!retainedAutomatic);
    let experimental = options['--experimental'] === true || retainedAutomatic?.experimentalCompatibility === true;
    if (automatic) {
      const dependencies = { ...initial.dependencies, ...initial.optionalDependencies, ...initial.devDependencies };
      if (!retainedAutomatic && dshKnownAdapterNames.some(name => dependencies[name] !== undefined || initial.dsh?.profile?.bundles?.includes(name))) {
        fail('DUPLICATE_ADAPTER_CONFLICT', 'This existing profile already declares Arlo. Preserve its manual registration and select that exact compiled adapter before acquiring another release.');
      }
      installation = await planDshInstallation(target, profileDir, options['--npm-cli'] as string, experimental, command === 'setup-status' ? 'inspect' : 'install');
      if (retainedAutomatic && (JSON.stringify(retainedAutomatic.installation) !== JSON.stringify(installation.initial.selector)
        || retainedAutomatic.adapter !== recordedPackageDirectory(installation.components.adapter) || retainedAutomatic.components?.id !== installation.components.id
        || retainedAutomatic.preparation?.id !== installation.preparationId)) fail('SETUP_OWNERSHIP_CONFLICT', 'The selected native owner differs from the retained automatic resource. Preserve both installations and select the exact original target.');
      if (command === 'setup' && !retainedAutomatic) {
        const staged = await installation.components.preflight();
        const profileManager = packageManager(profileDir, current, installation.initial.owner, npmCli(options['--npm-cli'] as string));
        const preflightRequire = createRequire(path.join(installation.initial.directory, 'package.json'));
        validatePackagePlan(profileDir, staged.adapter, profileManager, preflightRequire, false);
      const preview = { host: 'dsh', target: installation.host, scope: 'profile', profile, profileDir, home,
        adapter: { directory: installation.components.adapter }, preparation: installation.summary(), components: installation.components.state(),
        registration: { manager: profileManager.name, dependency: `file:${installation.components.adapter}`, bundle: '@arlo/adapter-dsh', state: 'validated' },
        phase: 'preview', configured: false, runtime: 'unobserved', communication: 'unobserved',
        changes: ['Prepare this exact existing DSH installation using the bundled version-specific repairs and its own standard package manager.',
          'Add only the missing reviewed browser packages; retain unrelated dependencies and package/patch records.',
          'Consume the exact coordinated Arlo release in the durable component resource and borrow the selected physical host modules.',
          'Register this durable adapter through the selected existing native DSH profile and checkpoint each owned phase.'],
        nextStep: 'Verify the selected installation, repairs, components and existing profile, then repeat with --apply. Start or reload this same profile normally afterward.' };
      if (options['--apply']) console.error(JSON.stringify(preview, null, 2)); else output(preview);
      if (!options['--apply']) {
        if (!stdin.isTTY || options['--json']) return 0;
        const answer = await askSetup('Apply this installation preparation and selected native profile registration? [y/N]: ');
        if (!answer || !['y', 'yes'].includes(answer.toLowerCase())) { output({ phase: 'cancelled', nextStep: 'Cancelled. No changes applied.' }); return 0; }
        options['--apply'] = true;
      }
      await installation.acquire();
      release = await setupTransaction(path.dirname(recordFile));
      current = profileManifest(file);
      if (JSON.stringify(current) !== JSON.stringify(initial) || recordFingerprint() !== initialRecordFingerprint) fail('PACKAGE_PLAN_STALE', 'The selected profile or setup ownership record changed after its installation was planned. Preserve those edits and preview the same selection again.');
      }
      if (command === 'setup' && options['--apply']) {
        hostPreparation = await installation.apply();
        await installation.components.acquire();
        await installation.components.consume();
      }
      adapterSelection = installation.components.adapter;
      target = installation.host.directory;
    }
    let host;
    try { host = json(path.join(target, 'package.json')); } catch { fail('HOST_UNREADABLE', 'Select a readable existing DSH package directory.'); }
    if (host.name !== '@deepseek-ai/dsh') fail('HOST_UNSUPPORTED', 'Select the exact prepared DSH host package; no similarly named installation is changed.');
    const consumer = installationDirectory(target);
    const hostInspection = { experimental, ...(installation ? { installation: installation.initial.selector } : {}) };
    hostPreparation = inspectDshHostPreparation(consumer, hostInspection);
    if (!hostPreparation.ready) fail(hostPreparation.reason, hostPreparation.guidance);
    if (!['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.5'].includes(host.version)) fail('HOST_UNSUPPORTED', 'First-release setup supports only existing reviewed DSH compositions; prepare a listed host rather than automatically modifying an experimental installation.');
    if (!release && command !== 'setup-status' && options['--apply'] && (fs.existsSync(recordFile) || command === 'setup' && !initial.dsh?.profile?.bundles?.includes('@arlo/adapter-dsh'))) {
      release = await setupTransaction(path.dirname(recordFile));
      current = profileManifest(file);
    }
    if (!adapterSelection) fail('ADAPTER_NOT_FOUND', 'Select the exact recorded adapter path with --adapter.');
    const adapter = command !== 'setup' ? recordedPackageDirectory(adapterSelection)
      : directory(adapterSelection, 'ADAPTER_NOT_FOUND', 'Consume the delivered compiled private Arlo packages beside this prepared host, then select the adapter with --adapter. Do not run a generic npm install over the host\'s patched dependency tree.');
    const missingAdapter = !fs.existsSync(adapter);
    const scopeTarget = installation?.initial.selector.packageDirectory ?? target;
    const record = readRecord(recordFile, scopeTarget, adapter, profile, home);
    if (record) scopeRecord = { file: recordFile, value: record };
    if (missingAdapter && !record) fail('ADAPTER_NOT_FOUND', 'Consume the compiled private Arlo packages for this prepared host before setup. To revoke a lost component, select the exact adapter path retained by your private setup record.');
    const componentConsumer = installation?.components.state().consumer ?? consumer;
    const require = createRequire(path.join(componentConsumer, 'package.json'));
    let manifest: any = {}, adapterEntry: string;
    let delivery: any, composition: any;
    if (!missingAdapter) {
    try { manifest = json(path.join(adapter, 'package.json')); adapterEntry = require.resolve('@arlo/adapter-dsh'); }
    catch { fail('ADAPTER_UNREADABLE', 'Select the installed compiled @arlo/adapter-dsh from the reviewed private product.'); }
    if (manifest.name !== '@arlo/adapter-dsh' || fs.realpathSync(path.dirname(adapterEntry)) !== adapter || !adapterEntry.endsWith('.mjs')
      || typeof manifest.dsh?.bundle?.patch !== 'string' || !fs.existsSync(path.join(adapter, manifest.dsh.bundle.patch))) {
      fail('ADAPTER_IDENTITY_CONFLICT', 'The selected adapter must be the exact compiled package resolved by this prepared installation; preserve competing packages and select one reviewed product.');
    }
    delivery = await import(pathToFileURL(require.resolve('@arlo/adapter-dsh/delivery')).href);
    composition = delivery.inspectDshWebComposition(componentConsumer, { experimental });
    if (!composition.ready) fail(composition.reason, composition.guidance);
    }
    const hostRequire = createRequire(path.join(target, 'package.json'));
    const boot = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
    const loadProfile = () => {
      const loaded = boot.loadProfileDirectory('dsh', profileDir, path.join(target, 'package.json'));
      const homePatch = path.join(home, 'cordis.patch.yml');
      const rows = boot.composeEntries([...loaded.layers.map((layer: any) => layer.patches), loaded.patches,
        fs.existsSync(homePatch) ? boot.loadOverlayPatches('dsh', homePatch) : []]);
      return { loaded, rows: rows.filter((row: any) => row.name === '@arlo/adapter-dsh' || row.id === 'arlo-contact') };
    };
    let loaded: ReturnType<typeof loadProfile>;
    try { loaded = loadProfile(); } catch { fail('CONFIGURATION_UNREADABLE', 'Repair the selected profile layers through DSH; no patch or model configuration was replaced.'); }
    if (!missingAdapter && loaded.loaded.skippedBundles.some((bundle: any) => bundle.packageName === '@arlo/adapter-dsh')
      || loaded.rows.length > 1 || loaded.rows.some((row: any) => row.name !== '@arlo/adapter-dsh' || row.disabled)) {
      fail('DUPLICATE_ADAPTER_CONFLICT', 'Review the selected profile and home layers: keep one intended, enabled Arlo entry. Disabled and competing user entries are preserved.');
    }
    const dependencies = { ...current.devDependencies, ...current.optionalDependencies, ...current.dependencies };
    const declaration = dependencies['@arlo/adapter-dsh'];
    const link = path.join(profileDir, 'node_modules/@arlo/adapter-dsh');
    if (declaration && (recordedPackageDirectory(link) !== adapter || !missingAdapter && !loaded.rows.length)) {
      fail('ADAPTER_IDENTITY_CONFLICT', 'An existing profile dependency points elsewhere or is disabled. Preserve it and resolve the intended local package through DSH before setup.');
    }
    const configured = loaded.rows.length === 1 || missingAdapter && !!declaration && current.dsh?.profile?.bundles?.includes('@arlo/adapter-dsh');
    const activeOwnership = record?.owned && ['configured', 'removing'].includes(record.phase);
    const drifted = activeOwnership && (declaration !== undefined || configured) && (declaration !== record?.dependency
      || !current.dsh?.profile?.bundles?.includes('@arlo/adapter-dsh')
      || !missingAdapter && record?.rowSha256 !== undefined && record.rowSha256 !== contactDigest(loaded.rows));
    const manager = packageManager(profileDir, current, consumer, npmCli(options['--npm-cli'] as string));
    const resources = () => installation ? { preparation: installation.summary(), components: installation.components.state() } : {};
    const report = { host: 'dsh', target: { directory: target, version: host.version, consumer },
      adapter: { directory: adapter, version: manifest.version }, scope: 'profile', profile, profileDir, home,
      cliRuntime: { executable: process.execPath, version: process.versions.node },
      packageManager: { name: manager.name, executable: manager.executable, version: manager.version, acquisition: manager.args.includes('exec') ? 'standard-npm-exec' : 'installed-tool' },
      hostPreparation: summary(hostPreparation), composition: summary(composition), packages: missingAdapter ? 'missing' : 'installed', configured,
      transaction: record?.phase ?? 'none',
      ...(record?.failure ? { failure: record.failure } : {}),
      ...resources(),
      ownership: drifted ? 'conflict' : activeOwnership && configured ? 'arlo' : configured ? 'preexisting' : 'none',
      environment: process.versions.node === '24.13.1' ? 'baseline-cli-runtime' : 'unverified-cli-runtime',
      runtime: 'unobserved', communication: 'unobserved',
      hostRuntime: { state: 'unobserved', nextStep: 'Start or reload the selected profile normally. Its Host output reports arlo-host-loaded with the actual Node and adapter identity; then confirm native contacts and communication in Web. Disk configuration is not a loaded-process claim.' },
      daemonRuntime: { state: 'unobserved', nextStep: 'Use arlo status and arlo doctor for the shared Daemon; setup does not restart it.' },
    };
    if (command === 'setup-status') { output({ ...report, phase: drifted ? 'configuration-conflict' : record?.phase === 'prepared' || record?.phase === 'removing' ? 'recovery-required' : configured ? 'pending-start-or-reload' : 'not-configured', nextStep: drifted ? 'The owned dependency or contact configuration changed. Preserve your edits and review the native profile registration.' : missingAdapter ? 'Restore the correct compiled private adapter package, or use uninstall with this exact recorded target/profile to revoke only its owned wiring. Then start or reload the selected profile normally.' : report.hostRuntime.nextStep }); return 0; }
    if (drifted) fail('CONFIGURATION_CHANGED', 'The owned dependency, bundle or contact configuration changed after setup. Preserve your edits and review the intended entry through DSH before removal.');
    if (record?.phase === 'prepared' && (configured || declaration || fs.existsSync(link))) fail('RECOVERY_REVIEW_REQUIRED', 'A native profile installation was interrupted with partial wiring. Intent alone cannot prove ownership. Preserve your edits, inspect the selected profile and remove the ambiguous registration through DSH before retrying.');
    if (command === 'uninstall') {
      if (activeOwnership && record && !declaration && !current.dsh?.profile?.bundles?.includes('@arlo/adapter-dsh')) {
        if (!options['--apply']) { output({ ...report, phase: 'preview', changes: ['Finish the pending owned removal and remove only its remaining local link.'], nextStep: 'Repeat with --apply, then reload the profile normally.' }); return 0; }
        removeOwnedLink(link, adapter);
        checkpoint({ ...record, phase: 'removed', owned: false, failure: undefined });
        output({ ...report, failure: undefined, configured: false, ownership: 'none', transaction: 'removed', phase: 'removed-pending-reload', nextStep: 'The pending removal is complete. Reload this profile normally; user edits, other clients and shared packages remain.' }); return 0;
      }
      if (!record?.owned || !['configured', 'removing'].includes(record.phase) || !configured) {
        output({ ...report, phase: configured ? 'preexisting-preserved' : 'already-removed', nextStep: 'No owned profile registration was removed. Consumed packages, other profiles, history and shared Daemon are preserved.' }); return 0;
      }
      if (declaration !== record.dependency || !current.dsh?.profile?.bundles?.includes('@arlo/adapter-dsh')) fail('CONFIGURATION_CHANGED', 'The owned dependency or bundle changed after setup. Preserve your changes and review that entry through DSH before removal.');
      if (!options['--apply']) { output({ ...report, phase: 'preview', changes: ['Remove only the owned local profile dependency and its native bundle through DSH.'], nextStep: 'Repeat with --apply, then reload this profile normally.' }); return 0; }
      validatePackagePlan(profileDir, adapter, manager, hostRequire, true);
      checkpoint({ ...record, phase: 'removing', failure: undefined });
      const operation = nativeOperation(target, home, profile, adapter, manager, true);
      const removed = profileManifest(file);
      if (removed.dependencies?.['@arlo/adapter-dsh'] || removed.dsh?.profile?.bundles?.includes('@arlo/adapter-dsh')) {
        throw new SetupError('REGISTRATION_INCOMPLETE', 'The native package manager retained an Arlo declaration. Review the private record and current profile; no removal success was recorded.',
          { code: 'REGISTRATION_INCOMPLETE', ...operation, operation: 'native-remove' });
      }
      // npm can leave an extraneous local link after removing its declaration.
      // Remove that single owned link only; the shared compiled package is untouched.
      removeOwnedLink(link, adapter);
      checkpoint({ ...record, phase: 'removed', owned: false, failure: undefined });
      output({ ...report, failure: undefined, configured: false, ownership: 'none', transaction: 'removed', phase: 'removed-pending-reload', operation, nextStep: 'Reload the selected profile normally. Shared packages, other profiles, histories, root identities, allowance records and Daemon remain.' }); return 0;
    }
    if (record?.phase === 'removing') fail('RECOVERY_REVIEW_REQUIRED', 'Finish the pending uninstall with the same exact target/profile before requesting a new setup.');
    if (configured) { output({ ...report, phase: 'already-configured-pending-reload', nextStep: report.hostRuntime.nextStep }); return 0; }
    if (!options['--apply']) { output({ ...report, phase: 'preview', changes: ['Use the selected DSH native profile manager to link the compiled installed adapter.', 'Enable its shipped bundle/client through the native profile mechanism and write a private ownership record.'], nextStep: 'Verify the exact target/profile and repeat with --apply; then start or reload the profile normally.' }); return 0; }
    validatePackagePlan(profileDir, adapter, manager, hostRequire, false);
    const prepared: RecordState = { schemaVersion: 1, kind: 'dsh', target: scopeTarget, adapter, profile, home, owned: false,
      phase: 'prepared', manager: manager.name, createdAt: new Date().toISOString(), ...(installation ? {
        installation: installation.initial.selector, preparation: { id: installation.preparationId, directory: installation.root },
        components: { id: installation.components.id, directory: installation.components.root }, experimentalCompatibility: experimental } : {}) };
    if (installation) { installation.components.registration('registration-prepared'); installation.registration('prepared'); }
    checkpoint(prepared);
    const operation = nativeOperation(target, home, profile, adapter, manager, false);
    const after = profileManifest(file);
    const loadedAfter = loadProfile();
    if (!fs.existsSync(link) || recordedPackageDirectory(link) !== adapter || loadedAfter.rows.length !== 1 || loadedAfter.rows[0].disabled
      || !after.dsh?.profile?.bundles?.includes('@arlo/adapter-dsh')) throw new SetupError('REGISTRATION_INCOMPLETE', 'Native registration did not load one intended bundle; the prepared record is retained for safe review and retry.',
        { code: 'REGISTRATION_INCOMPLETE', ...operation, operation: 'native-install' });
    const hostAfter = inspectDshHostPreparation(consumer, hostInspection);
    if (!hostAfter.ready || hostAfter.dependencyClosure?.installedIdentitySha256 !== hostPreparation.dependencyClosure?.installedIdentitySha256
      || hostAfter.dependencyClosure?.lockSha256 !== hostPreparation.dependencyClosure?.lockSha256) {
      fail('HOST_DEPENDENCY_CHANGED', 'The selected host changed during profile setup. Preserve the prepared record and inspect the host; setup does not repair or replace its dependencies.');
    }
    const post = delivery.inspectDshWebComposition(componentConsumer, { experimental });
    if (!post.ready) fail(post.reason, post.guidance);
    checkpoint({ ...prepared, phase: 'configured', owned: true, dependency: after.dependencies?.['@arlo/adapter-dsh'], rowSha256: contactDigest(loadedAfter.rows) });
    if (installation) { installation.components.registration('configured'); installation.registration('configured'); }
    output({ ...report, ...resources(), failure: undefined, configured: true, ownership: 'arlo', transaction: 'configured', phase: 'configured-pending-start-or-reload', operation, nextStep: report.hostRuntime.nextStep }); return 0;
  } catch (error) {
    const failure = error instanceof SetupError ? error.failure : undefined;
    const failureRecording: string[] = [];
    if (failure && scopeRecord && release) {
      const expected = scopeRecord.value;
      try {
        const retained = readRecord(scopeRecord.file, expected.target, expected.adapter, expected.profile, expected.home);
        if (JSON.stringify(retained) !== JSON.stringify(expected)) fail('SETUP_OWNERSHIP_CONFLICT', 'The native setup record changed during registration. Preserve its current contents before recovery.');
        const failed = { ...expected, failure };
        writeRecord(scopeRecord.file, failed);
        scopeRecord.value = failed;
      } catch { failureRecording.push('native-profile'); }
      try { installation?.components.recordFailure(failure); } catch { failureRecording.push('components'); }
    }
    const unsafe = error instanceof ArloError && ['UNSAFE_LOCATION', 'INSECURE_PERMISSIONS', 'INVALID_OWNERSHIP'].includes(error.code);
    output({ error: unsafe ? 'UNSAFE_SETUP_RECORD' : error instanceof DshSetupError || error instanceof SetupError ? error.code : error instanceof Error && ['SETUP_BUSY', 'CONFIGURATION_TARGET_CONFLICT'].includes(error.message) ? error.message : 'SETUP_FAILED', hostPreparation: summary(hostPreparation),
      ...(scopeRecord ? { transaction: scopeRecord.value.phase } : {}), ...(failure ? { failure } : {}),
      ...(failureRecording.length ? { failureRecording: { unavailable: failureRecording } } : {}),
      ...(installation ? { preparation: installation.summary(), components: installation.components.state() } : {}),
      nextStep: unsafe ? 'Use a private, current-user-owned DSH home/profile. Setup does not change unrelated directory permissions.'
        : error instanceof DshSetupError || error instanceof SetupError ? error.nextStep : 'No success was recorded. Inspect the selected private record and native profile logs; never restore an entire old configuration snapshot.' });
    return 1;
  } finally { await release?.(); await installation?.close(); }
}
