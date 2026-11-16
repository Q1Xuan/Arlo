import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { stdin, stdout } from 'node:process';
import { assertConfigurationFile, recordedPackageDirectory, setupTransaction } from './transaction.ts';
import { writePrivateStateFile } from '../storage/index.ts';
import { assertSafeStatePath, enforceWindowsAcl, verifyWindowsAcl, ArloError } from '@arlo/sdk';
import { SetupError, fail, type SetupOperationFailure } from './errors.ts';
import { preparePiComponents, retainedPiComponents, physicalPackage, piComponentNames, piRelease } from './components.ts';
import { askSetup, selectPi } from './pi-discovery.ts';
import { locateOwnedPiCleanup, prepareOwnedComponentCleanup } from './component-cleanup.ts';
type Settings = { packages?: unknown[]; extensions?: unknown[]; [key: string]: unknown };
type Journal = { schemaVersion: 1; target: string; adapter: string; declaration: string; owned: boolean;
  phase: 'prepared' | 'configured' | 'removing' | 'removed'; createdAt: string;
  installation?: { id: string; directory: string }; failure?: SetupOperationFailure };
function readJson(file: string): any { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function settings(file: string): Settings {
  assertConfigurationFile(file);
  if (!fs.existsSync(file)) return {};
  try {
    const value = readJson(file);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (value.packages !== undefined && !Array.isArray(value.packages)) ||
        (value.extensions !== undefined && !Array.isArray(value.extensions))) throw new Error();
    return value;
  } catch { return fail('CONFIGURATION_UNREADABLE', 'Repair the selected user settings.json before retrying; no settings were replaced.'); }
}
function exactDirectory(value: string | undefined, code: string, step: string): string {
  try { if (value && fs.statSync(value).isDirectory()) return fs.realpathSync(value); } catch { /* actionable error below */ }
  return fail(code, step);
}
function journalWrite(file: string, value: Journal): void {
  const directory = path.dirname(file);
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) fail('UNSAFE_SETUP_RECORD', 'Use a private real directory for setup metadata.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  enforceWindowsAcl(directory, true);
  assertSafeStatePath(directory);
  if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !verifyWindowsAcl(file).valid)) fail('UNSAFE_SETUP_RECORD', 'Preserve and review the unsafe setup record before retrying.');
  writePrivateStateFile(directory, path.basename(file), JSON.stringify(value, null, 2) + '\n', true);
}
function sourceOf(entry: unknown): string | undefined {
  return typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'source' in entry && typeof entry.source === 'string' ? entry.source : undefined;
}
function nativePi(target: string, agentDir: string, action: 'install' | 'remove', adapter: string): void {
  const cli = path.join(target, readJson(path.join(target, 'package.json')).bin.pi);
  const result = spawnSync(process.execPath, [cli, action, adapter], {
    cwd: agentDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: 'false' },
    encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  // Native output can contain arbitrary user configuration. Keep it private.
  if (result.status !== 0 || result.error) throw new SetupError('HOST_PACKAGE_OPERATION_FAILED',
    `Pi ${action} failed (exit ${result.status ?? (result.error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown'}, signal ${result.signal ?? 'none'}). Review the private setup record and selected settings before retrying.`,
    { code: 'HOST_PACKAGE_OPERATION_FAILED', exit: result.status, signal: result.signal, operation: `native-${action}` });
}

/** Thin user-level wiring over Pi's own package registration. Package acquisition remains npm's job. */
export async function runSetupCli(command: string, args: string[]): Promise<number> {
  const options: Record<string, string | boolean> = {};
  const output = (report: object) => console.log(JSON.stringify(report, null, 2));
  let release: (() => Promise<void>) | undefined;
  let components: Awaited<ReturnType<typeof preparePiComponents>> | undefined;
  let cleanup: Awaited<ReturnType<typeof prepareOwnedComponentCleanup>>;
  try {
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (['--apply', '--json', '--experimental'].includes(key)) options[key] = true;
      else if (['--host', '--target', '--adapter', '--agent-dir', '--profile', '--dsh-home', '--npm-cli'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
      else fail('INVALID_ARGUMENT', 'Use setup|setup-status|uninstall --host pi --target PI_PACKAGE_DIR [--adapter ADAPTER_PACKAGE_DIR] [--agent-dir USER_AGENT_DIR] [--apply].');
    }
    if (!options['--host'] && stdin.isTTY && !options['--json']) {
      const host = await askSetup('Host to connect (pi/dsh, 0 to cancel): ');
      if (!host || ['0', 'q', 'cancel'].includes(host)) { output({ phase: 'cancelled', nextStep: 'Cancelled. No changes applied.' }); return 0; }
      options['--host'] = host;
    }
    if (options['--host'] === 'dsh') {
      const interactive = stdin.isTTY && !options['--json'];
      const home = path.resolve(options['--dsh-home'] as string ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
      if (!options['--target']) {
        if (!interactive) fail('HOST_SELECTION_REQUIRED', 'Noninteractive DSH setup requires an explicit --target DSH_PACKAGE_DIR and --profile NAME; no host or profile was guessed.');
        const { selectDsh } = await import('./dsh-discovery.ts');
        const target = await selectDsh(home, options['--npm-cli'] as string);
        if (!target) { output({ phase: 'cancelled', nextStep: 'Cancelled. No changes applied.' }); return 0; }
        options['--target'] = target;
      }
      if (!options['--profile']) {
        if (!interactive) fail('PROFILE_SELECTION_REQUIRED', 'Select one existing DSH profile explicitly with --profile NAME; no profile is initialized or enabled automatically.');
        const { selectDshProfile } = await import('./dsh-discovery.ts');
        const selected = await selectDshProfile(home);
        if (!selected) { output({ phase: 'cancelled', nextStep: 'Cancelled. No changes applied.' }); return 0; }
        options['--profile'] = selected.profile; options['--dsh-home'] = selected.home;
      }
      const { runDshSetupCli } = await import('./dsh.ts');
      return runDshSetupCli(command, options);
    }
    if (options['--host'] !== 'pi') fail('HOST_SELECTION_REQUIRED', 'Select --host pi and an exact existing --target; DSH requires the prepared-profile setup path.');
    if (!options['--target']) {
      if (!stdin.isTTY || options['--json']) fail('HOST_SELECTION_REQUIRED', 'Noninteractive Pi setup requires an explicit --target PI_PACKAGE_DIR; no target was guessed or downloaded.');
      const agent = path.resolve(options['--agent-dir'] as string ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi/agent'));
      const selected = await selectPi(agent, options['--npm-cli'] as string);
      if (!selected) { output({ phase: 'cancelled', nextStep: 'Cancelled. No changes applied.' }); return 0; }
      options['--target'] = selected;
    }
    const target = exactDirectory(options['--target'] as string, 'HOST_NOT_FOUND', 'Install or locate Pi yourself, then pass its exact package directory with --target. No host was downloaded.');
    let host;
    try { host = readJson(path.join(target, 'package.json')); } catch { fail('HOST_UNREADABLE', 'Pass the readable Pi package directory with --target.'); }
    if (host.name !== '@earendil-works/pi-coding-agent' || !['1.1.0', '1.2.0', '1.3.0', '1.4.0'].includes(host.version) ||
        typeof host.bin?.pi !== 'string' || !fs.existsSync(path.join(target, host.bin.pi))) {
      fail('HOST_UNSUPPORTED', 'Select an existing formally supported Pi 1.1.0, 1.2.0, 1.3.0 or 1.4.0 installation; setup never installs another host.');
    }
    const bin = fs.realpathSync(path.join(target, host.bin.pi));
    const relativeBin = path.relative(target, bin);
    if (!bin.endsWith('.js') || !fs.statSync(bin).isFile() || relativeBin.startsWith('..') || path.isAbsolute(relativeBin)) fail('HOST_UNSUPPORTED', 'The Pi bin must be a readable compiled file inside that exact package. Locate the actual standard installation before retrying.');
    const selectedAgentDir = path.resolve(options['--agent-dir'] as string ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent'));
    const agentDir = fs.existsSync(selectedAgentDir) ? fs.realpathSync(selectedAgentDir) : selectedAgentDir;
    const file = path.join(agentDir, 'settings.json');
    const record = path.join(agentDir, 'arlo-setup', 'pi.json');
    const initial = settings(file);
    const recordFingerprint = () => fs.existsSync(record) ? createHash('sha256').update(fs.readFileSync(record)).digest('hex') : 'missing';
    const initialRecordFingerprint = recordFingerprint();
    let retained: Journal | undefined;
    if (fs.existsSync(record)) {
      assertSafeStatePath(path.dirname(record));
      if (fs.lstatSync(record).isSymbolicLink() || !verifyWindowsAcl(record).valid) fail('UNSAFE_SETUP_RECORD', 'Preserve and review the unsafe setup record before retrying.');
      try { retained = readJson(record); } catch { fail('SETUP_RECORD_UNREADABLE', 'Preserve and repair the selected setup record before retrying.'); }
      if (!retained || retained.schemaVersion !== 1 || retained.target !== target || typeof retained.adapter !== 'string'
        || !path.isAbsolute(retained.adapter) || recordedPackageDirectory(retained.adapter) !== retained.adapter
        || typeof retained.owned !== 'boolean' || !['prepared', 'configured', 'removing', 'removed'].includes(retained.phase)
        || typeof retained.declaration !== 'string' || retained.declaration !== (path.relative(agentDir, retained.adapter) || '.')
        || typeof retained.createdAt !== 'string' || !Number.isFinite(Date.parse(retained.createdAt))
        || retained.failure !== undefined && (!retained.failure || !['HOST_PACKAGE_OPERATION_FAILED', 'REGISTRATION_INCOMPLETE'].includes(retained.failure.code)
          || !['native-install', 'native-remove'].includes(retained.failure.operation) || retained.failure.exit !== null && !Number.isInteger(retained.failure.exit)
          || retained.failure.signal !== null && !/^SIG[A-Z0-9]+$/.test(retained.failure.signal))
        || retained.installation !== undefined && (!retained.installation || typeof retained.installation !== 'object'
          || typeof retained.installation.id !== 'string' || !/^[a-f0-9]{64}$/.test(retained.installation.id)
          || typeof retained.installation.directory !== 'string' || !path.isAbsolute(retained.installation.directory))) {
        fail('SETUP_OWNERSHIP_CONFLICT', 'The existing record does not prove this exact target, adapter, declaration and completed phase. Preserve and review it before retrying; no component or native changes were applied.');
      }
      const retainedMatches = (initial.packages ?? []).filter(entry => {
        const source = sourceOf(entry);
        if (!source || source.startsWith('npm:') || source.startsWith('git:')) return false;
        return recordedPackageDirectory(path.resolve(agentDir, source)) === retained!.adapter;
      });
      if (retainedMatches.length > 1) fail('DUPLICATE_ADAPTER_CONFLICT', 'Review duplicate retained Arlo declarations before acquisition. Setup preserved all entries.');
      if (command !== 'setup-status' && retained.owned && ['configured', 'removing'].includes(retained.phase) && retainedMatches.length && retainedMatches[0] !== retained.declaration) {
        fail('CONFIGURATION_CHANGED', 'The owned declaration changed after setup. Preserve it and review its native registration before requesting component installation.');
      }
      if (command !== 'setup-status' && retained.phase === 'prepared' && retainedMatches.length) fail('RECOVERY_REVIEW_REQUIRED', 'A prior native install was interrupted after a declaration appeared. Intent does not prove who added it. Preserve the declaration and review the private record before retrying; no component changes were applied.');
      if (command === 'setup' && retained.phase === 'removing') fail('RECOVERY_REVIEW_REQUIRED', 'Finish the pending uninstall on the same exact target before requesting a new component installation.');
      if (options['--adapter'] && recordedPackageDirectory(options['--adapter'] as string) !== retained.adapter) fail('SETUP_OWNERSHIP_CONFLICT', 'A different adapter was selected from the one in this scope record. Preserve and review it before installation.');
      options['--adapter'] ??= retained.adapter;
    }
    let cleanupInstallation = retained?.installation;
    if (command === 'uninstall' && !cleanupInstallation) {
      const located = locateOwnedPiCleanup(target, options['--adapter'] ? recordedPackageDirectory(options['--adapter'] as string) : undefined);
      if (located) { cleanupInstallation = located.installation; options['--adapter'] ??= located.adapter; }
    }
    let manualArloDeclarations = false;
    if (!options['--adapter']) {
      const manual = (initial.packages ?? []).flatMap(entry => {
        const source = sourceOf(entry);
        if (!source) return [];
        if (source.startsWith('npm:') || source.startsWith('git:')) {
          if (source.includes(piComponentNames.piAdapter)) {
            manualArloDeclarations = true;
            if (command !== 'uninstall') fail('DUPLICATE_ADAPTER_CONFLICT', 'Review the existing native npm/git Arlo package before acquisition. Setup preserved that declaration.');
          }
          return [];
        }
        try {
          const candidate = fs.realpathSync(path.resolve(agentDir, source));
          return readJson(path.join(candidate, 'package.json')).name === piComponentNames.piAdapter ? [candidate] : [];
        } catch { return []; }
      });
      manualArloDeclarations ||= !!manual.length || (initial.extensions ?? []).some(entry => typeof entry === 'string' && /(?:arlo|adapter-pi)/i.test(entry));
      if (command !== 'uninstall' && (manual.length > 1 || (initial.extensions ?? []).some(entry => typeof entry === 'string' && /(?:arlo|adapter-pi)/i.test(entry)))) fail('DUPLICATE_ADAPTER_CONFLICT', 'Review existing Arlo declarations before installation. All entries were preserved.');
      if (manual.length === 1) options['--adapter'] = manual[0];
    }
    if (command === 'uninstall' && !options['--adapter']) {
      output({ host: 'pi', target: { directory: target, version: host.version }, scope: 'user', agentDir,
        configured: manualArloDeclarations, ownership: manualArloDeclarations ? 'preexisting' : 'none', transaction: 'none',
        phase: manualArloDeclarations ? 'preexisting-preserved' : 'already-removed', runtime: 'unobserved', communication: 'unobserved',
        nextStep: manualArloDeclarations ? 'Manual native declarations have no owned setup record and remain preserved. Review them through Pi before removing their registration.'
          : 'No owned native registration or matching component resource was found. All native configuration and user data remain preserved.' });
      return 0;
    }
    // Reject competing native declarations before package acquisition. The
    // registration stage repeats this check after consumption under its lock.
    if (command !== 'uninstall') {
      const selectedAdapter = options['--adapter'] ? recordedPackageDirectory(options['--adapter'] as string) : undefined;
      let existingMatches = 0;
      for (const entry of initial.packages ?? []) {
        const source = sourceOf(entry);
        if (!source) continue;
        if (source.startsWith('npm:') || source.startsWith('git:')) {
          if (source.includes(piComponentNames.piAdapter)) fail('DUPLICATE_ADAPTER_CONFLICT', 'Review the existing native npm/git Arlo declaration before component acquisition. It was preserved.');
          continue;
        }
        const location = recordedPackageDirectory(path.resolve(agentDir, source));
        if (location === selectedAdapter) { existingMatches++; continue; }
        let competing = source.includes(piComponentNames.piAdapter);
        try { competing ||= readJson(path.join(location, 'package.json')).name === piComponentNames.piAdapter; } catch { /* unrelated unresolved entry */ }
        if (competing) fail('DUPLICATE_ADAPTER_CONFLICT', 'Review the competing Arlo package declaration before acquisition. Setup preserved all entries.');
      }
      if (existingMatches > 1 || (initial.extensions ?? []).some(entry => typeof entry === 'string' && /(?:arlo|adapter-pi)/i.test(entry))) fail('DUPLICATE_ADAPTER_CONFLICT', 'Review duplicate or extension-based Arlo declarations before acquisition. Setup preserved all entries.');
    }
    if (command !== 'uninstall' && (!options['--adapter'] || retained?.installation)) {
      components = await preparePiComponents(target, agentDir, options['--npm-cli'] as string, command === 'setup' ? 'install' : 'inspect');
      if (retained?.installation && (retained.installation.id !== components.id || retained.installation.directory !== components.root)) fail('COMPONENT_OWNERSHIP_CONFLICT', 'The setup record points to a different component resource. Preserve both records and review their ownership.');
      if (command === 'setup') {
        const alreadyRegistered = retained?.phase === 'configured' && (initial.packages ?? []).includes(retained.declaration);
        const previewOutput = options['--apply'] ? (value: object) => console.error(JSON.stringify(value, null, 2)) : output;
        previewOutput({ host: 'pi', target: components.host, scope: 'user', agentDir, adapter: { directory: components.adapter },
          components: components.state(), phase: 'preview', configured: alreadyRegistered, runtime: 'unobserved', communication: 'unobserved',
          changes: alreadyRegistered ? ['Verify the existing owned components and native user declaration; do not duplicate registration.'] : [
            components.state().state === 'installed' ? 'Reuse the verified installed coordinated components.' : 'Consume the exact four registry components in the durable companion through the selected standard package tool.',
            'Link the three borrowed physical peers; preserve the original host installation.',
            'Register the durable adapter through selected Pi native user-level pi install.', 'Record owned component entries and this referring setup scope.'],
          nextStep: 'Verify this target and plan, then repeat with --apply. Start/reload the selected native Pi normally and run /arlo-doctor afterwards.' });
        if (!options['--apply']) {
          if (!stdin.isTTY || options['--json']) return 0;
          const answer = await askSetup('Apply this installation and native user registration? [y/N]: ');
          if (!answer || !['y', 'yes'].includes(answer.toLowerCase())) { output({ phase: 'cancelled', nextStep: 'Cancelled. No changes applied.' }); return 0; }
          options['--apply'] = true;
        }
      }
      if (command === 'setup') {
        await components.acquire();
        release = await setupTransaction(path.dirname(record));
        if (JSON.stringify(settings(file)) !== JSON.stringify(initial) || recordFingerprint() !== initialRecordFingerprint) fail('PACKAGE_PLAN_STALE', 'The selected user settings or setup ownership record changed after planning. Preserve the current edits and retry.');
        await components.consume();
      }
      options['--adapter'] = components.adapter;
    }
    const adapter = command !== 'setup' && !fs.existsSync(options['--adapter'] as string)
      ? recordedPackageDirectory(options['--adapter'] as string)
      : exactDirectory(options['--adapter'] as string, 'ADAPTER_NOT_FOUND', 'Use npm to install all delivered private sibling tarballs, then pass the installed compiled adapter directory with --adapter.');
    let manifest: any = {};
    if (command === 'setup-status' && components?.state().state === 'missing') {
      if (fs.existsSync(adapter)) manifest = readJson(path.join(adapter, 'package.json'));
    } else if (command === 'setup' || fs.existsSync(adapter) && command === 'setup-status') {
    try { manifest = readJson(path.join(adapter, 'package.json')); } catch { fail('ADAPTER_UNREADABLE', 'Select the installed compiled @arlo/adapter-pi package.'); }
    if (manifest.name !== piComponentNames.piAdapter || manifest.pi?.extensions?.length !== 1 ||
        !manifest.pi.extensions.every((file: unknown) => typeof file === 'string' && file.endsWith('.js') && fs.existsSync(path.join(adapter, file)))) {
      fail('COMPILED_ADAPTER_REQUIRED', 'Obtain the private compiled adapter-pi artifact; source TypeScript and extension metadata alone are insufficient.');
    }
    if (manifest.version !== piRelease[piComponentNames.piAdapter]) {
      fail('DEPENDENCY_IDENTITY_MISMATCH', 'The selected compiled adapter has a different version from this coordinated CLI release. Preserve its registration and select the matching release before retrying.');
    }
    if (physicalPackage(adapter, host.name) !== target) fail('HOST_PEER_CONFLICT', 'The adapter resolves a different Pi copy. Use the selected host installation for standard npm package consumption; do not install a second host.');
    for (const name of ['@earendil-works/pi-tui', 'typebox']) {
      if (physicalPackage(adapter, name) !== physicalPackage(target, name)) fail('HOST_PEER_CONFLICT', `The adapter and selected host resolve different ${name} packages. Reconcile package consumption before setup.`);
    }
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!Object.hasOwn(piRelease, name)) continue;
      const directory = physicalPackage(adapter, name);
      const dependency = readJson(path.join(directory, 'package.json'));
      const entry = dependency.exports?.['.'];
      const compiled = typeof entry === 'string' ? entry : entry?.default;
      if (dependency.name !== name || dependency.version !== version || typeof compiled !== 'string' ||
          !compiled.endsWith('.js') || !fs.existsSync(path.join(directory, compiled))) {
        fail('DEPENDENCY_IDENTITY_MISMATCH', `Reinstall the delivered compiled ${name}@${version} sibling tarball using npm.`);
      }
    }
    }
    if (!release && command === 'setup' && options['--apply'] && (fs.existsSync(record) || !(initial.packages ?? []).some(entry => {
      const source = sourceOf(entry); if (!source) return false;
      try { return fs.realpathSync(path.resolve(agentDir, source)) === adapter; } catch { return false; }
    }))) release = await setupTransaction(path.dirname(record));
    const current = settings(file);
    const declaration = path.relative(agentDir, adapter) || '.';
    const packages = current.packages ?? [];
    const matching = packages.filter(entry => {
      const source = sourceOf(entry);
      if (!source || source.startsWith('npm:') || source.startsWith('git:')) return false;
      try { return fs.realpathSync(path.resolve(agentDir, source)) === adapter; } catch { return command !== 'setup' && path.resolve(agentDir, source) === adapter; }
    });
    const other = packages.some(entry => {
      const source = sourceOf(entry);
      if (!source || matching.includes(entry)) return false;
      if (source.includes(piComponentNames.piAdapter)) return true;
      try { return readJson(path.join(path.resolve(agentDir, source), 'package.json')).name === piComponentNames.piAdapter; } catch { return false; }
    });
    if (matching.length > 1 || command !== 'uninstall' && (other || (current.extensions ?? []).some(entry => typeof entry === 'string' && /(?:arlo|adapter-pi)/i.test(entry)))) {
      fail('DUPLICATE_ADAPTER_CONFLICT', 'Review existing Pi package/extension declarations and keep one intended Arlo entry; setup preserved all entries.');
    }
    let journal: Journal | undefined;
    if (fs.existsSync(record)) {
      assertSafeStatePath(path.dirname(record));
      if (fs.lstatSync(record).isSymbolicLink() || !verifyWindowsAcl(record).valid) fail('UNSAFE_SETUP_RECORD', 'Preserve and review the unsafe setup record before retrying.');
      try { journal = readJson(record); } catch { fail('SETUP_RECORD_UNREADABLE', 'Preserve the private setup record and repair it before retrying.'); }
      if (!journal || journal.schemaVersion !== 1 || journal.target !== target || journal.adapter !== adapter
        || typeof journal.owned !== 'boolean' || !['prepared', 'configured', 'removing', 'removed'].includes(journal.phase)
        || typeof journal.declaration !== 'string' || journal.declaration !== declaration
        || typeof journal.createdAt !== 'string' || !Number.isFinite(Date.parse(journal.createdAt))) fail('SETUP_OWNERSHIP_CONFLICT', 'A different target owns the setup record. Select that target or resolve the record manually; no configuration changed.');
    }
    const activeOwnership = journal?.owned && ['configured', 'removing'].includes(journal.phase);
    const drifted = activeOwnership && matching.length > 0 && matching[0] !== journal?.declaration;
    const report = { host: 'pi', target: { directory: target, version: host.version }, adapter: { directory: adapter, version: manifest.version },
      scope: 'user', agentDir, cliRuntime: { executable: process.execPath, version: process.versions.node },
      hostRuntime: { state: 'unobserved', nextStep: 'In the selected native Pi TUI run /arlo-doctor to observe its actual executable, loaded adapter, contracts and reception.' },
      daemonRuntime: { state: 'unobserved', nextStep: 'Use arlo status and arlo doctor for the shared Daemon; setup does not start or restart it.' },
      environment: process.versions.node === '24.13.1' ? 'baseline-cli-runtime' : 'unverified-cli-runtime',
      packages: fs.existsSync(adapter) ? 'installed' : 'missing', ...(components ? { components: components.state() } : {}), configured: matching.length === 1,
      transaction: journal?.phase ?? 'none',
      ...(journal?.failure ? { failure: journal.failure } : {}),
      ownership: drifted ? 'conflict' : activeOwnership && matching.length ? 'arlo' : matching.length ? 'preexisting' : 'none',
      runtime: 'unobserved', communication: 'unobserved',
    };
    if (command === 'setup-status') {
      const missingRecordedComponents = components?.state().inventory === 'review-required';
      output({ ...report, phase: drifted ? 'configuration-conflict' : missingRecordedComponents ? 'components-missing' : components?.state().state === 'partial' || journal?.phase === 'prepared' || journal?.phase === 'removing' ? 'recovery-required' : matching.length ? 'pending-start-or-reload' : 'not-configured', nextStep: drifted ? 'The owned declaration changed after setup. Preserve your edits and review its native Pi registration.' : missingRecordedComponents ? 'Recorded component files are missing. Preserve the native declaration and private records, then review the owned consumer before retrying setup; its remaining inventory cannot authorize an overwrite.' : !fs.existsSync(adapter) ? 'Components are missing or partially installed. Retry setup on this exact target to complete owned consumption, or revoke a retained native declaration with uninstall; reload the host normally afterwards.' : matching.length ? report.hostRuntime.nextStep : 'Run setup to preview user-level registration.' });
      return 0;
    }
    if (drifted) fail('CONFIGURATION_CHANGED', 'The owned declaration changed after setup. Preserve it and remove the desired entry through Pi after reviewing your changes.');
    if (journal?.phase === 'prepared' && matching.length) {
      fail('RECOVERY_REVIEW_REQUIRED', 'A prior native install was interrupted after a declaration appeared. Intent alone cannot prove who added it. Preserve your edits; inspect this private setup record and remove the ambiguous declaration through Pi if you intend a fresh setup, then retry.');
    }
    if (command === 'uninstall') {
      const revoke = !!journal?.owned && journal.phase !== 'removed' && matching.length === 1;
      cleanup = await prepareOwnedComponentCleanup(cleanupInstallation, target, agentDir, adapter, options['--npm-cli'] as string, !!matching.length && !revoke);
      const removeComponents = cleanup?.state().action === 'remove' && !matching.length || revoke;
      if (!revoke && !removeComponents && !journal?.owned) {
        if (options['--apply'] && (journal || cleanup)) {
          await cleanup?.acquire();
          release = await setupTransaction(path.dirname(record));
          if (JSON.stringify(settings(file)) !== JSON.stringify(initial) || recordFingerprint() !== initialRecordFingerprint) fail('PACKAGE_PLAN_STALE', 'Selected Pi settings or their ownership changed during uninstall. Preserve those edits and retry.');
        }
        output({ ...report, ...(cleanup ? { cleanup: cleanup.state() } : {}), phase: matching.length ? 'preexisting-preserved' : 'already-removed',
          nextStep: matching.length ? 'The manual native registration and its components remain. Remove that declaration through Pi after reviewing its ownership.' : 'Native registration is already absent. Shared or edited resources and all user data remain preserved.' });
        return 0;
      }
      const previewOutput = options['--apply'] ? (value: object) => console.error(JSON.stringify(value, null, 2)) : output;
      previewOutput({ ...report, ...(cleanup ? { cleanup: cleanup.state() } : {}), phase: 'preview',
        changes: [revoke ? 'Remove only the owned Pi user package declaration through pi remove.' : 'Native registration is absent; reconcile only its retained owned transaction.',
          cleanup?.state().action === 'remove' ? 'Clean matching unshared owned components through the recorded companion package tool.' : 'Preserve shared, edited or unproven components.'],
        nextStep: 'Confirm this exact target and cleanup plan with --apply; start/reload Pi normally afterwards.' });
      if (!options['--apply']) {
        if (!stdin.isTTY || options['--json']) return 0;
        const answer = await askSetup('Apply this native revocation and owned component cleanup? [y/N]: ');
        if (!answer || !['y', 'yes'].includes(answer.toLowerCase())) { output({ phase: 'cancelled', nextStep: 'Cancelled. No changes applied.' }); return 0; }
        options['--apply'] = true;
      }
      await cleanup?.acquire();
      release = await setupTransaction(path.dirname(record));
      if (JSON.stringify(settings(file)) !== JSON.stringify(initial) || recordFingerprint() !== initialRecordFingerprint) fail('PACKAGE_PLAN_STALE', 'Selected Pi settings or their ownership changed after the uninstall preview. Preserve those edits and retry.');
      if (revoke) {
        journalWrite(record, { ...journal!, phase: 'removing', failure: undefined });
        try { nativePi(target, agentDir, 'remove', adapter); }
        catch (error) { if (error instanceof SetupError && error.failure) journalWrite(record, { ...journal!, phase: 'removing', failure: error.failure }); throw error; }
        if ((settings(file).packages ?? []).some(entry => {
          const source = sourceOf(entry);
          return source && !source.startsWith('npm:') && !source.startsWith('git:') && recordedPackageDirectory(path.resolve(agentDir, source)) === adapter;
        })) {
          journalWrite(record, { ...journal!, phase: 'removing', failure: { code: 'REGISTRATION_INCOMPLETE', exit: 0, signal: null, operation: 'native-remove' } });
          fail('REGISTRATION_INCOMPLETE', 'Pi retained a declaration of the selected adapter. Preserve the current declaration and retry after reviewing its native ownership.');
        }
      }
      if (journal) journalWrite(record, { ...journal, phase: 'removed', owned: false, failure: undefined });
      await cleanup?.remove();
      output({ ...report, packages: fs.existsSync(adapter) ? 'installed' : 'missing', ...(components ? { components: components.state() } : {}),
        ...(cleanup ? { cleanup: cleanup.state() } : {}), configured: false, ownership: 'none', transaction: journal ? 'removed' : 'none',
        phase: revoke ? 'removed-pending-reload' : 'already-removed', nextStep: 'Reload or restart Pi normally. Shared or edited components, history, root identities, allowances and the shared Daemon are preserved.' });
      return 0;
    }
    if (journal?.phase === 'removing') fail('RECOVERY_REVIEW_REQUIRED', 'Finish the pending uninstall using the same exact target before requesting a new setup.');
    if (matching.length) {
      if (!components && options['--apply']) {
        components = await retainedPiComponents(adapter, target, agentDir, options['--npm-cli'] as string);
        if (components) {
          await components.acquire();
          if (components.state().state !== 'installed') fail('COMPONENT_OWNERSHIP_CONFLICT', 'The shared resource changed before confirmation could be recorded. Preserve the manual declaration and review its components.');
          components.recheck();
          if (JSON.stringify(settings(file)) !== JSON.stringify(initial) || recordFingerprint() !== initialRecordFingerprint) fail('PACKAGE_PLAN_STALE', 'The manual native declaration changed before its shared component use could be recorded. Preserve the configuration and retry.');
          components.registration('configured', activeOwnership ? 'setup-record' : 'preexisting-declaration');
        }
      }
      output({ ...report, ...(components ? { components: components.state() } : {}), phase: 'already-configured-pending-reload', nextStep: report.hostRuntime.nextStep });
      return 0;
    }
    if (!options['--apply']) {
      output({ ...report, phase: 'preview', changes: ['Register the compiled adapter directory using Pi native user-level pi install.', 'Write a private ownership record; preserve other settings and all project declarations.'], nextStep: 'Verify the target and repeat with --apply. Then start/reload Pi normally and run /arlo-doctor.' });
      return 0;
    }
    const prepared: Journal = { schemaVersion: 1, target, adapter, declaration, owned: false, phase: 'prepared', createdAt: new Date().toISOString(),
      ...(components ? { installation: { id: components.id, directory: components.root } } : {}) };
    journalWrite(record, prepared);
    components?.registration('registration-prepared');
    try { nativePi(target, agentDir, 'install', adapter); }
    catch (error) {
      if (error instanceof SetupError && error.failure) { journalWrite(record, { ...prepared, failure: error.failure }); components?.recordFailure(error.failure); }
      throw error;
    }
    const installed = settings(file).packages ?? [];
    if (!installed.includes(declaration)) {
      const failure: SetupOperationFailure = { code: 'REGISTRATION_INCOMPLETE', exit: 0, signal: null, operation: 'native-install' };
      journalWrite(record, { ...prepared, failure }); components?.recordFailure(failure);
      throw new SetupError('REGISTRATION_INCOMPLETE', 'Pi did not persist the expected declaration. The private prepared record is retained; inspect settings and rerun setup.', failure);
    }
    journalWrite(record, { ...prepared, phase: 'configured', owned: true });
    components?.registration('configured');
    output({ ...report, ...(components ? { components: components.state() } : {}), configured: true, ownership: 'arlo', transaction: 'configured', phase: 'configured-pending-start-or-reload', nextStep: report.hostRuntime.nextStep });
    return 0;
  } catch (error) {
    if (error instanceof ArloError && ['UNSAFE_LOCATION', 'INSECURE_PERMISSIONS', 'INVALID_OWNERSHIP'].includes(error.code)) {
      output({ error: 'UNSAFE_SETUP_RECORD', nextStep: 'Select a private, current-user-owned Pi configuration directory with --agent-dir, or repair that directory through your host preparation process. Setup did not change unrelated directory permissions.' });
      return 1;
    }
    output({ ...(components ? { components: components.state() } : {}), ...(cleanup ? { cleanup: cleanup.state() } : {}), ...(error instanceof SetupError && error.failure ? { failure: error.failure } : {}), error: error instanceof SetupError ? error.code : error instanceof Error && ['SETUP_BUSY', 'CONFIGURATION_TARGET_CONFLICT'].includes(error.message) ? error.message : 'SETUP_FAILED',
      nextStep: error instanceof SetupError ? error.nextStep : 'No success was recorded. Inspect the selected private setup record and settings, then retry; never restore an entire old configuration snapshot.' });
    return 1;
  } finally { await release?.(); await cleanup?.close(); await components?.close(); }
}
