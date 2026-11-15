import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.version !== 'v24.13.1') throw new Error('Requires pinned Node v24.13.1');
const argumentsList = process.argv.slice(2);
const reportOption = argumentsList.indexOf('--report-file');
const reportFile = reportOption < 0 ? path.join(root, '.scratch/last-run.json') : argumentsList[reportOption + 1];
if (reportOption >= 0) {
  if (!reportFile || !path.isAbsolute(reportFile)) throw new Error('--report-file requires an absolute path');
  argumentsList.splice(reportOption, 2);
}
const desktopOption = argumentsList.indexOf('--desktop-exe');
const desktopExecutable = desktopOption < 0 ? undefined : argumentsList[desktopOption + 1];
if (desktopOption >= 0) {
  if (!desktopExecutable || !path.isAbsolute(desktopExecutable)) throw new Error('--desktop-exe needs an absolute installed executable path');
  argumentsList.splice(desktopOption, 2);
}
const scratch = path.join(root, '.scratch');
mkdirSync(scratch, { recursive: true });
const home = mkdtempSync(path.join(scratch, 'host-'));
writeFileSync(path.join(home, '.arlo-owner'), 'Arlo issue 2 isolated probe\n');
const outsideCanary = path.join(scratch, 'fictional-outside-canary');
writeFileSync(outsideCanary, 'fictional canary; owned by Arlo issue 2\n');
const probes = path.join(root, 'probes');
const files = argumentsList.length ? argumentsList : [
  'probes/host.test.ts', 'probes/pending.test.ts', 'probes/history-reader.test.ts',
  'probes/isolation.test.ts', 'probes/network-denied.test.ts',
  'probes/sandbox.test.ts', 'probes/display.test.ts',
  'probes/gui-network.test.ts',
  'probes/mcp-notification.test.ts',
  'probes/mcp-metadata.test.ts',
  'probes/host-reception-gate.test.ts',
  'probes/transport-retry-defense.test.ts',
  'probes/transport-tls.test.ts',
  'probes/secure-transport.test.ts',
];
const results = [];
for (const file of files) {
const result = spawnSync(desktopExecutable ?? process.execPath, [
  '--permission',
  `--allow-fs-read=${probes}`,
  `--allow-fs-read=${path.join(root, 'package.json')}`,
  `--allow-fs-read=${path.join(root, 'node_modules')}`,
  `--allow-fs-read=${path.join(root, 'docs')}`,
  `--allow-fs-read=${home}`,
  `--allow-fs-write=${home}`,
  '--import', new URL('./isolation.mjs', import.meta.url).href,
  '--import', new URL('./runtime-check.mjs', import.meta.url).href,
  path.resolve(root, file),
], {
  cwd: home,
  env: {
    SystemRoot: process.env.SystemRoot,
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
    TEMP: home, TMP: home, TMPDIR: home,
    ARLO_OUTSIDE_CANARY: outsideCanary,
    ARLO_EXPECTED_NODE: desktopExecutable ? 'v24.18.1' : 'v24.13.1',
    ...(desktopExecutable ? { ELECTRON_RUN_AS_NODE: '1', ARLO_EXPECTED_ELECTRON: '44.0.0' } : {}),
  },
  encoding: 'utf8', timeout: 30000, windowsHide: true,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) console.error(result.error.code ?? 'PROBE_PROCESS_FAILED');
results.push({ file, exitCode: result.status ?? 1,
  expectedExitCode: file === 'probes/network-denied.test.ts' ? 1 : 0,
  processError: result.error?.code ?? null,
  negativeControlConfirmed: file !== 'probes/network-denied.test.ts' || existsSync(path.join(home, 'network-denied-confirmed')),
});
}
writeFileSync(reportFile, JSON.stringify({
  node: process.version, platform: process.platform, arch: process.arch,
  hostRuntime: existsSync(path.join(home, 'runtime-observed.json'))
    ? JSON.parse(readFileSync(path.join(home, 'runtime-observed.json'), 'utf8')) : null,
  lockSha256: createHash('sha256').update(readFileSync(path.join(root, 'pnpm-lock.yaml'))).digest('hex'),
  results,
  observations: existsSync(path.join(home, 'transport-observations.json'))
    ? JSON.parse(readFileSync(path.join(home, 'transport-observations.json'), 'utf8')) : {},
}, null, 2) + '\n');
process.exitCode = results.every(result => result.processError === null && result.negativeControlConfirmed && result.exitCode === result.expectedExitCode) ? 0 : 1;
