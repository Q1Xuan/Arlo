import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createPrivateBuildEnvironment, filesIn } from './private-build.mjs';
import { inspectDshWebComposition } from '../packages/adapter-dsh/delivery/index.mjs';
import { enforceWindowsAcl } from '../packages/sdk/src/security/index.ts';

const repo = path.resolve(import.meta.dirname, '..');
const { values: { version, out, pnpm, store, experimental } } = parseArgs({ options: {
  version: { type: 'string' }, out: { type: 'string' }, pnpm: { type: 'string' },
  store: { type: 'string' }, experimental: { type: 'boolean' },
} });
assert.ok(experimental && version === '0.2.1-rc.2' && out && pnpm,
  'Usage: dsh-candidate.mjs --experimental --version 0.2.1-rc.2 --out NEW_DIR --pnpm CLI.js [--store DIR]');
assert.equal(process.version, 'v24.13.1', 'Use the reproducible build runtime; runtime-range work belongs to #121');
const bundle = path.resolve(out);
assert.ok(!fs.existsSync(bundle), 'Choose a new output directory to retain previous experiment evidence');
const { resources, dirs, env } = createPrivateBuildEnvironment({
  prefix: 'arlo-dsh-experiment-', metadata: { purpose: 'DSH candidate composition experiment' },
  npmrc: 'registry=https://registry.npmjs.org/\n',
});
fs.mkdirSync(bundle, { recursive: true, mode: 0o700 });
enforceWindowsAcl(bundle, true);
const consumer = path.join(bundle, 'consumer');
fs.cpSync(path.join(repo, 'web/candidates', version), consumer, { recursive: true });
function run(argv, cwd, log) {
  const result = spawnSync(process.execPath, argv, { cwd, env, encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  fs.writeFileSync(path.join(dirs.logs, log), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.ok(result.status === 0 && !result.error, `Candidate installation failed; inspect ${log} in the private experiment logs`);
  return result.stdout.trim();
}
assert.equal(run([pnpm, '--version'], consumer, 'pnpm-version.log'), '10.26.2');
run([pnpm, 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace',
  ...(store ? ['--store-dir', store] : [])], consumer, 'install.log');
const require = createRequire(path.join(consumer, 'package.json'));
const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const patchResults = [];
for (const file of fs.readdirSync(path.join(repo, 'packages/adapter-dsh/patches')).filter(file => file.endsWith('.patch')).sort()) {
  const name = `@deepseek-ai/${file.split('@')[0]}`;
  const directory = path.dirname(hostRequire.resolve(`${name}/package.json`));
  const result = spawnSync('patch', ['--dry-run', '--batch', '--fuzz=0', '-p1', '-i',
    path.join(repo, 'packages/adapter-dsh/patches', file)], { cwd: directory, env, encoding: 'utf8', timeout: 30000 });
  patchResults.push({ file, alreadyApplied: name === '@deepseek-ai/dsh-session-format',
    executed: !result.error, exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  schemaVersion: 1, experimental: true, platform: process.platform, node: process.version,
  createdAt: new Date().toISOString(), resources,
  stage: 'installed-contract-investigation',
  // This candidate has declaration, native creation and submit-preparation ports. It must not start a Arlo
  // endpoint or be presented as a complete Web bundle.
  diagnosis: inspectDshWebComposition(consumer, { experimental: true }),
  patchResults,
  files: Object.fromEntries(filesIn(consumer, { excludeNodeModules: true }).map(file =>
    [`consumer/${file}`, sha(fs.readFileSync(path.join(consumer, file)))])),
};
fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ bundle, stage: report.stage, status: report.diagnosis.status,
  reason: report.diagnosis.reason, formallySupported: false }));
process.exitCode = report.diagnosis.ready ? 0 : 1;
