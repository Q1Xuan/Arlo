import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm';

// A deliberately small M0 demonstrator, not the SDK's delivery ledger.
// Reserve before followup; ACK never releases credit. All observations use
// public Agent APIs. Reattachment reconstructs pending before admission.
export function attachPendingProbe(ctx: Context, agent: Agent, limit: number) {
  if (!ctx.agents.roots().includes(agent)) throw new Error('CALLER_NOT_ROOT');
  const snapshot = () => [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    .filter(message => message.source.kind === 'arlo').map(message => message.id);
  const held = new Set(snapshot());
  const observed = new Set<MessageId>();
  const inFlight = new Set<MessageId>();
  let active = true;
  const inserted = ctx.on('agent/inbox/inserted', event => {
    if (event.agent === agent && inFlight.has(event.message.id)) observed.add(event.message.id);
  });
  const release = (event: { agent: Agent; message: UserMessage }) => {
    if (event.agent !== agent) return;
    if (inFlight.has(event.message.id)) observed.add(event.message.id);
    held.delete(event.message.id);
  };
  const claimed = ctx.on('agent/inbox/claimed', release);
  const discarded = ctx.on('agent/inbox/discarded', release);
  return {
    offer(message: UserMessage): 'accepted' | 'rejected' | 'unknown' {
      if (!active || !ctx.agents.roots().includes(agent) || message.source.kind !== 'arlo') return 'rejected';
      try {
        for (const id of snapshot()) held.add(id);
      } catch {
        return 'rejected'; // No dispatch occurred: accounting is unavailable.
      }
      if (held.size >= limit || held.has(message.id)) return 'rejected';
      held.add(message.id);
      inFlight.add(message.id);
      try {
        agent.followup(message);
        return 'accepted';
      } catch {
        if (observed.has(message.id)) return 'accepted';
        try {
          if (snapshot().includes(message.id)) return 'accepted';
        } catch { /* No usable evidence: retain the reservation. */ }
        return 'unknown';
      } finally {
        observed.delete(message.id);
        inFlight.delete(message.id);
      }
    },
    dispose() {
      active = false;
      inserted(); claimed(); discarded();
    },
  };
}
