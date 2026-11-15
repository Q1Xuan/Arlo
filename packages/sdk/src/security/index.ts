import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { ArloErrorCode, ArloError } from '../protocol/index.ts';

let cachedCurrentUserSid: string | undefined;
const WINDOWS_NATIVE_TIMEOUT_MS = 10000;

// Windows PowerShell must not inherit PowerShell 7's incompatible built-in modules.
export function windowsPowerShellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  env.PSModulePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return env;
}

export function getCurrentUserSid(): string {
  if (cachedCurrentUserSid) {
    return cachedCurrentUserSid;
  }

  if (process.platform === 'win32') {
    try {
      const output = cp.execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user'], {
        encoding: 'utf8',
        windowsHide: true, timeout: WINDOWS_NATIVE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = output.match(/S-1-[0-59]-\d+(?:-\d+)+/);
      if (match) {
        cachedCurrentUserSid = match[0];
        return cachedCurrentUserSid;
      }
    } catch {
      // fallback to powershell
    }

    try {
      const psOutput = cp.execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '& { [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }'],
        {
          encoding: 'utf8',
          windowsHide: true, timeout: WINDOWS_NATIVE_TIMEOUT_MS,
          env: windowsPowerShellEnv(),
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ).trim();
      if (psOutput && psOutput.startsWith('S-1-')) {
        cachedCurrentUserSid = psOutput;
        return cachedCurrentUserSid;
      }
      throw new ArloError(ArloErrorCode.INVALID_OWNERSHIP);
    } catch {
      throw new ArloError(ArloErrorCode.INVALID_OWNERSHIP, 'Unable to determine current user SID');
    }
  }

  // The legacy API name is SID-based, but POSIX ownership is a kernel UID.
  // Never derive a lock owner from spoofable USER/USERNAME environment values.
  if (!process.getuid) throw new ArloError(ArloErrorCode.INVALID_OWNERSHIP);
  cachedCurrentUserSid = String(process.getuid());
  return cachedCurrentUserSid;
}

export interface WindowsAclInspection {
  owner: string;
  rules: string[];
  isReparse: boolean;
  canRead?: boolean;
}

// One Windows PowerShell process is about two seconds, and a startup spike past
// the old per-call limit came back as an empty inspection. UNSAFE_LOCATION then
// rejected a path that had not actually been read. Keep one read-only inspector
// for this process and fail closed if it still cannot answer.
const WINDOWS_ACL_TIMEOUT_MS = 30000;
interface AclPipe {
  child: cp.ChildProcess;
  fd?: number;
  pipePath: string;
  pid: number;
}
let aclPipe: AclPipe | undefined;

function armWindowsProcessTimeout(pid: number, deadline: number): () => void {
  const flag = new Int32Array(new SharedArrayBuffer(8));
  const watchdog = new Worker(`
    import('node:worker_threads').then(({ workerData }) => {
      const flag = new Int32Array(workerData.flag);
      Atomics.store(flag, 1, 1);
      Atomics.notify(flag, 1);
      if (Atomics.wait(flag, 0, 0, Math.max(0, workerData.deadline - Date.now())) === 'timed-out' && Atomics.load(flag, 0) === 0) {
        try { process.kill(workerData.pid); } catch {}
      }
    });
  `, { eval: true, execArgv: [], workerData: { flag: flag.buffer, pid, deadline } });
  // Parent-only flags (such as --input-type=module) must not disable the timer.
  // The main thread cannot receive a Worker error during a synchronous pipe
  // read, so confirm initialization before allowing any blocking pipe I/O.
  watchdog.on('error', () => {});
  watchdog.unref();
  const disarm = () => {
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    void watchdog.terminate().catch(() => {});
  };
  if (Atomics.load(flag, 1) === 0) {
    Atomics.wait(flag, 1, 0, Math.max(0, deadline - Date.now()));
  }
  if (Atomics.load(flag, 1) !== 1) {
    disarm();
    throw new Error('ACL watchdog did not initialize');
  }
  return disarm;
}

function resetAclPipe(): void {
  const current = aclPipe;
  aclPipe = undefined;
  if (!current) return;
  try { if (current.fd !== undefined) fs.closeSync(current.fd); } catch { /* already closed */ }
  try { current.child.kill(); } catch { /* already exited */ }
}

function aclInspectorScript(): string {
  // Pipe name stays in the environment so this text can stay pinned by the test guard.
  const script = `
$ErrorActionPreference = 'Stop'
$name = $env:ARLO_ACL_PIPE
if (-not $name) { exit 1 }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = [System.IO.Pipes.PipeAccessRule]::new($sid, [System.IO.Pipes.PipeAccessRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
$security = [System.IO.Pipes.PipeSecurity]::new()
$security.AddAccessRule($rule)
$server = [System.IO.Pipes.NamedPipeServerStream]::new($name, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::None, 65536, 65536, $security)
function Read-Request([System.IO.Stream] $stream) {
  $bytes = New-Object System.Collections.Generic.List[byte]
  while ($true) {
    $value = $stream.ReadByte()
    if ($value -lt 0) { return $null }
    if ($value -eq 10) { break }
    if ($value -ne 13) { [void]$bytes.Add([byte]$value) }
  }
  return [System.Text.Encoding]::UTF8.GetString($bytes.ToArray())
}
$server.WaitForConnection()
try {
  while ($true) {
    $line = Read-Request $server
    if ($null -eq $line -or $line -eq 'exit') { break }
    # ConvertFrom-Json already returns the array. Assigning @(...) nests it, so a later foreach sees one array instead of each path.
    $parsed = ConvertFrom-Json -InputObject $line
    $res = @{}
    foreach ($item in @($parsed)) {
      $p = [string]$item
      if (Microsoft.PowerShell.Management\\Test-Path -LiteralPath $p) {
        try {
          $acl = Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $p
          $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
          $rules = @()
          foreach ($r in $acl.Access) {
            try {
              $sid = $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
              $rules += ($sid + ':' + $r.AccessControlType + ':' + $r.FileSystemRights + ':' + $r.PropagationFlags + ':' + [int]$r.FileSystemRights)
            } catch { throw }
          }
          $item = Microsoft.PowerShell.Management\\Get-Item -LiteralPath $p -Force
          $isReparse = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
          $canRead = $false
          try {
            if ($item.PSIsContainer) {
              $entries = [System.IO.Directory]::EnumerateFileSystemEntries($p).GetEnumerator()
              try { $null = $entries.MoveNext() } finally { $entries.Dispose() }
            } else {
              $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
              $stream = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
              $stream.Dispose()
            }
            $canRead = $true
          } catch {}
          $res[$p] = @{ owner = $owner; rules = $rules; isReparse = $isReparse; canRead = $canRead }
        } catch {}
      }
    }
    $json = $res | Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress
    if (-not $json) { $json = '{}' }
    $payload = [System.Text.Encoding]::UTF8.GetBytes($json + [string][char]10)
    $server.Write($payload, 0, $payload.Length)
    $server.Flush()
  }
} finally {
  $server.Dispose()
}
`;
  return script;
}

function ensureAclPipe(): AclPipe {
  if (aclPipe && aclPipe.child.exitCode === null && aclPipe.child.signalCode === null && !aclPipe.child.killed && aclPipe.pid > 0) return aclPipe;
  resetAclPipe();
  // A predictable global pipe name lets another local user pre-create a server
  // and forge ACL results. Keep this per-inspector capability unguessable.
  const pipeName = `ArloAcl-${randomUUID()}`;
  const env = windowsPowerShellEnv();
  env.ARLO_ACL_PIPE = pipeName;
  const child = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${aclInspectorScript()} }`], {
    windowsHide: true, env, stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  const pipe: AclPipe = { child, pipePath: `\\\\.\\pipe\\${pipeName}`, pid: child.pid ?? 0 };
  child.once('exit', () => {
    if (aclPipe !== pipe) return;
    try { if (pipe.fd !== undefined) fs.closeSync(pipe.fd); } catch { /* already closed */ }
    aclPipe = undefined;
  });
  child.once('error', () => {
    if (aclPipe === pipe) resetAclPipe();
  });
  aclPipe = pipe;
  return pipe;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const wrote = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (wrote <= 0) throw new Error('ACL pipe write failed');
    offset += wrote;
  }
}

function readAclLine(fd: number): string {
  const buffer = Buffer.alloc(65536);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const n = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (n <= 0) break;
    total += n;
    if (total > 1024 * 1024) throw new Error('ACL response exceeded 1MB');
    chunks.push(Buffer.from(buffer.subarray(0, n)));
    if (buffer.subarray(0, n).includes(10)) break;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const newline = text.indexOf('\n');
  if (newline < 0 || newline !== text.length - 1) throw new Error('ACL response was not one line');
  const line = text.slice(0, newline).replace(/\r$/, '');
  if (!line) throw new Error('empty ACL response');
  return line;
}

function requestWindowsAcl(paths: string[]): string {
  const pipe = ensureAclPipe();
  if (pipe.pid <= 0) throw new Error('ACL inspector did not start');
  const deadline = Date.now() + WINDOWS_ACL_TIMEOUT_MS;
  const disarm = armWindowsProcessTimeout(pipe.pid, deadline);
  try {
    if (pipe.fd === undefined) {
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          pipe.fd = fs.openSync(pipe.pipePath, 'r+');
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (pipe.child.exitCode !== null) break;
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'EPIPE') break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
      }
      if (pipe.fd === undefined) throw lastError instanceof Error ? lastError : new Error('ACL inspector did not accept a connection');
    }
    writeAll(pipe.fd, Buffer.from(`${JSON.stringify(paths)}\n`));
    return readAclLine(pipe.fd);
  } finally {
    disarm();
  }
}

function windowsAclInspection(paths: string[]): Record<string, WindowsAclInspection> {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      last = requestWindowsAcl(paths);
      const parsed = JSON.parse(last) as Record<string, WindowsAclInspection>;
      if (paths.every(p => parsed[p])) return parsed;
    } catch {
      last = '';
    }
    resetAclPipe();
  }
  if (!last) return {};
  try { return JSON.parse(last) as Record<string, WindowsAclInspection>; } catch { return {}; }
}

process.on('exit', resetAclPipe);

export function inspectWindowsAclBatch(paths: string[]): Record<string, WindowsAclInspection> {
  if (process.platform !== 'win32') {
    const result: Record<string, WindowsAclInspection> = {};
    for (const p of paths) {
      if (fs.existsSync(p)) {
        const stat = fs.lstatSync(p);
        result[p] = {
          owner: String(stat.uid),
          rules: [],
          isReparse: stat.isSymbolicLink(),
        };
      }
    }
    return result;
  }

  const existingPaths = paths.filter((p) => fs.existsSync(p));
  if (existingPaths.length === 0) return {};
  return windowsAclInspection(existingPaths);
}

export function enforceWindowsAcl(targetPath: string, isDirectory: boolean): void {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(targetPath, isDirectory ? 0o700 : 0o600);
    } catch {}
    return;
  }

  const userSid = getCurrentUserSid();
  const grantArg = isDirectory ? `*${userSid}:(OI)(CI)F` : `*${userSid}:F`;

  try {
    cp.execFileSync('icacls.exe', [targetPath, '/inheritance:r', '/grant:r', grantArg], {
      windowsHide: true, timeout: WINDOWS_NATIVE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new ArloError(
      ArloErrorCode.INSECURE_PERMISSIONS,
      'Failed to enforce Windows ACL'
    );
  }
}

export interface AclVerificationResult {
  valid: boolean;
  errorCode?: ArloErrorCode;
  detail?: string;
}

const FORBIDDEN_SIDS = new Set([
  'S-1-1-0', // Everyone
  'S-1-5-11', // Authenticated Users
  'S-1-5-32-545', // BUILTIN\Users
  'S-1-5-7', // Anonymous
  'S-1-5-32-546', // Guests
]);

const TRUSTED_ADMIN_SIDS = new Set([
  'S-1-5-18', // NT AUTHORITY\SYSTEM
  'S-1-5-32-544', // BUILTIN\Administrators
]);

export function verifyWindowsAcl(targetPath: string, inspection?: WindowsAclInspection): AclVerificationResult {
  if (!fs.existsSync(targetPath)) {
    return { valid: false, errorCode: ArloErrorCode.CORRUPTED_STATE, detail: 'Target does not exist' };
  }

  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      return { valid: false, errorCode: ArloErrorCode.UNSAFE_LOCATION, detail: 'Target is a symbolic link' };
    }
  } catch {
    return { valid: false, errorCode: ArloErrorCode.CORRUPTED_STATE, detail: 'Failed to stat target' };
  }

  if (process.platform !== 'win32') {
    const stat = fs.lstatSync(targetPath);
    if (stat.uid !== process.getuid?.()) {
      return { valid: false, errorCode: ArloErrorCode.INVALID_OWNERSHIP };
    }
    if ((!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
      return { valid: false, errorCode: ArloErrorCode.UNSAFE_LOCATION };
    }
    const expected = stat.isDirectory() ? 0o700 : 0o600;
    if ((stat.mode & 0o7777) !== expected) {
      return { valid: false, errorCode: ArloErrorCode.INSECURE_PERMISSIONS, detail: 'Invalid private Unix permissions' };
    }
    return { valid: true };
  }

  const acl = inspection ?? inspectWindowsAclBatch([targetPath])[targetPath];
  if (!acl) {
    return { valid: false, errorCode: ArloErrorCode.CORRUPTED_STATE, detail: 'Unable to read Windows ACL' };
  }

  if (acl.isReparse) {
    return { valid: false, errorCode: ArloErrorCode.UNSAFE_LOCATION, detail: 'Target is a reparse point or junction' };
  }

  const currentUserSid = getCurrentUserSid();
  const isOwnerValid = acl.owner === currentUserSid || TRUSTED_ADMIN_SIDS.has(acl.owner);
  if (!isOwnerValid) {
    return {
      valid: false,
      errorCode: ArloErrorCode.INVALID_OWNERSHIP,
      detail: `File owner ${acl.owner} does not match current user ${currentUserSid}`,
    };
  }

  for (const rule of acl.rules) {
    const [sid, type] = rule.split(':');
    if (type !== 'Allow') continue;

    if (FORBIDDEN_SIDS.has(sid)) {
      return {
        valid: false,
        errorCode: ArloErrorCode.INSECURE_PERMISSIONS,
        detail: `Forbidden group or public SID granted access: ${sid}`,
      };
    }

    const isAuthorized = sid === currentUserSid || TRUSTED_ADMIN_SIDS.has(sid);
    if (!isAuthorized) {
      return {
        valid: false,
        errorCode: ArloErrorCode.INSECURE_PERMISSIONS,
        detail: `Unauthorized SID granted access: ${sid}`,
      };
    }
  }

  // Node's Windows file opens can bypass a Deny ACE when backup privileges
  // are enabled. The native inspection also probes ordinary access without
  // backup semantics and without reading any file contents.
  if (acl.canRead === false) {
    return { valid: false, errorCode: ArloErrorCode.INSECURE_PERMISSIONS, detail: 'Current user cannot read target' };
  }

  // Recheck access after inspection in case the target changed in between.
  try {
    if (fs.statSync(targetPath).isDirectory()) {
      fs.readdirSync(targetPath);
    } else {
      const fd = fs.openSync(targetPath, 'r');
      fs.closeSync(fd);
    }
  } catch {
    return { valid: false, errorCode: ArloErrorCode.INSECURE_PERMISSIONS, detail: 'Current user cannot read target' };
  }

  return { valid: true };
}

export function assertSafeStatePath(stateDir: string): void {
  const leaf = path.resolve(stateDir);
  const ancestors: string[] = [];
  for (let current = leaf; ; current = path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ArloError(ArloErrorCode.UNSAFE_LOCATION);
      ancestors.push(current);
    } catch (error) {
      if (error instanceof ArloError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ArloError(ArloErrorCode.UNSAFE_LOCATION);
    }
    if (path.dirname(current) === current) break;
  }
  const inspections = inspectWindowsAclBatch(ancestors);
  for (const ancestor of ancestors) {
    if (ancestor === leaf) {
      const check = verifyWindowsAcl(leaf, inspections[leaf]);
      if (!check.valid) throw new ArloError(check.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS);
      continue;
    }
    if (process.platform !== 'win32') {
      const stat = fs.statSync(ancestor);
      if (stat.uid !== 0 && stat.uid !== process.getuid?.()) throw new ArloError(ArloErrorCode.INVALID_OWNERSHIP);
      // A sticky shared temporary root cannot replace another user's children.
      if ((stat.mode & 0o022) && !(stat.mode & 0o1000)) throw new ArloError(ArloErrorCode.UNSAFE_LOCATION);
      continue;
    }
    const acl = inspections[ancestor];
    if (!acl || acl.isReparse) throw new ArloError(ArloErrorCode.UNSAFE_LOCATION);
    const trusted = (sid: string) => sid === getCurrentUserSid() || TRUSTED_ADMIN_SIDS.has(sid);
    const trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
    if (!trusted(acl.owner) && acl.owner !== trustedInstaller) throw new ArloError(ArloErrorCode.INVALID_OWNERSHIP);
    for (const rule of acl.rules) {
      const [sid, type, , propagation, mask] = rule.split(':');
      if (type !== 'Allow' || trusted(sid) || propagation?.includes('InheritOnly')) continue;
      // DELETE_CHILD, DELETE, WRITE_DAC and WRITE_OWNER permit replacing a
      // protected child or changing an ancestor's protection. Read is harmless.
      if ((Number(mask) & 0x100d0040) !== 0) throw new ArloError(ArloErrorCode.UNSAFE_LOCATION);
    }
  }
}
