import { AuthorizedControlClient as ControlClient } from './helpers/authorized-control.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArloDaemon } from '@arlo/daemon';
import {

  ArloErrorCode,
  ARLO_MESSAGE_ID_META_KEY,
  ARLO_NOTIFICATION_METHOD,
  type ArloMessageNotificationParams,
} from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('Seam 2: Daemon unicast delivery, discovery, 3-state receipts, and bounded capacity', async () => {
  const stateDir = createTempDir('daemon-unicast');
  const daemon = new ArloDaemon({ stateDir });

  try {
    const { port } = await daemon.start();
    const control = new ControlClient({ stateDir, port });

    // 1. Register Runtime and two Roots in the same group, and one in a different group
    const rt = await control.registerRuntime({ host_type: 'deepseek-harness', host_version: '0.2.0' });
    const rootA = await control.registerRoot(rt.runtime_token, {
      root_session_id: 'host-a',
      group_name: 'team-alpha',
      agent_incarnation: 'inc-a',
      plugin_generation: 1,
    });
    const rootB = await control.registerRoot(rt.runtime_token, {
      root_session_id: 'host-b',
      group_name: 'team-alpha',
      agent_incarnation: 'inc-b',
      plugin_generation: 1,
    });
    const rootC = await control.registerRoot(rt.runtime_token, {
      root_session_id: 'host-c',
      group_name: 'team-beta',
      agent_incarnation: 'inc-c',
      plugin_generation: 1,
    });

    const connA = control.createRootConnection(rootA);
    const connB = control.createRootConnection(rootB);
    const connC = control.createRootConnection(rootC);

    try {
      // Connect Root A and Root B MCP clients
      await connA.connect();
      await connB.connect();
      await connC.connect();

      // Before confirming ready: arlo_list_sessions returns empty list
      const initialSessionsA = await connA.listSessions();
      assert.deepEqual(JSON.parse(initialSessionsA[0].text), [], 'Unready endpoints must not be discovered');

      // Attempting to publish ready before SSE connection or initialization
      // Confirm Root A and Root B ready
      await control.confirmRootReady(rootA.root_token, { endpoint_id: rootA.endpoint_id });
      await control.confirmRootReady(rootB.root_token, { endpoint_id: rootB.endpoint_id });
      await control.confirmRootReady(rootC.root_token, { endpoint_id: rootC.endpoint_id });

      // After ready: Root A lists other ready roots in team-alpha (Root B only, not Root C or itself!)
      const sessionsA = await connA.listSessions();
      const listA = JSON.parse(sessionsA[0].text);
      assert.equal(listA.length, 1);
      assert.equal(listA[0].endpoint_id, rootB.endpoint_id);
      assert.equal(listA[0].deliverable, true);
      assert.equal(listA[0].mcpSessionId, undefined, 'Must not leak MCP Session ID');
      assert.equal(listA[0].root_token, undefined, 'Must not leak root credentials');

      // Listen for notifications on Root B
      const receivedNotificationsB: ArloMessageNotificationParams[] = [];
      connB.onNotification((params) => {
        receivedNotificationsB.push(params);
        // Automatically submit receipt as enqueued
        void control.submitReceipt(rootB.root_token, {
          daemon_id: params.daemon_id,
          endpoint_id: rootB.endpoint_id,
          message_id: params.message_id,
          delivery_id: params.delivery_id,
          generation: params.target_generation,
          status: 'enqueued',
          native_message_id: 'native-b-1',
        });
      });

      // 2. Unicast send from Root A to Root B
      const sendRes1 = await connA.sendMessage({
        to: rootB.endpoint_id,
        text: 'Hello B from A',
      });
      assert.equal(sendRes1.status, 'accepted');
      assert.ok(sendRes1.message_id);

      assert.equal(receivedNotificationsB.length, 1);
      assert.equal(receivedNotificationsB[0].text, 'Hello B from A');
      assert.equal(receivedNotificationsB[0].from_endpoint, rootA.endpoint_id);
      assert.equal(receivedNotificationsB[0].to_endpoint, rootB.endpoint_id);
      assert.equal(receivedNotificationsB[0].delivery_seq, '1');

      // 3. Deduplication: repeating same message returns accepted without re-dispatching
      const sendRes1Repeat = await connA.sendMessage({
        to: rootB.endpoint_id,
        text: 'Hello B from A',
      }, sendRes1.message_id);
      assert.equal(sendRes1Repeat.status, 'accepted');
      assert.equal(receivedNotificationsB.length, 1, 'Duplicate message must not re-dispatch');

      // 4. Same message_id with different text returns MESSAGE_ID_CONFLICT
      await assert.rejects(
        connA.sendMessage({
          to: rootB.endpoint_id,
          text: 'Conflicting content',
        }, sendRes1.message_id),
        (err: any) => err.code === ArloErrorCode.MESSAGE_ID_CONFLICT || err.message?.includes('MESSAGE_ID_CONFLICT')
      );

      // 5. Sending to Root C (different group) is rejected
      await assert.rejects(
        connA.sendMessage({
          to: rootC.endpoint_id,
          text: 'Cross group attempt',
        }),
        (err: any) => err.code === ArloErrorCode.TARGET_UNAVAILABLE || err.code === ArloErrorCode.GROUP_MISMATCH
      );

      // 6. Credit release: releasing credit for message 1
      const relRes = await control.releaseCredit(rootB.root_token, {
        endpoint_id: rootB.endpoint_id,
        message_id: sendRes1.message_id,
        native_message_id: 'native-b-1',
        event: 'claimed',
      });
      assert.equal(relRes.status, 'ok');

      // Duplicate credit release is idempotent
      const relRes2 = await control.releaseCredit(rootB.root_token, {
        endpoint_id: rootB.endpoint_id,
        message_id: sendRes1.message_id,
        native_message_id: 'native-b-1',
        event: 'claimed',
      });
      assert.equal(relRes2.status, 'ok');

      // 7. Target submitting receipt with status 'not_enqueued' returns status 'rejected' to sender
      let lastNotificationB: ArloMessageNotificationParams | undefined;
      connB.onNotification(async (params) => {
        lastNotificationB = params;
        if (params.text === 'Message to be rejected') {
          await control.submitReceipt(rootB.root_token, {
            daemon_id: params.daemon_id,
            endpoint_id: rootB.endpoint_id,
            message_id: params.message_id,
            delivery_id: params.delivery_id,
            generation: params.target_generation,
            status: 'not_enqueued',
            reason: 'QUEUE_LIMIT',
          });
        }
      });

      const sendResReject = await connA.sendMessage({
        to: rootB.endpoint_id,
        text: 'Message to be rejected',
      });
      assert.equal(sendResReject.status, 'rejected');
      assert.equal(sendResReject.reason, 'QUEUE_LIMIT');

      // 8. Receipt conflict: Root B submits conflicting receipt (enqueued for previously accepted/rejected)
      await assert.rejects(
        control.submitReceipt(rootB.root_token, {
          daemon_id: lastNotificationB!.daemon_id,
          endpoint_id: rootB.endpoint_id,
          message_id: sendResReject.message_id,
          delivery_id: lastNotificationB!.delivery_id,
          generation: rootB.generation,
          status: 'enqueued',
          native_message_id: 'native-conflict',
        }),
        (err: any) => err.code === ArloErrorCode.RECEIPT_CONFLICT || err.message?.includes('RECEIPT_CONFLICT')
      );

      // Endpoint B deliverable is now false due to receipt conflict
      const rootsAfterConflict = await control.listRoots(rt.runtime_token);
      const rootBInfo = rootsAfterConflict.find((r) => r.endpoint_id === rootB.endpoint_id);
      assert.equal(rootBInfo?.deliverable, false);

      // Sending to Root B is now rejected because it's non-deliverable
      await assert.rejects(
        connA.sendMessage({
          to: rootB.endpoint_id,
          text: 'Send to non-deliverable target',
        }),
        (err: any) => err.code === ArloErrorCode.TARGET_UNAVAILABLE || err.message?.includes('TARGET_UNAVAILABLE')
      );
    } finally {
      connA.dispose();
      connB.dispose();
      connC.dispose();
    }
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('Seam 2: Strict arguments and bidirectional pending reconciliation on re-entry', async () => {
  const stateDir = createTempDir('daemon-regressions');
  const daemon = new ArloDaemon({ stateDir });

  try {
    const { port } = await daemon.start();
    const control = new ControlClient({ stateDir, port });

    const rt = await control.registerRuntime({ host_type: 'deepseek-harness', host_version: '0.2.0' });
    const rootA = await control.registerRoot(rt.runtime_token, {
      root_session_id: 'host-reg-a',
      group_name: 'team-reg',
      agent_incarnation: 'inc-reg-a',
      plugin_generation: 1,
    });
    const rootB = await control.registerRoot(rt.runtime_token, {
      root_session_id: 'host-reg-b',
      group_name: 'team-reg',
      agent_incarnation: 'inc-reg-b',
      plugin_generation: 1,
    });

    const connA = control.createRootConnection(rootA);
    const connB = control.createRootConnection(rootB);
    let sendPromise: ReturnType<typeof connA.sendMessage> | undefined;

    try {
      await connA.connect();
      await connB.connect();
      // An empty daemon ledger cannot explain pending input reported by the host.
      await assert.rejects(
        control.confirmRootReady(rootB.root_token, {
          endpoint_id: rootB.endpoint_id,
          reconciled_pending_message_ids: ['existing-host-message'],
        }),
        (err: any) => err.code === ArloErrorCode.ACCOUNTING_UNAVAILABLE
      );
      assert.equal((await control.listRoots(rt.runtime_token)).find(r => r.endpoint_id === rootB.endpoint_id)?.ready, false);
      await control.confirmRootReady(rootA.root_token, { endpoint_id: rootA.endpoint_id });
      await control.confirmRootReady(rootB.root_token, { endpoint_id: rootB.endpoint_id });

      // 1. AC 2: Undeclared properties like attachment are strictly rejected.
      // (reply_to is a declared optional argument since the reply ticket; a
      // forged identity field like sender is rejected as forbidden.)
      await assert.rejects(
        connA.sendMessage({
          to: rootB.endpoint_id,
          text: 'hello',
          attachment: 'forbidden',
        } as any),
        (err: any) => err.code === ArloErrorCode.INVALID_ARGUMENT
      );

      await assert.rejects(
        connA.sendMessage({
          to: rootB.endpoint_id,
          text: 'hello',
          sender: 'forged-identity',
        } as any),
        (err: any) => err.code === ArloErrorCode.INVALID_ARGUMENT
      );

      // 2. AC 9: Pending reconciliation on re-entry
      const notification = Promise.withResolvers<ArloMessageNotificationParams>();
      connB.onNotification((params) => {
        notification.resolve(params);
        // Do not ACK yet, leaving it in flight / pending
      });

      sendPromise = connA.sendMessage({
        to: rootB.endpoint_id,
        text: 'pending text',
      });
      // Observe rejection immediately, including when another assertion fails.
      void sendPromise.catch(notification.reject);
      const pending = await notification.promise;

      // While message is pending in daemon, rootB re-calling ready without reconciling IDs fails
      await assert.rejects(
        control.confirmRootReady(rootB.root_token, {
          endpoint_id: rootB.endpoint_id,
        }),
        (err: any) => err.code === ArloErrorCode.ACCOUNTING_UNAVAILABLE
      );
      assert.deepEqual(JSON.parse((await connA.listSessions())[0].text), [], 'Failed reconciliation stops discovery and dispatch');

      // Re-calling ready with matching reconciled_pending_message_ids succeeds and preserves pending queue
      await control.confirmRootReady(rootB.root_token, {
        endpoint_id: rootB.endpoint_id,
        reconciled_pending_message_ids: [pending.message_id],
      });

      // Now submit receipt to finish the in-flight message cleanly
      await control.submitReceipt(rootB.root_token, {
        endpoint_id: rootB.endpoint_id,
        daemon_id: pending.daemon_id,
        message_id: pending.message_id,
        delivery_id: pending.delivery_id,
        generation: pending.target_generation,
        status: 'enqueued',
        native_message_id: 'native-reg-1',
      });

      const outcome = await sendPromise;
      assert.equal(outcome.status, 'accepted');
    } finally {
      connA.dispose();
      connB.dispose();
      await sendPromise?.catch(() => {});
    }
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
