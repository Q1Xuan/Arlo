import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A bounded IPC driver. Neither stdout nor stderr is discarded before audit checks. */
export function acceptanceProcess(script: string, profile: string, stateDir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const network = path.join(profile, 'network.json');
  const child = spawn(process.execPath, ['--import', new URL('../../probes/isolation.mjs', import.meta.url).href,
    fileURLToPath(new URL(script, import.meta.url))], {
    cwd: profile, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { SystemRoot: process.env.SystemRoot, HOME: profile, USERPROFILE: profile,
      APPDATA: profile, LOCALAPPDATA: profile, XDG_CONFIG_HOME: profile, XDG_DATA_HOME: profile, XDG_CACHE_HOME: profile,
      TEMP: profile, TMP: profile, TMPDIR: profile, PSExecutionPolicyPreference: 'Bypass',
      ARLO_STATE_DIR: stateDir, ARLO_LOW_LEVEL_NETWORK_FILE: network, ...extraEnv },
  });
  const ready = Promise.withResolvers<any>();
  // Node 24 on Windows can omit ChildProcess 'close' after parent-initiated
  // IPC disconnect. Observe termination and both output pipes independently.
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const drained = Promise.all([exited, ...[child.stdout!, child.stderr!].map(stream =>
    new Promise<void>(resolve => stream.once('close', () => resolve())))]);
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
  let sequence = 0;
  let output = '';
  let overflow = false;
  let forced = false;
  const fail = (error: Error) => { ready.reject(error); for (const response of pending.values()) response.reject(error); };
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => {
    if (Buffer.byteLength(output) + chunk.length > 2 * 1024 * 1024) { overflow = true; child.kill(); }
    else output += chunk;
  });
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`Acceptance process exit ${code}: ${output}`)));
  child.on('message', (message: any) => {
    if (message.ready === true) ready.resolve(message);
    else if (message.ready === false) ready.reject(new Error(message.code ?? 'PROCESS_START_FAILED'));
    else if (message.error) pending.get(message.id)?.reject(new Error(message.error));
    else pending.get(message.id)?.resolve(message.result);
  });
  const startup = setTimeout(() => ready.reject(new Error('Acceptance process startup deadline')), 45000);
  void ready.promise.then(() => clearTimeout(startup), () => clearTimeout(startup));
  async function request(command: object) {
    const id = ++sequence;
    const response = Promise.withResolvers<any>();
    pending.set(id, response);
    const timer = setTimeout(() => response.reject(new Error('Acceptance command deadline')), 30000);
    try { child.send({ id, command }, error => { if (error) response.reject(error); }); return await response.promise; }
    finally { clearTimeout(timer); pending.delete(id); }
  }
  return {
    pid: child.pid, ready: ready.promise, request, output: () => output,
    async stop(command?: object) {
      let timer: NodeJS.Timeout | undefined;
      const shutdown = async () => {
        if (child.exitCode === null && child.signalCode === null) {
          if (child.connected && command) await request(command).catch(() => {});
          if (child.connected && !command) child.disconnect();
        }
        await drained;
      };
      try {
        await Promise.race([shutdown(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            forced = true;
            child.kill();
            child.stdout!.destroy();
            child.stderr!.destroy();
            reject(new Error('Acceptance process disposal deadline'));
          }, 35000);
        })]);
      } finally { clearTimeout(timer); }
      assert.equal(overflow, false, 'Audit capture must not truncate process output');
      assert.equal(forced, false, 'Fixture must stop within the disposal deadline');
      assert.equal(child.exitCode, 0, output);
      assert.equal(JSON.parse(fs.readFileSync(network, 'utf8')).deniedConnections, 0);
    },
  };
}
