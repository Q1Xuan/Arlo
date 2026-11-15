import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const consumer = process.env.ARLO_DSH_COMPOSITION_CONSUMER;
const installed = process.env.ARLO_DSH_ENVIRONMENT_INSTALLED === '1';
const delivery = consumer && await (async () => {
  if (!installed) return import('../packages/adapter-dsh/delivery/index.mjs');
  const require = createRequire(path.join(path.resolve(consumer), 'package.json'));
  return import(pathToFileURL(require.resolve('@arlo/adapter-dsh/delivery')).href);
})();

test('DSH diagnostics separately identify formal composition, actual environment and mandatory readiness',
  { skip: !consumer }, () => {
    const report = delivery.inspectDshWebComposition(consumer);
    assert.equal(report.hostSupportPolicy, 'formal');
    assert.deepEqual(report.runtime, { platform: process.platform, arch: process.arch, node: process.versions.node });
    assert.equal(report.requiredContracts.ready, true);
    assert.equal(report.requiredContracts.reason, 'SATISFIED');
    assert.equal(report.ready, true);
    if (installed) {
      assert.equal(report.environmentEvidence.status, 'verified');
      assert.equal(report.installation.binding, 'bound');
      assert.match(report.installation.adapter.artifactSha256, /^[a-f0-9]{64}$/);
      assert.ok(report.environmentEvidence.testedCapabilities.length > 0);
      assert.ok(report.environmentEvidence.limitations.length > 0);
      if (process.platform === 'win32') {
        assert.deepEqual(report.observedWindows, { status: 'observed', source: 'windows-registry',
          osRelease: '10.0.19045', productName: 'Windows 10 Home', displayVersion: '22H2', build: '19045.6456' });
        assert.deepEqual(report.environmentEvidence.measuredWindows, [{ osRelease: '10.0.19045',
          productName: 'Windows 10 Home', displayVersion: '22H2', build: '19045.6456' }]);
      } else assert.equal(report.observedWindows, undefined);
    }
  });

const adapterRequire = consumer && createRequire(path.join(path.resolve(consumer), 'package.json'));
const adapterDirectory = consumer && path.dirname(adapterRequire.resolve('@arlo/adapter-dsh'));
const evidenceFile = consumer && path.join(adapterDirectory, 'delivery/environment-evidence.json');

// Atomic replacement exercises the filesystem boundary without modifying a
// shared pnpm store inode. Use a new owned installation, never concurrent tests.
function withFile(file, transform, check) {
  const original = fs.readFileSync(file);
  const temporary = `${file}.arlo-environment-test`;
  const replace = bytes => { fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, file); };
  try {
    if (transform === null) fs.unlinkSync(file);
    else replace(transform(original));
    check();
  } finally { replace(original); }
}

test('a measured Windows release cannot lend evidence to another release under formal DSH readiness',
  { skip: !consumer || !installed || process.platform !== 'win32' }, () => {
    withFile(evidenceFile, bytes => {
      const data = JSON.parse(bytes);
      for (const row of data.rows.filter(row => row.platform === 'win32')) {
        row.windows = { osRelease: '10.0.22631', productName: 'Windows 11 Home',
          displayVersion: '23H2', build: '22631.6456' };
      }
      return JSON.stringify(data);
    }, () => {
      const report = delivery.requireDshWebComposition(consumer);
      assert.equal(report.environmentEvidence.status, 'unverified');
      assert.equal(report.environmentEvidence.reason, 'NO_MATCH');
      assert.equal(report.hostSupportPolicy, 'formal');
      assert.equal(report.requiredContracts.ready, true);
      assert.equal(report.ready, true);
    });
  });

test('a different Windows servicing revision cannot borrow DSH evidence or block formal readiness',
  { skip: !consumer || !installed || process.platform !== 'win32' }, () => {
    withFile(evidenceFile, bytes => {
      const data = JSON.parse(bytes);
      for (const row of data.rows.filter(row => row.platform === 'win32')) {
        row.windows = { osRelease: '10.0.19045', productName: 'Windows 10 Home',
          displayVersion: '22H2', build: '19045.6457' };
      }
      return JSON.stringify(data);
    }, () => {
      const report = delivery.requireDshWebComposition(consumer);
      assert.equal(report.environmentEvidence.status, 'unverified');
      assert.equal(report.environmentEvidence.reason, 'NO_MATCH');
      assert.equal(report.hostSupportPolicy, 'formal');
      assert.equal(report.requiredContracts.ready, true);
      assert.equal(report.ready, true);
      assert.equal(report.observedWindows.build, '19045.6456');
      assert.equal(report.environmentEvidence.measuredWindows[0].build, '19045.6457');
    });
  });

test('invalid Windows selectors never become declared DSH scalar measurements',
  { skip: !consumer || !installed || process.platform !== 'win32' }, () => {
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
      withFile(evidenceFile, bytes => {
        const data = JSON.parse(bytes);
        for (const row of data.rows.filter(row => row.platform === 'win32')) row.windows = windows;
        return JSON.stringify(data);
      }, () => {
        const report = delivery.requireDshWebComposition(consumer);
        assert.equal(report.environmentEvidence.status, 'unverified');
        assert.deepEqual(report.environmentEvidence.measuredWindows, []);
        assert.equal(report.hostSupportPolicy, 'formal');
        assert.equal(report.requiredContracts.ready, true);
      });
    }
  });

test('historical Windows rows without a full measured selector never act as DSH wildcard evidence',
  { skip: !consumer || !installed || process.platform !== 'win32' }, () => {
    withFile(evidenceFile, bytes => {
      const data = JSON.parse(bytes);
      for (const row of data.rows) delete row.windows;
      return JSON.stringify(data);
    }, () => {
      const report = delivery.requireDshWebComposition(consumer);
      assert.equal(report.environmentEvidence.status, 'unverified');
      assert.equal(report.environmentEvidence.reason, 'NO_MATCH');
      assert.deepEqual(report.environmentEvidence.measuredWindows, []);
      assert.equal(report.requiredContracts.ready, true);
    });
  });

test('mutating a previous DSH diagnostic cannot alter the next observed Windows or evidence match',
  { skip: !consumer || !installed || process.platform !== 'win32' }, () => {
    const before = delivery.requireDshWebComposition(consumer);
    const observed = structuredClone(before.observedWindows);
    before.observedWindows.build = '19045.6457';
    before.observedWindows.status = 'unavailable';
    before.environmentEvidence.measuredWindows[0].build = '19045.6457';
    const after = delivery.requireDshWebComposition(consumer);
    assert.deepEqual(after.observedWindows, observed);
    assert.equal(after.environmentEvidence.status, 'verified');
    assert.equal(after.environmentEvidence.measuredWindows[0].build, '19045.6456');
    assert.equal(after.requiredContracts.ready, true);
  });

test('unavailable Windows observation in a fresh installed DSH process leaves formal contracts ready',
  { skip: !consumer || !installed || process.platform !== 'win32' }, () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    env.PATH = path.dirname(process.execPath);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./windows-observation-unavailable.mjs', import.meta.url)),
      'dsh', consumer], { cwd: consumer, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).observedWindows.status, 'unavailable');
  });

test('formal DSH can run in an environment without matched behavior evidence',
  { skip: !consumer || !installed }, () => {
    withFile(evidenceFile, bytes => {
      const data = JSON.parse(bytes);
      for (const row of data.rows) row.node = '99.0.0';
      return JSON.stringify(data);
    }, () => {
      const report = delivery.requireDshWebComposition(consumer);
      assert.equal(report.hostSupportPolicy, 'formal');
      assert.equal(report.requiredContracts.ready, true);
      assert.equal(report.runtime.node, process.versions.node);
      assert.equal(report.environmentEvidence.status, 'unverified');
      assert.equal(report.environmentEvidence.reason, 'NO_MATCH');
      assert.match(report.environmentEvidence.limitations.join(' '), /当前环境尚未验证/);
    });
  });

test('unavailable DSH evidence does not become a missing mandatory capability',
  { skip: !consumer || !installed }, () => {
    withFile(evidenceFile, null, () => {
      const report = delivery.requireDshWebComposition(consumer);
      assert.equal(report.hostSupportPolicy, 'formal');
      assert.equal(report.requiredContracts.ready, true);
      assert.equal(report.environmentEvidence.reason, 'EVIDENCE_UNAVAILABLE');
      assert.equal(report.environmentEvidence.status, 'unverified');
    });
  });

test('malformed DSH evidence remains an explicit unverified report',
  { skip: !consumer || !installed }, () => {
    withFile(evidenceFile, bytes => JSON.stringify({ ...JSON.parse(bytes), schemaVersion: 99 }), () => {
      const report = delivery.requireDshWebComposition(consumer);
      assert.equal(report.requiredContracts.ready, true);
      assert.equal(report.environmentEvidence.reason, 'EVIDENCE_UNAVAILABLE');
    });
  });

test('explicit DSH experimental selection remains separate from actual formal profile evidence',
  { skip: !consumer || !installed }, () => {
    const report = delivery.requireDshWebComposition(consumer, { experimental: true });
    assert.equal(report.mode, 'experimental');
    assert.equal(report.formallySupported, false);
    assert.equal(report.hostSupportPolicy, 'formal');
    assert.equal(report.environmentEvidence.status, 'verified');
  });

test('another DSH profile cannot lend environment evidence to the same top-level host version',
  { skip: !consumer || !installed }, () => {
    withFile(evidenceFile, bytes => {
      const data = JSON.parse(bytes);
      for (const row of data.rows) row.compositionSha256 = '0'.repeat(64);
      return JSON.stringify(data);
    }, () => {
      const report = delivery.requireDshWebComposition(consumer);
      assert.equal(report.hostSupportPolicy, 'formal');
      assert.equal(report.environmentEvidence.status, 'unverified');
      assert.equal(report.environmentEvidence.reason, 'INSTALLATION_IDENTITY_MISMATCH');
    });
  });

test('DSH resource corruption rejects readiness and cannot borrow verified environment evidence',
  { skip: !consumer || !installed }, () => {
    const hostRequire = createRequire(adapterRequire.resolve('@deepseek-ai/dsh/package.json'));
    const file = path.join(path.dirname(hostRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist/index.html');
    withFile(file, bytes => `${bytes}\n`, () => {
      const report = delivery.inspectDshWebComposition(consumer);
      assert.equal(report.ready, false);
      assert.equal(report.requiredContracts.ready, false);
      assert.equal(report.requiredContracts.reason, 'DSH_RESOURCE_MISMATCH');
      assert.equal(report.environmentEvidence.status, 'unverified');
      assert.throws(() => delivery.requireDshWebComposition(consumer), { code: 'DSH_RESOURCE_MISMATCH' });
    });
  });

test('missing DSH mandatory contract preserves its fixed rejection reason',
  { skip: !consumer || !installed }, () => {
    const hostRequire = createRequire(adapterRequire.resolve('@deepseek-ai/dsh/package.json'));
    const file = path.join(path.dirname(hostRequire.resolve('@deepseek-ai/dsh-api-session-controller/package.json')), 'lib/types/types.d.ts');
    withFile(file, bytes => bytes.toString().replace('interface SessionCreateOptions', 'interface MissingCreateOptions'), () => {
      const report = delivery.inspectDshWebComposition(consumer);
      assert.equal(report.requiredContracts.ready, false);
      assert.equal(report.requiredContracts.reason, 'DSH_REQUIRED_CONTRACT_MISSING');
      assert.equal(report.environmentEvidence.status, 'unverified');
      assert.throws(() => delivery.requireDshWebComposition(consumer), { code: 'DSH_REQUIRED_CONTRACT_MISSING' });
    });
  });

test('DSH evidence must match the actual installed adapter artifact',
  { skip: !consumer || !installed }, () => {
    withFile(path.join(adapterDirectory, 'host.mjs'), bytes => `${bytes}\n`, () => {
      const report = delivery.inspectDshWebComposition(consumer);
      assert.equal(report.requiredContracts.ready, false);
      assert.equal(report.requiredContracts.reason, 'DSH_ADAPTER_CONTRACT_MISMATCH');
      assert.equal(report.environmentEvidence.status, 'unverified');
      assert.equal(report.environmentEvidence.reason, 'INSTALLATION_IDENTITY_MISMATCH');
    });
  });

test('a missing DSH adapter entry has no invented installation identity',
  { skip: !consumer || !installed }, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-dsh-missing-adapter-'));
    try {
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'diagnostic-consumer', version: '1.0.0' }));
      const report = delivery.inspectDshWebComposition(directory);
      assert.equal(report.requiredContracts.ready, false);
      assert.equal(report.installation.adapter, null);
      assert.equal(report.environmentEvidence.status, 'unverified');
    } finally { fs.rmSync(directory, { recursive: true }); }
  });

test('the packaged DSH diagnostic command runs without a source workspace',
  { skip: !consumer || !installed }, () => {
    const require = createRequire(path.join(path.resolve(consumer), 'package.json'));
    const command = path.join(path.dirname(require.resolve('@arlo/adapter-dsh/delivery')), 'diagnose.mjs');
    const result = spawnSync(process.execPath, [command, 'diagnose', '--consumer', consumer],
      { cwd: consumer, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.hostSupportPolicy, 'formal');
    assert.equal(report.environmentEvidence.status, 'verified');
    assert.equal(report.requiredContracts.ready, true);
    assert.equal(report.arch, process.arch);
  });

test('the complete DSH dependency closure cannot borrow a reviewed environment or policy',
  { skip: !consumer || !installed }, () => {
    const hostRequire = createRequire(adapterRequire.resolve('@deepseek-ai/dsh/package.json'));
    const name = '@deepseek-ai/dsh-session-persistence';
    const file = hostRequire.resolve(`${name}/package.json`);
    const lockFile = path.join(consumer, 'pnpm-lock.yaml');
    const version = JSON.parse(fs.readFileSync(file)).version;
    // This package was outside the previous 29-package contract inventory.
    withFile(file, bytes => JSON.stringify({ ...JSON.parse(bytes), version: '0.2.99' }), () => {
      const mismatch = delivery.inspectDshWebComposition(consumer);
      assert.equal(mismatch.requiredContracts.ready, false);
      assert.equal(mismatch.requiredContracts.reason, 'DSH_DEPENDENCY_IDENTITY_MISMATCH');
      assert.equal(mismatch.environmentEvidence.status, 'unverified');
      assert.throws(() => delivery.requireDshWebComposition(consumer, { experimental: true }),
        { code: 'DSH_DEPENDENCY_IDENTITY_MISMATCH' });

      const yaml = hostRequire('js-yaml');
      withFile(lockFile, bytes => {
        const rewrite = (value, key = '') => {
          if (Array.isArray(value)) return value.map(item => rewrite(item));
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
            .map(([field, item]) => [field.replaceAll(`${name}@${version}`, `${name}@0.2.99`), rewrite(item, key === name ? name : field)]));
          if (typeof value !== 'string') return value;
          if ((key === name || key === `${name}@${version}`) && value.startsWith(version)) {
            return `0.2.99${value.slice(version.length)}`.replaceAll(`${name}@${version}`, `${name}@0.2.99`);
          }
          return value.replaceAll(`${name}@${version}`, `${name}@0.2.99`);
        };
        return yaml.dump(rewrite(yaml.load(bytes.toString())));
      }, () => {
        assert.throws(() => delivery.requireDshWebComposition(consumer), { code: 'DSH_EXPERIMENTAL_REQUIRED' });
        const report = delivery.requireDshWebComposition(consumer, { experimental: true });
        assert.equal(report.requiredContracts.ready, true);
        assert.equal(report.hostSupportPolicy, 'experimental-required');
        assert.equal(report.environmentEvidence.status, 'unverified');
        assert.equal(report.environmentEvidence.reason, 'INSTALLATION_IDENTITY_MISMATCH');
      });
    });
  });

test('public resolution integrity and physical peer wiring remain part of the DSH composition',
  { skip: !consumer || !installed }, () => {
    const hostRequire = createRequire(adapterRequire.resolve('@deepseek-ai/dsh/package.json'));
    const yaml = hostRequire('js-yaml');
    const name = '@deepseek-ai/dsh-session-persistence';
    const lockFile = path.join(consumer, 'pnpm-lock.yaml');
    withFile(lockFile, bytes => {
      const lock = yaml.load(bytes.toString());
      const key = Object.keys(lock.packages).find(key => key.startsWith(`${name}@`));
      lock.packages[key].resolution.integrity = 'sha512-unreviewed-resolution';
      return yaml.dump(lock);
    }, () => {
      assert.throws(() => delivery.requireDshWebComposition(consumer), { code: 'DSH_EXPERIMENTAL_REQUIRED' });
      assert.equal(delivery.requireDshWebComposition(consumer, { experimental: true }).environmentEvidence.status, 'unverified');
    });
    const dependencyRequire = createRequire(hostRequire.resolve(`${name}/package.json`));
    const peer = '@deepseek-ai/dsh-brand';
    const lookup = dependencyRequire.resolve.paths(peer).find(directory => fs.existsSync(path.join(directory, peer, 'package.json')));
    const link = path.join(lookup, peer);
    const saved = `${link}.arlo-peer-test`;
    const replacement = path.join(consumer, 'node_modules', '.arlo-peer-test');
    fs.mkdirSync(replacement);
    const manifest = JSON.parse(fs.readFileSync(dependencyRequire.resolve(`${peer}/package.json`)));
    fs.writeFileSync(path.join(replacement, 'package.json'), JSON.stringify({ ...manifest, version: '0.2.99' }));
    fs.renameSync(link, saved);
    try {
      fs.symlinkSync(replacement, link, process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => delivery.requireDshWebComposition(consumer, { experimental: true }),
        { code: 'DSH_DEPENDENCY_IDENTITY_MISMATCH' });
    } finally { fs.unlinkSync(link); fs.renameSync(saved, link); fs.rmSync(replacement, { recursive: true }); }
  });

test('private archive locations and absent consumer acceptance tools do not gate DSH runtime',
  { skip: !consumer || !installed }, () => {
    const hostRequire = createRequire(adapterRequire.resolve('@deepseek-ai/dsh/package.json'));
    const yaml = hostRequire('js-yaml');
    withFile(path.join(consumer, 'pnpm-lock.yaml'), bytes => {
      const rewrite = value => {
        if (Array.isArray(value)) return value.map(rewrite);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
          .map(([key, item]) => [key.replaceAll('file:../arlo-', 'file:/another-install/arlo-'), rewrite(item)]));
        return typeof value === 'string' ? value.replaceAll('file:../arlo-', 'file:/another-install/arlo-') : value;
      };
      return yaml.dump(rewrite(yaml.load(bytes.toString())));
    }, () => {
      const report = delivery.requireDshWebComposition(consumer);
      assert.equal(report.hostSupportPolicy, 'formal');
      assert.equal(report.environmentEvidence.status, 'verified');
    });
    const tools = ['playwright', 'typescript'];
    const saved = tools.map(name => [path.join(consumer, 'node_modules', name), path.join(consumer, 'node_modules', `${name}.arlo-tool-test`)]);
    for (const [file, backup] of saved) fs.renameSync(file, backup);
    try {
      const report = delivery.requireDshWebComposition(consumer);
      assert.equal(report.requiredContracts.ready, true);
      assert.equal(report.environmentEvidence.status, 'verified');
    } finally { for (const [file, backup] of saved) fs.renameSync(backup, file); }
  });

test('an uninspected dependency cannot change executable routing under a reviewed lock',
  { skip: !consumer || !installed }, () => {
    const hostRequire = createRequire(adapterRequire.resolve('@deepseek-ai/dsh/package.json'));
    const file = hostRequire.resolve('@deepseek-ai/dsh-session-persistence/package.json');
    withFile(file, bytes => JSON.stringify({ ...JSON.parse(bytes), main: './unreviewed-entry.js' }), () => {
      const report = delivery.inspectDshWebComposition(consumer);
      assert.equal(report.requiredContracts.ready, false);
      assert.equal(report.requiredContracts.reason, 'DSH_DEPENDENCY_IDENTITY_MISMATCH');
      assert.equal(report.environmentEvidence.status, 'unverified');
      assert.throws(() => delivery.requireDshWebComposition(consumer, { experimental: true }),
        { code: 'DSH_DEPENDENCY_IDENTITY_MISMATCH' });
    });
  });

test('conditional export order cannot change a DSH runtime dependency under a reviewed lock',
  { skip: !consumer || !installed }, () => {
    const hostRequire = createRequire(adapterRequire.resolve('@deepseek-ai/dsh/package.json'));
    const dependencyRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-credentials-local/package.json'));
    const file = dependencyRequire.resolve('yaml/package.json');
    withFile(file, bytes => {
      const manifest = JSON.parse(bytes);
      const conditions = manifest.exports['.'];
      assert.equal(conditions.node, './dist/index.js');
      assert.equal(conditions.default, './browser/index.js');
      manifest.exports['.'] = { default: conditions.default, ...Object.fromEntries(Object.entries(conditions)
        .filter(([condition]) => condition !== 'default')) };
      return JSON.stringify(manifest);
    }, () => {
      const report = delivery.inspectDshWebComposition(consumer);
      assert.equal(report.requiredContracts.ready, false);
      assert.equal(report.requiredContracts.reason, 'DSH_DEPENDENCY_IDENTITY_MISMATCH');
      assert.equal(report.environmentEvidence.status, 'unverified');
      assert.throws(() => delivery.requireDshWebComposition(consumer, { experimental: true }),
        { code: 'DSH_DEPENDENCY_IDENTITY_MISMATCH' });
    });
  });
