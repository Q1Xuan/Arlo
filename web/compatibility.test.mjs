import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const args = process.argv.slice(2);
const candidate = args.includes('--experimental');
assert.ok(args.length === (candidate ? 3 : 2) && args[0] === '--consumer',
  'Usage: node web/compatibility.test.mjs --consumer REVIEWED_PRIVATE_CONSUMER');
const source = fs.realpathSync(path.resolve(args[1]));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-dsh-composition-test-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
// Copy the complete installed bundle, retaining pnpm's physical wiring.
// Faults affect only this test-owned copy, never the original or the pnpm store.
const bundle = path.join(temporary, 'bundle');
const sourceBundle = path.dirname(source);
fs.cpSync(sourceBundle, bundle, {
  recursive: true, mode: fs.constants.COPYFILE_FICLONE,
  // Recreate junctions explicitly to preserve the installed dependency wiring.
  filter: file => !fs.lstatSync(file).isSymbolicLink(),
});
function copyLinks(directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    const entry = fs.lstatSync(file);
    if (entry.isSymbolicLink()) {
      const resolved = fs.realpathSync(file);
      const relative = path.relative(sourceBundle, resolved);
      assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        'Installed runtime links must stay inside the copied bundle');
      const copied = path.join(bundle, path.relative(sourceBundle, file));
      fs.symlinkSync(path.join(bundle, relative), copied, process.platform === 'win32'
        ? fs.statSync(file).isDirectory() ? 'junction' : 'file' : undefined);
    } else if (entry.isDirectory()) copyLinks(file);
  }
}
copyLinks(sourceBundle);
const consumer = path.join(bundle, path.basename(source));
const require = createRequire(path.join(consumer, 'package.json'));
const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const { inspectDshWebComposition, requireDshWebComposition } = await import(
  pathToFileURL(require.resolve('@arlo/adapter-dsh/delivery')).href);
const packageFile = (name, file) => path.join(path.dirname(hostRequire.resolve(`${name}/package.json`)), file);
const options = { experimental: candidate };
const selectedHostVersion = JSON.parse(fs.readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version;
const baseline = requireDshWebComposition(consumer, options);
const frontendDirectory = packageFile('@deepseek-ai/dsh-web-frontend', 'dist');
assert.ok(fs.realpathSync(frontendDirectory).startsWith(bundle + path.sep));

function changedFile(file, change, observe) {
  assert.ok(fs.realpathSync(path.dirname(file)).startsWith(bundle + path.sep));
  const exists = fs.existsSync(file);
  const original = exists ? fs.readFileSync(file, 'utf8') : '';
  const replacement = change(original);
  assert.notEqual(replacement, original, 'The fault must alter installed bytes');
  // Keep backups outside the probed resource tree, so a byte-change test
  // cannot pass merely because it introduced an additional resource file.
  const backupDirectory = fs.mkdtempSync(path.join(temporary, 'backup-'));
  const backup = path.join(backupDirectory, 'original');
  if (exists) fs.renameSync(file, backup);
  try {
    fs.writeFileSync(file, replacement);
    observe();
  } finally {
    fs.rmSync(file);
    if (exists) fs.renameSync(backup, file);
    fs.rmSync(backupDirectory, { recursive: true });
  }
}

function refuses(code) {
  const report = inspectDshWebComposition(consumer, options);
  assert.equal(report.ready, false);
  assert.equal(report.formallySupported, false);
  assert.equal(report.reason, code);
  assert.notEqual(report.combination, baseline.combination);
  assert.throws(() => requireDshWebComposition(consumer, options), error => error.code === code);
  const ordinary = inspectDshWebComposition(consumer);
  assert.equal(ordinary.ready, false, 'Ordinary entry must retain the same integrity guard');
  assert.equal(ordinary.reason, code, 'Required contract failures stay actionable before host policy');
  const experimental = inspectDshWebComposition(consumer, { experimental: true });
  assert.equal(experimental.ready, false, 'Experimental entry must retain the same integrity guard');
  assert.equal(experimental.reason, code);
}

test('reviewed installed composition opens formally; explicit experiment stays experimental', () => {
  assert.equal(baseline.hostVersion, selectedHostVersion);
  assert.ok(['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.5'].includes(selectedHostVersion));
  assert.equal(baseline.formallySupported, !candidate);
  if (selectedHostVersion === '0.2.1-rc.5') {
    const defaultReport = inspectDshWebComposition(consumer);
    assert.equal(defaultReport.ready, true, 'Default entry admits the measured complete rc.5 profile');
    assert.equal(defaultReport.formallySupported, true);
    assert.equal(defaultReport.hostSupportPolicy, 'formal');
    assert.equal(defaultReport.reason, 'DSH_REVIEWED_COMBINATION');
  }
  const experimental = requireDshWebComposition(consumer, { experimental: true });
  assert.equal(experimental.status, 'experimental');
  assert.equal(experimental.formallySupported, false);
});

test('changed HTML execution mode rejects the otherwise unchanged main seed', () => {
  changedFile(path.join(frontendDirectory, 'index.html'),
    html => html.replace('type="module"', 'type="application/json"'), () => refuses('DSH_RESOURCE_MISMATCH'));
});

test('changed secondary JavaScript rejects the otherwise unchanged main seed', () => {
  const secondary = fs.readdirSync(frontendDirectory, { recursive: true })
    .find(file => file.endsWith('.js') && `/${file.split(path.sep).join('/')}` !== baseline.frontend.asset);
  assert.ok(secondary, 'The reviewed installation includes secondary browser scripts');
  changedFile(path.join(frontendDirectory, secondary), source => `${source}\n/* changed resource */\n`,
    () => refuses('DSH_RESOURCE_MISMATCH'));
});

test('additional unreviewed browser resource rejects admission', () => {
  changedFile(path.join(frontendDirectory, 'assets/unreviewed.js'), () => 'throw new Error("unreviewed");',
    () => refuses('DSH_RESOURCE_MISMATCH'));
});

test('redirected Host and adapter entries reject even when both resolve the same module', () => {
  changedFile(packageFile('@deepseek-ai/dsh-agent', 'lib/unreviewed.js'), () => "export * from './index.js';\n", () => {
    changedFile(hostRequire.resolve('@deepseek-ai/dsh-agent/package.json'), text => {
      const manifest = JSON.parse(text);
      manifest.exports['.'].default = './lib/unreviewed.js';
      return JSON.stringify(manifest);
    }, () => {
      // Resolve in a fresh process so Node's manifest cache cannot retain the
      // baseline entry from the preceding tests.
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import { createRequire } from 'node:module';
        const consumerRequire = createRequire(path.join(process.argv[1], 'package.json'));
        const hostRequire = createRequire(consumerRequire.resolve('@deepseek-ai/dsh/package.json'));
        const adapterRequire = createRequire(consumerRequire.resolve('@arlo/adapter-dsh'));
        const entry = fs.realpathSync(hostRequire.resolve('@deepseek-ai/dsh-agent'));
        assert.equal(path.basename(entry), 'unreviewed.js');
        assert.equal(entry, fs.realpathSync(adapterRequire.resolve('@deepseek-ai/dsh-agent')));
      `, consumer], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      refuses('DSH_ENTRY_MISMATCH');
    });
  });
});

test('missing declared patch rejects patched runtime files that remain intact', () => {
  changedFile(path.join(consumer, 'package.json'), text => {
    const manifest = JSON.parse(text);
    delete manifest.pnpm.patchedDependencies[Object.keys(manifest.pnpm.patchedDependencies)[0]];
    return JSON.stringify(manifest);
  }, () => refuses('DSH_PATCH_MISMATCH'));
});

test('missing public creation contract rejects before endpoint readiness', () => {
  changedFile(packageFile('@deepseek-ai/dsh-api-session-controller', 'lib/types/types.d.ts'),
    text => text.replace('interface SessionCreateOptions', 'interface MissingCreateOptions'),
    () => refuses('DSH_REQUIRED_CONTRACT_MISSING'));
});

if (candidate) {
  test('unlisted Host releases retain rejection under explicit experimental selection', () => {
    for (const version of ['0.2.1-rc.4', '__proto__']) {
      changedFile(hostRequire.resolve('@deepseek-ai/dsh/package.json'), source => {
        const manifest = JSON.parse(source);
        manifest.version = version;
        return JSON.stringify(manifest);
      }, () => {
        for (const experimental of [false, true]) {
          const report = inspectDshWebComposition(consumer, { experimental });
          assert.equal(report.ready, false);
          assert.equal(report.formallySupported, false);
          assert.equal(report.status, 'rejected');
          assert.throws(() => requireDshWebComposition(consumer, { experimental }),
            error => error.code === report.reason && error.report.ready === false);
        }
      });
    }
  });
  test('changed candidate browser entry rejects before registration', () => {
    changedFile(require.resolve('@arlo/adapter-dsh/client'), source => `${source}\n/* altered client */\n`,
      () => refuses('DSH_ADAPTER_CONTRACT_MISMATCH'));
  });
  test('missing or changed candidate runtime declarations reject before registration', () => {
    const directory = path.dirname(require.resolve('@arlo/adapter-dsh'));
    for (const file of ['src/runtime.d.ts', 'src/reception.d.ts']) {
      const target = path.join(directory, file);
      changedFile(target, source => `${source}\n/* altered declaration */\n`, () => {
        refuses('DSH_ADAPTER_CONTRACT_MISMATCH');
        const altered = fs.readFileSync(target);
        fs.rmSync(target);
        try { refuses('DSH_ADAPTER_CONTRACT_MISMATCH'); }
        finally { fs.writeFileSync(target, altered); }
      });
    }
  });
  test('mixed candidate Host version rejects explicit experimental admission', () => {
    changedFile(hostRequire.resolve('@deepseek-ai/dsh-agent/package.json'), source => {
      const manifest = JSON.parse(source);
      manifest.version = '0.2.0-rc.2';
      return JSON.stringify(manifest);
    }, () => refuses('DSH_PACKAGE_MISMATCH'));
  });
}

if (!candidate) {
  test('changed installed application icon route rejects admission', () => {
    changedFile(packageFile('@deepseek-ai/dsh-host-open-in-app', 'lib/index.js'),
      source => `${source}\n/* altered icon route */\n`, () => refuses('DSH_CONTRACT_MISMATCH'));
  });
}
