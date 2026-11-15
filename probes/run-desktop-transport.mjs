import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { probeSourceSha256 } from './source-fingerprint.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exe = process.argv[2] ?? 'E:/software/dsh/DeepSeek Harness.exe';
assert.ok(existsSync(exe), 'Installed Desktop executable must exist');
const sourceSha256 = probeSourceSha256(root);
const lockSha256 = createHash('sha256').update(readFileSync(path.join(root, 'pnpm-lock.yaml'))).digest('hex');
const installation = path.dirname(exe);
const installationMetadata = JSON.parse(readFileSync(path.join(root, 'docs/compatibility/desktop-installation.json'), 'utf8'));
const asarHash = createHash('sha256');
for await (const chunk of createReadStream(path.join(installation, 'resources/app.asar'))) asarHash.update(chunk);
const appAsarSha256 = asarHash.digest('hex');
assert.equal(appAsarSha256, installationMetadata.appAsarSha256, 'Installed build must match the recorded Host M0 build');
const asarDsh = path.join(installation, 'resources/app.asar/dsh');
mkdirSync(path.join(root, '.scratch'), { recursive: true });
const home = mkdtempSync(path.join(root, '.scratch/installed-transport-'));
writeFileSync(path.join(home, '.arlo-owner'), 'Arlo issue 3 installed HTTPS MCP transport probe\n');
const profile = path.join(home, 'profiles/desktop');
mkdirSync(profile, { recursive: true });
const modules = path.join(home, 'probe');
mkdirSync(modules);
// Compile our own probe sources, leaving all third-party imports at their
// published package entries. Nothing is extracted or evaluated from ASAR.
for (const name of ['desktop-transport-plugin', 'fixture', 'secure-transport-scenario', 'pinned-fetch',
  'transport-tls', 'tls-fixtures', 'transport-retry-defense', 'host-reception-gate',
  'reception', 'mcp-metadata', 'mcp-notification', 'message', 'imposter-process']) {
  const source = readFileSync(path.join(root, 'probes', `${name}.ts`), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } });
  writeFileSync(path.join(modules, `${name}.mjs`), compiled.outputText.replace(/(from ['"]\.\/[^'"]+)\.ts(['"])/g, '$1.mjs$2'));
}
for (const name of ['gui-network-guard', 'isolation']) copyFileSync(path.join(root, 'probes', `${name}.mjs`), path.join(modules, `${name}.mjs`));
writeFileSync(path.join(modules, 'preload.mjs'), "import './isolation.mjs';\nimport { apply } from './gui-network-guard.mjs';\nawait apply(null);\n");
const pluginUrl = pathToFileURL(path.join(modules, 'desktop-transport-plugin.mjs')).href;
writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
  name: 'arlo-isolated-transport-profile', private: true, dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}));
writeFileSync(path.join(profile, 'cordis.patch.yml'), `- insert:\n    - name: ${JSON.stringify(pluginUrl)}\n`);
const reportFile = path.join(home, 'transport.json');
const networkFile = path.join(home, 'network.json');
const lowLevelNetworkFile = path.join(home, 'low-level-network.json');
const child = spawn(exe, [
  '--import', pathToFileURL(path.join(modules, 'preload.mjs')).href, '--expose-internals',
  path.join(asarDsh, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'),
  asarDsh, profile, path.join(installation, 'resources/runtime/primary-runtime'),
  path.join(installation, 'resources/runtime/pnpm/bin/pnpm.mjs'), path.join(installation, 'resources/runtime/bin'),
], {
  cwd: profile, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: {
    SystemRoot: process.env.SystemRoot, PATH: process.env.PATH ?? process.env.Path,
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
    TEMP: home, TMP: home, TMPDIR: home, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_CLIENT_VERSION: '0.2.0-rc.2',
    ARLO_TRANSPORT_REPORT: reportFile, ARLO_HOST_EVIDENCE_FILE: networkFile,
    ARLO_LOW_LEVEL_NETWORK_FILE: lowLevelNetworkFile,
  },
});
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-16000); });
let ready = false;
let timeout = false;
let processError = null;
child.on('error', error => { processError = error.message; });
child.on('message', message => {
  if (message.type === 'ready') {
    ready = true;
    child.send({ type: 'shutdown' });
  }
});
const deadline = setTimeout(() => { timeout = true; child.kill(); }, 45000);
const exitCode = await new Promise(resolve => child.once('close', resolve));
clearTimeout(deadline);
const results = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
const network = existsSync(networkFile) ? JSON.parse(readFileSync(networkFile, 'utf8')) : null;
const lowLevelNetwork = existsSync(lowLevelNetworkFile) ? JSON.parse(readFileSync(lowLevelNetworkFile, 'utf8')) : null;
const pass = ready && !timeout && !processError && exitCode === 0 && results?.pass === true &&
  results.runtime.node === 'v24.18.1' && results.runtime.electron === '44.0.0' &&
  results.observations?.wireRevision === '2025-06-18' && results.localModelRequests > 0 &&
  results.observations.isolatedImposter === true &&
  network?.negativeControlProven === true && network.unexpectedExternalCallsCount === 0 &&
  lowLevelNetwork?.deniedConnections === 0 &&
  sourceSha256 === probeSourceSha256(root);
const evidence = {
  timestamp: new Date().toISOString(), sourceSha256, lockSha256,
  scope: 'Installed Desktop Host entry with public Cordis plugin and actual registry agents; local controlled model; MCP HTTPS/SSE via public SDK fetch option.',
  desktopExecutable: exe, appAsarSha256, harnessVersion: installationMetadata.version,
  ready, timeout, processError, exitCode, results, network, lowLevelNetwork,
  overallStatus: pass ? 'PASS' : 'FAIL',
};
writeFileSync(path.join(root, 'docs/compatibility/desktop-transport-run.json'), JSON.stringify(evidence, null, 2) + '\n');
// Host startup logs contain a generated local UI bearer token.
if (!pass) process.stderr.write(output.replace(/([?&]token=)[^\s&]+/g, '$1<REDACTED>'));
console.log(`Installed HTTPS MCP transport: ${evidence.overallStatus}`);
console.log(JSON.stringify({ runtime: results?.runtime, metrics: results?.observations?.metrics, error: results?.error ?? processError }));
process.exitCode = pass ? 0 : 1;
