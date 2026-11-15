import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createCliProcessFixture(prefix) {
  const directory = fs.mkdtempSync(path.join(process.env.ARLO_ACCEPTANCE_ROOT ?? os.tmpdir(), prefix));
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'].filter(key => process.env[key])
    .map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory, XDG_STATE_HOME: directory,
    XDG_CACHE_HOME: directory, XDG_RUNTIME_DIR: directory, DSH_HOME: directory, TERM: 'dumb' });
  return { directory, env, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
