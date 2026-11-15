import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ControlClient, ArloError, ArloErrorCode, type RootRegistrationResponse } from '@arlo/sdk';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { fixture, LocalModel } from '../probes/fixture.ts';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';

for (const proof of ['succeeds', 'fails', 'stalls'] as const) test(`Plugin unload drains issued consumption credit and revokes its runtime when the proof ${proof}`, { timeout: 45000 }, async () => {
  const rig = await MessageStatusFixture.create({ roots: 1, ackTimeoutMs: 500 });
  const model = new LocalModel();
  const host = await fixture(model);
  const ready = Promise.withResolvers<void>();
  const heldTurn = Promise.withResolvers<void>();
  const enteredTurn = Promise.withResolvers<void>();
  const creditStarted = Promise.withResolvers<void>();
  const creditRetried = Promise.withResolvers<void>();
  const releaseCredit = Promise.withResolvers<void>();
  const creditCompleted = Promise.withResolvers<void>();
  const notificationArrived = Promise.withResolvers<void>();
  const releaseNotification = Promise.withResolvers<void>();
  const notificationCompleted = Promise.withResolvers<void>();
  let registration: RootRegistrationResponse | undefined;
  let creditError: string | undefined;
  let creditCalls = 0;
  const creditMessages: string[] = [];
  let pauseNotification = false;
  class DelayedCreditClient extends ControlClient {
    override createRootConnection(...args: Parameters<ControlClient['createRootConnection']>) {
      const connection = super.createRootConnection(...args);
      const install = connection.onNotification.bind(connection);
      connection.onNotification = handler => install(async frame => {
        if (!pauseNotification) return handler(frame);
        notificationArrived.resolve();
        await releaseNotification.promise;
        await handler(frame);
        notificationCompleted.resolve();
      });
      return connection;
    }
    override async registerRoot(...args: Parameters<ControlClient['registerRoot']>) {
      registration = await super.registerRoot(...args);
      return registration;
    }
    override async confirmRootReady(...args: Parameters<ControlClient['confirmRootReady']>) {
      const result = await super.confirmRootReady(...args);
      ready.resolve();
      return result;
    }
    override async releaseCredit(...args: Parameters<ControlClient['releaseCredit']>) {
      creditCalls++;
      creditMessages.push(args[1].message_id);
      if (creditCalls > 1) creditRetried.resolve();
      creditStarted.resolve();
      await releaseCredit.promise;
      try {
        if (proof !== 'succeeds') throw new ArloError(ArloErrorCode.CONNECTION_FAILED);
        return await super.releaseCredit(...args);
      }
      catch (error) { creditError = (error as { code?: string }).code; throw error; }
      finally { creditCompleted.resolve(); }
    }
  }
  const control = new DelayedCreditClient({ stateDir: rig.stateDir });
  let plugin: Awaited<ReturnType<typeof host.ctx.plugin>> | undefined;
  try {
    plugin = await host.ctx.plugin(createArloHarnessPlugin({
      stateDir: rig.stateDir, groupName: 'team-status', controlClient: control,
    }));
    await ready.promise;
    model.beforeResponse = () => { enteredTurn.resolve(); return heldTurn.promise; };
    host.root.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hold existing turn' }], source: { kind: 'user' } }));
    await enteredTurn.promise;
    const sent = await rig.roots[0].connection.sendMessage({ to: registration!.endpoint_id, text: 'queued before unload' });
    assert.equal(sent.status, 'accepted');
    assert.equal(host.root.agent.inbox.nextTurn.length, 1);
    model.beforeResponse = undefined;
    heldTurn.resolve();
    await host.root.agent.whenIdle();
    await creditStarted.promise;
    assert.equal(host.root.agent.inbox.nextTurn.length, 0);
    // A live heartbeat may retry the original unacknowledged proof before
    // unload. Exercise that public path rather than relying on timer timing.
    if (proof === 'stalls') await creditRetried.promise;
    pauseNotification = true;
    const pausedSend = rig.roots[0].connection.sendMessage({ to: registration!.endpoint_id, text: 'paused at unload' });
    await notificationArrived.promise;
    const eventsBeforeUnload = host.root.agent.session.snapshotEvents();
    const requestsBeforeUnload = model.requests.length;
    const creditCallsBeforeUnload = creditCalls;
    const disposal = plugin.dispose();
    assert.equal(await Promise.race([disposal.then(() => 'disposed'), delay(30, 'waiting')]), 'waiting',
      'Unload must keep its already-issued credit authenticated until completion');
    releaseNotification.resolve();
    await notificationCompleted.promise;
    assert.deepEqual(host.root.agent.session.snapshotEvents(), eventsBeforeUnload,
      'A previously paused notification cannot insert during accounting drain');
    assert.equal(host.root.agent.inbox.nextTurn.length, 0);
    assert.equal(model.requests.length, requestsBeforeUnload);
    if (proof === 'stalls') {
      assert.equal(await Promise.race([disposal.then(() => 'disposed'), delay(17000, 'still-waiting')]), 'disposed',
        'Unload has a finite drain deadline even if an accounting provider never settles');
      releaseCredit.resolve();
    } else {
      releaseCredit.resolve();
      await disposal;
    }
    await creditCompleted.promise;
    assert.equal(creditError, proof === 'succeeds' ? undefined : ArloErrorCode.CONNECTION_FAILED,
      'A real proof reaches the daemon before revocation; proof failure still permits cleanup');
    assert.deepEqual([...new Set(creditMessages)], [sent.message_id],
      'Every issued credit proof must refer to the original consumed message');
    assert.equal(creditCalls, creditCallsBeforeUnload,
      'Unload must not issue extra credit proofs during its accounting drain');
    assert.equal((await rig.control.listRoots()).find(root => root.endpoint_id === registration!.endpoint_id)?.status, 'revoked');
    assert.equal((await pausedSend).status, 'unknown');
  } finally {
    heldTurn.resolve();
    releaseCredit.resolve();
    releaseNotification.resolve();
    await plugin?.dispose();
    await host.ctx.fiber.dispose();
    control.dispose();
    rig.control.dispose();
    await rig.dispose();
  }
});
