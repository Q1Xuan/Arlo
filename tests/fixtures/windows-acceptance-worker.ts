import { ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import path from 'node:path';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { fixture, LocalModel } from '../../probes/fixture.ts';
import { humanSendAllowance } from '../helpers/harness-human-allowance.ts';

export type AcceptanceCommand =
  | { action: 'discover-send'; text: string }
  | { action: 'arm-reply'; requestText: string; replyText: string }
  | { action: 'tool'; name: string; args: Record<string, unknown>; caller: 'root' | 'child' | 'second' }
  | { action: 'sending-status' | 'continue' }
  | { action: 'duplicate-plugin' | 'create-second' | 'replace-root' }
  | { action: 'hold' | 'release' | 'snapshot' | 'unload-history' | 'stop' };

function toolCall(id: string, name: string, args: Record<string, unknown>): StreamChunk[] {
  const callId = ToolCallId(id);
  const argumentsJson = JSON.stringify(args);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

// The only substituted component is the provider model. This adapter reads the
// same GenerateOptions projection an external provider would receive, and emits
// ordinary tool calls; it never calls a Arlo API or inserts a received message.
class AcceptanceModel extends LocalModel {
  active = 0;
  maxActive = 0;
  aborted = 0;
  sequence = 0;
  hold?: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> };
  plan?: { text: string; discoveryCall: string; sendCall: string; phase: 'discover' | 'send' };
  reply?: { requestText: string; replyText: string };
  replyDecision?: { message_id: string; from_endpoint: string };

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    this.maxActive = Math.max(this.maxActive, ++this.active);
    const aborted = () => { this.aborted++; };
    options.signal?.addEventListener('abort', aborted, { once: true });
    try {
      const hold = this.hold;
      if (hold) {
        hold.entered.resolve();
        await hold.release.promise;
      }
      const scripted = this.script.shift();
      if (scripted) {
        yield* scripted;
        return;
      }
      if (this.plan?.phase === 'discover') {
        this.plan.phase = 'send';
        yield* toolCall(this.plan.discoveryCall, 'arlo_list_sessions', {});
        return;
      }
      if (this.plan?.phase === 'send') {
        const plan = this.plan;
        this.plan = undefined;
        const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === plan.discoveryCall);
        if (!result) throw new Error('MODEL_DISCOVERY_RESULT_MISSING');
        const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        const sessions = JSON.parse(text);
        if (sessions.length !== 1 || !sessions[0].deliverable) throw new Error('MODEL_DISCOVERY_TARGET_AMBIGUOUS');
        yield* toolCall(plan.sendCall, 'arlo_send_message', { to: sessions[0].endpoint_id, text: plan.text });
        return;
      }
      if (this.reply) {
        const reply = this.reply;
        const inbound = options.messages.findLast(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === reply.requestText));
        if (inbound) {
          const contextBlock = inbound.content.find(block => block.type === 'text' && block.text.startsWith('{"arlo":'));
          if (!contextBlock || contextBlock.type !== 'text') throw new Error('MODEL_REPLY_CONTEXT_MISSING');
          const context = JSON.parse(contextBlock.text).arlo;
          if (!context.message_id || !context.from_endpoint) throw new Error('MODEL_REPLY_CONTEXT_INVALID');
          this.replyDecision = { message_id: context.message_id, from_endpoint: context.from_endpoint };
          this.reply = undefined;
          yield* toolCall(`contextual-reply-${++this.sequence}`, 'arlo_send_message', {
            to: context.from_endpoint, text: reply.replyText, reply_to: context.message_id,
          });
          return;
        }
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Local acceptance turn completed' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Local acceptance turn completed' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally {
      options.signal?.removeEventListener('abort', aborted);
      this.active--;
    }
  }
}

const model = new AcceptanceModel();
let created = 0;
const host = await fixture(model, ctx => {
  ctx.on('agent/created', () => { created++; return undefined; });
}, { sessionDirectory: path.join(process.env.USERPROFILE ?? process.cwd(), 'acceptance-sessions'),
  ...(process.env.ARLO_ACCEPTANCE_SESSION_ID ? { sessionId: process.env.ARLO_ACCEPTANCE_SESSION_ID } : {}) });
let second: typeof host.root | undefined;
const claimed: string[] = [];
host.ctx.on('agent/inbox/claimed', ({ message }) => { claimed.push(message.id); });
const bindingReady = new WeakMap<typeof host.root.agent, boolean>();
const definition = createArloHarnessPlugin({
  groupName: 'windows-mvp-acceptance', stateDir: process.env.ARLO_STATE_DIR,
  // Preserve all message budgets/pacing defaults; shorten only fixture teardown.
  autoStart: { idleTimeoutMs: 10000 },
  onReady: (agent, ready) => { bindingReady.set(agent, ready); },
});
let integration: Awaited<ReturnType<typeof host.ctx.plugin>> | undefined = await host.ctx.plugin(definition);
const humanAllowances = new WeakMap<typeof host.root.agent, ReturnType<typeof humanSendAllowance>>();
function humanAllowance(agent: typeof host.root.agent) {
  let allowance = humanAllowances.get(agent);
  if (!allowance) {
    allowance = humanSendAllowance(definition, agent);
    humanAllowances.set(agent, allowance);
  }
  return allowance;
}

const input = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
async function snapshot() {
  if (!model.hold) await host.root.agent.whenIdle();
  await second?.agent.whenIdle();
  return {
    pid: process.pid, sessionId: host.root.agent.session.id,
    bindingReady: bindingReady.get(host.root.agent) === true,
    secondBindingReady: second ? bindingReady.get(second.agent) === true : false,
    status: host.root.agent.status, created, agentCount: host.ctx.agents.list().length,
    requests: model.requests.length, active: model.active, maxActive: model.maxActive, aborted: model.aborted,
    pending: [...host.root.agent.inbox.nextTurn, ...host.root.agent.inbox.nextStep], claimed,
    messages: host.root.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data),
    childMessages: host.child.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data),
    secondMessages: second?.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data) ?? [],
    replyDecision: model.replyDecision,
  };
}

async function execute(command: AcceptanceCommand): Promise<unknown> {
  switch (command.action) {
    case 'sending-status':
      return definition.getRootSendingStatus(host.root.agent);
    case 'continue':
      try { return { continued: true, status: await definition.continueCollaboration(host.root.agent) }; }
      catch (error) { return { continued: false, error: (error as { code?: string }).code }; }
    case 'tool': {
      const agent = command.caller === 'child' ? host.child.agent : command.caller === 'second' ? second?.agent : host.root.agent;
      if (!agent) throw new Error('MODEL_CALLER_MISSING');
      const callId = `acceptance-tool-${++model.sequence}`;
      model.script.push(toolCall(callId, command.name, command.args));
      agent.followup(input('Execute the specified local model tool call'));
      await agent.whenIdle();
      const event = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === callId);
      if (!event || event.type !== 'tool/result') throw new Error('MODEL_TOOL_RESULT_MISSING');
      return event.data.message;
    }
    case 'duplicate-plugin':
      await host.ctx.plugin(createArloHarnessPlugin({ groupName: 'windows-mvp-acceptance', stateDir: process.env.ARLO_STATE_DIR }));
      return { integrated: true };
    case 'create-second':
      second = await host.ctx.agents.create({
        sessionId: SessionId('fictional-second-root'), agentOptions: { provider: 'arlo-local', model: 'scripted' },
      });
      return { created: true };
    case 'replace-root': {
      const sessionId = host.root.agent.session.id;
      await host.root.dispose();
      host.root = await host.ctx.agents.resume({
        resumeSessionId: sessionId, agentOptions: { provider: 'arlo-local', model: 'scripted' },
      });
      return { replaced: true };
    }
    case 'arm-reply':
      await humanAllowance(host.root.agent).prepare();
      model.reply = command;
      return { armed: true };
    case 'discover-send': {
      await humanAllowance(host.root.agent).prepare();
      const sequence = ++model.sequence;
      const sendCall = `discovered-send-${sequence}`;
      model.plan = { text: command.text, phase: 'discover', discoveryCall: `discover-${sequence}`, sendCall };
      host.root.agent.followup(input('Discover the other root and send the locally specified text'));
      await host.root.agent.whenIdle();
      const result = host.root.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === sendCall);
      if (!result || result.type !== 'tool/result') throw new Error('MODEL_SEND_RESULT_MISSING');
      return { result: result.data.message };
    }
    case 'hold':
      model.hold = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
      host.root.agent.followup(input('Keep this existing turn busy'));
      await model.hold.entered.promise;
      return snapshot();
    case 'release': {
      const hold = model.hold;
      model.hold = undefined;
      hold?.release.resolve();
      return snapshot();
    }
    case 'snapshot':
      return snapshot();
    case 'unload-history': {
      await integration?.dispose();
      integration = undefined;
      const serialized = JSON.parse(JSON.stringify({ header: host.root.agent.session.header, events: host.root.agent.session.snapshotEvents() }));
      const history = Session.create(SessionId(serialized.header.id), serialized.events, serialized.header);
      return {
        messages: history.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data),
        agentCount: host.ctx.agents.list().length, status: host.root.agent.status,
      };
    }
    case 'stop':
      model.hold?.release.resolve();
      model.hold = undefined;
      await integration?.dispose();
      integration = undefined;
      await host.ctx.fiber.dispose();
      return { stopped: true };
  }
}

let requests = Promise.resolve();
process.on('message', (message: { id: number; command: AcceptanceCommand }) => {
  requests = requests.then(async () => {
    try {
      const result = await execute(message.command);
      process.send?.({ id: message.id, result });
      if (message.command.action === 'stop') process.disconnect();
    } catch {
      process.send?.({ id: message.id, error: 'ACCEPTANCE_COMMAND_FAILED' });
    }
  });
});
process.on('disconnect', () => {
  model.hold?.release.resolve();
  void host.ctx.fiber.dispose();
});
process.send?.({ ready: true, pid: process.pid, sessionId: host.root.agent.session.id });
