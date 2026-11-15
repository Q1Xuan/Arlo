// Installed-native display observer: no Arlo plugin, endpoint or messaging tools.
import fs from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
export const inject = ['agents', 'llm', 'sessionController', 'workspaceController', 'agentDefaultModel', 'sessionProjections', 'workspaceRegistry'];
export function apply(ctx) {
  const requests = [];
  const token = randomBytes(24).toString('hex');
  let held = false, release;
  class Model extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'scripted', name: 'Contract model' }]; }
    async *stream(options) {
      requests.push({ sessionId: options.sessionId, messages: options.messages });
      if (held) await new Promise(resolve => { release = resolve; options.signal?.addEventListener('abort', resolve, { once: true }); });
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['display-local'], new Model());
  ctx.appReady.onReady(async () => {
    const { workspace } = await ctx.workspaceController.create({ path: process.cwd() });
    const root = await ctx.sessionController.create({ sessionId: 'submission-a', workspaceId: workspace.workspaceId }, {
      fresh: true, modelSelection: { provider: 'display-local', model: 'scripted' } });
    await ctx.sessionController.rename({ sessionId: root.sessionId, title: 'Display contract' });
    const agent = ctx.agents.get(root.sessionId);
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end('{}'); return; }
      try {
        let body = ''; for await (const chunk of req) body += chunk;
        const data = body ? JSON.parse(body) : {};
        if (req.url === '/seed' || req.url === '/queue') {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: data.text }], source: { kind: 'user' } }));
          if (req.url === '/seed') await agent.whenIdle();
        } else if (req.url === '/hold') held = true;
        else if (req.url === '/release') { held = false; release?.(); }

        res.end(JSON.stringify({ requests, roots: ctx.agents.roots().map(root => root.id), queue: agent.inbox.nextTurn }));
      } catch (error) { res.writeHead(400).end(JSON.stringify({ error: String(error) })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    ctx.effect(() => () => { release?.(); server.close(); });
    fs.writeFileSync(process.env.SUBMISSION_REPORT, JSON.stringify({ control: `http://127.0.0.1:${server.address().port}`, token }));
  });
}
