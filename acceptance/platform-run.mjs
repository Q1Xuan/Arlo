import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenariosForPlatform, classifyFile } from './catalog.mjs';
import { combineStatus, evaluateScenario } from './results.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const take = name => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
};
const platformName = process.platform === 'linux' ? 'linux' : 'windows';
const issue = process.platform === 'linux' ? 17 : 16;
const scenarios = scenariosForPlatform(process.platform);
const output = path.resolve(take('--output') ?? path.join(repo, `.scratch/${platformName}-acceptance-${issue}.json`));
const filesOption = take('--files');
const concurrencyOption = take('--concurrency') ?? '1';
if (!/^[1-4]$/.test(concurrencyOption)) throw new Error('--concurrency must be an integer from 1 to 4');
const concurrency = Number(concurrencyOption);
const timeoutMs = 60 * 60 * 1000;
const inventory = args.includes('--inventory');
const allowTemporaryUser = args.includes('--allow-temporary-user');
const skipProbes = args.includes('--skip-probes') || Boolean(filesOption) || inventory;
if (args.some(arg => !['--inventory', '--skip-probes', '--allow-temporary-user'].includes(arg))) throw new Error('Unknown acceptance runner option');
const files = filesOption ? filesOption.split(',') : fs.readdirSync(path.join(repo, 'tests'))
  .filter(file => file.endsWith('.test.ts')).sort().map(file => `tests/${file}`);
for (const file of files) {
  if (!/^tests\/[a-z0-9-]+\.test\.ts$/.test(file) || !fs.existsSync(path.join(repo, file))) throw new Error('Expected existing tests/*.test.ts files');
}
const hash = data => createHash('sha256').update(data).digest('hex');
function fingerprint() {
  const entries = [];
  for (const directory of ['packages', 'probes', 'tests', 'acceptance', 'scripts', 'delivery']) {
    const visit = relative => {
      for (const entry of fs.readdirSync(path.join(repo, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === 'node_modules') continue;
        const name = `${relative}/${entry.name}`;
        if (entry.isDirectory()) visit(name);
        else if (entry.isFile()) entries.push([name, hash(fs.readFileSync(path.join(repo, name)))]);
      }
    };
    visit(directory);
  }
  for (const file of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json']) entries.push([file, hash(fs.readFileSync(path.join(repo, file)))]);
  return hash(JSON.stringify(entries));
}
const sourceSha256 = fingerprint();
const startedAt = new Date().toISOString();
const pinnedNode = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).engines.node;
const packageVersion = name => {
  const file = path.join(repo, 'node_modules', name, 'package.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).version : null;
};
const versions = Object.fromEntries([
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session-projection',
  '@modelcontextprotocol/client', '@modelcontextprotocol/server', '@arlo/daemon', '@arlo/sdk', '@arlo/adapter-sdk', '@arlo/adapter-dsh',
].map(name => [name, packageVersion(name)]));
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).stdout?.trim() || null;
const report = {
  schemaVersion: 1, issue: `https://github.com/Q1Xuan/Arlo/issues/${issue}`, startedAt,
  command: ['node', 'acceptance/run.mjs', ...process.argv.slice(2)],
  source: { commit: git('rev-parse', 'HEAD'), worktreeDirty: Boolean(git('status', '--porcelain')), sourceSha256, lockSha256: hash(fs.readFileSync(path.join(repo, 'pnpm-lock.yaml'))) },
  runtime: { platform: process.platform, osType: os.type(), osRelease: os.release(), osVersion: os.version(), windowsBuild: null,
    linux: process.platform === 'linux' ? {
      osRelease: fs.readFileSync('/etc/os-release', 'utf8'), uid: process.getuid(), gid: process.getgid(),
      wsl: /microsoft/i.test(os.release()), sourceFilesystemType: fs.statfsSync(repo).type,
    } : null,
    arch: process.arch, node: process.version, pinnedNode: `v${pinnedNode}`, packages: versions },
  transport: { kind: 'MCP Streamable HTTP over pinned loopback HTTPS/SSE', configuredWireRevision: '2025-06-18', configuredArloProfile: 'arlo/session-messaging@0.1', note: 'Configured pins; behavioral negotiation is asserted by transport tests, not inferred from these labels.' },
  hostScope: 'Published Harness runtime modules and actual AgentLoop in independent processes, production Arlo plugin and test-defined permission/input rules enforced through the real public Harness policy pipeline. The installed Desktop launcher is outside this runtime acceptance scope.',
  unverifiedScope: process.platform === 'linux' ? [
    'Installed Desktop launcher and its complete policy/plugin configuration',
    'Other Linux distributions, non-WSL kernels and filesystems',
    'Access from another independently logged-in OS user; namespace probes map only the invoking UID and do not create accounts',
  ] : [],
  platformStatus: { windows: process.platform === 'win32' && !inventory ? 'executed-see-scenarios' : 'not-run', linux: process.platform === 'linux' && !inventory ? 'executed-see-scenarios' : 'not-run' },
  execution: { mode: inventory ? 'inventory' : filesOption ? 'selected-files' : 'all-tests', selectedFiles: files, probesIncluded: !skipProbes, allowTemporaryUser, concurrency, timeoutMs, timeoutScope: 'network negative control, tests and probes after resource setup' },
  tests: [], suites: [], probes: null, isolation: null, nativeEvidence: {},
};
let testExitCode = null;
let infrastructureFailure = false;
if (!inventory) {
  if (process.version !== `v${pinnedNode}`) throw new Error(`Requires pinned Node v${pinnedNode}`);
  const resourceRoot = fs.mkdtempSync(path.join(os.homedir(), `arlo-acceptance-${issue}-`));
  const owner = randomUUID();
  const { enforceWindowsAcl } = await import('@arlo/sdk');
  enforceWindowsAcl(resourceRoot, true);
  if (process.platform !== 'win32') fs.chmodSync(resourceRoot, 0o700);
  fs.writeFileSync(path.join(resourceRoot, '.arlo-owner.json'), JSON.stringify({ owner, pid: process.pid, purpose: `Arlo issue ${issue} acceptance`, createdAt: startedAt }));
  const dirs = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'runtime', 'temp', 'project', 'artifacts', 'evidence'].map(name => {
    const directory = path.join(resourceRoot, name);
    fs.mkdirSync(directory, { mode: 0o700 });
    return [name, directory];
  }));
  fs.writeFileSync(path.join(dirs.config, 'gitconfig'), '');
  const env = {
    PATH: process.env.PATH ?? process.env.Path,
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    PSExecutionPolicyPreference: 'Bypass',
    PSModuleAnalysisCachePath: path.join(dirs.cache, 'PowerShell', 'ModuleAnalysisCache'),
    HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.config, LOCALAPPDATA: dirs.data,
    XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state, XDG_RUNTIME_DIR: dirs.runtime,
    TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp, DSH_HOME: dirs.home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dirs.config, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
    ARLO_ACCEPTANCE_ROOT: resourceRoot, ARLO_ACCEPTANCE_OWNER: owner,
    ARLO_ALLOW_TEMPORARY_USER: allowTemporaryUser ? '1' : undefined,
    ARLO_ACCEPTANCE_EVIDENCE_DIR: dirs.evidence,
    ARLO_ACCEPTANCE_LOG: path.join(dirs.artifacts, 'test-details.log'),
    NODE_OPTIONS: `--import=${new URL('./preload.mjs', import.meta.url).href}`,
  };
  if (process.platform === 'win32') {
    const observed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$v = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'; [ordered]@{ ProductName=$v.ProductName; DisplayVersion=$v.DisplayVersion; CurrentBuildNumber=$v.CurrentBuildNumber; UBR=$v.UBR } | ConvertTo-Json -Compress",
    ], { cwd: dirs.project, encoding: 'utf8', windowsHide: true, timeout: 10000, env });
    if (observed.status === 0) {
      try { report.runtime.windowsBuild = JSON.parse(observed.stdout); } catch {}
    }
  }
  const deadline = Date.now() + timeoutMs;
  const remainingMs = () => Math.max(1, deadline - Date.now());
  process.stdout.write(`Acceptance resources: ${resourceRoot}\nRunning ${files.length} test files with concurrency ${concurrency}; total workload timeout ${timeoutMs} ms.\n`);
  const negativeCounter = path.join(dirs.artifacts, 'network-negative-control.json');
  const negativeProof = path.join(dirs.artifacts, 'network-negative-control.confirmed');
  const negativeEnv = { ...env, ARLO_LOW_LEVEL_NETWORK_FILE: negativeCounter };
  delete negativeEnv.NODE_OPTIONS;
  const negative = spawnSync(process.execPath, [
    '--import', new URL('../probes/isolation.mjs', import.meta.url).href, '--input-type=module', '--eval',
    `import assert from 'node:assert/strict'; import https from 'node:https'; import fs from 'node:fs';
assert.throws(() => https.request('https://acceptance-provider.invalid/fictional-canary'), /EXTERNAL_NETWORK_FORBIDDEN/);
fs.writeFileSync(${JSON.stringify(negativeProof)}, 'confirmed');`,
  ], { cwd: dirs.project, env: negativeEnv, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  const negativeControl = negative.status === 1 && !negative.error && fs.existsSync(negativeProof) &&
    fs.existsSync(negativeCounter) && JSON.parse(fs.readFileSync(negativeCounter, 'utf8')).deniedConnections === 1;
  const result = negativeControl ? spawnSync(process.execPath, [
    '--test', `--test-concurrency=${concurrency}`, '--test-reporter', new URL('./reporter.mjs', import.meta.url).href,
    ...files.map(file => path.join(repo, file)),
  ], { cwd: dirs.project, env, windowsHide: true, encoding: 'utf8', timeout: remainingMs(), maxBuffer: 32 * 1024 * 1024 })
    : { status: null, error: { code: 'ACCEPTANCE_NETWORK_NEGATIVE_CONTROL_FAILED' }, stdout: '', stderr: '' };
  testExitCode = result.status;
  fs.writeFileSync(path.join(dirs.artifacts, 'test-events.jsonl'), result.stdout ?? '');
  fs.writeFileSync(path.join(dirs.artifacts, 'test-stderr.log'), result.stderr ?? '');
  const events = [];
  try {
    for (const line of (result.stdout ?? '').split(/\r?\n/).filter(Boolean)) events.push(JSON.parse(line));
  } catch { infrastructureFailure = true; }
  report.tests = events.filter(event => event.event === 'test:pass' || event.event === 'test:fail').map(event => ({
    ...event, file: event.file ? path.relative(repo, event.file).replaceAll('\\', '/') : null,
  }));
  infrastructureFailure ||= Boolean(result.error) || result.status === null || report.tests.length === 0;
  report.execution.exitCode = result.status;
  report.execution.processError = result.error?.code ?? null;
  for (const name of ['pid-reuse', 'cross-user', 'linux-ownership']) {
    const file = path.join(dirs.evidence, `${name}.json`);
    if (fs.existsSync(file)) report.nativeEvidence[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const processDir = path.join(resourceRoot, 'processes');
  const processFiles = fs.existsSync(processDir) ? fs.readdirSync(processDir) : [];
  const processRecords = processFiles.filter(file => file.endsWith('.process.json')).map(file => JSON.parse(fs.readFileSync(path.join(processDir, file), 'utf8')));
  const networkRecords = processFiles.filter(file => file.endsWith('.network.json')).map(file => ({
    instance: file.slice(0, -'.network.json'.length), pid: Number(file.split('-')[0]), ...JSON.parse(fs.readFileSync(path.join(processDir, file), 'utf8')),
  }));
  const isolationPassed = processRecords.length > 0 && processRecords.every(record => record.owner === owner) &&
    processRecords.every(record => networkRecords.some(network => network.instance === record.instance && network.deniedConnections === 0));
  report.isolation = {
    status: isolationPassed ? 'passed' : 'failed', resourceRoot, owner, negativeControl,
    environmentPolicy: 'Allowlist only; private HOME/config/cache/state/temp/project; no inherited provider variables or global Git config.',
    processCount: processRecords.length, processes: processRecords.map(({ owner, ...record }) => record), network: networkRecords,
    boundary: 'Node networking is restricted to loopback and local IPC and the preload propagates to Node descendants. Chroot/namespace probes keep separate validated counters in nativeEvidence. This is a controlled local model test boundary, not an OS sandbox against arbitrary native subprocesses.',
    cleanup: 'Resources retained for review; no recursive cleanup or PID-based termination is performed by the runner.',
  };
  infrastructureFailure ||= !isolationPassed;
  if (!skipProbes && negativeControl) {
    process.stdout.write('Running the existing isolated probe suite.\n');
    const probeReport = path.join(dirs.artifacts, 'probes.json');
    const probeEnv = { ...env };
    // Probe negative controls intentionally attempt forbidden fictional requests.
    // Their established permission runner owns that boundary and expected exit.
    delete probeEnv.NODE_OPTIONS;
    const probes = spawnSync(process.execPath, [path.join(repo, 'probes/run.mjs'), '--report-file', probeReport], {
      cwd: dirs.project, env: probeEnv, windowsHide: true, encoding: 'utf8', timeout: Math.min(10 * 60 * 1000, remainingMs()), maxBuffer: 8 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(dirs.artifacts, 'probes.stdout.log'), probes.stdout ?? '');
    fs.writeFileSync(path.join(dirs.artifacts, 'probes.stderr.log'), probes.stderr ?? '');
    report.probes = { status: probes.status === 0 && !probes.error ? 'passed' : 'failed', exitCode: probes.status, processError: probes.error?.code ?? null, evidence: fs.existsSync(probeReport) ? JSON.parse(fs.readFileSync(probeReport, 'utf8')) : null };
    infrastructureFailure ||= report.probes.status === 'failed';
  }
}
report.source.unchangedDuringRun = sourceSha256 === fingerprint();
infrastructureFailure ||= !report.source.unchangedDuringRun;
report.suites = files.map(file => {
  const tests = report.tests.filter(test => test.file === file);
  return { file, evidenceLevel: classifyFile(file), status: combineStatus(tests), testCount: tests.length, skipped: tests.filter(test => test.status === 'not-run').length };
});
report.scenarios = scenarios.map(scenario => evaluateScenario(scenario, {
  platform: process.platform, tests: report.tests,
  isolationStatus: report.isolation?.status ?? 'not-run', reportStatus: inventory ? 'not-run' : infrastructureFailure ? 'failed' : 'passed',
}));
report.counts = Object.fromEntries(['passed', 'failed', 'not-run', 'blocked'].map(status => [status, report.scenarios.filter(scenario => scenario.status === status).length]));
report.execution.status = inventory ? 'not-run' : infrastructureFailure || testExitCode !== 0 ? 'failed' : 'passed';
report.windowsMvpComplete = process.platform === 'win32' && report.execution.status === 'passed' && report.scenarios.filter(scenario => scenario.required).every(scenario => scenario.status === 'passed');
report.linuxMvpComplete = process.platform === 'linux' && report.execution.status === 'passed' && report.scenarios.filter(scenario => scenario.required).every(scenario => scenario.status === 'passed');
report.finishedAt = new Date().toISOString();
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(`Report: ${output}\nExecution: ${report.execution.status}; Windows MVP complete: ${report.windowsMvpComplete}; Linux MVP complete: ${report.linuxMvpComplete}\n`);
// 2 means the commands succeeded but required acceptance evidence is incomplete.
process.exitCode = inventory ? 0 : report.execution.status === 'failed' ? 1 : report.windowsMvpComplete || report.linuxMvpComplete ? 0 : 2;
