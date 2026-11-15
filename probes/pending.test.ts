import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fixture.ts';
import { attachPendingProbe } from './pending.ts';
import { arloMessage } from './message.ts';

const message = () => arloMessage('fictional pending canary');

test('real pre-append failure leaves no input; absent positive evidence remains unknown and holds credit', { timeout: 10000 }, async () => {
  const host = await fixture();
  const probe = attachPendingProbe(host.ctx, host.root.agent, 1);
  const before = host.root.agent.session.snapshotEvents();
  const stopThrowing = host.ctx.on('internal/dispatch', (_type, name) => {
    if (name === 'session/event') throw new Error('FICTIONAL_BEFORE_APPEND');
  });
  try {
    assert.equal(probe.offer(message()), 'unknown');
    assert.deepEqual(host.root.agent.session.snapshotEvents(), before);
    assert.deepEqual(host.root.agent.inbox.nextTurn, []);
    stopThrowing();
    // The probe does not have the test injector's knowledge of the boundary.
    assert.equal(probe.offer(message()), 'rejected');
    assert.equal(host.model.requests.length, 0);
  } finally {
    stopThrowing();
    probe.dispose();
    await host.ctx.fiber.dispose();
  }
});

test('pending remains bounded across attachment reload, discard, and claim', { timeout: 10000 }, async () => {
  const host = await fixture();
  const release = Promise.withResolvers<void>();
  const maintenance = host.root.agent.runMaintenance(() => release.promise);
  let probe = attachPendingProbe(host.ctx, host.root.agent, 2);
  try {
    const first = message(), second = message();
    assert.equal(probe.offer(first), 'accepted');
    assert.equal(probe.offer(second), 'accepted');
    assert.equal(probe.offer(message()), 'rejected');
    assert.equal(host.root.agent.inbox.nextTurn.length, 2);
    probe.dispose();
    probe = attachPendingProbe(host.ctx, host.root.agent, 2);
    assert.equal(probe.offer(message()), 'rejected');
    assert.equal(host.root.agent.inbox.remove(first.id), true);
    assert.equal(probe.offer(message()), 'accepted');
    assert.equal(probe.offer(message()), 'rejected');
    release.resolve();
    await maintenance;
    await host.root.agent.whenIdle();
    assert.equal(probe.offer(message()), 'accepted');
    await host.root.agent.whenIdle();
    assert.equal(host.root.agent.inbox.nextTurn.length, 0);
  } finally {
    release.resolve();
    await maintenance;
    probe.dispose();
    await host.ctx.fiber.dispose();
  }
});

test('throw after real insertion is accepted using pending evidence, even before our event listener', { timeout: 10000 }, async () => {
  const host = await fixture();
  // Cordis exports this dispatch instrumentation event. Throw before agent
  // observer containment, but after the real Session append has committed.
  const stopThrowing = host.ctx.on('internal/dispatch', (_type, name) => {
    if (name === 'agent/inbox/inserted') throw new Error('FICTIONAL_AFTER_INSERT');
  });
  const probe = attachPendingProbe(host.ctx, host.root.agent, 2);
  const input = message();
  try {
    assert.equal(probe.offer(input), 'accepted');
    assert.deepEqual(host.root.agent.inbox.nextTurn.map(item => item.id), [input.id]);
    // The exception prevents wakeDriver: accepted does not imply processing.
    assert.equal(host.root.agent.status, 'idle');
    assert.equal(host.model.requests.length, 0);
  } finally {
    stopThrowing();
    probe.dispose();
    await host.ctx.fiber.dispose();
  }
});
