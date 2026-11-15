import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { eventually, inbound, nativeScenario, sendFromNative } from './harness.mjs';

test('a later native settlement handler may wait without stranding accepted input',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('settled-handler');
    let bravo;
    t.after(async () => { bravo?.gate('settled', 'release'); await rig.close(); });
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    bravo = await rig.start('bravo');
    await bravo.ready();
    bravo.gate('settled', 'hold');
    await bravo.submit('Complete this native task and wait in the later settlement handler.');
    await eventually(() => bravo.events(), events => events.some(event =>
      event.type === 'gate' && event.name === 'settled'), 'a later public settlement handler remains pending');
    assert.equal(bravo.events().findLast(event => event.type === 'agent_settled').idle, true,
      'Pi reports idle before it finishes emitting agent_settled');

    const marker = 'PI_ACCEPTED_DURING_DELAYED_SETTLEMENT_HANDLER';
    const first = await sendFromNative(rig, alpha, bravo.name, `${marker}: process after settlement finishes.`);
    assert.equal(first.status.status, 'accepted');
    // The later public handler legitimately outlives all three one-second
    // control-delivery deadlines. It has not released Pi's deferred commands.
    await delay(3500);
    assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, marker)), false,
      'The received input stays pending until the native settlement handler finishes');
    bravo.gate('settled', 'release');
    await eventually(() => bravo.events(), events => events.some(event =>
      event.type === 'agent_settled_handler_complete'), 'the delayed native settlement handler completes');
    const result = await eventually(() => ({
      received: rig.requests.filter(request => request.peer === 'bravo' && inbound(request.body, marker)),
      stopped: bravo.output.includes('Arlo cannot schedule received input'),
    }), value => value.received.length > 0 || value.stopped,
    'accepted input automatically reaches the model after settlement', 8_000);
    t.diagnostic(`Delayed settlement result: ${JSON.stringify({
      receipt: first.receipt.status, status: first.status.status,
      modelRequests: result.received.length, receptionStopped: result.stopped,
    })}`);
    assert.equal(result.stopped, false,
      'A legitimately deferred native control must not permanently suspend reception');
    assert.equal(result.received.length, 1, 'The existing root processes the accepted input exactly once');
    assert.equal(inbound(result.received[0].body, marker).message_id, first.receipt.message_id);
    await eventually(() => bravo.events(), events => events.filter(event => event.type === 'agent_settled').length === 2,
      'the received input processing settles');

    const fresh = 'PI_FRESH_INPUT_AFTER_DELAYED_SETTLEMENT_HANDLER';
    await sendFromNative(rig, alpha, bravo.name, `${fresh}: reception remains available.`);
    await eventually(() => rig.requests, requests => requests.some(request =>
      request.peer === 'bravo' && inbound(request.body, fresh)), 'fresh input still reaches the existing root');
    assert.equal(bravo.events().filter(event => event.type === 'message_end' &&
      event.message?.role === 'custom' && JSON.stringify(event.message.content).includes(marker)).length, 1);
    assert.deepEqual(rig.errors, []);
  });
