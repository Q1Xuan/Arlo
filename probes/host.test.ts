import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { createUserMessage, type MessageId } from '@deepseek-ai/dsh-llm';
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import { fixture, LocalModel, toolResponse } from './fixture.ts';
import { arloMessage } from './message.ts';

test('public message constructor preserves external source and native identity', () => {
  const message = createUserMessage({
    content: [{ type: 'text', text: 'fictional-arlo-canary' }],
    source: { kind: 'arlo', form: 'relay' },
  });
  assert.match(message.id, /^[0-9a-f-]{36}$/);
  assert.equal(message.role, 'user');
  assert.deepEqual(JSON.parse(JSON.stringify(message)).source, { kind: 'arlo', form: 'relay' });
});

test('idle followup wakes; busy followup queues without preemption and preserves history identity', { timeout: 10000 }, async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const model = new LocalModel();
  model.beforeResponse = async () => { entered.resolve(); await release.promise; };
  const host = await fixture(model);
  const claimed: MessageId[] = [];
  host.ctx.on('agent/inbox/claimed', ({ message }) => { claimed.push(message.id); });
  const first = arloMessage('first');
  const second = arloMessage('second');
  try {
    host.root.agent.followup(first);
    await entered.promise;
    assert.equal(host.root.agent.status, 'running');
    host.root.agent.followup(second);
    assert.equal(model.requests.length, 1);
    assert.equal(model.requests[0]?.signal?.aborted, false);
    assert.deepEqual(host.root.agent.inbox.nextTurn.map(message => message.id), [second.id]);
    assert.deepEqual(claimed, [first.id]);
    release.resolve();
    await host.root.agent.whenIdle();
    assert.equal(model.requests.length, 2);
    assert.deepEqual(claimed, [first.id, second.id]);
    assert.deepEqual(host.root.agent.inbox.nextTurn, []);
    const messages = host.root.agent.session.snapshotEvents()
      .filter(event => event.type === 'user/message').map(event => event.data);
    assert.deepEqual(messages.map(message => message.id), [first.id, second.id]);
    assert.deepEqual(messages.map(message => message.source), [first.source, second.source]);
    writeFileSync('history.json', JSON.stringify({
      header: host.root.agent.session.header,
      events: host.root.agent.session.snapshotEvents(),
      messageIds: [first.id, second.id],
    }));
  } finally {
    release.resolve();
    await host.ctx.fiber.dispose();
  }
});

test('attach sees existing live roots and lifecycle without creating sessions', { timeout: 10000 }, async () => {
  const created: Agent[] = [];
  const host = await fixture(new LocalModel(), ctx => {
    ctx.on('agent/created', ({ agent }) => { created.push(agent); return undefined; });
  });
  try {
    assert.deepEqual(created, [host.root.agent, host.child.agent]);
    assert.deepEqual(host.ctx.agents.roots(), [host.root.agent]);
    assert.equal(host.ctx.agents.isOwnedBy(host.child.agent.id, host.root.agent), true);
    assert.deepEqual(new Set(host.ctx.agents.list()), new Set([host.root.agent, host.child.agent]));
    const disposed: string[] = [];
    const unsubscribe = host.ctx.on('agent/disposed', ({ agent }) => { disposed.push(agent.id); });
    await host.child.dispose();
    assert.deepEqual(disposed, [host.child.agent.id]);
    assert.deepEqual(host.ctx.agents.roots(), [host.root.agent]);
    unsubscribe();
  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('real tool caller is the exact root or child; repeated plugin load publishes once', { timeout: 10000 }, async () => {
  const model = new LocalModel();
  const host = await fixture(model);
  const publications: Agent[] = [];
  const callers: Agent[] = [];
  const outcomes: string[] = [];
  // Arlo-owned marker, not a Harness internal symbol. Cordis contextualizes
  // service proxies, so a WeakSet keyed by those proxies is not sufficient.
  const ownerKey = Symbol.for('arlo.m0.registry-owner');
  const integration = (ctx: Context) => {
    if (Reflect.has(ctx.agents, ownerKey)) return;
    const token = {};
    Object.defineProperty(ctx.agents, ownerKey, { value: token, configurable: true });
    ctx.effect(() => () => {
      if (Reflect.get(ctx.agents, ownerKey) === token) Reflect.deleteProperty(ctx.agents, ownerKey);
    });
    publications.push(...ctx.agents.roots());
    ctx.tools.register(defineContentToolFixture({
      name: 'arlo_binding_probe', description: 'Check fictional root binding', parameters: {},
      execute: async (_args, exec) => {
        assert.ok(exec.agent);
        assert.equal(ctx.agents.requireInitiator(), exec.agent);
        callers.push(exec.agent);
        const result = exec.agent === host.root.agent && ctx.agents.roots().includes(exec.agent)
          ? 'accepted-root' : 'CALLER_NOT_ROOT';
        outcomes.push(result);
        return [{ type: 'text', text: result }];
      },
    }));
  };
  Object.assign(integration, { inject: ['agents', 'tools'] });
  try {
    const firstLoad = await host.ctx.plugin(integration);
    await host.ctx.plugin(integration);
    assert.deepEqual(publications, [host.root.agent]);
    for (const agent of [host.root.agent, host.child.agent]) {
      model.script.push(toolResponse('arlo_binding_probe'));
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fictional tool request' }], source: { kind: 'arlo', form: 'relay' } }));
      await agent.whenIdle();
    }
    assert.deepEqual(callers, [host.root.agent, host.child.agent]);
    assert.deepEqual(outcomes, ['accepted-root', 'CALLER_NOT_ROOT']);
    assert.equal(host.ctx.agents.currentInitiator(), undefined);
    await firstLoad.dispose();
    await host.ctx.plugin(integration);
    assert.deepEqual(publications, [host.root.agent, host.root.agent]);
  } finally {
    await host.ctx.fiber.dispose();
  }
});
