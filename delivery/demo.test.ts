import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '@arlo/sdk';
import type { DemoCommand, HostSnapshot, ToolMessage } from './host.ts';

function startHost(stateDir: string, profileDir: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./host.ts', import.meta.url))], {
    windowsHide: true,
    // The delivery runner supplies an allowlisted environment and the network
    // guard in NODE_OPTIONS, which also reaches the auto-started daemon.
    env: {
      ...process.env,
      HOME: profileDir, USERPROFILE: profileDir, APPDATA: profileDir, LOCALAPPDATA: profileDir,
      XDG_CONFIG_HOME: profileDir, XDG_DATA_HOME: profileDir, XDG_CACHE_HOME: profileDir,
      XDG_STATE_HOME: profileDir, XDG_RUNTIME_DIR: profileDir,
      ARLO_STATE_DIR: stateDir,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const ready = Promise.withResolvers<{ pid: number; adapterEntry: string; adapterSdkEntry: string; sdkEntry: string }>();
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  let sequence = 0;
  let output = '';
  child.stdout!.on('data', chunk => { output = (output + chunk).slice(-65536); });
  child.stderr!.on('data', chunk => { output = (output + chunk).slice(-65536); });
  const fail = (error: Error) => {
    ready.reject(error);
    for (const response of pending.values()) response.reject(error);
  };
  child.on('error', fail);
  const exited = new Promise<void>(resolve => child.once('exit', code => {
    fail(new Error(`Installed Harness exited (${code}): ${output}`));
    resolve();
  }));
  child.on('message', (message: { ready?: boolean; pid: number; adapterEntry: string; adapterSdkEntry: string; sdkEntry: string; id: number; result?: unknown; error?: string }) => {
    if (message.ready) ready.resolve(message);
    else if (message.error) pending.get(message.id)?.reject(new Error(message.error));
    else pending.get(message.id)?.resolve(message.result);
  });
  const startupTimer = setTimeout(() => ready.reject(new Error(`Installed Harness startup timed out: ${output}`)), 45000);
  void ready.promise.then(() => clearTimeout(startupTimer), () => clearTimeout(startupTimer));

  async function request<T>(command: DemoCommand): Promise<T> {
    const id = ++sequence;
    const response = Promise.withResolvers<unknown>();
    pending.set(id, response);
    const timer = setTimeout(() => response.reject(new Error(`Installed Harness ${command.action} timed out`)), 20000);
    try {
      child.send({ id, command }, error => { if (error) response.reject(error); });
      return await response.promise as T;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }

  return {
    ready: ready.promise, request,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Only this directly spawned test host is eligible for fallback cleanup.
      // The independently owned shared daemon is never killed by PID.
      const timer = setTimeout(() => child.kill(), 8000);
      try {
        if (child.connected) await request({ action: 'stop' }).catch(() => {});
        else child.kill();
        await exited;
      } finally { clearTimeout(timer); }
    },
  };
}

function toolData<T>(message: ToolMessage): T {
  assert.notEqual(message.isError, true, JSON.stringify(message.content));
  return JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')) as T;
}

test('Installed plugins connect two real Hosts for discovery, active reception, reply and safe unload', { timeout: 120000 }, async t => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'arlo-installed-hosts-'));
  const stateDir = path.join(temporary, 'state');
  const profiles = ['a', 'b'].map(name => path.join(temporary, name));
  for (const profile of profiles) mkdirSync(profile, { mode: 0o700 });
  const workers: ReturnType<typeof startHost>[] = [];
  try {
    assert.equal(existsSync(path.join(stateDir, 'discovery.json')), false, 'Plugin starts its own fresh shared daemon');
    const a = startHost(stateDir, profiles[0]);
    const b = startHost(stateDir, profiles[1]);
    workers.push(a, b);
    const [first, second] = await Promise.all([a.ready, b.ready]);
    assert.notEqual(first.pid, second.pid);
    assert.notEqual(first.pid, process.pid);
    assert.notEqual(second.pid, process.pid);
    for (const host of [first, second]) {
      assert.match(host.adapterEntry, /\/node_modules\/.*\/src\/runtime\.js$/);
      assert.match(host.adapterSdkEntry, /\/node_modules\/.*\/src\/index\.js$/);
      assert.match(host.sdkEntry, /\/node_modules\/.*\/src\/index\.js$/);
    }

    const list = async (host: typeof a) => toolData<{ endpoint_id: string }[]>(await host.request<ToolMessage>({
      action: 'tool', name: 'arlo_list_sessions', args: {},
    }));
    const peers = await list(a);
    assert.equal(peers.length, 1, 'Discovery exposes only the other ready root, excluding both children');
    assert.equal((await list(b)).length, 1);
    const daemon = new DaemonClient({ stateDir });
    const beforeDaemon = await daemon.getStatus();
    assert.equal(beforeDaemon.status, 'ready');
    assert.equal(beforeDaemon.active_endpoints_count, 2);

    const sent = toolData<{ status: string; message_id: string }>(await a.request<ToolMessage>({
      action: 'tool', name: 'arlo_send_message', args: { to: peers[0].endpoint_id, text: 'Fictional request from Cedar to Willow' },
    }));
    assert.equal(sent.status, 'accepted');
    const received = await b.request<HostSnapshot>({ action: 'snapshot' });
    const inbound = received.messages.find(message => message.content[0]?.text === 'Fictional request from Cedar to Willow');
    assert.ok(inbound, 'The existing receiver root accepts input without a local user prompt or inbox polling');
    assert.deepEqual(inbound.source, { kind: 'arlo', form: 'relay' });
    assert.equal(received.messages.filter(message => message.id === inbound.id).length, 1);
    assert.equal(received.childMessages, 0);
    assert.ok(JSON.stringify(received.modelMessages).includes('Fictional request from Cedar to Willow'),
      'Active reception reaches the real AgentLoop and local model projection');
    const replyContext = JSON.parse(inbound.content[1]!.text!).arlo as { from_endpoint: string; message_id: string };
    assert.equal(replyContext.message_id, sent.message_id);
    const reply = toolData<{ status: string; message_id: string }>(await b.request<ToolMessage>({
      action: 'tool', name: 'arlo_send_message', args: {
        to: replyContext.from_endpoint, reply_to: replyContext.message_id, text: 'Fictional reply from Willow to Cedar',
      },
    }));
    assert.equal(reply.status, 'accepted');
    assert.notEqual(reply.message_id, sent.message_id);
    const receivedReply = (await a.request<HostSnapshot>({ action: 'snapshot' })).messages.find(
      message => message.content[0]?.text === 'Fictional reply from Willow to Cedar',
    );
    assert.ok(receivedReply);
    const association = JSON.parse(receivedReply.content[1]!.text!).arlo;
    assert.equal(association.reply_to, sent.message_id);
    assert.equal(association.reply_depth, 1);
    assert.equal(association.message_id, reply.message_id);

    assert.equal((await b.request<HostSnapshot>({ action: 'hold-and-queue' })).status, 'running');
    const busyText = 'Fictional input retained while Willow is already working';
    const busySend = toolData<{ status: string }>(await a.request<ToolMessage>({
      action: 'tool', name: 'arlo_send_message', args: { to: peers[0].endpoint_id, text: busyText },
    }));
    assert.equal(busySend.status, 'accepted');
    const busy = await b.request<HostSnapshot>({ action: 'snapshot' });
    assert.equal(busy.status, 'running');
    assert.equal(busy.modelAborted, false, 'Reception does not interrupt the current local model work');
    const queued = busy.pending.filter(message => message.content[0]?.text === busyText);
    assert.equal(queued.length, 1, 'Busy reception queues exactly one business input');
    assert.equal(busy.messages.some(message => message.id === queued[0].id), false,
      'Accepted means pending input, not a completed model turn');
    const afterBusy = await b.request<HostSnapshot>({ action: 'release' });
    assert.equal(afterBusy.status, 'idle');
    assert.equal(afterBusy.messages.filter(message => message.id === queued[0].id).length, 1);
    assert.ok(JSON.stringify(afterBusy.modelMessages).includes(busyText), 'Busy input reaches the following real model turn');
    assert.equal(afterBusy.childMessages, 0);

    // Hold an existing local turn and local pending input. Already consumed
    // Arlo input stays in history; unload must preserve all host-owned work.
    assert.equal((await b.request<HostSnapshot>({ action: 'hold-and-queue' })).status, 'running');
    const beforeUnload = await b.request<HostSnapshot>({ action: 'snapshot' });
    assert.equal(beforeUnload.agentIds.length, 2);
    assert.equal(beforeUnload.pending.length, 1);
    assert.equal(beforeUnload.modelAborted, false);
    const afterUnload = await b.request<HostSnapshot>({ action: 'unload' });
    assert.equal(afterUnload.status, 'running');
    assert.equal(afterUnload.modelAborted, false, 'Unloading communication does not cancel model work');
    assert.equal(afterUnload.pid, beforeUnload.pid);
    assert.deepEqual(afterUnload.agentIds, beforeUnload.agentIds, 'Unload does not destroy existing agents');
    assert.deepEqual(afterUnload.pending, beforeUnload.pending, 'Unload preserves host-owned pending input');
    assert.deepEqual(afterUnload.messages, beforeUnload.messages, 'Unload preserves original message identity and history');
    assert.deepEqual(afterUnload.history, beforeUnload.history, 'Unload preserves the complete host event history');
    assert.deepEqual(await list(a), [], 'Only the unloaded endpoint is removed');
    const afterDaemon = await daemon.getStatus();
    assert.equal(afterDaemon.daemon_id, beforeDaemon.daemon_id, 'Other clients keep the same shared daemon');
    assert.equal(afterDaemon.pid, beforeDaemon.pid);
    assert.equal(afterDaemon.status, 'ready');
    assert.equal(afterDaemon.active_endpoints_count, 1);
    const status = toolData<{ status: string }>(await a.request<ToolMessage>({
      action: 'tool', name: 'arlo_get_message_status', args: { message_id: sent.message_id },
    }));
    assert.equal(status.status, 'accepted', 'The remaining plugin can still query the earlier reception result');
    const released = await b.request<HostSnapshot>({ action: 'release' });
    assert.equal(released.status, 'idle');
    assert.equal(released.pending.length, 0);
    assert.equal(released.messages.filter(message => message.id === beforeUnload.pending[0].id).length, 1,
      'Original host work continues after communication is unloaded');
    t.diagnostic('Two installed package consumers; two real Harness processes; production auto-start; local model; discovery, send, idle active reception, busy pending reception, associated reply, local pending/history preservation and shared-daemon survival passed.');
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    const deadline = Date.now() + 20000;
    while (existsSync(path.join(stateDir, 'discovery.json')) && Date.now() < deadline) await delay(100);
    assert.equal(existsSync(path.join(stateDir, 'discovery.json')), false,
      `The shared daemon must release its own discovery after idle; retained state: ${stateDir}`);
    rmSync(temporary, { recursive: true, force: true });
  }
});
