import { fetchCurrentBridge } from './helpers/claudecode-bridge-client.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  ClaudeCodeSidecar,
  ClaudeCodeModDispatcher,
  generateBridgeToken,
  type ClaudeModHost,
  BRIDGE_ERROR_CODES,
  CORRELATION_MARKER_PREFIX,
  CORRELATION_MARKER_SUFFIX,
} from '../packages/adapter-claudecode/src/index.ts';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';
import { awaitDurableStatus, createTempDir, readDurableQueue, removeTempDir } from './test-utils.ts';

test('Claude Code Adapter - End-to-End Through-Line & Contract Acceptance (#87)', async (t) => {
  const groupName = 'cc-e2e-group';
  const sidecarStateDir = createTempDir('cc-sidecar-state-');
  const sessionId = 'session-cc-root-01';
  const token = generateBridgeToken();

  t.after(() => {
    removeTempDir(sidecarStateDir);
  });

  // 1. Boot daemon and sender root via MessageStatusFixture
  const fixture = await MessageStatusFixture.create({
    roots: 1,
    groupName,
  });

  // Enable cross-host participation on the sender runtime so it can communicate with claudecode
  await fixture.control.updateRuntimeParticipation(fixture.runtimeToken, true);

  t.after(async () => {
    await fixture.dispose();
  });

  // 2. Start Claude Code Sidecar connected to the same Daemon
  const sidecar = new ClaudeCodeSidecar({
    sessionId,
    token,
    stateDir: sidecarStateDir,
    groupName,
    controlClient: fixture.control,
  });

  const { url: bridgeUrl } = await sidecar.start();

  t.after(async () => {
    await sidecar.stop();
  });

  // 3. Verify Bridge Security & Session Isolation (Contract Seam)
  await t.test('Bridge rejects unauthenticated requests with UNAUTHORIZED', async () => {
    const res = await fetch(`${bridgeUrl}/api/v1/bridge/status`, {
      headers: { 'x-session-id': sessionId },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, BRIDGE_ERROR_CODES.UNAUTHORIZED);
  });

  await t.test('Bridge rejects invalid token with UNAUTHORIZED', async () => {
    const res = await fetch(`${bridgeUrl}/api/v1/bridge/status`, {
      headers: {
        'Authorization': 'Bearer wrong-secret-token',
        'x-session-id': sessionId,
      },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, BRIDGE_ERROR_CODES.UNAUTHORIZED);
  });

  await t.test('Bridge rejects cross-session access with SESSION_MISMATCH', async () => {
    const res = await fetch(`${bridgeUrl}/api/v1/bridge/status`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-session-id': 'unauthorized-other-session',
      },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.code, BRIDGE_ERROR_CODES.SESSION_MISMATCH);
  });

  // 4. Verify Active Endpoint Registration with Daemon
  let endpointId: string | undefined;
  let sentMessageId: string | undefined;
  await t.test('Sidecar registers root session as an active Arlo endpoint', async () => {
    assert.deepEqual(sidecar.host.roots(), [], 'A listening bridge is not yet a live root');
    const beforeHandshake = await fixture.control.listRoots();
    assert.equal(beforeHandshake.length, 1);
    const handshake = await fetchCurrentBridge(`${bridgeUrl}/api/v1/bridge/handshake`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-session-id': sessionId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ modVersion: '0.1.0', capabilities: ['prompt.submit'] }),
    });
    assert.equal(handshake.status, 200);
    await sidecar.waitForReady(15000);

    // List roots from daemon control plane
    for (let i = 0; i < 30; i++) {
      const roots = await fixture.control.listRoots();
      const match = roots.find(
        (r) => r.endpoint_id !== fixture.roots[0].registration.endpoint_id && r.ready
      );
      if (match) {
        endpointId = match.endpoint_id;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(endpointId, 'Claude Code endpoint must be discovered in daemon');
  });

  await t.test('cross-host discovery requires an explicit receiver opt-in', async () => {
    const sender = fixture.roots[0].connection;
    const before = JSON.parse((await sender.listSessions())[0].text) as { endpoint_id: string }[];
    assert.equal(before.some((session) => session.endpoint_id === endpointId), false);
    const enabled = await fetchCurrentBridge(`${bridgeUrl}/api/v1/bridge/commands/call`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'x-session-id': sessionId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'arlo-settings', arguments: 'on' }),
    });
    assert.equal(enabled.status, 200);
    const after = JSON.parse((await sender.listSessions())[0].text) as { endpoint_id: string }[];
    assert.equal(after.some((session) => session.endpoint_id === endpointId), true);
  });

  // 5. Verify Durable Enqueue before Acceptance
  await t.test('Incoming unicast message is persisted to disk before returning accepted', async () => {
    assert.ok(endpointId);

    // Sender sends unicast message to Claude Code endpoint
    const sender = fixture.roots[0];
    const sendResult = await sender.connection.sendMessage({
      to: endpointId,
      text: 'Test message for Claude Code prompt submission',
    });

    assert.equal(sendResult.status, 'accepted', 'Daemon must report accepted');
    sentMessageId = sendResult.message_id;

    // Assert that the message is durably present on disk in sidecar storage
    const queueFile = path.join(sidecarStateDir, sessionId, 'queue.jsonl');
    assert.ok(fs.existsSync(queueFile), 'Queue file must exist');
    const content = fs.readFileSync(queueFile, 'utf8');
    assert.match(
      content,
      /Test message for Claude Code prompt submission/,
      'Message text must be durably stored before accepted'
    );
  });

  // 6. Verify In-Process Mod Reception & $.prompt.submit Dispatch
  await t.test('In-process Mod receives message across authenticated bridge and submits to prompt', async () => {
    const submittedPrompts: { text: string }[] = [];

    const mock$: ClaudeModHost = {
      session: {
        id: async () => sessionId,
      },
      env: {
        get: async (key: string) => {
          if (key === 'ARLO_CLAUDECODE_BRIDGE_URL') return bridgeUrl;
          if (key === 'ARLO_CLAUDECODE_BRIDGE_TOKEN') return token;
          return undefined;
        },
      },
      http: {
        fetch: async (url, init) => {
          const res = await fetch(url, {
            method: init?.method,
            headers: init?.headers,
            body: init?.body,
          });
          const text = await res.text();
          let json: unknown;
          try { json = JSON.parse(text); } catch { json = null; }
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
        submit: async (input) => {
          submittedPrompts.push(input);
          return { text: input.text };
        },
      },
      clock: {
        now: async () => Date.now(),
        after: (delay, callback) => {
          const timer = setTimeout(callback, delay);
          return { cancel: () => clearTimeout(timer) };
        },
        every: (_delay, _callback) => {
          return { cancel: () => {} };
        },
      },
    };

    const mod = new ClaudeCodeModDispatcher({ $: mock$ });
    await mod.start();

    // Poll message from bridge
    await mod.pollOnce();

    // Assert that prompt.submit was called with the business text and this
    // message's own correlation marker.
    assert.equal(submittedPrompts.length, 1);
    assert.match(submittedPrompts[0].text, /Test message for Claude Code prompt submission/);
    const submitted = await awaitDurableStatus(sidecarStateDir, sessionId, sentMessageId!, 'submitting');
    assert.ok(submitted.correlationId);
    assert.ok(submittedPrompts[0].text.includes(`${CORRELATION_MARKER_PREFIX}${submitted.correlationId}${CORRELATION_MARKER_SUFFIX}`),
      'The submitted prompt must carry this message correlation marker');
    assert.equal(readDurableQueue(sidecarStateDir, sessionId).some(record => record.status === 'claimed'), false,
      'A submit without drop is a handoff, not a claim');

    // The handoff still occupies the receiving queue until it is proven.
    assert.ok(endpointId);
    const held = sidecar.receptionHost.snapshot({
      instanceId: sidecar.receptionHost.instanceId, generation: 1,
    });
    assert.equal(held.inFlight.length, 1, 'A handoff still occupies queue capacity');
    assert.equal(held.pending.length, 0);

    // The host turn input that ingested the message carries its marker, and the
    // host wraps plugin-origin text rather than passing it verbatim.
    mod.onTurnStart('turn-claim-evidence', {
      turnId: 'turn-claim-evidence',
      text: `The arlo-adapter-claudecode plugin sent a message:\n${submittedPrompts[0].text}`,
    });
    await awaitDurableStatus(sidecarStateDir, sessionId, sentMessageId!, 'claimed');
    const released = sidecar.receptionHost.snapshot({
      instanceId: sidecar.receptionHost.instanceId, generation: 1,
    });
    assert.equal(released.inFlight.length, 0, 'A claim releases the held capacity');

    await mod.stop();
  });
});
