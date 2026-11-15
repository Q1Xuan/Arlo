import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { assertConfigurationFile, recordedPackageDirectory, setupTransaction } from './transaction.ts';
import { writePrivateStateFile } from '../storage/index.ts';
import { assertSafeStatePath, enforceWindowsAcl, verifyWindowsAcl, ArloError } from '@arlo/sdk';

class SetupError extends Error {
  readonly code: string;
  readonly nextStep: string;
  constructor(code: string, nextStep: string) { super(code); this.code = code; this.nextStep = nextStep; }
}
type Settings = { packages?: unknown[]; extensions?: unknown[]; [key: string]: unknown };
type Journal = { schemaVersion: 1; target: string; adapter: string; declaration: string; owned: boolean;
  phase: 'prepared' | 'configured' | 'removing' | 'removed'; createdAt: string };
const fail = (code: string, nextStep: string): never => { throw new SetupError(code, nextStep); };
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
function physicalPackage(from: string, name: string): string {
  const require = createRequire(path.join(from, 'package.json'));
  for (const directory of require.resolve.paths(name) ?? []) {
    const file = path.join(directory, name, 'package.json');
    if (fs.existsSync(file)) return fs.realpathSync(path.dirname(file));
  }
  return fail('DEPENDENCY_MISSING', `Install all private sibling tarballs together with npm in the selected host installation; missing ${name}.`);
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
  if (result.status !== 0 || result.error) fail('HOST_PACKAGE_OPERATION_FAILED',
    `Pi ${action} failed (exit ${result.status ?? (result.error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown'}). Review the private setup record and selected settings before retrying.`);
}

/** Thin user-level wiring over Pi's own package registration. Package acquisition remains npm's job. */
export async function runSetupCli(command: string, args: string[]): Promise<number> {
  const options: Record<string, string | boolean> = {};
  const output = (report: object) => console.log(JSON.stringify(report, null, 2));
  let release: (() => Promise<void>) | undefined;
  try {
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (['--apply', '--json', '--experimental'].includes(key)) options[key] = true;
      else if (['--host', '--target', '--adapter', '--agent-dir', '--profile', '--dsh-home', '--npm-cli'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
      else fail('INVALID_ARGUMENT', 'Use setup|setup-status|uninstall --host pi --target PI_PACKAGE_DIR --adapter ADAPTER_PACKAGE_DIR [--agent-dir USER_AGENT_DIR] [--apply].');
    }
    if (!options['--host'] && stdin.isTTY && !options['--json']) {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        options['--host'] = (await prompt.question('Host to connect (pi/dsh): ')).trim();
        options['--target'] ??= (await prompt.question('Exact installed host package directory: ')).trim();
        options['--adapter'] ??= (await prompt.question('Installed compiled Arlo adapter package directory: ')).trim();
        if (options['--host'] === 'dsh') options['--profile'] ??= (await prompt.question('Existing DSH profile name: ')).trim();
      } finally { prompt.close(); }
    }
    if (options['--host'] === 'dsh' && !options['--profile']) fail('PROFILE_SELECTION_REQUIRED', 'Select one existing DSH profile explicitly with --profile NAME; no profile is initialized or enabled automatically.');
    if (options['--host'] === 'dsh') {
      const { runDshSetupCli } = await import('./dsh.ts');
      return runDshSetupCli(command, options);
    }
    if (options['--host'] !== 'pi') fail('HOST_SELECTION_REQUIRED', 'Select --host pi and an exact existing --target; DSH requires the prepared-profile setup path.');
    const target = exactDirectory(options['--target'] as string, 'HOST_NOT_FOUND', 'Install or locate Pi yourself, then pass its exact package directory with --target. No host was downloaded.');
    let host;
    try { host = readJson(path.join(target, 'package.json')); } catch { fail('HOST_UNREADABLE', 'Pass the readable Pi package directory with --target.'); }
    if (host.name !== '@earendil-works/pi-coding-agent' || !['1.1.0', '1.2.0', '1.3.0', '1.4.0'].includes(host.version) ||
        typeof host.bin?.pi !== 'string' || !fs.existsSync(path.join(target, host.bin.pi))) {
      fail('HOST_UNSUPPORTED', 'Select an existing formally supported Pi 1.1.0, 1.2.0, 1.3.0 or 1.4.0 installation; setup never installs another host.');
    }
    if (!options['--adapter']) fail('ADAPTER_NOT_FOUND', 'Select the recorded adapter path using --adapter.');
    const adapter = command !== 'setup' && !fs.existsSync(options['--adapter'] as string)
      ? recordedPackageDirectory(options['--adapter'] as string)
      : exactDirectory(options['--adapter'] as string, 'ADAPTER_NOT_FOUND', 'Use npm to install all delivered private sibling tarballs, then pass the installed compiled adapter directory with --adapter.');
    let manifest: any = {};
    if (command === 'setup' || fs.existsSync(adapter) && command === 'setup-status') {
    try { manifest = readJson(path.join(adapter, 'package.json')); } catch { fail('ADAPTER_UNREADABLE', 'Select the installed compiled @arlo/adapter-pi package.'); }
    if (manifest.name !== '@arlo/adapter-pi' || manifest.pi?.extensions?.length !== 1 ||
        !manifest.pi.extensions.every((file: unknown) => typeof file === 'string' && file.endsWith('.js') && fs.existsSync(path.join(adapter, file)))) {
      fail('COMPILED_ADAPTER_REQUIRED', 'Obtain the private compiled adapter-pi artifact; source TypeScript and extension metadata alone are insufficient.');
    }
    if (physicalPackage(adapter, host.name) !== target) fail('HOST_PEER_CONFLICT', 'The adapter resolves a different Pi copy. Use the selected host installation for standard npm package consumption; do not install a second host.');
    for (const name of ['@earendil-works/pi-tui', 'typebox']) {
      if (physicalPackage(adapter, name) !== physicalPackage(target, name)) fail('HOST_PEER_CONFLICT', `The adapter and selected host resolve different ${name} packages. Reconcile package consumption before setup.`);
    }
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!name.startsWith('@arlo/')) continue;
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
    const selectedAgentDir = path.resolve(options['--agent-dir'] as string ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent'));
    const agentDir = fs.existsSync(selectedAgentDir) ? fs.realpathSync(selectedAgentDir) : selectedAgentDir;
    const file = path.join(agentDir, 'settings.json');
    const record = path.join(agentDir, 'arlo-setup', 'pi.json');
    const initial = settings(file);
    if (command !== 'setup-status' && options['--apply'] && (fs.existsSync(record) || command === 'setup' && !(initial.packages ?? []).some(entry => {
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
      if (source.includes('@arlo/adapter-pi')) return true;
      try { return readJson(path.join(path.resolve(agentDir, source), 'package.json')).name === '@arlo/adapter-pi'; } catch { return false; }
    });
    if (other || matching.length > 1 || (current.extensions ?? []).some(entry => typeof entry === 'string' && /(?:arlo|adapter-pi)/i.test(entry))) {
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
      packages: fs.existsSync(adapter) ? 'installed' : 'missing', configured: matching.length === 1,
      transaction: journal?.phase ?? 'none',
      ownership: drifted ? 'conflict' : activeOwnership && matching.length ? 'arlo' : matching.length ? 'preexisting' : 'none',
      runtime: 'unobserved', communication: 'unobserved',
    };
    if (command === 'setup-status') {
      output({ ...report, phase: drifted ? 'configuration-conflict' : journal?.phase === 'prepared' || journal?.phase === 'removing' ? 'recovery-required' : matching.length ? 'pending-start-or-reload' : 'not-configured', nextStep: drifted ? 'The owned declaration changed after setup. Preserve your edits and review its native Pi registration.' : !fs.existsSync(adapter) ? 'The adapter package is missing. Restore the same private compiled component or use uninstall with this exact recorded target to revoke its retained declaration; reload the host normally afterwards.' : matching.length ? report.hostRuntime.nextStep : 'Run setup to preview user-level registration.' });
      return 0;
    }
    if (drifted) fail('CONFIGURATION_CHANGED', 'The owned declaration changed after setup. Preserve it and remove the desired entry through Pi after reviewing your changes.');
    if (journal?.phase === 'prepared' && matching.length) {
      fail('RECOVERY_REVIEW_REQUIRED', 'A prior native install was interrupted after a declaration appeared. Intent alone cannot prove who added it. Preserve your edits; inspect this private setup record and remove the ambiguous declaration through Pi if you intend a fresh setup, then retry.');
    }
    if (command === 'uninstall') {
      if (journal?.owned && !matching.length && options['--apply']) {
        journal = { ...journal, phase: 'removed', owned: false }; journalWrite(record, journal);
      }
      if (!journal?.owned || journal.phase === 'removed' || !matching.length) {
        output({ ...report, transaction: journal?.phase ?? 'none', ownership: matching.length ? 'preexisting' : 'none', phase: matching.length ? 'preexisting-preserved' : 'already-removed', nextStep: 'No owned registration was removed. Existing consumed packages, history, root identities and shared Daemon are preserved.' });
        return 0;
      }
      if (matching[0] !== journal.declaration) fail('CONFIGURATION_CHANGED', 'The owned declaration changed after setup. Preserve it and remove the desired entry through Pi after reviewing your changes.');
      if (!options['--apply']) {
        output({ ...report, phase: 'preview', changes: ['Remove only the owned Pi user package declaration through pi remove.'], nextStep: 'Repeat with --apply to remove this registration; restart/reload Pi normally afterwards.' });
        return 0;
      }
      journalWrite(record, { ...journal, phase: 'removing' });
      nativePi(target, agentDir, 'remove', adapter);
      const removingDeclaration = journal.declaration;
      if ((settings(file).packages ?? []).some(entry => sourceOf(entry) === removingDeclaration)) {
        fail('REGISTRATION_INCOMPLETE', 'Pi retained the owned declaration. The removing record is retained; preserve your current settings and retry uninstall.');
      }
      journalWrite(record, { ...journal, phase: 'removed', owned: false });
      output({ ...report, configured: false, ownership: 'none', transaction: 'removed', phase: 'removed-pending-reload', nextStep: 'Reload or restart Pi normally. Shared consumed packages, history, root identities, allowances and shared Daemon remain; remove unshared packages separately through npm.' });
      return 0;
    }
    if (journal?.phase === 'removing') fail('RECOVERY_REVIEW_REQUIRED', 'Finish the pending uninstall using the same exact target before requesting a new setup.');
    if (matching.length) {
      output({ ...report, phase: 'already-configured-pending-reload', nextStep: report.hostRuntime.nextStep });
      return 0;
    }
    if (!options['--apply']) {
      output({ ...report, phase: 'preview', changes: ['Register the compiled adapter directory using Pi native user-level pi install.', 'Write a private ownership record; preserve other settings and all project declarations.'], nextStep: 'Verify the target and repeat with --apply. Then start/reload Pi normally and run /arlo-doctor.' });
      return 0;
    }
    const prepared: Journal = { schemaVersion: 1, target, adapter, declaration, owned: false, phase: 'prepared', createdAt: new Date().toISOString() };
    journalWrite(record, prepared);
    nativePi(target, agentDir, 'install', adapter);
    const installed = settings(file).packages ?? [];
    if (!installed.includes(declaration)) fail('REGISTRATION_INCOMPLETE', 'Pi did not persist the expected declaration. The private prepared record is retained; inspect settings and rerun setup.');
    journalWrite(record, { ...prepared, phase: 'configured', owned: true });
    output({ ...report, configured: true, ownership: 'arlo', transaction: 'configured', phase: 'configured-pending-start-or-reload', nextStep: report.hostRuntime.nextStep });
    return 0;
  } catch (error) {
    if (error instanceof ArloError && ['UNSAFE_LOCATION', 'INSECURE_PERMISSIONS', 'INVALID_OWNERSHIP'].includes(error.code)) {
      output({ error: 'UNSAFE_SETUP_RECORD', nextStep: 'Select a private, current-user-owned Pi configuration directory with --agent-dir, or repair that directory through your host preparation process. Setup did not change unrelated directory permissions.' });
      return 1;
    }
    output({ error: error instanceof SetupError ? error.code : error instanceof Error && ['SETUP_BUSY', 'CONFIGURATION_TARGET_CONFLICT'].includes(error.message) ? error.message : 'SETUP_FAILED',
      nextStep: error instanceof SetupError ? error.nextStep : 'No success was recorded. Inspect the selected private setup record and settings, then retry; never restore an entire old configuration snapshot.' });
    return 1;
  } finally { await release?.(); }
}
