import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createCliProcessFixture } from '../tests/fixtures/cli-process.mjs';
import { cliProcess, componentDistribution } from '../tests/fixtures/pi-component-distribution.mjs';
import { eventually, inbound, modelText, nativeScenario, sendFromNative } from './harness.mjs';

test('automatically acquired components load in the selected normal Pi TUI, share one durable resource and preserve native work', {
  timeout: 180_000,
  skip: !process.env.ARLO_PI_SETUP_BUNDLE || !process.env.ARLO_PI_SETUP_HOST || !process.env.ARLO_CLI_ENTRY,
}, async t => {
  const context = createCliProcessFixture('arlo-pi-native-acquisition-');
  const distribution = await componentDistribution(process.env.ARLO_PI_SETUP_BUNDLE);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  context.env.npm_config_cache = path.join(context.directory, 'npm-cache');
  const rig = await nativeScenario('automatic-component-install');
  t.diagnostic(`Evidence: ${rig.directory}; components: ${context.directory}`);
  t.after(async () => { await rig.close(); await distribution.close(); });
  const setup = { setup: true, acquire: true, cli: process.env.ARLO_CLI_ENTRY,
    target: process.env.ARLO_PI_SETUP_HOST, packageEnv: context.env, files: { 'history/retained.txt': 'Prior native history remains.' } };
  const alpha = await rig.start('alpha', { packages: [], retainedPreference: true }, setup);
  await alpha.ready();
  assert.equal(alpha.setupReport.components.state, 'installed');
  const bravo = await rig.start('bravo', { packages: [] }, setup);
  await bravo.ready();
  assert.equal(bravo.setupReport.components.directory, alpha.setupReport.components.directory);
  assert.equal(bravo.setupReport.components.references.length, 2);
  await alpha.submit('/arlo-doctor');
  const notice = await eventually(() => alpha.events().findLast(event => event.type === 'notification' &&
    event.message.includes('Arlo compatibility')), Boolean, 'actual normally loaded adapter doctor');
  assert.match(notice.message, /Required contracts: satisfied/);
  const artifact = JSON.parse(fs.readFileSync(path.join(alpha.setupReport.adapter.directory, 'src/environment-evidence.json'), 'utf8')).adapter.artifactSha256;
  assert.ok(notice.message.includes(artifact), notice.message);
  assert.match(notice.message, /Adapter identity: @arlo\/adapter-pi@0\.1\.0/);
  assert.match(notice.message, /Pi version: 1\.4\.0/);
  rig.handlers.set('bravo', modelText('Actual selected host received the message.'));
  await sendFromNative(rig, alpha, 'bravo', 'AUTO_INSTALLED_NATIVE_PI_MESSAGE');
  await eventually(() => rig.requests.find(request => request.peer === 'bravo' && inbound(request.body, 'AUTO_INSTALLED_NATIVE_PI_MESSAGE')),
    Boolean, 'automatic installation receives through real native Pi');
  const status = await cliProcess(process.env.ARLO_CLI_ENTRY, ['setup-status', '--host', 'pi', '--target', setup.target,
    '--agent-dir', alpha.home, '--json'], context, { npm_config_cache: path.join(context.directory, 'another-cli-cache') });
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.equal(JSON.parse(status.stdout).runtime, 'unobserved', 'disk status never substitutes for the observed native process');
  assert.equal(fs.readFileSync(path.join(alpha.home, 'history/retained.txt'), 'utf8'), 'Prior native history remains.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(alpha.home, 'settings.json'), 'utf8')).retainedPreference, true);
  assert.deepEqual(rig.errors, []);
});
