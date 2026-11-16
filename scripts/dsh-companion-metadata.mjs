import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { manifestSha256 } from '../packages/daemon/setup-dsh/dependency-closure.mjs';
import { sha256 } from '../packages/daemon/setup-dsh/exact-patch.mjs';

// Maintainer-only metadata from a compiled archive. Existing reviewed
// executable/declaration/browser hashes are checked, never regenerated here.
const [option, archive] = process.argv.slice(2);
assert.equal(option, '--compiled-adapter');
const read = file => {
  const result = spawnSync('tar', ['-xOf', path.resolve(archive), `package/${file}`], { maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
};
const manifest = JSON.parse(read('package.json'));
const version = manifest.peerDependencies['@deepseek-ai/dsh'];
assert.equal(version, '0.2.1-rc.5');
assert.equal(manifest.name, '@arlo/adapter-dsh');
assert.ok(Object.keys(manifest.dependencies).every(name => name.startsWith('@arlo/')));
assert.ok(Object.keys(manifest.peerDependencies).every(name => manifest.peerDependenciesMeta[name]?.optional === true));
const repo = path.resolve(import.meta.dirname, '..');
const file = path.join(repo, 'packages/adapter-dsh/delivery/rc5-composition.json');
const reviewed = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const [file, digest] of Object.entries(reviewed.adapter.files)) assert.equal(sha256(read(file)), digest, `Unreviewed adapter bytes: ${file}`);
const fields = ['name', 'version', 'type', 'main', 'module', 'exports', 'imports', 'browser', 'bin', 'dsh',
  'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'];
reviewed.companion = {
  hostVersion: version,
  dependencyManifests: { [`${manifest.name}@${manifest.version}`]: manifestSha256(Object.fromEntries(fields
    .filter(field => field in manifest).map(field => [field, manifest[field]]))) },
  scope: 'Exact compiled companion manifest; original executable, native contract, peer, browser and complete closure gates remain required. Ordinary dependency profiles still require explicit experimental selection.',
};
fs.writeFileSync(file, JSON.stringify(reviewed, null, 2) + '\n');
console.log(`Bound ${manifest.name}@${manifest.version} to its exact compiled rc.5 borrowed-peer manifest.`);
