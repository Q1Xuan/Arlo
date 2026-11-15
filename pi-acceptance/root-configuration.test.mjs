import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { nativeScenario, eventually, modelText } from './harness.mjs';

const plain = text => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
// Pi redraws earlier notifications when adding the current one.
const configId = text => [...plain(text).matchAll(/Configuration ID: ([^\s]+)/g)].at(-1)?.[1];

test('the real Pi TUI root configuration command uses only the current human context and preserves its binding through reload',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('root-configuration');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const pi = await rig.start('native-config-root');
    await pi.ready();
    const file = pi.events().findLast(event => event.type === 'session_start').sessionFile;
    assert.equal(fs.existsSync(file), false, 'An idle Pi root has a public path but no persisted conversation');
    await pi.submit('/arlo-root-config');
    await eventually(() => plain(pi.output), text => text.includes('Ownership: unknown (EVIDENCE_UNAVAILABLE)'),
      'Native human command diagnoses unwritten persistence');
    assert.equal(fs.existsSync(file), false, 'Querying never writes private host history');
    assert.equal(rig.requests.length, 0, 'The human command does not run the model');

    rig.handlers.set(pi.name, modelText('Public native conversation persisted.'));
    await pi.submit('Persist a native Pi conversation.');
    await eventually(() => pi.events(), events => events.some(event => event.type === 'agent_settled'),
      'Real public Pi runtime persists and settles the conversation');
    const transcript = fs.readFileSync(file, 'utf8');
    let offset = pi.output.length;
    await pi.submit('/arlo-root-config');
    await eventually(() => plain(pi.output.slice(offset)), text => text.includes('Ownership: verified (BOUND)'),
      'Human command binds actual persisted root via SDK/Daemon');
    const originalId = configId(pi.output.slice(offset));
    assert.ok(originalId && originalId !== 'Unavailable');
    assert.match(plain(pi.output.slice(offset)), /Historical first eligibility: unknown/);
    assert.equal(fs.readFileSync(file, 'utf8'), transcript);
    const requests = rig.requests.length;

    offset = pi.output.length;
    await pi.submit('/arlo-root-config another-root');
    await eventually(() => plain(pi.output.slice(offset)), text => text.includes('with no arguments'),
      'Caller supplied root identity is rejected by human command');
    assert.equal(rig.requests.length, requests);

    const starts = pi.events().filter(event => event.type === 'session_start').length;
    const readiness = rig.readiness.length;
    await pi.submit('/reload');
    await eventually(() => pi.events(), events => events.filter(event => event.type === 'session_start').length > starts,
      'Native public extension reload completes');
    await eventually(() => rig.readiness, proofs => proofs.length > readiness && proofs.at(-1)?.status === 200,
      'Reloaded root confirms current SDK/Daemon readiness');
    const startIndex = pi.events().findLastIndex(event => event.type === 'session_start');
    await eventually(() => pi.events().slice(startIndex), events => events.some(event => event.type === 'draft' && event.text === ''),
      'New public Pi editor exposes its empty draft after reload');
    offset = pi.output.length;
    await pi.submit('/arlo-root-config');
    await eventually(() => plain(pi.output.slice(offset)), text => text.includes('Ownership: verified (BOUND)'),
      'Reloaded human command reads persisted binding');
    assert.equal(configId(pi.output.slice(offset)), originalId);
    assert.equal(rig.requests.length, requests);
    assert.deepEqual(rig.errors, []);
  });
