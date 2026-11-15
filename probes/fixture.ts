import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';

export class LocalModel extends LlmAdapter {
  requests: GenerateOptions[] = [];
  script: StreamChunk[][] = [];
  beforeResponse?: () => Promise<void>;
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    await this.beforeResponse?.();
    const response = this.script.shift();
    if (response) { yield* response; return; }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'fictional response' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fictional response' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function toolResponse(name: string): StreamChunk[] {
  const id = ToolCallId('fictional-call');
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

// Only the fixture creates agents, before an integration is attached.
// No launcher, config loader, persistence, provider, or global plugin is loaded.
export async function fixture(model = new LocalModel(), beforeAgents?: (ctx: Context) => void,
  options: { sessionCwd?: string; sessionDirectory?: string; sessionId?: string } = {}) {
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    if (options.sessionDirectory) {
      const { default: JsonlSessionPersistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl');
      await ctx.plugin(JsonlSessionPersistence, { root: options.sessionDirectory });
    }
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    ctx.llm.registerAdapter(['arlo-local'], model);
    beforeAgents?.(ctx);
    const root = await ctx.agents.create({
      sessionId: SessionId(options.sessionId ?? 'fictional-root'),
      ...(options.sessionCwd !== undefined ? { meta: { cwd: options.sessionCwd } } : {}),
      agentOptions: { provider: 'arlo-local', model: 'scripted' },
    });
    const child = await root.agent.ctx.agents.create({
      sessionId: SessionId(`${options.sessionId ?? 'fictional'}-child`), parentAgent: root.agent,
      agentOptions: { provider: 'arlo-local', model: 'scripted' },
    });
    return { ctx, root, child, model };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
