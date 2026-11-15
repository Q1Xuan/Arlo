import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventually, inbound, lastTool, modelText, modelTool, nativeScenario, piVersion, sendFromNative } from './harness.mjs';

const thresholdResponse = modelText('This seed response reaches the configured compaction threshold.',
  { prompt_tokens: 7500, completion_tokens: 10, total_tokens: 7510 });

test('native Escape during successful pre-prompt automatic compaction cancels pending input and permits fresh reception',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('preprompt-compact-success-interrupt');
    let bravo;
    t.after(async () => { bravo?.gate('compaction-complete', 'release'); await rig.close(); });
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    bravo = await rig.start('bravo', {
      compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1 },
    });
    await bravo.ready();
    let first = true, compactRequest;
    rig.handlers.set('bravo', request => {
      if (first) { first = false; return thresholdResponse(request); }
      compactRequest = request;
    });

    // Cancelling the seed turn's automatic compaction leaves its large native
    // transcript in place. Pi checks it again before the next agent_start.
    await bravo.submit('Create a large native transcript for the following pre-prompt compaction.');
    await eventually(() => ({ events: bravo.events(), compactRequest }), value => value.compactRequest &&
      value.events.some(event => event.type === 'session_before_compact' && event.reason === 'threshold'),
    'the seed turn enters automatic compaction');
    bravo.write('\u001b');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'agent_settled' && event.aborted),
      'the seed compaction is cancelled while its original agent run is active');
    await eventually(() => compactRequest.closed, Boolean, 'the cancelled seed compaction releases its model connection');

    compactRequest = undefined;
    const prepromptOffset = bravo.events().length;
    bravo.gate('compaction-complete', 'hold');
    const original = 'PI_NATIVE_TASK_AFTER_PREPROMPT_COMPACTION';
    await bravo.submit(`${original}: process this ordinary native submission after preparing its context.`);
    await eventually(() => ({ events: bravo.events().slice(prepromptOffset), compactRequest }), value => value.compactRequest &&
      value.events.some(event => event.type === 'session_before_compact' && event.reason === 'threshold'),
    'the new native submission reaches actual pre-prompt automatic compaction');
    assert.equal(bravo.events().slice(prepromptOffset).some(event => event.type === 'agent_start'), false,
      'The new ordinary native run has not started yet');
    const cancelled = 'PI_CANCELLED_DURING_SUCCESSFUL_PREPROMPT_COMPACTION';
    const accepted = await sendFromNative(rig, alpha, bravo.name, `${cancelled}: discard at the explicit interruption boundary.`);
    rig.handlers.set('bravo', modelText('The original native submission or fresh input was processed.'));
    modelText('The seed transcript has been summarized for the original pending native submission.')(compactRequest);
    await eventually(() => bravo.events().slice(prepromptOffset), events => events.some(event =>
      event.type === 'gate' && event.name === 'compaction-complete'), 'the later successful compaction handler remains pending');
    assert.equal(bravo.events().findLast(event => event.type === 'session_compact').idle, false);
    assert.equal(bravo.events().slice(prepromptOffset).some(event => event.type === 'agent_start'), false);

    const interruptionOffset = bravo.events().length;
    const outputOffset = bravo.output.length;
    bravo.write('\u001b');
    await eventually(() => bravo.events().slice(interruptionOffset), events =>
      events.some(event => event.type === 'terminal_escape' && event.idle === false) &&
      events.some(event => event.type === 'compaction_signal_aborted' && event.reason === 'threshold'),
    'native Escape aborts the public signal of the still-busy pre-prompt compaction');
    bravo.gate('compaction-complete', 'release');
    await eventually(() => bravo.events().slice(prepromptOffset), events => events.some(event =>
      event.type === 'agent_settled'), 'the actual original native submission resumes and settles');
    const resumed = bravo.events().slice(prepromptOffset);
    assert.ok(resumed.some(event => event.type === 'session_compact_handler_complete'));
    assert.ok(resumed.some(event => event.type === 'agent_start'));
    // Pi 1.2 marks the run active before preparation and carries the public
    // abort request into agent_start. The baseline's old assertion is retained.
    const abortsPreparedRun = ['1.2.0', '1.3.0', '1.4.0'].includes(piVersion);
    assert.equal(resumed.findLast(event => event.type === 'agent_settled').aborted, abortsPreparedRun,
      abortsPreparedRun ? 'Pi 1.2 retains the explicit abort requested during preparation'
        : 'Pi resumes the original prompt after the successful pre-prompt handler without a run abort flag');
    assert.equal(resumed.some(event => event.type === 'session_compact_failed'), false,
      'Escape after the successful-compaction notification emits no failed completion');
    assert.equal(rig.requests.some(request => request.peer === 'bravo' && JSON.stringify(request.body).includes(original)), !abortsPreparedRun,
      'An aborted prepared run must not invoke the provider for the original prompt');

    let step = 0, retained;
    const senderSettled = alpha.events().filter(event => event.type === 'agent_settled').length;
    rig.handlers.set('alpha', request => {
      if (step++ === 0) return modelTool('arlo_get_message_status', { message_id: accepted.receipt.message_id })(request);
      retained = lastTool(request.body);
      return modelText('The earlier reception result remains accepted.')(request);
    });
    await alpha.submit('Query the reception result of my message sent during the interrupted pre-prompt operation.');
    await eventually(() => alpha.events(), events => events.filter(event => event.type === 'agent_settled').length > senderSettled,
      'the sender queries its original acceptance after the operation finishes');
    assert.equal(retained.status, 'accepted');

    const fresh = 'PI_FRESH_AFTER_SUCCESSFUL_PREPROMPT_COMPACTION_INTERRUPT';
    const later = await sendFromNative(rig, alpha, bravo.name, `${fresh}: process this newly arriving input.`);
    await eventually(() => rig.requests, requests => requests.some(request =>
      request.peer === 'bravo' && inbound(request.body, fresh)), 'fresh accepted input reaches the same native root', 8_000)
      .finally(() => t.diagnostic(`Pre-prompt interruption result: ${JSON.stringify({
        originalAcceptance: retained.status, freshAcceptance: later.status.status,
        cancellationShown: bravo.output.slice(outputOffset).includes('Arlo cancelled 1 pending message'),
        freshModelRequests: rig.requests.filter(request => request.peer === 'bravo' && inbound(request.body, fresh)).length,
      })}`));
    assert.ok(bravo.output.slice(outputOffset).includes('Arlo cancelled 1 pending message'));
    assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, cancelled)), false,
      'The interrupted operation cannot revive its discarded pending input');
    assert.deepEqual(rig.errors, []);
  });
