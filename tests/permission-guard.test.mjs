import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { test } from 'node:test';
import { installPermissionGuard } from './helpers/permission-guard.mjs';

function fixture(t, filesystemOverrides = {}) {
  // Windows TEMP can use RUNNER~1 while the native resolver returns the long
  // username. Operate on the canonical owned fixture; aliases stay refused.
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-permission-check-')));
  const root = path.join(parent, 'owned');
  fs.mkdirSync(root);
  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'owned');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const calls = [];
  // No real permission operation or OS command is executed by these tests.
  const filesystem = { ...fs, promises: { ...fs.promises },
    chmodSync: (...args) => calls.push(['chmod', ...args]),
    chownSync: (...args) => calls.push(['chown', ...args]),
    ...filesystemOverrides,
  };
  const processes = Object.fromEntries(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']
    .map(name => [name, (...args) => { calls.push([name, ...args]); return {}; }]));
  installPermissionGuard({ root, filesystem, processes });
  return { parent, root, file, calls, filesystem, processes };
}

test('the original parent-walk pattern is stopped before an unowned ACL command', t => {
  const f = fixture(t);
  let target = f.file;
  assert.throws(() => {
    for (let attempts = 0; attempts < 20; attempts++) {
      f.processes.execFileSync('icacls.exe', [target, '/inheritance:r', '/grant:r', '*S-1-5-21-1:(OI)(CI)F']);
      target = path.dirname(target);
    }
  }, /TEST_PERMISSION_BOUNDARY/);
  assert.deepEqual(f.calls.map(call => call[2][0]), [f.file, f.root]);
});

test('prefix siblings, traversal, symlinks and hardlinks cannot authorize permission changes', t => {
  const f = fixture(t);
  const sibling = `${f.root}-outside`;
  fs.mkdirSync(sibling);
  const link = path.join(f.root, 'escape');
  fs.symlinkSync(sibling, link, process.platform === 'win32' ? 'junction' : 'dir');
  const outsideFile = path.join(sibling, 'outside');
  fs.writeFileSync(outsideFile, 'outside');
  const hardlink = path.join(f.root, 'hardlink');
  fs.linkSync(outsideFile, hardlink);
  for (const target of [f.parent, sibling, path.join(f.root, '..'), link, path.join(link, 'outside'), hardlink]) {
    assert.throws(() => f.filesystem.chmodSync(target, 0o700), /TEST_PERMISSION_BOUNDARY/);
  }
  assert.deepEqual(f.calls, []);
});

test('Node permission APIs and icacls allow only existing owned targets', t => {
  const f = fixture(t);
  f.filesystem.chmodSync(f.file, 0o600);
  f.filesystem.chownSync(f.file, 1, 1);
  f.processes.execFileSync('C:\\Windows\\System32\\icacls.exe', [f.file, '/grant', '*S-1-1-0:R']);
  assert.equal(f.calls.length, 3);
  for (const args of [[f.file, '/restore', 'outside.acl'], [f.file, '/grant', '*S-1-1-0:R', '/T'],
    [path.join(f.root, '*'), '/reset'], [f.file, '/grant', '*S-1-1-0:R', f.parent]]) {
    assert.throws(() => f.processes.execFileSync('icacls.exe', args), /TEST_PERMISSION_BOUNDARY/);
  }
  assert.equal(f.calls.length, 3);
});

test('shells and alternate permission tools are refused before process execution', t => {
  const f = fixture(t);
  for (const command of ['chmod', '/usr/bin/chown', 'takeown.exe', 'cmd.exe', 'sh', 'bash', 'pwsh']) {
    assert.throws(() => f.processes.spawnSync(command, [f.parent]), /TEST_PERMISSION_BOUNDARY/);
  }
  assert.throws(() => f.processes.execSync('icacls C:\\Users /reset'), /TEST_PERMISSION_BOUNDARY/);
  assert.throws(() => f.processes.spawn('node', [], { shell: true }), /TEST_PERMISSION_BOUNDARY/);
  assert.throws(() => f.processes.execFileSync('powershell.exe', ['-Command', 'Set-Acl C:\\Users']), /TEST_PERMISSION_BOUNDARY/);
  assert.deepEqual(f.calls, []);
});

test('children with replacement environments retain the permission preload', t => {
  const f = fixture(t);
  f.processes.spawn(process.execPath, ['worker.mjs'], { env: { HOME: f.root } });
  const options = f.calls[0][3];
  assert.equal(options.env.ARLO_TEST_ROOT, f.root);
  assert.match(options.env.NODE_OPTIONS, /permission-preload\.mjs/);
  assert.equal(options.env.HOME, f.root);
});

test('the SDK read-only Windows inspection remains available', t => {
  const f = fixture(t);
  const source = fs.readFileSync(new URL('../packages/sdk/src/security/index.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const template = source.split('  const script = `')[1].split('`;')[0].replaceAll('\\\\', '\\');
  const script = template.replace(/^\$paths = @\(.*\)$/m, "$paths = @('C:\\Users\\test','C:\\Users\\test\\owned')");
  f.processes.execFileSync('powershell.exe', ['-NoProfile', '-Command', `& { ${script} }`]);
  assert.equal(f.calls.length, 1);
  assert.throws(() => f.processes.execFileSync('powershell.exe', ['-NoProfile', '-Command', `& { ${script}\nSet-Acl C:\\Users }`]), /TEST_PERMISSION_BOUNDARY/);
});

test('a real Node descendant refuses an outside chmod with a replacement environment', t => {
  const f = fixture(t);
  const canary = path.join(f.parent, 'canary');
  fs.writeFileSync(canary, 'must keep its permissions', { mode: 0o640 });
  const before = fs.statSync(canary).mode;
  const program = `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    const target = process.argv[1];
    assert.throws(() => fs.chmodSync(target, 0o600), /TEST_PERMISSION_BOUNDARY/);
    assert.throws(() => cp.execFileSync('icacls.exe', [target, '/inheritance:r']), /TEST_PERMISSION_BOUNDARY/);
    const child = cp.spawnSync(process.execPath, ['--input-type=module', '-e',
      "import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.throws(() => fs.chmodSync(process.argv[1], 384), /TEST_PERMISSION_BOUNDARY/)", target],
      {env: {}, encoding: 'utf8'});
    assert.equal(child.status, 0, child.stderr);
  `;
  const child = cp.spawnSync(process.execPath, ['--import', new URL('./permission-preload.mjs', import.meta.url).href,
    '--input-type=module', '-e', program, canary], { env: { SystemRoot: process.env.SystemRoot }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.statSync(canary).mode, before);
});

test('ownership checks use native realpath for Windows extended-length paths', t => {
  // The JS Windows realpath walker can fail with lstat C: for a \\?\ path.
  // Exercise the actual guard call site while keeping native OS commands fake.
  const realpathSync = Object.assign(() => { throw new Error('legacy realpath cannot resolve extended path'); },
    { native: fs.realpathSync.native });
  const f = fixture(t, { realpathSync });
  f.filesystem.chmodSync(path.toNamespacedPath(f.file), 0o600);
  assert.equal(f.calls.length, 1);
  assert.throws(() => f.filesystem.chmodSync(f.parent, 0o600), /TEST_PERMISSION_BOUNDARY/);
  assert.equal(f.calls.length, 1);
});
