import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { eventually, inbound, modelText, nativeScenario, sendFromNative } from './harness.mjs';

for (const initialInput of [true, false]) {
  test(`successful native manual compaction processes ${initialInput ? 'pending input' : 'a late first input'} after all completion handlers finish`,
    { timeout: 120_000 }, async t => {
      const rig = await nativeScenario(`manual-compact-success-${initialInput ? 'pending' : 'late'}`);
      t.after(() => rig.close());
      t.diagnostic(`Evidence: ${rig.directory}`);
      const alpha = await rig.start('alpha');
      await alpha.ready();
      const bravo = await rig.start('bravo', {
        compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1 },
      });
      await bravo.ready();
      const settledCount = () => bravo.events().filter(event => event.type === 'agent_settled').length;
      await bravo.submit('Create a complete native turn for the upcoming successful manual compaction.');
      await eventually(settledCount, count => count === 1, 'the seed turn settles');

      let compactRequest;
      rig.handlers.set('bravo', request => { compactRequest = request; });
      bravo.gate('compaction-complete', 'hold');
      await bravo.submit('/compact');
      await eventually(() => ({ events: bravo.events(), compactRequest }), value => value.compactRequest &&
        value.events.some(event => event.type === 'session_before_compact' && event.reason === 'manual'),
      'manual compaction reaches its actual model request');

      const duringCompaction = 'PI_ACCEPTED_DURING_SUCCESSFUL_MANUAL_COMPACTION';
      if (initialInput) {
        await sendFromNative(rig, alpha, bravo.name, `${duringCompaction}: process after compaction finishes.`);
      }
      assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, duringCompaction)), false);
      rig.handlers.set('bravo', modelText('The received inputs were processed after compaction.'));
      modelText('The native seed turn is complete. Continue using this compacted conversation summary.')(compactRequest);
      await eventually(() => bravo.events(), events => events.some(event =>
        event.type === 'gate' && event.name === 'compaction-complete'), 'a later public completion handler stays pending');
      assert.equal(bravo.events().findLast(event => event.type === 'session_compact').idle, false,
        'The successful completion notification precedes Pi releasing the manual-compaction slot');

      // A full native send/status roundtrip keeps the later completion handler
      // suspended across multiple event-loop turns. A zero-delay scheduling
      // callback therefore cannot mistake the notification for true completion.
      const duringHandler = 'PI_ACCEPTED_DURING_DELAYED_COMPACTION_HANDLER';
      await sendFromNative(rig, alpha, bravo.name, `${duringHandler}: wait for the later completion handler too.`);
      // A delivered command waiting for this public handler must outlive the
      // one-second lost-control watchdog without losing its scheduling token.
      await delay(1200);
      const markers = initialInput ? [duringCompaction, duringHandler] : [duringHandler];
      for (const marker of markers) {
        assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, marker)), false,
          'Accepted business input must remain pending while manual compaction still owns its processing slot');
      }
      assert.equal(settledCount(), 1, 'Manual compaction does not emit a separate agent_settled notification');

      bravo.gate('compaction-complete', 'release');
      await eventually(() => rig.requests, requests => requests.some(request => request.peer === 'bravo' &&
        markers.every(marker => inbound(request.body, marker))),
      'all accepted input automatically reaches the model after manual compaction', 8_000);
      await eventually(settledCount, count => count === 2, 'received input processing settles');
      assert.equal(bravo.events().filter(event => event.type === 'session_compact_handler_complete').length, 1);
      assert.equal(bravo.events().filter(event => event.type === 'agent_settled').at(-1).aborted, false);
      assert.equal(bravo.output.includes('Arlo cannot schedule received input'), false);
      assert.deepEqual(rig.errors, []);
    });
}

test('native manual compaction cancellation accepts a new first input while a later failure handler waits',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('manual-compact-cancel-complete');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo', {
      compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1 },
    });
    await bravo.ready();
    const settledCount = () => bravo.events().filter(event => event.type === 'agent_settled').length;
    await bravo.submit('Create a complete native turn before cancelling manual compaction.');
    await eventually(settledCount, count => count === 1, 'the seed turn settles');

    let compactRequest;
    rig.handlers.set('bravo', request => { compactRequest = request; });
    bravo.gate('compaction-failed', 'hold');
    await bravo.submit('/compact');
    await eventually(() => ({ events: bravo.events(), compactRequest }), value => value.compactRequest &&
      value.events.some(event => event.type === 'session_before_compact' && event.reason === 'manual'),
    'manual compaction reaches its actual model request');
    const cancelledMarker = 'PI_CANCELLED_BEFORE_DELAYED_COMPACTION_FAILURE_HANDLER';
    await sendFromNative(rig, alpha, bravo.name, `${cancelledMarker}: discard at the native interruption boundary.`);

    const beforeCancel = bravo.events().length;
    bravo.write('\u001b');
    await eventually(() => bravo.events().slice(beforeCancel), events => events.some(event =>
      event.type === 'gate' && event.name === 'compaction-failed'), 'the later failure handler waits after cancellation');
    const failed = bravo.events().findLast(event => event.type === 'session_compact_failed');
    assert.equal(failed.aborted, true);
    assert.equal(failed.idle, true, 'Pi 1.1.0 releases manual compaction before its failure notification');
    assert.ok(bravo.events().slice(beforeCancel).some(event => event.type === 'terminal_escape' && event.idle === false));
    await eventually(() => compactRequest.closed, Boolean, 'the aborted compaction releases its model connection');
    await eventually(() => bravo.output, output => output.includes('Arlo cancelled 1 pending message'),
      'the original pending input is discarded');
    assert.equal(settledCount(), 1, 'Cancelling standalone compaction does not emit agent_settled');

    rig.handlers.set('bravo', modelText('The new input arrived after cancellation and was processed.'));
    const freshMarker = 'PI_FRESH_FIRST_INPUT_DURING_DELAYED_COMPACTION_FAILURE_HANDLER';
    await sendFromNative(rig, alpha, bravo.name, `${freshMarker}: accept and process this new input.`);
    await eventually(() => rig.requests, requests => requests.some(request =>
      request.peer === 'bravo' && inbound(request.body, freshMarker)), 'the new first input reaches the model');
    await eventually(settledCount, count => count === 2, 'the fresh input completes despite the pending failure handler');
    bravo.gate('compaction-failed', 'release');
    await eventually(() => bravo.events(), events => events.some(event =>
      event.type === 'session_compact_failed_handler_complete'), 'the delayed failure handler completes');
    assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, cancelledMarker)), false,
      'A completion wake cannot revive input discarded by the earlier cancellation');
    assert.equal(bravo.events().filter(event => event.type === 'agent_settled').at(-1).aborted, false);
    assert.deepEqual(rig.errors, []);
  });

test('native automatic compaction cancellation waits for delayed failure handlers without exhausting completion wakes',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('automatic-compact-cancel-complete');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo', {
      compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1 },
    });
    await bravo.ready();
    let compactRequest;
    let firstRequest = true;
    rig.handlers.set('bravo', request => {
      if (!firstRequest) { compactRequest = request; return; }
      firstRequest = false;
      return modelText('This turn crosses the automatic compaction threshold.',
        { prompt_tokens: 7500, completion_tokens: 10, total_tokens: 7510 })(request);
    });
    bravo.gate('compaction-failed', 'hold');
    await bravo.submit('Begin a native turn that requires automatic compaction.');
    await eventually(() => ({ events: bravo.events(), compactRequest }), value => value.compactRequest &&
      value.events.some(event => event.type === 'session_before_compact' && event.reason === 'threshold'),
    'automatic compaction reaches its actual model request');
    const cancelledMarker = 'PI_CANCELLED_DURING_DELAYED_AUTOMATIC_COMPACTION_FAILURE';
    await sendFromNative(rig, alpha, bravo.name, `${cancelledMarker}: discard when this active run settles as aborted.`);
    const outputOffset = bravo.output.length;
    bravo.write('\u001b');
    await eventually(() => bravo.events(), events => events.some(event =>
      event.type === 'gate' && event.name === 'compaction-failed'), 'the later failure handler delays aborted-run settlement');
    const failed = bravo.events().findLast(event => event.type === 'session_compact_failed');
    assert.equal(failed.aborted, true);
    assert.equal(failed.idle, false, 'The active run still owns its slot until cancellation settles');

    // An active cancellation intentionally prevents control delivery. Holding
    // its completion beyond the bounded wake retries must preserve reception.
    await delay(4000);
    const stoppedBeforeSettlement = bravo.output.slice(outputOffset).includes('Arlo cannot schedule received input');
    bravo.gate('compaction-failed', 'release');
    assert.equal(stoppedBeforeSettlement, false, 'Waiting for cancellation completion cannot suspend the receiver');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'agent_settled' && event.aborted),
      'the interrupted native run reaches its cancellation boundary');
    await eventually(() => bravo.output.slice(outputOffset), output => output.includes('Arlo cancelled 1 pending message'),
      'the original pending input is discarded at settlement');

    rig.handlers.set('bravo', modelText('The receiver remains available after the delayed cancellation.'));
    const freshMarker = 'PI_FRESH_AFTER_DELAYED_AUTOMATIC_COMPACTION_FAILURE';
    await sendFromNative(rig, alpha, bravo.name, `${freshMarker}: process after the cancelled operation.`);
    await eventually(() => rig.requests, requests => requests.some(request =>
      request.peer === 'bravo' && inbound(request.body, freshMarker)), 'fresh reception remains available');
    await eventually(() => bravo.events(), events => events.filter(event => event.type === 'agent_settled').length === 2,
      'the fresh input finishes processing');
    assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, cancelledMarker)), false);
    assert.deepEqual(rig.errors, []);
  });

test('native Escape during a delayed successful manual compaction completion discards pending input and permits fresh reception',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('manual-compact-success-interrupt');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo', {
      compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1 },
    });
    await bravo.ready();
    const settledCount = () => bravo.events().filter(event => event.type === 'agent_settled').length;
    await bravo.submit('Create a complete native turn before interrupting a successful compaction callback.');
    await eventually(settledCount, count => count === 1, 'the seed turn settles');

    let compactRequest;
    rig.handlers.set('bravo', request => { compactRequest = request; });
    bravo.gate('compaction-complete', 'hold');
    await bravo.submit('/compact');
    await eventually(() => ({ events: bravo.events(), compactRequest }), value => value.compactRequest &&
      value.events.some(event => event.type === 'session_before_compact' && event.reason === 'manual'),
    'manual compaction reaches its actual model request');
    const cancelledMarker = 'PI_CANCELLED_DURING_SUCCESSFUL_MANUAL_COMPACTION_HANDLER';
    await sendFromNative(rig, alpha, bravo.name, `${cancelledMarker}: discard at the requested native interruption boundary.`);
    rig.handlers.set('bravo', modelText('The new input was received after the previous operation was interrupted.'));
    modelText('The seed conversation is now summarized.')(compactRequest);
    await eventually(() => bravo.events(), events => events.some(event =>
      event.type === 'gate' && event.name === 'compaction-complete'), 'the successful completion handler is still pending');

    const beforeInterrupt = bravo.events().length;
    const outputOffset = bravo.output.length;
    bravo.write('\u001b');
    await eventually(() => bravo.events().slice(beforeInterrupt), events => events.some(event =>
      event.type === 'terminal_escape' && event.idle === false), 'native Escape interrupts the still-busy manual operation');
    bravo.gate('compaction-complete', 'release');
    await eventually(() => bravo.events(), events => events.some(event =>
      event.type === 'session_compact_handler_complete'), 'the successful completion callback returns');
    await eventually(() => bravo.output.slice(outputOffset), output => output.includes('Arlo cancelled 1 pending message'),
      'the matching completed operation reconciles the explicit interruption', 8_000);
    assert.equal(settledCount(), 1, 'Standalone successful compaction has no new agent_settled event');
    assert.equal(bravo.events().some(event => event.type === 'session_compact_failed'), false,
      'Pi does not emit a failed event when Escape arrives after its successful-compaction notification');

    const freshMarker = 'PI_FRESH_AFTER_INTERRUPT_DURING_SUCCESSFUL_COMPACTION_HANDLER';
    await sendFromNative(rig, alpha, bravo.name, `${freshMarker}: process this later input.`);
    await eventually(() => rig.requests, requests => requests.some(request =>
      request.peer === 'bravo' && inbound(request.body, freshMarker)), 'fresh input reaches the receiver after interruption');
    await eventually(settledCount, count => count === 2, 'fresh input processing settles');
    assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, cancelledMarker)), false);
    assert.deepEqual(rig.errors, []);
  });
