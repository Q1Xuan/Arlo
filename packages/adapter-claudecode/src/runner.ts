import childProcess from 'node:child_process';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStateDir } from '@arlo/sdk';
import {
  bridgeBootstrapPath,
  publishExhaustedBridgeBootstrap,
  SIDECAR_RECOVERY_ATTEMPTS,
  SIDECAR_RECOVERY_BUDGET_MS,
  SIDECAR_RECOVERY_INITIAL_BACKOFF_MS,
  SIDECAR_RECOVERY_MAX_BACKOFF_MS,
} from './bridge-bootstrap.ts';
import { CLAUDE_CODE_VERSION } from './contract.ts';

export interface SpawnedChildProcess extends Pick<EventEmitter, 'on' | 'once' | 'removeListener'> {
  pid?: number;
  killed?: boolean;
  exitCode?: number | null;
  signalCode?: string | null;
  stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  connected?: boolean;
  send?(message: { type: 'shutdown' }, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFunction = (
  command: string,
  args: string[],
  options: { env?: Record<string, string | undefined>; stdio?: childProcess.StdioOptions; cwd?: string; windowsHide?: boolean },
) => SpawnedChildProcess;

export interface RunnerLaunchOptions {
  sessionId: string;
  claudeCommand?: string;
  claudeArgs?: string[];
  sidecarScript?: string;
  spawnFn?: SpawnFunction;
  stateDir?: string;
  groupName?: string;
  cwd?: string;
  crossHostEnabled?: boolean;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface ClaudeCodeRunnerHandle {
  readonly sessionId: string;
  readonly bridgeUrl: string;
  readonly token: string;
  readonly bridgeBootstrapPath?: string;
  readonly sidecarProcess: SpawnedChildProcess;
  readonly claudeProcess: SpawnedChildProcess;
  stop(): Promise<void>;
}

function launchEnvironment(overrides: RunnerLaunchOptions['env']): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (process.platform === 'win32') {
      for (const existing of Object.keys(env)) if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    }
    env[key] = value;
  }
  return env;
}

function isFile(candidate: string): boolean {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

// Node cannot execute npm's .cmd/.ps1 shims directly. Locate the package's
// native binary instead of passing user arguments through a shell.
function claudeExecutable(command: string, env: Record<string, string | undefined>, cwd: string): string {
  if (process.platform !== 'win32') return command;
  const hasPath = /[\\/]/.test(command);
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const directories = hasPath ? [path.dirname(path.resolve(cwd, command))] : searchPath.split(path.delimiter).filter(Boolean);
  const name = path.basename(command);
  for (const directory of directories) {
    const candidate = path.resolve(directory, name);
    if (/\.exe$/i.test(candidate) && isFile(candidate)) return candidate;
    if (!path.extname(name) && isFile(`${candidate}.exe`)) return `${candidate}.exe`;
    if (/^claude(?:\.(?:cmd|ps1))?$/i.test(name)) {
      const native = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (isFile(native)) return path.resolve(native);
    }
  }
  throw new Error('Cannot find the Claude Code native executable; set claudeCommand to its absolute .exe path');
}

function hostArguments(options: RunnerLaunchOptions, cwd: string, env: Record<string, string | undefined>): string[] {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.sessionId)) {
    throw new Error('sessionId must be a UUID for a new Claude Code session');
  }
  const args = [...options.claudeArgs ?? []];
  const forbidden = new Set([
    '-p', '--print', '-c', '--continue', '-r', '--resume', '--fork-session', '--from-pr', '--teleport',
    '--input-format', '--output-format', '--no-session-persistence', '--bg', '--background', '--cloud',
    '--desktop', '--environment', '--worktree', '-w', '--tmux', '--safe-mode', '--bare', '--disable-plugins',
    '--help', '-h', '--version', '-v', '--',
  ]);
  for (const arg of args) {
    if (forbidden.has(arg.split('=')[0]!) || /^-[^-]*[pcrw][^-]*$/.test(arg)) {
      throw new Error(`The runner requires a fresh interactive session with plugins enabled; unsupported argument: ${arg}`);
    }
  }
  if (['CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_SIMPLE'].some(key => /^(?:1|true)$/i.test(env[key] ?? ''))) {
    throw new Error('The runner requires Claude Code plugins to be enabled');
  }
  const modDirectory = fileURLToPath(new URL('../mod', import.meta.url));
  if (!isFile(path.join(modDirectory, '.claude-plugin', 'plugin.json')) || !isFile(path.join(modDirectory, 'hooks', 'hooks.json'))) {
    throw new Error('The shipped Claude Code Mod is missing');
  }
  let boundSession = false;
  let loadedMod = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const flag = arg.split('=')[0];
    if (flag !== '--session-id' && flag !== '--plugin-dir') continue;
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index];
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
    if (flag === '--session-id') {
      if (boundSession || value !== options.sessionId) throw new Error('--session-id must match the runner sessionId exactly once');
      boundSession = true;
    } else {
      const candidate = path.resolve(cwd, value);
      loadedMod ||= process.platform === 'win32'
        ? candidate.toLowerCase() === modDirectory.toLowerCase()
        : candidate === modDirectory;
    }
  }
  if (!boundSession) args.push('--session-id', options.sessionId);
  if (!loadedMod) args.push('--plugin-dir', modDirectory);
  return args;
}

interface ManagedChild {
  process: SpawnedChildProcess;
  started: Promise<void>;
  closed: Promise<{ code: number | null; error?: Error }>;
  ended: boolean;
}

function manage(process: SpawnedChildProcess): ManagedChild {
  let started!: () => void;
  let failed!: (error: Error) => void;
  let closed!: (value: { code: number | null; error?: Error }) => void;
  const child: ManagedChild = {
    process,
    started: new Promise<void>((resolve, reject) => { started = resolve; failed = reject; }),
    closed: new Promise(resolve => { closed = resolve; }),
    ended: false,
  };
  // A spawn error can arrive while another startup await is in progress.
  void child.started.catch(() => {});
  process.once('spawn', started);
  process.on('error', (error: Error) => {
    failed(error);
    if (!process.pid) child.ended = true;
    closed({ code: null, error });
  });
  process.once('exit', () => { child.ended = true; });
  process.once('close', (code: number | null) => {
    child.ended = true;
    failed(new Error('Child process exited before starting'));
    closed({ code });
  });
  return child;
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${label}`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

interface SidecarObservation {
  ready: Promise<{ url: string; token: string; bootstrapPath?: string }>;
  attached: Promise<void>;
  rejectAttached(error: Error): void;
}

function observeSidecar(child: ManagedChild, launchSessionId: string): SidecarObservation {
  let readyResolve!: (bridge: { url: string; token: string; bootstrapPath?: string }) => void;
  let readyReject!: (error: Error) => void;
  let attachedResolve!: () => void;
  let attachedReject!: (error: Error) => void;
  const ready = new Promise<{ url: string; token: string; bootstrapPath?: string }>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const attached = new Promise<void>((resolve, reject) => {
    attachedResolve = resolve;
    attachedReject = reject;
  });
  void ready.catch(() => {});
  void attached.catch(() => {});
  let buffer = '';
  let bridge: { url: string; token: string; bootstrapPath?: string } | undefined;
  let sawAttachment = false;
  const finish = () => {
    if (bridge) readyResolve(bridge);
    if (sawAttachment) attachedResolve();
  };
  child.process.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 65536) {
      readyReject(new Error('Sidecar readiness output exceeded its limit'));
      attachedReject(new Error('Sidecar readiness output exceeded its limit'));
      return;
    }
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let data: { type?: string; url?: string; token?: string; sessionId?: string; launchSessionId?: string; bootstrapPath?: string };
      try {
        data = JSON.parse(line) as typeof data;
      } catch {
        continue;
      }
      if (data.type === 'ready' && data.url && data.token) {
        let url: URL;
        try {
          url = new URL(data.url);
        } catch {
          readyReject(new Error('Sidecar reported an invalid loopback bridge URL'));
          continue;
        }
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) {
          readyReject(new Error('Sidecar reported an invalid loopback bridge URL'));
          continue;
        }
        if (data.bootstrapPath !== undefined && (typeof data.bootstrapPath !== 'string' || !data.bootstrapPath || data.bootstrapPath.includes('\0'))) {
          readyReject(new Error('Sidecar reported an invalid bootstrap path'));
          continue;
        }
        bridge = { url: data.url, token: data.token, ...(data.bootstrapPath ? { bootstrapPath: data.bootstrapPath } : {}) };
        finish();
      }
      if (data.type === 'attached') {
        const launch = data.launchSessionId ?? data.sessionId;
        if (launch !== launchSessionId) attachedReject(new Error('Sidecar attached to a different session'));
        else { sawAttachment = true; finish(); }
      }
    }
  });
  void child.closed.then(result => {
    const error = result.error ?? new Error('Sidecar exited during startup');
    readyReject(error);
    attachedReject(error);
  });
  return { ready, attached, rejectAttached: attachedReject };
}

async function stopChild(child: ManagedChild, graceful = false): Promise<void> {
  if (child.ended) return;
  if (graceful && child.process.connected && child.process.send) {
    try { child.process.send({ type: 'shutdown' }, () => {}); } catch {}
    try { await deadline(child.closed, 1000, 'Sidecar shutdown'); } catch {}
    if (child.ended) return;
  }
  try { child.process.kill('SIGTERM'); } catch {}
  try { await deadline(child.closed, 1000, 'child exit'); } catch {}
  if (!child.ended) {
    try { child.process.kill('SIGKILL'); } catch {}
    await deadline(child.closed, 1000, 'child termination');
  }
}

async function probeVersion(spawn: SpawnFunction, command: string, env: Record<string, string | undefined>, cwd: string, timeoutMs: number): Promise<void> {
  const child = manage(spawn(command, ['--version'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  let output = '';
  child.process.stdout?.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(0, 8192); });
  try {
    await deadline(child.started, timeoutMs, 'Claude Code version probe');
    const result = await deadline(child.closed, timeoutMs, 'Claude Code version probe');
    if (result.error) throw result.error;
    if (result.code !== 0 || ![CLAUDE_CODE_VERSION, `${CLAUDE_CODE_VERSION} (Claude Code)`].includes(output.trim())) {
      throw new Error(`Claude Code ${CLAUDE_CODE_VERSION} is required`);
    }
  } finally {
    await stopChild(child);
  }
}

export async function launchClaudeCodeWithSidecar(options: RunnerLaunchOptions): Promise<ClaudeCodeRunnerHandle> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd must be a directory');
  const env = launchEnvironment(options.env);
  const args = hostArguments(options, cwd, env);
  if (!options.spawnFn && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('The Claude Code runner requires an interactive terminal for stdin and stdout');
  }
  const spawn = options.spawnFn ?? childProcess.spawn as SpawnFunction;
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  const command = claudeExecutable(options.claudeCommand ?? 'claude', env, cwd);
  await probeVersion(spawn, command, env, cwd, timeoutMs);

  const sidecarEnv: Record<string, string | undefined> = {
    ...env,
    ARLO_CLAUDECODE_SESSION_ID: options.sessionId,
    ARLO_CLAUDECODE_STATE_DIR: options.stateDir ? path.resolve(cwd, options.stateDir) : undefined,
    ARLO_CLAUDECODE_GROUP_NAME: options.groupName,
    ARLO_CLAUDECODE_CWD: cwd,
    ARLO_CLAUDECODE_CROSS_HOST_ENABLED: options.crossHostEnabled ? '1' : '0',
    ARLO_CLAUDECODE_STARTUP_TIMEOUT_MS: String(timeoutMs),
  };
  delete sidecarEnv.ARLO_CLAUDECODE_BRIDGE_TOKEN;
  delete sidecarEnv.ARLO_CLAUDECODE_BRIDGE_URL;
  const sidecarScript = options.sidecarScript ?? fileURLToPath(new URL('./sidecar-cli.ts', import.meta.url));
  const spawnSidecar = () => manage(spawn(process.execPath, [sidecarScript], {
    env: sidecarEnv, cwd, stdio: ['ignore', 'pipe', 'inherit', 'ipc'], windowsHide: true,
  }));
  let current = spawnSidecar();
  let host: ManagedChild | undefined;
  let stopping: Promise<void> | undefined;
  let halting = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let spawning = false;
  let generation = 0;
  let incident: { started: number; attempts: number } | undefined;
  let bridge = { url: '', token: '' };
  let bootstrapPath = options.stateDir
    ? bridgeBootstrapPath(resolveStateDir(path.resolve(cwd, options.stateDir)), options.sessionId)
    : undefined;
  const onRunnerExit = () => {
    if (host && !host.ended) { try { host.process.kill(); } catch {} }
    if (!current.ended) { try { current.process.kill(); } catch {} }
  };
  const stop = (): Promise<void> => {
    halting = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = undefined;
    stopping ??= (async () => {
      try {
        await Promise.all([host ? stopChild(host) : Promise.resolve(), stopChild(current, true)]);
      } finally {
        process.removeListener('exit', onRunnerExit);
      }
    })();
    return stopping;
  };
  const exhaust = () => {
    incident = undefined;
    if (bootstrapPath) {
      try { publishExhaustedBridgeBootstrap(bootstrapPath, options.sessionId); } catch { /* The host and ledger stay. */ }
    }
  };
  const scheduleRestart = () => {
    if (halting || !host || host.ended || restartTimer || spawning) return;
    const now = Date.now();
    incident ??= { started: now, attempts: 0 };
    if (incident.attempts >= SIDECAR_RECOVERY_ATTEMPTS || now - incident.started >= SIDECAR_RECOVERY_BUDGET_MS) {
      exhaust();
      return;
    }
    const delay = Math.min(SIDECAR_RECOVERY_MAX_BACKOFF_MS, SIDECAR_RECOVERY_INITIAL_BACKOFF_MS * 2 ** incident.attempts);
    incident.attempts += 1;
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void restart();
    }, delay);
    restartTimer.unref?.();
  };
  const watch = (child: ManagedChild, watchedGeneration: number) => {
    void child.closed.then(() => {
      if (halting || watchedGeneration !== generation || !host || host.ended) return;
      scheduleRestart();
    }).catch(() => {});
  };
  const restart = async () => {
    if (halting || !host || host.ended || spawning) return;
    if (incident && Date.now() - incident.started >= SIDECAR_RECOVERY_BUDGET_MS) {
      exhaust();
      return;
    }
    spawning = true;
    const watchedGeneration = ++generation;
    let replacement: ManagedChild | undefined;
    let failed = false;
    try {
      if (!current.ended) await stopChild(current, false);
      if (halting || host.ended) return;
      replacement = spawnSidecar();
      current = replacement;
      const observed = observeSidecar(replacement, options.sessionId);
      const waitMs = incident
        ? Math.min(timeoutMs, Math.max(1, SIDECAR_RECOVERY_BUDGET_MS - (Date.now() - incident.started)))
        : timeoutMs;
      const ready = await deadline(observed.ready, waitMs, 'Sidecar readiness');
      if (halting || host.ended || replacement.ended) throw new Error('Sidecar exited during recovery');
      const attachedWait = incident
        ? Math.min(timeoutMs, Math.max(1, SIDECAR_RECOVERY_BUDGET_MS - (Date.now() - incident.started)))
        : timeoutMs;
      await deadline(observed.attached, attachedWait, 'the Mod to attach and register its root');
      if (replacement.ended) throw new Error('Sidecar exited during recovery');
      if (halting || host.ended || watchedGeneration !== generation) return;
      bridge = { url: ready.url, token: ready.token };
      if (ready.bootstrapPath) bootstrapPath = ready.bootstrapPath;
      incident = undefined;
      watch(replacement, watchedGeneration);
    } catch {
      failed = true;
      if (replacement && !replacement.ended) await stopChild(replacement, false);
    } finally {
      spawning = false;
      if (failed && !halting && host && !host.ended) scheduleRestart();
    }
  };
  process.once('exit', onRunnerExit);
  try {
    const observed = observeSidecar(current, options.sessionId);
    const ready = await deadline(observed.ready, timeoutMs, 'Sidecar readiness');
    if (current.ended) throw new Error('Sidecar exited during startup');
    bridge = { url: ready.url, token: ready.token };
    if (ready.bootstrapPath) bootstrapPath = ready.bootstrapPath;
    const hostEnv: Record<string, string | undefined> = {
      ...env,
      ARLO_CLAUDECODE_SESSION_ID: options.sessionId,
      ARLO_CLAUDECODE_BRIDGE_URL: bridge.url,
      ARLO_CLAUDECODE_BRIDGE_TOKEN: bridge.token,
    };
    if (bootstrapPath) hostEnv.ARLO_CLAUDECODE_BRIDGE_BOOTSTRAP = bootstrapPath;
    host = manage(spawn(command, args, { env: hostEnv, cwd, stdio: 'inherit' }));
    await deadline(host.started, timeoutMs, 'Claude Code startup');
    void host.closed.then(result => observed.rejectAttached(result.error ?? new Error('Claude Code exited before the Mod attached')));
    await deadline(observed.attached, timeoutMs, 'the Mod to attach and register its root');
    if (host.ended || current.ended) throw new Error('Claude Code or its Sidecar exited during startup');
    const runningHost = host;
    void runningHost.closed.then(() => stop()).catch(() => {});
    watch(current, generation);
    return {
      sessionId: options.sessionId,
      get bridgeUrl() { return bridge.url; },
      get token() { return bridge.token; },
      get bridgeBootstrapPath() { return bootstrapPath; },
      get sidecarProcess() { return current.process; },
      claudeProcess: runningHost.process,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
