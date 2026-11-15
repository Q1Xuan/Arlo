import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, ArloErrorCode, type ReadyRootRequest } from '@arlo/sdk';
import { ReceptionLedger } from '@arlo/adapter-sdk';
import { createDshReceptionHost, createArloHarnessPlugin, arloMessage } from '@arlo/adapter-dsh/runtime';
import { fixture } from '../probes/fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('Host insertion followed by an exception remains unknown and retains pending credit', async () => {
  const host = await fixture();
  const deduplicator = new ReceptionLedger({ host: createDshReceptionHost(host.root.agent), currentGeneration: 1, initialCapacity: 1 });
  const stopThrowing = host.ctx.on('internal/dispatch', (_type, name) => {
    if (name === 'agent/inbox/inserted') throw new Error('post-insert-secret-canary');
  });
  const frame = {
    protocol_version: '0.1', daemon_id: 'daemon', message_id: 'message', delivery_id: 'delivery',
    from_endpoint: 'sender', to_endpoint: 'receiver', group_id: 'group', target_generation: 1,
    delivery_seq: '1', text: 'retained pending input', sent_at: new Date().toISOString(),
  };
  try {
    const result = await deduplicator.receiveFrame(frame);
    assert.equal(host.root.agent.inbox.nextTurn.length, 1, 'The real host inserted the message before throwing');
    assert.deepEqual(result, { status: 'unknown', reason: ArloErrorCode.ENQUEUE_UNCERTAIN });
    assert.equal(deduplicator.getAvailableCapacity(), 0);
    assert.deepEqual(await deduplicator.receiveFrame(frame), result, 'A repeated frame retains its uncertain result');
    assert.equal(host.root.agent.inbox.nextTurn.length, 1, 'An uncertain result must not cause a second insertion');
    assert.equal((await deduplicator.receiveFrame({ ...frame, message_id: 'another', delivery_seq: '2' })).reason, ArloErrorCode.QUEUE_LIMIT);
  } finally {
    stopThrowing();
    deduplicator.dispose();
    await host.ctx.fiber.dispose();
  }
});

test('A real root with unaccounted existing pending input cannot publish readiness', { timeout: 30000 }, async () => {
  const stateDir = createTempDir('harness-pending-reentry');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  const readyAttempt = Promise.withResolvers<{ request: ReadyRootRequest; error?: unknown }>();
  class ObservedControlClient extends ControlClient {
    override async confirmRootReady(token: string, request: ReadyRootRequest) {
      try {
        const response = await super.confirmRootReady(token, request);
        readyAttempt.resolve({ request });
        return response;
      } catch (error) {
        readyAttempt.resolve({ request, error });
        throw error;
      }
    }
  }
  try {
    const { port } = await daemon.start();
    const controlClient = new ObservedControlClient({ stateDir, port });
    host.root.agent.inbox.splice('next-turn', Infinity, 0, [arloMessage('existing pending input')]);
    await host.ctx.plugin(createArloHarnessPlugin({ groupName: 'pending-reentry', stateDir, controlClient }));
    const attempt = await readyAttempt.promise;
    assert.equal(attempt.request.reconciled_pending_message_ids?.length, 1);
    assert.equal((attempt.error as { code?: string })?.code, ArloErrorCode.ACCOUNTING_UNAVAILABLE);
    assert.equal(host.root.agent.inbox.nextTurn.length, 1, 'Failed readiness must preserve host input');
  } finally {
    await host.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
