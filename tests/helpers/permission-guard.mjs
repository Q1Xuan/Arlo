import fs from 'node:fs';
import cp from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const preload = new URL('../permission-preload.mjs', import.meta.url).href;
const mutex = fileURLToPath(new URL('../../packages/daemon/src/storage/windows-mutex.ps1', import.meta.url));
const consoleFixture = fileURLToPath(new URL('../fixtures/windows-console.ps1', import.meta.url));
const ownershipNamespace = fileURLToPath(new URL('../run-linux-ownership.sh', import.meta.url));

function refuse() { throw new Error('TEST_PERMISSION_BOUNDARY: refusing an unowned permission operation or unguarded shell'); }

// Match ordinary and extended-length Windows paths using the same spelling.
function canonical(value) {
  const resolved = path.resolve(value instanceof URL ? fileURLToPath(value) : value);
  return process.platform === 'win32' ? path.toNamespacedPath(resolved).toLowerCase() : resolved;
}

export function installPermissionGuard({ root, owner, filesystem = fs, processes = cp }) {
  // Node's JS realpath walker can reject \\?\ Windows paths with lstat C:.
  // The native resolver accepts both spellings; the lstat walk below still
  // rejects reparse points and hardlinks before a permission operation.
  const realpath = filesystem.realpathSync.native ?? filesystem.realpathSync;
  const boundary = canonical(realpath(root));
  const inside = value => value === boundary || value.startsWith(`${boundary}${path.sep}`);
  function assertOwned(target) {
    if (!(typeof target === 'string' || target instanceof URL || Buffer.isBuffer(target))) refuse();
    const filename = Buffer.isBuffer(target) ? target.toString() : target;
    const absolute = canonical(filename);
    const withoutNamespace = absolute.startsWith('\\\\?\\') ? absolute.slice(4) : absolute;
    if (!inside(absolute) || /[*?]/.test(withoutNamespace)) refuse();
    // Reject aliases before any chmod/icacls call, including junctions in parents.
    for (let current = path.resolve(filename instanceof URL ? fileURLToPath(filename) : filename);;) {
      const stat = filesystem.lstatSync(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) refuse();
      if (canonical(current) === boundary) break;
      const parent = path.dirname(current);
      if (parent === current) refuse();
      current = parent;
    }
    if (!inside(canonical(realpath(filename)))) refuse();
  }

  for (const name of ['chmod', 'chmodSync', 'chown', 'chownSync', 'lchown', 'lchownSync', 'lchmod', 'lchmodSync']) {
    if (!filesystem[name]) continue;
    const original = filesystem[name];
    filesystem[name] = function(target, ...args) { assertOwned(target); return original.call(this, target, ...args); };
  }
  // Descriptor APIs cannot prove a pathname is still the same owned inode.
  for (const name of ['fchmod', 'fchmodSync', 'fchown', 'fchownSync']) if (filesystem[name]) filesystem[name] = refuse;
  for (const name of ['chmod', 'chown', 'lchown', 'lchmod']) {
    if (!filesystem.promises[name]) continue;
    const original = filesystem.promises[name];
    filesystem.promises[name] = async function(target, ...args) { assertOwned(target); return original.call(this, target, ...args); };
  }
  const open = filesystem.promises.open;
  filesystem.promises.open = async function(...args) {
    const handle = await open.apply(this, args);
    handle.chmod = handle.chown = async () => refuse();
    return handle;
  };

  function powershell(args) {
    const index = args.indexOf('-Command');
    if (index < 0 || index !== args.length - 2 || args.slice(0, index).some(arg => !['-NoProfile', '-NonInteractive'].includes(arg))) refuse();
    const script = args[index + 1].replaceAll('\r\n', '\n');
    if (script === '& { [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }') return;
    // Pin the SDK's read-only ACL inspection, substituting only single-quoted
    // path literals. Unknown PowerShell programs cannot run under this guard.
    const normalized = script.replace(/^\$paths = @\((?:'(?:[^']|'')*'(?:,'(?:[^']|'')*')*)?\)$/m, '$paths = @(<paths>)');
    if (createHash('sha256').update(normalized).digest('hex') === '308299abc0b60bdb43810626b9a805d293364667e2acebbeed435f54a0c1abb6') return;
    if (/^try \{ \$f = \[System\.IO\.File\]::OpenRead\('(?:[^']|'')*'\); \$f\.Dispose\(\); exit 0 \} catch \{ exit 1 \}$/.test(script)) return;
    refuse();
  }
  function checkCommand(command, args, options) {
    if (options?.shell) refuse();
    const name = path.win32.basename(String(command)).toLowerCase().replace(/\.exe$/, '');
    // This existing launcher enters a user/mount/PID/network namespace and
    // read-only chroot. Permit its exact reviewed source, never arbitrary bash.
    if (name === 'bash' && args.length === 3 && args[0] === '-c' &&
        canonical(args[2]) === canonical(ownershipNamespace) &&
        args[1] === filesystem.readFileSync(ownershipNamespace, 'utf8').replaceAll('\r\n', '\n')) return { HOME: root };
    if (['sh', 'bash', 'dash', 'zsh', 'cmd', 'pwsh', 'chmod', 'chown', 'chgrp', 'takeown', 'setfacl', 'cacls'].includes(name)) refuse();
    if (name === 'powershell') {
      // The shipped mutex helper has no filesystem permission operations.
      const index = args.indexOf('-File');
      if (index >= 0 && args.slice(0, index).some(arg => !['-NoProfile', '-NonInteractive'].includes(arg))) refuse();
      if (index >= 0 && canonical(args[index + 1] ?? '') === canonical(mutex)) return;
      if (index >= 0 && canonical(args[index + 1] ?? '') === canonical(consoleFixture)) {
        const state = args.indexOf('-StateDir');
        if (state >= 0) assertOwned(args[state + 1]);
        return;
      }
      powershell(args);
    }
    if (name !== 'icacls') return;
    assertOwned(args[0]);
    const switches = new Map([['/inheritance:r', 0], ['/grant:r', 1], ['/grant', 1], ['/deny', 1],
      ['/remove:g', 1], ['/remove:d', 1], ['/setowner', 1]]);
    if (args.length < 2) refuse();
    for (let index = 1; index < args.length; index++) {
      const count = switches.get(String(args[index]).toLowerCase());
      if (count === undefined) refuse();
      if (count && (typeof args[++index] !== 'string' || !/^\*S-1-[\d-]+(?::[A-Z(),]+)?$/i.test(args[index]))) refuse();
    }
  }
  function guarded(options = {}, overrides = {}) {
    const env = { ...(options.env ?? process.env), ...overrides, ARLO_TEST_ROOT: root, ARLO_TEST_OWNER: owner };
    const option = `--import=${preload}`;
    env.NODE_OPTIONS = [env.NODE_OPTIONS, option].filter(Boolean).join(' ');
    return { ...options, env };
  }
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = processes[name];
    processes[name] = function(command, args, options, callback) {
      if (!Array.isArray(args)) { callback = typeof args === 'function' ? args : options; options = typeof args === 'object' ? args : {}; args = []; }
      if (typeof options === 'function') { callback = options; options = {}; }
      const overrides = checkCommand(command, args, options);
      return original.call(this, command, args, guarded(options, overrides), ...(callback ? [callback] : []));
    };
    if (original[promisify.custom]) processes[name][promisify.custom] = function(command, args, options) {
      if (!Array.isArray(args)) { options = args; args = []; }
      const overrides = checkCommand(command, args, options);
      return original[promisify.custom].call(this, command, args, guarded(options, overrides));
    };
  }
  const fork = processes.fork;
  processes.fork = function(modulePath, args, options) {
    if (!Array.isArray(args)) { options = args; args = []; }
    if (options?.shell) refuse();
    return fork.call(this, modulePath, args, guarded(options));
  };
  processes.exec = processes.execSync = refuse;
  if (filesystem === fs && processes === cp) syncBuiltinESMExports();
  return { assertOwned };
}
