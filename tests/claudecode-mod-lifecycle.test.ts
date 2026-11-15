import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import type { ArloMessageNotificationParams } from '@arlo/sdk';
import { ClaudeCodeSidecar, type ClaudeModToolHost } from '../packages/adapter-claudecode/src/index.ts';
import { register } from '../packages/adapter-claudecode/mod/hooks/register.js';
import { createTempDir, durableStatus, readDurableQueue, removeTempDir } from './test-utils.ts';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function frame(id: string): ArloMessageNotificationParams {
  return {
    protocol_version: '0.1', daemon_id: 'daemon-lifecycle', message_id: id,
    delivery_id: `delivery-${id}`, from_endpoint: 'sender', to_endpoint: 'receiver',
    group_id: 'group-lifecycle', target_generation: 1, delivery_seq: '1',
    text: `body-${id}`, sent_at: new Date().toISOString(),
  };
}

async function fixture(t: { after(callback: () => void | Promise<void>): void }) {
  const storageDir = createTempDir('cc-mod-lifecycle-');
  const originalSessionId = 'session-before-switch';
  let sessionId = originalSessionId;
  let sidecar = new ClaudeCodeSidecar({ sessionId, stateDir: storageDir, autoStart: false });
  await sidecar.start();
  const timers: { cancelled: boolean; callback(): void; cancel(): void }[] = [];
  const submitted: string[] = [];
  const diagnostics: string[] = [];
  const requests: { path: string; headers: Record<string, string>; body?: string; status?: number }[] = [];
  const host: ClaudeModToolHost = {
    command: { register: async definition => ({ command: definition.name }) },
    tool: { register: async definition => ({ tool: `mcp__arlo-adapter-claudecode__${definition.name}` }) },
    session: { id: async () => sessionId },
    env: { get: async name => name.endsWith('BOOTSTRAP') ? sidecar.bootstrapPath : name.endsWith('URL') ? sidecar.url : sidecar.token },
    fs: { read: async file => fs.readFileSync(file, 'utf8') },
    http: { fetch: async (url, init) => {
      const request = { path: new URL(url).pathname, headers: init?.headers ?? {}, body: init?.body, status: undefined as number | undefined };
      requests.push(request);
      const result = await fetch(url, init);
      request.status = result.status;
      return { status: result.status, ok: result.ok, headers: {}, text: await result.text() };
    } },
    prompt: { submit: async input => { submitted.push(input.text); return undefined; } },
    clock: {
      now: async () => Date.now(),
      every: (_delay, callback) => {
        const timer = { cancelled: false, callback, cancel() { this.cancelled = true; } };
        timers.push(timer);
        return timer;
      },
      after: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return { cancel: () => clearTimeout(timer) };
      },
    },
    ui: { log: (text: string) => { diagnostics.push(text); } },
  };
  const hooks = new Map<string, Parameters<Parameters<typeof register>[0]>[1]>();
  register((event, handler) => { hooks.set(event, handler); return { catch() {} }; });
  const invoke = async (event: string, input: Record<string, unknown> = {}, next = async (value: unknown) => value) =>
    hooks.get(event)!(host, input, next);
  t.after(async () => {
    await invoke('session.end', { sessionId, reason: 'prompt_input_exit' });
    await sidecar.stop();
    removeTempDir(storageDir);
  });
  return { get sidecar() { return sidecar; }, host, storageDir, originalSessionId, timers, submitted, diagnostics, requests, invoke,
    replaceSidecar: async () => {
      await sidecar.bridgeServer.stop();
      await sidecar.runtime?.dispose();
      sidecar = new ClaudeCodeSidecar({ sessionId, launchSessionId: originalSessionId, stateDir: storageDir, autoStart: false });
      await sidecar.start();
    },
    setSessionId: (value: string) => { sessionId = value; } };
}

test('official clear session.end retires old queued input and activates the verified root without session.start', async t => {
  const f = await fixture(t);
  await f.invoke('session.start');
  assert.equal(f.timers.filter(timer => !timer.cancelled).length, 1);
  await f.sidecar.receptionHost.prepare(frame('never-submitted')).enqueue();
  const inFlight = f.sidecar.receptionHost.prepare(frame('unconfirmed'));
  await inFlight.enqueue();
  f.sidecar.receptionHost.beginDispatch(inFlight.nativeMessageId);
  f.sidecar.receptionHost.recordHandoff(inFlight.nativeMessageId);

  await f.invoke('session.end', { reason: 'clear', sessionId: f.originalSessionId }, async event => {
    f.setSessionId('session-after-clear');
    return event;
  });
  await until(() => f.requests.some(request => request.path.endsWith('/session/activate') && request.status === 200), 'current root activation');
  assert.equal(f.timers[0]!.cancelled, true);
  assert.equal(f.timers.filter(timer => !timer.cancelled).length, 1);
  assert.equal(durableStatus(f.storageDir, f.originalSessionId, 'never-submitted'), 'discarded');
  assert.equal(durableStatus(f.storageDir, f.originalSessionId, 'unconfirmed'), 'unknown');
  assert.equal(f.submitted.length, 0);
  assert.equal(f.diagnostics.length, 0);
  await f.sidecar.receptionHost.prepare(frame('current-message')).enqueue();
  f.timers.find(timer => !timer.cancelled)!.callback();
  await until(() => f.submitted.length === 1, 'new root dispatch');
  assert.match(f.submitted[0]!, /body-current-message/);
  assert.equal(f.requests.filter(request => request.path.endsWith('/messages/pending')).at(-1)!.headers['x-session-id'], 'session-after-clear');
});

test('official clear after Sidecar recovery activates the new root while host environment keeps the old bridge credentials', async t => {
  const f = await fixture(t);
  const initialBridge = { url: f.sidecar.url, token: f.sidecar.token, bootstrap: f.sidecar.bootstrapPath };
  f.host.env.get = async name => name.endsWith('BOOTSTRAP') ? initialBridge.bootstrap :
    name.endsWith('URL') ? initialBridge.url : initialBridge.token;
  await f.invoke('session.start');
  const previousInstance = f.sidecar.bridgeServer.instanceId;
  await f.replaceSidecar();
  assert.notEqual(f.sidecar.url, initialBridge.url);
  assert.ok(f.sidecar.token !== initialBridge.token);
  assert.equal(f.sidecar.bootstrapPath, initialBridge.bootstrap);
  assert.notEqual(f.sidecar.bridgeServer.instanceId, previousInstance);
  f.timers.find(timer => !timer.cancelled)!.callback();
  await until(() => f.timers.length === 2, 'living Mod recovery scheduler');
  assert.equal(f.timers.filter(timer => !timer.cancelled).length, 1);
  assert.equal(f.requests.filter(request => request.path.endsWith('/handshake') && request.status === 200).length, 2);
  assert.equal(await f.host.env.get('ARLO_CLAUDECODE_BRIDGE_URL'), initialBridge.url);
  assert.ok(await f.host.env.get('ARLO_CLAUDECODE_BRIDGE_TOKEN') === initialBridge.token);

  await f.invoke('session.end', { reason: 'clear', sessionId: f.originalSessionId }, async event => {
    f.setSessionId('session-cleared-after-sidecar-recovery');
    return event;
  });
  await until(() => f.sidecar.host.roots().some(root =>
    f.sidecar.host.sessionId(root) === 'session-cleared-after-sidecar-recovery') &&
    f.requests.some(request => request.path.endsWith('/session/activate') && request.status === 200) &&
    f.timers.filter(timer => !timer.cancelled).length === 1, 'registered root after recovery and clear');
  assert.equal(f.requests.some(request => request.path.endsWith('/session/activate') && request.status === 200), true);
  assert.equal(f.timers.filter(timer => !timer.cancelled).length, 1);
  assert.equal(f.diagnostics.length, 0);
});

test('running resume and branch use the ending root event and a stable current identity', async t => {
  const f = await fixture(t);
  await f.invoke('session.start');
  await f.sidecar.receptionHost.prepare(frame('before-resume')).enqueue();
  await f.invoke('session.end', { reason: 'resume', sessionId: f.originalSessionId }, async event => {
    f.setSessionId('resumed-or-branched-root');
    return event;
  });
  await until(() => f.timers.length === 2, 'resume scheduler');
  assert.equal(durableStatus(f.storageDir, f.originalSessionId, 'before-resume'), 'discarded');
  assert.equal(f.sidecar.host.sessionId(f.sidecar.host.roots()[0]!), 'resumed-or-branched-root');
  assert.equal(f.timers.filter(timer => !timer.cancelled).length, 1);
});

test('an unverifiable replacement leaves communication retired and reports a host diagnostic', async t => {
  const f = await fixture(t);
  await f.invoke('session.start');
  await f.sidecar.receptionHost.prepare(frame('unverifiable')).enqueue();
  await f.invoke('session.end', { reason: 'clear', sessionId: f.originalSessionId });
  await until(() => f.diagnostics.length > 0, 'identity diagnostic');
  assert.match(f.diagnostics[0]!, /communication stopped.*session.*verified/i);
  assert.equal(f.timers.filter(timer => !timer.cancelled).length, 0);
  assert.equal(f.sidecar.host.roots().length, 0);
  assert.equal(f.submitted.length, 0);
  assert.equal(durableStatus(f.storageDir, f.originalSessionId, 'unverifiable'), 'discarded');
  assert.equal(f.requests.some(request => request.path.endsWith('/session/activate')), false);
  await assert.doesNotReject(f.invoke('turn.start', { turnId: 'local-work' }));
  await assert.doesNotReject(f.invoke('turn.complete', { turnId: 'local-work' }));
});

test('same-context session.start reload keeps one endpoint and cancels the old poll callback', async t => {
  const f = await fixture(t);
  let created = 0;
  f.sidecar.host.onCreated(() => { created++; });
  await f.invoke('session.start');
  await f.sidecar.receptionHost.prepare(frame('survives-reload')).enqueue();
  const oldPollStarted = Promise.withResolvers<void>();
  const releaseOldPoll = Promise.withResolvers<void>();
  const fetchBridge = f.host.http.fetch;
  let hold = true;
  f.host.http.fetch = async (url, init) => {
    const result = await fetchBridge(url, init);
    if (hold && url.endsWith('/messages/pending')) {
      hold = false;
      oldPollStarted.resolve();
      await releaseOldPoll.promise;
    }
    return result;
  };
  f.timers[0]!.callback();
  await oldPollStarted.promise;
  await f.invoke('session.start');
  releaseOldPoll.resolve();
  f.timers.at(-1)!.callback();
  await until(() => f.submitted.length === 1, 'replacement scheduler dispatch');
  assert.equal(created, 1, 'Reload does not create another root or first issuance opportunity');
  assert.equal(f.timers.filter(timer => !timer.cancelled).length, 1);
  assert.equal(f.timers[0]!.cancelled, true);
  assert.match(f.submitted[0]!, /body-survives-reload/);
});

test('a late pre-clear host handoff keeps its old identity and cannot settle the current root', async t => {
  const f = await fixture(t);
  await f.invoke('session.start');
  await f.sidecar.receptionHost.prepare(frame('late-handoff')).enqueue();
  const releaseHandoff = Promise.withResolvers<void>();
  const submit = f.host.prompt.submit;
  let first = true;
  f.host.prompt.submit = async input => {
    await submit(input);
    if (first) { first = false; await releaseHandoff.promise; }
    return undefined;
  };
  f.timers[0]!.callback();
  await until(() => f.submitted.length === 1, 'pre-clear host entry');
  await f.invoke('session.end', { reason: 'clear', sessionId: f.originalSessionId }, async event => {
    f.setSessionId('root-after-late-handoff');
    return event;
  });
  await until(() => f.timers.length === 2, 'current scheduler');
  releaseHandoff.resolve();
  await until(() => f.requests.some(request => request.path.endsWith('/messages/settle') && request.status === 403), 'late old-root report rejection');
  assert.equal(durableStatus(f.storageDir, f.originalSessionId, 'late-handoff'), 'unknown');
  await f.sidecar.receptionHost.prepare(frame('new-handoff')).enqueue();
  f.timers.at(-1)!.callback();
  await until(() => durableStatus(f.storageDir, 'root-after-late-handoff', 'new-handoff') === 'submitting', 'new-root handoff');
  assert.equal(f.submitted.length, 2);
  assert.equal(f.requests.filter(request => request.status === 403).every(request => request.headers['x-session-id'] === f.originalSessionId), true);
});

test('claim evidence pending across clear is fenced to the retired root', async t => {
  const f = await fixture(t);
  await f.invoke('session.start');
  await f.sidecar.receptionHost.prepare(frame('late-claim')).enqueue();
  f.timers[0]!.callback();
  await until(() => durableStatus(f.storageDir, f.originalSessionId, 'late-claim') === 'submitting', 'pre-clear handoff');
  const marker = readDurableQueue(f.storageDir, f.originalSessionId)[0]!.correlationId;
  const clock = Promise.withResolvers<number>();
  const claimStarted = Promise.withResolvers<void>();
  f.host.clock.now = () => { claimStarted.resolve(); return clock.promise; };
  await f.invoke('turn.start', { turnId: 'old-proof', text: `[arlo-correlation:${marker}]` });
  await claimStarted.promise;
  await f.invoke('session.end', { reason: 'clear', sessionId: f.originalSessionId }, async event => {
    f.setSessionId('root-after-late-claim');
    return event;
  });
  await until(() => f.timers.length === 2, 'current scheduler');
  clock.resolve(Date.now());
  await until(() => f.requests.some(request => request.path.endsWith('/messages/claim') && request.status === 403), 'late claim rejection');
  assert.equal(durableStatus(f.storageDir, f.originalSessionId, 'late-claim'), 'unknown');
  assert.equal(f.sidecar.receptionHost.snapshot({ instanceId: f.sidecar.receptionHost.instanceId, generation: 1 }).inFlight.length, 0);
});

test('Mod reload while retirement is in progress resumes the verified context once retirement finishes', async t => {
  const f = await fixture(t);
  await f.invoke('session.start');
  const retireStarted = Promise.withResolvers<void>();
  const releaseRetire = Promise.withResolvers<void>();
  const fetchBridge = f.host.http.fetch;
  f.host.http.fetch = async (url, init) => {
    if (url.endsWith('/session/retire')) {
      retireStarted.resolve();
      await releaseRetire.promise;
    }
    return fetchBridge(url, init);
  };
  await f.invoke('session.end', { reason: 'clear', sessionId: f.originalSessionId }, async event => {
    f.setSessionId('root-reloaded-during-retire');
    return event;
  });
  await retireStarted.promise;
  const reloading = f.invoke('session.start');
  await until(() => f.requests.some(request => request.path.endsWith('/status') && request.status === 403), 'status before retirement');
  releaseRetire.resolve();
  await reloading;
  await until(() => f.timers.filter(timer => !timer.cancelled).length === 1, 'reloaded current scheduler');
  assert.equal(f.sidecar.host.sessionId(f.sidecar.host.roots()[0]!), 'root-reloaded-during-retire');
  assert.equal(f.diagnostics.length, 0);
});

test('the latest Mod attachment recovers when an older in-flight handshake consumes its observed generation', async t => {
  const f = await fixture(t);
  const oldHandshakeStarted = Promise.withResolvers<void>();
  const newHandshakeStarted = Promise.withResolvers<void>();
  const releaseOld = Promise.withResolvers<void>();
  const releaseNew = Promise.withResolvers<void>();
  const fetchBridge = f.host.http.fetch;
  let handshakes = 0;
  f.host.http.fetch = async (url, init) => {
    if (url.endsWith('/handshake')) {
      const sequence = ++handshakes;
      if (sequence === 1) { oldHandshakeStarted.resolve(); await releaseOld.promise; }
      if (sequence === 2) { newHandshakeStarted.resolve(); await releaseNew.promise; }
    }
    return fetchBridge(url, init);
  };
  const oldStart = f.invoke('session.start');
  await oldHandshakeStarted.promise;
  const newStart = f.invoke('session.start');
  await newHandshakeStarted.promise;
  releaseOld.resolve();
  await oldStart;
  releaseNew.resolve();
  await newStart;
  assert.equal(f.timers.filter(timer => !timer.cancelled).length, 1);
  assert.equal(f.diagnostics.length, 0);
  assert.equal(f.sidecar.host.roots().length, 1);
});

test('a second context switch retires an activation whose response is still in flight', async t => {
  const f = await fixture(t);
  await f.invoke('session.start');
  const activationStarted = Promise.withResolvers<void>();
  const releaseActivation = Promise.withResolvers<void>();
  const fetchBridge = f.host.http.fetch;
  let held = false;
  f.host.http.fetch = async (url, init) => {
    const result = await fetchBridge(url, init);
    if (!held && url.endsWith('/session/activate')) {
      held = true;
      activationStarted.resolve();
      await releaseActivation.promise;
    }
    return result;
  };
  await f.invoke('session.end', { reason: 'clear', sessionId: f.originalSessionId }, async event => {
    f.setSessionId('intermediate-root');
    return event;
  });
  await activationStarted.promise;
  await f.sidecar.receptionHost.prepare(frame('intermediate-pending')).enqueue();
  await f.invoke('session.end', { reason: 'resume', sessionId: 'intermediate-root' }, async event => {
    f.setSessionId('final-root');
    return event;
  });
  releaseActivation.resolve();
  await until(() => f.timers.filter(timer => !timer.cancelled).length === 1, 'final context scheduler');
  assert.equal(f.sidecar.host.sessionId(f.sidecar.host.roots()[0]!), 'final-root');
  assert.equal(durableStatus(f.storageDir, 'intermediate-root', 'intermediate-pending'), 'discarded');
  assert.equal(f.submitted.length, 0);
  assert.equal(f.diagnostics.length, 0);
});

test('reloaded Mod reattaches after an older activation wins the retired binding generation', async t => {
  const f = await fixture(t);
  await f.invoke('session.start');
  const oldActivationStarted = Promise.withResolvers<void>();
  const newActivationStarted = Promise.withResolvers<void>();
  const releaseOld = Promise.withResolvers<void>();
  const releaseNew = Promise.withResolvers<void>();
  const fetchBridge = f.host.http.fetch;
  let activations = 0;
  f.host.http.fetch = async (url, init) => {
    if (url.endsWith('/session/activate')) {
      const sequence = ++activations;
      if (sequence === 1) { oldActivationStarted.resolve(); await releaseOld.promise; }
      if (sequence === 2) { newActivationStarted.resolve(); await releaseNew.promise; }
    }
    return fetchBridge(url, init);
  };
  await f.invoke('session.end', { reason: 'clear', sessionId: f.originalSessionId }, async event => {
    f.setSessionId('root-with-competing-activation');
    return event;
  });
  await oldActivationStarted.promise;
  await f.invoke('session.start');
  await newActivationStarted.promise;
  releaseOld.resolve();
  await until(() => f.requests.some(request => request.path.endsWith('/session/activate') && request.status === 200), 'older activation');
  releaseNew.resolve();
  await until(() => f.timers.filter(timer => !timer.cancelled).length === 1, 'current attachment after activation conflict');
  assert.equal(f.sidecar.host.sessionId(f.sidecar.host.roots()[0]!), 'root-with-competing-activation');
  assert.equal(f.diagnostics.length, 0);
  await f.sidecar.receptionHost.prepare(frame('after-activation-conflict')).enqueue();
  f.timers.at(-1)!.callback();
  await until(() => f.submitted.length === 1, 'current attachment reception');
});

test('clear during reload identity discovery retires the ending root even before the new dispatcher attaches', async t => {
  for (const outcome of ['old identity', 'empty identity', 'failed identity']) await t.test(outcome, async t => {
    const f = await fixture(t);
    await f.invoke('session.start');
    await f.sidecar.receptionHost.prepare(frame('before-interrupted-reload')).enqueue();
    const readingIdentity = Promise.withResolvers<void>();
    const releaseIdentity = Promise.withResolvers<string>();
    const readIdentity = f.host.session.id;
    let held = false;
    f.host.session.id = async () => {
      if (!held) { held = true; readingIdentity.resolve(); return releaseIdentity.promise; }
      return readIdentity();
    };
    const reloading = f.invoke('session.start');
    await readingIdentity.promise;
    await f.invoke('session.end', { reason: 'clear', sessionId: f.originalSessionId }, async event => {
      f.setSessionId('root-after-interrupted-reload');
      return event;
    });
    if (outcome === 'failed identity') releaseIdentity.reject(new Error('Host identity unavailable'));
    else releaseIdentity.resolve(outcome === 'empty identity' ? '' : f.originalSessionId);
    await reloading;
    await until(() => f.timers.filter(timer => !timer.cancelled).length === 1, 'current context after interrupted reload');
    assert.equal(f.sidecar.host.sessionId(f.sidecar.host.roots()[0]!), 'root-after-interrupted-reload');
    assert.equal(durableStatus(f.storageDir, f.originalSessionId, 'before-interrupted-reload'), 'discarded');
    assert.equal(f.diagnostics.length, 0);
  });
});

for (const reason of ['clear', 'resume']) {
  test(`Sidecar recovery after ${reason} keeps the current root and resumes input once`, async t => {
    const f = await fixture(t);
    await f.invoke('session.start');
    await f.invoke('session.end', { reason, sessionId: f.originalSessionId }, async event => {
      f.setSessionId('root-before-sidecar-recovery');
      return event;
    });
    await until(() => f.timers.filter(timer => !timer.cancelled).length === 1, 'switched scheduler');
    const previousInstance = f.sidecar.bridgeServer.instanceId;
    await f.sidecar.receptionHost.prepare(frame('carried-after-switch')).enqueue();
    await f.replaceSidecar();
    assert.notEqual(f.sidecar.bridgeServer.instanceId, previousInstance);
    f.timers.find(timer => !timer.cancelled)!.callback();
    await until(() => f.timers.length === 3, 'replacement scheduler');
    f.timers.find(timer => !timer.cancelled)!.callback();
    await until(() => f.submitted.length === 1, 'recovered delivery');
    f.timers.find(timer => !timer.cancelled)!.callback();
    assert.match(f.submitted[0]!, /body-carried-after-switch/);
    assert.equal(f.diagnostics.length, 0);
    assert.equal(f.timers.filter(timer => !timer.cancelled).length, 1);
  });
}
