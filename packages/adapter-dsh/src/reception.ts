import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { PendingInput, ReceptionHost } from '@arlo/adapter-sdk';
import type { ArloMessageNotificationParams } from '@arlo/sdk';
import crypto from 'node:crypto';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    arlo: { kind: 'arlo'; form: 'relay' };
  }
}

// The identity belongs to the live host object, surviving plugin reattachment
// without retaining a disposed agent.
const instanceIds = new WeakMap<Agent, string>();

export function arloMessage(text: string, frame?: ArloMessageNotificationParams): UserMessage {
  return createUserMessage({
    content: [
      { type: 'text', text },
      // Keep the body verbatim, with model-visible addressing in a separate block.
      ...(frame ? [{ type: 'text' as const, text: JSON.stringify({ arlo: {
        message_id: frame.message_id,
        from_endpoint: frame.from_endpoint,
        ...(frame.reply_to !== undefined ? {
          reply_to: frame.reply_to, reply_depth: frame.reply_depth,
        } : {}),
      } }) }] : []),
    ],
    source: { kind: 'arlo', form: 'relay' },
  });
}

function unassociatedInput(message: UserMessage): PendingInput {
  return {
    nativeMessageId: String(message.id),
    messageId: String(message.id),
    textBytes: message.content.reduce((bytes, block) =>
      bytes + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0),
  };
}

/** DSH owns native input and observations; the adapter SDK owns reception accounting. */
export function createDshReceptionHost(agent: Agent): ReceptionHost {
  let instanceId = instanceIds.get(agent);
  if (!instanceId) {
    instanceId = crypto.randomUUID();
    instanceIds.set(agent, instanceId);
  }
  const identity = instanceId;
  // Dispatch associations survive a transport reconnect with this host port,
  // but a fresh attachment has no retained receipt identity to reconstruct.
  // DSH snapshots messages into its durable projection, so its events carry
  // cloned objects with the same native ID, not the prepare() object reference.
  const messageAssociations = new Map<string, PendingInput>();
  return {
    instanceId: identity,
    prepare(frame) {
      const message = arloMessage(frame.text, frame);
      messageAssociations.set(String(message.id), {
        nativeMessageId: String(message.id),
        messageId: frame.message_id,
        textBytes: Buffer.byteLength(frame.text, 'utf8'),
        dispatch: {
          daemon_id: frame.daemon_id,
          endpoint_id: frame.to_endpoint,
          message_id: frame.message_id,
          delivery_id: frame.delivery_id,
          generation: frame.target_generation,
        },
      });
      return {
        nativeMessageId: String(message.id),
        enqueue() {
          // followup inserts synchronously, then wakes the existing agent. A
          // post-insertion exception propagates for the ledger to keep unknown.
          agent.followup(message);
          return 'enqueued';
        },
      };
    },
    snapshot(scope) {
      return {
        instanceId: identity,
        generation: scope.generation,
        complete: true,
        pending: [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
          .filter(message => message.source.kind === 'arlo')
          .map(message => messageAssociations.get(String(message.id)) ?? unassociatedInput(message)),
        // DSH has no deferred followup insertion outside these public queues.
        // The ledger separately protects its synchronous enqueue call stack.
        inFlight: [],
      };
    },
    observe(listener) {
      const release = (event: 'claimed' | 'discarded') =>
        ({ agent: eventAgent, message }: { agent: Agent; message: UserMessage }) => {
          if (eventAgent !== agent) return;
          const nativeMessageId = String(message.id);
          const association = messageAssociations.get(nativeMessageId);
          if (!association?.dispatch) return;
          try {
            listener({ instanceId: identity, dispatch: association.dispatch, nativeMessageId, event });
          } finally {
            messageAssociations.delete(nativeMessageId);
          }
        };
      const stopClaimed = agent.ctx.on('agent/inbox/claimed', release('claimed'));
      const stopDiscarded = agent.ctx.on('agent/inbox/discarded', release('discarded'));
      return () => { stopClaimed(); stopDiscarded(); };
    },
  };
}
