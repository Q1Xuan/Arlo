import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createCliProcessFixture(prefix) {
  const root = process.env.ARLO_ACCEPTANCE_ROOT ?? os.tmpdir();
  const directory = fs.mkdtempSync(path.join(root, prefix));
  // Windows PowerShell initializes AppData/Roaming in USERPROFILE even for a
  // read-only command. Keep that OS profile separate from the command's target.
  const profile = process.platform === 'win32' ? fs.mkdtempSync(path.join(root, 'arlo-cli-profile-')) : directory;
  if (process.platform === 'win32') {
    // Native known-folder lookup returns an empty path if AppData/Local is
    // absent, causing PowerShell's module cache to fall back to the command cwd.
    for (const name of ['Local', 'Roaming']) fs.mkdirSync(path.join(profile, 'AppData', name), { recursive: true });
  }
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'].filter(key => process.env[key])
    .map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
    XDG_CONFIG_HOME: profile, XDG_DATA_HOME: profile, XDG_STATE_HOME: profile,
    XDG_CACHE_HOME: profile, XDG_RUNTIME_DIR: profile, DSH_HOME: profile, TERM: 'dumb' });
  return { directory, env, close: () => {
    fs.rmSync(directory, { recursive: true, force: true });
    if (profile !== directory) fs.rmSync(profile, { recursive: true, force: true });
  } };
}
