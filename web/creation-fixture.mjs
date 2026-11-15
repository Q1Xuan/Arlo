import { prepareRootCreation } from './host-create.mjs';
import assert from 'node:assert/strict';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
class Model extends LlmAdapter {
  requests = [];
  async listModels(provider) { return [{ provider, id: 'first', name: 'First' }, { provider, id: this.defaultModel, name: 'Default' }]; }
  async *stream(options) {
    this.requests.push({ provider: options.provider, model: options.model });
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export const name = 'creation-contract';
export const inject = ['sessionProjections', 'sessionController', 'workspaceController', 'workspaceRegistry', 'agents', 'llm', 'agentDefaultModel'];
export function apply(ctx) {
  ctx.appReady.onReady(async () => {
    try {
      const model = new Model();
      ctx.llm.registerAdapter(['creation-local'], model);
      const initial = { ...ctx.agentDefaultModel.currentSelection() };
      model.defaultModel = initial.model;
      const { workspace } = await ctx.workspaceController.create({ path: process.cwd() });
      const location = { workspaceId: workspace.workspaceId };
      const blank = await ctx.sessionController.create(location);
      const cancelled = new AbortController();
      cancelled.abort(new Error('cancel-before-create'));
      const count = ctx.agents.roots().length;
      await assert.rejects(ctx.sessionController.create(location, { fresh: true, signal: cancelled.signal }));
      assert.equal(ctx.agents.roots().length, count);
      if (!process.env.CREATION_BASELINE) {
        const reused = await ctx.sessionController.create({ ...location, sessionId: blank.sessionId });
        assert.equal(reused.sessionId, blank.sessionId);
        await assert.rejects(ctx.sessionController.create({ ...location, sessionId: blank.sessionId }, { fresh: true }));
      }
      const created = await ctx.sessionController.create(location, { fresh: true });
      assert.notEqual(created.sessionId, blank.sessionId);
      assert.ok(ctx.agents.get(created.sessionId));
      assert.ok(ctx.workspaceRegistry.get(workspace.workspaceId).sessionIds.includes(created.sessionId));
      const beforeInvalid = ctx.agents.roots().length;
      if (!process.env.CREATION_BASELINE) await assert.rejects(ctx.sessionController.create(location, { fresh: true, modelSelection: { provider: 'missing', model: 'missing' } }));
      assert.equal(ctx.agents.roots().length, beforeInvalid);
      const selected = { provider: 'creation-local', model: 'first' };
      const publication = new AbortController();
      const chosen = await ctx.sessionController.create(location, { fresh: true, modelSelection: selected, signal: publication.signal });
      publication.abort(new Error('after-publication'));
      const agent = ctx.agents.get(chosen.sessionId);
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first request' }], source: { kind: 'user' } }));
      await agent.whenIdle();
      assert.deepEqual(model.requests, [selected]);
      // Exercise the exact trusted Host preparation used by the contact service,
      // with real projections and ordinary controller creation, without a Arlo endpoint.
      const caller = ctx.agents.get(blank.sessionId);
      ctx.llm.registerAdapter([initial.provider], model);
      const dispatch = async root => {
        root.followup(createUserMessage({ content: [{ type: 'text', text: 'provider witness' }], source: { kind: 'user' } }));
        await root.whenIdle();
        return model.requests.at(-1);
      };
      for (const [configured, expected] of [[selected, selected], [undefined, initial]]) {
        const create = await prepareRootCreation(ctx, caller, configured, new AbortController().signal);
        const id = `session-contract-${crypto.randomUUID()}`;
        const root = await create(id, new AbortController().signal);
        assert.equal(root.id, id);
        assert.deepEqual(await dispatch(root), { provider: expected.provider, model: expected.model });
      }
      // The completed chosen root has a real request header distinct from the default.
      const fromHeader = await prepareRootCreation(ctx, agent, undefined, new AbortController().signal);
      const headerSelected = await fromHeader(`session-contract-${crypto.randomUUID()}`, new AbortController().signal);
      assert.deepEqual(await dispatch(headerSelected), selected);
      agent.session.append('model/selection', initial);
      for (const [configured, expected] of [[selected, selected], [undefined, initial]]) {
        const create = await prepareRootCreation(ctx, agent, configured, new AbortController().signal);
        const root = await create(`session-contract-${crypto.randomUUID()}`, new AbortController().signal);
        assert.deepEqual(await dispatch(root), { provider: expected.provider, model: expected.model });
      }
      agent.session.append('model/selection', { provider: 'unavailable', model: 'missing' });
      const beforeUnavailable = ctx.agents.roots().length;
      await assert.rejects(prepareRootCreation(ctx, agent, undefined, new AbortController().signal));
      assert.equal(ctx.agents.roots().length, beforeUnavailable);
      const headerCreate = await prepareRootCreation(ctx, caller, undefined, new AbortController().signal);
      const headerRoot = await headerCreate(`session-contract-${crypto.randomUUID()}`, new AbortController().signal);
      assert.deepEqual(await dispatch(headerRoot), { provider: initial.provider, model: initial.model });
      const ordinary = await ctx.sessionController.create(location);
      assert.deepEqual(await dispatch(ctx.agents.get(ordinary.sessionId)), { provider: initial.provider, model: initial.model });
      assert.ok(ctx.agents.get(chosen.sessionId));
      const beforeFailure = ctx.agents.roots().length;
      const during = new AbortController();
      const dispose = ctx.on('agent/created', () => { during.abort(new Error('during-create')); });
      await assert.rejects(ctx.sessionController.create(location, { fresh: true, signal: during.signal }));
      dispose();
      assert.equal(ctx.agents.roots().length, beforeFailure);
      const fail = ctx.on('agent/created', () => { throw new Error('creation-failed'); });
      await assert.rejects(ctx.sessionController.create(location, { fresh: true }));
      fail();
      assert.equal(ctx.agents.roots().length, beforeFailure);
      assert.deepEqual(ctx.agentDefaultModel.currentSelection(), initial);
      console.log('CREATION_CONTRACT_PASSED');
      ctx.appExit(0);
    } catch (error) { console.error(error); ctx.appExit(1); }
  });
}
