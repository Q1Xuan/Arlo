import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCliProcessFixture } from '../tests/fixtures/cli-process.mjs';
import { cliProcess, componentDistribution } from '../tests/fixtures/pi-component-distribution.mjs';
import { eventually, inbound, lastTool, modelText, modelTool, nativeScenario, sendFromNative, sendingCommand } from './harness.mjs';

const cli = process.env.ARLO_CLI_ENTRY;
const target = process.env.ARLO_PI_SETUP_HOST;
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const userRequestContains = (request, text) => request?.body.messages.some(message => message.role === 'user' &&
  (typeof message.content === 'string' ? message.content : Array.isArray(message.content)
    ? message.content.map(part => typeof part.text === 'string' ? part.text : '').join('\n') : '').includes(text));

test('owned Pi cleanup revokes native access and reloads normally while another native client keeps its shared Daemon and allowance', {
  timeout: 240_000,
  skip: !cli || !target || !process.env.ARLO_PI_SETUP_BUNDLE,
}, async t => {
  const context = createCliProcessFixture('arlo-pi-native-cleanup-');
  const distribution = await componentDistribution(process.env.ARLO_PI_SETUP_BUNDLE);
  fs.writeFileSync(path.join(context.directory, 'npmrc'), `@arlo:registry=${distribution.url}\n`);
  context.env.NPM_CONFIG_USERCONFIG = path.join(context.directory, 'npmrc');
  const rig = await nativeScenario('owned-component-cleanup', { sharedDaemon: true });
  context.env.ARLO_STATE_DIR = rig.stateDir;
  t.diagnostic(`Evidence: ${rig.directory}; component consumer: ${context.directory}`);
  t.after(async () => { await rig.close(); await distribution.close(); });
  const setup = { setup: true, acquire: true, cli, target, packageEnv: context.env,
    files: { 'history/retained.jsonl': 'PRIOR_NATIVE_HISTORY_AND_ROOT' } };
  const alpha = await rig.start('alpha', { packages: [], retainedPreference: 'ALPHA_PREFERENCE' }, setup);
  await alpha.ready();
  const bravo = await rig.start('bravo', { packages: [], retainedPreference: 'BRAVO_PREFERENCE' }, setup);
  await bravo.ready();
  assert.equal(bravo.setupReport.components.directory, alpha.setupReport.components.directory);
  const component = alpha.setupReport.components;
  const originalModels = [digest(path.join(alpha.home, 'models.json')), digest(path.join(bravo.home, 'models.json'))];
  const status = async () => {
    const result = await cliProcess(cli, ['status', '--state-dir', rig.stateDir, '--json'], context);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const before = await status();
  assert.notEqual(before.pid, process.pid, 'the actual acquired adapter starts its consumed shared Daemon');
  assert.equal(before.active_endpoints_count, 2);
  const daemonOrigin = process.platform === 'linux' ? fs.readlinkSync(`/proc/${before.pid}/cwd`) : undefined;
  if (daemonOrigin) assert.equal(fs.realpathSync(daemonOrigin), fs.realpathSync(path.join(component.consumer, 'node_modules/@arlo/daemon')));
  await alpha.submit('/arlo-doctor');
  const loaded = await eventually(() => alpha.events().findLast(event => event.type === 'notification' && event.message.includes('Arlo compatibility')),
    Boolean, 'actual acquired adapter doctor');
  assert.match(loaded.message, /Required contracts: satisfied/);
  const artifact = JSON.parse(fs.readFileSync(path.join(alpha.setupReport.adapter.directory, 'src/environment-evidence.json'), 'utf8')).adapter.artifactSha256;
  assert.ok(loaded.message.includes(artifact), loaded.message);
  rig.handlers.set('bravo', modelText('The native peer received this message before uninstall.'));
  await sendFromNative(rig, alpha, 'bravo', 'BEFORE_OWNED_NATIVE_CLEANUP');
  await eventually(() => rig.requests.find(request => request.peer === 'bravo' && inbound(request.body, 'BEFORE_OWNED_NATIVE_CLEANUP')),
    Boolean, 'real native active reception before cleanup');
  await eventually(() => bravo.events().findLast(event => event.type === 'agent_settled'), Boolean, 'receiving native turn finishes');
  const allowance = await sendingCommand(bravo, '/arlo-send-status');
  const alphaArgs = ['--host', 'pi', '--target', target, '--agent-dir', alpha.home, '--json'];
  const removedAlpha = await cliProcess(cli, ['uninstall', ...alphaArgs, '--apply'], context);
  assert.equal(removedAlpha.status, 0, removedAlpha.stdout + removedAlpha.stderr);
  fs.writeFileSync(path.join(alpha.home, 'uninstall-command.json'), JSON.stringify(removedAlpha, null, 2));
  assert.equal(JSON.parse(removedAlpha.stdout).cleanup.state, 'retained');
  assert.equal(JSON.parse(removedAlpha.stdout).packages, 'installed');
  assert.equal(fs.existsSync(alpha.setupReport.adapter.directory), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(alpha.home, 'settings.json'), 'utf8')).packages, []);
  const session = alpha.events().findLast(event => event.type === 'session_start');
  const starts = alpha.events().filter(event => event.type === 'session_start').length;
  const priorHistory = fs.readFileSync(session.sessionFile, 'utf8');
  await alpha.submit('/reload');
  await eventually(() => alpha.events().filter(event => event.type === 'session_start'), events => events.length > starts,
    'normal native /reload after owned deregistration');
  assert.equal(alpha.events().findLast(event => event.type === 'session_start').sessionId, session.sessionId);
  rig.handlers.set('alpha', modelText('Ordinary native work remains available after Arlo is unloaded.'));
  await alpha.submit('Continue ordinary native work after the normal reload.');
  const ordinary = await eventually(() => rig.requests.findLast(request => request.peer === 'alpha'),
    request => userRequestContains(request, 'Continue ordinary native work'),
    'actual native model request after cleanup reload');
  assert.equal(ordinary.body.tools?.some(tool => tool.function?.name.startsWith('arlo_')) ?? false, false);
  assert.ok(fs.readFileSync(session.sessionFile, 'utf8').startsWith(priorHistory));
  let discovered;
  rig.handlers.set('bravo', request => {
    if (request.body.messages.at(-1)?.role !== 'tool') return modelTool('arlo_list_sessions', {})(request);
    discovered = lastTool(request.body);
    return modelText('Shared native communication tools remain usable.')(request);
  });
  await bravo.submit('List the remaining Arlo sessions after the other native root reloads.');
  await eventually(() => discovered, Boolean, 'other real native client keeps its communication tools');
  assert.equal(discovered.some(peer => peer.display_name === 'alpha'), false);
  assert.equal(await sendingCommand(bravo, '/arlo-send-status'), allowance, 'uninstall does not change another root identity, allowance period or usage');
  const active = await status();
  assert.equal(active.daemon_id, before.daemon_id);
  assert.equal(active.pid, before.pid);
  assert.equal(active.active_endpoints_count, before.active_endpoints_count, 'normal reload preserves registered root identities while closing Arlo reception');
  await bravo.quit();
  const bravoArgs = ['--host', 'pi', '--target', target, '--agent-dir', bravo.home, '--json'];
  const removedBravo = await cliProcess(cli, ['uninstall', ...bravoArgs, '--apply'], context);
  assert.equal(removedBravo.status, 0, removedBravo.stdout + removedBravo.stderr);
  fs.writeFileSync(path.join(bravo.home, 'uninstall-command.json'), JSON.stringify(removedBravo, null, 2));
  assert.equal(JSON.parse(removedBravo.stdout).cleanup.state, 'retained');
  assert.match(JSON.parse(removedBravo.stdout).cleanup.reasons.join(' '), /Daemon/);
  await eventually(() => fs.existsSync(path.join(rig.stateDir, 'discovery.json')), exists => !exists,
    'the shared Daemon exits through its normal idle lifecycle', 90_000);
  const retry = await cliProcess(cli, ['uninstall', ...bravoArgs, '--apply'], context);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  fs.writeFileSync(path.join(bravo.home, 'cleanup-retry-command.json'), JSON.stringify(retry, null, 2));
  assert.equal(JSON.parse(retry.stdout).cleanup.state, 'removed');
  assert.equal(JSON.parse(retry.stdout).packages, 'missing');
  for (const name of [...Object.keys(component.packages), ...Object.keys(component.borrowed)]) {
    assert.equal(fs.existsSync(path.join(component.consumer, 'node_modules', name)), false);
  }
  assert.equal(fs.existsSync(alpha.setupReport.adapter.directory), false);
  for (const [index, peer] of [alpha, bravo].entries()) {
    assert.equal(digest(path.join(peer.home, 'models.json')), originalModels[index]);
    assert.equal(fs.readFileSync(path.join(peer.home, 'history/retained.jsonl'), 'utf8'), 'PRIOR_NATIVE_HISTORY_AND_ROOT');
    assert.equal(JSON.parse(fs.readFileSync(path.join(peer.home, 'settings.json'), 'utf8')).retainedPreference, index === 0 ? 'ALPHA_PREFERENCE' : 'BRAVO_PREFERENCE');
  }
  const finalStarts = alpha.events().filter(event => event.type === 'session_start').length;
  await alpha.submit('/reload');
  await eventually(() => alpha.events().filter(event => event.type === 'session_start'), events => events.length > finalStarts,
    'normal native /reload after the unshared owned component files are removed');
  assert.equal(alpha.events().findLast(event => event.type === 'session_start').sessionId, session.sessionId);
  await alpha.submit('Continue ordinary native work after all owned component files are removed.');
  const finalNative = await eventually(() => rig.requests.findLast(request => request.peer === 'alpha'),
    request => userRequestContains(request, 'after all owned component files'),
    'native host remains usable after complete component cleanup');
  assert.equal(finalNative.body.tools?.some(tool => tool.function?.name.startsWith('arlo_')) ?? false, false);
  const disk = await cliProcess(cli, ['setup-status', ...alphaArgs], context);
  assert.equal(disk.status, 0, disk.stdout + disk.stderr);
  assert.equal(JSON.parse(disk.stdout).components.state, 'removed');
  assert.equal(JSON.parse(disk.stdout).runtime, 'unobserved');
  fs.writeFileSync(path.join(rig.directory, 'cleanup-lifecycle-proof.json'), JSON.stringify({ cli, target, component, artifact,
    daemon: { before, origin: daemonOrigin, afterAlphaReload: active, deferredLastScope: JSON.parse(removedBravo.stdout).cleanup.daemon },
    normalReload: { sessionId: session.sessionId, afterNativeRevocation: starts + 1, afterComponentRemoval: finalStarts + 1, arloToolsPresent: false },
    preserved: { modelsSha256: originalModels, otherNativeRootSendingStatus: allowance, history: 'PRIOR_NATIVE_HISTORY_AND_ROOT' },
    cleanup: JSON.parse(retry.stdout), diskStatus: JSON.parse(disk.stdout) }, null, 2) + '\n');
  await alpha.quit();
  assert.deepEqual(rig.errors, []);
});
