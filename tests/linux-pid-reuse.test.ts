import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDir, removeTempDir } from './test-utils.ts';
import { namespaceUnavailable } from './helpers/linux-namespace-capability.mjs';

test('Linux actual recycled PID cannot inherit daemon ownership or be killed during stale-lock recovery', {
  skip: process.platform !== 'linux', timeout: 90000,
}, t => {
  const root = createTempDir('linux-actual-pid-reuse');
  try {
    const owner = randomUUID();
    const jail = path.join(root, 'namespace');
    fs.mkdirSync(jail, { mode: 0o700 });
    const isolation = path.join(jail, 'isolation');
    fs.mkdirSync(isolation, { mode: 0o700 });
    fs.writeFileSync(path.join(isolation, '.arlo-owner.json'), JSON.stringify({ owner }));
    for (const name of ['home', 'config', 'data', 'cache', 'state', 'runtime', 'temp']) {
      const directory = path.join(jail, name);
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    const launcher = fileURLToPath(new URL('./fixtures/linux-pid-reuse.sh', import.meta.url));
    const namespace = [
      '--user', '--map-root-user', '--mount', '--pid', '--fork', '--kill-child=SIGKILL', '--mount-proc',
      '/bin/bash', '-c', fs.readFileSync(launcher, 'utf8').replaceAll('\r\n', '\n'), launcher,
      jail, process.execPath, fileURLToPath(new URL('../', import.meta.url)), owner,
    ];
    const options = { cwd: root, encoding: 'utf8' as const, timeout: 60000, killSignal: 'SIGKILL' as const };
    const probe = spawnSync('/usr/bin/unshare', [...namespace, '--input-type=module', '--eval', `
      import fs from 'node:fs';
      try {
        const file = '/proc/sys/kernel/ns_last_pid';
        fs.writeFileSync(file, fs.readFileSync(file));
        process.stdout.write(JSON.stringify({ available: true }));
      } catch (error) {
        if (!['EACCES', 'EPERM', 'EROFS', 'ENOENT'].includes(error.code)) throw error;
        process.stdout.write(JSON.stringify({ available: false, reason: error.code }));
      }
    `], options);
    if (namespaceUnavailable(probe)) {
      t.skip('Unprivileged user/mount/PID namespace unavailable; actual Linux PID reuse remains unverified');
      return;
    }
    assert.equal(probe.error, undefined);
    assert.equal(probe.status, 0, probe.stderr);
    const capability = JSON.parse(probe.stdout);
    if (!capability.available) {
      t.skip(`Namespace-local ns_last_pid is unavailable (${capability.reason}); actual Linux PID reuse remains unverified`);
      return;
    }
    const result = spawnSync('/usr/bin/unshare', [...namespace,
      '/repo/tests/fixtures/linux-pid-reuse.ts',
      String(process.getuid!()), fs.readlinkSync('/proc/self/ns/pid'),
    ], options);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.originalPid, evidence.reusedPid);
    assert.ok(BigInt(evidence.reusedStartTicks) > BigInt(evidence.originalStartTicks));
    assert.equal(evidence.staleFilesUnmodified, true);
    assert.equal(evidence.replacementAlive, true);
    assert.equal(evidence.authenticatedRecovery, true);
    const files = fs.readdirSync(path.join(isolation, 'processes'));
    const processes = files.filter(file => file.endsWith('.process.json')).map(file =>
      JSON.parse(fs.readFileSync(path.join(isolation, 'processes', file), 'utf8')));
    assert.ok(processes.length >= 5, 'Probe, fixture, two real daemons and status command must be guarded');
    for (const record of processes) {
      assert.equal(record.owner, owner);
      const network = JSON.parse(fs.readFileSync(path.join(isolation, 'processes', `${record.instance}.network.json`), 'utf8'));
      assert.equal(network.deniedConnections, 0);
    }
    const report = {
      ...evidence,
      isolation: { separateNamespaceAccounting: true, processCount: processes.length, deniedConnections: 0,
        boundary: 'Owned user/mount/PID namespace, one mapped caller UID; guarded Node networking; native sleep has no network activity.' },
    };
    t.diagnostic(JSON.stringify(report));
    if (process.env.ARLO_ACCEPTANCE_EVIDENCE_DIR) {
      fs.writeFileSync(path.join(process.env.ARLO_ACCEPTANCE_EVIDENCE_DIR, 'pid-reuse.json'), JSON.stringify(report, null, 2) + '\n');
    }
  } finally { removeTempDir(root); }
});
