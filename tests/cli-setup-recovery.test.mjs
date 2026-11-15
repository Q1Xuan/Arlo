import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';

const piReport = process.env.ARLO_RECOVERY_PI_REPORT;
function trace(argv, result, report) {
  if (!process.env.ARLO_RECOVERY_TRACE) return;
  fs.appendFileSync(process.env.ARLO_RECOVERY_TRACE, JSON.stringify({ executable: process.execPath, argv,
    exitCode: result.status, signal: result.signal ?? null,
    stdoutSha256: createHash('sha256').update(result.stdout ?? '').digest('hex'),
    stderrSha256: createHash('sha256').update(result.stderr ?? '').digest('hex'),
    ...(report ? { error: report.error, phase: report.phase, transaction: report.transaction,
      ownership: report.ownership, packages: report.packages, configured: report.configured } : {}) }) + '\n', { mode: 0o600 });
}
function termination(child, argv) {
  return new Promise(resolve => child.once('close', (code, signal) => {
    trace(argv, { status: code, signal }); resolve({ code, signal });
  }));
}
function piFixture(installed = JSON.parse(fs.readFileSync(piReport, 'utf8'))) {
  const target = path.resolve(path.dirname(installed.entries.piEntry), '..');
  const adapter = path.resolve(path.dirname(installed.entries.adapterEntry), '..');
  const cli = process.env.ARLO_RECOVERY_CLI ?? path.resolve('packages/daemon/bin/arlo.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-recovery-pi-'));
  const file = path.join(home, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ packages: [], theme: 'dark', privateKey: 'NEVER_PRINT_RECOVERY_SECRET' }));
  const argv = command => [cli, command, '--host', 'pi', '--target', target, '--adapter', adapter, '--agent-dir', home, '--json', '--apply'];
  const invoke = command => {
    const r = spawnSync(process.execPath, argv(command), { encoding: 'utf8' });
    assert.equal((r.stdout + r.stderr).includes('NEVER_PRINT_RECOVERY_SECRET'), false);
    assert.ok(r.stdout, r.stderr);
    const report = JSON.parse(r.stdout); trace(argv(command), r, report);
    return { ...r, report };
  };
  return { home, file, argv, invoke, adapter, target, record: path.join(home, 'arlo-setup/pi.json'), cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('Pi corrupt ownership metadata cannot authorize native removal', { skip: !piReport }, () => {
  const f = piFixture();
  try {
    const configured = f.invoke('setup'); assert.equal(configured.status, 0); assert.equal(configured.report.transaction, 'configured');
    const original = fs.readFileSync(f.file, 'utf8');
    const record = JSON.parse(fs.readFileSync(f.record, 'utf8'));
    record.owned = 'truthy-but-invalid'; record.phase = 'unrecognized';
    fs.writeFileSync(f.record, JSON.stringify(record));
    const r = f.invoke('uninstall');
    assert.equal(r.status, 1);
    assert.equal(r.report.error, 'SETUP_OWNERSHIP_CONFLICT');
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  } finally { f.cleanup(); }
});

test('Pi native remove that cannot persist settings is unfinished and safely retryable', { skip: !piReport }, () => {
  const f = piFixture();
  try {
    assert.equal(f.invoke('setup').status, 0);
    const original = fs.readFileSync(f.file, 'utf8');
    fs.mkdirSync(`${f.file}.lock`);
    const failed = f.invoke('uninstall');
    assert.equal(failed.status, 1);
    assert.ok(['REGISTRATION_INCOMPLETE', 'HOST_PACKAGE_OPERATION_FAILED'].includes(failed.report.error));
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    fs.rmSync(`${f.file}.lock`, { recursive: true });
    const status = f.invoke('setup-status');
    assert.equal(status.report.transaction, 'removing');
    const current = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    current.userAfterFailure = 'retained';
    fs.writeFileSync(f.file, JSON.stringify(current));
    assert.equal(f.invoke('uninstall').report.phase, 'removed-pending-reload');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { packages: [], theme: 'dark', privateKey: 'NEVER_PRINT_RECOVERY_SECRET', userAfterFailure: 'retained' });
    assert.equal(f.invoke('uninstall').report.phase, 'already-removed');
  } finally { f.cleanup(); }
});


test('Pi removes an owned dead declaration after standard npm package removal', {
  skip: !process.env.ARLO_RECOVERY_PI_NPM_REPORT,
}, () => {
  const source = JSON.parse(fs.readFileSync(process.env.ARLO_RECOVERY_PI_NPM_REPORT, 'utf8'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-dead-pi-'));
  const consumer = path.join(scratch, 'consumer');
  fs.cpSync(source.consumer, consumer, { recursive: true, verbatimSymlinks: true });
  function relocate(value) {
    if (typeof value === 'string' && path.isAbsolute(value)) {
      const relative = path.relative(source.consumer, value);
      if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
        return path.join(consumer, relative);
      }
    }
    if (Array.isArray(value)) return value.map(relocate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)]));
    return value;
  }
  const installed = relocate(source);
  const f = piFixture(installed);
  try {
    assert.equal(f.invoke('setup').status, 0);
    const npm = process.env.ARLO_RECOVERY_NPM;
    const removal = spawnSync(process.execPath, [npm, 'uninstall', '@arlo/adapter-pi', '--ignore-scripts', '--legacy-peer-deps', '--offline', '--no-audit', '--no-fund', '--cache', path.join(scratch, 'npm-cache')], { cwd: consumer, encoding: 'utf8' });
    assert.equal(removal.status, 0, removal.stderr + removal.stdout);
    assert.equal(fs.existsSync(f.adapter), false);
    const status = f.invoke('setup-status');
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.equal(status.report.packages, 'missing');
    assert.equal(status.report.configured, true);
    assert.equal(status.report.ownership, 'arlo');
    const result = f.invoke('uninstall');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.report.phase, 'removed-pending-reload');
    assert.equal(result.report.transaction, 'removed');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).packages, []);
    assert.equal(fs.existsSync(path.join(consumer, 'node_modules/@arlo/daemon/package.json')), true);
    assert.equal(f.invoke('uninstall').report.phase, 'already-removed');
  } finally { f.cleanup(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Owned process did not reach public native package boundary');
}
function nativeChild(pid) {
  try { return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).map(Number).find(child => {
    try { return fs.readFileSync(`/proc/${child}/cmdline`, 'utf8').includes('install\0'); } catch { return false; }
  }); } catch { return undefined; }
}

test('interrupted native Pi install releases its transaction scope and can retry without a duplicate', {
  skip: !piReport || process.platform !== 'linux',
}, async () => {
  const f = piFixture();
  const processHandle = spawn(process.execPath, f.argv('setup'), { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = termination(processHandle, f.argv('setup'));
  let child;
  try {
    child = await until(() => nativeChild(processHandle.pid));
    process.kill(child, 'SIGSTOP');
    const overlapping = f.invoke('setup');
    assert.equal(overlapping.status, 1);
    assert.equal(overlapping.report.error, 'SETUP_BUSY');
    const alias = `${f.home}-alias`; fs.symlinkSync(f.home, alias);
    try {
      const args = f.argv('uninstall'); args[args.indexOf('--agent-dir') + 1] = alias;
      const throughAlias = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(JSON.parse(throughAlias.stdout).error, 'SETUP_BUSY');
    } finally { fs.unlinkSync(alias); }
    processHandle.kill('SIGKILL');
    process.kill(child, 'SIGKILL');
    const termination = await exited;
    assert.equal(termination.signal, 'SIGKILL');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).packages, []);
    assert.equal(f.invoke('setup-status').report.transaction, 'prepared');
    assert.equal(f.invoke('setup').report.phase, 'configured-pending-start-or-reload');
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).packages.length, 1);
    assert.equal(f.invoke('uninstall').report.phase, 'removed-pending-reload');
  } finally {
    processHandle.kill('SIGKILL');
    if (child) { try { process.kill(child, 'SIGKILL'); } catch {} }
    await exited; f.cleanup();
  }
});

test('an interrupted Pi install with a persisted declaration requires review instead of claiming user configuration', {
  skip: !piReport || process.platform !== 'linux',
}, async () => {
  const f = piFixture();
  const processHandle = spawn(process.execPath, f.argv('setup'), { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = termination(processHandle, f.argv('setup'));
  try {
    await until(() => nativeChild(processHandle.pid));
    processHandle.kill('SIGSTOP');
    await until(() => JSON.parse(fs.readFileSync(f.file, 'utf8')).packages.length === 1);
    processHandle.kill('SIGKILL'); await exited;
    const current = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    current.afterInterruptedInstall = 'keep';
    fs.writeFileSync(f.file, JSON.stringify(current));
    const before = fs.readFileSync(f.file, 'utf8');
    const status = f.invoke('setup-status');
    assert.equal(status.report.phase, 'recovery-required');
    for (const command of ['setup', 'uninstall']) {
      const result = f.invoke(command);
      assert.equal(result.status, 1);
      assert.equal(result.report.error, 'RECOVERY_REVIEW_REQUIRED');
      assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    }
    // User resolves the ambiguous native registration through the actual host.
    const host = JSON.parse(fs.readFileSync(path.join(f.target, 'package.json'), 'utf8'));
    const removed = spawnSync(process.execPath, [path.join(f.target, host.bin.pi), 'remove', f.adapter], { cwd: f.home, env: { ...process.env, PI_CODING_AGENT_DIR: f.home }, encoding: 'utf8' });
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(f.invoke('setup').status, 0);
    assert.equal(f.invoke('uninstall').status, 0);
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).afterInterruptedInstall, 'keep');
  } finally { processHandle.kill('SIGKILL'); await exited; f.cleanup(); }
});

const dshConsumer = process.env.ARLO_RECOVERY_DSH_CONSUMER;
function dshFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-recovery-dsh-'));
  const profile = path.join(home, 'profiles/web'); fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const file = path.join(profile, 'package.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'private-web', private: true, custom: 'preserve', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
  const target = path.join(dshConsumer, 'node_modules/@deepseek-ai/dsh');
  const adapter = path.join(dshConsumer, 'node_modules/@arlo/adapter-dsh');
  const cli = process.env.ARLO_RECOVERY_CLI ?? path.resolve('packages/daemon/bin/arlo.js');
  const argv = command => [cli, command, '--host', 'dsh', '--target', target, '--adapter', adapter, '--profile', 'web', '--dsh-home', home, '--apply', '--json'];
  const invoke = command => { const r = spawnSync(process.execPath, argv(command), { encoding: 'utf8' }); assert.ok(r.stdout, r.stderr); const report = JSON.parse(r.stdout); trace(argv(command), r, report); return { ...r, report }; };
  return { home, profile, file, target, adapter, argv, invoke, record: path.join(profile, 'arlo-setup/dsh.json'), cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('DSH can revoke only its owned profile wiring when the shared adapter disappears', { skip: !dshConsumer }, () => {
  const f = dshFixture();
  const adapter = fs.realpathSync(f.adapter); const saved = `${adapter}.recovery-test-saved`;
  try {
    const installed = f.invoke('setup'); assert.equal(installed.status, 0, installed.stdout + installed.stderr); assert.equal(installed.report.transaction, 'configured');
    const current = JSON.parse(fs.readFileSync(f.file, 'utf8')); current.afterSetup = 'keep'; fs.writeFileSync(f.file, JSON.stringify(current));
    fs.renameSync(adapter, saved);
    const status = f.invoke('setup-status');
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.equal(status.report.packages, 'missing');
    assert.match(status.report.nextStep, /Restore.*compiled/);
    const removed = f.invoke('uninstall');
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(removed.report.phase, 'removed-pending-reload');
    assert.equal(removed.report.transaction, 'removed');
    const after = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.equal(after.afterSetup, 'keep'); assert.equal(after.custom, 'preserve');
    assert.equal(after.dependencies?.['@arlo/adapter-dsh'], undefined);
    assert.equal(after.dsh.profile.bundles.includes('@arlo/adapter-dsh'), false);
    assert.equal(fs.lstatSync(saved).isDirectory(), true);
    assert.equal(f.invoke('uninstall').report.phase, 'already-removed');
  } finally { if (fs.existsSync(saved)) fs.renameSync(saved, adapter); f.cleanup(); }
});

test('Pi reports later owned declaration edits as conflict and preserves them through setup and removal', { skip: !piReport }, () => {
  const f = piFixture();
  try {
    assert.equal(f.invoke('setup').status, 0);
    const current = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    current.packages = [{ source: current.packages[0], extensions: ['user-selected-extension'] }];
    current.model = 'user-changed-model';
    fs.writeFileSync(f.file, JSON.stringify(current));
    const original = fs.readFileSync(f.file, 'utf8');
    const status = f.invoke('setup-status');
    assert.equal(status.report.phase, 'configuration-conflict');
    assert.equal(status.report.ownership, 'conflict');
    for (const command of ['setup', 'uninstall']) {
      const result = f.invoke(command);
      assert.equal(result.status, 1);
      assert.equal(result.report.error, 'CONFIGURATION_CHANGED');
      assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    }
  } finally { f.cleanup(); }
});

function childMatching(pid, marker) {
  try { return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).map(Number).find(child => {
    try { return fs.readFileSync(`/proc/${child}/cmdline`, 'utf8').includes(marker); } catch { return false; }
  }); } catch { return undefined; }
}

test('interrupted native DSH installation releases the profile scope and retries one registration', {
  skip: !dshConsumer || process.platform !== 'linux',
}, async () => {
  const f = dshFixture();
  const processHandle = spawn(process.execPath, f.argv('setup'), { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = termination(processHandle, f.argv('setup'));
  let child;
  try {
    child = await until(() => childMatching(processHandle.pid, 'native-profile.mjs'));
    process.kill(child, 'SIGSTOP');
    assert.equal(f.invoke('setup').report.error, 'SETUP_BUSY');
    assert.equal(f.invoke('uninstall').report.error, 'SETUP_BUSY');
    const other = path.join(f.home, 'profiles/other'); fs.mkdirSync(other, { mode: 0o700 });
    const otherFile = path.join(other, 'package.json');
    const otherManifest = { private: true, model: 'preserved-other-profile-model', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
    fs.writeFileSync(otherFile, JSON.stringify(otherManifest)); fs.writeFileSync(path.join(other, 'cordis.patch.yml'), '[]\n');
    for (const command of ['setup', 'uninstall']) {
      const args = f.argv(command); args[args.indexOf('--profile') + 1] = 'other';
      const independent = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(independent.status, 0, independent.stdout + independent.stderr);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(otherFile, 'utf8')), otherManifest);
    processHandle.kill('SIGKILL'); process.kill(child, 'SIGKILL');
    assert.equal((await exited).signal, 'SIGKILL');
    assert.equal(f.invoke('setup-status').report.transaction, 'prepared');
    assert.equal(f.invoke('setup').report.phase, 'configured-pending-start-or-reload');
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).dsh.profile.bundles.filter(n => n === '@arlo/adapter-dsh').length, 1);
    assert.equal(f.invoke('uninstall').report.phase, 'removed-pending-reload');
  } finally {
    processHandle.kill('SIGKILL'); if (child) { try { process.kill(child, 'SIGKILL'); } catch {} }
    await exited; f.cleanup();
  }
});

test('DSH finishes an interrupted removal without restoring later profile edits', {
  skip: !dshConsumer || process.platform !== 'linux',
}, async () => {
  const f = dshFixture();
  assert.equal(f.invoke('setup').status, 0);
  const processHandle = spawn(process.execPath, f.argv('uninstall'), { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = termination(processHandle, f.argv('uninstall'));
  try {
    await until(() => childMatching(processHandle.pid, 'native-profile.mjs'));
    processHandle.kill('SIGSTOP');
    await until(() => {
      const current = JSON.parse(fs.readFileSync(f.file, 'utf8'));
      return !current.dependencies?.['@arlo/adapter-dsh'] && !current.dsh.profile.bundles.includes('@arlo/adapter-dsh');
    });
    processHandle.kill('SIGKILL'); await exited;
    const current = JSON.parse(fs.readFileSync(f.file, 'utf8')); current.afterInterruptedRemoval = 'keep';
    fs.writeFileSync(f.file, JSON.stringify(current));
    assert.equal(f.invoke('setup-status').report.transaction, 'removing');
    const removed = f.invoke('uninstall');
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(removed.report.phase, 'removed-pending-reload');
    assert.equal(f.invoke('setup-status').report.transaction, 'removed');
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).afterInterruptedRemoval, 'keep');
    assert.equal(fs.existsSync(path.join(f.profile, 'node_modules/@arlo/adapter-dsh')), false);
    assert.equal(f.invoke('uninstall').report.phase, 'already-removed');
  } finally { processHandle.kill('SIGKILL'); await exited; f.cleanup(); }
});

test('DSH preserves later contact configuration edits and reports ownership conflict', { skip: !dshConsumer }, () => {
  const f = dshFixture();
  try {
    assert.equal(f.invoke('setup').status, 0);
    const overlay = path.join(f.profile, 'cordis.patch.yml');
    const changed = '- id: arlo-contact\n  config:\n    groupName: user-selected-group\n';
    fs.writeFileSync(overlay, changed);
    const before = fs.readFileSync(f.file, 'utf8');
    const status = f.invoke('setup-status');
    assert.equal(status.report.phase, 'configuration-conflict');
    assert.equal(status.report.ownership, 'conflict');
    for (const command of ['setup', 'uninstall']) {
      const result = f.invoke(command);
      assert.equal(result.status, 1);
      assert.equal(result.report.error, 'CONFIGURATION_CHANGED');
      assert.equal(fs.readFileSync(f.file, 'utf8'), before);
      assert.equal(fs.readFileSync(overlay, 'utf8'), changed);
    }
  } finally { f.cleanup(); }
});

test('DSH native package-tool failure remains unfinished and retry preserves later unrelated settings', {
  skip: !dshConsumer || process.platform !== 'linux',
}, () => {
  const f = dshFixture();
  const modules = path.join(f.profile, 'node_modules'); fs.mkdirSync(modules, { mode: 0o500 });
  try {
    const failed = f.invoke('setup');
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.equal(failed.report.error, 'HOST_PACKAGE_OPERATION_FAILED');
    assert.equal(f.invoke('setup-status').report.transaction, 'prepared');
    fs.chmodSync(modules, 0o700);
    const current = JSON.parse(fs.readFileSync(f.file, 'utf8')); current.afterFailure = 'keep'; fs.writeFileSync(f.file, JSON.stringify(current));
    assert.equal(f.invoke('setup').report.phase, 'configured-pending-start-or-reload');
    assert.equal(f.invoke('uninstall').report.phase, 'removed-pending-reload');
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).afterFailure, 'keep');
  } finally { fs.chmodSync(modules, 0o700); f.cleanup(); }
});

test('interrupted DSH install with native persisted wiring stays unowned until the user reviews it', {
  skip: !dshConsumer || process.platform !== 'linux',
}, async () => {
  const f = dshFixture();
  const processHandle = spawn(process.execPath, f.argv('setup'), { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = termination(processHandle, f.argv('setup'));
  try {
    await until(() => childMatching(processHandle.pid, 'native-profile.mjs'));
    processHandle.kill('SIGSTOP');
    await until(() => JSON.parse(fs.readFileSync(f.file, 'utf8')).dsh.profile.bundles.includes('@arlo/adapter-dsh'));
    processHandle.kill('SIGKILL'); await exited;
    const current = JSON.parse(fs.readFileSync(f.file, 'utf8')); current.afterInterruptedInstall = 'keep'; fs.writeFileSync(f.file, JSON.stringify(current));
    const before = fs.readFileSync(f.file, 'utf8');
    const status = f.invoke('setup-status');
    assert.equal(status.report.phase, 'recovery-required'); assert.equal(status.report.ownership, 'preexisting');
    for (const command of ['setup', 'uninstall']) {
      const result = f.invoke(command); assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.report.error, 'RECOVERY_REVIEW_REQUIRED'); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    }
    const npm = process.env.ARLO_RECOVERY_NPM ?? path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    const program = 'const {runCli}=await import(process.argv[1]);process.argv=[process.execPath,process.argv[1],...process.argv.slice(2)];await runCli({packageManager:{command:process.execPath,args:[process.env.ARLO_RECOVERY_NATIVE_NPM]}})';
    const removed = spawnSync(process.execPath, ['--input-type=module', '-e', program, pathToFileURL(path.join(f.target, 'lib/bin.js')).href,
      'plugin', '--profile', 'web', 'uninstall', '@arlo/adapter-dsh', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'],
      { cwd: f.profile, env: { ...process.env, DSH_HOME: f.home, ARLO_RECOVERY_NATIVE_NPM: npm }, encoding: 'utf8' });
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
    assert.equal(f.invoke('setup').status, 0);
    assert.equal(f.invoke('uninstall').status, 0);
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).afterInterruptedInstall, 'keep');
  } finally { processHandle.kill('SIGKILL'); await exited; f.cleanup(); }
});

test('Pi refuses redirected or shared settings files without touching the other configuration', {
  skip: !piReport || process.platform !== 'linux',
}, () => {
  for (const kind of ['symbolic', 'hard']) {
    const f = piFixture(); const other = path.join(f.home, 'other-settings.json');
    fs.copyFileSync(f.file, other); fs.unlinkSync(f.file);
    if (kind === 'symbolic') fs.symlinkSync(other, f.file); else fs.linkSync(other, f.file);
    const before = fs.readFileSync(other, 'utf8');
    try {
      const result = f.invoke('setup'); assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.report.error, 'CONFIGURATION_TARGET_CONFLICT');
      assert.equal(fs.readFileSync(other, 'utf8'), before);
      assert.equal(fs.existsSync(f.record), false);
    } finally { f.cleanup(); }
  }
});

test('DSH refuses a redirected profile manifest without touching its separate owner', {
  skip: !dshConsumer || process.platform !== 'linux',
}, () => {
  const f = dshFixture(); const other = path.join(f.home, 'other-profile.json');
  fs.copyFileSync(f.file, other); fs.unlinkSync(f.file); fs.symlinkSync(other, f.file);
  const before = fs.readFileSync(other, 'utf8');
  try {
    const result = f.invoke('setup'); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.report.error, 'CONFIGURATION_TARGET_CONFLICT');
    assert.equal(fs.readFileSync(other, 'utf8'), before); assert.equal(fs.existsSync(f.record), false);
  } finally { f.cleanup(); }
});
