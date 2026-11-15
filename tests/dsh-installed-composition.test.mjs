import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

// Run against a new private build before native acceptance. Restore every
// controlled corruption so the same installation can then exercise the Host.
const consumer = process.env.ARLO_DSH_COMPOSITION_CONSUMER;
test('formal installed DSH composition retains all integrity gates', { skip: !consumer }, async t => {
  const require = createRequire(path.join(path.resolve(consumer), 'package.json'));
  const delivery = await import(pathToFileURL(require.resolve('@arlo/adapter-dsh/delivery')).href);
  const hostManifest = require.resolve('@deepseek-ai/dsh/package.json');
  const hostRequire = createRequire(hostManifest);
  const initial = delivery.requireDshWebComposition(consumer);
  assert.equal(initial.formallySupported, true);
  assert.equal(initial.mode, 'verified');
  assert.equal(delivery.requireDshWebComposition(consumer, { experimental: true }).formallySupported, false);

  const manifest = JSON.parse(fs.readFileSync(path.join(consumer, 'package.json'), 'utf8'));
  const frontend = path.join(path.dirname(hostRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist/index.html');
  for (const [name, file, transform, code] of [
    ['unknown host', hostManifest, value => JSON.stringify({ ...JSON.parse(value), version: '0.2.99' }), 'DSH_PACKAGE_MISMATCH'],
    ['changed dependency', hostRequire.resolve('@deepseek-ai/dsh-agent/package.json'), value => JSON.stringify({ ...JSON.parse(value), version: '0.2.99' }), 'DSH_PACKAGE_MISMATCH'],
    ['changed routing', hostManifest, value => JSON.stringify({ ...JSON.parse(value), main: './unreviewed.js' }), 'DSH_ENTRY_MISMATCH'],
    ['changed patch', path.resolve(consumer, Object.values(manifest.pnpm.patchedDependencies)[0]), value => `${value}\n`, 'DSH_PATCH_MISMATCH'],
    ['changed browser resources', frontend, value => `${value}\n`, 'DSH_RESOURCE_MISMATCH'],
  ]) {
    await t.test(name, () => {
      const original = fs.readFileSync(file);
      const replacement = `${file}.arlo-integrity-test`;
      const replace = bytes => {
        fs.writeFileSync(replacement, bytes);
        fs.renameSync(replacement, file);
      };
      try {
        replace(transform(original.toString('utf8')));
        const report = delivery.inspectDshWebComposition(consumer);
        assert.equal(report.ready, false);
        assert.equal(report.formallySupported, false);
        assert.ok(report.checks.some(check => !check.ok && check.code === code));
        assert.throws(() => delivery.requireDshWebComposition(consumer));
      } finally { replace(original); }
      assert.equal(delivery.requireDshWebComposition(consumer).combination, initial.combination);
    });
  }
});
