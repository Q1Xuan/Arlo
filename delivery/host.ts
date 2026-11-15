import { setTimeout as delay } from 'node:timers/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { ToolCallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { fixture, LocalModel } from '../probes/fixture.ts';

export type DemoCommand =
  | { action: 'tool'; name: 'arlo_list_sessions' | 'arlo_send_message' | 'arlo_get_message_status'; args: Record<string, unknown> }
  | { action: 'hold-and-queue' | 'snapshot' | 'unload' | 'release' | 'stop' };

export interface ToolMessage {
  isError?: boolean;
  content: readonly { type: string; text?: string }[];
}

interface HostMessage {
  id: string;
  source?: unknown;
  content: readonly { type: string; text?: string }[];
}

export interface HostSnapshot {
  pid: number;
  agentIds: string[];
  status: string;
  modelAborted?: boolean;
  pending: HostMessage[];
  messages: HostMessage[];
  history: readonly unknown[];
  modelMessages: unknown;
  childMessages: number;
}

// The only simulated boundary is the external LLM. Runtime, AgentLoop,
// sessions, tools, plugin, SDK, and the separately started daemon are real.
const model = new LocalModel();
const profileDirectory = process.env.USERPROFILE ?? process.cwd();
const host = await fixture(model, undefined, { sessionDirectory: path.join(profileDirectory, 'sessions'),
  sessionId: `installed-${crypto.createHash('sha256').update(profileDirectory).digest('hex').slice(0, 16)}` });
const definition = createArloHarnessPlugin({
  stateDir: process.env.ARLO_STATE_DIR,
  groupName: 'fictional-installed-demo',
  autoStart: { idleTimeoutMs: 10000 },
});
let plugin: Awaited<ReturnType<typeof host.ctx.plugin>> | undefined = await host.ctx.plugin(definition);
let held: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let toolSequence = 0;

function localInput(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}

async function tool(command: Extract<DemoCommand, { action: 'tool' }>): Promise<ToolMessage> {
  if (command.name === 'arlo_send_message') {
    const status = await definition.getRootSendingStatus(host.root.agent);
    if (status.knowledge === 'unknown' || status.remaining === 0) {
      // The installed demo driver supplies an explicit fixture human command.
      // Autonomous acceptance has its own worker without this renewal step.
      await definition.continueCollaboration(host.root.agent);
    }
  }
  const id = ToolCallId(`installed-tool-${++toolSequence}`);
  const args = JSON.stringify(command.args);
  const response: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: command.name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: command.name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
  model.script.push(response);
  host.root.agent.followup(localInput('Run the fictional local tool request'));
  await host.root.agent.whenIdle();
  const result = host.root.agent.session.snapshotEvents().find(event =>
    event.type === 'tool/result' && event.data.message.toolCallId === id,
  );
  if (!result || result.type !== 'tool/result') throw new Error('TOOL_RESULT_MISSING');
  return result.data.message;
}

async function snapshot(): Promise<HostSnapshot> {
  if (!held) await host.root.agent.whenIdle();
  return {
    pid: process.pid,
    agentIds: host.ctx.agents.list().map(agent => agent.id),
    status: host.root.agent.status,
    modelAborted: model.requests.at(-1)?.signal?.aborted,
    pending: [...host.root.agent.inbox.nextTurn, ...host.root.agent.inbox.nextStep],
    messages: host.root.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data),
    history: host.root.agent.session.snapshotEvents(),
    modelMessages: model.requests.at(-1)?.messages,
    childMessages: host.child.agent.session.snapshotEvents().filter(event => event.type === 'user/message').length,
  };
}

async function unload() {
  await plugin?.dispose();
  plugin = undefined;
}

async function release() {
  model.beforeResponse = undefined;
  held?.resolve();
  held = undefined;
  await host.root.agent.whenIdle();
}

let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  stopping ??= (async () => {
    await release();
    await unload();
    await host.ctx.fiber.dispose();
  })();
  return stopping;
}

async function execute(command: DemoCommand): Promise<unknown> {
  switch (command.action) {
    case 'tool': return tool(command);
    case 'snapshot': return snapshot();
    case 'hold-and-queue': {
      if (held) throw new Error('TURN_ALREADY_HELD');
      held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      model.beforeResponse = async () => { entered.resolve(); await held?.promise; };
      host.root.agent.followup(localInput('Keep the fictional local turn running'));
      await entered.promise;
      host.root.agent.followup(localInput('Fictional pending local work must survive plugin unload'));
      return snapshot();
    }
    case 'unload': await unload(); return snapshot();
    case 'release': await release(); return snapshot();
    case 'stop': await stop(); return { stopped: true };
  }
}

try {
  // Readiness is observed through the public model tool, without replacing the
  // plugin's production control client or reading its private root bindings.
  const deadline = Date.now() + 40000;
  for (;;) {
    const result = await tool({ action: 'tool', name: 'arlo_list_sessions', args: {} });
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    let ready = false;
    try { ready = !result.isError && Array.isArray(JSON.parse(text)); } catch { /* Registration can still be starting. */ }
    if (ready) break;
    if (Date.now() >= deadline) throw new Error('INSTALLED_PLUGIN_NOT_READY');
    await delay(100);
  }
} catch (error) {
  await stop();
  throw error;
}

let requests = Promise.resolve();
process.on('message', (message: { id: number; command: DemoCommand }) => {
  requests = requests.then(async () => {
    try {
      const result = await execute(message.command);
      process.send?.({ id: message.id, result });
      if (message.command.action === 'stop') process.disconnect();
    } catch {
      process.send?.({ id: message.id, error: 'INSTALLED_HOST_COMMAND_FAILED' });
    }
  });
});
process.on('disconnect', () => { void stop(); });
process.send?.({
  ready: true, pid: process.pid,
  adapterEntry: import.meta.resolve('@arlo/adapter-dsh/runtime'),
  adapterSdkEntry: import.meta.resolve('@arlo/adapter-sdk'),
  sdkEntry: import.meta.resolve('@arlo/sdk'),
});
