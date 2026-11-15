import cp from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, linkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const root = process.env.ARLO_ACCEPTANCE_ROOT;
const owner = process.env.ARLO_ACCEPTANCE_OWNER;
if (!root || !owner || JSON.parse(readFileSync(path.join(root, '.arlo-owner.json'), 'utf8')).owner !== owner) {
  throw new Error('ACCEPTANCE_RESOURCE_OWNERSHIP_REQUIRED');
}
const processes = path.join(root, 'processes');
mkdirSync(processes, { recursive: true });
const instance = `${process.pid}-${randomUUID()}`;
writeFileSync(path.join(processes, `${instance}.process.json`), JSON.stringify({
  instance,
  owner, pid: process.pid, parentPid: process.ppid, startedAt: new Date().toISOString(),
  node: process.version, platform: process.platform,
}));
const networkFile = path.join(processes, `${instance}.network.json`);
process.env.ARLO_LOW_LEVEL_NETWORK_FILE = process.env.ARLO_ACCEPTANCE_NETWORK_DIR
  ? path.join(process.env.ARLO_ACCEPTANCE_NETWORK_DIR, `${process.pid}.json`)
  : process.env.ARLO_LOW_LEVEL_NETWORK_FILE || networkFile;
if (process.env.ARLO_LOW_LEVEL_NETWORK_FILE !== networkFile) {
  const relative = path.relative(root, process.env.ARLO_LOW_LEVEL_NETWORK_FILE);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('NETWORK_EVIDENCE_MUST_BE_RUN_OWNED');
  // A recycled PID must not reset a prior process's retained hardlink counter.
  if (existsSync(process.env.ARLO_LOW_LEVEL_NETWORK_FILE)) unlinkSync(process.env.ARLO_LOW_LEVEL_NETWORK_FILE);
}
await import('../probes/isolation.mjs');
if (process.env.ARLO_LOW_LEVEL_NETWORK_FILE !== networkFile) {
  // The fixture may remove its directory after force-stopping an owned daemon.
  // Keep the synchronously updated counters alive through the run's own link.
  linkSync(process.env.ARLO_LOW_LEVEL_NETWORK_FILE, networkFile);
}

// Worker fixtures deliberately construct their own small environments. Propagate
// the guard to those Node processes too, without copying the caller's credentials.
function guarded(options = {}) {
  const env = { ...(options.env ?? process.env) };
  env.ARLO_ACCEPTANCE_ROOT = root;
  env.ARLO_ACCEPTANCE_OWNER = owner;
  if (env.ARLO_LOW_LEVEL_NETWORK_FILE === process.env.ARLO_LOW_LEVEL_NETWORK_FILE) delete env.ARLO_LOW_LEVEL_NETWORK_FILE;
  env.NODE_OPTIONS = `--import=${import.meta.url}`;
  return { ...options, env, windowsHide: true };
}
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[name];
  cp[name] = function(command, args, options, callback) {
    if (!Array.isArray(args)) {
      callback = typeof args === 'function' ? args : options;
      options = typeof args === 'object' ? args : {};
      args = [];
    } else if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    return original.call(this, command, args, guarded(options), ...(callback ? [callback] : []));
  };
  if (original[promisify.custom]) {
    cp[name][promisify.custom] = function(command, args, options) {
      if (!Array.isArray(args)) { options = args; args = []; }
      return original[promisify.custom].call(this, command, args, guarded(options));
    };
  }
}
const fork = cp.fork;
cp.fork = function(modulePath, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  return fork.call(this, modulePath, args, guarded(options));
};
syncBuiltinESMExports();
