import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ArloErrorCode,
  MAX_REPLY_DEPTH,
  arloNotificationSchema,
  ARLO_PROFILE_VERSION,
  type ArloMessageNotificationParams,
} from '@arlo/sdk';
import { MessageStatusFixture, TestClock } from './helpers/message-status-fixture.ts';

/** Submits a receipt derived from the notification frame itself. */
function receiptFrom(
  params: ArloMessageNotificationParams,
  status: 'enqueued' | 'not_enqueued' | 'uncertain',
  extra: { reason?: string; native_message_id?: string } = {}
) {
  return {
    daemon_id: params.daemon_id,
    message_id: params.message_id,
    delivery_id: params.delivery_id,
    generation: params.target_generation,
    status,
    ...extra,
  };
}

/** Arms an enqueued receipt for every frame a fixture root receives. */
function autoAck(fixture: MessageStatusFixture, rootIndex: number): void {
  fixture.roots[rootIndex].onNotification(async (params, root) => {
    await fixture.control.submitReceipt(root.registration.root_token, {
      endpoint_id: root.registration.endpoint_id,
      ...receiptFrom(params, 'enqueued', { native_message_id: `native-${params.message_id}` }),
    });
  });
}

function endpoint(fixture: MessageStatusFixture, index: number): string {
  return fixture.roots[index].registration.endpoint_id;
}

test('A definitively rejected delivery cannot become reply context', async () => {
  const fixture = await MessageStatusFixture.create({ roots: 2 });
  try {
    // Durable fixture authorization must finish before the ACK observation.
    for (const root of fixture.roots) await fixture.control.fixtureAuthorize(root.registration);
    autoAck(fixture, 0);
    fixture.roots[1].onNotification(async (params, root) => {
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id,
        ...receiptFrom(params, 'not_enqueued', { reason: ArloErrorCode.QUEUE_LIMIT }),
      });
    });
    const original = await fixture.send(0, 1, 'never entered the receiving session');
    assert.equal(original.status, 'rejected');
    await assert.rejects(fixture.roots[1].connection.sendMessage({
      to: endpoint(fixture, 0), text: 'invalid context', reply_to: original.message_id,
    }), (error: any) => error.code === ArloErrorCode.INVALID_REPLY);
  } finally {
    await fixture.dispose();
  }
});

test('A received message can be replied to before its ACK or after an uncertain receipt', { timeout: 60000 }, async () => {
  const fixture = await MessageStatusFixture.create({ roots: 2 });
  try {
    // A first reply must not spend its parent's ACK window opening a period.
    for (const root of fixture.roots) await fixture.control.fixtureAuthorize(root.registration);
    autoAck(fixture, 0);
    const replies: string[] = [];
    const completed = Promise.withResolvers<void>();
    fixture.roots[1].onNotification(async (params, root) => {
      if (params.text === 'uncertain parent') {
        await fixture.control.submitReceipt(root.registration.root_token, {
          endpoint_id: root.registration.endpoint_id,
          ...receiptFrom(params, 'uncertain', { reason: ArloErrorCode.ENQUEUE_UNCERTAIN }),
        });
      }
      const reply = await root.connection.sendMessage({
        to: params.from_endpoint, text: 'received despite missing ACK', reply_to: params.message_id,
      });
      replies.push(reply.status);
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id,
        ...receiptFrom(params, 'enqueued', { native_message_id: `native-${params.message_id}` }),
      });
      if (replies.length === 2) completed.resolve();
    });
    for (const text of ['in-flight parent', 'uncertain parent']) {
      const parent = await fixture.send(0, 1, text);
      if (text === 'in-flight parent') {
        assert.equal(parent.status, 'accepted', 'The reply completes before the parent ACK is submitted');
      } else {
        assert.equal(parent.status, 'unknown', 'The parent uncertain receipt settles before its reply completes');
        assert.equal(parent.reason, ArloErrorCode.ENQUEUE_UNCERTAIN);
      }
    }
    // The uncertain send may have returned before the reply finishes.
    await completed.promise;
    assert.deepEqual(replies, ['accepted', 'accepted']);
  } finally {
    await fixture.dispose();
  }
});

test('A reply between two real roots carries the authorised parent association and a fresh business UUID', async () => {
  const fixture = await MessageStatusFixture.create({ roots: 2 });
  try {
    autoAck(fixture, 0);
    autoAck(fixture, 1);

    const original = await fixture.send(0, 1, 'please summarise ticket 42');
    assert.equal(original.status, 'accepted');
    const parentFrame = fixture.frameFor(1, original.message_id);
    assert.equal(parentFrame.reply_to, undefined, 'a new message carries no reply association');
    assert.equal(parentFrame.reply_depth, undefined);

    // The receiving root replies, citing the inbound message it actually received.
    const reply = await fixture.roots[1].connection.sendMessage({
      to: endpoint(fixture, 0),
      text: 'ticket 42 is summarised in the attached notes',
      reply_to: parentFrame.message_id,
    });
    assert.equal(reply.status, 'accepted', 'an authorised reply follows the normal send path');
    assert.notEqual(
      reply.message_id,
      parentFrame.message_id,
      'the SDK must generate a new business UUID for the reply, never reuse the parent ID'
    );

    // The original sender's notification frame keeps the parent association and
    // the full Arlo external-source binding. The real SDK connection validated
    // this frame through arloNotificationSchema before it was observed here.
    const replyFrame = fixture.frameFor(0, reply.message_id);
    assert.equal(replyFrame.reply_to, parentFrame.message_id);
    assert.equal(replyFrame.reply_depth, 1);
    assert.equal(replyFrame.from_endpoint, endpoint(fixture, 1));
    assert.equal(replyFrame.to_endpoint, endpoint(fixture, 0));
    assert.equal(replyFrame.protocol_version, ARLO_PROFILE_VERSION);
    assert.equal(replyFrame.group_id, parentFrame.group_id);
    assert.ok(replyFrame.daemon_id);
    const validated = arloNotificationSchema['~standard'].validate(replyFrame);
    assert.ok('value' in validated, 'the reply frame must satisfy the published notification schema');
  } finally {
    await fixture.dispose();
  }
});

test('The daemon computes reply depth from its own association and stops at the default limit', async () => {
  const fixture = await MessageStatusFixture.create({ roots: 2 });
  try {
    autoAck(fixture, 0);
    autoAck(fixture, 1);

    let parent = (await fixture.send(0, 1, 'chain root')).message_id;
    let sender = 1;
    let receiver = 0;
    for (let depth = 1; depth <= MAX_REPLY_DEPTH; depth++) {
      const res = await fixture.roots[sender].connection.sendMessage({
        to: endpoint(fixture, receiver),
        text: `chain reply ${depth}`,
        reply_to: parent,
      });
      assert.equal(res.status, 'accepted', `a reply at depth ${depth} is inside the limit`);
      assert.notEqual(res.message_id, parent);
      const frame = fixture.frameFor(receiver, res.message_id);
      assert.equal(frame.reply_depth, depth, `the daemon derived depth ${depth} from its own records`);
      assert.equal(frame.reply_to, parent);
      parent = res.message_id;
      [sender, receiver] = [receiver, sender];
    }

    // The root that received the depth-8 message cannot extend the chain to 9.
    await assert.rejects(
      fixture.roots[sender].connection.sendMessage({
        to: endpoint(fixture, receiver),
        text: 'one reply too deep',
        reply_to: parent,
      }),
      (err: any) => err.code === ArloErrorCode.REPLY_DEPTH_LIMIT
    );

    // The model can neither declare nor forge the depth argument.
    await assert.rejects(
      fixture.roots[sender].connection.sendMessage({
        to: endpoint(fixture, receiver),
        text: 'forged depth',
        reply_to: parent,
        reply_depth: 0,
      } as any),
      (err: any) => err.code === ArloErrorCode.INVALID_ARGUMENT
    );
  } finally {
    await fixture.dispose();
  }
});

test('A reply reference must be an inbound message of the replying endpoint, never another root or the caller itself', async () => {
  const fixture = await MessageStatusFixture.create({ roots: 3 });
  try {
    autoAck(fixture, 0);
    autoAck(fixture, 1);
    autoAck(fixture, 2);

    // C sends privately to A: the message is A's inbound context, not B's.
    const privateToA = await fixture.send(2, 0, 'private context for A only');
    assert.equal(privateToA.status, 'accepted');

    await assert.rejects(
      fixture.roots[1].connection.sendMessage({
        to: endpoint(fixture, 0),
        text: 'replying to a context I never received',
        reply_to: privateToA.message_id,
      }),
      (err: any) => err.code === ArloErrorCode.INVALID_REPLY
    );

    // A cannot cite its own outbound message as an inbound parent.
    const aToB = await fixture.send(0, 1, 'A to B');
    await assert.rejects(
      fixture.roots[0].connection.sendMessage({
        to: endpoint(fixture, 1),
        text: 'replying to my own sent message',
        reply_to: aToB.message_id,
      }),
      (err: any) => err.code === ArloErrorCode.INVALID_REPLY
    );

    // Unknown references and malformed arguments are distinct failures.
    await assert.rejects(
      fixture.roots[1].connection.sendMessage({
        to: endpoint(fixture, 0),
        text: 'replying to a message that never existed',
        reply_to: 'msg-never-existed',
      }),
      (err: any) => err.code === ArloErrorCode.INVALID_REPLY
    );
    await assert.rejects(
      fixture.roots[1].connection.sendMessage({
        to: endpoint(fixture, 0),
        text: 'malformed reference',
        reply_to: '',
      } as any),
      (err: any) => err.code === ArloErrorCode.INVALID_ARGUMENT
    );
  } finally {
    await fixture.dispose();
  }
});

test('The reply target must be the original sender of the referenced message, and a replayed reply stays idempotent', async () => {
  const fixture = await MessageStatusFixture.create({ roots: 3 });
  try {
    autoAck(fixture, 0);
    autoAck(fixture, 1);
    autoAck(fixture, 2);

    const aToB = await fixture.send(0, 1, 'context that must not be misrouted');
    assert.equal(aToB.status, 'accepted');

    // Redirecting the reply to a third same-group endpoint is an illegal reference.
    await assert.rejects(
      fixture.roots[1].connection.sendMessage({
        to: endpoint(fixture, 2),
        text: 'misrouted reply',
        reply_to: aToB.message_id,
      }),
      (err: any) => err.code === ArloErrorCode.INVALID_REPLY
    );

    // A cross-group endpoint is equally unreachable through a reply association.
    const rt = await fixture.control.registerRuntime({ host_type: 'deepseek-harness' });
    const outsider = await fixture.control.registerRoot(rt.runtime_token, {
      root_session_id: 'host-outsider',
      group_name: 'team-outsider',
      agent_incarnation: 'inc-outsider',
      plugin_generation: 1,
    });
    await assert.rejects(
      fixture.roots[1].connection.sendMessage({
        to: outsider.endpoint_id,
        text: 'cross-group reply attempt',
        reply_to: aToB.message_id,
      }),
      (err: any) => err.code === ArloErrorCode.INVALID_REPLY
    );

    // A correct reply is admitted; replaying the identical request returns the
    // original result without a second dispatch.
    const reply = await fixture.roots[1].connection.sendMessage({
      to: endpoint(fixture, 0),
      text: 'correctly routed reply',
      reply_to: aToB.message_id,
    });
    assert.equal(reply.status, 'accepted');
    assert.equal(fixture.frameFor(0, reply.message_id).reply_to, aToB.message_id);
    const dispatches = fixture.roots[0].notifications.filter((n) => n.message_id === reply.message_id).length;
    const replay = await fixture.roots[1].connection.sendMessage(
      { to: endpoint(fixture, 0), text: 'correctly routed reply', reply_to: aToB.message_id },
      reply.message_id
    );
    assert.equal(replay.status, 'accepted');
    assert.equal(
      fixture.roots[0].notifications.filter((n) => n.message_id === reply.message_id).length,
      dispatches,
      'a replayed reply must not dispatch again'
    );

    // Reusing the same reply ID with a different association is a conflict.
    const otherParent = (await fixture.send(0, 1, 'another context')).message_id;
    await assert.rejects(
      fixture.roots[1].connection.sendMessage(
        { to: endpoint(fixture, 0), text: 'correctly routed reply', reply_to: otherParent },
        reply.message_id
      ),
      (err: any) => err.code === ArloErrorCode.MESSAGE_ID_CONFLICT
    );
  } finally {
    await fixture.dispose();
  }
});

test('An offline original sender fails through the unified send path, not the association', async () => {
  const fixture = await MessageStatusFixture.create({ roots: 2 });
  try {
    autoAck(fixture, 1);
    const aToB = await fixture.send(0, 1, 'context from a root that will go offline');
    assert.equal(aToB.status, 'accepted');

    // Dropping the transport leaves the endpoint registered but undeliverable.
    fixture.roots[0].connection.dispose();
    assert.ok(
      await fixture.waitForDeliverable(0, false),
      'the daemon must stop advertising the disconnected endpoint as deliverable'
    );

    await assert.rejects(
      fixture.roots[1].connection.sendMessage({
        to: endpoint(fixture, 0),
        text: 'reply to an offline sender',
        reply_to: aToB.message_id,
      }),
      (err: any) => err.code === ArloErrorCode.TARGET_UNAVAILABLE
    );
  } finally {
    await fixture.dispose();
  }
});

test('A replaced original sender cannot be addressed by a reply, not even a same-Session successor', async () => {
  const fixture = await MessageStatusFixture.create({ roots: 2 });
  try {
    autoAck(fixture, 1);
    const aToB = await fixture.send(0, 1, 'context whose sender will be replaced');
    assert.equal(aToB.status, 'accepted');

    await fixture.control.revokeRoot(fixture.roots[0].registration.root_token, {
      endpoint_id: fixture.roots[0].registration.endpoint_id,
    });

    await assert.rejects(
      fixture.roots[1].connection.sendMessage({
        to: endpoint(fixture, 0),
        text: 'reply to a replaced sender',
        reply_to: aToB.message_id,
      }),
      (err: any) => err.code === ArloErrorCode.INVALID_REPLY
    );

    // A newly registered successor for the same host session gets a new opaque
    // endpoint ID; the association must never be re-targeted onto it.
    const successor = await fixture.control.registerRoot(
      (await fixture.control.registerRuntime({ host_type: 'deepseek-harness' })).runtime_token,
      {
        root_session_id: 'host-status-0',
        group_name: 'team-status',
        agent_incarnation: 'inc-successor',
        plugin_generation: 1,
      }
    );
    assert.notEqual(successor.endpoint_id, fixture.roots[0].registration.endpoint_id);
    await assert.rejects(
      fixture.roots[1].connection.sendMessage({
        to: successor.endpoint_id,
        text: 'reply redirected to a same-session successor',
        reply_to: aToB.message_id,
      }),
      (err: any) => err.code === ArloErrorCode.INVALID_REPLY
    );
  } finally {
    await fixture.dispose();
  }
});

test('An expired settled record invalidates the reply context without leaking whether the message existed', async () => {
  const clock = new TestClock();
  const fixture = await MessageStatusFixture.create({ roots: 2, now: clock.now, messageRecordTtlMs: 1000 });
  try {
    autoAck(fixture, 1);
    const aToB = await fixture.send(0, 1, 'context that will expire');
    assert.equal(aToB.status, 'accepted');

    // Settle the record completely: result accepted and pending credit released.
    await fixture.control.releaseCredit(fixture.roots[1].registration.root_token, {
      endpoint_id: fixture.roots[1].registration.endpoint_id,
      message_id: aToB.message_id,
      native_message_id: `native-${aToB.message_id}`,
      event: 'claimed',
    });

    clock.advance(2000);
    await assert.rejects(
      fixture.roots[1].connection.sendMessage({
        to: endpoint(fixture, 0),
        text: 'reply after the context expired',
        reply_to: aToB.message_id,
      }),
      (err: any) => err.code === ArloErrorCode.INVALID_REPLY
    );
  } finally {
    await fixture.dispose();
  }
});

test('A reply consumes target admission like any send and cannot bypass a full queue', { timeout: 90000 }, async () => {
  const fixture = await MessageStatusFixture.create({ roots: 2 });
  try {
    autoAck(fixture, 0);
    autoAck(fixture, 1);

    // The parent A→B settles normally on B's side.
    const parent = await fixture.send(0, 1, 'context for the capacity probe');
    assert.equal(parent.status, 'accepted');

    // Enqueued receipts settle each send while A holds all 64 pending credits.
    // Let the real human grant renew between sends; it must not race an ACK
    // window belonging to this pending-capacity regression.
    const fillers = [];
    for (let index = 0; index < 64; index++) {
      const filler = await fixture.send(1, 0, `filler ${index}`);
      assert.equal(filler.status, 'accepted');
      fillers.push(filler);
    }
    assert.equal(fixture.roots[0].notifications.length, 64, 'All capacity fillers reached the target');

    const beforeRejectedReply = await fixture.control.fixtureSendingStatus(fixture.roots[1].registration);
    await assert.rejects(
      fixture.roots[1].connection.sendMessage({
        to: endpoint(fixture, 0),
        text: 'reply bypass attempt',
        reply_to: parent.message_id,
      }),
      (err: any) => err.code === ArloErrorCode.QUEUE_LIMIT
    );
    const afterRejectedReply = await fixture.control.fixtureSendingStatus(fixture.roots[1].registration);
    assert.equal(afterRejectedReply.period_id, beforeRejectedReply.period_id);
    assert.equal(afterRejectedReply.used, beforeRejectedReply.used, 'A full queue consumes no autonomous attempt');

    // Release the queue; the identical reply is then admitted, proving the
    // rejection came from the ordinary admission rule rather than the association.
    // An enqueued receipt alone never frees credit: consumption does.
    const observed = fixture.roots[0].notifications.splice(0);
    for (const params of observed) {
      await fixture.control.submitReceipt(fixture.roots[0].registration.root_token, {
        endpoint_id: fixture.roots[0].registration.endpoint_id,
        ...receiptFrom(params, 'enqueued', { native_message_id: `native-${params.message_id}` }),
      });
    }
    await assert.rejects(
      fixture.roots[1].connection.sendMessage({
        to: endpoint(fixture, 0), text: 'reply after receipt retry', reply_to: parent.message_id,
      }),
      (err: any) => err.code === ArloErrorCode.QUEUE_LIMIT,
      'Enqueued receipts and their retries never release the full pending credit'
    );
    for (const params of observed) {
      await fixture.control.releaseCredit(fixture.roots[0].registration.root_token, {
        endpoint_id: fixture.roots[0].registration.endpoint_id,
        message_id: params.message_id,
        native_message_id: `native-${params.message_id}`,
        event: 'claimed',
      });
    }
    for (const outcome of fillers) {
      assert.equal(outcome.status, 'accepted');
    }
    const after = await fixture.roots[1].connection.sendMessage({
      to: endpoint(fixture, 0),
      text: 'reply after capacity freed',
      reply_to: parent.message_id,
    });
    assert.equal(after.status, 'accepted');
    assert.equal(fixture.frameFor(0, after.message_id).reply_to, parent.message_id);
  } finally {
    await fixture.dispose();
  }
});
