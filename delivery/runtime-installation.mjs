import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function assertIndependentConsumerLock(consumerDirectory) {
  const lock = fs.readFileSync(path.join(consumerDirectory, 'pnpm-lock.yaml'), 'utf8');
  const importers = lock.match(/^importers:\r?\n([\s\S]*?)(?=^\S)/m)?.[1];
  assert.ok(importers, 'The installed consumer has a pnpm lockfile');
  assert.deepEqual([...importers.matchAll(/^  (\S[^\r\n]*):\r?$/gm)].map(match => match[1]), ['.'],
    'An independent consumer must not retain repository workspace packages');
}

/** Resolve from the specified installation even when this verifier is elsewhere. */
export function installedPackageEntry(consumerDirectory, name) {
  const consumerRequire = createRequire(path.join(consumerDirectory, 'package.json'));
  const entry = fs.realpathSync(consumerRequire.resolve(name));
  const relative = path.relative(path.join(consumerDirectory, 'node_modules'), entry);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `${name} must load from the private installation, without workspace fallback`);
  return pathToFileURL(entry).href;
}

export async function verifyInstalledRuntime(consumerDirectory, hostRequire) {
  const consumerRequire = createRequire(path.join(consumerDirectory, 'package.json'));
  hostRequire ??= consumerRequire;
  const entry = installedPackageEntry(consumerDirectory, '@arlo/adapter-dsh/runtime');
  assert.equal(typeof (await import(entry)).createArloHarnessPlugin, 'function');
  const entryFile = fileURLToPath(entry);
  assert.ok(entryFile.endsWith(path.join('src', 'runtime.js')));
  const directory = path.resolve(path.dirname(entryFile), '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './client', './delivery', './runtime']);
  assert.ok(fs.existsSync(path.join(directory, manifest.exports['./runtime'].types)));
  for (const subpath of ['.', './client', './delivery']) {
    assert.ok(fs.existsSync(path.join(directory, manifest.exports[subpath].types)));
    assert.ok(fs.existsSync(path.join(directory, manifest.exports[subpath].default)));
  }
  assert.throws(() => consumerRequire.resolve('@arlo/dsh-contact'), { code: 'MODULE_NOT_FOUND' });
  assert.throws(() => consumerRequire.resolve('@arlo/harness-adapter'), { code: 'MODULE_NOT_FOUND' });
  assert.ok(!fs.readdirSync(path.join(consumerDirectory, 'node_modules/.pnpm'))
    .some(name => /^@arlo\+(?:harness-adapter|dsh-contact)@/.test(name)),
    'Removed packages must not be installed transitively');
  const runtimeRequire = createRequire(entry);
  const hostModuleIdentities = {};
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']) {
    const resolved = fs.realpathSync(hostRequire.resolve(name));
    assert.equal(fs.realpathSync(runtimeRequire.resolve(name)), resolved,
      `${name} must have the same module identity in the Host and installed runtime`);
    hostModuleIdentities[name] = resolved;
  }
  return { entry, hostModuleIdentities };
}
