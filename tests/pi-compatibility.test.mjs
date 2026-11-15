import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installation = process.env.ARLO_PI_INSTALL_REPORT
  ? JSON.parse(fs.readFileSync(process.env.ARLO_PI_INSTALL_REPORT, 'utf8')) : undefined;
if (installation) assert.equal(installation.status, 'passed');
const adapterUrl = installation ? pathToFileURL(installation.entries.adapterEntry)
  : new URL('../packages/adapter-pi/src/index.ts', import.meta.url);
const adapter = await import(adapterUrl.href);
const evidenceFile = new URL('./environment-evidence.json', adapterUrl);
const hostVersion = installation?.entries.piVersion ?? '1.1.0';
const atomicWrite = content => {
  const temporary = new URL('./environment-evidence.test-replacement.json', adapterUrl);
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, evidenceFile);
};

function nativeContext() {
  const header = { type: 'session', id: 'diagnostic-root', cwd: process.cwd() };
  const methods = names => Object.fromEntries(names.map(name => [name, () => {}]));
  return {
    pi: methods(['sendMessage', 'sendUserMessage', 'appendEntry']),
    ctx: {
      mode: 'tui', isIdle: () => true, abort() {},
      ui: methods(['notify', 'setStatus', 'setEditorComponent', 'getEditorComponent',
        'addAutocompleteProvider', 'onTerminalInput', 'select']),
      sessionManager: { getHeader: () => header, getSessionId: () => header.id,
        getSessionFile: () => '/diagnostic/session.jsonl', getCwd: () => header.cwd,
        getEntries: () => [], getSessionName: () => 'diagnostic' },
    },
  };
}

test('Pi diagnostic separates formal host policy, measured environment limits and required contracts', () => {
  const { pi, ctx } = nativeContext();
  const report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
  assert.equal(report.hostSupportPolicy, 'formal');
  assert.deepEqual(report.runtime, { platform: process.platform, arch: process.arch, node: process.versions.node });
  assert.equal(report.environmentEvidence.status, hostVersion === '1.1.0' ? 'failed' : 'verified');
  // Windows's Linux-only suspend control remains explicitly inapplicable.
  const acceptance = hostVersion === '1.1.0' ? 'failed'
    : process.platform === 'win32' ? 'passed-applicable' : 'passed';
  assert.equal(report.environmentEvidence.acceptance, acceptance);
  assert.ok(report.environmentEvidence.limitations.length > 0);
  assert.equal(report.requiredContracts.ready, true);
  assert.equal(report.requiredContracts.reason, 'SATISFIED');
  assert.equal(report.installation.adapter.name, '@arlo/adapter-pi');
  assert.equal(report.installation.packages['@earendil-works/pi-coding-agent'], hostVersion);
  assert.equal(report.installation.binding, installation ? 'bound' : 'source');
  if (process.platform === 'win32') {
    assert.deepEqual(report.observedWindows, { status: 'observed', source: 'windows-registry',
      osRelease: '10.0.19045', productName: 'Windows 10 Home', displayVersion: '22H2', build: '19045.6456' });
    assert.deepEqual(report.environmentEvidence.measuredWindows, [{ osRelease: '10.0.19045',
      productName: 'Windows 10 Home', displayVersion: '22H2', build: '19045.6456' }]);
  } else assert.equal(report.observedWindows, undefined);
});

test('formal Pi in an unverified environment remains eligible under its required contracts', t => {
  const previous = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', previous));
  const { pi, ctx } = nativeContext();
  const report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
  assert.equal(report.hostSupportPolicy, 'formal');
  assert.equal(report.environmentEvidence.status, 'unverified');
  assert.equal(report.environmentEvidence.reason, 'NO_MATCH');
  assert.match(report.environmentEvidence.limitations.join(' '), /当前环境尚未验证/);
  assert.equal(report.requiredContracts.ready, true);
  assert.equal(report.policy, 'verified');
});

test('a measured Windows release cannot label another release verified or change formal Pi readiness',
  { skip: process.platform !== 'win32' || !installation }, t => {
    const original = fs.readFileSync(evidenceFile);
    const evidence = JSON.parse(original);
    for (const row of evidence.rows.filter(row => row.platform === 'win32')) {
      row.windows = { osRelease: '10.0.22631', productName: 'Windows 11 Home',
        displayVersion: '23H2', build: '22631.6456' };
    }
    atomicWrite(JSON.stringify(evidence));
    t.after(() => atomicWrite(original));
    const { pi, ctx } = nativeContext();
    const report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
    assert.equal(report.environmentEvidence.status, 'unverified');
    assert.equal(report.environmentEvidence.reason, 'NO_MATCH');
    assert.equal(report.hostSupportPolicy, 'formal');
    assert.equal(report.requiredContracts.ready, true);
    assert.equal(report.policy, 'verified');
  });

test('a different Windows servicing revision remains unverified under formal Pi contracts',
  { skip: process.platform !== 'win32' || !installation }, t => {
    const original = fs.readFileSync(evidenceFile);
    const evidence = JSON.parse(original);
    for (const row of evidence.rows.filter(row => row.platform === 'win32')) {
      row.windows = { osRelease: '10.0.19045', productName: 'Windows 10 Home',
        displayVersion: '22H2', build: '19045.6457' };
    }
    atomicWrite(JSON.stringify(evidence));
    t.after(() => atomicWrite(original));
    const { pi, ctx } = nativeContext();
    const report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
    assert.equal(report.environmentEvidence.status, 'unverified');
    assert.equal(report.environmentEvidence.reason, 'NO_MATCH');
    assert.equal(report.hostSupportPolicy, 'formal');
    assert.equal(report.requiredContracts.ready, true);
    assert.equal(report.observedWindows.build, '19045.6456');
    assert.equal(report.environmentEvidence.measuredWindows[0].build, '19045.6457');
  });

test('invalid Windows selectors never become declared Pi scalar measurements',
  { skip: process.platform !== 'win32' || !installation }, t => {
    const original = fs.readFileSync(evidenceFile);
    t.after(() => atomicWrite(original));
    const valid = { osRelease: '10.0.19045', productName: 'Windows 10 Home', displayVersion: '22H2', build: '19045.6456' };
    const cases = [
      { ...valid, osRelease: ['10.0.19045'], build: ['19045.6456'] },
      { ...valid, osRelease: `${'9'.repeat(100_000)}.0.19045` },
      { ...valid, osRelease: '4294967296.0.19045' },
      { ...valid, build: '19045.4294967296' },
      { ...valid, build: '19045' },
      { ...valid, productName: '' },
      { ...valid, displayVersion: null },
    ];
    for (const windows of cases) {
      const evidence = JSON.parse(original);
      for (const row of evidence.rows.filter(row => row.platform === 'win32')) row.windows = windows;
      atomicWrite(JSON.stringify(evidence));
      const { pi, ctx } = nativeContext();
      const report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
      assert.equal(report.environmentEvidence.status, 'unverified');
      assert.deepEqual(report.environmentEvidence.measuredWindows, []);
      assert.equal(report.hostSupportPolicy, 'formal');
      assert.equal(report.requiredContracts.ready, true);
    }
  });

test('historical Windows rows without a full measured selector never act as Pi wildcard evidence',
  { skip: process.platform !== 'win32' || !installation }, t => {
    const original = fs.readFileSync(evidenceFile);
    const evidence = JSON.parse(original);
    for (const row of evidence.rows) delete row.windows;
    atomicWrite(JSON.stringify(evidence));
    t.after(() => atomicWrite(original));
    const { pi, ctx } = nativeContext();
    const report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
    assert.equal(report.environmentEvidence.status, 'unverified');
    assert.equal(report.environmentEvidence.reason, 'NO_MATCH');
    assert.deepEqual(report.environmentEvidence.measuredWindows, []);
    assert.equal(report.requiredContracts.ready, true);
  });

test('mutating a previous Pi diagnostic cannot alter the next observed Windows or evidence match',
  { skip: process.platform !== 'win32' || !installation }, () => {
    const { pi, ctx } = nativeContext();
    const before = adapter.inspectPiCompatibility(pi, ctx, 'verified');
    const observed = structuredClone(before.observedWindows);
    before.observedWindows.build = '19045.6457';
    before.observedWindows.status = 'unavailable';
    before.environmentEvidence.measuredWindows[0].build = '19045.6457';
    const after = adapter.inspectPiCompatibility(pi, ctx, 'verified');
    assert.deepEqual(after.observedWindows, observed);
    assert.equal(after.environmentEvidence.status, 'verified');
    assert.equal(after.environmentEvidence.measuredWindows[0].build, '19045.6456');
    assert.equal(after.requiredContracts.ready, true);
  });

test('unavailable Windows observation in a fresh installed Pi process leaves formal contracts ready',
  { skip: process.platform !== 'win32' || !installation }, () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    env.PATH = path.dirname(process.execPath);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./windows-observation-unavailable.mjs', import.meta.url)),
      'pi', process.env.ARLO_PI_INSTALL_REPORT], { cwd: installation.consumer, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).observedWindows.status, 'unavailable');
  });

test('unavailable packaged evidence is an evidence gap rather than a mandatory capability failure', t => {
  const original = fs.readFileSync(evidenceFile);
  atomicWrite('{invalid metadata');
  t.after(() => atomicWrite(original));
  const { pi, ctx } = nativeContext();
  const report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
  assert.equal(report.environmentEvidence.reason, 'EVIDENCE_UNAVAILABLE');
  assert.equal(report.environmentEvidence.status, 'unverified');
  assert.equal(report.requiredContracts.ready, true);
  assert.equal(report.hostSupportPolicy, 'formal');
});

test('Pi diagnosis retains the declared behavior evidence scope separately from current artifact identity', t => {
  const original = fs.readFileSync(evidenceFile);
  const evidence = JSON.parse(original);
  evidence.scope = 'Historical native evidence; current artifact identity is recorded separately.';
  atomicWrite(JSON.stringify(evidence));
  t.after(() => atomicWrite(original));
  const { pi, ctx } = nativeContext();
  const report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
  assert.equal(report.environmentEvidence.scope, 'Historical native evidence; current artifact identity is recorded separately.');
  assert.equal(report.requiredContracts.ready, true);
});

test('measured environment evidence does not override a missing required handoff capability', () => {
  const { pi, ctx } = nativeContext();
  delete pi.sendMessage;
  const report = adapter.inspectPiCompatibility(pi, ctx, 'experimental');
  assert.equal(report.environmentEvidence.status, hostVersion === '1.1.0' ? 'failed' : 'verified');
  assert.equal(report.requiredContracts.ready, false);
  assert.equal(report.requiredContracts.reason, 'MISSING_PI_CAPABILITY');
  assert.deepEqual(report.missing, ['pi.sendMessage']);
  assert.equal(report.policy, 'experimental');
});

test('a different installed Pi family cannot borrow the measured environment record', t => {
  const original = fs.readFileSync(evidenceFile);
  const evidence = JSON.parse(original);
  for (const row of evidence.rows) row.packages['@earendil-works/pi-tui'] = '0.0.0';
  atomicWrite(JSON.stringify(evidence));
  t.after(() => atomicWrite(original));
  const { pi, ctx } = nativeContext();
  const report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
  assert.equal(report.environmentEvidence.reason, 'INSTALLATION_IDENTITY_MISMATCH');
  assert.equal(report.environmentEvidence.status, 'unverified');
  assert.equal(report.requiredContracts.ready, true);
});

test('another adapter artifact cannot borrow packaged environment evidence', t => {
  const original = fs.readFileSync(evidenceFile);
  const evidence = JSON.parse(original);
  evidence.adapter.version = '0.0.0';
  atomicWrite(JSON.stringify(evidence));
  t.after(() => atomicWrite(original));
  const { pi, ctx } = nativeContext();
  const report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
  assert.equal(report.environmentEvidence.reason, 'INSTALLATION_IDENTITY_MISMATCH');
  assert.equal(report.environmentEvidence.status, 'unverified');
  assert.equal(report.requiredContracts.ready, true);
});

test('unavailable Pi adapter identity is reported without crashing diagnosis or changing mandatory readiness', t => {
  const manifest = new URL('../package.json', adapterUrl);
  const saved = new URL('../package.arlo-identity-test.json', adapterUrl);
  fs.renameSync(manifest, saved);
  t.after(() => fs.renameSync(saved, manifest));
  const { pi, ctx } = nativeContext();
  const report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
  assert.equal(report.installation.adapter, null);
  assert.equal(report.installation.binding, 'unavailable');
  assert.equal(report.environmentEvidence.status, 'unverified');
  assert.equal(report.environmentEvidence.reason, 'INSTALLATION_IDENTITY_MISMATCH');
  assert.equal(report.requiredContracts.ready, true);
  assert.equal(report.requiredContracts.reason, 'SATISFIED');
});

test('installed adapter bytes must match the evidence binding', { skip: !installation }, t => {
  const declaration = new URL('./environment.d.ts', adapterUrl);
  const temporary = new URL('./environment.test-replacement.d.ts', adapterUrl);
  const original = fs.readFileSync(declaration);
  const replace = content => {
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, declaration);
  };
  replace(Buffer.concat([original, Buffer.from('\n// altered installed artifact\n')]));
  t.after(() => replace(original));
  const { pi, ctx } = nativeContext();
  const report = adapter.inspectPiCompatibility(pi, ctx, 'verified');
  assert.equal(report.environmentEvidence.reason, 'INSTALLATION_IDENTITY_MISMATCH');
  assert.equal(report.environmentEvidence.status, 'unverified');
  assert.equal(report.requiredContracts.ready, true);
});
