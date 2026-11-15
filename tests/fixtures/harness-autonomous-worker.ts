import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { createUserMessage, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { ArloContactService } from '@arlo/adapter-dsh';
import { LocalModel } from '../../probes/fixture.ts';

export type AutonomousCommand =
  | { action: 'human'; name: 'status' | 'continue' }
  | { action: 'arm'; target: string }
  | { action: 'input'; text: string }
  | { action: 'local-work' | 'snapshot' | 'discover' | 'detach' | 'attach' | 'stop' };

const ctx = new Context();
const model = new LocalModel();
await ctx.plugin(LlmRuntime);
await ctx.plugin(SessionStore);
await ctx.plugin(JsonlSessionPersistence, { root: process.env.ARLO_SESSION_DIR!, compression: 'none' });
await ctx.plugin(SessionProjectionRegistry);
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime);
await ctx.plugin(AgentRegistry);
await ctx.plugin(AgentLoop, { agents: [] });
ctx.llm.registerAdapter(['arlo-local'], model);
const root = await ctx.agents.create({
  sessionId: SessionId(process.env.ARLO_ROOT_NAME!),
  agentOptions: { provider: 'arlo-local', model: 'scripted' },
});
const child = await root.agent.ctx.agents.create({
  sessionId: SessionId(`${process.env.ARLO_ROOT_NAME!}-child`), parentAgent: root.agent,
  agentOptions: { provider: 'arlo-local', model: 'scripted' },
});
let localWork = 0;
let humanCommand = 0;
ctx.tools.register(defineContentToolFixture({
  name: 'acceptance_local_work', description: 'Run an ordinary local host task', parameters: {},
  execute: async () => { localWork++; return [{ type: 'text', text: 'ordinary local work completed' }]; },
}));
let sequence = 0;
let target: string | undefined;
const handled = new Set<string>();
function scriptedTool(name: string, args: Record<string, unknown>): { id: string; chunks: StreamChunk[] } {
  const id = ToolCallId(`autonomous-${++sequence}`);
  const argumentsJson = JSON.stringify(args);
  return { id, chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] };
}
// This controlled local model reacts to the real public Host input history.
// The parent process never commands the individual autonomous replies.
model.beforeResponse = async () => {
  if (!target || model.script.length) return;
  const event = root.agent.session.snapshotEvents().find(value => value.type === 'user/message' &&
    !handled.has(value.data.id) && (value.data.source?.kind === 'arlo' ||
      value.data.content.some(block => block.type === 'text' && block.text === 'autonomous-start')));
  if (!event || event.type !== 'user/message') return;
  handled.add(event.data.id);
  const content = event.data.content;
  const contextBlock = content.find(block => block.type === 'text' && block.text.includes('"from_endpoint"'));
  const context = contextBlock?.type === 'text' ? JSON.parse(contextBlock.text).arlo : undefined;
  // Deliberately omit reply_to: omission must not exempt an autonomous reply
  // from the root's shared dispatch-attempt allowance.
  model.script.push(scriptedTool('arlo_send_message', {
    to: context?.from_endpoint ?? target, text: sequence % 2 ? 'autonomous pong' : 'autonomous ping',
  }).chunks);
};

const definition = createArloHarnessPlugin({ stateDir: process.env.ARLO_STATE_DIR,
  groupName: 'autonomous-processes', autoStart: false });
let plugin: Awaited<ReturnType<typeof ctx.plugin>> | undefined = await ctx.plugin(definition);
const service = new ArloContactService(ctx, definition);
async function snapshot() {
  await root.agent.whenIdle();
  const events = root.agent.session.snapshotEvents();
  return { pid: process.pid, status: root.agent.status, requests: model.requests.length, localWork,
    messages: events.filter(event => event.type === 'user/message').map(event => event.data),
    results: events.filter(event => event.type === 'tool/result').map(event => event.data.message),
    pending: [...root.agent.inbox.nextTurn, ...root.agent.inbox.nextStep],
    childMessages: child.agent.session.snapshotEvents().filter(event => event.type === 'user/message').length };
}
async function input(text: string) {
  root.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await root.agent.whenIdle();
}
async function execute(command: AutonomousCommand) {
  switch (command.action) {
    case 'human': {
      humanCommand++;
      await root.agent.whenIdle();
      const before = model.requests.length;
      const signal = new AbortController().signal;
      const status = command.name === 'status'
        ? await service.sendStatus(root.agent.session.id, signal)
        : await service.continueCollaboration(root.agent.session.id, signal);
      return { status, modelRequestsAdded: model.requests.length - before };
    }
    case 'arm': target = command.target; return { armed: true };
    case 'discover': return service.list(root.agent.session.id, new AbortController().signal);
    case 'input': await input(command.text); return snapshot();
    case 'local-work': {
      const call = scriptedTool('acceptance_local_work', {});
      model.script.push(call.chunks);
      await input('perform an ordinary local task');
      return snapshot();
    }
    case 'snapshot': return snapshot();
    case 'detach': await plugin?.dispose(); plugin = undefined; return snapshot();
    case 'attach':
      plugin = await ctx.plugin(definition);
      return snapshot();
    case 'stop':
      target = undefined;
      await plugin?.dispose();
      await ctx.fiber.dispose();
      return { stopped: true };
  }
}
let requests = Promise.resolve();
process.on('message', (message: { id: number; command: AutonomousCommand }) => {
  requests = requests.then(async () => {
    try {
      process.send?.({ id: message.id, result: await execute(message.command) });
      if (message.command.action === 'stop') process.disconnect();
    } catch (error) {
      const failure = error as Error & { code?: string; details?: unknown };
      process.send?.({ id: message.id, error: JSON.stringify({ message: failure.message, code: failure.code,
        details: failure.details, action: message.command.action, humanCommand, requests: model.requests.length }) });
    }
  });
});
process.on('disconnect', () => { void ctx.fiber.dispose(); });
process.send?.({ ready: true, pid: process.pid });
