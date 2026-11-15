import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertIndependentConsumerLock, verifyInstalledRuntime } from './runtime-installation.mjs';

const consumerDirectory = path.resolve(import.meta.dirname, '..');

test('Installed private consumer lock contains no workspace importers', () => {
  assertIndependentConsumerLock(consumerDirectory);
});

test('Installed DSH adapter keeps its runtime entry separate and shares host module identities', async () => {
  await verifyInstalledRuntime(consumerDirectory);
});

test('Installed private packages expose JavaScript, declarations and a working diagnostic CLI', async () => {
  for (const name of ['sdk', 'adapter-sdk', 'daemon', 'adapter-dsh']) {
    const entry = fileURLToPath(import.meta.resolve(`@arlo/${name}${name === 'adapter-dsh' ? '/runtime' : ''}`));
    assert.ok(entry.endsWith('.js'), 'Installed packages must run without TypeScript source loading');
    const directory = path.resolve(path.dirname(entry), '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.private, true);
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      assert.ok(fs.existsSync(path.join(directory, target.types)), `${name}${subpath} has declarations`);
      // The native Host plugin requires the full Web composition, verified by
      // web/verify-installation.mjs. Runtime-only consumers do not install it.
      if (name === 'adapter-dsh' && subpath === '.') continue;
      await import(`@arlo/${name}${subpath === '.' ? '' : subpath.slice(1)}`);
    }
    assert.ok(Object.values(manifest.dependencies).every(version => /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)),
      'Published dependency metadata must use exact versions');
  }
  const { ArloDaemon } = await import('@arlo/daemon');
  const { enforceWindowsAcl } = await import('@arlo/sdk');
  const stateDir = fs.mkdtempSync(path.join(process.env.ARLO_ACCEPTANCE_ROOT, 'cli-state-'));
  enforceWindowsAcl(stateDir, true);
  fs.chmodSync(stateDir, 0o700);
  const daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    // Keep the server's event loop free while the real CLI performs HTTPS requests.
    const { spawn } = await import('node:child_process');
    const cli = fileURLToPath(new URL('../bin/arlo.js', import.meta.resolve('@arlo/daemon')));
    // The package entry is src/index.js, so bin is its sibling directory.
    for (const command of ['status', 'doctor']) {
      const child = spawn(process.execPath, [cli, command, '--json', '--state-dir', stateDir], {
        env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      assert.equal(code, 0, `${command} succeeds from the installed CLI`);
      const report = JSON.parse(output);
      assert.equal(command === 'status' ? report.status : report.overall_status, command === 'status' ? 'ready' : 'healthy');
    }
  } finally {
    await daemon.stop();
  }
});
