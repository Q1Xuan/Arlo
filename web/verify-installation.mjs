import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertIndependentConsumerLock, installedPackageEntry, verifyInstalledRuntime } from '../delivery/runtime-installation.mjs';

const consumerDirectory = path.resolve(import.meta.dirname, '..');
const consumerRequire = createRequire(path.join(consumerDirectory, 'package.json'));
const hostRequire = createRequire(consumerRequire.resolve('@deepseek-ai/dsh/package.json'));
assertIndependentConsumerLock(consumerDirectory);
const runtime = await verifyInstalledRuntime(consumerDirectory, hostRequire);
const contactEntry = installedPackageEntry(consumerDirectory, '@arlo/adapter-dsh');
const contactRequire = createRequire(contactEntry);
assert.equal(fs.realpathSync(contactRequire.resolve('@arlo/adapter-dsh/runtime')), fileURLToPath(runtime.entry),
  'The installed contact plugin must load the same DSH runtime');
assert.equal(fs.realpathSync(contactRequire.resolve('@deepseek-ai/cordis')), runtime.hostModuleIdentities['@deepseek-ai/cordis']);
const plugin = await import(contactEntry);
assert.equal(typeof plugin.apply, 'function');
const { requireDshWebComposition } = await import(pathToFileURL(consumerRequire.resolve('@arlo/adapter-dsh/delivery')).href);
const experimental = process.argv.includes('--experimental');
const composition = requireDshWebComposition(consumerDirectory, { experimental });
const adapterDirectory = path.dirname(fileURLToPath(contactEntry));
const adapterManifest = JSON.parse(fs.readFileSync(path.join(adapterDirectory, 'package.json'), 'utf8'));
assert.equal(adapterManifest.dsh.client.platform, 'web');
assert.ok(adapterManifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-gateway'));
assert.match(fs.readFileSync(path.join(adapterDirectory, adapterManifest.dsh.bundle.patch), 'utf8'),
  /name: '@arlo\/adapter-dsh'/u, 'The shipped bundle activates the actual Host plugin');
const consumerManifest = JSON.parse(fs.readFileSync(path.join(consumerDirectory, 'package.json'), 'utf8'));
assert.equal(Object.keys(consumerManifest.pnpm.patchedDependencies).length, 5);
for (const patch of Object.values(consumerManifest.pnpm.patchedDependencies)) {
  assert.deepEqual(fs.readFileSync(path.resolve(consumerDirectory, patch)),
    fs.readFileSync(path.join(adapterDirectory, ['0.2.1-rc.2', '0.2.1-rc.5'].includes(composition.hostVersion) ? 'delivery/candidate-patches' : 'patches', path.basename(patch))),
    'The installed composition uses the patches shipped in the same adapter tarball');
}
const { backend, abi, optionalPackageName } = hostRequire('node-addon-require-builtin').getBindingInfo();
console.log(JSON.stringify({ nativeBinding: { backend, abi, optionalPackageName }, runtime: { ...runtime, contactEntry } }));
