import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { nativeScenario, eventually, inbound, lastTool, modelText, modelTool, sendFromNative, sendingCommand } from './harness.mjs';

async function sendingStatus(peer, command = '/arlo-send-status') {
  const text = await sendingCommand(peer, command);
  const line = label => [...text.matchAll(new RegExp(`${label}: ([^\\n]+)`, 'g'))].at(-1)?.[1].trim();
  return { text, period: line('Period'), knowledge: line('Usage'), granted: line('Granted'),
    used: line('Used'), remaining: line('Remaining'), pause: line('Pause reason') };
}

test('a pristine native Pi root automatically sends twenty attempts, pauses only sending, and resumes through the human command',
  { timeout: 180_000 }, async t => {
    const rate = { perMinute: 60000, burst: 1000 };
    const rig = await nativeScenario('initial-allowance', {
      rateLimit: { sender: rate, receiver: rate }, leaseDurationMs: 120_000,
    });
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const sender = await rig.start('initial-sender');
    await sender.ready();
    const receiver = await rig.start('initial-receiver');
    await receiver.ready();
    const file = sender.events().findLast(event => event.type === 'session_start').sessionFile;
    assert.equal(fs.existsSync(file), false, 'Native startup exposes an unsaved root without a durable conversation');
    rig.handlers.set(sender.name, modelText('The native root has a durable conversation.'));
    await sender.submit('Persist this pristine native Pi conversation.');
    await eventually(() => sender.events(), events => events.some(event => event.type === 'agent_settled'),
      'The real Pi runtime writes and settles the first conversation');
    assert.equal(fs.existsSync(file), true);
    const initial = await sendingStatus(sender);
    assert.equal(initial.knowledge, 'known', initial.text);
    assert.equal(initial.granted, '20', initial.text);
    assert.equal(initial.used, '0', initial.text);
    assert.equal(initial.remaining, '20', initial.text);
    assert.equal(initial.pause, 'none', initial.text);
    assert.notEqual(initial.period, 'unknown');
    const sent = await sendFromNative(rig, sender, receiver.name, 'PI_INITIAL_ALLOWANCE_ACTUAL_SEND');
    assert.equal(sent.receipt.status, 'accepted');
    const used = await sendingStatus(sender);
    assert.equal(used.period, initial.period);
    assert.equal(used.used, '1', used.text);
    assert.equal(used.remaining, '19', used.text);

    const readiness = rig.readiness.length;
    rig.dropConnections();
    await eventually(() => rig.readiness.slice(readiness), records => records.filter(record => record.status === 200).length >= 2,
      'Both native peers recover their real SDK connections', 40_000);
    const recovered = await sendingStatus(sender);
    assert.equal(recovered.period, initial.period, 'Normal reconnection preserves the authoritative allowance period');
    assert.equal(recovered.used, '1', recovered.text);
    assert.equal(recovered.remaining, '19', recovered.text);

    const listing = sender.events().findLast(event => event.type === 'tool_execution_end' && event.toolName === 'arlo_list_sessions');
    const target = JSON.parse(listing.result.content[0].text).find(peer => peer.display_name === receiver.name);
    assert.ok(target);
    const receipts = [sent.receipt];
    let step = 0;
    let reception;
    const settled = sender.events().filter(event => event.type === 'agent_settled').length;
    rig.handlers.set(sender.name, request => {
      if (step > 0 && step <= 19) {
        const receipt = lastTool(request.body);
        assert.equal(receipt.status, 'accepted');
        receipts.push(receipt);
      }
      if (step++ < 19) return modelTool('arlo_send_message', {
        to: target.endpoint_id, text: `PI_DEFAULT_ALLOWANCE_ATTEMPT_${step + 1}`,
      })(request);
      if (step === 20) return modelTool('arlo_send_message', {
        to: target.endpoint_id, text: 'PI_EXHAUSTED_ATTEMPT_MUST_NOT_ARRIVE',
      })(request);
      if (step === 21) {
        assert.match(JSON.stringify(request.body.messages.findLast(message => message.role === 'tool')), /ALLOWANCE_EXHAUSTED/);
        return modelTool('arlo_get_message_status', { message_id: receipts.at(-1).message_id })(request);
      }
      reception = lastTool(request.body);
      assert.equal(reception.status, 'accepted', 'Reception status queries remain usable while sending is paused');
      return modelText('Twenty actual dispatch attempts consumed the allowance.')(request);
    });
    await sender.submit('Use the remaining nineteen dispatch attempts, try once more, then query the last acceptance.');
    await eventually(() => sender.events(), events => events.filter(event => event.type === 'agent_settled').length > settled,
      'Native model consumes all twenty attempts and sees the next rejection', 40_000);
    assert.equal(receipts.length, 20);
    assert.equal(reception.status, 'accepted');
    const paused = await sendingStatus(sender);
    assert.equal(paused.period, initial.period);
    assert.equal(paused.used, '20', paused.text);
    assert.equal(paused.remaining, '0', paused.text);
    assert.equal(paused.pause, 'ALLOWANCE_EXHAUSTED', paused.text);

    const localSettled = sender.events().filter(event => event.type === 'agent_settled').length;
    rig.handlers.set(sender.name, modelText('Local work continues with sending paused.'));
    await eventually(() => sender.events().findLast(event => event.type === 'draft'),
      event => event?.text === '', 'Local work begins from the empty native editor');
    await sender.submit('Do local work and mention /arlo-continue as ordinary conversation text.');
    await eventually(() => sender.events(), events => events.filter(event => event.type === 'agent_settled').length > localSettled,
      'Sending pause leaves ordinary native local work available');
    assert.ok(sender.events().some(event => event.type === 'message_end' && event.message?.role === 'assistant' &&
      event.message.content?.some(part => part.type === 'text' && part.text === 'Local work continues with sending paused.')));
    const ordinary = await sendingStatus(sender);
    assert.equal(ordinary.period, initial.period, 'Ordinary chat does not open an allowance period');
    assert.equal(ordinary.remaining, '0');

    const marker = 'PI_INCOMING_WHILE_SENDING_PAUSED';
    const received = await sendFromNative(rig, receiver, sender.name, marker);
    await eventually(() => rig.requests, requests => requests.some(request => request.peer === sender.name && inbound(request.body, marker)),
      'The paused sender processes incoming messages through real Pi active reception');
    await eventually(() => rig.accounting, records => records.some(record =>
      record.proof?.message_id === received.receipt.message_id && record.proof.event === 'claimed' && record.status === 200),
      'Incoming model claim settles pending credit while sending is paused');
    await eventually(() => rig.accounting, records => receipts.every(receipt => records.some(record =>
      record.proof?.message_id === receipt.message_id && record.proof.event === 'claimed' && record.status === 200)),
      'All accepted dispatches settle through public credit accounting');
    assert.equal(rig.requests.some(request => request.peer === receiver.name && inbound(request.body, 'PI_EXHAUSTED_ATTEMPT_MUST_NOT_ARRIVE')), false);
    const afterReception = await sendingStatus(sender);
    assert.equal(afterReception.period, initial.period, 'Inbound input does not continue collaboration');
    assert.equal(afterReception.remaining, '0');

    const requests = rig.requests.filter(request => request.peer === sender.name).length;
    const renewed = await sendingStatus(sender, '/arlo-continue');
    assert.equal(rig.requests.filter(request => request.peer === sender.name).length, requests,
      'The trusted human continuation command never invokes the model');
    assert.notEqual(renewed.period, initial.period);
    assert.equal(renewed.granted, '20');
    assert.equal(renewed.used, '0');
    assert.equal(renewed.remaining, '20');
    await sendFromNative(rig, sender, receiver.name, 'PI_ACTUAL_SEND_AFTER_HUMAN_CONTINUATION');
    const resumed = await sendingStatus(sender);
    assert.equal(resumed.period, renewed.period);
    assert.equal(resumed.used, '1');
    assert.equal(resumed.remaining, '19');
    assert.deepEqual(rig.errors, []);
  });

async function nativeTurn(rig, peer, prompt) {
  rig.handlers.set(peer.name, modelText('The current native root completed local work.'));
  const settled = peer.events().filter(event => event.type === 'agent_settled_handler_complete').length;
  await eventually(() => peer.events().findLast(event => event.type === 'draft'),
    event => event?.text === '', `${peer.name} native editor is ready for local work`);
  await peer.submit(prompt);
  await eventually(() => peer.events(), events => events.filter(event => event.type === 'agent_settled_handler_complete').length > settled,
    `${peer.name} native local conversation settles`);
}

async function changeRoot(rig, peer, command, reason) {
  const starts = peer.events().filter(event => event.type === 'session_start').length;
  const readiness = rig.readiness.length;
  await eventually(() => peer.events().findLast(event => event.type === 'draft'),
    event => event?.text === '', `${peer.name} native editor is ready for lifecycle command`);
  await peer.submit(command);
  await eventually(() => peer.events(), events => events.filter(event => event.type === 'session_start').length > starts &&
    events.findLast(event => event.type === 'session_start').reason === reason,
    `${peer.name} completes the real public ${reason} lifecycle`);
  await eventually(() => rig.readiness.slice(readiness), records => records.some(record => record.status === 200),
    `${peer.name} replacement confirms SDK/Daemon readiness`);
  const index = peer.events().findLastIndex(event => event.type === 'session_start');
  await eventually(() => peer.events().slice(index), events => events.some(event => event.type === 'draft' && event.text === ''),
    `${peer.name} replacement exposes its empty public editor`);
  return peer.events().findLast(event => event.type === 'session_start');
}

test('native Pi reload preserves usage, fork and genuine resume never regrant, and public new obtains its own first allowance',
  { timeout: 180_000 }, async t => {
    const rig = await nativeScenario('initial-lifecycle', { leaseDurationMs: 120_000 });
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const sender = await rig.start('lifecycle-sender');
    await sender.ready();
    const receiver = await rig.start('lifecycle-receiver');
    await receiver.ready();
    await nativeTurn(rig, sender, 'Persist the first public native root.');
    const initial = await sendingStatus(sender);
    assert.equal(initial.remaining, '20', initial.text);
    const original = sender.events().findLast(event => event.type === 'session_start');
    await sendFromNative(rig, sender, receiver.name, 'PI_INITIAL_ROOT_BEFORE_RELOAD');
    const used = await sendingStatus(sender);
    assert.equal(used.used, '1');

    const reload = await changeRoot(rig, sender, '/reload', 'reload');
    assert.equal(reload.sessionFile, original.sessionFile);
    await nativeTurn(rig, sender, 'Continue local work after native extension reload.');
    const reloaded = await sendingStatus(sender);
    assert.equal(reloaded.period, initial.period);
    assert.equal(reloaded.used, '1');
    assert.equal(reloaded.remaining, '19');

    const fork = await changeRoot(rig, sender, '/acceptance-root fork', 'fork');
    assert.notEqual(fork.sessionId, original.sessionId);
    assert.notEqual(fork.sessionFile, original.sessionFile);
    await nativeTurn(rig, sender, 'Local work in the public native fork does not authorize another initial grant.');
    const forked = await sendingStatus(sender);
    assert.equal(forked.knowledge, 'unknown', forked.text);
    assert.equal(forked.pause, 'ALLOWANCE_UNKNOWN', forked.text);
    assert.match(forked.text, /FIRST_USE_UNPROVEN/);

    const resumed = await changeRoot(rig, sender, '/acceptance-root resume-original', 'resume');
    assert.equal(resumed.sessionFile, original.sessionFile);
    assert.equal(resumed.sessionId, original.sessionId);
    assert.equal(resumed.reusedManager, false, 'The public switchSession opens a fresh native manager without interception');
    await nativeTurn(rig, sender, 'Ordinary local work after genuine resume cannot recover lost usage automatically.');
    const reopened = await sendingStatus(sender);
    assert.equal(reopened.knowledge, 'unknown', reopened.text);
    assert.equal(reopened.pause, 'ALLOWANCE_UNKNOWN', reopened.text);
    assert.match(reopened.text, /INITIAL_ALLOWANCE_CONSUMED/);
    const continued = await sendingStatus(sender, '/arlo-continue');
    assert.equal(continued.remaining, '20');
    await sendFromNative(rig, sender, receiver.name, 'PI_REAL_RESUME_AFTER_HUMAN_CONTINUATION');

    const fresh = await changeRoot(rig, sender, '/new', 'new');
    assert.notEqual(fresh.sessionId, original.sessionId);
    assert.equal(fs.existsSync(fresh.sessionFile), false, 'Public new allocates another genuinely unsaved native root');
    await nativeTurn(rig, sender, 'Persist the fresh root created by the actual native new command.');
    const newStatus = await sendingStatus(sender);
    assert.equal(newStatus.knowledge, 'known', newStatus.text);
    assert.equal(newStatus.remaining, '20', newStatus.text);
    assert.notEqual(newStatus.period, initial.period);
    assert.notEqual(newStatus.period, continued.period);
    await sendFromNative(rig, sender, receiver.name, 'PI_PUBLIC_NEW_FIRST_ALLOWANCE_ACTUAL_SEND');
    const newlyUsed = await sendingStatus(sender);
    assert.equal(newlyUsed.period, newStatus.period);
    assert.equal(newlyUsed.used, '1');
    assert.equal(newlyUsed.remaining, '19');
    assert.deepEqual(rig.errors, []);
  });

test('a fresh native Pi receiver can spend its first allowance on the first real reply after inbound assistant materialization',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('initial-reception', { leaseDurationMs: 120_000 });
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const sender = await rig.start('reception-sender');
    await sender.ready();
    const receiver = await rig.start('reception-receiver');
    await receiver.ready();
    await nativeTurn(rig, sender, 'Persist the sender before contacting the untouched native receiver.');
    const receiverFile = receiver.events().findLast(event => event.type === 'session_start').sessionFile;
    assert.equal(fs.existsSync(receiverFile), false, 'The receiving native root has no prior ordinary conversation');
    const marker = 'PI_FIRST_RECEPTION_REQUEST';
    const replyMarker = 'PI_FIRST_RECEPTION_ACTUAL_REPLY';
    let senderStep = 0, receiverStep = 0, sent, reply;
    rig.handlers.set(sender.name, request => {
      if (inbound(request.body, replyMarker)) return modelText('The first real reply reached the original sender.')(request);
      if (senderStep++ === 0) return modelTool('arlo_list_sessions', {})(request);
      if (senderStep === 2) {
        const target = lastTool(request.body).find(peer => peer.display_name === receiver.name);
        assert.ok(target);
        return modelTool('arlo_send_message', { to: target.endpoint_id, text: marker })(request);
      }
      sent = lastTool(request.body);
      assert.equal(sent.status, 'accepted');
      return modelText('The untouched native receiver accepted the request.')(request);
    });
    rig.handlers.set(receiver.name, request => {
      if (receiverStep++ === 0) {
        const source = inbound(request.body, marker);
        assert.ok(source);
        assert.equal(fs.existsSync(receiverFile), false,
          'The first inbound provider request occurs before custom input becomes a durable conversation');
        return modelTool('arlo_send_message', {
          to: source.from_endpoint, reply_to: source.message_id, text: replyMarker,
        })(request);
      }
      const result = request.body.messages.findLast(message => message.role === 'tool');
      assert.ok(result);
      const text = typeof result.content === 'string' ? result.content
        : result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      reply = text.startsWith('{') ? JSON.parse(text) : { error: text };
      return modelText('The first native reply attempt completed.')(request);
    });
    await sender.submit('Discover the fresh receiver and send a request that calls for an immediate reply.');
    await eventually(() => receiver.events(), events => events.some(event => event.type === 'agent_settled_handler_complete'),
      'The fresh native receiver finishes its first inbound turn', 40_000);
    assert.ok(sent);
    assert.equal(fs.existsSync(receiverFile), true, 'Pi persists the real assistant tool call before tool execution');
    assert.equal(reply?.status, 'accepted', JSON.stringify(reply));
    await eventually(() => rig.requests, requests => requests.some(request =>
      request.peer === sender.name && inbound(request.body, replyMarker)), 'The immediate actual reply reaches the original sender');
    const status = await sendingStatus(receiver);
    assert.equal(status.knowledge, 'known', status.text);
    assert.equal(status.granted, '20', status.text);
    assert.equal(status.used, '1', status.text);
    assert.equal(status.remaining, '19', status.text);

    const plainReceiver = await rig.start('reception-plain');
    await plainReceiver.ready();
    const plainFile = plainReceiver.events().findLast(event => event.type === 'session_start').sessionFile;
    assert.equal(fs.existsSync(plainFile), false);
    const plainMarker = 'PI_FIRST_PLAIN_RECEPTION_REQUEST';
    rig.handlers.set(plainReceiver.name, request => {
      assert.ok(inbound(request.body, plainMarker));
      assert.equal(fs.existsSync(plainFile), false, 'A plain first inbound turn is also unsaved at its only provider request');
      return modelText('The fresh native receiver completed its first inbound turn without a tool call.')(request);
    });
    await eventually(() => sender.events().findLast(event => event.type === 'draft'),
      event => event?.text === '', 'The original sender editor is ready for the second untouched recipient');
    await sendFromNative(rig, sender, plainReceiver.name, plainMarker);
    await eventually(() => plainReceiver.events(), events => events.some(event => event.type === 'agent_settled_handler_complete'),
      'The plain first inbound assistant response materializes and settles', 40_000);
    assert.equal(fs.existsSync(plainFile), true);
    const plainStatus = await sendingStatus(plainReceiver);
    assert.equal(plainStatus.knowledge, 'known', plainStatus.text);
    assert.equal(plainStatus.granted, '20', plainStatus.text);
    assert.equal(plainStatus.used, '0', plainStatus.text);
    assert.equal(plainStatus.remaining, '20', plainStatus.text);
    assert.deepEqual(rig.errors, []);
  });
