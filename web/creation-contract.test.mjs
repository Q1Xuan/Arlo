// Isolated native Host contract probe; no Arlo plugin or endpoint is loaded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const consumer = path.resolve(process.argv[2]);
const require = createRequire(path.join(consumer, 'package.json'));
const root = fs.mkdtempSync(path.resolve('.scratch/creation-'));
const fixture = path.join(root, 'fixture.mjs');
fs.copyFileSync(new URL('./creation-fixture.mjs', import.meta.url), fixture);
fs.copyFileSync(new URL('../packages/adapter-dsh/host-create.mjs', import.meta.url), path.join(root, 'host-create.mjs'));
fs.symlinkSync(path.join(consumer, 'node_modules'), path.join(root, 'node_modules'));
const home = path.join(root, 'home');
const profile = path.join(home, 'profiles/web');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'creation-contract', private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
fs.symlinkSync(path.join(consumer, 'node_modules'), path.join(profile, 'node_modules'));
const overlay = path.join(root, 'probe.yml');
fs.writeFileSync(overlay, [
  ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'agent-instructions', 'hmr'].map(id => `- id: ${id}\n  disabled: true`),
  '- id: ui-plugin-manager\n  config:\n    registryProbeEnabled: false',
  `- insert:\n    - id: creation-contract\n      name: ${JSON.stringify(pathToFileURL(fixture).href)}`,
].join('\n'));
const result = spawnSync(process.execPath, [require.resolve('@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
  cwd: root, timeout: 120000, encoding: 'utf8', env: { PATH: process.env.PATH, ...(process.argv.includes('--baseline') ? { CREATION_BASELINE: '1' } : {}), HOME: home, DSH_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
});
console.log((result.stdout + result.stderr).replace(/token=[^\s]+/g, 'token=<redacted>'));
if (result.error) console.error(result.error.message);
assert.equal(result.status, 0);
assert.match(result.stdout, /CREATION_CONTRACT_PASSED/);
