import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { eventually, inbound, modelText, nativeScenario, sendFromNative } from './harness.mjs';

function persistedInputs(peer, messageId) {
  const file = peer.events().findLast(event => event.type === 'session_start').sessionFile;
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => entry.type === 'custom_message' &&
      (entry.details?.messages ?? [entry.details]).some(item => item?.message_id === messageId));
}

test('native Pi preserves permanent claim across guarded pre-append reload and unsettled proof replay',
  { timeout: 150_000 }, async t => {
    const rig = await nativeScenario('issue65-claim-boundary');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha'); await alpha.ready();
    const bravo = await rig.start('bravo'); await bravo.ready();
    const originalSession = bravo.events().find(event => event.type === 'session_start').sessionId;
    let ordinary;
    rig.handlers.set('bravo', request => { ordinary = request; });
    await bravo.submit('Finish this ordinary task after the accepted busy input arrives.');
    await eventually(() => ordinary, Boolean, 'the controlled model holds the ordinary busy turn');

    rig.creditGate.hold = true;
    const marker = 'PI_ISSUE65_CLAIM_BOUNDARY';
    const first = await sendFromNative(rig, alpha, bravo.name, marker);
    const endpoint = alpha.events().findLast(event => event.type === 'tool_execution_end' &&
      event.toolName === 'arlo_list_sessions');
    const originalEndpoint = JSON.parse(endpoint.result.content[0].text)[0].endpoint_id;
    assert.equal(persistedInputs(bravo, first.receipt.message_id).length, 0);
    bravo.gate('last-boundary', 'hold');
    bravo.gate('before-adapter-settled', 'hold');
    let processed = 0;
    rig.handlers.set('bravo', request => {
      assert.equal(inbound(request.body, marker)?.message_id, first.receipt.message_id);
      processed++;
      return modelText('The claimed busy input was processed once.')(request);
    });
    modelText('The ordinary task has finished.')(ordinary);
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' &&
      event.name === 'last-boundary'), 'Pi holds the public boundary after the adapter permanently claims');
    await eventually(() => rig.creditGate.held, requests => requests.length === 1,
      'the original claim has a real held credit proof');
    assert.equal(processed, 0, 'Pi has not issued the continuation provider request');
    assert.equal(persistedInputs(bravo, first.receipt.message_id).length, 0,
      'The claimed provider draft has not yet been appended');
    assert.equal(bravo.events().filter(event => event.type === 'message_end' &&
      event.message.role === 'custom').length, 0, 'No direct-control message handoff has occurred');

    const busyOffset = bravo.output.length;
    await bravo.submit('/reload');
    await eventually(() => bravo.output.slice(busyOffset), output =>
      output.includes('Wait for the current response to finish before reloading.'),
    'interactive reload is refused before the claimed provider draft is appended');
    const commandOffset = bravo.output.length;
    await bravo.submit('/acceptance-reload');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'acceptance_reload' &&
      event.idle === false), 'public command-context reload is attempted while the claim boundary is busy');
    await eventually(() => bravo.output.slice(commandOffset), output =>
      output.includes('Wait for the current response to finish before reloading.'),
    'command-context reload uses the same streaming guard');
    assert.equal(bravo.events().some(event => event.type === 'session_shutdown'), false);
    assert.equal(persistedInputs(bravo, first.receipt.message_id).length, 0);
    assert.equal(processed, 0);

    bravo.gate('last-boundary', 'release');
    await eventually(() => processed, count => count === 1, 'the claimed input starts exactly one provider continuation');
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'gate' &&
      event.name === 'before-adapter-settled'), 'the claimed turn holds its public settlement callback');
    assert.equal(persistedInputs(bravo, first.receipt.message_id).length, 1);
    assert.equal(bravo.events().some(event => event.type === 'agent_settled'), false,
      'The claimed turn has not completed its settlement callbacks');
    assert.equal(rig.creditGate.attempts, 1);

    const starts = bravo.events().filter(event => event.type === 'session_start').length;
    const reloadOffset = bravo.output.length;
    await bravo.submit('/reload');
    await eventually(() => bravo.output.slice(reloadOffset), output => output.includes('Reloading keybindings'),
      'real TUI reload starts while settlement and the original credit proof are held');
    rig.releaseCredits({ fail: true });
    await eventually(() => bravo.events(), events => events.some(event => event.type === 'session_shutdown' &&
      event.reason === 'reload'), 'real reload begins while settlement and the original credit proof are held');
    await eventually(() => bravo.events(), events => events.filter(event => event.type === 'session_start').length > starts,
      'the native runner is rebuilt', 35_000);
    await eventually(() => rig.accounting.filter(item => item.path === '/control/v1/roots/credit'),
      proofs => proofs.length === 2 && proofs[1].status === 200,
      'the replacement finishes replaying the original claim proof before readiness', 35_000);
    await eventually(() => bravo.output.slice(reloadOffset), output => output.includes('Arlo ready'),
      'the replacement confirms the replayed claim before becoming ready', 35_000);
    assert.equal(bravo.events().findLast(event => event.type === 'session_start').sessionId, originalSession);
    assert.equal(rig.creditGate.attempts, 2, 'Only the unconfirmed credit proof is replayed');
    const proofAttempts = rig.accounting.filter(item => item.path === '/control/v1/roots/credit');
    assert.equal(proofAttempts.length, 2);
    assert.deepEqual(proofAttempts.map(item => item.status), [503, 200]);
    assert.deepEqual(proofAttempts[0].proof, proofAttempts[1].proof,
      'Reattachment proves the identical original claim association');
    assert.match(JSON.stringify(proofAttempts[1].proof), new RegExp(first.receipt.message_id));
    assert.match(JSON.stringify(proofAttempts[1].proof), /claimed/);
    assert.equal(processed, 1, 'Reattachment cannot schedule the already-claimed input again');
    bravo.gate('before-adapter-settled', 'release');

    rig.handlers.set('bravo', modelText('Fresh traffic follows the original claim.'));
    const next = await sendFromNative(rig, alpha, bravo.name, 'PI_ISSUE65_AFTER_CLAIM_BOUNDARY');
    await eventually(() => persistedInputs(bravo, next.receipt.message_id), entries => entries.length === 1,
      'fresh native input is accepted and handed off by the replacement');
    assert.equal(persistedInputs(bravo, first.receipt.message_id).length, 1);
    const peers = alpha.events().findLast(event => event.type === 'tool_execution_end' &&
      event.toolName === 'arlo_list_sessions');
    assert.equal(JSON.parse(peers.result.content[0].text)[0].endpoint_id, originalEndpoint);
    assert.equal(bravo.output.slice(reloadOffset).includes('Arlo cancelled'), false);
    assert.deepEqual(rig.errors, []);
  });
