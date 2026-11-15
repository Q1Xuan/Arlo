import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Bootstrap also runs before any workspace dependencies are installed.
import { enforceWindowsAcl } from '../packages/sdk/src/security/index.ts';

export const privateRuntimePackages = ['sdk', 'adapter-sdk', 'daemon', 'adapter-dsh'];

/** Keep only the consumer importer; preserve all reviewed resolution bytes. */
export function consumerLockSeed(lock) {
  const section = lock.match(/^importers:\r?\n([\s\S]*?)(?=^\S)/m);
  assert.ok(section, 'Expected pnpm v9 importers');
  const body = section[1];
  const importers = [...body.matchAll(/^  (\S[^\r\n]*):\r?$/gm)];
  const root = importers.findIndex(match => match[1] === '.');
  assert.ok(root >= 0, 'Expected a root consumer importer');
  const header = section[0].slice(0, section[0].length - body.length) + body.slice(0, importers[0].index);
  const rootBlock = body.slice(importers[root].index, importers[root + 1]?.index);
  return lock.slice(0, section.index) + header + rootBlock + lock.slice(section.index + section[0].length);
}

/** Private build state shared by the core and Web delivery entry points. */
export function createPrivateBuildEnvironment({ prefix, metadata, offlineCache, npmrc }) {
  const resources = fs.mkdtempSync(path.join(os.homedir(), prefix));
  enforceWindowsAcl(resources, true);
  if (process.platform !== 'win32') fs.chmodSync(resources, 0o700);
  fs.writeFileSync(path.join(resources, '.arlo-owner.json'), JSON.stringify(metadata, null, 2) + '\n');
  const dirs = Object.fromEntries(['home', 'config', 'cache', 'data', 'state', 'runtime', 'temp', 'logs'].map(name => {
    const directory = path.join(resources, name);
    fs.mkdirSync(directory, { mode: 0o700 });
    return [name, directory];
  }));
  if (process.platform === 'win32') {
    // PowerShell's native known-folder lookup needs these private profile
    // folders; otherwise its module cache falls back to the package cwd.
    for (const name of ['Local', 'Roaming']) fs.mkdirSync(path.join(dirs.home, 'AppData', name), { recursive: true });
  }
  const isolatedOfflineCache = path.join(dirs.cache, 'pnpm');
  if (offlineCache) fs.cpSync(offlineCache, isolatedOfflineCache, { recursive: true });
  fs.writeFileSync(path.join(dirs.config, 'npmrc'), npmrc);
  fs.writeFileSync(path.join(dirs.config, 'gitconfig'), '');
  const env = {
    PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
    HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.config, LOCALAPPDATA: dirs.data,
    XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state, XDG_RUNTIME_DIR: dirs.runtime, DSH_HOME: dirs.home,
    TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp,
    NPM_CONFIG_USERCONFIG: path.join(dirs.config, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(dirs.config, 'npmrc'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dirs.config, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
    COREPACK_ENABLE_NETWORK: '0', CI: 'true',
  };
  return { resources, dirs, isolatedOfflineCache, env };
}

/** Enumerate regular package files deterministically, rejecting workspace links. */
export function filesIn(directory, { excludeNodeModules = false } = {}) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => !excludeNodeModules || entry.name !== 'node_modules')
    .sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      assert.ok(!entry.isSymbolicLink(), 'Delivery must contain regular files, never workspace links');
      return entry.isDirectory()
        ? filesIn(path.join(directory, entry.name), { excludeNodeModules }).map(file => `${entry.name}/${file}`)
        : [entry.name];
    });
}
