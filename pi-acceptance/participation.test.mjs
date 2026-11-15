import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { nativeScenario, eventually } from './harness.mjs';

test('Pi native plugin settings persist default-off participation and show acknowledged changes', { timeout: 90_000 }, async t => {
  const rig = await nativeScenario('participation');
  t.after(() => rig.close());
  const pi = await rig.start('pi-settings');
  await pi.ready();
  const file = path.join(pi.home, 'arlo.json');
  assert.equal(fs.existsSync(file), false);
  await pi.submit('/arlo-settings on');
  await eventually(() => pi.output, output => output.includes('Cross-host communication enabled'), 'native setting acknowledged');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).crossHostEnabled, true);
  await pi.submit('/arlo-settings off');
  await eventually(() => pi.output, output => output.includes('Cross-host communication disabled'), 'native disable acknowledged');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).crossHostEnabled, false);
  assert.equal(rig.requests.length, 0, 'Changing settings never starts the model');
});

test('native Pi processes reread one plugin configuration and preserve independently configured preferences', { timeout: 120_000 }, async t => {
  const rig = await nativeScenario('shared-participation');
  t.after(() => rig.close());
  t.diagnostic(`Evidence: ${rig.directory}`);
  const shared = path.join(rig.directory, 'shared-settings', 'arlo.json');
  const first = await rig.start('first', {}, { settingsPath: shared });
  const second = await rig.start('second', {}, { settingsPath: shared });
  const independent = await rig.start('independent');
  await first.ready();
  await second.ready();
  await independent.ready();
  await first.submit('/arlo-settings on');
  await eventually(() => first.output, text => text.includes('Cross-host communication enabled'), 'First Pi setting acknowledged');
  assert.equal(JSON.parse(fs.readFileSync(shared, 'utf8')).crossHostEnabled, true);
  await eventually(() => second.output, text => text.includes('Arlo cross-host: on'), 'Sibling Pi process applies saved configuration');
  assert.equal(independent.output.includes('Arlo cross-host: on'), false);
  const offset = second.output.length;
  await first.submit('/arlo-settings off');
  await eventually(() => second.output.slice(offset), text => text.includes('Arlo cross-host: off'), 'Sibling Pi process rereads disable');
  assert.equal(JSON.parse(fs.readFileSync(shared, 'utf8')).crossHostEnabled, false);
  assert.equal(rig.requests.length, 0);
});
