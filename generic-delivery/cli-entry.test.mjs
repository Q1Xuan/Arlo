import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const consumer = process.env.ARLO_CLI_CONSUMER_DIR;
const npx = process.env.ARLO_NPX_CLI;
const terminalDriver = fileURLToPath(new URL('../tests/fixtures/cli-terminal.py', import.meta.url));

test('standard npx executes the installed compiled bin outside the source workspace without installing a host', {
  skip: !consumer || !npx,
}, () => {
  const directory = fs.mkdtempSync(path.join(process.env.ARLO_ACCEPTANCE_ROOT ?? os.tmpdir(), 'arlo-npx-'));
  const npmrc = path.join(directory, 'npmrc');
  fs.writeFileSync(npmrc, '');
  const globalNpmrc = path.join(directory, 'global-npmrc');
  fs.writeFileSync(globalNpmrc, '');
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'].filter(key => process.env[key])
    .map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    XDG_CONFIG_HOME: directory, XDG_STATE_HOME: directory, XDG_DATA_HOME: directory,
    NPM_CONFIG_USERCONFIG: npmrc, NPM_CONFIG_GLOBALCONFIG: globalNpmrc, NPM_CONFIG_CACHE: path.join(directory, 'cache'),
    NPM_CONFIG_UPDATE_NOTIFIER: 'false', TERM: 'dumb' });
  const argv = [process.execPath, npx, '--offline', '--no', '--loglevel=silent', '--', 'arlo'];
  try {
    const result = spawnSync(argv[0], [...argv.slice(1), '--json', '--state-dir', path.join(directory, 'state')],
      { cwd: consumer, env, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { error: 'DAEMON_NOT_RUNNING' });
    assert.equal(fs.existsSync(path.join(directory, 'state')), false);
    if (process.platform !== 'win32') {
      const cancelled = spawnSync('python3', [terminalDriver, JSON.stringify(argv), JSON.stringify([['Choose an action', '0\n']])],
        { cwd: consumer, env, encoding: 'utf8', timeout: 15_000 });
      assert.equal(cancelled.status, 0, cancelled.stderr + cancelled.stdout);
      assert.match(cancelled.stdout, /Cancelled/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
