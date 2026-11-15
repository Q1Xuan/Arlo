import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { inspectDshWebComposition } from '../packages/adapter-dsh/delivery/index.mjs';
import { combineStatus } from './results.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const reporter = pathToFileURL(path.join(repo, 'acceptance/reporter.mjs')).href;
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const task = (id, argv, extra = {}) => ({ id, argv, status: 'not-run', exitCode: null, ...extra });
const configuredModel = ['--new-session-model', '{"provider":"arlo-web-configured","model":"scripted-configured"}'];
const webCases = [
  ['web', []], ['round-trip', ['--round-trip']],
  ['cross-host', ['--cross-host']], ['rendering', ['--contact-rendering']],
  ['unload', ['--plugin-unload']], ['readiness', ['--contact-readiness']],
  ['readiness-cancel', ['--contact-readiness-cancel']], ['multi-contact', ['--multi-contact']],
  ['configured-multi-contact', [...configuredModel, '--multi-contact']],
  ['configured-model', configuredModel],
  ['missing-provider', ['--new-session-model', '{"provider":"missing-controlled-provider","model":"scripted-configured"}', '--expect-model-unavailable']],
  ['missing-model', ['--new-session-model', '{"provider":"arlo-web-configured","model":"missing-controlled-model"}', '--expect-model-unavailable']],
  ...['removed-provider', 'catalog-failure', 'resolution-failure'].map(fault =>
    [fault, [...configuredModel, '--model-fault', fault, '--expect-model-unavailable']]),
];

// The installed report selects real published host/adapter entries; never use
// the harness's optional workspace fallback for compatibility evidence.
async function inspectPi(reportFile, experimental) {
  try {
    const installation = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(installation.status, 'passed');
    assert.equal(installation.platform, process.platform);
    const consumer = fs.realpathSync(installation.consumer);
    const require = createRequire(path.join(consumer, 'package.json'));
    const entries = {};
    for (const [key, name] of Object.entries({ piEntry: '@earendil-works/pi-coding-agent',
      adapterEntry: '@arlo/adapter-pi', sdkEntry: '@arlo/sdk', daemonEntry: '@arlo/daemon' })) {
      const file = fs.realpathSync(installation.entries[key]);
      const relative = path.relative(consumer, file);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && file.endsWith('.js'));
      if (key === 'piEntry') {
        // Pi exposes only an ESM import condition; require.resolve cannot
        // resolve its main export. Follow the actual installed import route.
        const root = path.join(consumer, 'node_modules', name);
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        assert.equal(file, fs.realpathSync(path.join(root, manifest.exports['.'].import)));
        assert.equal(fs.realpathSync(installation.entries.piCli), fs.realpathSync(path.join(root, manifest.bin.pi)));
      } else assert.equal(file, fs.realpathSync(require.resolve(name)));
      entries[key] = { file, sha256: sha(file) };
    }
    const { VERSION } = await import(pathToFileURL(entries.piEntry.file).href);
    assert.equal(VERSION, installation.hostVersion);
    assert.equal(VERSION, installation.entries.piVersion);
    const adapterRoot = path.dirname(path.dirname(entries.adapterEntry.file));
    const adapter = JSON.parse(fs.readFileSync(path.join(adapterRoot, 'package.json'), 'utf8'));
    assert.equal(fs.realpathSync(installation.entries.extension), fs.realpathSync(path.join(adapterRoot, adapter.pi.extensions[0])));
    if (!['1.1.0', '1.2.0', '1.3.0', '1.4.0'].includes(VERSION) && !experimental) return { ready: false, code: 'UNSUPPORTED_PI_VERSION', version: VERSION };
    return { ready: true, version: VERSION, experimental, reportSha256: sha(reportFile), entries };
  } catch {
    return { ready: false, code: 'PI_INSTALLATION_INVALID', reason: 'Use a successful private Pi build report for this platform with intact installed JS entries.' };
  }
}

export async function validate(args) {
  const { values } = parseArgs({ args, options: {
    stage: { type: 'string', default: 'contract' }, target: { type: 'string' },
    'pi-report': { type: 'string' }, consumer: { type: 'string' }, output: { type: 'string' },
    only: { type: 'string' }, experimental: { type: 'boolean', default: false },
    inventory: { type: 'boolean', default: false },
  } });
  assert.ok(['contract', 'core', 'native', 'all'].includes(values.stage), '--stage contract|core|native|all');
  assert.ok(['pi', 'dsh', 'cross-host'].includes(values.target), '--target pi|dsh|cross-host is required');
  assert.ok(values.output, '--output NEW_REPORT.json is required; prior evidence is never overwritten');
  const output = path.resolve(values.output);
  assert.ok(!fs.existsSync(output) && !fs.existsSync(`${output}.artifacts`), 'Choose a new --output to preserve prior evidence');
  const wantsPi = values.target !== 'dsh';
  const wantsDsh = values.target !== 'pi';
  const piReport = values['pi-report'] && path.resolve(values['pi-report']);
  const consumer = values.consumer && path.resolve(values.consumer);
  const stages = {
    contract: { status: 'not-run', tasks: [
      ...(wantsDsh ? [task('dsh-composition', [])] : []),
      ...(wantsPi ? [task('pi-installation', []), task('pi-contract', [
        '--test', '--test-concurrency=1', '--test-reporter', reporter, 'pi-acceptance/compatibility.test.mjs',
      ])] : []),
    ] },
    core: { status: 'not-run', tasks: [
      'cross-host-participation', 'adapter-registration',
      ...(wantsPi ? ['pi-reception', 'pi-connection-recovery', 'pi-root-configuration'] : []),
      ...(wantsDsh ? ['dsh-contact-client', 'dsh-initial-allowance', 'dsh-root-configuration'] : []),
    ].map(name => task(`core-${name}`, ['scripts/test-daemon.mjs', '--test-concurrency=1',
      '--test-reporter', reporter, `tests/${name}.test.ts`])) },
    native: { status: 'not-run', tasks: [
      ...(wantsPi ? fs.readdirSync(path.join(repo, 'pi-acceptance')).sort()
        .filter(file => file.endsWith('.test.mjs') && file !== 'compatibility.test.mjs')
        .map(file => task(`pi-${file.replace('.test.mjs', '')}`, ['--test', '--test-concurrency=1',
          '--test-reporter', reporter, `pi-acceptance/${file}`])) : []),
      ...(wantsDsh ? webCases.filter(([id]) => wantsPi || id !== 'cross-host')
        .map(([id, flags]) => task(`dsh-${id}`, ['web/run.mjs', '--consumer', consumer ?? 'MISSING_CONSUMER', ...flags,
          ...(values.experimental ? ['--experimental'] : [])], { webReport: true })) : []),
    ] },
  };
  if (values.only) assert.ok(['core', 'native'].includes(values.stage) &&
    stages[values.stage].tasks.some(item => item.id === values.only), '--only requires --stage core|native and a task in that stage; use --inventory to list tasks');
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(),
    command: [process.execPath, 'scripts/compatibility.mjs', 'validate', ...args],
    sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout?.trim() ?? null,
    driverSha256: Object.fromEntries(['scripts/compatibility.mjs', 'acceptance/compatibility.mjs',
      'acceptance/reporter.mjs', 'pi-acceptance/harness.mjs', 'web/run.mjs', 'pnpm-lock.yaml'].map(file => [file, sha(path.join(repo, file))])),
    runtime: { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch, osRelease: os.release() },
    target: values.target, requestedStage: values.stage, experimental: values.experimental,
    stages, complete: false, note: 'Contract admission and core regression do not imply native compatibility or expand the support matrix.' };
  let env;
  let artifacts;
  function save() {
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  async function run(item) {
    if (!env) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-compatibility-'));
      if (process.platform === 'win32') {
        const installation = piReport ? JSON.parse(fs.readFileSync(piReport, 'utf8')) : null;
        const sdk = installation?.entries.sdkEntry ?? createRequire(path.join(consumer, 'package.json')).resolve('@arlo/sdk');
        const { enforceWindowsAcl } = await import(pathToFileURL(sdk).href);
        enforceWindowsAcl(home, true);
      } else fs.chmodSync(home, 0o700);
      report.privateResources = home;
      // Existing runners create their own private profiles and local models.
      // The allowlist keeps provider credentials/global config out of children.
      env = Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PLAYWRIGHT_BROWSERS_PATH',
        'ARLO_BROWSER_EXECUTABLE', 'ARLO_PI_FD', 'ARLO_ACCEPTANCE_PYTHON']
        .filter(key => process.env[key]).map(key => [key, process.env[key]]));
      Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
        XDG_RUNTIME_DIR: home, TEMP: home, TMP: home, TMPDIR: home, CI: 'true',
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.platform === 'win32'
          ? [path.join(process.env.SystemRoot, 'System32'),
            path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
            process.env.PATH ?? process.env.Path ?? ''].join(path.delimiter) : '/usr/bin:/bin'}`,
        ARLO_PI_INSTALL_REPORT: piReport, ARLO_PI_EXPECTED_NODE: process.version,
        ARLO_PI_EXPERIMENTAL: values.experimental ? '1' : '0',
        ARLO_ACCEPTANCE_LOG: path.join(artifacts, 'test-details.log'),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig') });
      fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
    }
    item.startedAt = new Date().toISOString();
    item.log = path.join(artifacts, `${item.id}.log`);
    const nativeReport = path.join(artifacts, `${item.id}.json`);
    // Pi's explicit experiment must not select DSH's candidate-only contracts
    // when the other half of a single-host upgrade is the verified baseline.
    const baselineDsh = stages.contract.tasks.find(task => task.id === 'dsh-composition')
      ?.diagnosis?.hostVersion === '0.2.0-rc.2';
    const argv = [...item.argv.filter(arg => !(item.webReport && baselineDsh && arg === '--experimental')),
      ...(item.webReport ? ['--output', nativeReport] : [])];
    item.command = [process.execPath, ...argv];
    const fd = fs.openSync(item.log, 'wx', 0o600);
    // Source core fixtures use the same reviewed PowerShell mutex helper as
    // native fixtures, with their existing process-local script policy.
    const taskEnv = item.id.startsWith('core-') && process.platform === 'win32'
      ? { ...env, PSExecutionPolicyPreference: 'Bypass' } : env;
    if (taskEnv !== env) item.testEnvironment = { PSExecutionPolicyPreference: 'Bypass' };
    const result = spawnSync(process.execPath, argv, { cwd: repo, env: taskEnv,
      stdio: ['ignore', fd, fd], timeout: 20 * 60 * 1000, windowsHide: true });
    fs.closeSync(fd);
    Object.assign(item, { exitCode: result.status, signal: result.signal, processError: result.error?.code ?? null,
      status: result.status === 0 && !result.error ? 'passed' : 'failed', logSha256: sha(item.log), finishedAt: new Date().toISOString() });
    if (item.webReport) {
      try {
        const native = JSON.parse(fs.readFileSync(nativeReport, 'utf8'));
        item.evidence = { report: nativeReport, sha256: sha(nativeReport), status: native.status,
          checks: native.checks, composition: native.composition };
        if (native.status !== 'passed' || !native.checks?.length) item.status = 'failed';
      } catch {
        item.status = 'failed';
        item.evidenceError = 'NATIVE_REPORT_MISSING_OR_INVALID';
      }
    } else {
      const events = fs.readFileSync(item.log, 'utf8').split(/\r?\n/).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      item.tests = events.filter(event => event.event === 'test:pass' || event.event === 'test:fail');
      if (item.status === 'passed') item.status = combineStatus(item.tests);
    }
    save();
    console.log(`${item.id}: ${item.status} (exit ${item.exitCode})`);
  }
  if (!values.inventory) {
    artifacts = `${output}.artifacts`;
    fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
    for (const item of stages.contract.tasks) {
      if (item.id === 'dsh-composition') {
        item.diagnosis = inspectDshWebComposition(consumer ?? path.join(artifacts, 'missing'), { experimental: values.experimental });
      } else if (item.id === 'pi-installation') item.diagnosis = await inspectPi(piReport, values.experimental);
      else if (stages.contract.tasks.some(previous => previous.status !== 'passed' && previous !== item)) {
        item.reason = 'Installation contract failed; native contract probe not started.';
        continue;
      } else { await run(item); continue; }
      item.status = item.diagnosis.ready ? 'passed' : 'failed';
      item.exitCode = item.diagnosis.ready ? 0 : 1;
      save();
    }
    stages.contract.status = combineStatus(stages.contract.tasks);
    for (const name of ['core', 'native']) {
      const stage = stages[name];
      if (values.stage !== name && values.stage !== 'all') stage.reason = 'Stage not selected.';
      else if (stages.contract.status !== 'passed') stage.reason = 'Required contract failed; no positive validation started.';
      else if (name === 'core' && process.version !== `v${JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).engines.node}`) {
        stage.reason = 'BUILD_TOOLCHAIN_REQUIRED: source core checks require the pinned development Node; select native for installed-runtime validation.';
        for (const item of stage.tasks) { item.status = 'blocked'; item.reason = stage.reason; }
      }
      else if (values.stage === 'all' && name === 'native' && stages.core.status !== 'passed') stage.reason = 'Core stage incomplete or failed.';
      else for (const item of stage.tasks) {
        if (values.only && item.id !== values.only) item.reason = 'Not selected for this single-task rerun.';
        else await run(item);
      }
      stage.status = combineStatus(stage.tasks);
    }
  }
  report.complete = stages.contract.status === 'passed' && stages.native.status === 'passed' && !values.only;
  const requested = values.stage === 'all' ? Object.values(stages) : [stages.contract, stages[values.stage]];
  report.exitCode = values.inventory ? 0 : requested.some(stage => stage.status === 'failed') ? 1
    : values.only ? (Object.values(stages).flatMap(stage => stage.tasks).find(item => item.id === values.only).status === 'passed' ? 0 : 2)
    : requested.every(stage => stage.status === 'passed') ? 0 : 2;
  save();
  console.log(`Report: ${output}; complete native acceptance: ${report.complete}`);
  process.exitCode = report.exitCode;
}
