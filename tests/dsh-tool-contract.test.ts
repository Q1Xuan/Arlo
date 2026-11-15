import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ArloDaemon } from '@arlo/daemon';
import { DaemonClient } from '@arlo/sdk';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { fixture, LocalModel } from '../probes/fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('DSH product tools expose canonical discovery, send and status values', async () => {
  const stateDir = createTempDir('dsh-tool-contract');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture(new LocalModel(), undefined, { sessionDirectory: path.join(stateDir, 'sessions') });
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir, groupName: 'tool-contract' });
    await host.ctx.plugin(plugin);
    const client = new DaemonClient({ stateDir });
    for (let i = 0; i < 100; i++) {
      if ((await client.listRoots()).some(root => root.ready)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const result = await host.ctx.tools.execute({
      callId: ToolCallId('canonical-discovery'), name: 'arlo_list_sessions', arguments: {},
      agent: host.root.agent, signal: new AbortController().signal,
    });
    assert.equal(result.isError, false);
    assert.deepEqual(result.value, [], 'No peer endpoints exist; content blocks are not the domain value');
    assert.deepEqual(result.content, [{ type: 'text', text: '[]' }]);
    const status = await host.ctx.tools.execute({
      callId: ToolCallId('canonical-status'), name: 'arlo_get_message_status',
      arguments: { message_id: 'unrecorded-message' }, agent: host.root.agent,
      signal: new AbortController().signal,
    });
    assert.equal(status.isError, false);
    assert.equal((status.value as { status: string }).status, 'result_unavailable');
    await host.ctx.agents.create({ sessionId: SessionId('tool-contract-peer'),
      agentOptions: { provider: 'arlo-local', model: 'scripted' } });
    let peer: string | undefined;
    for (let i = 0; i < 100; i++) {
      const discovery = await host.ctx.tools.execute({ callId: ToolCallId('peer-discovery'),
        name: 'arlo_list_sessions', arguments: {}, agent: host.root.agent,
        signal: new AbortController().signal });
      const contacts = JSON.parse((discovery.content[0] as { text: string }).text);
      peer = contacts[0]?.endpoint_id;
      if (peer) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(peer);
    await plugin.continueCollaboration(host.root.agent);
    const send = await host.ctx.tools.execute({
      callId: ToolCallId('canonical-send'), name: 'arlo_send_message',
      arguments: { to: peer, text: 'A single delivery attempt.' },
      agent: host.root.agent, signal: new AbortController().signal,
    });
    assert.equal(send.isError, false, JSON.stringify(send));
    assert.equal((send.value as { status: string }).status, 'accepted');
  } finally {
    await host.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
