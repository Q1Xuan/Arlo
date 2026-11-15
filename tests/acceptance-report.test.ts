import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils.ts';
// The runner is executable JavaScript, shared with the command-line entry.
// @ts-expect-error The executable reporter has no ambient declarations.
import { combineStatus, evaluateScenario } from '../acceptance/results.mjs';

const scenario = { platform: 'win32', tests: [{ file: 'tests/example.test.ts', name: 'required behavior' }], gap: null };
const passed = { file: 'tests/example.test.ts', name: 'required behavior', status: 'passed' };

test('Acceptance evidence cannot promote missing, skipped, failed or wrong-platform behavior to passed', () => {
  const evaluate = (tests: unknown[], platform = 'win32') => evaluateScenario(scenario, { platform, tests });
  assert.equal(evaluate([passed]).status, 'passed');
  assert.equal(evaluate([]).status, 'not-run');
  assert.equal(evaluate([{ ...passed, name: 'an unrelated passing test' }]).status, 'not-run');
  assert.equal(evaluate([{ ...passed, status: 'not-run' }]).status, 'not-run');
  assert.equal(evaluate([{ ...passed, status: 'failed' }]).status, 'failed');
  assert.equal(evaluate([{ ...passed, status: 'blocked' }]).status, 'blocked');
  assert.equal(evaluate([passed], 'linux').status, 'not-run');
  assert.equal(combineStatus([{ status: 'passed' }, { status: 'not-run' }]), 'not-run');
  assert.equal(combineStatus([{ status: 'passed' }, { status: 'failed' }]), 'failed');
  assert.equal(combineStatus([]), 'not-run');
  assert.equal(evaluateScenario({ ...scenario, tests: [{ runner: 'isolation' }] }, {
    platform: 'win32', tests: [], isolationStatus: 'failed',
  }).status, 'failed', 'An executed isolation failure is a failure, not an unrun scenario');
});

test('The actual Node reporter preserves a failing exit, explicit skip and cancellation as non-passing evidence', () => {
  const directory = createTempDir('acceptance-reporter');
  try {
    const script = path.join(directory, 'behavior.test.mjs');
    fs.writeFileSync(script, `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('passes', () => {});
test('skipped', { skip: 'platform unavailable' }, () => { throw new Error('must not run'); });
test('fails', () => assert.equal(1, 2));
const controller = new AbortController(); controller.abort();
test('canceled child', { signal: controller.signal }, () => {});
`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      '--test', '--test-reporter', new URL('../acceptance/reporter.mjs', import.meta.url).href, script,
    ], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, 'Reporter must preserve the real failing process exit');
    const records = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(records.find(record => record.name === 'passes').status, 'passed');
    assert.equal(records.find(record => record.name === 'skipped').status, 'not-run');
    assert.equal(records.find(record => record.name === 'fails').status, 'failed');
    assert.equal(records.find(record => record.name === 'canceled child').status, 'failed');
    assert.equal(result.stdout.includes('AssertionError'), false, 'Failure details remain in the private diagnostic log');
  } finally { removeTempDir(directory); }
});
