import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, LocalModel } from './fixture.ts';
import {
  TransportDeduplicator,
  McpStreamableHttpTestRig,
  type ArloDeliveryFrame,
} from './transport-retry-defense.ts';
import { ArloProtocolErrorCode } from './mcp-metadata.ts';
import { ARLO_PINNED_WIRE_REVISION } from './mcp-notification.ts';
import { recordProbeEvidence } from './evidence.ts';

test('pending credit survives ACK, connection generation changes and real post-insertion failure', async () => {
  const host = await fixture();
  const deduplicator = new TransportDeduplicator({ agent: host.root.agent, currentGeneration: 1, initialCapacity: 1 });
  const stopThrowing = host.ctx.on('internal/dispatch', (_type, name) => {
    if (name === 'agent/inbox/inserted') throw new Error('FICTIONAL_AFTER_INSERT');
  });
  const frame: ArloDeliveryFrame = {
    protocol_version: '0.1', daemon_id: 'daemon', message_id: 'message', delivery_id: 'delivery',
    from_endpoint: 'sender', to_endpoint: 'receiver', group_id: 'group', target_generation: 1,
    delivery_seq: '1', text: 'fictional retained pending input', reply_depth: 0, sent_at: new Date().toISOString(),
  };
  try {
    assert.equal((await deduplicator.receiveFrame(frame)).status, 'unknown');
    assert.equal(host.root.agent.inbox.nextTurn.length, 1);
    const afterInsertionFailure = { pending: host.root.agent.inbox.nextTurn.length, available: deduplicator.getAvailableCapacity() };
    assert.equal(afterInsertionFailure.available, 0);
    const firstAck = deduplicator.submitAck(frame.delivery_id);
    const repeatedAck = deduplicator.submitAck(frame.delivery_id);
    assert.equal(firstAck.quotaReleased, false);
    assert.equal(repeatedAck.duplicate, true);
    deduplicator.advanceGeneration(2);
    const afterGeneration = deduplicator.getAvailableCapacity();
    assert.equal(afterGeneration, 0);
    stopThrowing();
    assert.equal((await deduplicator.receiveFrame({ ...frame, message_id: 'second', target_generation: 2 })).reason, 'QUEUE_LIMIT');
    assert.equal(host.root.agent.inbox.remove(host.root.agent.inbox.nextTurn[0]!.id), true);
    assert.equal(deduplicator.getAvailableCapacity(), 1);
    assert.equal((await deduplicator.receiveFrame({ ...frame, message_id: 'third', target_generation: 2 })).status, 'enqueued');
    await host.root.agent.whenIdle();
    assert.equal(deduplicator.getAvailableCapacity(), 1);
    recordProbeEvidence('pendingCredit', { afterInsertionFailure, firstAck, repeatedAck, afterGeneration, afterClaim: deduplicator.getAvailableCapacity() });
  } finally {
    stopThrowing();
    await host.ctx.fiber.dispose();
  }
});

test('Seam 4.1: concurrent duplicate frames enter the real host once', async () => {
  const model = new LocalModel();
  const host = await fixture(model);

  try {
    const deduplicator = new TransportDeduplicator({
      agent: host.root.agent,
      windowSize: 1024,
      currentGeneration: 1,
    });

    const baseFrame: ArloDeliveryFrame = {
      protocol_version: '0.1',
      daemon_id: 'daemon-test-1',
      message_id: 'msg-concurrent-1',
      delivery_id: 'del-001',
      from_endpoint: 'ep-sender',
      to_endpoint: 'ep-root',
      group_id: 'group-default',
      target_generation: 1,
      delivery_seq: '1',
      text: 'concurrent message test',
      reply_depth: 0,
      sent_at: new Date().toISOString(),
    };

    const inserted: string[] = [];
    host.ctx.on('agent/inbox/inserted', ({ message }) => {
      const text = (message.content[0] as any)?.text;
      if (text) inserted.push(text);
    });

    // 1. Concurrent duplicate frames (two concurrent deliveries of the same frame)
    const [resultA, resultB] = await Promise.all([
      deduplicator.receiveFrame(baseFrame),
      deduplicator.receiveFrame(baseFrame),
    ]);

    // Both return valid reception statuses without error
    assert.ok(resultA.status === 'enqueued' || resultA.status === 'duplicate');
    assert.ok(resultB.status === 'enqueued' || resultB.status === 'duplicate');

    // Wait for agent to process idle turn
    await host.root.agent.whenIdle();

    // Critically: exactly ONE message enters host inbox
    const concurrentInserted = inserted.filter(t => t === 'concurrent message test');
    assert.equal(concurrentInserted.length, 1, 'Concurrent frames must insert into host inbox exactly once');

  } finally {
    await host.ctx.fiber.dispose();
  }
});

test('Seam 4.2: Sliding window out-of-order, stale sequence rejection, eviction defense, stale generation, and idempotent ACK', async () => {
  const model = new LocalModel();
  const host = await fixture(model);
  const release = Promise.withResolvers<void>();
  const maintenance = host.root.agent.runMaintenance(() => release.promise);

  try {
    const windowSize = 100;
    const initialCapacity = 10;
    const deduplicator = new TransportDeduplicator({
      agent: host.root.agent,
      windowSize,
      currentGeneration: 1,
      initialCapacity,
    });

    const inserted: string[] = [];
    host.ctx.on('agent/inbox/inserted', ({ message }) => {
      const text = (message.content[0] as any)?.text;
      if (text) inserted.push(text);
    });

    const makeFrame = (seq: string, msgId: string, gen = 1): ArloDeliveryFrame => ({
      protocol_version: '0.1',
      daemon_id: 'daemon-test-1',
      message_id: msgId,
      delivery_id: `del-${seq}`,
      from_endpoint: 'ep-sender',
      to_endpoint: 'ep-root',
      group_id: 'group-default',
      target_generation: gen,
      delivery_seq: seq,
      text: `text-seq-${seq}`,
      reply_depth: 0,
      sent_at: new Date().toISOString(),
    });

    // 1. In-window out-of-order frames: seq 10 arrives before seq 8
    const resSeq10 = await deduplicator.receiveFrame(makeFrame('10', 'msg-10'));
    assert.equal(resSeq10.status, 'enqueued');

    const resSeq8 = await deduplicator.receiveFrame(makeFrame('8', 'msg-8'));
    assert.equal(resSeq8.status, 'enqueued', 'In-window out-of-order sequence frame must be accepted');

    // Repeated seq 8 is duplicate
    const resSeq8Dup = await deduplicator.receiveFrame(makeFrame('8', 'msg-8-replay'));
    assert.equal(resSeq8Dup.status, 'duplicate');

    // 2. Exact window boundary and bounded eviction
    // Sequence 200 arrives; with windowSize=100, valid window is [200 - 100 + 1, 200] = [101, 200]
    const resSeq200 = await deduplicator.receiveFrame(makeFrame('200', 'msg-200'));
    assert.equal(resSeq200.status, 'enqueued');

    // Exact lower bound boundary tests:
    // seq 100 is strictly outside window ([101, 200]) -> rejected with stale_sequence
    const resBoundaryBelow = await deduplicator.receiveFrame(makeFrame('100', 'msg-100'));
    assert.equal(resBoundaryBelow.status, 'stale_sequence', 'Sequence 100 must be rejected as stale when window is [101, 200]');
    assert.equal(resBoundaryBelow.reason, ArloProtocolErrorCode.STALE_SEQUENCE);

    // seq 101 is exact lower boundary -> accepted
    const resBoundaryExact = await deduplicator.receiveFrame(makeFrame('101', 'msg-101'));
    assert.equal(resBoundaryExact.status, 'enqueued', 'Sequence 101 is exact lower bound and must be accepted');

    // Verify eviction: old sequences (< 101) like 8 and 10 must have been evicted from seenSequences
    assert.equal(deduplicator.isSequenceSeen('8'), false, 'Sequence 8 must be evicted once window advances past it');
    assert.equal(deduplicator.isSequenceSeen('10'), false, 'Sequence 10 must be evicted once window advances past it');
    assert.ok(deduplicator.getSeenSequencesCount() <= windowSize, 'seenSequences must remain bounded by window size');

    // 3. Stale generation frame rejection
    deduplicator.advanceGeneration(2);
    const resStaleGen = await deduplicator.receiveFrame(makeFrame('201', 'msg-201', 1)); // gen 1 sent to gen 2
    assert.equal(resStaleGen.status, 'rejected');
    assert.equal(resStaleGen.reason, ArloProtocolErrorCode.STALE_GENERATION);

    // Frame with new generation succeeds
    assert.equal(deduplicator.getAvailableCapacity(), 6, 'Generation changes retain all four pending messages');
    const resGen2 = await deduplicator.receiveFrame(makeFrame('1', 'msg-gen2-1', 2));
    assert.equal(resGen2.status, 'enqueued');
    assert.equal(deduplicator.getInFlightCount(), 5);
    assert.equal(deduplicator.getAvailableCapacity(), 5, 'Dispatch reserves one additional pending credit');

    // 4. Observable Idempotent Control Receipt (ACK)
    // Neither initial nor repeated acceptance is evidence of consumption.
    const ack1 = deduplicator.submitAck('del-1');
    assert.equal(ack1.status, 'acknowledged');
    assert.equal(ack1.duplicate, false);
    assert.equal(ack1.quotaReleased, false);
    assert.equal(ack1.retryCount, 1);
    assert.equal(deduplicator.getInFlightCount(), 5);
    assert.equal(deduplicator.getAvailableCapacity(), 5, 'First ACK retains pending credit');

    const inboxCountBeforeDupAck = host.root.agent.inbox.nextTurn.length;

    // Second ACK (duplicate retry): does NOT release quota again, does NOT increase capacity past max, does NOT wake host
    const ack2 = deduplicator.submitAck('del-1');
    assert.equal(ack2.status, 'acknowledged');
    assert.equal(ack2.duplicate, true);
    assert.equal(ack2.quotaReleased, false, 'Duplicate ACK must NOT release quota again');
    assert.equal(ack2.retryCount, 2);
    assert.equal(deduplicator.getInFlightCount(), 5);
    assert.equal(deduplicator.getAvailableCapacity(), 5, 'Duplicate ACK must NOT inflate available capacity');
    assert.equal(host.root.agent.inbox.nextTurn.length, inboxCountBeforeDupAck, 'Duplicate ACK must NOT enqueue any turn into host');

    release.resolve();
    await maintenance;
    await host.root.agent.whenIdle();
    assert.equal(deduplicator.getAvailableCapacity(), 10, 'Actual host claims release pending credit');
  } finally {
    release.resolve();
    await maintenance;
    await host.ctx.fiber.dispose();
  }
});

test('Seam 4.3: Real MCP Streamable HTTP & SSE transport path: POST 500, socket drop, tools/call, and Last-Event-ID replay', { timeout: 10000 }, async () => {
  const model = new LocalModel();
  const host = await fixture(model);

  const deduplicator = new TransportDeduplicator({
    agent: host.root.agent,
    windowSize: 100,
    currentGeneration: 1,
    initialCapacity: 10,
  });

  const rig = new McpStreamableHttpTestRig({
    agent: host.root.agent,
    deduplicator,
  });

  try {
    await rig.start();
    assert.equal(rig.client.getNegotiatedProtocolVersion(), ARLO_PINNED_WIRE_REVISION);

    // 1. tools/call over real Streamable HTTP transport
    const initialEnqueued = rig.metrics.hostEnqueueCount;
    const callRes1: any = await rig.client.callTool({
      name: 'arlo_deliver_message',
      arguments: {
        text: 'hello from streamable http tool call',
        delivery_seq: '1',
        message_id: 'msg-http-tool-1',
      },
      _meta: {
        'arlo/message-id': 'msg-http-tool-1',
      },
    } as any);

    assert.equal(callRes1.content[0].text, 'ENQUEUED');
    assert.equal(rig.metrics.hostEnqueueCount, initialEnqueued + 1);
    assert.equal(rig.metrics.businessDispatchCount, 1);
    assert.ok(rig.metrics.requestCount >= 1, 'HTTP POST must be received');

    // 2. Fault injection: POST 500 Internal Server Error & Retry
    rig.injectPost500Next();
    const before500 = rig.requests.filter(request => request.rpcMethod === 'tools/call').length;
    await assert.rejects(
      async () => {
        await rig.client.callTool({
          name: 'arlo_deliver_message',
          arguments: {
            text: 'retry message after 500',
            delivery_seq: '2',
            message_id: 'msg-http-tool-2',
          },
          _meta: {
            'arlo/message-id': 'msg-http-tool-2',
          },
        } as any);
      },
      /Internal Server Error|500/
    );
    assert.equal(rig.metrics.faultsInjectedCount, 1);
    assert.equal(rig.requests.filter(request => request.rpcMethod === 'tools/call').length, before500 + 1, 'SDK must not retry POST 500');

    // Client retries after 500 error:
    const retryAfter500: any = await rig.client.callTool({
      name: 'arlo_deliver_message',
      arguments: {
        text: 'retry message after 500',
        delivery_seq: '2',
        message_id: 'msg-http-tool-2',
      },
      _meta: {
        'arlo/message-id': 'msg-http-tool-2',
      },
    } as any);
    assert.equal(retryAfter500.content[0].text, 'ENQUEUED');
    // Enqueue count must be exactly 2 (msg 1 and msg 2 once each)
    assert.equal(rig.metrics.hostEnqueueCount, 2, 'Message retried after 500 must enter host inbox exactly once');

    // 3. Fault injection: Abrupt socket destruction after dispatch
    // The server receives POST, deduplicator dispatches, and socket is destroyed before HTTP response
    rig.injectSocketDestroyNext();
    const beforeDrop = rig.requests.filter(request => request.rpcMethod === 'tools/call').length;
    await assert.rejects(
      async () => {
        await rig.client.callTool({
          name: 'arlo_deliver_message',
          arguments: {
            text: 'message with socket drop',
            delivery_seq: '3',
            message_id: 'msg-http-tool-3',
          },
          _meta: {
            'arlo/message-id': 'msg-http-tool-3',
          },
        } as any);
      },
      /fetch failed|aborted|ECONNRESET/
    );
    assert.equal(rig.metrics.faultsInjectedCount, 2);
    assert.equal(rig.requests.filter(request => request.rpcMethod === 'tools/call').length, beforeDrop + 1, 'SDK must not retry a dispatched POST after losing its response');

    // Caller retries delivery of msg-http-tool-3:
    // Deduplicator recognizes already-processed message, suppresses host insertion!
    const retryAfterDrop: any = await rig.client.callTool({
      name: 'arlo_deliver_message',
      arguments: {
        text: 'message with socket drop',
        delivery_seq: '3',
        message_id: 'msg-http-tool-3',
      },
      _meta: {
        'arlo/message-id': 'msg-http-tool-3',
      },
    } as any);
    assert.match(retryAfterDrop.content[0].text, /SUPPRESSED:duplicate/);
    assert.equal(rig.metrics.hostEnqueueCount, 3, 'Message must NOT be enqueued again after transport socket drop');

    // 4. SSE Reconnection and Last-Event-ID duplicate frame suppression
    const sseFrame: ArloDeliveryFrame = {
      protocol_version: '0.1',
      daemon_id: 'daemon-http-rig',
      message_id: 'msg-sse-event-4',
      delivery_id: 'del-4',
      from_endpoint: 'ep-http-sender',
      to_endpoint: 'ep-root',
      group_id: 'group-default',
      target_generation: deduplicator.generation,
      delivery_seq: '4',
      text: 'sse event stream message',
      reply_depth: 0,
      sent_at: new Date().toISOString(),
    };

    const sseResult = await rig.reconnectSseWithReplay(sseFrame);
    assert.equal(sseResult.replayed, true, 'SSE replay upon Last-Event-ID reconnection must be processed');
    assert.equal(sseResult.duplicate, true, 'Replayed SSE event must be identified as duplicate');
    assert.equal(rig.metrics.sseReplayRequests, 1, 'A real GET carrying Last-Event-ID must reach the HTTP listener');
    assert.equal(rig.metrics.hostEnqueueCount, 4, 'Host enqueue count must strictly equal 4 across all tests');

    await host.root.agent.whenIdle();
    assert.equal(rig.metrics.businessDispatchCount, 6);
    assert.equal(rig.metrics.duplicateSuppressedCount, 2);
    assert.equal(rig.requests.filter(request => request.method === 'GET').length, 2);
    recordProbeEvidence('httpAndSse', {
      wireRevision: rig.client.getNegotiatedProtocolVersion(), metrics: rig.metrics,
      requests: rig.requests, timeline: rig.timeline,
    });
  } finally {
    await rig.close();
    await host.ctx.fiber.dispose();
  }
});

