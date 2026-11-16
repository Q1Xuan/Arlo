import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createCliProcessFixture } from './fixtures/cli-process.mjs';
import { cliProcess, commandProcess, componentDistribution } from './fixtures/pi-component-distribution.mjs';

const cli = process.env.ARLO_CLI_ENTRY;
const host = process.env.ARLO_PI_SETUP_HOST;
const bundle = process.env.ARLO_PI_SETUP_BUNDLE;
const available = cli && host && bundle;
const driver = fileURLToPath(new URL('./fixtures/cli-terminal.py', import.meta.url));
const terminal = (args, steps, context) => commandProcess('python3', [driver, JSON.stringify([process.execPath, cli, ...args]), JSON.stringify(steps), '100'], context);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function until(read, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${label}`);
}
function startCli(args, context) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: context.directory, env: context.env });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  return { child, result: once(child, 'exit').then(([status, signal]) => ({ status, signal, stdout, stderr })) };
}
function nativeChild(pid, operation, prefix) {
  try {
    return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).map(Number).find(child => {
      try {
        const args = fs.readFileSync(`/proc/${child}/cmdline`, 'utf8').split('\0');
        return args.includes(operation) && (!prefix || args.includes(`--prefix=${prefix}`));
      } catch { return false; }
    });
  } catch { return undefined; }
}

async function installedFixture(prefix, target = host) {
  const context = createCliProcessFixture(prefix);
  if (process.env.ARLO_PI_SETUP_TOOL_CACHE) context.env.npm_config_cache = process.env.ARLO_PI_SETUP_TOOL_CACHE;
  const distribution = await componentDistribution(bundle);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  const agent = path.join(context.directory, 'agent');
  fs.mkdirSync(agent, { mode: 0o700 });
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: [], retainedPreference: true }));
  fs.writeFileSync(path.join(agent, 'models.json'), 'RETAIN_MODELS');
  fs.mkdirSync(path.join(agent, 'history'));
  fs.writeFileSync(path.join(agent, 'history', 'prior.jsonl'), 'RETAIN_HISTORY_AND_ROOT');
  const args = ['--host', 'pi', '--target', fs.realpathSync(target), '--agent-dir', agent, '--json'];
  const installed = await cliProcess(cli, ['setup', ...args, '--apply'], context);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  return { context, distribution, agent, args, report: JSON.parse(installed.stdout),
    close: async () => { await distribution.close(); context.close(); } };
}

test('confirmed Pi uninstall previews then removes its unshared owned component batch through the original companion scope', {
  skip: !available,
}, async () => {
  const f = await installedFixture('arlo-pi-owned-cleanup-');
  try {
    const nativeFile = path.join(f.agent, 'settings.json');
    const manifest = path.join(f.report.components.consumer, 'package.json');
    const originalNative = fs.readFileSync(nativeFile, 'utf8');
    const originalManifest = fs.readFileSync(manifest, 'utf8');
    const targetManifest = hash(path.join(host, 'package.json'));
    const preview = await cliProcess(cli, ['uninstall', ...f.args], f.context);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    const plan = JSON.parse(preview.stdout);
    assert.equal(plan.phase, 'preview');
    assert.equal(plan.cleanup.action, 'remove');
    assert.deepEqual(plan.cleanup.packages, ['@arlo/sdk', '@arlo/adapter-sdk', '@arlo/daemon', '@arlo/adapter-pi']);
    assert.equal(plan.cleanup.consumer, f.report.components.consumer);
    assert.equal(fs.readFileSync(nativeFile, 'utf8'), originalNative);
    assert.equal(fs.readFileSync(manifest, 'utf8'), originalManifest);
    const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    const result = JSON.parse(removed.stdout);
    assert.equal(result.phase, 'removed-pending-reload');
    assert.equal(result.cleanup.state, 'removed');
    assert.equal(result.packages, 'missing', 'the final report observes the adapter after component removal');
    assert.deepEqual(JSON.parse(fs.readFileSync(nativeFile, 'utf8')), { packages: [], retainedPreference: true });
    for (const name of plan.cleanup.packages) assert.equal(fs.existsSync(path.join(f.report.components.consumer, 'node_modules', name)), false);
    for (const name of Object.keys(f.report.components.borrowed)) {
      assert.equal(fs.existsSync(path.join(f.report.components.consumer, 'node_modules', name)), false);
      assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).dependencies?.[name], undefined);
    }
    assert.equal(hash(path.join(host, 'package.json')), targetManifest);
    assert.equal(fs.readFileSync(path.join(f.agent, 'models.json'), 'utf8'), 'RETAIN_MODELS');
    assert.equal(fs.readFileSync(path.join(f.agent, 'history', 'prior.jsonl'), 'utf8'), 'RETAIN_HISTORY_AND_ROOT');
    const repeated = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).phase, 'already-removed');
  } finally { await f.close(); }
});

test('Pi owned cleanup uses the exact pnpm companion while preserving the selected pnpm host and borrowed peers', {
  skip: !available || !process.env.ARLO_PI_SETUP_PNPM_HOST,
}, async () => {
  const target = fs.realpathSync(process.env.ARLO_PI_SETUP_PNPM_HOST);
  const f = await installedFixture('arlo-pi-pnpm-cleanup-', target);
  try {
    const original = hash(path.join(target, 'package.json'));
    const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context, {
      npm_config_global: 'true', npm_config_prefix: path.dirname(path.dirname(target)),
    });
    const failureFile = path.join(f.report.components.directory, 'component-remove-failure.json');
    const reviewFile = path.join(f.report.components.directory, 'component-cleanup-review.json');
    assert.equal(removed.status, 0, removed.stdout + removed.stderr + (fs.existsSync(failureFile) ? fs.readFileSync(failureFile, 'utf8') : '')
      + (fs.existsSync(reviewFile) ? fs.readFileSync(reviewFile, 'utf8') : ''));
    const result = JSON.parse(removed.stdout);
    assert.equal(result.cleanup.manager.name, 'pnpm');
    assert.equal(result.cleanup.manager.version, '10.26.2');
    assert.equal(result.cleanup.state, 'removed');
    assert.equal(fs.existsSync(f.report.adapter.directory), false);
    assert.equal(hash(path.join(target, 'package.json')), original);
    for (const peer of Object.values(f.report.components.borrowed)) assert.equal(fs.existsSync(path.join(peer.directory, 'package.json')), true);
  } finally { await f.close(); }
});

test('ambiguous component references are preserved while an unchanged owned Pi registration can still be revoked', {
  skip: !available,
}, async () => {
  const f = await installedFixture('arlo-pi-ambiguous-cleanup-');
  try {
    const recordFile = path.join(f.report.components.directory, 'components.json');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    record.references[f.agent].kind = 'unrecognized-owner';
    const ambiguous = JSON.stringify(record);
    fs.writeFileSync(recordFile, ambiguous);
    const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    const result = JSON.parse(removed.stdout);
    assert.equal(result.configured, false);
    assert.equal(result.cleanup.state, 'retained');
    assert.equal(result.packages, 'installed', 'retained component files remain present in the final report');
    assert.match(result.cleanup.reasons.join(' '), /ambiguous|ownership|review/i);
    assert.equal(fs.existsSync(f.report.adapter.directory), true);
    assert.equal(fs.readFileSync(recordFile, 'utf8'), ambiguous, 'damaged resource metadata is retained without repairing or claiming it');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages, []);
  } finally { await f.close(); }
});

test('the uninstall menu previews the same Pi resource and preserves it on cancellation, EOF and interrupt before confirmation', {
  skip: !available || process.platform === 'win32',
}, async () => {
  const f = await installedFixture('arlo-pi-cleanup-menu-');
  try {
    const native = fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8');
    const manifest = fs.readFileSync(path.join(f.report.components.consumer, 'package.json'), 'utf8');
    const args = f.args.filter(arg => arg !== '--json');
    for (const answer of ['n\n', '\x04', '\x03']) {
      const cancelled = await terminal(args, [['Choose an action', '4\n'], ['Apply this native revocation', answer]], f.context);
      assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
      assert.match(cancelled.stdout, /"phase": "preview"/);
      assert.match(cancelled.stdout, /"phase": "cancelled"/);
      assert.ok(cancelled.stdout.includes(f.report.components.consumer));
      assert.equal(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'), native);
      assert.equal(fs.readFileSync(path.join(f.report.components.consumer, 'package.json'), 'utf8'), manifest);
    }
    const removed = await terminal(args, [['Choose an action', '4\n'], ['Apply this native revocation', 'y\n']], f.context);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.match(removed.stdout, /"phase": "removed-pending-reload"/);
    assert.equal(fs.existsSync(f.report.adapter.directory), false);
  } finally { await f.close(); }
});

test('an edit during the real native removal is preserved before component cleanup and a concurrent install cannot overwrite the resource', {
  skip: !available || process.platform !== 'linux', timeout: 60_000,
}, async () => {
  const f = await installedFixture('arlo-pi-concurrent-cleanup-');
  const lock = path.join(f.agent, 'settings.json.lock');
  fs.mkdirSync(lock);
  const keepLock = setInterval(() => { try { fs.utimesSync(lock, new Date(), new Date()); } catch {} }, 100);
  const running = startCli(['uninstall', ...f.args, '--apply'], f.context);
  let nativePid;
  try {
    nativePid = await until(() => nativeChild(running.child.pid, 'remove'), 'real native Pi removal');
    const blocked = await cliProcess(cli, ['setup', ...f.args, '--apply'], f.context);
    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.ok(['SETUP_BUSY', 'RECOVERY_REVIEW_REQUIRED'].includes(JSON.parse(blocked.stdout).error));
    const editedFile = path.join(f.report.adapter.directory, 'src', 'extension.js');
    const later = fs.readFileSync(editedFile, 'utf8') + '\n// USER_LATER_COMPONENT_EDIT\n';
    fs.writeFileSync(editedFile, later);
    clearInterval(keepLock);
    fs.rmSync(lock, { recursive: true });
    const removed = await running.result;
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).cleanup.state, 'retained');
    assert.equal(JSON.parse(removed.stdout).configured, false);
    assert.equal(fs.readFileSync(editedFile, 'utf8'), later);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages, []);
  } finally {
    clearInterval(keepLock);
    fs.rmSync(lock, { recursive: true, force: true });
    if (running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill('SIGKILL');
      if (nativePid) { try { process.kill(nativePid, 'SIGKILL'); } catch {} }
      await running.result;
    }
    await f.close();
  }
});

test('a shared Daemon keeps the last owned resource until its normal idle exit and a later uninstall completes cleanup', {
  skip: !available || process.platform !== 'linux', timeout: 60_000,
}, async () => {
  const f = await installedFixture('arlo-pi-daemon-cleanup-');
  const stateDir = path.join(f.context.directory, 'daemon');
  f.context.env.ARLO_STATE_DIR = stateDir;
  const daemonPackage = path.join(f.report.components.consumer, 'node_modules', '@arlo/daemon');
  const shared = spawn(process.execPath, [path.join(daemonPackage, 'bin', 'shared.js'), '12000', stateDir], {
    cwd: daemonPackage, env: f.context.env, stdio: ['ignore', 'ignore', 'ignore'],
  });
  const exited = once(shared, 'exit');
  try {
    await until(() => fs.existsSync(path.join(stateDir, 'discovery.json')), 'normal compiled shared Daemon startup');
    const before = await cliProcess(cli, ['status', '--state-dir', stateDir, '--json'], f.context);
    assert.equal(before.status, 0, before.stdout + before.stderr);
    const identity = JSON.parse(before.stdout);
    assert.equal(identity.pid, shared.pid);
    const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).cleanup.state, 'retained');
    assert.match(JSON.parse(removed.stdout).cleanup.reasons.join(' '), /Daemon|running|live/);
    assert.equal(fs.existsSync(f.report.adapter.directory), true);
    const after = await cliProcess(cli, ['status', '--state-dir', stateDir, '--json'], f.context);
    assert.equal(after.status, 0, after.stdout + after.stderr);
    assert.equal(JSON.parse(after.stdout).daemon_id, identity.daemon_id);
    assert.equal(JSON.parse(after.stdout).pid, identity.pid);
    const [exit, signal] = await exited;
    assert.equal(exit, 0);
    assert.equal(signal, null);
    const retry = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(JSON.parse(retry.stdout).cleanup.state, 'removed');
    assert.equal(fs.existsSync(f.report.adapter.directory), false);
  } finally {
    if (shared.exitCode === null && shared.signalCode === null) { shared.kill('SIGTERM'); await exited; }
    await f.close();
  }
});

test('completed Pi cleanup remains inspectable and reinstalling the same integration does not duplicate native declarations or user state', {
  skip: !available,
}, async () => {
  const f = await installedFixture('arlo-pi-cleanup-reinstall-');
  try {
    const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    const status = await cliProcess(cli, ['setup-status', ...f.args], f.context);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).components.state, 'removed');
    assert.equal(JSON.parse(status.stdout).phase, 'not-configured');
    const installed = await cliProcess(cli, ['setup', ...f.args, '--apply'], f.context);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const result = JSON.parse(installed.stdout);
    assert.equal(result.components.directory, f.report.components.directory);
    assert.equal(result.components.state, 'installed');
    assert.equal(result.configured, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages.length, 1);
    assert.equal(fs.readFileSync(path.join(f.agent, 'models.json'), 'utf8'), 'RETAIN_MODELS');
    assert.equal(fs.readFileSync(path.join(f.agent, 'history/prior.jsonl'), 'utf8'), 'RETAIN_HISTORY_AND_ROOT');
  } finally { await f.close(); }
});

test('a real package-tool permission failure records native removal and partial cleanup, then retries only the matching owned resource', {
  skip: !available || process.platform !== 'linux', timeout: 60_000,
}, async () => {
  const f = await installedFixture('arlo-pi-cleanup-permissions-');
  const toolRoot = path.join(f.context.directory, 'standard-npm');
  fs.cpSync(path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm'), toolRoot, { recursive: true });
  const tool = path.join(toolRoot, 'bin', 'npm-cli.js');
  const args = [...f.args, '--npm-cli', tool];
  try {
    const version = await commandProcess(process.execPath, [tool, '--version'], f.context);
    assert.equal(version.status, 0, version.stdout + version.stderr);
    assert.equal(version.stdout.trim(), f.report.components.manager.version);
    fs.chmodSync(tool, 0);
    const failed = await cliProcess(cli, ['uninstall', ...args, '--apply'], f.context);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const failure = JSON.parse(failed.stdout);
    assert.equal(failure.error, 'COMPONENT_REMOVE_FAILED');
    assert.equal(failure.cleanup.failure.operation, 'component-remove');
    assert.equal(failure.cleanup.failure.exit, 1);
    assert.equal(failure.cleanup.state, 'recovery-required');
    assert.match(JSON.parse(fs.readFileSync(path.join(f.report.components.directory, 'component-remove-failure.json'), 'utf8')).stderr, /EACCES|permission denied/i);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.agent, 'arlo-setup/pi.json'), 'utf8')).phase, 'removed');
    fs.chmodSync(tool, 0o755);
    const later = JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'));
    later.afterFailure = true;
    fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify(later));
    const status = await cliProcess(cli, ['setup-status', ...args], f.context);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).phase, 'recovery-required');
    const retry = await cliProcess(cli, ['uninstall', ...args, '--apply'], f.context);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(JSON.parse(retry.stdout).cleanup.state, 'removed');
    assert.equal(fs.existsSync(f.report.adapter.directory), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).afterFailure, true);
    assert.equal(fs.readFileSync(path.join(f.agent, 'history/prior.jsonl'), 'utf8'), 'RETAIN_HISTORY_AND_ROOT');
  } finally { fs.chmodSync(tool, 0o755); await f.close(); }
});

test('interrupting the CLI after real package removal retains the exact cleanup stage and a fresh invocation finishes the matching change', {
  skip: !available || process.platform !== 'linux', timeout: 60_000,
}, async () => {
  const f = await installedFixture('arlo-pi-interrupted-cleanup-');
  const running = startCli(['uninstall', ...f.args, '--apply'], f.context);
  let packagePid;
  try {
    packagePid = await until(() => nativeChild(running.child.pid, 'uninstall', f.report.components.consumer), 'standard npm removal in the owned companion');
    process.kill(running.child.pid, 'SIGSTOP');
    await until(() => {
      try { return /\) Z /.test(fs.readFileSync(`/proc/${packagePid}/stat`, 'utf8')); } catch { return true; }
    }, 'the real package tool completes while its CLI caller is stopped');
    assert.equal(fs.existsSync(f.report.adapter.directory), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.report.components.consumer, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies?.['@arlo/adapter-pi'], undefined);
    process.kill(running.child.pid, 'SIGKILL');
    assert.equal((await running.result).signal, 'SIGKILL');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.agent, 'arlo-setup/pi.json'), 'utf8')).phase, 'removed');
    const resource = JSON.parse(fs.readFileSync(path.join(f.report.components.directory, 'components.json'), 'utf8'));
    assert.equal(resource.cleanup.phase, 'removing');
    const status = await cliProcess(cli, ['setup-status', ...f.args], f.context);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).phase, 'recovery-required');
    const retry = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(JSON.parse(retry.stdout).cleanup.state, 'removed');
    assert.equal(fs.readFileSync(path.join(f.agent, 'models.json'), 'utf8'), 'RETAIN_MODELS');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages, []);
  } finally {
    if (running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill('SIGKILL');
      if (packagePid) { try { process.kill(packagePid, 'SIGKILL'); } catch {} }
      await running.result;
    }
    await f.close();
  }
});

test('an unrecorded project declaration keeps shared components while owned Pi user registration is revoked', {
  skip: !available,
}, async () => {
  const f = await installedFixture('arlo-pi-project-sharing-');
  const project = path.join(f.context.directory, '.pi');
  fs.mkdirSync(project);
  const declaration = JSON.stringify({ packages: [f.report.adapter.directory], retainedProjectPreference: true });
  fs.writeFileSync(path.join(project, 'settings.json'), declaration);
  try {
    const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).cleanup.state, 'retained');
    assert.match(JSON.parse(removed.stdout).cleanup.reasons.join(' '), /project|unrecorded|manual/i);
    assert.equal(fs.existsSync(f.report.adapter.directory), true);
    assert.equal(fs.readFileSync(path.join(project, 'settings.json'), 'utf8'), declaration);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages, []);
  } finally { await f.close(); }
});

test('uninstall finds matching partial component consumption without claiming native ownership and remains idempotent', {
  skip: !available,
}, async () => {
  const context = createCliProcessFixture('arlo-pi-partial-cleanup-');
  const distribution = await componentDistribution(bundle);
  distribution.packages.get('@arlo/adapter-pi').unavailable = true;
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\nfetch-retries=0\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  context.env.npm_config_cache = path.join(context.directory, 'npm-cache');
  const agent = path.join(context.directory, 'agent');
  fs.mkdirSync(agent, { mode: 0o700 });
  fs.writeFileSync(path.join(agent, 'settings.json'), '{"packages":[],"retainedPreference":true}');
  fs.writeFileSync(path.join(agent, 'models.json'), 'RETAIN_MODELS');
  const args = ['--host', 'pi', '--target', host, '--agent-dir', agent, '--json'];
  try {
    const nothingOwned = await cliProcess(cli, ['uninstall', ...args, '--apply'], context);
    assert.equal(nothingOwned.status, 0, nothingOwned.stdout + nothingOwned.stderr);
    assert.equal(JSON.parse(nothingOwned.stdout).phase, 'already-removed');
    const failed = await cliProcess(cli, ['setup', ...args, '--apply'], context);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const partial = JSON.parse(failed.stdout);
    assert.equal(partial.error, 'COMPONENT_INSTALL_FAILED');
    assert.equal(partial.components.state, 'partial');
    const record = path.join(agent, 'arlo-setup/pi.json');
    assert.equal(fs.existsSync(record), false, 'native registration has not started');
    const preview = await cliProcess(cli, ['uninstall', ...args], context);
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(JSON.parse(preview.stdout).cleanup.consumer, partial.components.consumer);
    assert.equal(JSON.parse(preview.stdout).cleanup.action, 'remove');
    const removed = await cliProcess(cli, ['uninstall', ...args, '--apply'], context);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).cleanup.state, 'removed');
    assert.equal(JSON.parse(removed.stdout).ownership, 'none');
    assert.equal(fs.existsSync(record), false, 'cleanup never claims or fabricates a native registration');
    for (const name of [...Object.keys(partial.components.packages), ...Object.keys(partial.components.borrowed)]) {
      assert.equal(fs.existsSync(path.join(partial.components.consumer, 'node_modules', name)), false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(partial.components.consumer, 'package.json'), 'utf8')).dependencies?.[name], undefined);
    }
    const repeated = await cliProcess(cli, ['uninstall', ...args, '--apply'], context);
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).phase, 'already-removed');
    assert.equal(fs.readFileSync(path.join(agent, 'models.json'), 'utf8'), 'RETAIN_MODELS');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8')), { packages: [], retainedPreference: true });
  } finally { await distribution.close(); context.close(); }
});

test('a consumed shared Daemon in another state directory retains its physical component origin until normal idle exit', {
  skip: !available || process.platform !== 'linux', timeout: 60_000,
}, async () => {
  const f = await installedFixture('arlo-pi-other-state-cleanup-');
  const stateDir = path.join(f.context.directory, 'another-daemon-state');
  const daemonPackage = path.join(f.report.components.consumer, 'node_modules', '@arlo/daemon');
  const shared = spawn(process.execPath, [path.join(daemonPackage, 'bin/shared.js'), '9000', stateDir], {
    cwd: daemonPackage, env: { ...f.context.env, ARLO_STATE_DIR: stateDir }, stdio: 'ignore',
  });
  const exited = once(shared, 'exit');
  try {
    await until(() => fs.existsSync(path.join(stateDir, 'discovery.json')), 'consumed shared Daemon in an unrecorded state directory');
    const before = await cliProcess(cli, ['status', '--state-dir', stateDir, '--json'], f.context);
    assert.equal(before.status, 0, before.stdout + before.stderr);
    assert.equal(JSON.parse(before.stdout).pid, shared.pid);
    const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).cleanup.state, 'retained');
    assert.match(JSON.parse(removed.stdout).cleanup.reasons.join(' '), /process|Daemon|state directory/i);
    assert.equal(fs.existsSync(f.report.adapter.directory), true);
    assert.equal(fs.realpathSync(fs.readlinkSync(`/proc/${shared.pid}/cwd`)), fs.realpathSync(daemonPackage));
    const after = await cliProcess(cli, ['status', '--state-dir', stateDir, '--json'], f.context);
    assert.equal(after.status, 0, after.stdout + after.stderr);
    assert.equal(JSON.parse(after.stdout).daemon_id, JSON.parse(before.stdout).daemon_id);
    assert.equal(JSON.parse(after.stdout).pid, shared.pid);
    const [exit, signal] = await exited;
    assert.equal(exit, 0);
    assert.equal(signal, null);
    const retry = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(JSON.parse(retry.stdout).cleanup.state, 'removed');
  } finally {
    if (shared.exitCode === null && shared.signalCode === null) { shared.kill('SIGTERM'); await exited; }
    await f.close();
  }
});

test('an unchanged owned Pi declaration can be revoked while a separate manual Arlo declaration and its files remain', {
  skip: !available,
}, async () => {
  const f = await installedFixture('arlo-pi-manual-declaration-cleanup-');
  const manual = path.join(f.context.directory, 'manual-adapter');
  fs.cpSync(f.report.adapter.directory, manual, { recursive: true });
  const retainedFile = path.join(manual, 'src/extension.js');
  const manualHash = hash(retainedFile);
  const native = path.join(host, JSON.parse(fs.readFileSync(path.join(host, 'package.json'), 'utf8')).bin.pi);
  try {
    const installedManual = await commandProcess(process.execPath, [native, 'install', manual], f.context,
      { PI_CODING_AGENT_DIR: f.agent, PI_TELEMETRY: 'false' });
    assert.equal(installedManual.status, 0, installedManual.stdout + installedManual.stderr);
    const declarations = JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages;
    assert.equal(declarations.length, 2);
    const manualDeclaration = declarations.find(source => path.resolve(f.agent, source) === manual);
    assert.ok(manualDeclaration);
    const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).configured, false);
    assert.equal(JSON.parse(removed.stdout).cleanup.state, 'removed');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages, [manualDeclaration]);
    assert.equal(hash(retainedFile), manualHash);
    assert.equal(fs.readFileSync(path.join(f.agent, 'models.json'), 'utf8'), 'RETAIN_MODELS');
  } finally { await f.close(); }
});

test('a confirmed manual shared Pi reference remains unowned and retains components until its native declaration is removed normally', {
  skip: !available,
}, async () => {
  const f = await installedFixture('arlo-pi-manual-reference-cleanup-');
  const manualAgent = path.join(f.context.directory, 'manual-agent');
  fs.mkdirSync(manualAgent, { mode: 0o700 });
  fs.writeFileSync(path.join(manualAgent, 'settings.json'), '{"packages":[],"retainedManualPreference":true}');
  const native = path.join(host, JSON.parse(fs.readFileSync(path.join(host, 'package.json'), 'utf8')).bin.pi);
  const args = ['--host', 'pi', '--target', host, '--agent-dir', manualAgent, '--adapter', f.report.adapter.directory, '--json'];
  try {
    const registered = await commandProcess(process.execPath, [native, 'install', f.report.adapter.directory], f.context,
      { PI_CODING_AGENT_DIR: manualAgent, PI_TELEMETRY: 'false' });
    assert.equal(registered.status, 0, registered.stdout + registered.stderr);
    const shared = await cliProcess(cli, ['setup', ...args, '--apply'], f.context);
    assert.equal(shared.status, 0, shared.stdout + shared.stderr);
    assert.equal(JSON.parse(shared.stdout).ownership, 'preexisting');
    assert.ok(JSON.parse(shared.stdout).components.references.includes(manualAgent));
    const manualSettings = fs.readFileSync(path.join(manualAgent, 'settings.json'), 'utf8');
    assert.equal(fs.existsSync(path.join(manualAgent, 'arlo-setup/pi.json')), false);
    const owned = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(owned.status, 0, owned.stdout + owned.stderr);
    assert.equal(JSON.parse(owned.stdout).cleanup.state, 'retained');
    const manual = await cliProcess(cli, ['uninstall', ...args, '--apply'], f.context);
    assert.equal(manual.status, 0, manual.stdout + manual.stderr);
    assert.equal(JSON.parse(manual.stdout).phase, 'preexisting-preserved');
    assert.equal(JSON.parse(manual.stdout).cleanup.state, 'retained');
    assert.equal(fs.readFileSync(path.join(manualAgent, 'settings.json'), 'utf8'), manualSettings);
    assert.equal(fs.existsSync(f.report.adapter.directory), true);
    const revoked = await commandProcess(process.execPath, [native, 'remove', f.report.adapter.directory], f.context,
      { PI_CODING_AGENT_DIR: manualAgent, PI_TELEMETRY: 'false' });
    assert.equal(revoked.status, 0, revoked.stdout + revoked.stderr);
    const retry = await cliProcess(cli, ['uninstall', ...args, '--apply'], f.context);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(JSON.parse(retry.stdout).cleanup.state, 'removed');
    assert.equal(fs.existsSync(path.join(manualAgent, 'arlo-setup/pi.json')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(manualAgent, 'settings.json'), 'utf8')), { packages: [], retainedManualPreference: true });
  } finally { await f.close(); }
});

test('normal package-manager removal of the adapter leaves an owned native declaration that uninstall can revoke while preserving the changed consumer', {
  skip: !available,
}, async () => {
  const f = await installedFixture('arlo-pi-missing-adapter-cleanup-');
  const npm = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  try {
    const manual = await commandProcess(process.execPath, [npm, '--global=false', `--prefix=${f.report.components.consumer}`,
      'uninstall', '@arlo/adapter-pi', '--workspaces=false', '--install-links=false', '--legacy-peer-deps',
      '--ignore-scripts', '--no-audit', '--no-fund'], f.context);
    assert.equal(manual.status, 0, manual.stdout + manual.stderr);
    assert.equal(fs.existsSync(f.report.adapter.directory), false);
    const manifest = fs.readFileSync(path.join(f.report.components.consumer, 'package.json'), 'utf8');
    const lock = fs.readFileSync(path.join(f.report.components.consumer, 'package-lock.json'), 'utf8');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages.length, 1);
    const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).configured, false);
    assert.equal(JSON.parse(removed.stdout).phase, 'removed-pending-reload');
    assert.equal(JSON.parse(removed.stdout).cleanup.state, 'retained');
    assert.match(JSON.parse(removed.stdout).cleanup.reasons.join(' '), /changed|edit|review/i);
    assert.equal(fs.readFileSync(path.join(f.report.components.consumer, 'package.json'), 'utf8'), manifest);
    assert.equal(fs.readFileSync(path.join(f.report.components.consumer, 'package-lock.json'), 'utf8'), lock);
    assert.equal(fs.existsSync(path.join(f.report.components.consumer, 'node_modules/@arlo/daemon/package.json')), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages, []);
    assert.equal(fs.readFileSync(path.join(f.agent, 'models.json'), 'utf8'), 'RETAIN_MODELS');
  } finally { await f.close(); }
});

test('an older shared scope reference without kind preserves its native integration and the component resource', {
  skip: !available,
}, async () => {
  const f = await installedFixture('arlo-pi-older-reference-cleanup-');
  const olderAgent = path.join(f.context.directory, 'older-agent');
  fs.mkdirSync(olderAgent, { mode: 0o700 });
  const native = path.join(host, JSON.parse(fs.readFileSync(path.join(host, 'package.json'), 'utf8')).bin.pi);
  try {
    const registered = await commandProcess(process.execPath, [native, 'install', f.report.adapter.directory], f.context,
      { PI_CODING_AGENT_DIR: olderAgent, PI_TELEMETRY: 'false' });
    assert.equal(registered.status, 0, registered.stdout + registered.stderr);
    const oldSettings = fs.readFileSync(path.join(olderAgent, 'settings.json'), 'utf8');
    const recordFile = path.join(f.report.components.directory, 'components.json');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    const olderReference = { target: host, phase: 'configured' };
    record.references[olderAgent] = olderReference;
    fs.writeFileSync(recordFile, JSON.stringify(record));
    const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).cleanup.state, 'retained');
    assert.match(JSON.parse(removed.stdout).cleanup.reasons.join(' '), /older|scopes|integration/i);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages, []);
    assert.equal(fs.readFileSync(path.join(olderAgent, 'settings.json'), 'utf8'), oldSettings);
    assert.deepEqual(JSON.parse(fs.readFileSync(recordFile, 'utf8')).references[olderAgent], olderReference);
    assert.equal(fs.existsSync(f.report.adapter.directory), true);
  } finally { await f.close(); }
});

test('changing the CLI data-home environment still previews and cleans the exact companion retained by the native scope record', {
  skip: !available,
}, async () => {
  const f = await installedFixture('arlo-pi-recorded-scope-cleanup-');
  const laterDataHome = path.join(f.context.directory, 'later-data-home');
  try {
    const preview = await cliProcess(cli, ['uninstall', ...f.args], f.context, { XDG_DATA_HOME: laterDataHome });
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
    assert.equal(JSON.parse(preview.stdout).cleanup.consumer, f.report.components.consumer);
    assert.equal(JSON.parse(preview.stdout).cleanup.action, 'remove');
    const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context, { XDG_DATA_HOME: laterDataHome });
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).cleanup.state, 'removed');
    assert.equal(fs.existsSync(f.report.adapter.directory), false);
    assert.equal(fs.existsSync(laterDataHome), false, 'recovery does not create or substitute a consumer in the later data home');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages, []);
    assert.equal(fs.readFileSync(path.join(f.agent, 'models.json'), 'utf8'), 'RETAIN_MODELS');
  } finally { await f.close(); }
});

test('damaged or aliased component ownership records retain their resources while unchanged owned native wiring can be revoked', {
  skip: !available,
}, async t => {
  const cases = [
    ['invalid JSON', () => '{BROKEN_COMPONENT_JSON'],
    ['catalog mismatch', record => { record.packages['@arlo/daemon'] = '99.0.0'; return JSON.stringify(record); }],
    ['owned slot outside scope', record => { record.owned.peerLinks[0] = '../host/node_modules/pi'; return JSON.stringify(record); }],
    ['hardlinked record', record => JSON.stringify(record)],
  ];
  for (const [name, damage] of cases) await t.test(name, async () => {
    const f = await installedFixture('arlo-pi-damaged-record-cleanup-');
    try {
      const recordFile = path.join(f.report.components.directory, 'components.json');
      const damaged = damage(JSON.parse(fs.readFileSync(recordFile, 'utf8')));
      fs.writeFileSync(recordFile, damaged);
      if (name === 'hardlinked record') fs.linkSync(recordFile, path.join(f.context.directory, 'record-alias.json'));
      const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
      assert.equal(removed.status, 0, removed.stdout + removed.stderr);
      assert.equal(JSON.parse(removed.stdout).configured, false);
      assert.equal(JSON.parse(removed.stdout).cleanup.state, 'retained');
      assert.match(JSON.parse(removed.stdout).cleanup.reasons.join(' '), /ownership|ambiguous|review/i);
      assert.equal(fs.readFileSync(recordFile, 'utf8'), damaged, 'the ambiguous ownership record is not rewritten');
      assert.equal(fs.existsSync(f.report.adapter.directory), true);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages, []);
      assert.equal(fs.readFileSync(path.join(f.agent, 'models.json'), 'utf8'), 'RETAIN_MODELS');
    } finally { await f.close(); }
  });
});

test('a later edited or duplicate owned native declaration is preserved with its unchanged component resource for explicit review', {
  skip: !available,
}, async () => {
  const f = await installedFixture('arlo-pi-native-declaration-conflict-');
  try {
    const file = path.join(f.agent, 'settings.json');
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    const journal = path.join(f.agent, 'arlo-setup/pi.json');
    const journalBytes = fs.readFileSync(journal, 'utf8');
    const componentRecord = path.join(f.report.components.directory, 'components.json');
    const componentBytes = fs.readFileSync(componentRecord, 'utf8');
    const artifact = hash(path.join(f.report.adapter.directory, 'src/extension.js'));
    for (const [declarations, error] of [
      [[{ source: original.packages[0], extensions: [] }], 'CONFIGURATION_CHANGED'],
      [[original.packages[0], original.packages[0]], 'DUPLICATE_ADAPTER_CONFLICT'],
    ]) {
      const later = JSON.stringify({ ...original, packages: declarations, afterSetup: true });
      fs.writeFileSync(file, later);
      const removed = await cliProcess(cli, ['uninstall', ...f.args, '--apply'], f.context);
      assert.equal(removed.status, 1, removed.stdout + removed.stderr);
      assert.equal(JSON.parse(removed.stdout).error, error);
      assert.equal(fs.readFileSync(file, 'utf8'), later);
      assert.equal(fs.readFileSync(journal, 'utf8'), journalBytes);
      assert.equal(fs.readFileSync(componentRecord, 'utf8'), componentBytes);
      assert.equal(hash(path.join(f.report.adapter.directory, 'src/extension.js')), artifact);
    }
  } finally { await f.close(); }
});
