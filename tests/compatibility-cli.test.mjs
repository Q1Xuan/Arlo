import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils.ts';

const repo = path.resolve(import.meta.dirname, '..');
const cli = (...args) => spawnSync(process.execPath, ['scripts/compatibility.mjs', ...args], {
  cwd: repo, encoding: 'utf8', timeout: 30_000,
});

test('matrix distinguishes formal promotion from historical acceptance failures', () => {
  const result = cli('matrix', '--host', 'pi', '--version', '1.2.0', '--platform', 'linux', '--arch', 'x64', '--node', '24.13.1');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].support, 'formal');
  assert.equal(report.rows[0].beforePromotion20261107.acceptance, 'failed');
  assert.equal(report.rows[0].diagnosis, 'passed');
  assert.ok(report.rows[0].beforePromotion20261107.limitations.some(item => item.includes('targeted reruns')));
});

test('an unmeasured platform/runtime tuple remains untested even for a formal host version', () => {
  const result = cli('matrix', '--host', 'pi', '--version', '1.1.0', '--platform', 'win32', '--arch', 'arm64', '--node', '24.15.0');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.rows[0].support, 'untested');
  assert.equal(report.rows[0].acceptance, 'not-run');
  assert.deepEqual(report.rows[0].evidence, []);
});

test('missing DSH contracts refuse complete native validation before any host starts', t => {
  const directory = createTempDir('compatibility-cli');
  t.after(() => removeTempDir(directory));
  const output = path.join(directory, 'report.json');
  const result = cli('validate', '--stage', 'native', '--target', 'dsh', '--consumer', directory,
    '--experimental', '--output', output);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.complete, false);
  assert.equal(report.stages.contract.status, 'failed');
  assert.equal(report.stages.contract.tasks[0].exitCode, 1);
  assert.equal(report.stages.native.status, 'not-run');
  assert.ok(report.stages.native.tasks.every(task => task.status === 'not-run' && task.exitCode === null));
  assert.equal(report.stages.contract.tasks[0].diagnosis.ready, false);
  assert.match(report.stages.native.reason, /contract/i);
});

test('inventory and single-task selection expose unexecuted work without starting models or consuming artifacts', t => {
  const directory = createTempDir('compatibility-inventory');
  t.after(() => removeTempDir(directory));
  const output = path.join(directory, 'inventory.json');
  const result = cli('validate', '--stage', 'native', '--target', 'cross-host', '--only', 'dsh-cross-host',
    '--inventory', '--output', output);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.complete, false);
  assert.equal(report.privateResources, undefined);
  assert.ok(Object.values(report.stages).every(stage => stage.status === 'not-run'));
  assert.ok(report.stages.native.tasks.some(task => task.id === 'dsh-cross-host'));
  assert.ok(report.stages.native.tasks.some(task => task.id === 'pi-native'));
  for (const id of ['dsh-readiness', 'dsh-configured-multi-contact', 'dsh-missing-provider',
    'dsh-removed-provider', 'dsh-catalog-failure', 'dsh-resolution-failure']) {
    assert.ok(report.stages.native.tasks.some(task => task.id === id), `Complete native plan includes ${id}`);
  }
  for (const stage of Object.values(report.stages)) for (const task of stage.tasks) {
    assert.equal(task.status, 'not-run');
    assert.equal(task.exitCode, null);
    if (task.argv.at(-1)?.endsWith('.test.ts') || task.argv.at(-1)?.endsWith('.test.mjs')) {
      assert.ok(fs.existsSync(path.join(repo, task.argv.at(-1))), 'Planned existing runner/test must exist');
    }
  }
  assert.equal(fs.existsSync(`${output}.artifacts`), false);
  assert.notEqual(cli('validate', '--target', 'dsh', '--inventory', '--output', output).status, 0,
    'Prior evidence cannot be overwritten');
  assert.notEqual(cli('validate', '--stage', 'native', '--target', 'dsh', '--only', 'arbitrary-command',
    '--inventory', '--output', path.join(directory, 'invalid.json')).status, 0);
});

test('the existing acceptance entry routes compatibility stages and retains its platform inventory', t => {
  const directory = createTempDir('compatibility-entry');
  t.after(() => removeTempDir(directory));
  for (const [label, argv] of [
    ['compatibility', ['--compatibility', '--target', 'dsh', '--stage', 'all']],
    ['platform', []],
  ]) {
    const output = path.join(directory, `${label}.json`);
    const result = spawnSync(process.execPath, ['acceptance/run.mjs', ...argv, '--inventory', '--output', output], {
      cwd: repo, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    if (label === 'compatibility') assert.equal(report.stages.native.status, 'not-run');
    else assert.equal(report.execution.mode, 'inventory');
  }
});

test('the matrix reports formal complete recipes separately from historical failures and untested platforms', () => {
  const query = (...args) => {
    const result = cli('matrix', ...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const linux = query('--host', 'dsh', '--version', '0.2.1-rc.2', '--platform', 'linux');
  assert.equal(linux.rows[0].support, 'formal');
  assert.equal(linux.rows[0].diagnosis, 'passed');
  assert.equal(linux.rows[0].acceptance, 'passed');
  assert.equal(Object.keys(linux.recipes['dsh-0.2.1-rc.2'].patches).length, 5);
  assert.match(linux.recipes['dsh-0.2.1-rc.2'].install, /--host-version 0\.2\.1-rc\.2/);
  assert.equal(linux.recipes['dsh-0.2.1-rc.2'].diagnose.includes('--experimental'), false);
  const windows = query('--host', 'dsh', '--version', '0.2.1-rc.2', '--platform', 'win32');
  assert.equal(windows.rows[0].support, 'formal');
  assert.equal(windows.rows[0].diagnosis, 'passed');
  const baseline = query('--host', 'dsh', '--version', '0.2.0-rc.2', '--platform', 'linux', '--node', '24.13.1');
  assert.equal(baseline.rows[0].support, 'formal');
  assert.equal(baseline.rows[0].acceptance, 'failed');
  assert.match(baseline.rows[0].limitations.join(' '), /boot-order/);
  assert.equal(Object.keys(baseline.recipes['dsh-0.2.0-rc.2'].patches).length, 5);
  assert.deepEqual(baseline.runtimeNodes, ['22.22.1', '24.13.1', '24.15.0', '24.22.1']);
});


test('unreviewed host versions are refused before either private builder creates an output', t => {
  const directory = createTempDir('unreviewed-build-version');
  t.after(() => removeTempDir(directory));
  for (const [script, version] of [['pi-delivery.mjs', '1.2.1'], ['web-delivery.mjs', '0.2.1-rc.3']]) {
    const output = path.join(directory, script);
    const result = spawnSync(process.execPath, [`scripts/${script}`, 'build', '--host-version', version, '--out', output], {
      cwd: repo, encoding: 'utf8', timeout: 30_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No reviewed installation profile/);
    assert.equal(fs.existsSync(output), false);
  }
});
