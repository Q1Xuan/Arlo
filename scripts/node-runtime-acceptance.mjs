import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reuse the native acceptance boundaries; never build or install with a
// candidate runtime. Run once per executable and retain every nonzero result.
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  assert.ok(index >= 0 && args[index + 1] && !args[index + 1].startsWith('--'), `${name} requires a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}
const node = fs.realpathSync(option('--node'));
const phase = option('--phase');
const piReport = path.resolve(option('--pi-report'));
const output = path.resolve(option('--out'));
const consumer = phase === 'web' ? path.resolve(option('--web-consumer')) : undefined;
assert.ok(['pi', 'web'].includes(phase) && !args.length,
  'Usage: node-runtime-acceptance.mjs --node EXE --phase pi|web --pi-report REPORT --out DIR [--web-consumer DIR]');
assert.ok(!fs.existsSync(output), 'Choose a new output directory to preserve previous results');
const installation = JSON.parse(fs.readFileSync(piReport, 'utf8'));
assert.equal(installation.status, 'passed');
const version = spawnSync(node, ['--version'], { encoding: 'utf8' });
assert.equal(version.status, 0);
const nodeVersion = version.stdout.trim();
assert.match(nodeVersion, /^v\d+\.\d+\.\d+$/);
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-node-acceptance-'));
fs.chmodSync(home, 0o700);
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PLAYWRIGHT_BROWSERS_PATH', 'ARLO_PI_FD']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, {
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
  XDG_DATA_HOME: home, XDG_STATE_HOME: home, TEMP: home, TMP: home, TMPDIR: home,
  PATH: `${path.dirname(node)}${path.delimiter}${process.platform === 'win32'
    ? path.join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin'}`,
  ARLO_PI_INSTALL_REPORT: piReport, ARLO_PI_EXPECTED_NODE: nodeVersion, CI: 'true',
});
const report = {
  node: nodeVersion, executable: node, executableSha256: sha(node),
  platform: process.platform, arch: process.arch, osRelease: os.release(), osVersion: os.version(),
  phase, privateHome: home, pi: installation.hostVersion, piReportSha256: sha(piReport),
  installedEntries: Object.fromEntries(Object.entries(installation.entries).filter(([, file]) => typeof file === 'string' && path.isAbsolute(file)).map(([name, file]) =>
    [name, { file, sha256: sha(file) }])),
  ...(consumer ? { webManifestSha256: sha(path.join(consumer, '../manifest.json')) } : {}),
  runs: [],
};
async function run(label, argv) {
  const startedAt = new Date().toISOString();
  const log = path.join(output, `${label}.log`);
  const stream = fs.createWriteStream(log);
  const child = spawn(node, argv, { cwd: path.resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ exitCode: null, error: error.message }));
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  await new Promise(resolve => stream.end(resolve));
  const text = fs.readFileSync(log, 'utf8');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(name =>
    [name, Number(text.match(new RegExp(`ℹ ${name} (\\d+)`))?.[1] ?? 0)]));
  const webFile = path.join(output, `${label}.json`);
  const web = consumer && fs.existsSync(webFile) ? JSON.parse(fs.readFileSync(webFile, 'utf8')) : undefined;
  report.runs.push({ label, argv: [node, ...argv], startedAt, finishedAt: new Date().toISOString(), ...result,
    logSha256: sha(log), ...(web ? {
      status: web.status, checks: web.checks, composition: web.composition, browser: web.browser,
      error: web.error, browserErrors: web.browserErrors, browserConsole: web.browserConsole,
      externalBrowserRequests: web.externalBrowserRequests, reportSha256: sha(webFile),
    } : { counts, failedTests: text.split('\n').filter(line => /^✖ /.test(line)) }) });
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${nodeVersion} ${label}: exit ${result.exitCode}`);
}
if (phase === 'pi') {
  for (const name of ['native', 'lifecycle', 'recovery', 'root-configuration', 'initial-allowance', 'cancellation', 'participation']) {
    await run(name, ['--test', '--test-reporter=spec', '--test-concurrency=1', `pi-acceptance/${name}.test.mjs`]);
  }
} else {
  for (const [label, options] of [['native', []], ['cross-host', ['--cross-host']],
    ['rendering', ['--contact-rendering']], ['unload', ['--plugin-unload']]]) {
    await run(label, ['web/run.mjs', '--consumer', consumer, '--output', path.join(output, `${label}.json`), ...options]);
  }
}
process.exitCode = report.runs.some(run => run.exitCode !== 0) ? 1 : 0;
