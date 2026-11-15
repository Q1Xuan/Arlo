import { ToolCallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { LocalModel } from '../../probes/fixture.ts';
import { persistedHarnessFixture, humanSendAllowance } from '../helpers/harness-human-allowance.ts';

export type PolicyCommand =
  | { action: 'attach' | 'unload' | 'snapshot' | 'stop' }
  | { action: 'input'; text: string }
  | { action: 'tool' | 'arm-tool'; name: string; args?: Record<string, unknown> }
  | { action: 'switch-group'; groupName: string };

const configuration: { groupName?: string; workspaceDir?: string } = JSON.parse(process.env.ARLO_POLICY_CONFIG!);
const model = new LocalModel();
const host = await persistedHarnessFixture(model);
let executed = 0;
let denied = 0;
const rejectedInputs: string[] = [];
const admittedInputs: Array<{ id: string; source: unknown; content: unknown }> = [];
// These policies belong to the host and precede the Arlo integration. Real
// Harness dispatch, rather than a mock tool or adapter, must enforce them.
for (const name of ['policy_allowed', 'policy_denied']) {
  host.ctx.tools.register(defineContentToolFixture({
    name, description: 'Observe the existing host permission policy', parameters: {},
    execute: async () => { executed++; return [{ type: 'text', text: 'allowed-by-host' }]; },
  }));
}
host.root.agent.ctx.tools.guard(execution => {
  if (execution.name !== 'policy_denied') return undefined;
  denied++;
  return 'HOST_POLICY_DENIED';
});
host.root.agent.ctx.on('agent/pre-step', async ({ messages }, next) => {
  for (const message of messages) {
    if (message.content.some(block => block.type === 'text' && block.text === 'policy-rejected-input')) {
      rejectedInputs.push(message.id);
      return { kind: 'reject' };
    }
    admittedInputs.push({ id: message.id, source: message.source, content: message.content });
  }
  return next();
});

let bindingReady = false;
const definition = createArloHarnessPlugin({
  stateDir: process.env.ARLO_STATE_DIR,
  groupName: configuration.groupName,
  getConfirmedWorkspaceDirectory: () => configuration.workspaceDir,
  autoStart: { idleTimeoutMs: 10000 },
  onReady: (agent, ready) => {
    if (agent === host.root.agent) bindingReady = ready;
  },
});
let integration: Awaited<ReturnType<typeof host.ctx.plugin>> | undefined;
const humanAllowance = humanSendAllowance(definition, host.root.agent);
let sequence = 0;
function arm(name: string, args: Record<string, unknown> = {}) {
  const id = ToolCallId(`policy-tool-${++sequence}`);
  const argumentsJson = JSON.stringify(args);
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
  model.script.push(chunks);
  return id;
}
async function input(text: string) {
  host.root.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await host.root.agent.whenIdle();
}
async function snapshot() {
  await host.root.agent.whenIdle();
  const events = host.root.agent.session.snapshotEvents();
  return {
    pid: process.pid, bindingReady, executed, denied, rejectedInputs, admittedInputs,
    requests: model.requests.length, agentCount: host.ctx.agents.list().length,
    messages: events.filter(event => event.type === 'user/message').map(event => event.data),
    results: events.filter(event => event.type === 'tool/result').map(event => event.data.message),
    pending: [...host.root.agent.inbox.nextTurn, ...host.root.agent.inbox.nextStep],
  };
}
async function execute(command: PolicyCommand): Promise<unknown> {
  switch (command.action) {
    case 'attach':
      integration = await host.ctx.plugin(definition);
      humanAllowance.reset();
      return snapshot();
    case 'unload':
      await integration?.dispose();
      integration = undefined;
      return snapshot();
    case 'input':
      await input(command.text);
      return snapshot();
    case 'arm-tool':
      return { id: arm(command.name, command.args) };
    case 'tool': {
      if (command.name === 'arlo_send_message') await humanAllowance.prepare();
      const id = arm(command.name, command.args);
      await input('Run the scripted local model call');
      const event = host.root.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === id);
      if (!event || event.type !== 'tool/result') throw new Error('POLICY_TOOL_RESULT_MISSING');
      return event.data.message;
    }
    case 'switch-group':
      await definition.switchGroup(host.root.agent, command.groupName);
      humanAllowance.reset();
      return snapshot();
    case 'snapshot':
      return snapshot();
    case 'stop':
      await integration?.dispose();
      await host.ctx.fiber.dispose();
      return { stopped: true };
  }
}

let requests = Promise.resolve();
process.on('message', (message: { id: number; command: PolicyCommand }) => {
  requests = requests.then(async () => {
    try {
      process.send?.({ id: message.id, result: await execute(message.command) });
      if (message.command.action === 'stop') process.disconnect();
    } catch {
      process.send?.({ id: message.id, error: 'POLICY_COMMAND_FAILED' });
    }
  });
});
process.on('disconnect', () => { void host.ctx.fiber.dispose(); });
process.send?.({ ready: true, pid: process.pid });
