import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createAdapterRuntime, ReceptionLedger, receiptOutcome, type AdapterHost, type SharedStartupOptions, type PendingInput, type ReceptionHost } from '@arlo/adapter-sdk';
import type { ArloMessageNotificationParams } from '@arlo/sdk';

test('An installed independent adapter cancels its injected startup and detaches host lifecycle listeners', { timeout: 5000 }, async () => {
  const root = {};
  const started = Promise.withResolvers<SharedStartupOptions>();
  let detached = 0;
  let startupCompleted = false;
  const host: AdapterHost<typeof root> = {
    roots: () => [root],
    sessionId: () => 'independent-root',
    sessionCwd: () => undefined,
    reception() { throw new Error('A cancelled startup cannot attach reception'); },
    onCreated: () => () => { detached++; },
    onDisposed: () => () => { detached++; },
  };
  const stateDir = path.resolve('fictional-independent-state');
  const runtime = createAdapterRuntime({
    host, hostType: 'independent-fixture', hostVersion: '1',
    groupName: 'independent-group', stateDir, autoStart: { idleTimeoutMs: 1234 },
    async startSharedDaemon(options) {
      started.resolve(options);
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      startupCompleted = true;
    },
  });
  try {
    const startup = await started.promise;
    assert.equal(startup.stateDir, stateDir);
    assert.equal(startup.idleTimeoutMs, 1234);
    assert.equal(startup.signal.aborted, false);
    await runtime.dispose();
    assert.equal(startup.signal.aborted, true);
    assert.equal(startupCompleted, true);
    assert.equal(detached, 2);
    await assert.rejects(runtime.listSessions(root, {}), { code: 'CHANNEL_NOT_READY' });
    await runtime.dispose();
    assert.equal(detached, 2, 'Repeated disposal does not detach another host integration');
  } finally {
    await runtime.dispose();
  }
});

test('Independent adapter packages expose compiled public entries without DSH or Daemon references', () => {
  for (const name of ['adapter-sdk', 'sdk']) {
    const entry = fileURLToPath(import.meta.resolve(`@arlo/${name}`));
    assert.ok(entry.endsWith('.js'), 'Installed consumers load emitted JavaScript');
    const directory = path.resolve(path.dirname(entry), '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (name === 'adapter-sdk') assert.deepEqual(manifest.dependencies, { '@arlo/sdk': '0.1.0' });
    for (const target of Object.values(manifest.exports) as { types: string; default: string }[]) {
      assert.ok(fs.existsSync(path.join(directory, target.types)), 'Every public entry includes declarations');
    }
    for (const file of fs.readdirSync(path.join(directory, 'src'), { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !/\.(?:js|d\.ts)$/.test(file.name)) continue;
      const content = fs.readFileSync(path.join(file.parentPath, file.name), 'utf8');
      assert.doesNotMatch(content, /@deepseek-ai\/|@arlo\/(?:daemon|adapter-dsh|harness-adapter|dsh-contact)/,
        'Shared runtime code and declarations must not depend on DSH or Daemon');
    }
  }
});

test('An independent host consumes public reception and credit contracts from the installed adapter SDK', async () => {
  // An artificial portability fixture, not an implementation of another host.
  const frame: ArloMessageNotificationParams = {
    protocol_version: '0.1', daemon_id: 'daemon-isolated', message_id: 'msg-isolated',
    delivery_id: 'delivery-isolated', from_endpoint: 'endpoint-sender', to_endpoint: 'endpoint-receiver',
    group_id: 'group-isolated', target_generation: 3, delivery_seq: '1',
    text: 'Fictional independent reception', sent_at: '2026-01-01T00:00:00.000Z',
  };
  const dispatch = {
    daemon_id: frame.daemon_id, endpoint_id: frame.to_endpoint,
    message_id: frame.message_id, delivery_id: frame.delivery_id, generation: frame.target_generation,
  };
  const pending: PendingInput[] = [];
  let insertions = 0;
  const host: ReceptionHost = {
    instanceId: 'isolated-host-instance',
    prepare(input) {
      const nativeMessageId = `native-${input.message_id}`;
      return {
        nativeMessageId,
        enqueue() {
          insertions++;
          pending.push({ nativeMessageId, messageId: input.message_id, textBytes: Buffer.byteLength(input.text), dispatch });
          return 'enqueued';
        },
      };
    },
    snapshot: scope => ({ ...scope, complete: true, pending: [...pending], inFlight: [] }),
  };
  const ledger = new ReceptionLedger({ host, currentGeneration: 3, initialCapacity: 2 });
  try {
    const first = await ledger.receiveFrame(frame);
    assert.equal(first.status, 'enqueued');
    assert.equal(receiptOutcome(first).status, 'enqueued');
    assert.deepEqual(await ledger.receiveFrame(frame), first);
    assert.equal(insertions, 1, 'A duplicate dispatch never inserts another business input');
    assert.equal(ledger.getAvailableCapacity(), 1, 'Accepted input still holds pending credit');
    assert.equal(pending.length, 1, 'Acceptance precedes host processing');
    const claimed = pending.shift()!;
    ledger.observeEvidence({ instanceId: host.instanceId, dispatch, nativeMessageId: claimed.nativeMessageId, event: 'claimed' });
    assert.equal(ledger.getAvailableCapacity(), 2, 'Identity-checked host evidence releases credit');
    assert.equal(ledger.getRetainedEvidence()[0].credit?.event, 'claimed');
    ledger.acknowledgeCredit(frame.message_id);
    assert.deepEqual(await ledger.receiveFrame(frame), first);
    assert.equal(insertions, 1, 'Credit confirmation does not reopen a settled dispatch');
  } finally {
    ledger.dispose();
  }
});
