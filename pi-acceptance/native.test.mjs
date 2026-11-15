import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventually, inbound, lastTool, modelText, modelTool, nativeScenario, sendFromNative } from './harness.mjs';

test('two native Pi roots discover, send, reply with provenance, and query reception through actual model tools',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('roundtrip');
    t.after(() => rig.close());
    let alphaStep = 0, bravoStep = 0;
    let sent, replied, destination;
    rig.handlers.set('alpha', request => {
      if (alphaStep++ === 0) return modelTool('arlo_list_sessions', {})(request);
      if (alphaStep === 2) {
        const discovered = lastTool(request.body);
        const peers = Array.isArray(discovered) ? discovered : discovered.sessions;
        assert.equal(peers.length, 1);
        assert.equal(peers[0].display_name, 'bravo');
        destination = peers[0].endpoint_id;
        return modelTool('arlo_send_message', { to: destination, text: 'PI_NATIVE_ROUNDTRIP: please reply with its message association.' })(request);
      }
      if (alphaStep === 3) {
        sent = lastTool(request.body);
        assert.equal(sent.status, 'accepted');
        return modelTool('arlo_get_message_status', { message_id: sent.message_id })(request);
      }
      if (alphaStep === 4) assert.equal(lastTool(request.body).status, 'accepted');
      return modelText('Alpha finished this processing step.')(request);
    });
    rig.handlers.set('bravo', request => {
      if (bravoStep++ === 0) {
        const source = inbound(request.body, 'PI_NATIVE_ROUNDTRIP');
        assert.ok(source, 'The receiving model must see body and full source metadata');
        return modelTool('arlo_send_message', { to: source.from_endpoint, reply_to: source.message_id,
          text: 'PI_NATIVE_REPLY: correlated response.' })(request);
      }
      if (bravoStep === 2) {
        replied = lastTool(request.body);
        assert.equal(replied.status, 'accepted');
        return modelTool('arlo_get_message_status', { message_id: replied.message_id })(request);
      }
      assert.equal(lastTool(request.body).status, 'accepted');
      return modelText('Bravo sent its associated reply.')(request);
    });
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo');
    await bravo.ready();
    await alpha.submit('Discover the other Arlo root, send the roundtrip request, and query its reception status.');
    await eventually(() => rig.requests, requests => requests.some(request =>
      request.peer === 'alpha' && inbound(request.body, 'PI_NATIVE_REPLY')), 'native reply reaches original model', 45_000);
    await eventually(() => replied, result => result?.status === 'accepted',
      'The replying model observes its accepted native tool result');
    assert.ok(sent?.message_id && replied?.message_id);
    assert.deepEqual(rig.errors, []);
    const reply = rig.requests.find(request => request.peer === 'alpha' && inbound(request.body, 'PI_NATIVE_REPLY'));
    assert.equal(inbound(reply.body, 'PI_NATIVE_REPLY').reply_to, sent.message_id);
    assert.equal(inbound(reply.body, 'PI_NATIVE_REPLY').from_endpoint, destination);
    assert.ok(alpha.events().some(event => event.type === 'input' && event.source === 'interactive'), 'Native terminal submission enters Pi input');
    assert.ok(bravo.output.includes('PI_NATIVE_ROUNDTRIP'), 'Native receiver renders received source content');
    t.diagnostic(`Evidence: ${rig.directory}`);
  });

test('native Pi defers busy input and schedules arrivals after its last input-provider boundary',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('busy-boundary');
    t.after(() => rig.close());
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo');
    await bravo.ready();
    let held;
    rig.handlers.set('bravo', request => { held = request; });
    await bravo.submit('Keep this ordinary user task running until the controlled local model answers.');
    await eventually(() => held, Boolean, 'receiver starts its normal model operation');
    await sendFromNative(rig, alpha, 'bravo', 'PI_BUSY_MESSAGE: process after current work.');
    assert.equal(rig.requests.filter(request => request.peer === 'bravo').length, 1);
    assert.equal(held.closed, false, 'Receiving a message must not abort the current HTTP model operation');
    assert.ok(bravo.output.includes('1 pending'));
    rig.handlers.set('bravo', modelText('Receiver completed its current processing step.'));
    modelText('Original user task completed.')(held);
    await eventually(() => rig.requests, requests => requests.some(request => request.peer === 'bravo' &&
      inbound(request.body, 'PI_BUSY_MESSAGE')), 'busy input reaches a later model operation');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'agent_settled'), 'receiver finishes busy delivery');

    bravo.gate('last-boundary', 'hold');
    await bravo.submit('Finish this task and enter the final settlement boundary.');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' && event.name === 'last-boundary'),
      'last input provider has already returned');
    await sendFromNative(rig, alpha, 'bravo', 'PI_LAST_BOUNDARY: arrive after the last busy input provider.');
    bravo.gate('last-boundary', 'release');
    await eventually(() => rig.requests, requests => requests.some(request => request.peer === 'bravo' &&
      inbound(request.body, 'PI_LAST_BOUNDARY')), 'post-boundary arrival wakes the existing root');
    assert.equal(bravo.events().filter(event => event.type === 'agent_settled' && event.aborted).length, 0);
    assert.deepEqual(rig.errors, []);
    t.diagnostic(`Evidence: ${rig.directory}`);
  });

test('an ordinary native submission retains its processing slot while a public preflight hook waits',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('native-preflight');
    let bravo;
    t.after(async () => { bravo?.gate('native-preflight', 'release'); await rig.close(); });
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    bravo = await rig.start('bravo');
    await bravo.ready();
    bravo.gate('native-preflight', 'hold');
    let held;
    rig.handlers.set('bravo', request => {
      if (inbound(request.body, 'PI_PREFLIGHT_PENDING')) { held = request; return; }
      return modelText('The original native task was processed.')(request);
    });
    await bravo.submit('PI_NATIVE_PREFLIGHT_TASK: begin this ordinary task before processing subsequent messages.');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' && event.name === 'native-preflight'),
      'the real native submission waits in its public preflight hook');
    await sendFromNative(rig, alpha, 'bravo', 'PI_PREFLIGHT_PENDING: arrive while the original native task is preparing.');
    const requestsBeforeRelease = rig.requests.filter(request => request.peer === 'bravo').length;
    bravo.gate('native-preflight', 'release');
    if (requestsBeforeRelease > 0) {
      // Preserve the full native failure, including the original submission's
      // rejection while the incoming message still has an open model request.
      await eventually(() => bravo.output, output => output.includes('already processing a prompt'),
        'the resumed native prompt exposes the overlapping processing failure');
      assert.equal(held.closed, false);
      t.diagnostic('Native preflight resumed into an already-running Arlo request and reported "already processing a prompt".');
      modelText('Release the overlapping controlled request.')(held);
    }
    await eventually(() => rig.requests, requests => requests.some(request => request.peer === 'bravo' &&
      inbound(request.body, 'PI_PREFLIGHT_PENDING')), 'both native work and later reception get processing time');
    assert.equal(requestsBeforeRelease, 0,
      'An idle wake must not take over the native task that is already preparing to run');
    const first = rig.requests.find(request => request.peer === 'bravo');
    assert.ok(JSON.stringify(first.body).includes('PI_NATIVE_PREFLIGHT_TASK'));
    assert.equal(bravo.output.includes('already processing a prompt'), false);
    assert.deepEqual(rig.errors, []);
  });
