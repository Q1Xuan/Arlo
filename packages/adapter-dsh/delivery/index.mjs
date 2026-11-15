import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export { patchWebPrimitives } from './patch-web-primitives.mjs';
export { inspectDshWebComposition, requireDshWebComposition, dshInstallationDirectory, requireDshHostContracts } from './compatibility.mjs';

/** This adapter supports only the reviewed, patched DSH installation. */
export const dshVersion = '0.2.0-rc.2';
export const dshWebDependencies = {
  ...Object.fromEntries([
    'dsh', 'dsh-typert-protocol', 'dsh-client-ui-input-trigger', 'dsh-client-locale',
    'dsh-api-gateway', 'dsh-typert-registry', 'dsh-session-title',
    'dsh-client-ui-slots', 'dsh-client-modules',
  ].map(name => [`@deepseek-ai/${name}`, dshVersion])),
  '@deepseek-ai/schemastery': '3.18.4',
  '@types/react': '18.3.1',
};

const patchFiles = [
  'dsh-host-open-in-app@0.2.0-rc.2.patch',
  'dsh-client-ui-conversation@0.2.0-rc.2.patch',
  'dsh-api-session-controller@0.2.0-rc.2.patch',
  'dsh-client-ui-primitives@0.2.0-rc.2.patch',
  'dsh-session-format@0.2.0-rc.2.patch',
];

/** Materialize the adapter-owned patches before the private consumer resolves. */
export function prepareDshWebConsumer(bundle) {
  const directory = path.join(bundle, 'patches');
  fs.mkdirSync(directory);
  for (const file of patchFiles) {
    fs.copyFileSync(path.join(import.meta.dirname, '../patches', file), path.join(directory, file));
  }
  return {
    patchedDependencies: Object.fromEntries(patchFiles.map(file => [
      `@deepseek-ai/${file.slice(0, -6)}`, `../patches/${file}`,
    ])),
    files: patchFiles.map(file => `patches/${file}`),
  };
}

export function verifyDshVersion(version) {
  assert.equal(version, dshVersion, 'Use the reviewed DSH version and adapter patches');
}

export function dshCliPath(consumer) {
  const consumerRequire = createRequire(path.join(consumer, 'package.json'));
  return path.join(path.dirname(consumerRequire.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
}
