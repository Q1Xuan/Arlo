import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('Linux namespace ownership acceptance executes all foreign-owner rejections and the authenticated XDG positive control', {
  skip: process.platform !== 'linux', timeout: 60000,
}, t => {
  const available = spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--net', 'true'], {
    encoding: 'utf8', timeout: 5000,
  });
  if (available.status !== 0) { t.skip('Unprivileged user/mount/PID/network namespaces unavailable'); return; }
  const script = fileURLToPath(new URL('./run-linux-ownership.sh', import.meta.url));
  // Read-only LF normalization also works in Windows-created source snapshots.
  const result = spawnSync('bash', ['-c', fs.readFileSync(script, 'utf8').replaceAll('\r\n', '\n'), script], {
    env: { ...process.env, ARLO_OWNERSHIP_JSON: '1' },
    encoding: 'utf8', timeout: 50000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  const tests = records.filter(record => record.event === 'test:pass' || record.event === 'test:fail');
  assert.equal(tests.length, 11, 'Nine foreign-owner cases, parent and authenticated XDG positive control must run');
  assert.ok(tests.every(record => record.status === 'passed'));
  const network = records.find(record => record.event === 'namespace-network');
  assert.ok(network.processCount >= 12, 'Test runners and real CLI descendants must be guarded');
  assert.equal(network.deniedConnections, 0);
  const directory = process.env.ARLO_ACCEPTANCE_EVIDENCE_DIR;
  if (directory) fs.writeFileSync(path.join(directory, 'linux-ownership.json'), JSON.stringify({
    scope: 'Unprivileged user/mount/PID/network namespace; only invoking UID mapped; loopback only; no host accounts',
    tests: tests.map(({ name, status }) => ({ name, status })), network,
  }));
});
