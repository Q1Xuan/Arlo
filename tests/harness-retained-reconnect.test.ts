import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ReceptionLedger } from '@arlo/adapter-sdk';
import { createDshReceptionHost } from '@arlo/adapter-dsh/runtime';
import { type ArloMessageNotificationParams, type RootConnection } from '@arlo/sdk';
import { fixture, LocalModel } from '../probes/fixture.ts';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';

test('An explicit reconnect with retained message associations reconciles real pending without replay or fabricated acceptance', { timeout: 60000 }, async (t) => {
  const rig = await MessageStatusFixture.create();
  t.after(() => rig.dispose());
  const model = new LocalModel();
  const host = await fixture(model);
  t.after(() => host.ctx.fiber.dispose());
  const held = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const receiver = rig.roots[1]!.registration;
  const adapter = new ReceptionLedger({ host: createDshReceptionHost(host.root.agent), currentGeneration: receiver.generation });
  let token = receiver.root_token;
  let rotatedConnection: RootConnection | undefined;
  let stopFault: (() => void) | undefined;
  let insertions = 0;
  let receivedFrames = 0;
  const stopCounting = host.ctx.on('agent/inbox/inserted', ({ message }) => {
    if (message.source.kind === 'arlo') insertions++;
  });
  const receive = async (frame: ArloMessageNotificationParams) => {
    receivedFrames++;
    const result = await adapter.receiveFrame(frame);
    await rig.control.submitReceipt(token, {
      daemon_id: frame.daemon_id,
      endpoint_id: receiver.endpoint_id,
      message_id: frame.message_id,
      delivery_id: frame.delivery_id,
      generation: frame.target_generation,
      status: result.status === 'enqueued' ? 'enqueued' : 'uncertain',
      native_message_id: result.native_message_id,
    });
  };
  try {
    model.beforeResponse = async () => { started.resolve(); await held.promise; };
    host.root.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hold the real host' }], source: { kind: 'user' } }));
    await started.promise;
    rig.roots[1]!.onNotification(receive);
    stopFault = host.ctx.on('internal/dispatch', (_type, name) => {
      if (name === 'agent/inbox/inserted') throw new Error('post-insertion-canary');
    });
    const unknown = await rig.send(0, 1, 'retained-unknown');
    stopFault();
    stopFault = undefined;
    const accepted = await rig.send(0, 1, 'retained-accepted');
    assert.equal(unknown.status, 'unknown');
    assert.equal(accepted.status, 'accepted');
    const backlog = [...host.root.agent.inbox.nextTurn];
    assert.equal(backlog.length, 2);
    const observedInsertions = insertions;

    const rotated = await rig.control.connectRoot(token, { endpoint_id: receiver.endpoint_id });
    assert.equal(rotated.generation, receiver.generation + 1);
    token = rotated.root_token;
    rig.roots[1]!.connection.dispose();
    adapter.advanceGeneration(rotated.generation);
    rotatedConnection = rig.control.createRootConnection({ ...receiver, ...rotated });
    rotatedConnection.onNotification(receive);
    await rotatedConnection.connect();
    const ready = await rig.control.confirmRootReady(token, {
      endpoint_id: receiver.endpoint_id,
      reconciled_pending_message_ids: adapter.getPendingMessageIds(),
    });
    assert.equal(ready.ready, true);
    assert.deepEqual(host.root.agent.inbox.nextTurn, backlog);
    assert.equal((await rig.roots[0]!.connection.getMessageStatus(unknown.message_id)).status, 'unknown');
    assert.equal((await rig.roots[0]!.connection.getMessageStatus(accepted.message_id)).status, 'accepted');

    assert.equal(receivedFrames, 2);
    const repeated = await rig.send(0, 1, 'retained-unknown', unknown.message_id);
    assert.equal(repeated.status, 'unknown', 'A matching capacity snapshot is not an acceptance receipt');
    assert.equal(receivedFrames, 2, 'The daemon must not redispatch the repeated logical message');
    assert.equal(insertions, observedInsertions, 'A repeated logical message must not reach the new transport generation');
    assert.deepEqual(host.root.agent.inbox.nextTurn, backlog);
    const next = await rig.send(0, 1, 'new-after-reconnect');
    assert.equal(next.status, 'accepted');
    assert.equal(insertions, observedInsertions + 1);
    const nativeIds = host.root.agent.inbox.nextTurn.map((message) => message.id);
    assert.equal(nativeIds.length, 3);
    model.beforeResponse = undefined;
    held.resolve();
    await host.root.agent.whenIdle();
    const consumed = host.root.agent.session.snapshotEvents().filter((event) => event.type === 'user/message');
    for (const id of nativeIds) {
      assert.equal(consumed.filter((event) => event.type === 'user/message' && event.data.id === id).length, 1);
    }
  } finally {
    stopFault?.();
    stopCounting();
    held.resolve();
    rotatedConnection?.dispose();
    adapter.dispose();
  }
});
