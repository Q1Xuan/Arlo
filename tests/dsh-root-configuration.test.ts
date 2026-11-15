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
import { captureRootConfigurationEvidence, DaemonClient, ArloErrorCode } from '@arlo/sdk';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { ArloContactService } from '@arlo/adapter-dsh';
import { fixture, LocalModel } from '../probes/fixture.ts';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from './test-utils.ts';

async function ready(stateDir: string, expectedCount = 1): Promise<void> {
  const client = new DaemonClient({ stateDir });
  for (let attempt = 0; attempt < 150; attempt++) {
    if ((await client.listRoots()).filter(root => root.deliverable).length === expectedCount) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('DSH root did not become ready');
}

async function host(rootDir: string, resume = false, compression: 'none' | 'zstd' = 'none', rootId = 'persisted-root') {
  const ctx = new Context();
  const model = new LocalModel();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(JsonlSessionPersistence, { root: rootDir, compression });
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    ctx.llm.registerAdapter(['arlo-local'], model);
    const agentOptions = { provider: 'arlo-local', model: 'scripted' };
    const root = resume
      ? await ctx.agents.resume({ resumeSessionId: SessionId(rootId), agentOptions })
      : await ctx.agents.create({ sessionId: SessionId(rootId), agentOptions });
    return { ctx, root, model };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

test('DSH public trusted reload applies private root rules to model dispatches and preserves periods through mode changes',
  { timeout: 120_000 }, async () => {
    const directory = createTempDir('dsh-sending-rules-public');
    const stateDir = path.join(directory, 'state');
    const daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT });
    const sender = await host(path.join(directory, 'sender'), false, 'none', 'rule-sender');
    const receiver = await host(path.join(directory, 'receiver'), false, 'none', 'rule-receiver');
    try {
      await daemon.start();
      const options = { stateDir, groupName: 'public-sending-rules', autoStart: false };
      const senderPlugin = createArloHarnessPlugin(options);
      const receiverPlugin = createArloHarnessPlugin(options);
      await sender.ctx.plugin(senderPlugin);
      await receiver.ctx.plugin(receiverPlugin);
      await ready(stateDir, 2);
      const service = new ArloContactService(sender.ctx, senderPlugin);
      const signal = new AbortController().signal;
      const sessionId = sender.root.agent.session.id;
      const configuration = await service.rootConfiguration(sessionId, signal);
      assert.equal(configuration.ownership, 'verified');
      const rulesPath = configuration.config_path;
      const writeRules = (mode: 'bounded' | 'continuous', grant: number) => fs.writeFileSync(rulesPath,
        JSON.stringify({ version: 1, roots: { [configuration.config_id!]: { mode, grant } } }), { mode: 0o600 });
      const granted = await service.continueCollaboration(sessionId, signal);
      writeRules('continuous', 7);
      assert.equal((await service.sendStatus(sessionId, signal)).mode, 'bounded');
      const continuous = await service.reloadSendingRules(sessionId, signal);
      assert.equal(continuous.mode, 'continuous');
      assert.equal(continuous.next_grant, 7);
      assert.equal(continuous.period_id, granted.period_id);
      assert.equal(continuous.granted, 20);
      assert.equal(continuous.remaining, null);
      assert.equal(sender.model.requests.length, 0, 'Human commands do not schedule model input');
      const [contact] = await service.list(sessionId, signal);
      assert.ok(contact);
      const send = async (attempt: number) => {
        const id = ToolCallId(`rule-send-${attempt}`);
        const argumentsJson = JSON.stringify({ to: contact.endpoint_id, text: `public dispatch ${attempt}` });
        const chunks: StreamChunk[] = [
          { type: 'block-start', index: 0, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: 0, id, name: 'arlo_send_message', argumentsDelta: argumentsJson },
          { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'arlo_send_message', arguments: argumentsJson } },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ];
        sender.model.script.push(chunks);
        sender.root.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Send to the selected root.' }], source: { kind: 'user' } }));
        await sender.root.agent.whenIdle();
        await receiver.root.agent.whenIdle();
        const result = sender.root.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === id);
        assert.ok(result?.type === 'tool/result');
        const block = result.data.message.content[0];
        assert.ok(block?.type === 'text');
        return block.text;
      };
      for (let attempt = 1; attempt <= 21; attempt++) assert.equal(JSON.parse(await send(attempt)).status, 'accepted');
      const beforeCommands = sender.model.requests.length;
      const unchanged = await service.continueCollaboration(sessionId, signal);
      assert.equal(unchanged.period_id, granted.period_id);
      assert.equal(unchanged.used, 21);
      assert.equal((await receiverPlugin.getRootSendingStatus(receiver.root.agent)).mode, 'bounded');
      writeRules('bounded', 3);
      const bounded = await service.reloadSendingRules(sessionId, signal);
      assert.equal(bounded.used, 21);
      assert.equal(bounded.granted, 20);
      assert.equal(bounded.remaining, 0);
      assert.equal(bounded.pause_reason, 'ALLOWANCE_EXHAUSTED');
      assert.equal(sender.model.requests.length, beforeCommands);
      assert.match(await send(22), /ALLOWANCE_EXHAUSTED/u);
      assert.equal((await service.continueCollaboration(sessionId, signal)).granted, 3);
      fs.writeFileSync(rulesPath, '{"version":1,"roots":');
      await assert.rejects(service.reloadSendingRules(sessionId, signal),
        error => (error as { details?: { reason?: string } }).details?.reason === 'SENDING_RULES_INVALID');
      const preserved = await service.sendStatus(sessionId, signal);
      assert.equal(preserved.mode, 'bounded');
      assert.equal(preserved.next_grant, 3);
      assert.equal(preserved.granted, 3);
      assert.equal(preserved.used, 0);
      assert.ok(preserved.rules_error);
      assert.deepEqual(sender.ctx.tools.schemas().filter(tool => tool.name.startsWith('arlo_')).map(tool => tool.name).sort(),
        ['arlo_get_message_status', 'arlo_list_sessions', 'arlo_send_message']);
    } finally {
      await sender.ctx.fiber.dispose();
      await receiver.ctx.fiber.dispose();
      await daemon.stop();
      removeTempDir(directory);
    }
  });

test('DSH public JSONL persistence and a fresh resumed Agent retain one verified root configuration', async () => {
  const directory = createTempDir('dsh-root-configuration');
  const stateDir = path.join(directory, 'state');
  const persistenceDir = path.join(directory, 'sessions');
  let daemon = new ArloDaemon({ stateDir });
  let current = await host(persistenceDir, false, 'zstd');
  try {
    await daemon.start();
    const options = { stateDir, groupName: 'root-configuration', autoStart: false };
    const firstPlugin = createArloHarnessPlugin(options);
    const loaded = await current.ctx.plugin(firstPlugin);
    await ready(stateDir);
    const first = await firstPlugin.getRootConfiguration(current.root.agent);
    assert.equal(first.root_authenticated, true);
    assert.equal(first.ownership, 'verified');
    assert.equal(first.reason, 'BOUND');
    assert.equal(first.history, 'unknown');
    assert.ok(first.config_id);
    assert.ok(path.isAbsolute(first.config_path));
    const humanService = new ArloContactService(current.ctx, firstPlugin);
    const humanQuery = await humanService.rootConfiguration(current.root.agent.session.id, new AbortController().signal);
    assert.equal(humanQuery.config_id, first.config_id);
    assert.equal(humanQuery.ownership, 'verified');
    await firstPlugin.switchGroup(current.root.agent, 'changed-root-configuration-group');
    assert.equal((await firstPlugin.getRootConfiguration(current.root.agent)).config_id, first.config_id);
    await loaded.dispose();
    await assert.rejects(firstPlugin.getRootConfiguration(current.root.agent), { code: ArloErrorCode.CALLER_NOT_ROOT });
    await current.ctx.plugin(firstPlugin);
    await ready(stateDir);
    assert.equal((await firstPlugin.getRootConfiguration(current.root.agent)).config_id, first.config_id);
    const previousAgent = current.root.agent;
    const previousPersistence = current.ctx.get('sessionPersistence');
    assert.equal(current.model.requests.length, 0);
    await current.ctx.fiber.dispose();
    await daemon.stop();
    daemon = new ArloDaemon({ stateDir });
    await daemon.start();

    current = await host(persistenceDir, true, 'zstd');
    assert.notEqual(current.root.agent, previousAgent);
    assert.notEqual(current.ctx.get('sessionPersistence'), previousPersistence);
    const nextPlugin = createArloHarnessPlugin(options);
    await current.ctx.plugin(nextPlugin);
    await ready(stateDir);
    const reloaded = await nextPlugin.getRootConfiguration(current.root.agent);
    assert.equal(reloaded.ownership, 'verified');
    assert.equal(reloaded.config_id, first.config_id);
    assert.equal(reloaded.config_path, first.config_path);
    assert.equal(current.model.requests.length, 0);
  } finally {
    await current.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});

test('DSH public rule reload explains invalid version, grant and partial JSON in its command result', { timeout: 60_000 }, async () => {
  const directory = createTempDir('dsh-sending-rules-errors');
  const stateDir = path.join(directory, 'state');
  const daemon = new ArloDaemon({ stateDir });
  const current = await host(path.join(directory, 'sessions'));
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir, groupName: 'rules-diagnostics', autoStart: false });
    await current.ctx.plugin(plugin);
    await ready(stateDir);
    const service = new ArloContactService(current.ctx, plugin);
    const signal = new AbortController().signal;
    const configuration = await service.rootConfiguration(current.root.agent.session.id, signal);
    const configId = configuration.config_id!;
    for (const [file, explanation] of [
      [JSON.stringify({ version: 2, roots: {} }), /version must be 1/u],
      [JSON.stringify({ version: 1, roots: { [configId]: { mode: 'bounded', grant: 0 } } }), /grant must be a positive safe integer/u],
      ['{"version":1,"roots":', /complete valid JSON/u],
    ] as const) {
      fs.writeFileSync(configuration.config_path, file, { mode: 0o600 });
      await assert.rejects(service.reloadSendingRules(current.root.agent.session.id, signal), error => {
        const details = (error as { details?: { reason?: string; diagnostic?: string } }).details;
        assert.equal(details?.reason, 'SENDING_RULES_INVALID');
        assert.match(details?.diagnostic ?? '', explanation);
        return true;
      });
    }
    assert.equal(current.model.requests.length, 0, 'Invalid human reload commands do not schedule the model');
  } finally {
    await current.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});

test('DSH public persistence refuses a corrupted durable body and the root configuration stays unknown', async () => {
  const directory = createTempDir('dsh-root-configuration-corrupt');
  const stateDir = path.join(directory, 'state');
  const daemon = new ArloDaemon({ stateDir });
  const current = await host(path.join(directory, 'sessions'));
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir, groupName: 'configuration-corrupt', autoStart: false });
    await current.ctx.plugin(plugin);
    await ready(stateDir);
    current.root.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Create one ordinary durable turn' }],
      source: { kind: 'arlo', form: 'relay' } }));
    await current.root.agent.whenIdle();
    const previousRequests = current.model.requests.length;
    const bound = await plugin.getRootConfiguration(current.root.agent);
    assert.equal(bound.ownership, 'verified', JSON.stringify(bound));
    const persistence = current.ctx.get('sessionPersistence');
    assert.ok(persistence instanceof JsonlSessionPersistence);
    const sessionFile = await persistence.resolveCurrentLog(current.root.agent.session.id);
    assert.ok(sessionFile);
    // Filesystem fault injection in the owned fixture. Production queries
    // only use the backend's public read/flush APIs and never edit host files.
    const original = fs.readFileSync(sessionFile, 'utf8');
    const corrupted = original.replace('"header":{"config":', '"header":{"system":"invalid persisted body","config":');
    assert.notEqual(corrupted, original);
    fs.writeFileSync(sessionFile, corrupted);
    const result = await plugin.getRootConfiguration(current.root.agent);
    assert.equal(result.root_authenticated, true);
    assert.equal(result.ownership, 'unknown');
    assert.equal(result.reason, 'EVIDENCE_INVALID');
    assert.equal(result.config_id, null);
    assert.equal(result.history, 'unknown');
    assert.equal(current.model.requests.length, previousRequests);
  } finally {
    await current.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});

test('DSH authenticates an unsaved root without inventing persistent ownership or a model configuration tool', async () => {
  const directory = createTempDir('dsh-root-configuration-unsaved');
  const daemon = new ArloDaemon({ stateDir: directory });
  const current = await fixture();
  const foreign = await fixture();
  try {
    await daemon.start();
    const plugin = createArloHarnessPlugin({ stateDir: directory, groupName: 'configuration-unsaved', autoStart: false });
    await current.ctx.plugin(plugin);
    await ready(directory);
    const result = await plugin.getRootConfiguration(current.root.agent);
    assert.equal(result.root_authenticated, true);
    assert.equal(result.ownership, 'unknown');
    assert.equal(result.reason, 'EVIDENCE_UNAVAILABLE');
    assert.equal(result.config_id, null);
    assert.equal(result.history, 'unknown');
    await assert.rejects(plugin.getRootConfiguration(current.child.agent), { code: ArloErrorCode.CALLER_NOT_ROOT });
    await assert.rejects(plugin.getRootConfiguration(foreign.root.agent), { code: ArloErrorCode.CALLER_NOT_ROOT });
    const humanService = new ArloContactService(current.ctx, plugin);
    await assert.rejects(humanService.rootConfiguration(current.child.agent.session.id, new AbortController().signal),
      error => (error as { details?: { reason?: string } }).details?.reason === 'CALLER_NOT_ROOT');
    await assert.rejects(humanService.reloadSendingRules(current.child.agent.session.id, new AbortController().signal),
      error => (error as { details?: { reason?: string } }).details?.reason === 'CALLER_NOT_ROOT');
    assert.deepEqual(current.ctx.tools.schemas().filter(tool => tool.name.startsWith('arlo_')).map(tool => tool.name).sort(),
      ['arlo_get_message_status', 'arlo_list_sessions', 'arlo_send_message']);
    assert.equal(current.model.requests.length, 0);
  } finally {
    await current.ctx.fiber.dispose();
    await foreign.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});

test('DSH concurrent roots with the same SessionId and title in independent public stores do not share configuration', async () => {
  const directory = createTempDir('dsh-root-configuration-conflict');
  const stateDir = path.join(directory, 'state');
  const daemon = new ArloDaemon({ stateDir });
  const first = await host(path.join(directory, 'first-sessions'));
  const second = await host(path.join(directory, 'second-sessions'));
  try {
    await daemon.start();
    const options = { stateDir, groupName: 'configuration-conflict', autoStart: false, getSessionTitle: () => 'Same title' };
    const firstPlugin = createArloHarnessPlugin(options);
    const secondPlugin = createArloHarnessPlugin(options);
    await first.ctx.plugin(firstPlugin);
    await second.ctx.plugin(secondPlugin);
    await ready(stateDir, 2);
    const results = await Promise.all([
      firstPlugin.getRootConfiguration(first.root.agent),
      secondPlugin.getRootConfiguration(second.root.agent),
    ]);
    assert.deepEqual(results.map(result => result.ownership).sort(), ['conflict', 'verified']);
    const conflict = results.find(result => result.ownership === 'conflict')!;
    assert.equal(conflict.config_id, null);
    assert.equal(conflict.reason, 'OWNER_CONFLICT');
    assert.equal(conflict.history, 'unknown');
    assert.match(conflict.guidance, /original|duplicate/iu);
    assert.equal(first.model.requests.length + second.model.requests.length, 0);
  } finally {
    await first.ctx.fiber.dispose();
    await second.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});

test('DSH copied immutable origin cannot inherit configuration through the original file inode after fresh resume', async () => {
  const directory = createTempDir('dsh-root-configuration-origin-copy');
  const stateDir = path.join(directory, 'state');
  const originalStore = path.join(directory, 'original-sessions');
  const daemon = new ArloDaemon({ stateDir });
  let current = await host(originalStore);
  const foreign = await host(path.join(directory, 'foreign-sessions'));
  try {
    await daemon.start();
    const options = { stateDir, groupName: 'configuration-origin-copy', autoStart: false };
    const originalPlugin = createArloHarnessPlugin(options);
    await current.ctx.plugin(originalPlugin);
    await ready(stateDir);
    const originalConfiguration = await originalPlugin.getRootConfiguration(current.root.agent);
    assert.equal(originalConfiguration.ownership, 'verified', JSON.stringify(originalConfiguration));
    const originalBackend = current.ctx.get('sessionPersistence');
    const foreignBackend = foreign.ctx.get('sessionPersistence');
    assert.ok(originalBackend instanceof JsonlSessionPersistence);
    assert.ok(foreignBackend instanceof JsonlSessionPersistence);
    const originalFile = await originalBackend.resolveCurrentLog(current.root.agent.session.id);
    await foreign.ctx.sessions.flush(foreign.root.agent.session);
    const foreignFile = await foreignBackend.resolveCurrentLog(foreign.root.agent.session.id);
    assert.ok(originalFile && foreignFile);
    assert.notEqual(current.root.agent.session.header.createdAt, foreign.root.agent.session.header.createdAt);
    const before = captureRootConfigurationEvidence(originalFile).file_identity;
    await current.ctx.fiber.dispose();
    await foreign.ctx.fiber.dispose();
    // Simulate an externally copied valid record while retaining the destination
    // physical file. The subsequent query observes only real public Host state.
    fs.writeFileSync(originalFile, fs.readFileSync(foreignFile));
    assert.equal(captureRootConfigurationEvidence(originalFile).file_identity, before);
    current = await host(originalStore, true);
    const resumedPlugin = createArloHarnessPlugin(options);
    await current.ctx.plugin(resumedPlugin);
    await ready(stateDir);
    const result = await resumedPlugin.getRootConfiguration(current.root.agent);
    assert.equal(result.root_authenticated, true);
    assert.equal(result.ownership, 'conflict');
    assert.equal(result.reason, 'OWNER_CONFLICT');
    assert.equal(result.config_id, null);
    assert.equal(result.history, 'unknown');
  } finally {
    await current.ctx.fiber.dispose();
    await foreign.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(directory);
  }
});
