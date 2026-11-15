import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { ARLO_PINNED_WIRE_REVISION, ARLO_PROFILE, ARLO_PROFILE_VERSION } from './mcp-notification.ts';
import { probeSourceSha256 } from './source-fingerprint.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [
  'probes/mcp-notification.test.ts', 'probes/mcp-metadata.test.ts', 'probes/host-reception-gate.test.ts',
  'probes/transport-retry-defense.test.ts', 'probes/transport-tls.test.ts',
  'probes/secure-transport.test.ts',
];
const requiredObservations = ['capabilities', 'rootSessionBinding', 'notificationGate', 'pendingCredit', 'httpAndSse', 'tlsPinning', 'tlsConnections', 'httpsAndHost'];
const desktopExe = process.argv[2] ?? 'E:/software/dsh/DeepSeek Harness.exe';
const sourceSha256 = probeSourceSha256(root);
const lockSha256 = createHash('sha256').update(readFileSync(path.join(root, 'pnpm-lock.yaml'))).digest('hex');
mkdirSync(path.join(root, '.scratch'), { recursive: true });
const runDirectory = mkdtempSync(path.join(root, '.scratch/transport-evidence-'));

function run(name, options) {
  const reportPath = path.join(runDirectory, `${name}.json`);
  const started = Date.now();
  const result = spawnSync(process.execPath, ['probes/run.mjs', '--report-file', reportPath, ...options, ...tests], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  const observations = report?.observations ?? {};
  const pass = result.status === 0 && result.error === undefined && report?.results?.length === tests.length &&
    tests.every(file => report.results.some(test => test.file === file && test.exitCode === 0 && !test.processError)) &&
    requiredObservations.every(key => observations[key] !== undefined) &&
    observations.capabilities?.wireRevision === ARLO_PINNED_WIRE_REVISION &&
    observations.httpAndSse?.wireRevision === ARLO_PINNED_WIRE_REVISION && report.lockSha256 === lockSha256;
  return { runtime: report?.hostRuntime ?? null, durationMs: Date.now() - started,
    exitCode: result.status, processError: result.error?.code ?? null, pass,
    results: report?.results ?? [], observations };
}

console.log('Running transport probes in the pinned development runtime');
const nodeRuntime = run('node', []);
console.log('Running transport probes in the installed desktop Node runtime');
const desktopNodeRuntime = run('desktop', ['--desktop-exe', desktopExe]);
console.log('Running HTTPS MCP in the installed Desktop Host plugin');
const installedRun = spawnSync(process.execPath, ['probes/run-desktop-transport.mjs', desktopExe], {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
});
process.stdout.write(installedRun.stdout ?? '');
process.stderr.write(installedRun.stderr ?? '');
const installedPath = path.join(root, 'docs/compatibility/desktop-transport-run.json');
const installedHost = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, 'utf8')) : null;
const installedPass = installedRun.status === 0 && !installedRun.error && installedHost?.overallStatus === 'PASS' &&
  installedHost.sourceSha256 === sourceSha256 && installedHost.lockSha256 === lockSha256;
const installed = name => JSON.parse(readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
// Only enumerate the documented public interfaces actually exercised here.
const methods = (prototype, names) => names.filter(name => typeof prototype[name] === 'function');
const evidence = {
  timestamp: new Date().toISOString(), sourceSha256, lockSha256,
  profile: ARLO_PROFILE, profileVersion: ARLO_PROFILE_VERSION,
  mcpClientVersion: installed('@modelcontextprotocol/client'), mcpServerVersion: installed('@modelcontextprotocol/server'),
  harnessVersion: installed('@deepseek-ai/dsh-agent'),
  wireRevision: nodeRuntime.observations.httpAndSse?.wireRevision ?? null,
  scope: 'Windows: real SDK HTTP/SSE and pinned HTTPS/SSE; public Harness package fixtures in both Node runtimes and actual installed Desktop Host agents via Cordis plugin.',
  publicExports: {
    client: methods(Client.prototype, ['connect', 'getNegotiatedProtocolVersion', 'getProtocolEra', 'getServerCapabilities', 'setNotificationHandler', 'removeNotificationHandler', 'callTool', 'close']),
    server: methods(Server.prototype, ['connect', 'getClientCapabilities', 'setRequestHandler', 'notification', 'close']),
    streamableClient: methods(StreamableHTTPClientTransport.prototype, ['resumeStream', 'close']),
    streamableServer: methods(WebStandardStreamableHTTPServerTransport.prototype, ['handleRequest', 'closeStandaloneSSEStream', 'close']),
  },
  nodeRuntime, desktopNodeRuntime,
  installedHost: { pass: installedPass, evidenceFile: 'docs/compatibility/desktop-transport-run.json',
    exitCode: installedRun.status, processError: installedRun.error?.code ?? null,
    sourceSha256: installedHost?.sourceSha256 ?? null,
    evidenceSha256: existsSync(installedPath) ? createHash('sha256').update(readFileSync(installedPath)).digest('hex') : null },
  overallStatus: nodeRuntime.pass && desktopNodeRuntime.pass && installedPass && sourceSha256 === probeSourceSha256(root) ? 'PASS' : 'FAIL',
};
const evidencePath = path.join(root, 'docs/compatibility/transport-run.json');
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
console.log(`Transport evidence: ${evidence.overallStatus}`);
process.exitCode = evidence.overallStatus === 'PASS' ? 0 : 1;
