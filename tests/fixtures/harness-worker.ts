import { ToolCallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ControlClient, type ReadyRootRequest, type RootRegistrationResponse, type RootCreditReleaseRequest, type RootConnection } from '@arlo/sdk';
import { ReceptionLedger } from '@arlo/adapter-sdk';
import { createArloHarnessPlugin, createDshReceptionHost } from '@arlo/adapter-dsh/runtime';
import { LocalModel } from '../../probes/fixture.ts';
import { persistedHarnessFixture, humanSendAllowance } from '../helpers/harness-human-allowance.ts';

export type HarnessCommand =
  | { action: 'tool'; name: 'arlo_list_sessions' | 'arlo_send_message' | 'arlo_get_message_status'; args: Record<string, unknown> }
  | { action: 'switch-group'; groupName: string }
  | { action: 'change-context'; cwd: string; workspaceDir?: string }
  | { action: 'fault'; mode: 'none' | 'before-insertion' | 'after-insertion' | 'wrong-group' }
  | { action: 'hold' | 'release' | 'snapshot' | 'detach' | 'attach' | 'reconnect' | 'stop' };

interface ReadinessAttempt {
  ready: boolean;
  endpoint_id: string;
  generation: number;
  pending: string[];
  error?: string;
}

export interface HarnessConfiguration { groupName?: string; sessionCwd?: string; workspaceDir?: string }
const configuration: HarnessConfiguration = process.env.ARLO_HARNESS_CONFIG
  ? JSON.parse(process.env.ARLO_HARNESS_CONFIG)
  : { groupName: 'process-unicast' };
const model = new LocalModel();
const host = await persistedHarnessFixture(model, { sessionCwd: configuration.sessionCwd });
let ready = Promise.withResolvers<ReadinessAttempt>();
let fault: 'none' | 'before-insertion' | 'after-insertion' | 'wrong-group' = 'none';
let heldTurn: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let toolSequence = 0;
let unexpectedFrames = 0;
const followup = host.root.agent.followup.bind(host.root.agent);
host.root.agent.followup = message => {
  if (fault === 'before-insertion' && message.source?.kind === 'arlo') {
    fault = 'none';
    throw new Error('host-before-insertion-secret-canary');
  }
  return followup(message);
};

// Faults use the same public control/notification and host event boundaries as
// the in-process probes. The daemon and the actual host insertion stay real.
class ObservedControlClient extends ControlClient {
  readonly credits = new Set<Promise<unknown>>();
  connection?: RootConnection;

  override createRootConnection(binding: RootRegistrationResponse) {
    const connection = super.createRootConnection(binding);
    this.connection = connection;
    const onNotification = connection.onNotification.bind(connection);
    connection.onNotification = handler => onNotification(params => handler(
      fault === 'wrong-group' ? { ...params, group_id: 'different-frozen-group' } : params
    ));
    return connection;
  }

  override async confirmRootReady(token: string, request: ReadyRootRequest) {
    const attempt = {
      endpoint_id: request.endpoint_id,
      generation: this.connection!.binding.generation,
      pending: request.reconciled_pending_message_ids ?? [],
    };
    try {
      const response = await super.confirmRootReady(token, request);
      ready.resolve({ ...attempt, ready: true });
      return response;
    } catch (error) {
      ready.resolve({ ...attempt, ready: false, error: (error as { code?: string }).code });
      throw error;
    }
  }

  override releaseCredit(token: string, request: RootCreditReleaseRequest) {
    const pending = super.releaseCredit(token, request);
    this.credits.add(pending);
    void pending.then(() => this.credits.delete(pending), () => this.credits.delete(pending));
    return pending;
  }
}

let controlClient = new ObservedControlClient({ stateDir: process.env.ARLO_STATE_DIR });
let plugin: Awaited<ReturnType<typeof host.ctx.plugin>> | undefined;
let integration: ReturnType<typeof createArloHarnessPlugin>;
let humanAllowance: ReturnType<typeof humanSendAllowance>;
host.ctx.on('internal/dispatch', (_type, name) => {
  if (fault === 'after-insertion' && name === 'agent/inbox/inserted') {
    fault = 'none';
    throw new Error('host-exception-secret-canary');
  }
});

async function attach() {
  ready = Promise.withResolvers<ReadinessAttempt>();
  controlClient = new ObservedControlClient({ stateDir: process.env.ARLO_STATE_DIR });
  integration = createArloHarnessPlugin({
    groupName: configuration.groupName,
    getConfirmedWorkspaceDirectory: () => configuration.workspaceDir,
    controlClient,
  });
  plugin = await host.ctx.plugin(integration);
  humanAllowance = humanSendAllowance(integration, host.root.agent);
  return ready.promise;
}

async function detach() {
  await plugin?.dispose();
  plugin = undefined;
  controlClient.connection?.dispose();
}

if (!(await attach()).ready) throw new Error('INITIAL_READINESS_FAILED');

function localInput(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}

async function execute(command: HarnessCommand) {
  switch (command.action) {
    case 'switch-group':
      try {
        await integration.switchGroup(host.root.agent, command.groupName);
        configuration.groupName = command.groupName;
        humanAllowance.reset();
        return { switched: true, endpoint_id: controlClient.connection?.binding.endpoint_id };
      } catch (error) {
        return { switched: false, error: (error as { code?: string }).code };
      }
    case 'change-context':
      process.chdir(command.cwd);
      configuration.workspaceDir = command.workspaceDir;
      return { cwd: process.cwd() };
    case 'tool': {
      if (command.name === 'arlo_send_message') await humanAllowance.prepare();
      const callId = ToolCallId(`process-tool-${++toolSequence}`);
      const argumentsJson = JSON.stringify(command.args);
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: callId, name: command.name, argumentsDelta: argumentsJson },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: command.name, arguments: argumentsJson } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ];
      model.script.push(chunks);
      host.root.agent.followup(localInput('Run the scripted local tool call'));
      await host.root.agent.whenIdle();
      const event = host.root.agent.session.snapshotEvents().find(event =>
        event.type === 'tool/result' && event.data.message.toolCallId === callId
      );
      if (!event || event.type !== 'tool/result') throw new Error('TOOL_RESULT_MISSING');
      return event.data.message;
    }
    case 'hold': {
      heldTurn = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      model.beforeResponse = async () => {
        started.resolve();
        await heldTurn?.promise;
      };
      host.root.agent.followup(localInput('Keep the current turn busy'));
      await started.promise;
      return { status: host.root.agent.status };
    }
    case 'release':
      model.beforeResponse = undefined;
      heldTurn?.resolve();
      heldTurn = undefined;
      await host.root.agent.whenIdle();
      await Promise.allSettled([...controlClient.credits]);
      return { status: host.root.agent.status };
    case 'snapshot':
      if (!heldTurn) await host.root.agent.whenIdle();
      return {
        pid: process.pid,
        endpoint_id: controlClient.connection?.binding.endpoint_id,
        status: host.root.agent.status,
        pending: [...host.root.agent.inbox.nextTurn, ...host.root.agent.inbox.nextStep],
        modelMessages: model.requests.at(-1)?.messages,
        messages: host.root.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data),
        childMessages: host.child.agent.session.snapshotEvents().filter(event => event.type === 'user/message').length,
        unexpectedFrames,
      };
    case 'fault':
      fault = command.mode;
      return { fault };
    case 'detach':
      await detach();
      return { status: host.root.agent.status };
    case 'attach':
      if (plugin) throw new Error('PLUGIN_ALREADY_ATTACHED');
      return attach();
    case 'reconnect': {
      // Exercise the explicit control-plane reconnect, not an automatic retry
      // loop. The real host remains busy and its public inbox is authoritative.
      const previous = controlClient.connection!;
      const old = previous.binding;
      const rotated = await controlClient.connectRoot(old.root_token, { endpoint_id: old.endpoint_id });
      previous.dispose();
      const connection = controlClient.createRootConnection({ ...old, ...rotated });
      const observer = new ReceptionLedger({ host: createDshReceptionHost(host.root.agent), currentGeneration: rotated.generation });
      try {
        ready = Promise.withResolvers<ReadinessAttempt>();
        connection.onNotification(() => { unexpectedFrames++; });
        await connection.connect();
        await controlClient.confirmRootReady(rotated.root_token, {
          endpoint_id: rotated.endpoint_id,
          reconciled_pending_message_ids: observer.getPendingMessageIds(),
        }).catch(() => {});
        return await ready.promise;
      } finally {
        observer.dispose();
      }
    }
    case 'stop':
      fault = 'none';
      heldTurn?.resolve();
      await detach();
      await host.ctx.fiber.dispose();
      return { stopped: true };
  }
}

let requests = Promise.resolve();
process.on('message', (message: { id: number; command: HarnessCommand }) => {
  requests = requests.then(async () => {
    try {
      const result = await execute(message.command);
      process.send?.({ id: message.id, result });
      if (message.command.action === 'stop') process.disconnect();
    } catch {
      process.send?.({ id: message.id, error: 'HARNESS_COMMAND_FAILED' });
    }
  });
});
process.on('disconnect', () => {
  heldTurn?.resolve();
  controlClient.connection?.dispose();
  void host.ctx.fiber.dispose();
});
process.send?.({ ready: true, pid: process.pid });
