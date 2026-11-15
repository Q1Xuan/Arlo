import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { eventually, inbound, nativeScenario, sendFromNative } from './harness.mjs';

// Verify the bounded unavailable interval and each eventual native outcome.
for (const ending of ['quit', 'explicit same-root reload', 'autonomous recovery', 'cancellation']) {
  test(`unconfirmed native settlement controls preserve input through ${ending}`,
    { timeout: 120_000 }, async t => {
      const rig = await nativeScenario('issue129-settlement-blocker');
      let bravo;
      t.after(async () => { bravo?.gate('settled', 'release'); await rig.close(); });
      t.diagnostic(`Evidence: ${rig.directory}`);
      const alpha = await rig.start('alpha'); await alpha.ready();
      bravo = await rig.start('bravo'); await bravo.ready();
      const sessionId = bravo.events().find(event => event.type === 'session_start').sessionId;
      bravo.gate('settled', 'hold');
      await bravo.submit('Wait in the later public settlement handler.');
      await eventually(() => bravo.events(), events => events.some(event =>
        event.type === 'gate' && event.name === 'settled'), 'the native settlement handler is held');
      assert.equal(bravo.events().findLast(event => event.type === 'agent_settled').idle, true);
      const marker = 'PI_129_RETAINED_SETTLEMENT_BODY';
      const first = await sendFromNative(rig, alpha, bravo.name, marker);
      assert.equal(first.receipt.status, 'accepted');
      assert.equal(first.status.status, 'accepted');
      await delay(3500);
      await eventually(() => bravo.output, output => output.includes('PI_CONTROL_DELIVERY_UNCONFIRMED'),
        'the bounded control budget reports the specific unavailable diagnosis');
      const requests = () => rig.requests.filter(request => request.peer === 'bravo' && inbound(request.body, marker));
      const credits = () => rig.accounting.filter(record => record.proof?.message_id === first.receipt.message_id);
      assert.equal(requests().length, 0);
      assert.deepEqual(credits(), [], 'Timeout cannot claim, discard or refund accepted input');
      async function assertOriginalCredit(event) {
        await eventually(credits, records => records.some(record => record.status === 200),
          'restored authority settles the original credit');
        const proofs = credits().filter(record => record.status === 200).map(record => record.proof);
        assert.equal(proofs.length, 1);
        assert.equal(proofs[0].event, event);
        const acceptance = rig.receipts.find(record => record.status === 200 &&
          record.proof.message_id === first.receipt.message_id && record.proof.status === 'enqueued')?.proof;
        assert.ok(acceptance);
        for (const field of ['daemon_id', 'endpoint_id', 'message_id', 'delivery_id', 'generation', 'native_message_id']) {
          assert.equal(proofs[0][field], acceptance[field], `Original ${field} survives the paused attachment`);
        }
      }

      if (ending === 'explicit same-root reload') {
        fs.writeFileSync(path.join(bravo.home, 'arlo-enabled.json'), JSON.stringify({ enabled: true }));
        const offset = bravo.output.length;
        await bravo.submit('/reload');
        await eventually(() => bravo.events(), events => events.filter(event => event.type === 'session_start').length === 2,
          'the human explicitly reloads the same living root', 35_000);
        await eventually(() => bravo.output.slice(offset), output => output.includes('Arlo ready'),
          'the replacement attachment becomes ready', 35_000);
        assert.equal(bravo.events().findLast(event => event.type === 'session_start').sessionId, sessionId);
      }
      if (ending === 'cancellation') {
        bravo.write('\u001b');
        await eventually(() => bravo.output, output => output.includes('Arlo cancelled 1 pending message'),
          'Escape cancels retained input while the later settlement handler is held');
      }
      if (ending !== 'quit') {
        bravo.gate('settled', 'release');
        await eventually(() => bravo.events(), events => events.some(event =>
          event.type === 'agent_settled_handler_complete'), 'the delayed native handler completes');
        if (ending !== 'cancellation') {
          await eventually(requests, items => items.length > 0, 'the retained original body reaches the actual model');
          assert.equal(requests().length, 1);
          assert.equal(inbound(requests()[0].body, marker).message_id, first.receipt.message_id);
          await assertOriginalCredit('claimed');
          await eventually(() => bravo.events(), events => events.filter(event => event.type === 'agent_settled').length === 2,
            'the recovered input finishes');
        } else {
          await delay(1200);
          assert.equal(requests().length, 0, 'Cancelled input never reaches the model');
          assert.equal(bravo.events().filter(event => event.type === 'message_end' &&
            event.message?.role === 'custom' && JSON.stringify(event.message.content).includes(marker)).length, 0);
        }
        const freshMarker = 'PI_129_FRESH_AFTER_RECOVERY';
        const fresh = await sendFromNative(rig, alpha, bravo.name, freshMarker);
        await eventually(() => rig.requests, items => items.some(request => request.peer === 'bravo' &&
          inbound(request.body, freshMarker)?.message_id === fresh.receipt.message_id), 'fresh input reaches the same root');
        assert.equal(bravo.events().filter(event => event.type === 'message_end' && event.message?.role === 'custom' &&
          JSON.stringify(event.message.content).includes(marker)).length, ending === 'cancellation' ? 0 : 1, 'The original body is handed off at most once');
        if (ending === 'cancellation') await assertOriginalCredit('discarded');
        assert.equal(bravo.events().findLast(event => event.type === 'session_start').sessionId, sessionId);
        assert.equal(bravo.events().filter(event => event.type === 'session_start').length,
          ending === 'explicit same-root reload' ? 2 : 1);
        assert.deepEqual(rig.errors, []);
        return;
      }
      await bravo.quit();
      assert.ok(bravo.events().some(event => event.type === 'session_shutdown' && event.reason === 'quit'));
      assert.ok(rig.accounting.some(record => record.path === '/control/v1/runtimes/revoke' && record.status === 200),
        'The stopped runtime is revoked on final quit');
      // Pause has already removed the root token. A local final discard is not
      // an authenticated remote proof; never pretend its credit was confirmed.
      assert.deepEqual(credits(), [], 'Final quit cannot use retired root authority to invent a credit proof');
      assert.deepEqual(rig.errors, []);
    });
}
