import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ArloDaemon } from '@arlo/daemon';
import {
  ArloErrorCode,
  DaemonClient,
  type RootRegistrationResponse,
} from '@arlo/sdk';
import { createArloHarnessPlugin, fixture } from './helpers/authorized-dsh-fixture.ts';
import { LocalModel } from '../probes/fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

function extractToolResultText(events: readonly any[], toolCallId: string): string {
  const ev = events.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === toolCallId);
  return ev?.data?.message?.content?.[0]?.text ?? '';
}

function getToolResultEvent(events: readonly any[], toolCallId: string): any {
  return events.find((e) => e.type === 'tool/result' && e.data?.message?.toolCallId === toolCallId);
}

function toolCallChunks(callId: string, name: string, args: Record<string, unknown>): StreamChunk[] {
  const id = ToolCallId(callId);
  const argsJson = JSON.stringify(args);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

test('Seam 4: End-to-end Harness unicast delivery, discovery, queueing, and bounds acceptance', { timeout: 60000 }, async () => {
  const stateDir = createTempDir('harness-unicast-acceptance');
  const daemon = new ArloDaemon({ stateDir });

  try {
    await daemon.start();
    const userClient = new DaemonClient({ stateDir });

    const modelA = new LocalModel();
    const hostA = await fixture(modelA);

    const modelB = new LocalModel();
    const hostB = await fixture(modelB);

    try {
      // 1. Install ArloHarnessPlugin on both independent Harness hosts in same group
      const pluginA = createArloHarnessPlugin({
        groupName: 'team-deepseek-acceptance',
        stateDir,
      });
      const pluginB = createArloHarnessPlugin({
        groupName: 'team-deepseek-acceptance',
        stateDir,
      });

      await hostA.ctx.plugin(pluginA);
      await hostB.ctx.plugin(pluginB);

      // Wait for both roots to complete 4-step readiness gate
      let rootsDiag: any[] = [];
      for (let i = 0; i < 150; i++) {
        rootsDiag = await userClient.listRoots();
        if (rootsDiag.filter((r) => r.status === 'registered' && r.ready && r.deliverable).length >= 2) {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      assert.equal(rootsDiag.length, 2);
      assert.ok(rootsDiag.every((r) => r.ready && r.deliverable));

      // 2. Discovery: Root A discovers Root B via arlo_list_sessions
      modelA.script.push(toolCallChunks('call-list-1', 'arlo_list_sessions', {}));
      hostA.root.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'discover sessions' }],
          source: { kind: 'arlo', form: 'relay' },
        })
      );
      await hostA.root.agent.whenIdle();

      const eventsA1 = hostA.root.agent.session.snapshotEvents();
      const listText = extractToolResultText(eventsA1, 'call-list-1');
      assert.ok(listText, 'Tool result text must exist');
      const listContent = JSON.parse(listText);
      assert.ok(Array.isArray(listContent));
      assert.equal(listContent.length, 1);
      const targetEndpointB = listContent[0].endpoint_id;
      assert.ok(targetEndpointB, 'Discovered endpoint ID must be valid');
      assert.equal(listContent[0].deliverable, true);

      // Root A endpoint is the other endpoint in rootsDiag
      const endpointA = rootsDiag.find((r) => r.endpoint_id !== targetEndpointB)?.endpoint_id;
      assert.ok(endpointA, 'Root A endpoint must be identifiable');
      assert.notEqual(endpointA, targetEndpointB);

      // 3. Unicast Send & Idle Wakeup: Root A sends to Root B
      const canary1 = 'canary-unicast-secret-payload-990011';
      modelA.script.push(
        toolCallChunks('call-send-1', 'arlo_send_message', {
          to: targetEndpointB,
          text: canary1,
        })
      );
      hostA.root.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'send to B' }],
          source: { kind: 'arlo', form: 'relay' },
        })
      );
      await hostA.root.agent.whenIdle();

      const sendEventsA = hostA.root.agent.session.snapshotEvents();
      const sendText = extractToolResultText(sendEventsA, 'call-send-1');
      assert.ok(sendText, 'Send tool result must exist');
      const lastSendResult = JSON.parse(sendText);
      assert.equal(lastSendResult.status, 'accepted');
      assert.ok(lastSendResult.message_id);

      // Root B was idle: it should be woken up and process the message in a turn
      await hostB.root.agent.whenIdle();

      const eventsB = hostB.root.agent.session.snapshotEvents();
      const userMsgEvents = eventsB.filter((e) => e.type === 'user/message');
      const receivedMsg = userMsgEvents.find(
        (e: any) => e.data?.content?.[0]?.text === canary1
      )?.data as any;
      assert.ok(receivedMsg, 'Root B must receive the unicast message');
      assert.equal(receivedMsg.source?.kind, 'arlo');
      assert.equal(receivedMsg.source?.form, 'relay');

      // Verify Child Agent isolation: hostB.child received NOTHING
      const childEventsB = hostB.child.agent.session.snapshotEvents();
      assert.equal(
        childEventsB.filter((e: any) => e.type === 'user/message').length,
        0,
        'Child agent must not receive root messages'
      );

      // 4. Busy Next-Turn Queueing Without Preemption:
      // Make Host B busy with an artificial delay in model response
      let turnInProgress = true;
      let resolveTurn: (() => void) | undefined;
      const turnHold = new Promise<void>((resolve) => {
        resolveTurn = resolve;
      });

      modelB.beforeResponse = async () => {
        if (turnInProgress) {
          await turnHold;
        }
      };

      // Trigger Host B to start a turn and become busy
      hostB.root.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'turn to keep B busy' }],
          source: { kind: 'arlo', form: 'relay' },
        })
      );

      // Wait until B is running
      for (let i = 0; i < 20; i++) {
        if (hostB.root.agent.status === 'running') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(hostB.root.agent.status, 'running');

      // Now Root A sends a message while B is busy
      const canary2 = 'canary-busy-queue-message-554433';
      modelA.script.push(
        toolCallChunks('call-send-2', 'arlo_send_message', {
          to: targetEndpointB,
          text: canary2,
        })
      );
      hostA.root.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'send while B is busy' }],
          source: { kind: 'arlo', form: 'relay' },
        })
      );
      await hostA.root.agent.whenIdle();

      // Verify message is queued in hostB's inbox.nextTurn without interrupting the current turn
      assert.equal(hostB.root.agent.status, 'running');
      const nextTurnMsgs = hostB.root.agent.inbox.nextTurn;
      assert.ok(
        nextTurnMsgs.some((m) => m.content?.[0]?.type === 'text' && (m.content[0] as any).text === canary2),
        'Message must be safely queued in nextTurn without preemption'
      );

      // Now release the hold and let B complete both turns
      turnInProgress = false;
      resolveTurn?.();
      await hostB.root.agent.whenIdle();

      // 5. Capacity and Bounds Defense
      // 5a. Oversized text (> 32 KiB) is rejected
      const oversizedText = 'A'.repeat(33 * 1024);
      modelA.script.push(
        toolCallChunks('call-send-oversized', 'arlo_send_message', {
          to: targetEndpointB,
          text: oversizedText,
        })
      );
      hostA.root.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'send oversized' }],
          source: { kind: 'arlo', form: 'relay' },
        })
      );
      await hostA.root.agent.whenIdle();

      const eventsAAfterOversized = hostA.root.agent.session.snapshotEvents();
      const oversizedToolResult = getToolResultEvent(eventsAAfterOversized, 'call-send-oversized');
      assert.ok(
        JSON.stringify(oversizedToolResult).includes(ArloErrorCode.MESSAGE_TOO_LARGE),
        'Oversized text must be rejected with MESSAGE_TOO_LARGE'
      );

      // 5b. Wildcard "to" is rejected
      modelA.script.push(
        toolCallChunks('call-send-wildcard', 'arlo_send_message', {
          to: '*',
          text: 'hello all',
        })
      );
      hostA.root.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'send wildcard' }],
          source: { kind: 'arlo', form: 'relay' },
        })
      );
      await hostA.root.agent.whenIdle();

      const eventsAAfterWildcard = hostA.root.agent.session.snapshotEvents();
      const wildcardResult = getToolResultEvent(eventsAAfterWildcard, 'call-send-wildcard');
      assert.ok(
        JSON.stringify(wildcardResult).includes(ArloErrorCode.INVALID_ARGUMENT),
        'Wildcard target must be rejected with INVALID_ARGUMENT'
      );

      // 5c. Status query through the real adapter tool surface (Issue #9)
      modelA.script.push(
        toolCallChunks('call-status-root', 'arlo_get_message_status', {
          message_id: lastSendResult.message_id,
        })
      );
      hostA.root.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'query my message status' }],
          source: { kind: 'arlo', form: 'relay' },
        })
      );
      await hostA.root.agent.whenIdle();

      const statusText = extractToolResultText(
        hostA.root.agent.session.snapshotEvents(),
        'call-status-root'
      );
      assert.ok(statusText, 'Status query must return a tool result');
      const statusResult = JSON.parse(statusText);
      assert.equal(statusResult.status, 'accepted');
      assert.equal(statusResult.message_id, lastSendResult.message_id);
      assert.equal(statusResult.original_status, 'accepted');
      assert.equal(statusResult.text, undefined, 'Status query must not return message text');
      assert.equal(
        statusText.includes(canary1),
        false,
        'Status query must not leak the message body'
      );

      // A query for a message this root never sent is not an error; it is an
      // explicitly unavailable result.
      modelA.script.push(
        toolCallChunks('call-status-unknown', 'arlo_get_message_status', {
          message_id: 'msg-never-sent-by-this-root',
        })
      );
      hostA.root.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'query an unknown message' }],
          source: { kind: 'arlo', form: 'relay' },
        })
      );
      await hostA.root.agent.whenIdle();

      const unknownStatusText = extractToolResultText(
        hostA.root.agent.session.snapshotEvents(),
        'call-status-unknown'
      );
      assert.equal(JSON.parse(unknownStatusText).reason, ArloErrorCode.RESULT_UNAVAILABLE);

      // 5e. A child agent cannot query the root's messages either.
      modelA.script.push(
        toolCallChunks('call-child-status', 'arlo_get_message_status', {
          message_id: lastSendResult.message_id,
        })
      );
      hostA.child.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'child tries to query status' }],
          source: { kind: 'arlo', form: 'relay' },
        })
      );
      await hostA.child.agent.whenIdle();

      const childStatusEvents = hostA.child.agent.session.snapshotEvents();
      const childStatusResult = getToolResultEvent(childStatusEvents, 'call-child-status');
      assert.ok(
        JSON.stringify(childStatusResult).includes(ArloErrorCode.CALLER_NOT_ROOT),
        'Child status query must fail with CALLER_NOT_ROOT'
      );

      // 5c. Sub-agent caller isolation: child cannot call arlo_send_message
      modelA.script.push(
        toolCallChunks('call-child-send', 'arlo_send_message', {
          to: targetEndpointB,
          text: 'child attempt',
        })
      );
      hostA.child.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'child tries to send' }],
          source: { kind: 'arlo', form: 'relay' },
        })
      );
      await hostA.child.agent.whenIdle();

      const eventsChildA = hostA.child.agent.session.snapshotEvents();
      const childResult = getToolResultEvent(eventsChildA, 'call-child-send') ??
        eventsChildA.find((e) => e.type === 'tool/result');
      assert.ok(
        JSON.stringify(childResult).includes(ArloErrorCode.CALLER_NOT_ROOT),
        'Child tool execution must fail with CALLER_NOT_ROOT'
      );

      // 6. Privacy canary check in audit logs
      const logDir = path.join(stateDir, 'logs');
      if (fs.existsSync(logDir)) {
        const logFiles = fs.readdirSync(logDir).filter((f) => f.endsWith('.log') || f.endsWith('.jsonl'));
        for (const file of logFiles) {
          const content = fs.readFileSync(path.join(logDir, file), 'utf8');
          assert.equal(
            content.includes(canary1),
            false,
            `Canary 1 must never be leaked into audit log ${file}`
          );
          assert.equal(
            content.includes(canary2),
            false,
            `Canary 2 must never be leaked into audit log ${file}`
          );
        }
      }
    } finally {
      await hostA.dispose();
      await hostB.dispose();
    }
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
