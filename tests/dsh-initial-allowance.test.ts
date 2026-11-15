import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { createUserMessage, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import { ArloDaemon } from '@arlo/daemon';
import { DaemonClient, ArloErrorCode } from '@arlo/sdk';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { ArloContactService } from '@arlo/adapter-dsh';
import { LocalModel } from '../probes/fixture.ts';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from './test-utils.ts';

const groupName = 'dsh-initial-allowance';
const agentOptions = { provider: 'arlo-local', model: 'scripted' };
const signal = () => new AbortController().signal;

async function host(persistenceDir?: string) {
  const ctx = new Context();
  const model = new LocalModel();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    if (persistenceDir) await ctx.plugin(JsonlSessionPersistence, { root: persistenceDir, compression: 'zstd' });
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    ctx.llm.registerAdapter(['arlo-local'], model);
    return { ctx, model };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

async function ready(stateDir: string, count: number) {
  const client = new DaemonClient({ stateDir });
  for (let attempt = 0; attempt < 150; attempt++) {
    const roots = await client.listRoots();
    if (roots.filter(root => root.deliverable).length === count) return roots;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('DSH roots did not become ready');
}

function toolCall(callId: string, to: string): StreamChunk[] {
  const id = ToolCallId(callId);
  const args = JSON.stringify({ to, text: 'First autonomous message' });
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'arlo_send_message', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'arlo_send_message', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

test('DSH public new-root creation grants twenty dispatch attempts before its first real model tool send', async () => {
  const directory = createTempDir('dsh-initial-allowance');
  const stateDir = path.join(directory, 'state');
  const daemon = new ArloDaemon({ stateDir });
  const current = await host(path.join(directory, 'sessions'));
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir, groupName, autoStart: false });
    const loaded = await current.ctx.plugin(plugin);
    const sender = await current.ctx.agents.create({ sessionId: SessionId('new-sender'), agentOptions });
    const receiver = await current.ctx.agents.create({ sessionId: SessionId('new-receiver'), agentOptions });
    await ready(stateDir, 2);
    const human = new ArloContactService(current.ctx, plugin);
    const before = await human.sendStatus(sender.agent.session.id, signal());
    assert.equal(before.knowledge, 'known');
    assert.equal(before.granted, 20);
    assert.equal(before.used, 0);
    assert.equal(before.remaining, 20);
    assert.equal(before.root_configuration.ownership, 'verified');
    assert.equal(current.model.requests.length, 0, 'Initialization and the human status command do not run a model');
    const [target] = await human.list(sender.agent.session.id, signal());
    assert.ok(target);
    current.model.script.push(toolCall('initial-send', target.endpoint_id));
    sender.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Send one message' }],
      source: { kind: 'arlo', form: 'relay' } }));
    await sender.agent.whenIdle();
    const result = sender.agent.session.snapshotEvents().find(event => event.type === 'tool/result' &&
      event.data.message.toolCallId === 'initial-send');
    assert.ok(result && result.type === 'tool/result');
    const text = result.data.message.content.find(block => block.type === 'text');
    assert.ok(text && text.type === 'text');
    assert.equal(JSON.parse(text.text).status, 'accepted');
    const after = await human.sendStatus(sender.agent.session.id, signal());
    assert.equal(after.used, 1);
    assert.equal(after.remaining, 19);
    assert.equal(after.period_id, before.period_id);
    assert.equal(after.initial_allowance?.eligibility, 'consumed');
    await current.ctx.serial('agent/created', { agent: sender.agent, source: 'startup' });
    const repeated = await human.sendStatus(sender.agent.session.id, signal());
    assert.equal(repeated.remaining, 19, 'Repeated public Agent callbacks do not replenish allowance');

    await plugin.switchGroup(sender.agent, 'moved-dsh-initial-allowance');
    await ready(stateDir, 2);
    const moved = await human.sendStatus(sender.agent.session.id, signal());
    assert.equal(moved.period_id, before.period_id);
    assert.equal(moved.initial_allowance?.eligibility, 'consumed');
    assert.ok(moved.remaining === null || moved.remaining === 19, 'Group changes do not replenish an initial period');
    await loaded.dispose();
    await current.ctx.plugin(plugin);
    await ready(stateDir, 2);
    const reloaded = await human.sendStatus(sender.agent.session.id, signal());
    assert.equal(reloaded.period_id, before.period_id);
    assert.equal(reloaded.initial_allowance?.eligibility, 'consumed');
    assert.ok(reloaded.remaining === null || reloaded.remaining === 19, 'Plugin reload cannot grant again');
  } finally {
    await current.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});

test('DSH initial issuance and public rule changes share one period until explicit bounded continuation',
  { timeout: 120_000 }, async () => {
    const directory = createTempDir('dsh-initial-rule-changes');
    const stateDir = path.join(directory, 'state');
    const daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT });
    const current = await host(path.join(directory, 'sessions'));
    try {
      await daemon.start();
      const plugin = createArloHarnessPlugin({ stateDir, groupName, autoStart: false });
      await current.ctx.plugin(plugin);
      const sender = await current.ctx.agents.create({ sessionId: SessionId('rule-sender'), agentOptions });
      const receiver = await current.ctx.agents.create({ sessionId: SessionId('rule-receiver'), agentOptions });
      await ready(stateDir, 2);
      const human = new ArloContactService(current.ctx, plugin);
      const sessionId = sender.agent.session.id;
      const initial = await human.sendStatus(sessionId, signal());
      assert.equal(initial.remaining, 20);
      assert.equal(initial.control_sequence, 0);
      assert.equal(initial.initial_allowance?.eligibility, 'consumed');
      const configuration = await human.rootConfiguration(sessionId, signal());
      assert.ok(configuration.config_id);
      const writeRules = (mode: 'bounded' | 'continuous', grant: number) => fs.writeFileSync(configuration.config_path,
        JSON.stringify({ version: 1, roots: { [configuration.config_id!]: { mode, grant } } }), { mode: 0o600 });
      writeRules('continuous', 7);
      const continuous = await human.reloadSendingRules(sessionId, signal());
      assert.equal(continuous.mode, 'continuous');
      assert.equal(continuous.next_grant, 7);
      assert.equal(continuous.period_id, initial.period_id);
      assert.equal(continuous.granted, 20);
      assert.equal(continuous.used, 0);
      assert.equal(continuous.remaining, null);
      assert.equal(continuous.initial_allowance?.eligibility, 'consumed');
      assert.equal(current.model.requests.length, 0, 'Initialization and trusted rule changes do not run a model');

      const [target] = await human.list(sessionId, signal());
      assert.ok(target);
      current.model.script.push(toolCall('initial-continuous-send', target.endpoint_id));
      sender.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Send one message' }],
        source: { kind: 'arlo', form: 'relay' } }));
      await sender.agent.whenIdle();
      await receiver.agent.whenIdle();
      const event = sender.agent.session.snapshotEvents().find(event => event.type === 'tool/result' &&
        event.data.message.toolCallId === 'initial-continuous-send');
      assert.ok(event && event.type === 'tool/result');
      const text = event.data.message.content.find(block => block.type === 'text');
      assert.ok(text && text.type === 'text');
      assert.equal(JSON.parse(text.text).status, 'accepted');
      const afterSend = await human.sendStatus(sessionId, signal());
      assert.equal(afterSend.period_id, initial.period_id);
      assert.equal(afterSend.used, 1);
      const noOp = await human.continueCollaboration(sessionId, signal());
      assert.equal(noOp.period_id, initial.period_id);
      assert.equal(noOp.used, 1);
      assert.equal(noOp.control_sequence, 0, 'Continuous continuation does not manufacture a grant');
      await current.ctx.serial('agent/created', { agent: sender.agent, source: 'startup' });

      writeRules('bounded', 7);
      const bounded = await human.reloadSendingRules(sessionId, signal());
      assert.equal(bounded.period_id, initial.period_id);
      assert.equal(bounded.granted, 20);
      assert.equal(bounded.used, 1);
      assert.equal(bounded.remaining, 19);
      assert.equal(bounded.initial_allowance?.eligibility, 'consumed');
      const repeated = await human.reloadSendingRules(sessionId, signal());
      assert.equal(repeated.period_id, initial.period_id);
      assert.equal(repeated.remaining, 19);
      const continued = await human.continueCollaboration(sessionId, signal());
      assert.notEqual(continued.period_id, initial.period_id);
      assert.equal(continued.granted, 7);
      assert.equal(continued.remaining, 7);
      assert.equal(continued.used, 0);
      assert.equal(continued.control_sequence, 1);
      assert.equal(continued.initial_allowance?.eligibility, 'consumed');
    } finally {
      await current.ctx.fiber.dispose();
      await daemon.stop();
      removeTempDir(directory);
    }
  });

test('fresh DSH resume and daemon restart retain consumed initial eligibility and require the human continuation command', async () => {
  const directory = createTempDir('dsh-initial-resume');
  const stateDir = path.join(directory, 'state');
  const sessions = path.join(directory, 'sessions');
  let daemon = new ArloDaemon({ stateDir });
  let current = await host(sessions);
  try {
    await daemon.start();
    const options = { stateDir, groupName, autoStart: false };
    const plugin = createArloHarnessPlugin(options);
    await current.ctx.plugin(plugin);
    const first = await current.ctx.agents.create({ sessionId: SessionId('persisted-root'), agentOptions });
    await ready(stateDir, 1);
    const previous = await new ArloContactService(current.ctx, plugin).sendStatus(first.agent.session.id, signal());
    assert.equal(previous.remaining, 20);
    assert.equal(previous.initial_allowance?.eligibility, 'consumed');
    const previousBackend = current.ctx.get('sessionPersistence');
    await current.ctx.fiber.dispose();
    await daemon.stop();
    daemon = new ArloDaemon({ stateDir });
    await daemon.start();
    current = await host(sessions);
    const nextPlugin = createArloHarnessPlugin(options);
    await current.ctx.plugin(nextPlugin);
    const resumed = await current.ctx.agents.resume({ resumeSessionId: SessionId('persisted-root'), agentOptions });
    assert.notEqual(resumed.agent, first.agent);
    assert.notEqual(current.ctx.get('sessionPersistence'), previousBackend);
    await ready(stateDir, 1);
    const human = new ArloContactService(current.ctx, nextPlugin);
    const before = await human.sendStatus(resumed.agent.session.id, signal());
    assert.equal(before.root_configuration.config_id, previous.root_configuration.config_id);
    assert.equal(before.period_id, previous.period_id);
    assert.equal(before.knowledge, 'unknown');
    assert.equal(before.remaining, null);
    assert.equal(before.initial_allowance?.eligibility, 'consumed');
    const continued = await human.continueCollaboration(resumed.agent.session.id, signal());
    assert.equal(continued.knowledge, 'known');
    assert.equal(continued.remaining, 20);
    assert.notEqual(continued.period_id, previous.period_id);
    assert.equal(continued.control_sequence, 1);
    assert.equal(continued.initial_allowance?.eligibility, 'consumed');
    assert.equal(current.model.requests.length, 0, 'Status and explicit recovery are native human operations');
  } finally {
    await current.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});

test('late DSH plugin attachment cannot turn an old saved root into a first allowance', async () => {
  const directory = createTempDir('dsh-initial-late');
  const stateDir = path.join(directory, 'state');
  const daemon = new ArloDaemon({ stateDir });
  const current = await host(path.join(directory, 'sessions'));
  try {
    await daemon.start();
    const oldRoot = await current.ctx.agents.create({ sessionId: SessionId('old-root'), agentOptions });
    await current.ctx.sessions.flush(oldRoot.agent.session);
    const plugin = createArloHarnessPlugin({ stateDir, groupName, autoStart: false });
    await current.ctx.plugin(plugin);
    await ready(stateDir, 1);
    // An Agent notification alone cannot replace the missed public Session
    // creation and create-owned pending storage witness.
    await current.ctx.serial('agent/created', { agent: oldRoot.agent, source: 'startup' });
    const human = new ArloContactService(current.ctx, plugin);
    const before = await human.sendStatus(oldRoot.agent.session.id, signal());
    assert.equal(before.knowledge, 'unknown');
    assert.equal(before.remaining, null);
    assert.equal(before.initial_allowance?.reason, 'FIRST_USE_UNPROVEN');
    assert.equal(before.root_configuration.ownership, 'verified');
    const after = await human.continueCollaboration(oldRoot.agent.session.id, signal());
    assert.equal(after.remaining, 20);
    assert.equal(after.initial_allowance?.eligibility, 'consumed');
    assert.equal(current.model.requests.length, 0);
  } finally {
    await current.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});

test('a replayed public creation notification cannot turn a pre-plugin unmaterialized DSH Session into a first allowance', async () => {
  const directory = createTempDir('dsh-initial-pending-old');
  const stateDir = path.join(directory, 'state');
  const daemon = new ArloDaemon({ stateDir });
  const current = await host(path.join(directory, 'sessions'));
  try {
    await daemon.start();
    const oldRoot = await current.ctx.agents.create({ sessionId: SessionId('pending-old-root'), agentOptions });
    const plugin = createArloHarnessPlugin({ stateDir, groupName, autoStart: false });
    await current.ctx.plugin(plugin);
    const persistence = current.ctx.get('sessionPersistence') as JsonlSessionPersistence;
    assert.equal(persistence.hasPendingSession(oldRoot.agent.session.id), true);
    // Public event replay names the actual old Session and actual live Agent;
    // a pending create-owned backend fact alone is still not fresh history.
    current.ctx.emit('session/created', oldRoot.agent.session);
    await current.ctx.serial('agent/created', { agent: oldRoot.agent, source: 'startup' });
    await ready(stateDir, 1);
    const status = await new ArloContactService(current.ctx, plugin).sendStatus(oldRoot.agent.session.id, signal());
    assert.equal(status.root_configuration.ownership, 'verified');
    assert.equal(status.knowledge, 'unknown');
    assert.equal(status.remaining, null);
    assert.equal(status.initial_allowance?.reason, 'FIRST_USE_UNPROVEN');
    assert.equal(current.model.requests.length, 0);
  } finally {
    await current.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});

test('a new DSH root without a supported public persistence backend remains ready for reception and conservatively pauses sending', async () => {
  const directory = createTempDir('dsh-initial-unsupported');
  const daemon = new ArloDaemon({ stateDir: directory });
  const current = await host();
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir: directory, groupName, autoStart: false });
    await current.ctx.plugin(plugin);
    const root = await current.ctx.agents.create({ sessionId: SessionId('unsupported-root'), agentOptions });
    await ready(directory, 1);
    const human = new ArloContactService(current.ctx, plugin);
    const status = await human.sendStatus(root.agent.session.id, signal());
    assert.equal(status.knowledge, 'unknown');
    assert.equal(status.remaining, null);
    assert.equal(status.initial_allowance?.reason, 'OWNERSHIP_UNVERIFIED');
    await assert.rejects(human.continueCollaboration(root.agent.session.id, signal()),
      error => (error as { details?: { reason?: string } }).details?.reason === ArloErrorCode.ALLOWANCE_UNKNOWN);
    assert.equal(current.model.requests.length, 0);
  } finally {
    await current.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});

test('DSH public storage failure never grants automatically after repair and the human continuation command restores sending', async () => {
  const directory = createTempDir('dsh-initial-storage-fault');
  const stateDir = path.join(directory, 'state');
  const daemon = new ArloDaemon({ stateDir });
  const current = await host(path.join(directory, 'sessions'));
  const sessions = current.ctx.sessions;
  const flush = sessions.flush;
  try {
    await daemon.start();
    // Fail the public Session flush boundary; creation and ownership checks
    // continue to use the real installed backend.
    sessions.flush = async () => { throw new Error('Fixture storage unavailable'); };
    const plugin = createArloHarnessPlugin({ stateDir, groupName, autoStart: false });
    await current.ctx.plugin(plugin);
    const root = await current.ctx.agents.create({ sessionId: SessionId('faulted-root'), agentOptions });
    await ready(stateDir, 1);
    const human = new ArloContactService(current.ctx, plugin);
    const before = await human.sendStatus(root.agent.session.id, signal());
    assert.equal(before.knowledge, 'unknown');
    assert.equal(before.initial_allowance?.reason, 'OWNERSHIP_UNVERIFIED');
    sessions.flush = flush;
    const repaired = await human.sendStatus(root.agent.session.id, signal());
    assert.equal(repaired.root_configuration.ownership, 'verified');
    assert.equal(repaired.knowledge, 'unknown');
    assert.equal(repaired.initial_allowance?.reason, 'FIRST_USE_UNPROVEN');
    const after = await human.continueCollaboration(root.agent.session.id, signal());
    assert.equal(after.remaining, 20);
    assert.equal(after.control_sequence, 1);
    assert.equal(current.model.requests.length, 0);
  } finally {
    sessions.flush = flush;
    await current.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});

test('independent DSH roots with the same public SessionId cannot both obtain the initial allowance', async () => {
  const directory = createTempDir('dsh-initial-duplicate-id');
  const stateDir = path.join(directory, 'state');
  const daemon = new ArloDaemon({ stateDir });
  const first = await host(path.join(directory, 'first-sessions'));
  const second = await host(path.join(directory, 'second-sessions'));
  try {
    await daemon.start();
    const options = { stateDir, groupName, autoStart: false, getSessionTitle: () => 'Same title' };
    const firstPlugin = createArloHarnessPlugin(options);
    const secondPlugin = createArloHarnessPlugin(options);
    await first.ctx.plugin(firstPlugin);
    await second.ctx.plugin(secondPlugin);
    const [firstRoot, secondRoot] = await Promise.all([
      first.ctx.agents.create({ sessionId: SessionId('duplicate-root'), agentOptions }),
      second.ctx.agents.create({ sessionId: SessionId('duplicate-root'), agentOptions }),
    ]);
    await ready(stateDir, 2);
    const statuses = await Promise.all([
      new ArloContactService(first.ctx, firstPlugin).sendStatus(firstRoot.agent.session.id, signal()),
      new ArloContactService(second.ctx, secondPlugin).sendStatus(secondRoot.agent.session.id, signal()),
    ]);
    assert.deepEqual(statuses.map(status => status.remaining).sort((a, b) => (a ?? -1) - (b ?? -1)), [null, 20]);
    assert.deepEqual(statuses.map(status => status.root_configuration.ownership).sort(), ['conflict', 'verified']);
    assert.equal(statuses.find(status => status.remaining === null)?.initial_allowance?.reason, 'OWNERSHIP_UNVERIFIED');
    assert.equal(first.model.requests.length + second.model.requests.length, 0);
  } finally {
    await first.ctx.fiber.dispose();
    await second.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});
