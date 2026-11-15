import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Run the public runtime regressions against installed packages, with no source
// package fallback. Native browser/TTY acceptance remains a separate requirement.
const repo = path.resolve(import.meta.dirname, '..');
const consumer = path.resolve(process.argv[2]);
const require = createRequire(path.join(consumer, 'package.json'));
const delivery = await import(pathToFileURL(require.resolve('@arlo/adapter-dsh/delivery')).href);
delivery.requireDshWebComposition(consumer, { experimental: true });
const root = fs.mkdtempSync(path.join(repo, '.scratch/installed-dsh-'));
const files = ['tests/dsh-tool-contract.test.ts', 'tests/dsh-root-configuration.test.ts',
  'tests/dsh-initial-allowance.test.ts', 'tests/harness-adapter-lifecycle.test.ts',
  'tests/harness-connection-recovery.test.ts', 'tests/harness-unicast-regressions.test.ts',
  'tests/test-utils.ts', 'tests/permission-preload.mjs', 'tests/helpers/permission-guard.mjs',
  'tests/helpers/message-status-fixture.ts', 'tests/helpers/authorized-control.ts', 'probes/fixture.ts'];
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
fs.symlinkSync(path.join(consumer, 'node_modules'), path.join(root, 'node_modules'), 'junction');
for (const file of files) {
  let source = fs.readFileSync(path.join(repo, file), 'utf8');
  source = source.replace("import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';",
    "import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';");
  source = source.replace("const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl');",
    "const JsonlSessionPersistence = await import('@deepseek-ai/dsh-session-persistence-jsonl');");
  // The candidate publishes a module plugin and a checked ownership accessor,
  // rather than the baseline's concrete constructor. Use those public faces.
  source = source.replace(/(persistence|originalBackend|foreignBackend) instanceof JsonlSessionPersistence/gu,
    'JsonlSessionPersistence.ownershipOf($1)');
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), source);
}
for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-tools', '@arlo/adapter-dsh/runtime']) {
  const entry = fs.realpathSync(createRequire(path.join(root, 'package.json')).resolve(name));
  assert.ok(entry.startsWith(fs.realpathSync(path.join(consumer, 'node_modules')) + path.sep), 'Installed runtime only');
}
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
  ...files.filter(file => file.endsWith('.test.ts')).map(file => path.join(root, file))], {
  cwd: root, stdio: 'inherit', env: process.env, timeout: 180000,
});
console.log(`Installed runtime harness retained: ${root}`);
process.exitCode = result.status ?? 1;
