import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { ArloDaemon } from '@arlo/daemon';
import { enforceWindowsAcl } from '@arlo/sdk';

test('three installed packages expose every compiled export and preserve dependency direction', async () => {
  const bundle = JSON.parse(fs.readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
  const allowed = {
    sdk: ['@modelcontextprotocol/client'],
    'adapter-sdk': ['@arlo/sdk'],
    daemon: ['@arlo/sdk'],
  };
  for (const [name, dependencies] of Object.entries(allowed)) {
    const entry = fileURLToPath(import.meta.resolve(`@arlo/${name}`));
    assert.ok(entry.endsWith('.js'), 'Installed entry must be compiled JavaScript');
    const directory = path.resolve(path.dirname(entry), '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const installedFiles = fs.readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(file => file.isFile()).map(file => path.relative(directory, path.join(file.parentPath, file.name)).replaceAll('\\', '/')).sort();
    assert.deepEqual(installedFiles, [...bundle.inventories[manifest.name]].sort(), 'Tarball installation preserves the complete emitted package inventory');
    assert.equal(manifest.private, bundle.distribution?.kind !== 'release-candidate');
    if (bundle.distribution?.kind === 'release-candidate') assert.equal(manifest.publishConfig.access, 'public');
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), dependencies);
    for (const [key, target] of Object.entries(manifest.exports)) {
      assert.ok(target.types.endsWith('.d.ts') && fs.existsSync(path.join(directory, target.types)));
      assert.ok(target.default.endsWith('.js'));
      await import(`@arlo/${name}${key === '.' ? '' : key.slice(1)}`);
    }
    assert.ok(Object.values(manifest.dependencies).every(version => /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)));
    // Supplement the installed graph with emitted-code checks: an undeclared
    // sibling dependency must not be masked by installing all three together.
    for (const file of fs.readdirSync(path.join(directory, 'src'), { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !/\.(?:js|d\.ts)$/.test(file.name)) continue;
      const source = fs.readFileSync(path.join(file.parentPath, file.name), 'utf8');
      for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        assert.ok(dependencies.includes(packageName), `${name} has an undeclared import: ${specifier}`);
      }
    }
  }
});

test('installed status and doctor authenticate the actual daemon in an isolated state directory', { timeout: 30000 }, async () => {
  const stateDir = fs.mkdtempSync(path.join(process.env.ARLO_ACCEPTANCE_ROOT, 'cli-state-'));
  enforceWindowsAcl(stateDir, true);
  const daemon = new ArloDaemon({ stateDir });
  try {
    await daemon.start();
    const cli = fileURLToPath(new URL('../bin/arlo.js', import.meta.resolve('@arlo/daemon')));
    for (const command of ['status', 'doctor']) {
      const child = spawn(process.execPath, [cli, command, '--json', '--state-dir', stateDir], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
      });
      let output = '';
      let errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
      assert.equal(code, 0, errors);
      const report = JSON.parse(output);
      assert.equal(command === 'status' ? report.status : report.overall_status, command === 'status' ? 'ready' : 'healthy');
    }
  } finally {
    await daemon.stop();
  }
});
