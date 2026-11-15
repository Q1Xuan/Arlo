import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { dshHostLockSha256 } from '../packages/daemon/setup-dsh/dependency-closure.mjs';
import { createHash } from 'node:crypto';
const repo = path.resolve(import.meta.dirname, '..');
const consumer = process.argv[2] === '--host-consumer' && process.argv[3];
if (!consumer) throw new Error('Use --host-consumer REVIEWED_DSH_CONSUMER to obtain the already installed host YAML parser. Expectations come only from repository reviewed locks.');
const require = createRequire(path.join(path.resolve(consumer), 'package.json'));
const yaml = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))('js-yaml');
// This feature adds a public compiled CLI export. Freeze its resulting manifest
// selector together with the existing full recipes; public dependencies stay pinned.
const daemon = JSON.parse(fs.readFileSync(path.join(repo, 'packages/daemon/package.json'), 'utf8'));
daemon.exports = Object.fromEntries(Object.entries(daemon.exports).map(([key, value]) => [key,
  { types: value.replace(/\.ts$/, '.d.ts'), default: value.replace(/\.ts$/, '.js') }]));
daemon.dependencies = Object.fromEntries(Object.entries(daemon.dependencies).map(([name, version]) => [name,
  version === 'workspace:*' ? JSON.parse(fs.readFileSync(path.join(repo, 'packages', name.slice('@arlo/'.length), 'package.json'), 'utf8')).version : version]));
const fields = ['name', 'version', 'type', 'main', 'module', 'exports', 'imports', 'browser', 'bin', 'dsh',
  'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'];
const daemonManifestSha = createHash('sha256').update(JSON.stringify(Object.fromEntries(fields.filter(field => field in daemon)
  .map(field => [field, daemon[field]])))).digest('hex');
const profiles = {
  '0.2.0-rc.2': ['reviewed-composition.json', 'web/consumer-lock.yaml'],
  '0.2.1-rc.2': ['candidate-composition.json', 'web/candidates/0.2.1-rc.2/complete-lock.yaml'],
  '0.2.1-rc.5': ['rc5-composition.json', 'web/candidates/0.2.1-rc.5/complete-lock.yaml'],
};
const frozen = Object.fromEntries(Object.entries(profiles).map(([version, [recipe, lock]]) => {
  const recipeFile = path.join(repo, 'packages/adapter-dsh/delivery', recipe);
  const complete = JSON.parse(fs.readFileSync(recipeFile, 'utf8'));
  complete.dependencyManifests['@arlo/daemon@0.1.0'] = daemonManifestSha;
  fs.writeFileSync(recipeFile, JSON.stringify(complete, null, 2) + '\n');
  const { adapter, dependencyClosureSha256, ...host } = complete;
  return [version, { ...host, hostDependencyClosureSha256: dshHostLockSha256(yaml.load(fs.readFileSync(path.join(repo, lock), 'utf8'))) }];
}));
const output = path.join(repo, 'packages/daemon/setup-dsh/reviewed-hosts.json');
fs.writeFileSync(output, JSON.stringify(frozen, null, 2) + '\n');
console.log(output);
