import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventually, inbound, lastTool, modelText, modelTool, nativeScenario, sendFromNative } from './harness.mjs';

const largeContextResponse = modelText('This complete turn crosses the configured context threshold.',
  { prompt_tokens: 7500, completion_tokens: 10, total_tokens: 7510 });

async function queryAcceptedFromNative(rig, sender, messageId) {
  let status;
  let step = 0;
  const settled = sender.events().filter(event => event.type === 'agent_settled').length;
  rig.handlers.set(sender.name, request => {
    if (step++ === 0) return modelTool('arlo_get_message_status', { message_id: messageId })(request);
    status = lastTool(request.body);
    return modelText('The original reception result remains available.')(request);
  });
  await sender.submit(`Query the reception status of my previously sent message ${messageId}.`);
  await eventually(() => sender.events(), events => events.filter(event => event.type === 'agent_settled').length > settled,
    'sender queries the original accepted result after cancellation');
  assert.equal(status?.status, 'accepted', 'Discarding pending input must not rewrite its original acceptance');
  assert.deepEqual(rig.errors, []);
}

for (const stage of ['retry', 'settle', 'manual-compaction', 'automatic-compaction']) {
  test(`native Pi interruption cancels pending reception during ${stage} and accepts later input`,
    { timeout: 180_000 }, async t => {
      const rig = await nativeScenario(`cancel-${stage}`);
      t.after(() => rig.close());
      t.diagnostic(`Evidence: ${rig.directory}`);
      let responseMode = 'reply';
      let heldRequest;
      const cancelledMarkers = [];
      rig.handlers.set('bravo', request => {
        if (responseMode === 'retry') {
          request.response.writeHead(503, { 'content-type': 'application/json' });
          request.response.end(JSON.stringify({ error: { message: 'Service overloaded', type: 'server_error' } }));
          return;
        }
        if (responseMode === 'large-context') {
          responseMode = 'hold';
          return largeContextResponse(request);
        }
        if (responseMode === 'hold') { heldRequest = request; return; }
        return modelText('The receiving root completed its current input.')(request);
      });
      const alpha = await rig.start('alpha');
      await alpha.ready();
      const bravo = await rig.start('bravo', {
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 30_000, provider: { maxRetries: 0 } },
        compaction: { enabled: stage.includes('compaction'), reserveTokens: 2048, keepRecentTokens: 1 },
      });
      await bravo.ready();
      const settledCount = () => bravo.events().filter(event => event.type === 'agent_settled').length;
      const assertCancelledBodiesAbsent = () => {
        for (const marker of cancelledMarkers) {
          assert.equal(rig.requests.some(request => request.peer === 'bravo' && JSON.stringify(request.body).includes(marker)), false,
            `Pending input ${marker} must not reach a model after its cancellation`);
        }
      };
      const interrupt = async (phase, releaseGate = false, pendingCount = 1) => {
        const eventOffset = bravo.events().length;
        const outputOffset = bravo.output.length;
        const settledBefore = settledCount();
        const compacting = phase.includes('compaction');
        responseMode = 'reply';
        bravo.write('\u001b');
        await eventually(() => bravo.events().slice(eventOffset), events => events.some(event =>
          event.type === 'terminal_escape' && event.idle === false), `${phase} receives native Escape while busy`);
        if (releaseGate) bravo.gate('last-boundary', 'release');
        await eventually(() => bravo.events().slice(eventOffset), events => events.some(event =>
          event.type === (compacting ? 'session_compact_failed' : 'agent_settled') && event.aborted === true),
        `${phase} reports actual interruption completion`);
        if (phase === 'retry' || phase === 'settle' || phase === 'automatic-compaction') {
          await eventually(() => bravo.events().slice(eventOffset), events => events.some(event =>
            event.type === 'agent_settled' && event.aborted === true), `${phase} settles the whole run as aborted`);
        }
        if (phase === 'manual-compaction') {
          assert.equal(settledCount(), settledBefore, 'Standalone compaction completes without a new agent_settled event');
        }
        if (heldRequest) await eventually(() => heldRequest.closed, Boolean, `${phase} releases its actual model connection`);
        await eventually(() => bravo.output.slice(outputOffset), output => output.includes(`Arlo cancelled ${pendingCount} pending message`),
          `${phase} displays the pending-input cancellation`);
        assertCancelledBodiesAbsent();
        return { eventOffset, settledBefore };
      };

      if (stage === 'manual-compaction') {
        await bravo.submit('Create a complete turn for the upcoming manual compaction.');
        await eventually(settledCount, count => count === 1, 'seed turn settles before manual compaction');
        responseMode = 'hold';
        await bravo.submit('/compact');
        await eventually(() => ({ events: bravo.events(), heldRequest }), value => value.heldRequest &&
          value.events.some(event => event.type === 'session_before_compact' && event.reason === 'manual'),
        'native manual compaction reaches its actual model request');
      } else {
        if (stage === 'retry') responseMode = 'retry';
        if (stage === 'automatic-compaction') responseMode = 'large-context';
        if (stage === 'settle') bravo.gate('last-boundary', 'hold');
        await bravo.submit(`Begin the native ${stage} operation before a Arlo message arrives.`);
        if (stage === 'retry') {
          await eventually(() => bravo.output, output => output.includes('Retrying (1/2)'),
            'native UI enters retry backoff');
          assert.ok(bravo.events().some(event => event.type === 'message_end' && event.message.stopReason === 'error'));
        } else if (stage === 'settle') {
          await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' && event.name === 'last-boundary'),
            'native run pauses after its last receiving boundary');
        } else {
          await eventually(() => ({ events: bravo.events(), heldRequest }), value => value.heldRequest &&
            value.events.some(event => event.type === 'session_before_compact' && event.reason === 'threshold'),
          'automatic compaction reaches its actual model request');
        }
      }

      const marker = `PI_CANCELLED_${stage.toUpperCase().replaceAll('-', '_')}`;
      const first = await sendFromNative(rig, alpha, bravo.name, `${marker}: pending at the interruption boundary.`);
      cancelledMarkers.push(marker);
      assertCancelledBodiesAbsent();
      await interrupt(stage, stage === 'settle');
      await queryAcceptedFromNative(rig, alpha, first.receipt.message_id);

      if (stage === 'automatic-compaction') {
        // The cancelled threshold compaction leaves the large prior turn in
        // history. The next native submit compacts before agent_start; Pi may
        // continue that submitted prompt after cancelling only its preflight.
        const eventOffset = bravo.events().length;
        heldRequest = undefined;
        responseMode = 'hold';
        await bravo.submit('Continue from the large transcript after the earlier operation was interrupted.');
        await eventually(() => ({ events: bravo.events().slice(eventOffset), heldRequest }), value => value.heldRequest &&
          value.events.some(event => event.type === 'session_before_compact' && event.reason === 'threshold'),
        'pre-prompt compaction reaches its actual model request');
        assert.equal(bravo.events().slice(eventOffset).some(event => event.type === 'agent_start'), false,
          'Pre-prompt compaction precedes the new agent run');
        const preflightMarker = 'PI_CANCELLED_PREPROMPT_COMPACTION';
        const preflight = await sendFromNative(rig, alpha, bravo.name, `${preflightMarker}: pending during native preflight.`);
        cancelledMarkers.push(preflightMarker);
        // Pi coalesces consecutive identical status notifications. A second
        // pending input makes this cancellation's rendered count observable.
        const secondMarker = 'PI_CANCELLED_SECOND_PREPROMPT_COMPACTION';
        const second = await sendFromNative(rig, alpha, bravo.name, `${secondMarker}: also pending during native preflight.`);
        cancelledMarkers.push(secondMarker);
        const cancelled = await interrupt('preprompt-compaction', false, 2);
        await eventually(settledCount, count => count > cancelled.settledBefore,
          'the original native submit finishes after its cancelled preflight');
        assertCancelledBodiesAbsent();
        await queryAcceptedFromNative(rig, alpha, preflight.receipt.message_id);
        await queryAcceptedFromNative(rig, alpha, second.receipt.message_id);
      }

      const afterCancelSettled = settledCount();
      const freshMarker = `PI_FRESH_AFTER_${stage.toUpperCase().replaceAll('-', '_')}`;
      await sendFromNative(rig, alpha, bravo.name, `${freshMarker}: process this newly arriving message.`);
      await eventually(() => rig.requests, requests => requests.some(request =>
        request.peer === 'bravo' && inbound(request.body, freshMarker)), 'new input reaches the receiving model after cancellation');
      await eventually(settledCount, count => count > afterCancelSettled, 'new input processing settles');
      assertCancelledBodiesAbsent();
      assert.equal(bravo.events().filter(event => event.type === 'agent_settled').at(-1).aborted, false);
      assert.deepEqual(rig.errors, []);
    });
}
