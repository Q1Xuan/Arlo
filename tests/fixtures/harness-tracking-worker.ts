import { ToolCallId, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import {
  ControlClient, ArloError, ArloErrorCode,
  type ArloMessageNotificationParams, type ReadyRootRequest, type RootConnection,
  type RootCreditReleaseRequest, type RootReceiptRequest, type RootRegistrationResponse,
} from '@arlo/sdk';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { LocalModel } from '../../probes/fixture.ts';
import { persistedHarnessFixture, humanSendAllowance } from '../helpers/harness-human-allowance.ts';

type ToolRequest = {
  name: 'arlo_list_sessions' | 'arlo_send_message' | 'arlo_get_message_status';
  args: Record<string, unknown>;
};
export type TrackingCommand =
  | { action: 'tools'; calls: ToolRequest[] }
  | { action: 'replay-request'; messageId: string }
  | { action: 'snapshot' | 'hold' | 'release' | 'drop-ack' | 'replay-first-frame' | 'stop' };

const model = new LocalModel();
const host = await persistedHarnessFixture(model);
let toolSequence = 0;
let ready = false;
let heldTurn: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let replayMessageId: string | undefined;
let dropAck = false;
let notificationCount = 0;
let firstNotification: {
  frame: ArloMessageNotificationParams;
  handler: (frame: ArloMessageNotificationParams) => void | Promise<void>;
} | undefined;
let observedReceipt: RootReceiptRequest | undefined;
const inserted: string[] = [];

// Faults and observations stay at the public control/MCP boundary. Every
// business call comes from the real AgentLoop and ToolRuntime below.
class TrackingControlClient extends ControlClient {
  connection?: RootConnection;
  readonly credits = new Set<Promise<unknown>>();
  readonly releasedMessages = new Set<string>();
  override releaseCredit(token: string, request: RootCreditReleaseRequest) {
    const pending = super.releaseCredit(token, request);
    this.credits.add(pending);
    void pending.then(() => this.releasedMessages.add(request.message_id))
      .finally(() => this.credits.delete(pending)).catch(() => {});
    return pending;
  }
  override createRootConnection(binding: RootRegistrationResponse) {
    const connection = super.createRootConnection(binding);
    this.connection = connection;
    const send = connection.sendMessage.bind(connection);
    connection.sendMessage = (args, messageId) => {
      const replay = replayMessageId;
      replayMessageId = undefined;
      return send(args, replay ?? messageId);
    };
    const subscribe = connection.onNotification.bind(connection);
    connection.onNotification = handler => subscribe(frame => {
      notificationCount++;
      firstNotification ??= { frame, handler };
      return handler(frame);
    });
    return connection;
  }
  override async confirmRootReady(token: string, request: ReadyRootRequest) {
    const result = await super.confirmRootReady(token, request);
    ready = true;
    return result;
  }
  override async submitReceipt(token: string, request: RootReceiptRequest) {
    observedReceipt = request;
    if (dropAck) {
      dropAck = false;
      throw new ArloError(ArloErrorCode.CONNECTION_FAILED);
    }
    return super.submitReceipt(token, request);
  }
}

const control = new TrackingControlClient({ stateDir: process.env.ARLO_STATE_DIR });
host.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
  if (agent === host.root.agent && message.source?.kind === 'arlo') inserted.push(String(message.id));
});
const definition = createArloHarnessPlugin({
  groupName: 'process-tracking', stateDir: process.env.ARLO_STATE_DIR,
  controlClient: control, autoStart: false,
});
const humanAllowance = humanSendAllowance(definition, host.root.agent);
const plugin = await host.ctx.plugin(definition);
const input = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

async function execute(command: TrackingCommand): Promise<unknown> {
  switch (command.action) {
    case 'tools': {
      if (command.calls.length > 20) {
        const results: unknown[] = [];
        for (let offset = 0; offset < command.calls.length; offset += 20) {
          const batch = await execute({ action: 'tools', calls: command.calls.slice(offset, offset + 20) });
          if (!Array.isArray(batch)) throw new Error('SCRIPTED_BATCH_RESULT_MISSING');
          results.push(...batch);
        }
        return results;
      }
      const sends = command.calls.filter(call => call.name === 'arlo_send_message').length;
      if (sends) await humanAllowance.prepare(sends);
      const ids = command.calls.map(() => ToolCallId(`tracking-tool-${++toolSequence}`));
      const chunks: StreamChunk[] = command.calls.flatMap((call, index): StreamChunk[] => {
        const args = JSON.stringify(call.args);
        return [
          { type: 'block-start', index, blockType: 'tool-call' },
          { type: 'tool-call-delta', index, id: ids[index], name: call.name, argumentsDelta: args },
          { type: 'block-end', index, block: { type: 'tool-call', id: ids[index], name: call.name, arguments: args } },
        ];
      });
      chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } });
      model.script.push(chunks);
      host.root.agent.followup(input('Run the scripted local tool calls'));
      await host.root.agent.whenIdle();
      const events = host.root.agent.session.snapshotEvents();
      return ids.map(id => {
        const event = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === id);
        if (!event || event.type !== 'tool/result') throw new Error('TOOL_RESULT_MISSING');
        return event.data.message;
      });
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
    case 'snapshot': {
      if (!heldTurn) await host.root.agent.whenIdle();
      await Promise.allSettled([...control.credits]);
      const events = host.root.agent.session.snapshotEvents();
      return {
        pid: process.pid, ready, endpoint_id: control.connection?.binding.endpoint_id,
        status: host.root.agent.status,
        pending: [...host.root.agent.inbox.nextTurn, ...host.root.agent.inbox.nextStep].map(message => String(message.id)),
        consumed: events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'arlo')
          .map(event => event.type === 'user/message' ? String(event.data.id) : ''),
        inserted, notifications: notificationCount, releasedMessages: [...control.releasedMessages],
        childMessages: host.child.agent.session.snapshotEvents().filter(event => event.type === 'user/message').length,
      };
    }
    case 'replay-request':
      replayMessageId = command.messageId;
      return { armed: true };
    case 'drop-ack':
      dropAck = true;
      return { armed: true };
    case 'replay-first-frame': {
      if (!firstNotification) throw new Error('NO_CAPTURED_NOTIFICATION');
      await firstNotification.handler(firstNotification.frame);
      if (observedReceipt?.message_id !== firstNotification.frame.message_id) throw new Error('REPLAY_RECEIPT_MISSING');
      return { status: observedReceipt.status, reason: observedReceipt.reason, native_message_id: observedReceipt.native_message_id };
    }
    case 'stop':
      heldTurn?.resolve();
      await plugin.dispose();
      control.connection?.dispose();
      await host.ctx.fiber.dispose();
      return { stopped: true };
  }
}

let requests = Promise.resolve();
process.on('message', (message: { id: number; command: TrackingCommand }) => {
  requests = requests.then(async () => {
    try {
      process.send?.({ id: message.id, result: await execute(message.command) });
      if (message.command.action === 'stop') process.disconnect();
    } catch {
      process.send?.({ id: message.id, error: 'TRACKING_COMMAND_FAILED' });
    }
  });
});
process.on('disconnect', () => {
  heldTurn?.resolve();
  control.connection?.dispose();
  void host.ctx.fiber.dispose();
});
process.send?.({ ready: true, pid: process.pid });
