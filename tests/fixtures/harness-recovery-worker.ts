import { randomUUID } from 'node:crypto';
import { ToolCallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ControlClient, ArloError, ArloErrorCode, type ReadyRootRequest, type RootRegistrationResponse, type RootReceiptRequest, type RootConnection, type ArloMessageNotificationParams, type RootCreditReleaseRequest } from '@arlo/sdk';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { LocalModel } from '../../probes/fixture.ts';
import { persistedHarnessFixture, humanSendAllowance } from '../helpers/harness-human-allowance.ts';

export type RecoveryCommand =
  | { action: 'tool'; name: 'arlo_list_sessions' | 'arlo_send_message' | 'arlo_get_message_status'; args: Record<string, unknown> }
  | { action: 'inject-sequence'; sequence: string }
  | { action: 'replay-last'; fresh?: boolean }
  | { action: 'snapshot' | 'hold' | 'release' | 'drop-ack' | 'duplicate-next' | 'duplicate-next-request' | 'disconnect' | 'replace-plugin' | 'old-receipt' | 'conflict-receipt' | 'unload' | 'stop' };

const model = new LocalModel();
const host = await persistedHarnessFixture(model);
let humanAllowance: ReturnType<typeof humanSendAllowance> | undefined;
let heldTurn: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let toolSequence = 0;
let dropAck = false;
let duplicateNext = false;
let duplicateNextRequest = false;
let repeatedRequests: Awaited<ReturnType<RootConnection['sendMessage']>>[] = [];
let lastNotification: { frame: ArloMessageNotificationParams; handler: (frame: ArloMessageNotificationParams) => void | Promise<void> } | undefined;
let observedReceipt: RootReceiptRequest | undefined;
let notifications = 0;
const inserted: string[] = [];
const attempts: { ready: boolean; endpoint_id: string; generation: number; pending: string[]; error?: string }[] = [];
let oldReceipt: { token: string; request: RootReceiptRequest } | undefined;

// Observe public transport/control and host event boundaries. The MCP channel,
// plugin lifecycle, host insertion and local model are the production path.
class ObservedControlClient extends ControlClient {
  connection?: RootConnection;
  readonly credits = new Set<Promise<unknown>>();
  readonly releasedMessages = new Set<string>();
  override releaseCredit(token: string, request: RootCreditReleaseRequest) {
    const result = super.releaseCredit(token, request);
    this.credits.add(result);
    void result.then(() => this.releasedMessages.add(request.message_id))
      .finally(() => this.credits.delete(result)).catch(() => {});
    return result;
  }
  override createRootConnection(binding: RootRegistrationResponse) {
    const connection = super.createRootConnection(binding);
    this.connection = connection;
    const sendMessage = connection.sendMessage.bind(connection);
    connection.sendMessage = async (args, messageId) => {
      if (!duplicateNextRequest) return sendMessage(args, messageId);
      duplicateNextRequest = false;
      const id = messageId ?? randomUUID();
      // This fault repeats the authenticated outbound MCP request, not the
      // notification callback. The model still issued only one tool call.
      repeatedRequests = await Promise.all([sendMessage(args, id), sendMessage(args, id)]);
      return repeatedRequests[0];
    };
    const subscribe = connection.onNotification.bind(connection);
    connection.onNotification = handler => subscribe(params => {
      notifications++;
      lastNotification = { frame: params, handler };
      if (duplicateNext) {
        duplicateNext = false;
        return Promise.all([handler(params), handler(params)]).then(() => {});
      }
      return handler(params);
    });
    return connection;
  }
  override async confirmRootReady(token: string, request: ReadyRootRequest) {
    humanAllowance?.reset();
    const attempt = {
      endpoint_id: request.endpoint_id,
      generation: this.connection!.binding.generation,
      pending: request.reconciled_pending_message_ids ?? [],
    };
    try {
      const result = await super.confirmRootReady(token, request);
      attempts.push({ ...attempt, ready: true });
      return result;
    } catch (error) {
      attempts.push({ ...attempt, ready: false, error: (error as { code?: string }).code });
      throw error;
    }
  }
  override async submitReceipt(token: string, request: RootReceiptRequest) {
    observedReceipt = request;
    if (dropAck) {
      dropAck = false;
      oldReceipt = { token, request };
      throw new ArloError(ArloErrorCode.CONNECTION_FAILED);
    }
    return super.submitReceipt(token, request);
  }
}

let control = new ObservedControlClient({ stateDir: process.env.ARLO_STATE_DIR });
let plugin: Awaited<ReturnType<typeof host.ctx.plugin>> | undefined;
host.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
  if (agent === host.root.agent && message.source?.kind === 'arlo') inserted.push(String(message.id));
});

async function attach() {
  control = new ObservedControlClient({ stateDir: process.env.ARLO_STATE_DIR });
  const definition = createArloHarnessPlugin({
    groupName: 'process-recovery',
    controlClient: control,
    stateDir: process.env.ARLO_STATE_DIR,
    autoStart: process.env.ARLO_TEST_AUTO_START === '1' ? { idleTimeoutMs: 10000 } : false,
  });
  humanAllowance = humanSendAllowance(definition, host.root.agent);
  plugin = await host.ctx.plugin(definition);
}
await attach();

const input = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
async function execute(command: RecoveryCommand) {
  switch (command.action) {
    case 'tool': {
      if (command.name === 'arlo_send_message') await humanAllowance!.prepare();
      const callId = ToolCallId(`recovery-tool-${++toolSequence}`);
      const args = JSON.stringify(command.args);
      const chunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: callId, name: command.name, argumentsDelta: args },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: command.name, arguments: args } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ];
      model.script.push(chunks);
      host.root.agent.followup(input('Run the scripted local tool call'));
      await host.root.agent.whenIdle();
      const result = host.root.agent.session.snapshotEvents().find(event =>
        event.type === 'tool/result' && event.data.message.toolCallId === callId);
      if (!result || result.type !== 'tool/result') throw new Error('TOOL_RESULT_MISSING');
      return result.data.message;
    }
    case 'hold': {
      heldTurn = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      model.beforeResponse = async () => { started.resolve(); await heldTurn?.promise; };
      host.root.agent.followup(input('Hold the local model turn'));
      await started.promise;
      return { status: host.root.agent.status };
    }
    case 'release':
      model.beforeResponse = undefined;
      heldTurn?.resolve();
      heldTurn = undefined;
      await host.root.agent.whenIdle();
      await Promise.allSettled([...control.credits]);
      return { status: host.root.agent.status };
    case 'snapshot':
      if (!heldTurn) await host.root.agent.whenIdle();
      return {
        pid: process.pid,
        endpoint_id: control.connection?.binding.endpoint_id,
        generation: control.connection?.binding.generation,
        status: host.root.agent.status,
        attempts,
        pending: [...host.root.agent.inbox.nextTurn, ...host.root.agent.inbox.nextStep],
        messages: host.root.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data),
        childMessages: host.child.agent.session.snapshotEvents().filter(event => event.type === 'user/message').length,
        inserted,
        notifications,
        releasedMessages: [...control.releasedMessages],
        repeatedRequests,
      };
    case 'drop-ack':
      dropAck = true;
      return { armed: true };
    case 'duplicate-next':
      duplicateNext = true;
      return { armed: true };
    case 'duplicate-next-request':
      duplicateNextRequest = true;
      return { armed: true };
    case 'inject-sequence': {
      if (!lastNotification) throw new Error('NO_CAPTURED_NOTIFICATION');
      const { frame, handler } = lastNotification;
      const message_id = randomUUID();
      await handler({ ...frame, message_id, delivery_id: randomUUID(), delivery_seq: command.sequence });
      if (observedReceipt?.message_id !== message_id) throw new Error('INJECTED_FRAME_RECEIPT_MISSING');
      return { status: observedReceipt.status, ...(observedReceipt.reason ? { reason: observedReceipt.reason } : {}) };
    }
    case 'replay-last': {
      if (!lastNotification) throw new Error('NO_CAPTURED_NOTIFICATION');
      const { frame, handler } = lastNotification;
      // Keep the original handler, including its original transport generation.
      // A new ID/sequence makes the unload check independent of deduplication.
      await handler(command.fresh ? {
        ...frame, message_id: randomUUID(), delivery_id: randomUUID(),
        delivery_seq: String(BigInt(frame.delivery_seq) + 1n),
      } : frame);
      return { replayed: true };
    }
    case 'disconnect':
      await control.connection!.mcpClient.close();
      return { disconnected: true };
    case 'replace-plugin':
      await plugin?.dispose();
      await attach();
      return { replaced: true };
    case 'old-receipt':
    case 'conflict-receipt':
      if (!oldReceipt) throw new Error('NO_DROPPED_RECEIPT');
      try {
        await control.submitReceipt(oldReceipt.token, command.action === 'conflict-receipt'
          ? { ...oldReceipt.request, status: 'not_enqueued', reason: ArloErrorCode.QUEUE_LIMIT }
          : oldReceipt.request);
        return { accepted: true };
      } catch (error) {
        return { accepted: false, error: (error as { code?: string }).code };
      }
    case 'unload':
      await plugin?.dispose();
      plugin = undefined;
      return { unloaded: true };
    case 'stop':
      heldTurn?.resolve();
      await plugin?.dispose();
      control.connection?.dispose();
      await host.ctx.fiber.dispose();
      return { stopped: true };
  }
}

let requests = Promise.resolve();
process.on('message', (message: { id: number; command: RecoveryCommand }) => {
  requests = requests.then(async () => {
    try {
      process.send?.({ id: message.id, result: await execute(message.command) });
      if (message.command.action === 'stop') process.disconnect();
    } catch {
      process.send?.({ id: message.id, error: 'RECOVERY_COMMAND_FAILED' });
    }
  });
});
process.on('disconnect', () => {
  heldTurn?.resolve();
  control.connection?.dispose();
  void host.ctx.fiber.dispose();
});
process.send?.({ ready: true, pid: process.pid });
