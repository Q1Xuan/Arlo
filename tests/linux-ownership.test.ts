import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTempDir, removeTempDir } from './test-utils.ts';

const cli = fileURLToPath(new URL('../packages/daemon/bin/arlo.js', import.meta.url));
const isolated = process.platform === 'linux' && process.env.ARLO_OWNERSHIP_NAMESPACE === '1';

test('Linux CLI rejects real foreign-owned runtime and audit entries in an isolated user namespace', {
  skip: !isolated, timeout: 30000,
}, async t => {
  assert.equal(process.getuid!(), 0);
  assert.notEqual(fs.statSync('/foreign-file').uid, process.getuid!());
  for (const entry of ['runtime', 'ancestor', 'coordination.lock', 'daemon.lock', 'discovery.json', 'daemon.crt', 'daemon.key', 'bootstrap.token', 'daemon.log']) {
    await t.test(entry, () => {
      const root = createTempDir('foreign-owner');
      const runtimeBase = path.join(root, 'runtime');
      const runtime = path.join(runtimeBase, 'Arlo');
      const stateBase = path.join(root, 'state');
      const state = path.join(stateBase, 'Arlo');
      fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
      fs.mkdirSync(state, { recursive: true, mode: 0o700 });
      const directory = entry === 'runtime' || entry === 'ancestor';
      const target = entry === 'runtime' ? runtime : entry === 'ancestor' ? runtimeBase
        : path.join(entry === 'daemon.log' ? state : runtime, entry);
      if (!directory) fs.writeFileSync(target, '', { mode: 0o600 });
      cp.execFileSync('/usr/bin/mount', ['--bind', directory ? '/foreign-directory' : '/foreign-file', target]);
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: runtimeBase, XDG_STATE_HOME: stateBase };
        delete env.ARLO_STATE_DIR;
        const result = cp.spawnSync(process.execPath, [cli, 'serve', '--json'], {
          env, encoding: 'utf8', timeout: 5000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.equal(JSON.parse(result.stderr).error, 'INVALID_OWNERSHIP');
        assert.equal(result.stdout.includes('started'), false);
        assert.notEqual(fs.statSync(target).uid, process.getuid!(), 'foreign entry must remain untouched');
      } finally {
        cp.execFileSync('/usr/bin/umount', [target]);
        removeTempDir(root);
      }
    });
  }
});
