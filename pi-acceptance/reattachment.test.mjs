import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { completeOrdinaryTurn, eventually, inbound, lastTool, modelText, modelTool, nativeScenario, piVersion, sendFromNative } from './harness.mjs';

function deliveries(peer, messageId) {
  return peer.events().filter(event => event.type === 'message_end' && event.message.role === 'custom' &&
    (event.message.details?.messages ?? [event.message.details]).some(item => item?.message_id === messageId));
}

function discoveredPeers(peer) {
  const listing = peer.events().findLast(event => event.type === 'tool_execution_end' && event.toolName === 'arlo_list_sessions');
  return JSON.parse(listing.result.content[0].text);
}

async function reload(peer, enabled = true) {
  fs.writeFileSync(path.join(peer.home, 'arlo-enabled.json'), JSON.stringify({ enabled }));
  const eventOffset = peer.events().length;
  const starts = peer.events().filter(event => event.type === 'session_start').length;
  const offset = peer.output.length;
  await peer.submit('/reload');
  await eventually(() => peer.events(), events => events.filter(event => event.type === 'session_start').length > starts,
    'native reload rebuilds the runner', 35_000);
  const nextStart = peer.events().findIndex((event, index) => index >= eventOffset && event.type === 'session_start');
  // A native redraw can repeat the previous attachment's ready footer.
  // Wait for the new attachment's public status call instead of screen text.
  if (enabled) await eventually(() => peer.events().slice(nextStart + 1), events => events.some(event =>
    event.type === 'status' && event.key === 'arlo' && typeof event.text === 'string' && event.text.includes('Arlo ready')),
    'the reattached root is ready', 35_000);
  return offset;
}

test('native Pi reload takes over accepted pending input once on the original endpoint', { timeout: 150_000 }, async t => {
  const rig = await nativeScenario('issue65-reload');
  t.after(() => rig.close());
  t.diagnostic(`Evidence: ${rig.directory}`);
  const alpha = await rig.start('alpha');
  await alpha.ready();
  const bravo = await rig.start('bravo');
  await bravo.ready();
  const originalSession = bravo.events().find(event => event.type === 'session_start').sessionId;
  bravo.gate('settled', 'hold');
  await bravo.submit('Finish an ordinary turn while the settlement notification is held.');
  await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' && event.name === 'settled'),
    'native settlement holds a control before permanent claim');
  const marker = 'PI_ISSUE65_ORIGINAL_PENDING';
  const first = await sendFromNative(rig, alpha, bravo.name, marker);
  const originalEndpoint = discoveredPeers(alpha)[0].endpoint_id;
  assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, marker)), false);
  let processed = 0;
  rig.handlers.set('bravo', request => {
    assert.ok(inbound(request.body, marker));
    processed++;
    return modelText('The retained message was processed once.')(request);
  });
  const offset = await reload(bravo);
  assert.equal(bravo.events().findLast(event => event.type === 'session_start').sessionId, originalSession);
  bravo.gate('settled', 'release');
  await eventually(() => processed, count => count === 1, 'the replacement consumer claims the original input');
  await eventually(() => bravo.events(), events => events.some(event => event.type === 'message_end' &&
    event.message.role === 'assistant' && JSON.stringify(event.message).includes('retained message was processed')), 'native processing finishes');
  rig.handlers.set('bravo', modelText('New traffic is processed normally.'));
  const second = await sendFromNative(rig, alpha, bravo.name, 'PI_ISSUE65_NEW_MESSAGE');
  assert.notEqual(second.receipt.message_id, first.receipt.message_id);
  assert.equal(discoveredPeers(alpha)[0].endpoint_id, originalEndpoint);
  await eventually(() => deliveries(bravo, second.receipt.message_id), items => items.length === 1, 'new input is claimed');
  assert.equal(deliveries(bravo, first.receipt.message_id).length, 1, 'The original input is permanently claimed once');
  assert.equal(bravo.output.slice(offset).includes('Arlo cancelled'), false);
  assert.deepEqual(rig.errors, []);
});

test('native Pi reload at settlement after busy-turn arrival retains input for the new consumer', { timeout: 150_000 }, async t => {
  const rig = await nativeScenario('issue65-busy');
  t.after(() => rig.close());
  t.diagnostic(`Evidence: ${rig.directory}`);
  const alpha = await rig.start('alpha'); await alpha.ready();
  const bravo = await rig.start('bravo'); await bravo.ready();
  bravo.gate('last-boundary', 'hold');
  bravo.gate('before-adapter-settled', 'hold');
  await bravo.submit('Keep this native model turn busy past its last input-provider boundary.');
  await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' && event.name === 'last-boundary'),
    'the receiving root is genuinely busy after its boundary provider returned');
  const first = await sendFromNative(rig, alpha, bravo.name, 'PI_ISSUE65_BUSY_PENDING');
  assert.equal(deliveries(bravo, first.receipt.message_id).length, 0);
  const busyOffset = bravo.output.length;
  await bravo.submit('/reload');
  await eventually(() => bravo.output.slice(busyOffset),
    text => text.includes('Wait for the current response to finish before reloading.'),
    'Pi 1.1.0 refuses interactive /reload while the run is still streaming');
  assert.equal(bravo.events().some(event => event.type === 'session_shutdown'), false);
  assert.equal(deliveries(bravo, first.receipt.message_id).length, 0);
  const commandOffset = bravo.output.length;
  await bravo.submit('/acceptance-reload');
  await eventually(() => bravo.events(), events => events.some(event => event.type === 'acceptance_reload' && event.idle === false),
    'the public extension command reaches its handler while the native turn is busy');
  await eventually(() => bravo.output.slice(commandOffset),
    text => text.includes('Wait for the current response to finish before reloading.'),
    'Pi routes command-context reload through the same guarded TUI reload boundary');
  assert.equal(bravo.events().some(event => event.type === 'session_shutdown'), false);
  assert.equal(deliveries(bravo, first.receipt.message_id).length, 0);
  bravo.gate('last-boundary', 'release');
  await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' && event.name === 'before-adapter-settled'),
    'the busy turn reaches settlement before the old attachment can issue a post-busy wake');
  const reloadOffset = await reload(bravo);
  assert.equal(deliveries(bravo, first.receipt.message_id).length, 0, 'Reattachment cannot claim while settlement is still held');
  let consumed = 0;
  rig.handlers.set('bravo', request => {
    assert.ok(inbound(request.body, 'PI_ISSUE65_BUSY_PENDING'));
    consumed++;
    return modelText('The busy backlog was processed.')(request);
  });
  bravo.gate('before-adapter-settled', 'release');
  await eventually(() => consumed, count => count === 1, 'the new attachment claims the busy backlog once');
  await eventually(() => bravo.events(), events => events.some(event => event.type === 'message_end' &&
    event.message.role === 'assistant' && JSON.stringify(event.message).includes('busy backlog was processed')),
    'the new attachment finishes the busy backlog');
  assert.equal(consumed, 1);
  assert.equal(deliveries(bravo, first.receipt.message_id).length, 1);
  assert.equal(bravo.output.slice(reloadOffset).includes('Arlo cancelled'), false);
  assert.deepEqual(rig.errors, []);
});

test('native Pi reload with an outstanding ordinary preflight retains deferred input on its original endpoint', { timeout: 150_000 }, async t => {
  const rig = await nativeScenario('issue65-preflight-reload', { observeNativeHistory: ['1.2.0', '1.3.0', '1.4.0'].includes(piVersion) });
  let bravo;
  t.after(async () => {
    bravo?.gate('native-preflight', 'release');
    bravo?.gate('before-adapter-settled', 'release');
    await rig.close();
  });
  t.diagnostic(`Evidence: ${rig.directory}`);
  const alpha = await rig.start('alpha'); await alpha.ready();
  bravo = await rig.start('bravo'); await bravo.ready();
  for (const peer of [alpha, bravo]) await completeOrdinaryTurn(peer);
  const originalSession = bravo.events().find(event => event.type === 'session_start').sessionId;
  const ordinaryPrompt = 'PI_ISSUE65_ORDINARY_PREFLIGHT: hold preparation across the native reload.';
  bravo.gate('native-preflight', 'hold');
  bravo.gate('before-adapter-settled', 'hold');
  await bravo.submit(ordinaryPrompt);
  await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' && event.name === 'native-preflight'),
    'the ordinary native submission is still awaiting its public preflight handler');
  assert.equal(bravo.events().some(event => event.type === 'preflight_handler_complete' && event.prompt === ordinaryPrompt), false);
  // Pi's documented #62 preflight limitation lets a custom-message turn run
  // while this ordinary submission is preparing. Hold that turn's public
  // settlement event so a later arrival remains unclaimed during reload.
  const trigger = await sendFromNative(rig, alpha, bravo.name, 'PI_ISSUE65_PREFLIGHT_TRIGGER');
  if (['1.2.0', '1.3.0', '1.4.0'].includes(piVersion)) {
    // The real candidate keeps before_agent_start busy. Unlike 1.1, its reload
    // guard cannot be crossed at this boundary; verify refusal and conservation.
    const originalEndpoint = discoveredPeers(alpha)[0].endpoint_id;
    assert.equal(deliveries(bravo, trigger.receipt.message_id).length, 0);
    const marker = 'PI_ISSUE65_PREFLIGHT_RELOAD_PENDING';
    const retained = await sendFromNative(rig, alpha, bravo.name, marker);
    assert.equal(retained.receipt.status, 'accepted');
    assert.equal(deliveries(bravo, retained.receipt.message_id).length, 0);
    assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, marker)), false);
    const starts = bravo.events().filter(event => event.type === 'session_start').length;
    for (const command of ['/reload', '/acceptance-reload']) {
      await eventually(() => bravo.events().findLast(event => event.type === 'draft')?.text, text => text === '',
        'The previous native submission finishes clearing its draft');
      const offset = bravo.output.length;
      await bravo.submit(command);
      await eventually(() => bravo.output.slice(offset), text => text.includes('Wait for the current response to finish before reloading.'),
        'Pi 1.2 refuses public reload while ordinary preparation owns the run');
      assert.equal(bravo.events().filter(event => event.type === 'session_start').length, starts);
    }
    assert.equal(deliveries(bravo, retained.receipt.message_id).length, 0, 'Refused reload keeps input in the same root');
    const completed = bravo.events().filter(event => event.type === 'agent_settled_handler_complete').length;
    rig.handlers.set('bravo', modelText('The candidate preparation and retained input complete on the same root.'));
    bravo.gate('before-adapter-settled', 'release');
    bravo.gate('native-preflight', 'release');
    // Pi 1.2 commits boundary drafts as session entries, without message_end.
    // The existing observer reads the public SessionManager branch at settlement.
    const history = messageId => bravo.events().findLast(event => event.type === 'native_history')?.messages
      .filter(message => message.message_id === messageId) ?? [];
    for (const message of [trigger, retained]) {
      await eventually(() => history(message.receipt.message_id), items => items.length === 1,
        'Pi 1.2 claims the original accepted dispatch exactly once after preparation');
      await eventually(() => rig.accounting, records => records.some(record => record.status === 200 &&
        record.proof?.message_id === message.receipt.message_id), 'Original credit is settled');
      const proofs = rig.accounting.filter(record => record.proof?.message_id === message.receipt.message_id);
      assert.equal(proofs.length, 1);
      assert.equal(proofs[0].proof.event, 'claimed');
      assert.equal(proofs[0].proof.endpoint_id, originalEndpoint);
    }
    assert.ok(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, marker)),
      'The real model processes the retained input after preparation');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'preflight_handler_complete' && event.prompt === ordinaryPrompt),
      'The candidate ordinary preflight completes before reload');
    await eventually(() => bravo.events(), events => events.filter(event => event.type === 'agent_settled_handler_complete').length > completed,
      'The candidate reaches a fresh native settlement');
    await reload(bravo);
    assert.equal(bravo.events().findLast(event => event.type === 'session_start').sessionId, originalSession);
    const next = await sendFromNative(rig, alpha, bravo.name, 'PI_ISSUE65_AFTER_PREFLIGHT_RELOAD');
    assert.equal(discoveredPeers(alpha)[0].endpoint_id, originalEndpoint);
    await eventually(() => deliveries(bravo, next.receipt.message_id), items => items.length === 1,
      'Fresh candidate input still uses the original endpoint after allowed reload');
    assert.equal(history(retained.receipt.message_id).length, 1);
    assert.equal(history(trigger.receipt.message_id).length, 1);
    assert.deepEqual(rig.errors, []);
    t.diagnostic('Pi 1.2 busy preflight refused both reload APIs; accepted dispatches and the later allowed reload retained their endpoint and credit.');
    return;
  }
  await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' && event.name === 'before-adapter-settled'),
    'the received trigger reaches native settlement while ordinary preflight is outstanding');
  assert.equal(deliveries(bravo, trigger.receipt.message_id).length, 1);
  const originalEndpoint = discoveredPeers(alpha)[0].endpoint_id;
  const marker = 'PI_ISSUE65_PREFLIGHT_RELOAD_PENDING';
  const retained = await sendFromNative(rig, alpha, bravo.name, marker);
  assert.equal(retained.receipt.status, 'accepted');
  assert.equal(retained.status.status, 'accepted');
  assert.equal(deliveries(bravo, retained.receipt.message_id).length, 0);
  assert.equal(rig.requests.some(request => request.peer === 'bravo' && inbound(request.body, marker)), false);
  assert.equal(bravo.events().some(event => event.type === 'preflight_handler_complete' && event.prompt === ordinaryPrompt), false);
  const offset = await reload(bravo);
  assert.equal(bravo.events().findLast(event => event.type === 'session_start').sessionId, originalSession);
  assert.equal(bravo.events().some(event => event.type === 'session_shutdown' && event.reason === 'reload'), true);
  assert.equal(bravo.events().some(event => event.type === 'preflight_handler_complete' && event.prompt === ordinaryPrompt), false,
    'Pi reload actually takes place while the native ordinary preflight is awaiting completion');
  assert.equal(deliveries(bravo, retained.receipt.message_id).length, 0);
  let processed = 0;
  rig.handlers.set('bravo', request => {
    assert.ok(inbound(request.body, marker));
    processed++;
    return modelText('The preflight reload backlog was processed once.')(request);
  });
  bravo.gate('before-adapter-settled', 'release');
  await eventually(() => processed, count => count === 1, 'the replacement claims the deferred preflight backlog once');
  await eventually(() => bravo.events(), events => events.some(event => event.type === 'message_end' &&
    event.message.role === 'assistant' && JSON.stringify(event.message).includes('preflight reload backlog was processed once')),
    'the replacement finishes retained processing');
  rig.handlers.set('bravo', modelText('The original native preparation completes after reload.'));
  bravo.gate('native-preflight', 'release');
  await eventually(() => bravo.events(), events => events.some(event => event.type === 'preflight_handler_complete' && event.prompt === ordinaryPrompt),
    'the old preflight hook is released after replacement reception is complete');
  const next = await sendFromNative(rig, alpha, bravo.name, 'PI_ISSUE65_AFTER_PREFLIGHT_RELOAD');
  assert.equal(discoveredPeers(alpha)[0].endpoint_id, originalEndpoint);
  await eventually(() => deliveries(bravo, next.receipt.message_id), items => items.length === 1, 'fresh input continues on the original endpoint');
  await eventually(() => rig.requests, requests => requests.some(request => request.peer === 'bravo' &&
    inbound(request.body, 'PI_ISSUE65_AFTER_PREFLIGHT_RELOAD')), 'the model sees fresh input after preflight reload');
  await eventually(() => rig.accounting, items => items.some(item => item.status === 200 &&
    item.proof?.message_id === retained.receipt.message_id), 'the original retained dispatch releases credit successfully');
  const proofs = rig.accounting.filter(item => item.proof?.message_id === retained.receipt.message_id);
  assert.equal(proofs.length, 1);
  assert.equal(proofs[0].status, 200);
  assert.equal(proofs[0].proof.event, 'claimed');
  assert.equal(proofs[0].proof.endpoint_id, originalEndpoint);
  const triggerProof = rig.accounting.find(item => item.status === 200 && item.proof?.message_id === trigger.receipt.message_id).proof;
  assert.equal(proofs[0].proof.daemon_id, triggerProof.daemon_id);
  assert.equal(proofs[0].proof.generation, triggerProof.generation,
    'The replacement releases the original dispatch generation rather than its new registration generation');
  let queried = false;
  const settled = alpha.events().filter(event => event.type === 'agent_settled').length;
  rig.handlers.set('alpha', request => {
    if (!queried) {
      queried = true;
      return modelTool('arlo_get_message_status', { message_id: retained.receipt.message_id })(request);
    }
    assert.equal(lastTool(request.body).status, 'accepted');
    return modelText('The retained reception remains accepted after reload and claim.')(request);
  });
  await alpha.submit('Query the reception status of the retained request after its reload handoff.');
  await eventually(() => alpha.events(), events => events.filter(event => event.type === 'agent_settled').length > settled,
    'the sender queries the original reception successfully after reload');
  assert.equal(deliveries(bravo, retained.receipt.message_id).length, 1);
  assert.equal(deliveries(bravo, trigger.receipt.message_id).length, 1);
  assert.equal(processed, 1);
  assert.equal(bravo.output.slice(offset).includes('Arlo cancelled'), false);
  assert.deepEqual(rig.errors, []);
});

test('native Arlo unload preserves pending input while other Pi roots use the shared Daemon', { timeout: 180_000 }, async t => {
  const rig = await nativeScenario('issue65-unload');
  t.after(() => rig.close());
  t.diagnostic(`Evidence: ${rig.directory}`);
  const alpha = await rig.start('alpha'); await alpha.ready();
  const bravo = await rig.start('bravo'); await bravo.ready();
  const charlie = await rig.start('charlie'); await charlie.ready();
  bravo.gate('settled', 'hold');
  await bravo.submit('Hold settlement so the accepted input remains pending.');
  await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' && event.name === 'settled'),
    'the original control remains deferred');
  const first = await sendFromNative(rig, alpha, bravo.name, 'PI_ISSUE65_UNLOADED_PENDING');
  const offset = await reload(bravo, false);
  assert.equal(deliveries(bravo, first.receipt.message_id).length, 0);
  const other = await sendFromNative(rig, alpha, charlie.name, 'PI_ISSUE65_SHARED_DAEMON_ALIVE');
  await eventually(() => deliveries(charlie, other.receipt.message_id), items => items.length === 1,
    'the other real Pi roots still communicate');
  assert.equal(discoveredPeers(alpha).some(item => item.display_name === bravo.name), false, 'Unloaded Arlo stops new reception');
  await reload(bravo, true);
  rig.handlers.set('bravo', modelText('The retained input survives temporary unload.'));
  bravo.gate('settled', 'release');
  await eventually(() => deliveries(bravo, first.receipt.message_id), items => items.length === 1,
    'reloading Arlo claims its own retained input');
  rig.handlers.set('bravo', modelText('Fresh input follows reattachment.'));
  const next = await sendFromNative(rig, alpha, bravo.name, 'PI_ISSUE65_AFTER_UNLOAD');
  await eventually(() => deliveries(bravo, next.receipt.message_id), items => items.length === 1, 'new input continues');
  assert.equal(deliveries(bravo, first.receipt.message_id).length, 1);
  assert.equal(deliveries(charlie, first.receipt.message_id).length, 0, 'Another root cannot claim or attest to the retained input');
  assert.equal(bravo.output.slice(offset).includes('Arlo cancelled'), false);
  assert.deepEqual(rig.errors, []);
});

test('native Pi reload during credit proof wait never requeues permanently claimed input', { timeout: 150_000 }, async t => {
  const rig = await nativeScenario('issue65-credit-wait');
  t.after(() => rig.close());
  t.diagnostic(`Evidence: ${rig.directory}`);
  const alpha = await rig.start('alpha'); await alpha.ready();
  const bravo = await rig.start('bravo'); await bravo.ready();
  for (const peer of [alpha, bravo]) await completeOrdinaryTurn(peer);
  const settled = bravo.events().filter(event => event.type === 'agent_settled').length;
  rig.creditGate.hold = true;
  const first = await sendFromNative(rig, alpha, bravo.name, 'PI_ISSUE65_CLAIMED_BEFORE_RELOAD');
  await eventually(() => rig.creditGate.held, items => items.length > 0, 'the real Daemon credit request is held');
  await eventually(() => deliveries(bravo, first.receipt.message_id), items => items.length === 1, 'Pi permanently claimed input');
  await eventually(() => bravo.events(), events => events.filter(event => event.type === 'agent_settled').length > settled,
    'the claimed turn finishes while the credit proof is still in flight');
  assert.equal(rig.creditGate.attempts, 1);
  const starts = bravo.events().filter(event => event.type === 'session_start').length;
  const offset = bravo.output.length;
  await bravo.submit('/reload');
  await eventually(() => bravo.events(), events => events.some(event => event.type === 'session_shutdown' && event.reason === 'reload'),
    'reload shutdown starts while the credit proof is still in flight');
  rig.releaseCredits({ fail: true });
  await eventually(() => bravo.events(), events => events.filter(event => event.type === 'session_start').length > starts,
    'native reload rebuilds the runner', 35_000);
  await eventually(() => bravo.output.slice(offset), text => text.includes('Arlo ready'),
    'the reattached root replays the unconfirmed credit proof and becomes ready', 35_000);
  assert.equal(rig.creditGate.attempts, 2, 'Reattachment replays the unconfirmed credit proof once');
  const next = await sendFromNative(rig, alpha, bravo.name, 'PI_ISSUE65_AFTER_CREDIT_WAIT');
  await eventually(() => deliveries(bravo, next.receipt.message_id), items => items.length === 1, 'fresh traffic is processed');
  assert.equal(deliveries(bravo, first.receipt.message_id).length, 1);
  assert.equal(bravo.events().some(event => event.type === 'session_start' && event.reason === 'reload'), true);
  assert.deepEqual(rig.errors, []);
});
