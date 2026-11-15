import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ControlClient, MAX_ROOT_PENDING_MESSAGES, MAX_ROOT_PENDING_BYTES, MAX_SINGLE_TEXT_BYTES,
  completeOrdinaryTurn, eventually, grantSdkLoadRoot, inbound, lastTool, modelText, modelTool, nativeScenario, sendFromNative } from './harness.mjs';

async function recovered(rig, endpoint, generation) {
  const records = await eventually(() => rig.readiness,
    records => records.some(record => record.status === 200 && record.proof.endpoint_id === endpoint &&
      record.proof.generation > generation), 'the original endpoint publishes a recovered generation', 40_000);
  return records.findLast(record => record.status === 200 && record.proof.endpoint_id === endpoint);
}

async function queryFromNative(rig, peer, messageId) {
  let step = 0, status;
  const settled = peer.events().filter(event => event.type === 'agent_settled').length;
  rig.handlers.set(peer.name, request => {
    if (step++ === 0) return modelTool('arlo_get_message_status', { message_id: messageId })(request);
    status = lastTool(request.body);
    return modelText('Original reception status queried after recovery.')(request);
  });
  await peer.submit('Query the original Arlo message after connection recovery.');
  await eventually(() => peer.events(),
    events => events.filter(event => event.type === 'agent_settled').length > settled,
    'the native model queries the original message');
  assert.ok(status);
  assert.deepEqual(rig.errors, []);
  return status;
}

function nativeInputs(peer, messageId, events = peer.events()) {
  return (events.findLast(event => event.type === 'native_history')?.messages ?? [])
    .filter(message => message.message_id === messageId);
}

test('native Pi retains pending inputs and UI recovers across transport drops without duplicate delivery',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('recovery-pending', { observeNativeHistory: true });
    let bravo;
    t.after(async () => {
      bravo?.gate('settled', 'release');
      await rig.close();
    });
    t.diagnostic(`Evidence: ${rig.directory}`);

    const alpha = await rig.start('alpha');
    await alpha.ready();
    bravo = await rig.start('bravo');
    await bravo.ready();

    // 1. Hold bravo in settled handler so it remains busy / idle=false
    bravo.gate('settled', 'hold');
    await bravo.submit('Wait in the settlement gate so incoming message remains pending.');
    await eventually(() => bravo.events(), events => events.some(e => e.type === 'gate' && e.name === 'settled'),
      'bravo enters settlement gate');

    // 2. Alpha sends message to Bravo while Bravo is busy
    const marker = 'PI_RECOVER_PENDING_MSG';
    const first = await sendFromNative(rig, alpha, bravo.name, `${marker}: retain across transport loss`);
    assert.equal(first.status.status, 'accepted');

    // 3. Verify bravo UI updates to show pending message
    await eventually(() => bravo.output, out => out.includes('Arlo: 1 pending'), 'bravo UI displays pending count');

    const starts = [alpha, bravo].map(peer => peer.events().filter(event => event.type === 'session_start'));
    const alphaOffset = alpha.output.length;
    // 4. Sever transport connections
    rig.dropConnections();
    const receiverReady = await recovered(rig, first.status.to_endpoint, first.status.target_generation);
    await recovered(rig, first.status.from_endpoint, 1);
    assert.deepEqual(receiverReady.proof.reconciled_pending_message_ids, [first.receipt.message_id]);
    await eventually(() => alpha.output.slice(alphaOffset), out => out.includes('Arlo connecting') && out.includes('Arlo ready'),
      'alpha UI reflects the new readiness cycle');

    // 5. Release settlement gate on bravo
    bravo.gate('settled', 'release');
    await eventually(() => bravo.events(), events => events.some(e => e.type === 'agent_settled_handler_complete'),
      'bravo settlement completes');

    // 6. Bravo wakes up, claims the message, and processes it exactly once
    const receivedRequests = await eventually(
      () => rig.requests.filter(r => r.peer === 'bravo' && inbound(r.body, marker)),
      reqs => reqs.length > 0,
      'bravo receives the pending input after becoming idle',
      30_000
    );
    assert.equal(receivedRequests.length, 1, 'Input must be delivered to model exactly once');
    const bound = inbound(receivedRequests[0].body, marker);
    assert.equal(bound.message_id, first.receipt.message_id);

    // 7. Wait for alpha to recover connection and return to ready before sending fresh message
    await eventually(() => alpha.output, out => {
      const connectingIdx = out.lastIndexOf('Arlo connecting');
      if (connectingIdx === -1) return false;
      return out.indexOf('Arlo ready', connectingIdx) > connectingIdx;
    }, 'alpha recovers readiness after transport drop', 40_000);

    const freshMarker = 'PI_FRESH_AFTER_DROP';
    const replyMarker = 'PI_REPLY_AFTER_DROP';
    let reply, receiverStep = 0;
    rig.handlers.set('bravo', request => {
      if (receiverStep++ === 0) {
        const source = inbound(request.body, freshMarker);
        assert.ok(source);
        return modelTool('arlo_send_message', {
          to: source.from_endpoint, reply_to: source.message_id, text: replyMarker,
        })(request);
      }
      if (receiverStep === 2) {
        reply = lastTool(request.body);
        assert.equal(reply.status, 'accepted');
        return modelTool('arlo_get_message_status', { message_id: reply.message_id })(request);
      }
      assert.equal(lastTool(request.body).status, 'accepted');
      return modelText('The recovered native root sent its associated reply.')(request);
    });
    const fresh = await sendFromNative(rig, alpha, bravo.name, `${freshMarker}: normal delivery post recovery`);
    assert.equal(fresh.status.status, 'accepted');
    const replies = await eventually(() => rig.requests,
      requests => requests.some(request => request.peer === 'alpha' && inbound(request.body, replyMarker)),
      'the recovered native root replies to the sender');
    const association = inbound(replies.find(request => request.peer === 'alpha' && inbound(request.body, replyMarker)).body, replyMarker);
    await eventually(() => reply, Boolean, 'the receiving model observes its accepted reply outcome');
    assert.equal(association.reply_to, fresh.receipt.message_id);
    assert.equal(association.from_endpoint, first.status.to_endpoint);
    assert.equal(association.message_id, reply.message_id);
    assert.equal(association.reply_depth, 1);
    assert.deepEqual(await queryFromNative(rig, alpha, first.receipt.message_id), first.status);
    assert.equal(nativeInputs(bravo, first.receipt.message_id).length, 1, 'The retained body enters native history once');
    for (const [index, peer] of [alpha, bravo].entries()) {
      assert.deepEqual(peer.events().filter(event => event.type === 'session_start'), starts[index],
        'Recovery preserves the actual native root and attachment');
    }
    assert.deepEqual(rig.errors, []);
  });

test('native Pi recovers daemon lease expiry with retained input, original status, and an associated reply',
  { timeout: 120_000 }, async t => {
    // Pi's initial local lease lasts 20 seconds. Holding its next heartbeat
    // lets the daemon expire the real subscription first, without socket faults.
    const rig = await nativeScenario('recovery-lease', { leaseDurationMs: 12_000, observeNativeHistory: true });
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo');
    await bravo.ready();
    for (const peer of [alpha, bravo]) await completeOrdinaryTurn(peer);
    rig.heartbeatGate.mode = 'hold';
    rig.connectGate.mode = 'hold';
    const starts = [alpha, bravo].map(peer => peer.events().filter(event => event.type === 'session_start'));
    const busy = Promise.withResolvers();
    rig.handlers.set('bravo', request => { busy.resolve(request); });
    await bravo.submit('Hold the local model response while the Arlo heartbeat lease expires.');
    const held = await busy.promise;
    const marker = 'PI_NATIVE_LEASE_PENDING';
    const first = await sendFromNative(rig, alpha, bravo.name, marker);
    await eventually(() => bravo.output, output => output.includes('Arlo: 1 pending'), 'native input is pending before lease expiry');
    await eventually(() => rig.heartbeatGate.held.length, count => count === 2, 'both next heartbeats are held');
    await eventually(() => rig.connectGate.held.length, count => count === 2, 'daemon expiry closes both native subscriptions');
    assert.equal(rig.readiness.filter(record => record.status === 200).length, 2,
      'Expired roots cannot publish readiness while recovery is held');
    assert.equal(nativeInputs(bravo, first.receipt.message_id).length, 0);
    rig.releaseHeartbeat();
    await eventually(() => rig.heartbeats,
      records => records.some(record => record.status === 403 && record.proof.generation === 1),
      'the daemon rejects retained heartbeat credentials after expiry');
    rig.releaseConnect();
    const receiverReady = await recovered(rig, first.status.to_endpoint, first.status.target_generation);
    await recovered(rig, first.status.from_endpoint, 1);
    assert.deepEqual(receiverReady.proof.reconciled_pending_message_ids, [first.receipt.message_id]);
    const receipts = rig.receipts.filter(record => record.status === 200 && record.proof.message_id === first.receipt.message_id);
    assert.ok(receipts.length >= 2, 'Recovery submits the retained receipt');
    assert.deepEqual(receipts.at(-1).proof, receipts[0].proof, 'Receipt replay retains the dispatch and native input identity');
    assert.deepEqual(await queryFromNative(rig, alpha, first.receipt.message_id), first.status);

    const replyMarker = 'PI_NATIVE_LEASE_REPLY';
    let receiverStep = 0, reply;
    rig.handlers.delete('alpha');
    rig.handlers.set('bravo', request => {
      if (receiverStep++ === 0) {
        const source = inbound(request.body, marker);
        assert.ok(source);
        assert.equal(source.message_id, first.receipt.message_id);
        return modelTool('arlo_send_message', { to: source.from_endpoint,
          reply_to: source.message_id, text: replyMarker })(request);
      }
      if (receiverStep === 2) {
        reply = lastTool(request.body);
        assert.equal(reply.status, 'accepted');
      }
      return modelText('The same native root replied after lease recovery.')(request);
    });
    modelText('Release the held native turn.')(held);
    const requests = await eventually(() => rig.requests,
      requests => requests.some(request => request.peer === 'alpha' && inbound(request.body, replyMarker)),
      'the model replies to the original message after lease recovery');
    const source = inbound(requests.find(request => request.peer === 'alpha' && inbound(request.body, replyMarker)).body, replyMarker);
    await eventually(() => reply, Boolean, 'the recovered model observes its accepted reply outcome');
    assert.equal(source.reply_to, first.receipt.message_id);
    assert.equal(source.from_endpoint, first.status.to_endpoint);
    assert.equal(source.message_id, reply.message_id);
    assert.equal(source.reply_depth, 1);
    const fresh = await sendFromNative(rig, alpha, bravo.name, 'PI_NATIVE_LEASE_FRESH');
    await eventually(() => nativeInputs(bravo, fresh.receipt.message_id), inputs => inputs.length === 1,
      'the same native root receives a fresh message after lease recovery');
    assert.equal(nativeInputs(bravo, first.receipt.message_id).length, 1);
    assert.equal(first.receipt.status, 'accepted');
    for (const [index, peer] of [alpha, bravo].entries()) {
      assert.deepEqual(peer.events().filter(event => event.type === 'session_start'), starts[index]);
    }
    assert.deepEqual(rig.errors, []);
  });

for (const budget of ['count', 'bytes']) test(`native Pi repeatedly reclaims the full pending ${budget} budget after recovery`,
  { timeout: 180_000 }, async t => {
    // Capacity tests keep production count/byte limits and relax only admission
    // pacing, as in the common runtime's existing capacity fixtures.
    const rate = { perMinute: 60_000, burst: 1000 };
    const rig = await nativeScenario(`recovery-${budget}`, {
      rateLimit: { sender: rate, receiver: rate }, observeNativeHistory: true,
    });
    let control, connection, runtime;
    t.after(async () => {
      connection?.dispose();
      if (runtime) await control.revokeRuntime(runtime.runtime_token).catch(() => {});
      control?.dispose();
      await rig.close();
    });
    t.diagnostic(`Evidence: ${rig.directory}`);
    const bravo = await rig.start('bravo');
    await bravo.ready();
    const originalReady = rig.readiness.find(record => record.status === 200).proof;
    const starts = bravo.events().filter(event => event.type === 'session_start');
    rig.dropConnections();
    await recovered(rig, originalReady.endpoint_id, originalReady.generation);

    // The public SDK supplies sustained load to a real native Pi receiver;
    // handoff and reclamation still run through Pi's controlled local model.
    control = new ControlClient({ stateDir: rig.stateDir });
    runtime = await control.registerRuntime({ host_type: 'pi', host_kind: 'pi', host_version: '1.1.0' });
    const binding = await control.registerRoot(runtime.runtime_token, {
      root_session_id: 'capacity-sender', group_name: rig.groupName,
      agent_incarnation: 'capacity-sender-instance', plugin_generation: 1,
    });
    connection = control.createRootConnection(binding);
    await connection.connect();
    await control.confirmRootReady(binding.root_token, { endpoint_id: binding.endpoint_id, generation: binding.generation });
    // This synthetic load sender explicitly continues with a larger bounded
    // grant so production pending capacity, rather than allowance, is tested.
    await grantSdkLoadRoot(rig, control, binding, 'capacity-sender', 1000);
    const target = originalReady.endpoint_id;
    const size = budget === 'count' ? MAX_ROOT_PENDING_MESSAGES : MAX_ROOT_PENDING_BYTES / MAX_SINGLE_TEXT_BYTES;
    const allIds = new Set();
    let totalBytes = 0;
    for (let cycle = 0; cycle < 3; cycle++) {
      const settled = bravo.events().filter(event => event.type === 'agent_settled').length;
      const busy = Promise.withResolvers();
      rig.handlers.set('bravo', request => { busy.resolve(request); });
      await bravo.submit(`Hold native input while the ${budget} budget fills in cycle ${cycle}.`);
      const held = await busy.promise;
      const sent = [];
      for (let index = 0; index < size; index++) {
        const marker = `PI_CAPACITY_${budget}_${cycle}_${index}:`;
        const text = budget === 'count' ? marker : marker + 'é'.repeat(Math.floor((MAX_SINGLE_TEXT_BYTES - marker.length) / 2)) +
          'x'.repeat((MAX_SINGLE_TEXT_BYTES - marker.length) % 2);
        if (budget === 'bytes') assert.equal(Buffer.byteLength(text, 'utf8'), MAX_SINGLE_TEXT_BYTES);
        totalBytes += Buffer.byteLength(text, 'utf8');
        const result = await connection.sendMessage({ to: target, text });
        assert.equal(result.status, 'accepted', `${budget} cycle ${cycle}, input ${index}`);
        assert.equal(allIds.has(result.message_id), false);
        allIds.add(result.message_id);
        sent.push(result);
      }
      const overflowId = randomUUID();
      await assert.rejects(connection.sendMessage({ to: target, text: `PI_CAPACITY_OVERFLOW_${budget}_${cycle}` }, overflowId),
        { code: 'QUEUE_LIMIT' });
      assert.equal(nativeInputs(bravo, overflowId).length, 0);
      assert.equal(rig.receipts.some(record => record.proof.message_id === overflowId), false,
        'Capacity refusal happens before dispatch');
      const original = await connection.getMessageStatus(sent[0].message_id);
      assert.equal(original.status, 'accepted');
      rig.creditGate.mode = 'hold';
      rig.handlers.delete('bravo');
      modelText('Claim the pending native inputs.')(held);
      await eventually(() => bravo.events(),
        events => sent.every(result => nativeInputs(bravo, result.message_id, events).length === 1),
        'Pi hands every pending body to its model once', 40_000);
      await eventually(() => rig.creditGate.held.length, count => count >= size, 'original claim proofs await daemon acknowledgement');
      await assert.rejects(connection.sendMessage({ to: target, text: `PI_CAPACITY_UNCONFIRMED_${budget}_${cycle}` }),
        { code: 'QUEUE_LIMIT' }, 'Native handoff alone cannot release unacknowledged daemon credit');
      rig.releaseCredit();
      await eventually(() => rig.accounting,
        records => sent.every(result => records.some(record => record.status === 200 && record.proof?.message_id === result.message_id)),
        'all original native claim credits are acknowledged', 40_000);
      await eventually(() => bravo.events(), events => events.filter(event => event.type === 'agent_settled').length > settled,
        'the native model finishes the capacity cycle');
      assert.deepEqual(await connection.getMessageStatus(sent[0].message_id), original,
        'Capacity release cannot change the original message reception');
      const events = bravo.events();
      for (const result of sent) {
        const proofs = rig.accounting.filter(record => record.status === 200 && record.proof?.message_id === result.message_id);
        assert.ok(proofs.every(record => record.proof.event === 'claimed'));
        assert.equal(new Set(proofs.map(record => JSON.stringify(record.proof))).size, 1,
          'Repeated credit requests preserve exactly one original claim identity');
        assert.equal(nativeInputs(bravo, result.message_id, events).length, 1);
      }
      // Filling the entire budget in the next cycle proves that all prior
      // count/byte credit was reclaimed, without querying private counters.
    }
    assert.ok(allIds.size > MAX_ROOT_PENDING_MESSAGES);
    if (budget === 'bytes') assert.equal(totalBytes, 3 * MAX_ROOT_PENDING_BYTES);
    const successor = await connection.sendMessage({ to: target, text: `PI_CAPACITY_FINAL_${budget}` });
    assert.equal(successor.status, 'accepted');
    await eventually(() => nativeInputs(bravo, successor.message_id), inputs => inputs.length === 1,
      'the native receiver remains available after all capacity cycles');
    assert.deepEqual(bravo.events().filter(event => event.type === 'session_start'), starts);
    assert.deepEqual(rig.errors, []);
  });

test('uncertain send across transport disconnect returns unknown, retains ID, and clarifies late evidence',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('recovery-uncertain', { observeNativeHistory: true });
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);

    const alpha = await rig.start('alpha');
    await alpha.ready();
    const senderReady = rig.readiness.findLast(record => record.status === 200).proof;
    const bravo = await rig.start('bravo');
    await bravo.ready();
    const receiverReady = rig.readiness.findLast(record => record.status === 200).proof;
    const alphaOffset = alpha.output.length;

    let alphaStep = 0;
    let uncertainOutcome;

    // Set receiptGate to drop connections right when bravo submits receipt
    rig.receiptGate.mode = 'drop';

    rig.handlers.set('alpha', request => {
      if (alphaStep++ === 0) {
        return modelTool('arlo_list_sessions', {})(request);
      }
      if (alphaStep === 2) {
        const peers = lastTool(request.body);
        const target = peers.find(item => item.display_name === 'bravo');
        assert.ok(target, 'Target bravo found');
        return modelTool('arlo_send_message', { to: target.endpoint_id, text: 'PI_UNCERTAIN_DELIVERY' })(request);
      }
      if (alphaStep === 3) {
        uncertainOutcome = lastTool(request.body);
        assert.equal(uncertainOutcome.status, 'unknown');
        assert.ok(uncertainOutcome.message_id);
        return modelText('Send resulted in unknown status.')(request);
      }
      return modelText('The uncertain send attempt has completed.')(request);
    });

    // Alpha initiates the uncertain send
    const settledBefore = alpha.events().filter(e => e.type === 'agent_settled').length;
    await alpha.submit('Discover bravo, send a message to it, and handle uncertain result.');
    await eventually(
      () => alpha.events(),
      events => events.filter(e => e.type === 'agent_settled').length > settledBefore,
      'alpha completes uncertain send attempt',
      40_000
    );

    assert.ok(uncertainOutcome, 'uncertain outcome captured');
    assert.equal(uncertainOutcome.status, 'unknown');

    // Allow receipts now and wait for reconnection
    rig.receiptGate.mode = 'open';

    // Wait for bravo to reconnect and submit retained receipt
    await eventually(
      () => rig.receipts,
      rec => rec.some(a => a.path.includes('/control/v1/roots/receipt') && a.status === 200),
      'bravo submits retained receipt upon reconnect',
      30_000
    );

    await recovered(rig, senderReady.endpoint_id, senderReady.generation);
    await recovered(rig, receiverReady.endpoint_id, receiverReady.generation);
    await eventually(() => alpha.output.slice(alphaOffset), output => output.includes('Arlo connecting') &&
      output.lastIndexOf('Arlo ready') > output.lastIndexOf('Arlo connecting'),
      'the sender becomes ready before querying late evidence');
    const clarifiedStatus = await queryFromNative(rig, alpha, uncertainOutcome.message_id);
    assert.equal(clarifiedStatus.status, 'accepted');
    assert.equal(clarifiedStatus.late_evidence, true);
    assert.equal(clarifiedStatus.original_status, 'unknown');
    assert.equal(uncertainOutcome.status, 'unknown', 'Original send outcome is immutable');
    const retained = rig.receipts.find(record => record.status === 200 && record.proof.message_id === uncertainOutcome.message_id).proof;
    assert.equal(clarifiedStatus.target_generation, retained.generation);
    assert.equal(clarifiedStatus.native_message_id, retained.native_message_id);
    await eventually(() => nativeInputs(bravo, uncertainOutcome.message_id), inputs => inputs.length === 1,
      'the uncertain body enters native history exactly once');
    const fresh = await sendFromNative(rig, alpha, bravo.name, 'PI_FRESH_AFTER_UNCERTAIN');
    await eventually(() => nativeInputs(bravo, fresh.receipt.message_id), inputs => inputs.length === 1,
      'the recovered uncertain binding accepts fresh native input');
    assert.equal(nativeInputs(bravo, uncertainOutcome.message_id).length, 1);
    assert.deepEqual(rig.errors, []);
  });
