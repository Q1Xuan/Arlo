import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventually, inbound, lastTool, modelText, modelTool, nativeScenario, sendFromNative, sendingCommand } from './harness.mjs';

function lastToolText(body) {
  const message = body.messages.findLast(item => item.role === 'tool');
  assert.ok(message, 'Expected an actual model tool result');
  return typeof message.content === 'string' ? message.content
    : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}

function listedEndpoint(peer, name = 'bravo') {
  const listing = peer.events().findLast(event => event.type === 'tool_execution_end' && event.toolName === 'arlo_list_sessions');
  const item = JSON.parse(listing.result.content[0].text).find(candidate => candidate.display_name === name);
  assert.ok(item, `Expected discovered endpoint for ${name}`);
  return item.endpoint_id;
}

for (const change of ['new', 'resume', 'fork']) {
test(`native Pi ${change} replaces the endpoint and communicates from the new root without consuming old input`,
  { timeout: 150_000 }, async t => {
    const rig = await nativeScenario(`root-${change}`);
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo');
    await bravo.ready();
    const originalSession = bravo.events().find(event => event.type === 'session_start').sessionId;
    let captureStep = 0;
    rig.handlers.set('bravo', request => captureStep++ === 0
      ? modelTool('acceptance_capture_caller', {})(request) : modelText()(request));
    bravo.gate('last-boundary', 'hold');
    await bravo.submit('Finish the old native root while its boundary waits.');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' && event.name === 'last-boundary'),
      'the old root holds its boundary');
    const oldMarker = 'PI_OLD_ROOT_UNCLAIMED';
    const first = await sendFromNative(rig, alpha, 'bravo', oldMarker);
    const originalEndpoint = listedEndpoint(alpha);
    const offset = bravo.output.length;
    await bravo.submit(change === 'new' ? '/new' : `/acceptance-root ${change}`);
    await eventually(() => bravo.events(), events => events.some(event =>
      event.type === (change === 'fork' ? 'session_before_fork' : 'session_before_switch')),
      `native ${change} begins teardown`);
    bravo.gate('last-boundary', 'release');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'session_start' && event.reason === change),
      `native ${change} replaces the root`);
    await eventually(() => bravo.output.slice(offset), output => output.includes('Arlo ready'), 'the new root becomes ready');
    assert.equal(bravo.output.slice(offset).includes('Arlo cancelled'), false,
      'Teardown abort during replacement is not a user cancellation');
    const latestStart = bravo.events().findLast(event => event.type === 'session_start');
    if (change === 'resume') {
      assert.equal(latestStart.sessionId, originalSession, 'Resuming the same file still replaces the native root instance');
      assert.equal(latestStart.reusedManager, true, 'Reusing the SessionManager reference still replaces the native root instance');
      assert.equal(latestStart.reusedHeader, true, 'Reusing the session header reference still replaces the native root instance');
    } else assert.notEqual(latestStart.sessionId, originalSession);
    const credits = rig.accounting.filter(record => record.proof?.message_id === first.receipt.message_id);
    assert.equal(credits.length, 1);
    assert.equal(credits[0].proof.event, 'discarded');
    assert.equal(credits[0].status, 200);
    await bravo.submit('/acceptance-stale-caller');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'stale_caller_result'),
      'the previous model caller cannot invoke a communication tool');
    const stale = bravo.events().findLast(event => event.type === 'stale_caller_result');
    assert.match(stale.error ?? JSON.stringify(stale.result), /stale|CALLER_NOT_ROOT|CHANNEL_NOT_READY/);

    if (change !== 'new') {
      const requests = rig.requests.filter(request => request.peer === bravo.name).length;
      const paused = await sendingCommand(bravo, '/arlo-send-status');
      assert.match(paused, /Usage: unknown\n/);
      assert.match(paused, /Pause reason: ALLOWANCE_UNKNOWN\n/);
      const continued = await sendingCommand(bravo, '/arlo-continue');
      assert.match(continued, /Usage: known\nGranted: 20\nUsed: 0\nRemaining: 20\n/);
      assert.equal(rig.requests.filter(request => request.peer === bravo.name).length, requests,
        'Only the real current human command continues the replacement root before its scripted reply');
    }

    const freshMarker = 'PI_NEW_ROOT_ROUNDTRIP';
    const replyMarker = 'PI_NEW_ROOT_REPLY';
    let reply, destination, step = 0, receiverStep = 0;
    rig.handlers.set('bravo', request => {
      if (receiverStep++ === 0) {
        const source = inbound(request.body, freshMarker);
        assert.ok(source);
        return modelTool('arlo_send_message', { to: source.from_endpoint, reply_to: source.message_id, text: replyMarker })(request);
      }
      if (receiverStep === 2) {
        reply = lastTool(request.body);
        assert.equal(reply.status, 'accepted');
        return modelTool('arlo_get_message_status', { message_id: reply.message_id })(request);
      }
      assert.equal(lastTool(request.body).status, 'accepted');
      return modelText('The new root received and replied.')(request);
    });
    // The controlled model sees the actual native tool result, including a
    // send failure against the retired endpoint and the original acceptance.
    rig.handlers.set('alpha', request => {
      if (inbound(request.body, replyMarker)) return modelText('The new root replied.')(request);
      if (step++ === 0) return modelTool('arlo_list_sessions', {})(request);
      if (step === 2) {
        const peers = lastTool(request.body);
        assert.equal(peers.length, 1);
        destination = peers[0].endpoint_id;
        assert.notEqual(destination, originalEndpoint);
        return modelTool('arlo_send_message', { to: originalEndpoint, text: 'PI_RETIRED_TARGET' })(request);
      }
      if (step === 3) {
        assert.match(lastToolText(request.body), /TARGET_UNAVAILABLE/);
        return modelTool('arlo_get_message_status', { message_id: first.receipt.message_id })(request);
      }
      if (step === 4) {
        assert.equal(lastTool(request.body).status, 'accepted');
        return modelTool('arlo_send_message', { to: destination, text: freshMarker })(request);
      }
      if (step === 5) {
        assert.equal(lastTool(request.body).status, 'accepted');
        return modelText('The new root accepted fresh input.')(request);
      }
      return modelText()(request);
    });
    await alpha.submit('Check the old exact endpoint and original result, then send to the replacement root.');
    await eventually(() => rig.requests, requests => requests.some(request => request.peer === 'alpha' &&
      inbound(request.body, replyMarker)), 'new-root reply reaches the existing sender', 40_000);
    const observed = rig.requests.find(request => request.peer === 'alpha' && inbound(request.body, replyMarker));
    assert.equal(inbound(observed.body, replyMarker).from_endpoint, destination);
    assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, oldMarker)), false);
    assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, 'PI_RETIRED_TARGET')), false);
    assert.deepEqual(rig.errors, []);
  });
}

test('a cancelled native switch keeps its endpoint usable and an invalid fork reports the native fatal failure',
  { timeout: 150_000 }, async t => {
    const rig = await nativeScenario('root-failed-switch');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo');
    await bravo.ready();
    await sendFromNative(rig, alpha, 'bravo', 'PI_BEFORE_FAILED_SWITCH');
    const originalEndpoint = listedEndpoint(alpha);
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'agent_settled'),
      'the initial message is processed');
    await bravo.submit('/acceptance-root cancel');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'switch_cancelled' && event.cancelled),
      'another extension cancels the native replacement');
    const receivedRuns = bravo.events().filter(event => event.type === 'agent_settled').length;
    await sendFromNative(rig, alpha, 'bravo', 'PI_AFTER_FAILED_SWITCH');
    assert.equal(listedEndpoint(alpha), originalEndpoint);
    await eventually(() => rig.requests, requests => requests.some(request => request.peer === 'bravo' &&
      inbound(request.body, 'PI_AFTER_FAILED_SWITCH')), 'the same native root processes fresh reception');
    await eventually(() => bravo.events(), events => events.filter(event => event.type === 'agent_settled').length > receivedRuns,
      'the fresh native run finishes');
    await bravo.submit('/acceptance-root invalid-fork');
    await eventually(() => bravo.exit, Boolean, 'Pi reports a failed fork and exits its unusable runtime');
    assert.ok(bravo.output.includes('Invalid entry ID for forking'));
    assert.equal(bravo.exit.exitCode, 1, 'Pi 1.1.0 treats this command failure as fatal, without a shutdown callback');
    assert.equal(bravo.events().filter(event => event.type === 'session_start').length, 1);
    assert.deepEqual(rig.errors, []);
  });

for (const proof of ['delayed', 'failed']) {
test(`normal native Pi exit drains original discard evidence when accounting is ${proof}`,
  { timeout: 150_000 }, async t => {
    const rig = await nativeScenario(`root-exit-${proof}`, { idleTimeoutMs: 15_000 });
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo');
    await bravo.ready();
    bravo.gate('last-boundary', 'hold');
    await bravo.submit('Finish the outgoing native run with its boundary still waiting.');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' && event.name === 'last-boundary'),
      'the old root holds its boundary');
    const marker = 'PI_DISCARDED_ON_NORMAL_EXIT';
    const first = await sendFromNative(rig, alpha, 'bravo', marker);
    rig.creditGate.mode = proof === 'delayed' ? 'hold' : 'fail';
    const exit = bravo.quit();
    if (proof === 'delayed') {
      await eventually(() => rig.creditGate.held.length, count => count === 1, 'original-authority discard accounting is held');
      assert.equal(bravo.exit, undefined, 'The root cannot revoke before its issued proof finishes');
      assert.equal(rig.accounting.some(record => record.path.endsWith('/revoke')), false);
      rig.releaseCredit();
    }
    await exit;
    const credits = rig.accounting.filter(record => record.proof?.message_id === first.receipt.message_id);
    assert.equal(credits.length, 1, 'Final teardown never duplicates credit evidence');
    assert.equal(credits[0].proof.event, 'discarded');
    assert.equal(credits[0].status, proof === 'delayed' ? 200 : 503);
    const creditIndex = rig.accounting.indexOf(credits[0]);
    assert.ok(rig.accounting.slice(creditIndex + 1).some(record => record.path.endsWith('/revoke') && record.status === 200));
    assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, marker)), false);
    let step = 0, status;
    rig.handlers.set('alpha', request => {
      if (step++ === 0) return modelTool('arlo_get_message_status', { message_id: first.receipt.message_id })(request);
      status = lastTool(request.body);
      return modelText()(request);
    });
    await alpha.submit('Query my original accepted result after the receiver exited.');
    await eventually(() => status, Boolean, 'the sender queries its original result');
    assert.equal(status.status, 'accepted');
    await alpha.quit();
    if (proof === 'delayed') {
      await eventually(() => rig.idleStopped, Boolean, 'confirmed final credit permits the real Daemon to stop', 20_000);
    } else {
      await new Promise(resolve => setTimeout(resolve, 16_000));
      assert.equal(rig.idleStopped, false, 'Unconfirmed final evidence must retain remote credit after all native roots exit');
    }
    assert.deepEqual(rig.errors, []);
  });
}

test('a native replacement that fails after teardown reports unavailable without registering an empty old root',
  { timeout: 150_000 }, async t => {
    const rig = await nativeScenario('root-replacement-fails');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo');
    await bravo.ready();
    await sendFromNative(rig, alpha, 'bravo', 'PI_BEFORE_REPLACEMENT_FAILURE');
    const originalEndpoint = listedEndpoint(alpha);
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'agent_settled'),
      'the initial reception is processed');
    await bravo.submit('/acceptance-root replacement-fails');
    await eventually(() => bravo.output, output => output.includes('PI_ACCEPTANCE_REPLACEMENT_FAILURE'),
      'the host reports replacement setup failure');
    let step = 0;
    rig.handlers.set('alpha', request => {
      if (step++ === 0) return modelTool('arlo_list_sessions', {})(request);
      if (step === 2) {
        assert.deepEqual(lastTool(request.body), [], 'Failed replacement cannot masquerade as a ready endpoint');
        return modelTool('arlo_send_message', { to: originalEndpoint, text: 'PI_AFTER_REPLACEMENT_FAILURE' })(request);
      }
      assert.match(lastToolText(request.body), /TARGET_UNAVAILABLE/);
      return modelText()(request);
    });
    const settled = alpha.events().filter(event => event.type === 'agent_settled').length;
    await alpha.submit('Discover the unavailable replacement and attempt the exact old endpoint.');
    await eventually(() => alpha.events(), events => events.filter(event => event.type === 'agent_settled').length > settled,
      'the existing root observes explicit communication unavailability');
    assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, 'PI_AFTER_REPLACEMENT_FAILURE')), false);
    assert.deepEqual(rig.errors, []);
  });
