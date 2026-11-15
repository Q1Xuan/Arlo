import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonClient, readDiscoveryRecord } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';
import type { PolicyCommand } from './fixtures/harness-policy-worker.ts';

function startHarness(stateDir: string, profile: string, configuration: { groupName?: string; workspaceDir?: string }) {
  const networkDir = path.join(profile, 'network');
  fs.mkdirSync(networkDir);
  const guard = `process.env.ARLO_LOW_LEVEL_NETWORK_FILE = process.env.ARLO_ACCEPTANCE_NETWORK_DIR + '/' + process.pid + '.json'; await import(${JSON.stringify(new URL('../probes/isolation.mjs', import.meta.url).href)});`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/harness-policy-worker.ts', import.meta.url))], {
    cwd: profile, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      SystemRoot: process.env.SystemRoot,
      HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile,
      XDG_CONFIG_HOME: profile, XDG_DATA_HOME: profile, XDG_CACHE_HOME: profile,
      TEMP: profile, TMP: profile, TMPDIR: profile,
      PSExecutionPolicyPreference: 'Bypass',
      ARLO_STATE_DIR: stateDir, ARLO_POLICY_CONFIG: JSON.stringify(configuration),
      ARLO_ACCEPTANCE_NETWORK_DIR: networkDir,
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(guard)}`,
    },
  });
  const ready = Promise.withResolvers<number>();
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
  let sequence = 0;
  let output = '';
  let outputBytes = 0;
  let outputOverflow = false;
  let forcedStop = false;
  const forceStop = () => { forcedStop = true; child.kill(); };
  const fail = (error: Error) => { ready.reject(error); for (const response of pending.values()) response.reject(error); };
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`Policy Harness exit ${code}: ${output}`)));
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 2 * 1024 * 1024) {
      outputOverflow = true;
      forceStop();
    } else output += chunk.toString();
  });
  child.on('message', (message: any) => {
    if (message.ready) ready.resolve(message.pid);
    else if (message.error) pending.get(message.id)?.reject(new Error(message.error));
    else pending.get(message.id)?.resolve(message.result);
  });
  const startupTimer = setTimeout(() => ready.reject(new Error(`Policy Harness startup timeout: ${output}`)), 30000);
  void ready.promise.then(() => clearTimeout(startupTimer), () => clearTimeout(startupTimer));
  async function request(command: PolicyCommand) {
    const id = ++sequence;
    const response = Promise.withResolvers<any>();
    pending.set(id, response);
    const timer = setTimeout(() => response.reject(new Error(`Policy Harness ${command.action} timeout: ${output}`)), 30000);
    try {
      child.send({ id, command }, error => { if (error) response.reject(error); });
      return await response.promise;
    } finally { clearTimeout(timer); pending.delete(id); }
  }
  return {
    ready: ready.promise, request, networkDir,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const timer = setTimeout(forceStop, 35000);
        try {
          try {
            if (child.connected) await request({ action: 'stop' });
            else forceStop();
          } catch {
            // The request deadline is shorter than the termination deadline.
            // Kill on rejection and still await process/pipe closure before
            // clearing the timer or allowing owned-directory cleanup.
            forceStop();
          }
          await exited;
        } finally { clearTimeout(timer); }
      } else await exited;
      assert.equal(outputOverflow, false, 'Policy Harness output exceeded the diagnostic bound');
      assert.equal(forcedStop, false, `Policy Harness required forced termination: ${output}`);
      assert.equal(child.exitCode, 0, output);
    },
  };
}
type Worker = ReturnType<typeof startHarness>;
async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30000;
  let value: T | undefined;
  do {
    value = await read();
    if (matches(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail(`Expected real host state within the observation deadline: ${JSON.stringify(value)}`);
}
async function waitForBindingsReady(...workers: Worker[]): Promise<void> {
  // Observe actual adapter readiness through IPC before protected discovery
  // reads can compete with Windows native startup in the observation window.
  await eventually(() => Promise.all(workers.map(worker => worker.request({ action: 'snapshot' }))),
    states => states.every(state => state.bindingReady === true));
}
const tool = (worker: Worker, name: string, args: Record<string, unknown> = {}) => worker.request({ action: 'tool', name, args });
const content = (message: any) => message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
function value(message: any) { assert.notEqual(message.isError, true); return JSON.parse(content(message)); }

async function environment(configure: (project: string) => Array<{ groupName?: string; workspaceDir?: string }>, run: (workers: Worker[], client: DaemonClient) => Promise<void>) {
  const stateDir = createTempDir('policy-state');
  const project = createTempDir('policy-project');
  const profiles = [createTempDir('policy-a'), createTempDir('policy-b')];
  const workers = configure(project).map((configuration, i) => startHarness(stateDir, profiles[i], configuration));
  const client = new DaemonClient({ stateDir });
  let daemon: ReturnType<typeof readDiscoveryRecord> | undefined;
  try {
    const pids = await Promise.all(workers.map(worker => worker.ready));
    assert.equal(new Set([...pids, process.pid]).size, 3);
    await run(workers, client);
    daemon = readDiscoveryRecord(stateDir);
    assert.equal(new Set([...pids, daemon.pid, process.pid]).size, 4);
    await Promise.all(workers.map(worker => worker.stop()));
    await eventually(async () => fs.existsSync(path.join(stateDir, 'discovery.json')), exists => !exists);
    const networkFiles = workers.flatMap(worker => fs.readdirSync(worker.networkDir).map(name => path.join(worker.networkDir, name)));
    for (const pid of [...pids, daemon.pid]) assert.ok(networkFiles.some(file => path.basename(file) === `${pid}.json`));
    for (const file of networkFiles) assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).deniedConnections, 0);
  } finally {
    await Promise.allSettled(workers.map(worker => worker.stop()));
    try {
      const current = await client.getStatus();
      const owned = daemon ?? readDiscoveryRecord(stateDir);
      if (current.daemon_id === owned.daemon_id && current.pid === owned.pid) process.kill(owned.pid, 'SIGKILL');
    } catch {}
    for (const profile of profiles) removeTempDir(profile);
    removeTempDir(project);
    removeTempDir(stateDir);
  }
}

test('Two real Harness processes preserve existing tool permission and input policies before, during and after Arlo integration', { timeout: 120000 }, async () => {
  await environment(() => [{ groupName: 'policy-acceptance' }, { groupName: 'policy-acceptance' }], async ([a, b], client) => {
    const baseline = await b.request({ action: 'snapshot' });
    assert.notEqual((await tool(b, 'policy_allowed')).isError, true);
    assert.match(content(await tool(b, 'policy_denied')), /HOST_POLICY_DENIED/);
    const beforeRejection = await b.request({ action: 'snapshot' });
    const rejected = await b.request({ action: 'input', text: 'policy-rejected-input' });
    assert.equal(rejected.requests, beforeRejection.requests);
    assert.equal(rejected.rejectedInputs.length, 1);
    await Promise.all([a, b].map(worker => worker.request({ action: 'attach' })));
    await waitForBindingsReady(a, b);
    await eventually(() => client.listRoots().catch(() => []), roots => roots.filter(root => root.ready).length === 2);
    const target = value(await tool(a, 'arlo_list_sessions'))[0].endpoint_id;
    const send = async (text: string) => value(await tool(a, 'arlo_send_message', { to: target, text }));
    const deniedCall = await b.request({ action: 'arm-tool', name: 'policy_denied' });
    assert.equal((await send('remote-request-for-denied-tool')).status, 'accepted');
    const denied = await eventually(() => b.request({ action: 'snapshot' }), state => state.results.some((result: any) => result.toolCallId === deniedCall.id));
    const deniedResult = denied.results.find((result: any) => result.toolCallId === deniedCall.id);
    assert.equal(deniedResult.isError, true);
    assert.match(content(deniedResult), /HOST_POLICY_DENIED/);
    assert.equal(denied.executed, 1, 'Remote input cannot elevate the existing host permission');
    assert.equal(denied.denied, 2);
    const allowedCall = await b.request({ action: 'arm-tool', name: 'policy_allowed' });
    assert.equal((await send('remote-request-for-allowed-tool')).status, 'accepted');
    const allowed = await eventually(() => b.request({ action: 'snapshot' }), state => state.results.some((result: any) => result.toolCallId === allowedCall.id));
    assert.equal(allowed.executed, 2, 'Positive control proves remote model calls reach the actual tool pipeline');
    assert.equal((await send('policy-rejected-input')).status, 'accepted', 'ACK records host enqueue even when later host input policy discards the turn');
    const rejectedRemote = await eventually(() => b.request({ action: 'snapshot' }), state => state.rejectedInputs.length === 2);
    assert.equal(rejectedRemote.requests, allowed.requests);
    assert.equal(rejectedRemote.messages.some((message: any) => message.content.some((block: any) => block.text === 'policy-rejected-input')), false);
    assert.deepEqual(rejectedRemote.pending, []);
    const admitted = rejectedRemote.admittedInputs.find((message: any) => message.content.some((block: any) => block.text === 'remote-request-for-denied-tool'));
    assert.deepEqual(admitted.source, { kind: 'arlo', form: 'relay' });
    assert.equal(rejectedRemote.agentCount, baseline.agentCount);
    await b.request({ action: 'unload' });
    assert.match(content(await tool(b, 'policy_denied')), /HOST_POLICY_DENIED/);
    assert.notEqual((await tool(b, 'policy_allowed')).isError, true);
    const afterUnload = await b.request({ action: 'snapshot' });
    const final = await b.request({ action: 'input', text: 'policy-rejected-input' });
    assert.equal(final.requests, afterUnload.requests);
    assert.equal(final.rejectedInputs.length, 3);
    assert.equal(final.executed, 3);
    assert.equal(final.denied, 3);
  });
});

test('Two real Harness processes require trusted project context and deliver after explicit group selection', { timeout: 120000 }, async () => {
  await environment(project => [{ workspaceDir: project }, {}], async ([a, b], client) => {
    await Promise.all([a, b].map(worker => worker.request({ action: 'attach' })));
    await waitForBindingsReady(a);
    await eventually(() => client.listRoots().catch(() => []), roots => roots.filter(root => root.ready).length === 1);
    assert.deepEqual(value(await tool(a, 'arlo_list_sessions')), []);
    const missing = await tool(b, 'arlo_list_sessions');
    assert.equal(missing.isError, true);
    assert.match(content(missing), /GROUP_CONTEXT_REQUIRED/);
    await Promise.all([a, b].map(worker => worker.request({ action: 'switch-group', groupName: 'explicit-context-recovery' })));
    await waitForBindingsReady(a, b);
    await eventually(() => client.listRoots(), roots => roots.filter(root => root.ready).length === 2);
    const target = value(await tool(a, 'arlo_list_sessions'))[0].endpoint_id;
    assert.equal(value(await tool(a, 'arlo_send_message', { to: target, text: 'explicit-context-delivery' })).status, 'accepted');
    const received = await eventually(() => b.request({ action: 'snapshot' }), state => state.messages.some((message: any) => message.content[0]?.text === 'explicit-context-delivery'));
    assert.equal(received.messages.filter((message: any) => message.content[0]?.text === 'explicit-context-delivery').length, 1);
  });
});
