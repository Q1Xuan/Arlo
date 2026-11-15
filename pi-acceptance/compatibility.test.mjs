import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventually, nativeScenario, piVersion } from './harness.mjs';

test('native compatibility diagnosis reports the actual host, formal policy and root evidence', { timeout: 90_000 }, async t => {
  const rig = await nativeScenario('compatibility-doctor');
  t.after(() => rig.close());
  t.diagnostic(`Evidence: ${rig.directory}`);
  const peer = await rig.start('doctor');
  await peer.ready();
  await peer.submit('/arlo-doctor');
  const notice = await eventually(() => peer.events().findLast(event => event.type === 'notification' &&
    event.message.includes('Arlo compatibility')), Boolean, 'current native compatibility diagnosis');
  assert.ok(notice.message.includes(`Pi version: ${piVersion}`));
  assert.ok(notice.message.includes(`Policy: ${process.env.ARLO_PI_EXPERIMENTAL === '1' ? 'experimental' : 'verified'}`));
  assert.match(notice.message, /Formal versions: 1\.1\.0, 1\.2\.0, 1\.3\.0, 1\.4\.0/);
  assert.match(notice.message, /Host support policy: (formal|experimental-required)/);
  assert.ok(notice.message.includes(`Runtime: ${process.platform}/${process.arch}/Node ${process.versions.node}`));
  assert.match(notice.message, /Adapter identity: @arlo\/adapter-pi@0\.1\.0 \([a-f0-9]{64}\)/);
  assert.match(notice.message, /Environment evidence: (verified|failed|unverified) \([A-Z_]+\)/);
  if (['1.2.0', '1.3.0', '1.4.0'].includes(piVersion) && process.platform === 'linux' && process.versions.node === '24.13.1') {
    assert.match(notice.message, /Environment evidence: verified \(MATCHED\)/);
    assert.match(notice.message, /Environment scope:.*#149/);
    assert.match(notice.message, /Measured acceptance: passed/);
    assert.match(notice.message, /Environment limits: Only this exact host version/);
  }
  if (['1.2.0', '1.3.0', '1.4.0'].includes(piVersion) && process.platform === 'win32' && process.versions.node === '24.13.1') {
    assert.match(notice.message, /Observed Windows: 10\.0\.19045; Windows 10 Home 22H2; build 19045\.6456 \(windows-registry\)/);
    assert.match(notice.message, /Measured Windows: 10\.0\.19045; Windows 10 Home 22H2; build 19045\.6456/);
    assert.match(notice.message, /Environment evidence: verified \(MATCHED\)/);
    assert.match(notice.message, /Measured acceptance: passed-applicable/);
  }
  if (process.env.ARLO_PI_INSTALL_REPORT) assert.match(notice.message, /Evidence binding: bound/);
  assert.match(notice.message, /Required contracts: satisfied \(SATISFIED\)/);
  assert.match(notice.message, /Required interface: available/);
  assert.match(notice.message, /Reception: ready/);
  assert.match(notice.message, /Ownership: unknown \(EVIDENCE_UNAVAILABLE\)/);
  assert.match(notice.message, /Busy scheduling: limited/);
  assert.equal(rig.requests.length, 0, 'Read-only diagnosis does not invoke a model or grant an allowance');
});

test('an experimental native root with unstable identity is refused despite all method names existing', { timeout: 90_000 }, async t => {
  const rig = await nativeScenario('compatibility-invalid-root');
  t.after(() => rig.close());
  t.diagnostic(`Evidence: ${rig.directory}`);
  const peer = await rig.start('invalid', {}, { experimental: true, invalidHeaderIdentity: true });
  await eventually(() => peer.output, output => output.includes('ROOT_CONTEXT_REQUIRED'), 'unstable public root identity refused');
  assert.equal(peer.output.includes('Arlo ready'), false);
  await peer.submit('/arlo-doctor');
  const notice = await eventually(() => peer.events().findLast(event => event.type === 'notification' &&
    event.message.includes('Arlo compatibility')), Boolean, 'invalid root remains diagnosable');
  assert.match(notice.message, /Required interface: available/);
  assert.match(notice.message, /Current native root: unavailable/);
  assert.match(notice.message, /Reception: unavailable/);
  assert.equal(rig.requests.length, 0);
});

test('default native policy admits the discrete formal versions and refuses an unverified real host', { timeout: 90_000 }, async t => {
  const rig = await nativeScenario('compatibility-default', { experimental: false });
  t.after(() => rig.close());
  t.diagnostic(`Evidence: ${rig.directory}`);
  const peer = await rig.start('default');
  if (['1.1.0', '1.2.0', '1.3.0', '1.4.0'].includes(piVersion)) await peer.ready();
  else {
    await eventually(() => peer.output, output => output.includes(`UNSUPPORTED_PI_VERSION (${piVersion})`),
      'unverified real host needs explicit opt-in');
    assert.equal(peer.output.includes('Arlo ready'), false);
  }
  await peer.submit('/arlo-doctor');
  const notice = await eventually(() => peer.events().findLast(event => event.type === 'notification' &&
    event.message.includes('Arlo compatibility')), Boolean, 'default policy diagnosis');
  assert.match(notice.message, /Policy: verified/);
  assert.match(notice.message, /Formal versions: 1\.1\.0, 1\.2\.0, 1\.3\.0, 1\.4\.0/);
  assert.ok(notice.message.includes(`Reception: ${['1.1.0', '1.2.0', '1.3.0', '1.4.0'].includes(piVersion) ? 'ready' : 'unavailable'}`));
  assert.equal(rig.requests.length, 0);
});

test('explicit native experiment refuses a missing input handoff capability before readiness', { timeout: 90_000 }, async t => {
  const rig = await nativeScenario('compatibility-missing-handoff');
  t.after(() => rig.close());
  t.diagnostic(`Evidence: ${rig.directory}`);
  const peer = await rig.start('missing', {}, { experimental: true, missingCapability: 'sendMessage' });
  await eventually(() => peer.output, output => output.includes('MISSING_PI_CAPABILITY: pi.sendMessage'),
    'missing required capability is diagnosed at startup');
  assert.equal(peer.output.includes('Arlo ready'), false);
  await peer.submit('/arlo-doctor');
  const notice = await eventually(() => peer.events().findLast(event => event.type === 'notification' &&
    event.message.includes('Arlo compatibility')), Boolean, 'refused experiment remains diagnosable');
  assert.match(notice.message, /Policy: experimental/);
  assert.match(notice.message, /Required interface: missing pi.sendMessage/);
  assert.match(notice.message, /Reception: unavailable/);
  assert.equal(rig.requests.length, 0);
});

test('missing notification capability refuses native readiness and reports a named error without invoking it', { timeout: 90_000 }, async t => {
  const rig = await nativeScenario('compatibility-missing-notify');
  t.after(() => rig.close());
  t.diagnostic(`Evidence: ${rig.directory}`);
  for (const experimental of [true, false]) {
    const peer = await rig.start(`missing-notify-${experimental}`, {}, { experimental, missingCapability: 'notify' });
    const error = await eventually(() => peer.events().find(event => event.type === 'adapter_error' && event.boundary === 'session_start'),
      Boolean, 'Missing notification is refused before readiness');
    assert.equal(error.error, 'Error: MISSING_PI_CAPABILITY: ui.notify');
    assert.equal(peer.output.includes('Arlo ready'), false);
    assert.equal(peer.output.includes('TypeError'), false);
    await peer.submit('/arlo-doctor');
    const doctorError = await eventually(() => peer.events().find(event => event.type === 'adapter_error' && event.boundary === 'arlo-doctor'),
      Boolean, 'Doctor passes the named failure to the native extension-error surface');
    assert.equal(doctorError.error, 'Error: MISSING_PI_CAPABILITY: ui.notify');
  }
  assert.equal(rig.requests.length, 0);
});
