import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { inspectDshInstallation, installedPackage } from '../packages/daemon/setup-dsh/installed-host.mjs';
import { applyExactHunks, readExactPatch, sha256, packageInventory } from '../packages/daemon/setup-dsh/exact-patch.mjs';

// Maintainer-only generation from an ordinary, independently installed host.
// The compiled CLI consumes this immutable material; it never learns expected
// bytes from the user installation it is preparing.
const repo = path.resolve(import.meta.dirname, '..');
const [hostOption, selected, browserOption, browser] = process.argv.slice(2);
assert.equal(hostOption, '--ordinary-host');
assert.equal(browserOption, '--browser-modules');
const host = inspectDshInstallation(selected);
assert.equal(host.version, '0.2.1-rc.5');
const require = createRequire(path.join(host.directory, 'package.json'));
const ownerManifest = JSON.parse(fs.readFileSync(path.join(host.owner, 'package.json'), 'utf8'));
assert.equal(ownerManifest.pnpm?.patchedDependencies, undefined, 'Material generation starts before Arlo patches');
const reviewed = JSON.parse(fs.readFileSync(path.join(repo, 'packages/daemon/setup-dsh/reviewed-hosts.json'), 'utf8'))[host.version];
const output = path.join(repo, 'packages/daemon/setup-dsh/preparation-material', host.version);
fs.mkdirSync(output, { recursive: true });
const repairs = [
  ['dsh-api-session-controller', 'trusted-session-creation'],
  ['dsh-client-ui-conversation', 'browser-submit-preparation'],
  ['dsh-session-persistence-jsonl', 'native-backend-ownership'],
  ['dsh-session-format', 'type-repair'],
  ['dsh-host-open-in-app', 'environment-presentation-repair'],
].map(([name, category]) => {
  const file = `${name}@${host.version}.patch`;
  const patch = fs.readFileSync(path.join(repo, 'web/candidates', host.version, 'patches', file));
  assert.equal(sha256(patch), reviewed.patches[file], 'Only the reviewed exact version recipe is bundled');
  const identity = installedPackage(require, `@deepseek-ai/${name}`, host.owner);
  assert.equal(identity.version, host.version);
  const files = readExactPatch(patch).map(entry => {
    const before = fs.readFileSync(path.join(identity.directory, entry.file));
    const after = applyExactHunks(before, entry.hunks);
    assert.equal(sha256(after), reviewed.packages[`@deepseek-ai/${name}`].files[entry.file], `Reviewed executable/declaration postimage: ${name}/${entry.file}`);
    return { file: entry.file, beforeSha256: sha256(before), afterSha256: sha256(after) };
  });
  fs.writeFileSync(path.join(output, file), patch);
  return { name, category, packageName: `@deepseek-ai/${name}`, version: host.version,
    patch: file, sha256: sha256(patch), files };
});
const inventories = {};
const seen = new Set();
function collect(identity, installationOwner) {
  if (!identity || seen.has(identity.directory)) return;
  seen.add(identity.directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(identity.directory, 'package.json'), 'utf8'));
  if (manifest.name.startsWith('@deepseek-ai/dsh') || ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'].includes(manifest.name)) {
    const key = `${manifest.name}@${manifest.version}`;
    const inventory = packageInventory(identity.directory);
    if (inventories[key]) assert.deepEqual(inventory, inventories[key], 'A reviewed package cannot have divergent installed bytes');
    inventories[key] = inventory;
  }
  const currentRequire = createRequire(path.join(identity.directory, 'package.json'));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
    collect(installedPackage(currentRequire, name, installationOwner), installationOwner);
  }
}
collect({ directory: host.directory }, host.owner);
const browserOwner = fs.realpathSync(browser);
const browserRequire = createRequire(path.join(browserOwner, 'package.json'));
const supplements = {};
for (const name of ['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-slots']) {
  const identity = installedPackage(browserRequire, name, browserOwner);
  assert.equal(identity.version, host.version);
  for (const [file, digest] of Object.entries(reviewed.packages[name].files)) assert.equal(sha256(fs.readFileSync(path.join(identity.directory, file))), digest, `Reviewed ordinary browser supplement: ${name}/${file}`);
  collect(identity, browserOwner);
  supplements[name] = host.version;
}
const material = { schemaVersion: 1, hostVersion: host.version, repairs, supplements,
  packageInventories: Object.fromEntries(Object.entries(inventories).sort(([a], [b]) => a.localeCompare(b))) };
fs.writeFileSync(path.join(output, 'material.json'), JSON.stringify(material, null, 2) + '\n');
console.log(`Bundled ${repairs.length} reviewed repairs, ${Object.keys(supplements).length} browser supplements, ${Object.keys(inventories).length} immutable package inventories.`);
