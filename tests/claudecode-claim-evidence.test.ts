import { fetchCurrentBridge } from './helpers/claudecode-bridge-client.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReceptionLedger, type ReceptionEvidence } from '@arlo/adapter-sdk';
import type { ArloMessageNotificationParams, RootCreditReleaseRequest } from '@arlo/sdk';
import {
  CLAIM_EVIDENCE_TIMEOUT_MS,
  ClaudeCodeBridgeServer,
  ClaudeCodeModDispatcher,
  ClaudeCodeReceptionHost,
  CORRELATION_MARKER_PREFIX,
  CORRELATION_MARKER_SUFFIX,
  generateBridgeToken,
  generateCorrelationId,
  type ClaudeModToolHost,
} from '../packages/adapter-claudecode/src/index.ts';
import { awaitDurableStatus, createTempDir, durableStatus, readDurableQueue, removeTempDir } from './test-utils.ts';

function frame(seq: number, text = `claim body ${seq}`): ArloMessageNotificationParams {
  return {
    protocol_version: '0.1',
    daemon_id: 'daemon-claim',
    message_id: `msg-claim-${seq}`,
    delivery_id: `del-claim-${seq}`,
    from_endpoint: 'sender-endpoint',
    to_endpoint: 'cc-receiver-endpoint',
    group_id: 'group-claim',
    target_generation: 1,
    delivery_seq: String(seq),
    text,
    sent_at: new Date().toISOString(),
  };
}

/** A simulated Claude Code host facade speaking to one authenticated bridge. */
function createModHost(options: {
  bridgeUrl: string;
  token: string;
  sessionId: string;
  pending: () => unknown[];
}): { host: ClaudeModToolHost; submitted: string[]; reports: string[] } {
  const submitted: string[] = [];
  const reports: string[] = [];
  const json = (body: unknown) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(body) });
  const host: ClaudeModToolHost = {
    command: { register: async definition => ({ command: definition.name }) },
    tool: { register: async definition => ({ tool: `mcp__arlo-adapter-claudecode__${definition.name}` }) },
    session: { id: async () => options.sessionId },
    env: { get: async (name) => name.endsWith('URL') ? options.bridgeUrl : options.token },
    http: {
      async fetch(url, init) {
        if (url.endsWith('/messages/pending')) return json({ messages: options.pending() });
        // Every mutating report crosses the real authenticated bridge.
        const response = await fetch(url, { method: init?.method, headers: init?.headers, body: init?.body });
        const text = await response.text();
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { /* A malformed bridge body stays null. */ }
        if (url.endsWith('/messages/settle')) reports.push((body as { status?: string }).status ?? 'unknown');
        return { status: response.status, ok: response.ok, headers: {}, text, json: () => body };
      },
    },
    prompt: {
      submit: async (input: { text: string }) => {
        submitted.push(input.text);
        return { text: input.text };
      },
    },
    clock: {
      now: async () => Date.now(),
      every: () => ({ cancel() {} }),
      after: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return { cancel: () => clearTimeout(timer) };
      },
    },
  };
  return { host, submitted, reports };
}

test('Durable reception ledger settles claims only on this message correlation marker (#88)', async (t) => {
  const storageDir = createTempDir('cc-claim-host-');
  t.after(() => removeTempDir(storageDir));

  await t.test('every message carries its own marker and the handoff stays submitting', async () => {
    const sessionId = 'session-claim-host';
    const host = new ClaudeCodeReceptionHost({ sessionId, storageDir });
    const first = host.prepare(frame(1, 'first body'));
    const second = host.prepare(frame(2, 'second body'));
    assert.notEqual(first.nativeMessageId, second.nativeMessageId);
    assert.equal(await first.enqueue(), 'enqueued');
    assert.equal(await second.enqueue(), 'enqueued');

    const markers = readDurableQueue(storageDir, sessionId).map(record => record.correlationId);
    assert.equal(markers.length, 2);
    for (const marker of markers) assert.match(marker!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(new Set(markers).size, 2, 'Each message owns a distinct correlation marker');

    host.beginDispatch(first.nativeMessageId);
    host.recordHandoff(first.nativeMessageId);
    assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-1'), 'submitting');
    assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-2'), 'enqueued');
    assert.deepEqual(host.getPendingMessages().map(record => record.messageId), ['msg-claim-2']);
  });

  await t.test('claim evidence releases capacity and credit; a foreign marker never does', async () => {
    const sessionId = 'session-claim-evidence';
    const host = new ClaudeCodeReceptionHost({ sessionId, storageDir });
    const evidences: ReceptionEvidence[] = [];
    host.observe(evidence => evidences.push(evidence));
    const credits: RootCreditReleaseRequest[] = [];
    const ledger = new ReceptionLedger({ host, currentGeneration: 1, onCredit: proof => credits.push(proof) });

    assert.equal((await ledger.receiveFrame(frame(10, 'provable body'))).status, 'enqueued');
    assert.equal(ledger.getAvailableCapacity(), 63, 'Pending input holds one credit');
    const marker = `${CORRELATION_MARKER_PREFIX}${readDurableQueue(storageDir, sessionId)[0]!.correlationId}${CORRELATION_MARKER_SUFFIX}`;
    const nativeId = host.snapshot({ instanceId: host.instanceId, generation: 1 }).pending[0]!.nativeMessageId;

    host.beginDispatch(nativeId);
    host.recordHandoff(nativeId);
    assert.equal(ledger.getAvailableCapacity(), 63, 'A handoff still occupies queue capacity');

    // A marker belonging to another message is not evidence for this one, and
    // neither is its bare identifier.
    for (const foreign of [generateCorrelationId(),
      `${CORRELATION_MARKER_PREFIX}${generateCorrelationId()}${CORRELATION_MARKER_SUFFIX}`]) {
      assert.throws(() => host.claim(nativeId, undefined, foreign), (error: unknown) =>
        error instanceof Error && 'statusCode' in error && (error as { statusCode: number }).statusCode === 409);
    }
    assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-10'), 'submitting');
    assert.equal(credits.length, 0, 'An unproven handoff releases no credit');

    host.claim(nativeId, 'msg-claim-10', marker);
    assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-10'), 'claimed');
    assert.deepEqual(evidences.map(evidence => evidence.event), ['claimed']);
    assert.equal(ledger.getAvailableCapacity(), 64, 'A claim releases queue capacity');
    assert.deepEqual(credits.map(proof => ({ message: proof.message_id, event: proof.event })),
      [{ message: 'msg-claim-10', event: 'claimed' }]);

    // Repeating the same proven claim changes nothing and proves nothing twice.
    host.claim(nativeId, 'msg-claim-10', marker);
    assert.equal(credits.length, 1);
    assert.deepEqual(ledger.getUnconfirmedCredits().map(proof => proof.event), ['claimed']);
    ledger.dispose();
  });

  await t.test('an unproven handoff ends unknown and keeps occupying capacity', async () => {
    const sessionId = 'session-claim-unknown';
    const host = new ClaudeCodeReceptionHost({ sessionId, storageDir });
    const credits: RootCreditReleaseRequest[] = [];
    const ledger = new ReceptionLedger({ host, currentGeneration: 1, onCredit: proof => credits.push(proof) });
    assert.equal((await ledger.receiveFrame(frame(11, 'unprovable body'))).status, 'enqueued');
    const nativeId = host.snapshot({ instanceId: host.instanceId, generation: 1 }).pending[0]!.nativeMessageId;

    host.beginDispatch(nativeId);
    host.recordHandoff(nativeId);
    host.recordUnresolved(nativeId);

    assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-11'), 'unknown');
    assert.equal(ledger.getAvailableCapacity(), 63, 'Unresolved input still occupies capacity');
    assert.equal(credits.length, 0, 'No credit is released without claim evidence');
    assert.deepEqual(host.getPendingMessages(), [], 'Unresolved input is never submitted again');
    ledger.dispose();
  });

  await t.test('an explicit host drop discards the input and releases capacity', async () => {
    const sessionId = 'session-claim-drop';
    const host = new ClaudeCodeReceptionHost({ sessionId, storageDir });
    const credits: RootCreditReleaseRequest[] = [];
    const ledger = new ReceptionLedger({ host, currentGeneration: 1, onCredit: proof => credits.push(proof) });
    assert.equal((await ledger.receiveFrame(frame(12, 'dropped body'))).status, 'enqueued');
    const nativeId = host.snapshot({ instanceId: host.instanceId, generation: 1 }).pending[0]!.nativeMessageId;

    host.beginDispatch(nativeId);
    host.recordNotEntered(nativeId);

    assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-12'), 'discarded');
    assert.equal(ledger.getAvailableCapacity(), 64, 'A discard releases queue capacity');
    assert.deepEqual(credits.map(proof => proof.event), ['discarded']);
    ledger.dispose();
  });

  await t.test('the Sidecar formats the marker and the Mod only embeds it', async () => {
    const { composeSubmittedPrompt, ClaudeCodeModDispatcher: Mod } =
      await import('../packages/adapter-claudecode/mod/hooks/register.js');
    const correlationId = generateCorrelationId();
    const marker = `${CORRELATION_MARKER_PREFIX}${correlationId}${CORRELATION_MARKER_SUFFIX}`;
    // The Mod never formats a marker; it appends the one the bridge handed it.
    assert.equal(composeSubmittedPrompt('body', marker), `body\n\n${marker}`);
    assert.equal(composeSubmittedPrompt('', marker), marker);
    // The Mod cannot import the Sidecar contract, so its default window is pinned here.
    const defaults = new Mod({ $: createModHost({ bridgeUrl: 'http://127.0.0.1:1', token: 't', sessionId: 's', pending: () => [] }).host });
    assert.equal(defaults.claimEvidenceTimeoutMs, CLAIM_EVIDENCE_TIMEOUT_MS);
  });
});

test('Mod preserves reception outcomes while handoff reporting is pending (#88)', async (t) => {
  for (const interruption of ['timeout', 'stop', 'transport error', 'claim evidence'] as const) {
    for (const published of [false, true]) {
      await t.test(`${interruption}, ${published ? 'after' : 'before'} durable handoff`, async (t) => {
        const storageDir = createTempDir('cc-claim-race-');
        t.after(() => removeTempDir(storageDir));
        const sessionId = 'session-claim-race';
        const receptionHost = new ClaudeCodeReceptionHost({ sessionId, storageDir });
        const ledger = new ReceptionLedger({ host: receptionHost, currentGeneration: 1 });
        t.after(() => ledger.dispose());
        assert.equal((await ledger.receiveFrame(frame(50))).status, 'enqueued');
        const token = generateBridgeToken();
        const server = new ClaudeCodeBridgeServer({ sessionId, token, receptionHost });
        await server.start();
        t.after(() => server.stop());
        const mod = createModHost({
          bridgeUrl: server.url, token, sessionId,
          pending: () => receptionHost.getPendingMessages().map(record => ({
            ...record,
            correlationMarker: `${CORRELATION_MARKER_PREFIX}${record.correlationId}${CORRELATION_MARKER_SUFFIX}`,
          })),
        });
        let expireEvidence: (() => void) | undefined;
        const after = mod.host.clock.after;
        mod.host.clock.after = (delay, callback) => {
          if (delay !== CLAIM_EVIDENCE_TIMEOUT_MS) return after(delay, callback);
          expireEvidence = callback;
          return { cancel() { expireEvidence = undefined; } };
        };
        const handoffStarted = Promise.withResolvers<void>();
        const releaseHandoff = Promise.withResolvers<void>();
        const fetchBridge = mod.host.http.fetch;
        const unresolvedReasons: string[] = [];
        mod.host.http.fetch = async (url, init) => {
          if (url.endsWith('/messages/settle')) {
            const body = JSON.parse(init!.body!);
            if (body.status === 'unknown') unresolvedReasons.push(body.reason);
          }
          if (!url.endsWith('/messages/settle') || JSON.parse(init!.body!).status !== 'submitting') {
            return fetchBridge(url, init);
          }
          const response = published ? await fetchBridge(url, init) : undefined;
          handoffStarted.resolve();
          await releaseHandoff.promise;
          if (interruption === 'transport error') throw new Error('Handoff response lost');
          return response ?? fetchBridge(url, init);
        };
        const dispatcher = new ClaudeCodeModDispatcher({ $: mod.host });
        t.after(() => dispatcher.stop());
        await dispatcher.start();
        const polling = dispatcher.pollOnce();
        await handoffStarted.promise;
        assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-50'), published ? 'submitting' : 'dispatching');
        if (interruption === 'timeout') expireEvidence!();
        if (interruption === 'stop') await dispatcher.stop();
        if (interruption === 'claim evidence') {
          dispatcher.onTurnStart('turn-during-handoff', { text: mod.submitted[0] });
        }
        releaseHandoff.resolve();
        await polling;
        if (interruption === 'claim evidence') {
          await awaitDurableStatus(storageDir, sessionId, 'msg-claim-50', 'claimed');
          assert.equal(ledger.getAvailableCapacity(), 64, 'Buffered claim evidence releases credit');
          assert.equal(ledger.getUnconfirmedCredits().length, 1);
          assert.deepEqual(unresolvedReasons, []);
        } else {
          // Also expire any remaining window after a transport exception.
          expireEvidence?.();
          assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-50'), 'unknown');
          assert.equal(ledger.getAvailableCapacity(), 63, 'Unknown input retains its credit');
          assert.deepEqual(ledger.getUnconfirmedCredits(), [], 'No claim or discard evidence is manufactured');
          assert.deepEqual(unresolvedReasons, [interruption === 'timeout' ? 'CLAIM_EVIDENCE_TIMEOUT'
            : interruption === 'stop' ? 'SESSION_ENDED' : 'HANDOFF_REPORT_FAILED']);
        }
        await dispatcher.pollOnce();
        assert.equal(mod.submitted.length, 1, 'Interrupted handoffs never resubmit business text');
        assert.deepEqual(receptionHost.getPendingMessages(), []);
      });
    }
  }
});

test('Bridge settles correlated claims and refuses uncorrelated evidence (#88)', async (t) => {
  const storageDir = createTempDir('cc-claim-bridge-');
  t.after(() => removeTempDir(storageDir));
  const sessionId = 'session-claim-bridge';
  const receptionHost = new ClaudeCodeReceptionHost({ sessionId, storageDir });
  const prepared = receptionHost.prepare(frame(20, 'bridged body'));
  await prepared.enqueue();
  const correlationId = readDurableQueue(storageDir, sessionId)[0]!.correlationId!;
  const marker = `${CORRELATION_MARKER_PREFIX}${correlationId}${CORRELATION_MARKER_SUFFIX}`;
  const token = generateBridgeToken();
  const server = new ClaudeCodeBridgeServer({ sessionId, token, receptionHost });
  await server.start();
  t.after(() => server.stop());
  const headers = { Authorization: `Bearer ${token}`, 'x-session-id': sessionId, 'Content-Type': 'application/json' };
  const post = async (body: unknown, key?: string) => {
    const response = await fetchCurrentBridge(`${server.url}/api/v1/bridge/messages/claim`, {
      method: 'POST', headers: { ...headers, ...(key ? { 'x-idempotency-key': key } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const settle = async (body: unknown) => {
    const response = await fetchCurrentBridge(`${server.url}/api/v1/bridge/messages/settle`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const evidence = { nativeMessageId: prepared.nativeMessageId, messageId: 'msg-claim-20', correlationMarker: marker, timestamp: 1 };

  await t.test('the pending payload carries this message correlation marker', async () => {
    const response = await fetchCurrentBridge(`${server.url}/api/v1/bridge/messages/pending`, { headers });
    const body = await response.json() as { messages: Array<{ correlationMarker?: string; text: string }> };
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0]!.correlationMarker, marker);
    assert.equal(body.messages[0]!.text, 'bridged body', 'The queue keeps the business text unmodified');
  });

  await t.test('claim evidence requires the marker this Sidecar issued', async () => {
    for (const malformed of [null, [], {}, { ...evidence, correlationMarker: undefined },
      { ...evidence, correlationMarker: 7 }, { ...evidence, nativeMessageId: '' }, { ...evidence, timestamp: -1 }]) {
      const response = await post(malformed);
      assert.equal(response.status, 400);
      assert.match(JSON.stringify(response.body), /INVALID_ARGUMENT/);
    }
    assert.equal((await post({ ...evidence, nativeMessageId: 'missing' })).status, 404);
    assert.equal((await post({ ...evidence, messageId: 'wrong-message' })).status, 409);
    assert.equal((await post({ ...evidence,
      correlationMarker: `${CORRELATION_MARKER_PREFIX}${generateCorrelationId()}${CORRELATION_MARKER_SUFFIX}` })).status, 409);
    assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-20'), 'enqueued');
    // A claim before any host submission is not evidence of ingestion.
    assert.equal((await post(evidence)).status, 409);
    assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-20'), 'enqueued');
  });

  await t.test('the host handoff then correlated claim settles the input', async () => {
    assert.equal((await settle({ nativeMessageId: prepared.nativeMessageId, status: 'dispatching', timestamp: 2 })).status, 200);
    assert.equal((await settle({ nativeMessageId: prepared.nativeMessageId, status: 'submitting', timestamp: 3 })).status, 200);
    assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-20'), 'submitting');

    const claimed = await post(evidence, 'claim-once');
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.claimed, true);
    assert.equal(claimed.body.status, 'claimed');
    assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-20'), 'claimed');

    const replayed = await post(evidence, 'claim-once');
    assert.deepEqual(replayed, claimed, 'A retried claim with its key replays the same outcome');
    const repeated = await post(evidence, 'other-claim');
    assert.equal(repeated.status, 200, 'A proven claim repeated with another key settles nothing new');
    assert.equal(receptionHost.snapshot({ instanceId: receptionHost.instanceId, generation: 1 }).inFlight.length, 0);
    // Claim settlement is not available through the generic settle route.
    const rejected = await settle({ nativeMessageId: prepared.nativeMessageId, status: 'claimed', timestamp: 4 });
    assert.equal(rejected.status, 400);
    assert.match(JSON.stringify(rejected.body), /INVALID_ARGUMENT/);
  });

  await t.test('a handoff without claim evidence ends unknown through the settle route', async () => {
    const late = receptionHost.prepare(frame(21, 'late unprovable body'));
    await late.enqueue();
    assert.equal((await settle({ nativeMessageId: late.nativeMessageId, status: 'dispatching', timestamp: 5 })).status, 200);
    assert.equal((await settle({ nativeMessageId: late.nativeMessageId, status: 'submitting', timestamp: 6 })).status, 200);
    const unresolved = await settle({ nativeMessageId: late.nativeMessageId, status: 'unknown', timestamp: 7, reason: 'CLAIM_EVIDENCE_TIMEOUT' });
    assert.equal(unresolved.status, 200);
    assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-21'), 'unknown');
    assert.equal(receptionHost.snapshot({ instanceId: receptionHost.instanceId, generation: 1 }).inFlight.length, 1,
      'Unresolved input keeps occupying capacity');
  });
});

test('In-process Mod claims only the host turn input carrying its marker (#88)', async (t) => {
  const storageDir = createTempDir('cc-claim-mod-');
  t.after(() => removeTempDir(storageDir));
  const sessionId = 'session-claim-mod';
  const receptionHost = new ClaudeCodeReceptionHost({ sessionId, storageDir });
  const token = generateBridgeToken();
  const server = new ClaudeCodeBridgeServer({ sessionId, token, receptionHost });
  await server.start();
  t.after(() => server.stop());

  const { register } = await import('../packages/adapter-claudecode/mod/hooks/register.js');
  type ModHook = Parameters<Parameters<typeof register>[0]>[1];
  const hooks = new Map<string, ModHook>();
  register((event: string, handler: ModHook) => { hooks.set(event, handler); return { catch() {} }; });

  /** The bridge only ever returns input that is still waiting in the queue. */
  const stillPending = (messageId: string) => readDurableQueue(storageDir, sessionId)
    .some(record => record.messageId === messageId && record.status === 'enqueued');
  const pendingItem = (messageId: string, text: string, nativeMessageId: string, marker: string) =>
    stillPending(messageId) ? [{ nativeMessageId, messageId, text, correlationMarker: marker }] : [];

  /** The Mod records a report once the bridge answers it, which can lag the durable write. */
  async function untilReported(reports: string[], status: string): Promise<void> {
    for (let attempt = 0; attempt < 100 && !reports.includes(status); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  /** Attaches the shipped Mod hooks to one simulated host bound to the bridge. */
  async function attachMod(pending: () => unknown[]) {
    const mod = createModHost({ bridgeUrl: server.url, token, sessionId, pending });
    let poll: (() => void) | undefined;
    const clock = mod.host.clock;
    mod.host.clock = { ...clock, every: (_delay, callback) => { poll = callback; return { cancel() {} }; } };
    const next = async (event: unknown) => event;
    await hooks.get('session.start')!(mod.host, {}, next);
    return { mod, next, poll: () => poll?.() };
  }

  await t.test('the shipped Mod claims only the host turn input carrying its marker', async () => {
    // The host wraps plugin-origin text; this is the shape a real Claude Code
    // turn.start event carries for a plugin submit.
    const pluginWrapper = (body: string) =>
      `The arlo-adapter-claudecode plugin sent a message:\n${body}\n\nThis is how Claude Code surfaces a plugin prompt.`;
    const prepared = receptionHost.prepare(frame(30, 'incoming collaboration body'));
    await prepared.enqueue();
    const marker = `${CORRELATION_MARKER_PREFIX}${readDurableQueue(storageDir, sessionId)[0]!.correlationId}${CORRELATION_MARKER_SUFFIX}`;
    const attached = await attachMod(() => pendingItem('msg-claim-30', 'incoming collaboration body', prepared.nativeMessageId, marker));

    // The sending Mod never observes its own background submit.
    assert.equal([...hooks.keys()].includes('prompt.submit'), false,
      'A background submit must not depend on the sending Mod own prompt.submit hook');

    attached.poll();
    await awaitDurableStatus(storageDir, sessionId, 'msg-claim-30', 'submitting');
    await untilReported(attached.mod.reports, 'submitting');
    assert.equal(attached.mod.submitted.length, 1);
    assert.match(attached.mod.submitted[0]!, /incoming collaboration body/);
    assert.ok(attached.mod.submitted[0]!.includes(marker),
      'The submitted prompt carries this message own marker');
    assert.deepEqual(attached.mod.reports, ['dispatching', 'submitting'],
      'The Mod reports the handoff and never reports a claim through the settle route');
    assert.equal(receptionHost.snapshot({ instanceId: receptionHost.instanceId, generation: 1 }).inFlight.length, 1,
      'A handoff still occupies queue capacity');

    // An unrelated turn input proves nothing, and neither does a model reply that
    // echoes the marker back.
    await hooks.get('turn.start')!(attached.mod.host, { turnId: 'turn-human', text: 'an unrelated human request' }, attached.next);
    await hooks.get('turn.complete')!(attached.mod.host, {
      turnId: 'turn-human', reason: 'end_turn', answer: `I saw ${marker}`, durationMs: 12, isAborted: false, usage: {},
    }, attached.next);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(durableStatus(storageDir, sessionId, 'msg-claim-30'), 'submitting',
      'Neither an unrelated turn nor a model echo of the marker is claim evidence');

    // The host turn input that ingested the message does carry its marker, and it
    // is wrapped rather than verbatim.
    await hooks.get('turn.start')!(attached.mod.host, {
      turnId: 'turn-ingest', text: pluginWrapper(attached.mod.submitted[0]!),
    }, attached.next);
    await awaitDurableStatus(storageDir, sessionId, 'msg-claim-30', 'claimed');
    assert.equal(receptionHost.snapshot({ instanceId: receptionHost.instanceId, generation: 1 }).inFlight.length, 0,
      'A claim releases the held capacity');
    // Keep this context alive for the following handoff cases; each attachment
    // takes over through the authenticated generation handshake.
  });

  await t.test('an unproven handoff ends unknown without resubmitting the business text', async () => {
    const second = receptionHost.prepare(frame(31, 'second unprovable body'));
    await second.enqueue();
    const secondId = readDurableQueue(storageDir, sessionId).find(record => record.messageId === 'msg-claim-31')!.correlationId!;
    const secondMarker = `${CORRELATION_MARKER_PREFIX}${secondId}${CORRELATION_MARKER_SUFFIX}`;
    // The evidence window is a dispatcher option, so this case drives the same
    // class the production hooks instantiate, with a short window.
    const lonely = createModHost({
      bridgeUrl: server.url, token, sessionId,
      pending: () => pendingItem('msg-claim-31', 'second unprovable body', second.nativeMessageId, secondMarker),
    });
    const waiting = new ClaudeCodeModDispatcher({ $: lonely.host, claimEvidenceTimeoutMs: 40 });
    await waiting.start();
    await waiting.pollOnce();
    await awaitDurableStatus(storageDir, sessionId, 'msg-claim-31', 'submitting');
    assert.equal(lonely.submitted.length, 1);
    // A turn for something else does not prove this message was ingested.
    waiting.onTurnStart('turn-unrelated', { turnId: 'turn-unrelated', text: 'an unrelated request' });
    await awaitDurableStatus(storageDir, sessionId, 'msg-claim-31', 'unknown');
    assert.deepEqual(receptionHost.getPendingMessages(), [], 'Unresolved input is not scheduled again');
    assert.equal(lonely.submitted.length, 1, 'The business text is never submitted again');
    await waiting.stop();
  });

  await t.test('a bridge that issued no marker still delivers the text and ends unknown', async () => {
    const third = receptionHost.prepare(frame(32, 'markerless body'));
    await third.enqueue();
    const plain = createModHost({
      bridgeUrl: server.url, token, sessionId,
      pending: () => stillPending('msg-claim-32')
        ? [{ nativeMessageId: third.nativeMessageId, messageId: 'msg-claim-32', text: 'markerless body' }]
        : [],
    });
    const legacy = new ClaudeCodeModDispatcher({ $: plain.host });
    await legacy.start();
    await legacy.pollOnce();
    await awaitDurableStatus(storageDir, sessionId, 'msg-claim-32', 'unknown');
    assert.equal(plain.submitted.length, 1);
    assert.equal(plain.submitted[0], 'markerless body', 'The business text is still delivered unmodified');
    assert.deepEqual(receptionHost.getPendingMessages(), [], 'Unproven input is never submitted again');
    await legacy.stop();
  });
});
