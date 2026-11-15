import { AuthorizedControlClient as ControlClient } from './helpers/authorized-control.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { type RootConnection } from '@arlo/sdk';
import { createArloHarnessPlugin, fixture } from './helpers/authorized-dsh-fixture.ts';
import { LocalModel } from '../probes/fixture.ts';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';

test('A sending Host keeps the uncertain message ID across disconnect and can query it after recovery without resending', { timeout: 30000 }, async t => {
  const rig = await MessageStatusFixture.create({ roots: 1 });
  const model = new LocalModel();
  const host = await fixture(model);
  t.after(async () => { await host.dispose(); await rig.dispose(); });
  let connection: RootConnection | undefined;
  class CapturedControl extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      connection = super.createRootConnection(...args);
      return connection;
    }
  }
  await host.ctx.plugin(createArloHarnessPlugin({ groupName: 'team-status', controlClient: new CapturedControl({ stateDir: rig.stateDir }) }));
  async function waitForReady(generation: number) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await rig.control.listRoots()).some(root => root.endpoint_id === connection?.binding.endpoint_id && root.generation >= generation && root.deliverable)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Sender did not become ready');
  }
  await waitForReady(1);
  const originalConnection = connection!;
  rig.roots[0]!.onNotification(() => originalConnection.dispose());
  const args = JSON.stringify({ to: rig.roots[0]!.registration.endpoint_id, text: 'one business attempt' });
  const callId = ToolCallId('recovery-send');
  model.script.push([
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'arlo_send_message', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'arlo_send_message', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]);
  host.root.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'send once' }], source: { kind: 'user' } }));
  await host.root.agent.whenIdle();
  const event = host.root.agent.session.snapshotEvents().find(item => item.type === 'tool/result' && item.data.message.toolCallId === callId);
  assert.ok(event?.type === 'tool/result');
  assert.equal(event.data.message.isError, false, JSON.stringify(event.data.message.content));
  const block = event.data.message.content[0];
  assert.ok(block?.type === 'text');
  const outcome = JSON.parse(block.text);
  const frame = rig.roots[0]!.notifications[0]!;
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.message_id, frame.message_id);
  assert.equal(outcome.reason, 'CONNECTION_LOST');
  await rig.control.submitReceipt(rig.roots[0]!.registration.root_token, {
    daemon_id: frame.daemon_id, endpoint_id: frame.to_endpoint, message_id: frame.message_id,
    delivery_id: frame.delivery_id, generation: frame.target_generation, status: 'enqueued', native_message_id: 'observed-input',
  });
  await waitForReady(2);
  assert.equal((await connection!.getMessageStatus(outcome.message_id)).status, 'accepted');
  assert.equal(rig.roots[0]!.notifications.length, 1);
});
