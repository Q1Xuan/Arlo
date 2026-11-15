import fs from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { Service } from '@deepseek-ai/cordis';
import { prepareRootCreation } from './host-create.mjs';
import client from './client.cjs';

export const inject = ['agents', 'llm', 'typert', 'sessionController', 'sessionProjections', 'workspaceController', 'workspaceRegistry', 'agentDefaultModel', 'configEditor'];
// The Loader-owned client plugin also owns its Remote namespace. The observer
// survives its removal so cancellation and absence of prompt can be verified.
export function apply(ctx) {
  const requests = [], creations = [], calls = [];
  const token = randomBytes(24).toString('hex');
  let mode = {}, gate;
  class Model extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'scripted', name: 'Contract model' }]; }
    async *stream(options) {
      requests.push({ sessionId: options.sessionId, messages: options.messages, model: options.model });
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['submission-local'], new Model());
  class Creation extends TypertRemoteService {
    constructor(scope) {
      super(scope, 'submissionContract');
      this.lifetime = new AbortController();
      scope.effect(() => () => this.lifetime.abort());
    }
    async create(sessionId, signal) {
      signal = AbortSignal.any([signal, this.lifetime.signal]);
      const call = { caller: sessionId, state: 'entered' };
      calls.push(call);
      try {
        if (calls.length === mode.holdAt) {
          gate = Promise.withResolvers();
          const abort = () => gate?.reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          try { await gate.promise; } finally { signal.removeEventListener('abort', abort); gate = undefined; }
        }
        signal.throwIfAborted();
        if (calls.length === mode.failAt) throw new Error('Intentional native creation refusal');
        const caller = ctx.agents.get(sessionId);
        if (!caller) throw new Error('Missing submitting root');
        const create = await prepareRootCreation(ctx, caller, { provider: 'submission-local', model: 'scripted' }, signal);
        const root = await create(`submission-${randomUUID()}`, signal);
        creations.push({ caller: sessionId, id: root.id });
        call.state = 'created';
        return root.id;
      } catch (error) { call.state = signal.aborted ? 'aborted' : 'failed'; throw error; }
    }
  }
  class Observer extends Service {
    constructor() { super(ctx, 'submissionObserver'); }
    mount(scope) {
      new Creation(scope);
      scope.effect(() => scope.typert.register({ package: 'submission-contract', face: 'host', schemas: [],
        model: { services: [], events: [], objects: [] }, invocations: [client.descriptor] }));
    }
  }
  new Observer();
  ctx.appReady.onReady(async () => {
    const { workspace } = await ctx.workspaceController.create({ path: process.cwd() });
    for (const id of ['submission-a', 'submission-b']) {
      await ctx.sessionController.create({ sessionId: id, workspaceId: workspace.workspaceId }, { fresh: true,
        modelSelection: { provider: 'submission-local', model: 'scripted' } });
      await ctx.sessionController.rename({ sessionId: id, title: id });
      const agent = ctx.agents.get(id);
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Existing work context' }], source: { kind: 'user' } }));
      await agent.whenIdle();
    }
    requests.length = 0;
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end('{}'); return; }
      try {
        if (req.url === '/mode') {
          let body = ''; for await (const chunk of req) body += chunk;
          mode = JSON.parse(body);
        } else if (req.url === '/release') gate?.resolve();
        else if (req.url === '/unload') {
          const entry = ctx.configEditor.configuration().find(item => item.entry.options.id === 'submission-contract')?.entry;
          if (!entry) throw new Error('Missing acceptance client plugin');
          await entry.update({ disabled: true });
        }
        res.end(JSON.stringify({ requests, creations, calls, roots: ctx.agents.roots().map(agent => agent.id) }));
      } catch (error) { res.writeHead(400).end(JSON.stringify({ error: String(error) })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    ctx.effect(() => () => server.close());
    fs.writeFileSync(process.env.SUBMISSION_REPORT, JSON.stringify({ control: `http://127.0.0.1:${server.address().port}`, token }));
  });
}
