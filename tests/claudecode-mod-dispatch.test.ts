import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  ClaudeCodeBridgeServer,
  generateBridgeToken,
  ClaudeCodeModDispatcher,
  type ClaudeModHost,
} from '../packages/adapter-claudecode/src/index.ts';

test('Mod rechecks the living idle session after reserving a pending input', async (t) => {
  for (const change of ['stopped', 'busy'] as const) {
    await t.test(change, async () => {
      const armed = Promise.withResolvers<void>();
      const releaseArm = Promise.withResolvers<void>();
      const submitted = Promise.withResolvers<void>();
      const reports: string[] = [];
      let submitCount = 0;
      let pending = true;
      const response = (body: unknown) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(body) });
      const host: ClaudeModHost = {
        session: { id: async () => 'session-race' },
        env: { get: async (name) => name.endsWith('URL') ? 'http://127.0.0.1:1234' : 'test-token' },
        http: {
          async fetch(url, init) {
            if (url.endsWith('/status')) return response({ sessionId: 'session-race', instanceId: 'test-instance', generation: 0, status: 'active', contractVersion: '2.0.0' });
            if (url.endsWith('/handshake')) return response({ accepted: true, sessionId: 'session-race', instanceId: 'test-instance', generation: 1, contractVersion: '2.0.0' });
            if (url.endsWith('/pending')) return response({ messages: pending ? [{ nativeMessageId: 'native-race', messageId: 'message-race', text: 'queued input', correlationId: 'correlation-race' }] : [] });
            const body = JSON.parse(init!.body!) as { status: string };
            reports.push(body.status);
            pending = body.status === 'enqueued';
            if (body.status === 'dispatching' && reports.length === 1) {
              armed.resolve();
              await releaseArm.promise;
            }
            return response({ settled: false, status: body.status });
          },
        },
        prompt: { submit: async () => { submitCount++; submitted.resolve(); return undefined; } },
        clock: {
          now: async () => 1,
          every: () => ({ cancel() {} }),
          after: (delay, callback) => {
            const timer = setTimeout(callback, delay);
            return { cancel: () => clearTimeout(timer) };
          },
        },
      };
      const dispatcher = new ClaudeCodeModDispatcher({ $: host });
      t.after(() => dispatcher.stop());
      await dispatcher.start();
      const polling = dispatcher.pollOnce();
      await armed.promise;
      if (change === 'stopped') await dispatcher.stop();
      else dispatcher.onTurnStart('human-turn');
      releaseArm.resolve();
      await polling;
      assert.equal(submitCount, 0, 'Must not enter the host after the session stops or becomes busy');
      assert.deepEqual(reports, ['dispatching', 'enqueued']);
      assert.equal(pending, true, 'Known unsubmitted input must remain available for the next idle turn');
      if (change === 'busy') {
        dispatcher.onTurnComplete('human-turn');
        await submitted.promise;
        assert.equal(submitCount, 1);
      }
    });
  }
});

test('In-Process Mod Dispatcher (Seam C)', async (t) => {
  const sessionId = 'session-mod-test-01';
  const token = generateBridgeToken();

  let settledMessageId: string | undefined;
  let settledStatus: string | undefined;
  const reported: string[] = [];

  const pendingMessages = [
    {
      nativeMessageId: 'native-mod-1',
      messageId: 'msg-mod-1',
      text: 'Incoming message for prompt submit',
      correlationId: 'correlation-mod-1',
      dispatch: { endpoint_id: 'sender-ep', daemon_id: 'daemon-1' },
      enqueuedAt: new Date().toISOString(),
    },
  ];

  function takePending(nativeId: string, status: string): void {
    settledMessageId = nativeId;
    settledStatus = status;
    reported.push(status);
    const idx = pendingMessages.findIndex((m) => m.nativeMessageId === nativeId);
    if (idx >= 0) pendingMessages.splice(idx, 1);
  }

  const ledgerEvents: string[] = [];

  const mockReceptionHost = {
    getPendingMessages: () => [...pendingMessages],
    beginDispatch: (nativeId: string) => {
      takePending(nativeId, 'dispatching');
    },
    recordHandoff: (nativeId: string) => {
      takePending(nativeId, 'submitting');
    },
    recordNotEntered: (nativeId: string) => {
      takePending(nativeId, 'discarded');
    },
    recordUnresolved: (nativeId: string) => {
      takePending(nativeId, 'unknown');
    },
    settle: async (nativeId: string, event: 'claimed' | 'discarded') => {
      ledgerEvents.push(event);
      takePending(nativeId, event);
    },
  };

  const bridgeServer = new ClaudeCodeBridgeServer({
    sessionId,
    token,
    port: 0,
    receptionHost: mockReceptionHost,
  });
  await bridgeServer.start();

  t.after(async () => {
    await bridgeServer.stop();
  });

  // Mock Claude Code Host Facade ($)
  function createMockClaudeHost(options: { submitResult?: unknown; dropResult?: boolean } = {}) {
    const submittedPrompts: { text: string }[] = [];
    const timers: Array<{ delay: number; callback: () => void; cancelled: boolean }> = [];

    const $ = {
      tool: { register: async (definition: { name: string }) => ({ tool: `mcp__arlo-adapter-claudecode__${definition.name}` }) },
      command: { register: async (definition: { name: string }) => ({ command: definition.name }) },
      session: {
        id: async () => sessionId,
      },
      env: {
        get: async (key: string) => {
          if (key === 'ARLO_CLAUDECODE_BRIDGE_URL') return bridgeServer.url;
          if (key === 'ARLO_CLAUDECODE_BRIDGE_TOKEN') return token;
          return undefined;
        },
      },
      http: {
        fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
          const res = await fetch(url, {
            method: init?.method,
            headers: init?.headers,
            body: init?.body,
          });
          const text = await res.text();
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          return {
            status: res.status,
            ok: res.ok,
            headers: Object.fromEntries(res.headers.entries()),
            text,
            json: () => json,
          };
        },
      },
      prompt: {
        submit: async (input: { text: string }) => {
          submittedPrompts.push(input);
          if (options.dropResult) {
            return { drop: 'Explicit test drop' };
          }
          return options.submitResult || { text: input.text };
        },
      },
      clock: {
        now: async () => Date.now(),
        after: (delayMs: number, callback: () => void) => {
          const timer = setTimeout(callback, delayMs);
          return { cancel: () => clearTimeout(timer) };
        },
        every: (delayMs: number, callback: () => void) => {
          const timerHandle = { delay: delayMs, callback, cancelled: false };
          timers.push(timerHandle);
          return {
            cancel: () => {
              timerHandle.cancelled = true;
            },
          };
        },
      },
    };

    return { $, submittedPrompts, timers };
  }

  await t.test('initializes, polls pending messages, and dispatches to $.prompt.submit', async () => {
    const { $, submittedPrompts } = createMockClaudeHost();

    const dispatcher = new ClaudeCodeModDispatcher({ $ });
    await dispatcher.start();

    // Trigger one poll cycle
    await dispatcher.pollOnce();

    // 1. Message was dispatched into Claude Code prompt with its own marker
    assert.equal(submittedPrompts.length, 1);
    assert.match(submittedPrompts[0].text, /Incoming message for prompt submit/);
    assert.match(submittedPrompts[0].text, /\[arlo-correlation:correlation-mod-1\]/);

    // 2. Handoff is recorded after the call returns. It is not a claim.
    assert.equal(settledMessageId, 'native-mod-1');
    assert.equal(settledStatus, 'submitting');
    assert.deepEqual(reported, ['dispatching', 'submitting']);
    assert.deepEqual(ledgerEvents, []);

    // 3. Queue is now drained
    assert.equal(pendingMessages.length, 0);

    await dispatcher.stop();
  });

  await t.test('settles as discarded when $.prompt.submit returns drop', async () => {
    // Add another message to queue
    pendingMessages.push({
      nativeMessageId: 'native-mod-drop-1',
      messageId: 'msg-mod-drop-1',
      text: 'Message that will be dropped',
      correlationId: 'correlation-mod-drop-1',
      dispatch: { endpoint_id: 'sender-ep', daemon_id: 'daemon-1' },
      enqueuedAt: new Date().toISOString(),
    });

    const { $, submittedPrompts } = createMockClaudeHost({ dropResult: true });

    const dispatcher = new ClaudeCodeModDispatcher({ $ });
    await dispatcher.start();
    await dispatcher.pollOnce();

    assert.equal(submittedPrompts.length, 1);
    assert.equal(settledMessageId, 'native-mod-drop-1');
    assert.equal(settledStatus, 'discarded');
    assert.deepEqual(reported.slice(-2), ['dispatching', 'discarded']);
    assert.deepEqual(ledgerEvents, []);

    await dispatcher.stop();
  });

  await t.test('an explicit empty drop is still a definite host refusal', async () => {
    pendingMessages.push({
      nativeMessageId: 'native-mod-empty-drop',
      messageId: 'msg-mod-empty-drop',
      text: 'Empty drop reason',
      correlationId: 'correlation-mod-empty-drop',
      dispatch: { endpoint_id: 'sender-ep', daemon_id: 'daemon-1' },
      enqueuedAt: new Date().toISOString(),
    });
    const { $ } = createMockClaudeHost({ submitResult: { drop: '' } });
    const dispatcher = new ClaudeCodeModDispatcher({ $ });
    await dispatcher.start();
    await dispatcher.pollOnce();
    assert.deepEqual(reported.slice(-2), ['dispatching', 'discarded']);
    assert.deepEqual(ledgerEvents, []);
    await dispatcher.stop();
  });

  await t.test('failed and incompatible handshakes never enable polling', async (t) => {
    const valid = { accepted: true, sessionId, instanceId: 'test-instance', generation: 1, contractVersion: '2.0.0' };
    const cases = [
      { name: 'HTTP rejection', ok: false, body: valid },
      { name: 'application rejection', ok: true, body: { ...valid, accepted: false } },
      { name: 'session mismatch', ok: true, body: { ...valid, sessionId: 'another-session' } },
      { name: 'contract mismatch', ok: true, body: { ...valid, contractVersion: '3.0.0' } },
      { name: 'invalid body', ok: true, body: null },
      { name: 'transport error', ok: true, body: valid, throws: true },
    ];
    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const { $, timers, submittedPrompts } = createMockClaudeHost();
        const requests: string[] = [];
        $.http.fetch = async (url) => {
          if (url.endsWith('/status')) {
            const body = { ...valid, generation: 0, status: 'active' };
            return { status: 200, ok: true, headers: {}, text: JSON.stringify(body), json: () => body };
          }
          requests.push(url);
          if (scenario.throws) throw new Error('bridge unavailable');
          return {
            status: scenario.ok ? 200 : 401, ok: scenario.ok, headers: {},
            text: JSON.stringify(scenario.body), json: () => scenario.body,
          };
        };
        const dispatcher = new ClaudeCodeModDispatcher({ $ });
        await assert.doesNotReject(() => dispatcher.start());
        await dispatcher.pollOnce();
        assert.equal(dispatcher.isIdle(), false);
        assert.equal(timers.length, 0);
        assert.equal(submittedPrompts.length, 0);
        assert.equal(requests.length, 1);
        assert.ok(requests[0].endsWith('/handshake'));
        await dispatcher.stop();
      });
    }
  });

  await t.test('stop during handshake prevents a late response from installing a timer', async () => {
    const { $, timers } = createMockClaudeHost();
    const handshakeStarted = Promise.withResolvers<void>();
    const releaseHandshake = Promise.withResolvers<void>();
    const requests: string[] = [];
    $.http.fetch = async (url) => {
      if (url.endsWith('/status')) {
        const body = { sessionId, instanceId: 'test-instance', generation: 0, status: 'active', contractVersion: '2.0.0' };
        return { status: 200, ok: true, headers: {}, text: JSON.stringify(body), json: () => body };
      }
      requests.push(url);
      handshakeStarted.resolve();
      await releaseHandshake.promise;
      const body = { accepted: true, sessionId, instanceId: 'test-instance', generation: 1, contractVersion: '2.0.0' };
      return { status: 200, ok: true, headers: {}, text: JSON.stringify(body), json: () => body };
    };
    const dispatcher = new ClaudeCodeModDispatcher({ $ });
    const starting = dispatcher.start();
    await handshakeStarted.promise;
    await dispatcher.stop();
    releaseHandshake.resolve();
    await starting;
    await dispatcher.pollOnce();
    assert.equal(dispatcher.isIdle(), false);
    assert.equal(timers.length, 0);
    assert.equal(requests.length, 1);
  });

  await t.test('stop during environment discovery prevents a later handshake', async () => {
    const { $, timers } = createMockClaudeHost();
    const readingEnvironment = Promise.withResolvers<void>();
    const releaseEnvironment = Promise.withResolvers<void>();
    const getEnvironment = $.env.get;
    let requests = 0;
    $.env.get = async (name) => {
      readingEnvironment.resolve();
      await releaseEnvironment.promise;
      return getEnvironment(name);
    };
    const fetchBridge = $.http.fetch;
    $.http.fetch = async (...args) => { requests++; return fetchBridge(...args); };
    const dispatcher = new ClaudeCodeModDispatcher({ $ });
    const starting = dispatcher.start();
    await readingEnvironment.promise;
    await dispatcher.stop();
    releaseEnvironment.resolve();
    await starting;
    assert.equal(timers.length, 0);
    assert.equal(requests, 0);
  });

  await t.test('cancels background timer on session.end / stop', async () => {
    const { $, timers } = createMockClaudeHost();
    const dispatcher = new ClaudeCodeModDispatcher({ $ });
    await dispatcher.start();

    assert.equal(timers.length, 1);
    assert.equal(timers[0].cancelled, false);

    await dispatcher.stop();
    assert.equal(timers[0].cancelled, true);
  });

  await t.test('idle gating: suppresses prompt submit when turn is active (busy guard)', async () => {
    pendingMessages.push({
      nativeMessageId: 'native-mod-busy-1',
      messageId: 'msg-mod-busy-1',
      text: 'Message during busy turn',
      correlationId: 'correlation-mod-busy-1',
      dispatch: { endpoint_id: 'sender-ep', daemon_id: 'daemon-1' },
      enqueuedAt: new Date().toISOString(),
    });

    const { $, submittedPrompts } = createMockClaudeHost();
    const dispatcher = new ClaudeCodeModDispatcher({ $ });
    await dispatcher.start();

    // Mark turn as started (busy)
    dispatcher.onTurnStart('turn-busy-1');
    assert.equal(dispatcher.isIdle(), false, 'Session must not be idle when a turn is active');

    // Poll while busy
    await dispatcher.pollOnce();

    // Must NOT submit prompt during active turn
    assert.equal(submittedPrompts.length, 0, 'Must not submit prompt while session is busy');
    assert.equal(pendingMessages.length, 1, 'Message must remain in queue while busy');

    await dispatcher.stop();
  });

  await t.test('idle gating: event-driven dispatch recovery on turn.complete', async () => {
    // Keep native-mod-busy-1 in queue
    const { $, submittedPrompts } = createMockClaudeHost();
    const dispatcher = new ClaudeCodeModDispatcher({ $ });
    await dispatcher.start();

    dispatcher.onTurnStart('turn-busy-1');
    assert.equal(dispatcher.isIdle(), false);

    // Call turn.complete -> should trigger event-driven dispatch recovery
    dispatcher.onTurnComplete('turn-busy-1');
    assert.equal(dispatcher.isIdle(), true, 'Session must be idle after turn completes');

    // Give microtask tick for event-driven dispatch to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(submittedPrompts.length, 1, 'Prompt must be submitted automatically on idle recovery');
    assert.match(submittedPrompts[0].text, /Message during busy turn/);
    assert.match(submittedPrompts[0].text, /\[arlo-correlation:correlation-mod-busy-1\]/);
    assert.equal(settledStatus, 'submitting');
    assert.equal(reported.includes('claimed'), false);

    await dispatcher.stop();
  });

  await t.test('race guard: prevents concurrent duplicate prompt submissions', async () => {
    pendingMessages.push({
      nativeMessageId: 'native-mod-race-1',
      messageId: 'msg-mod-race-1',
      text: 'Message for race test',
      correlationId: 'correlation-mod-race-1',
      dispatch: { endpoint_id: 'sender-ep', daemon_id: 'daemon-1' },
      enqueuedAt: new Date().toISOString(),
    });

    const { $, submittedPrompts } = createMockClaudeHost();
    const dispatcher = new ClaudeCodeModDispatcher({ $ });
    await dispatcher.start();

    // Fire 2 concurrent polls simultaneously
    await Promise.all([dispatcher.pollOnce(), dispatcher.pollOnce()]);

    assert.equal(submittedPrompts.length, 1, 'Concurrent polls must not dispatch duplicate prompt submits');

    await dispatcher.stop();
  });

  await t.test('a thrown prompt.submit stays unknown and is not discarded or claimed', async () => {
    pendingMessages.push({
      nativeMessageId: 'native-mod-throw-1',
      messageId: 'msg-mod-throw-1',
      text: 'Message whose submit throws',
      correlationId: 'correlation-mod-throw-1',
      dispatch: { endpoint_id: 'sender-ep', daemon_id: 'daemon-1' },
      enqueuedAt: new Date().toISOString(),
    });

    const { $, submittedPrompts } = createMockClaudeHost();
    $.prompt.submit = async () => {
      submittedPrompts.push({ text: 'thrown' });
      throw new Error('host submit failed');
    };

    const dispatcher = new ClaudeCodeModDispatcher({ $ });
    await dispatcher.start();
    await dispatcher.pollOnce();

    assert.equal(submittedPrompts.length, 1);
    assert.equal(settledStatus, 'unknown');
    assert.deepEqual(reported.slice(-2), ['dispatching', 'unknown']);
    assert.deepEqual(ledgerEvents, []);
    assert.equal(pendingMessages.some((m) => m.nativeMessageId === 'native-mod-throw-1'), false);

    await dispatcher.stop();
  });

  await t.test('a hung prompt.submit becomes unknown and releases the poll loop', async () => {
    pendingMessages.push({
      nativeMessageId: 'native-mod-timeout-1',
      messageId: 'msg-mod-timeout-1',
      text: 'Message whose submit hangs',
      correlationId: 'correlation-mod-timeout-1',
      dispatch: { endpoint_id: 'sender-ep', daemon_id: 'daemon-1' },
      enqueuedAt: new Date().toISOString(),
    });

    const { $ } = createMockClaudeHost();
    $.prompt.submit = () => new Promise(() => {});

    const dispatcher = new ClaudeCodeModDispatcher({ $, promptSubmitTimeoutMs: 20 });
    await dispatcher.start();
    await dispatcher.pollOnce();

    assert.equal(settledStatus, 'unknown');
    assert.deepEqual(reported.slice(-2), ['dispatching', 'unknown']);
    assert.equal(dispatcher.isIdle(), true);

    await dispatcher.stop();
  });

  await t.test('production hooks cancel an in-progress reservation on session.end', async () => {
    // Dynamic import of official register.js hook entrypoint
    const { register } = await import('../packages/adapter-claudecode/mod/hooks/register.js');
    const registeredHooks = new Map<string, Function>();
    const mockOn = (event: string, handler: Function) => {
      registeredHooks.set(event, handler);
      return { catch() {} };
    };

    register(mockOn);

    assert.ok(registeredHooks.has('turn.start'), 'register.js must register turn.start hook');
    assert.ok(registeredHooks.has('turn.complete'), 'register.js must register turn.complete hook');

    const hooksManifest = JSON.parse(
      fs.readFileSync(new URL('../packages/adapter-claudecode/mod/hooks/hooks.json', import.meta.url), 'utf8'),
    ) as { modules?: string[] };
    assert.deepEqual(hooksManifest.modules, ['./register.js']);

    const { $, timers, submittedPrompts } = createMockClaudeHost();
    const armed = Promise.withResolvers<void>();
    const releaseArm = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const reports: string[] = [];
    $.http.fetch = async (url, init) => {
      let body: unknown;
      if (url.endsWith('/status')) body = { sessionId, instanceId: 'test-instance', generation: 0, status: 'active', contractVersion: '2.0.0' };
      else if (url.endsWith('/handshake')) body = { accepted: true, sessionId, instanceId: 'test-instance', generation: 1, contractVersion: '2.0.0' };
      else if (url.endsWith('/pending')) body = { messages: [{ nativeMessageId: 'native-hook', messageId: 'msg-hook', text: 'late input', correlationId: 'correlation-hook' }] };
      else {
        const report = JSON.parse(init!.body!) as { status: string };
        reports.push(report.status);
        if (report.status === 'dispatching') {
          armed.resolve();
          await releaseArm.promise;
        } else if (report.status === 'enqueued') cancelled.resolve();
        body = { settled: false, status: report.status };
      }
      return { status: 200, ok: true, headers: {}, text: JSON.stringify(body), json: () => body };
    };
    const next = async (event: unknown) => event;
    await registeredHooks.get('session.start')!($, {}, next);
    timers[0].callback();
    await armed.promise;
    await registeredHooks.get('session.end')!($, {}, next);
    releaseArm.resolve();
    await cancelled.promise;
    assert.equal(submittedPrompts.length, 0);
    assert.equal(timers[0].cancelled, true);
    assert.deepEqual(reports, ['dispatching', 'enqueued']);
  });
});

