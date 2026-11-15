import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import {
  arloNotificationSchema,
  ARLO_NOTIFICATION_METHOD,
  ARLO_MESSAGE_ID_META_KEY,
  ARLO_PINNED_WIRE_REVISION,
  ARLO_PROFILE_VERSION,
  type ArloMessageNotificationParams,
  type ArloSendMessageArgs,
  type SessionDiscoveryItem,
} from '@arlo/sdk';

test('Seam 1: arloNotificationSchema validates wire notification frames', () => {
  const validFrame: ArloMessageNotificationParams = {
    protocol_version: ARLO_PROFILE_VERSION,
    daemon_id: 'daemon-1',
    message_id: 'msg-1',
    delivery_id: 'del-1',
    from_endpoint: 'ep-sender',
    to_endpoint: 'ep-receiver',
    group_id: 'grp-test',
    target_generation: 1,
    delivery_seq: '1',
    text: 'hello world',
    sent_at: new Date().toISOString(),
  };

  const validation = arloNotificationSchema['~standard'].validate(validFrame);
  assert.ok('value' in validation, 'Valid frame should pass validation');
  assert.deepEqual(validation.value, validFrame);

  // Missing message_id
  const invalid1 = arloNotificationSchema['~standard'].validate({
    ...validFrame,
    message_id: '',
  });
  assert.ok('issues' in invalid1);

  // Incompatible protocol version
  const invalid2 = arloNotificationSchema['~standard'].validate({
    ...validFrame,
    protocol_version: '0.2',
  });
  assert.ok('issues' in invalid2);

  // Non-decimal or non-positive delivery_seq
  const invalid3 = arloNotificationSchema['~standard'].validate({
    ...validFrame,
    delivery_seq: '0',
  });
  assert.ok('issues' in invalid3);

  const invalid4 = arloNotificationSchema['~standard'].validate({
    ...validFrame,
    delivery_seq: '-5',
  });
  assert.ok('issues' in invalid4);

  // Non-integer target_generation
  const invalid5 = arloNotificationSchema['~standard'].validate({
    ...validFrame,
    target_generation: 1.5,
  });
  assert.ok('issues' in invalid5);

  // Reply association fields: the daemon emits reply_to and reply_depth as one
  // indivisible pair, so an empty parent, an out-of-range or zero depth, a
  // parent without a depth, and a bare depth without a parent all fail.
  const invalidReplyEmpty = arloNotificationSchema['~standard'].validate({
    ...validFrame,
    reply_to: '',
    reply_depth: 1,
  });
  assert.ok('issues' in invalidReplyEmpty);

  const invalidReplyDepthTooHigh = arloNotificationSchema['~standard'].validate({
    ...validFrame,
    reply_to: 'msg-parent',
    reply_depth: 99,
  });
  assert.ok('issues' in invalidReplyDepthTooHigh);

  const invalidReplyDepthZero = arloNotificationSchema['~standard'].validate({
    ...validFrame,
    reply_to: 'msg-parent',
    reply_depth: 0,
  });
  assert.ok('issues' in invalidReplyDepthZero);

  const invalidParentWithoutDepth = arloNotificationSchema['~standard'].validate({
    ...validFrame,
    reply_to: 'msg-parent',
  });
  assert.ok('issues' in invalidParentWithoutDepth);

  const invalidDepthWithoutParent = arloNotificationSchema['~standard'].validate({
    ...validFrame,
    reply_depth: 2,
  });
  assert.ok('issues' in invalidDepthWithoutParent);

  const validReply = arloNotificationSchema['~standard'].validate({
    ...validFrame,
    reply_to: 'msg-parent',
    reply_depth: 3,
  });
  assert.ok('value' in validReply, 'a complete reply association must validate');
});

test('Seam 1: RootConnection receives SSE notification and executes sendMessage tool call', async () => {
  let sseRes: http.ServerResponse | undefined;
  const receivedToolCalls: any[] = [];
  const https = await import('node:https');
  const { DAEMON_CERT, DAEMON_KEY } = await import('../probes/tls-fixtures.ts');
  const { createPinnedHttpsAgent } = await import('@arlo/sdk');

  const server = https.createServer({ cert: DAEMON_CERT, key: DAEMON_KEY }, (req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const rpc = JSON.parse(body);
        if (rpc.method === 'initialize') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'mcp-session-id': 'sess-test-123',
          });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: ARLO_PINNED_WIRE_REVISION,
              capabilities: {
                experimental: { 'arlo/session-messaging': { version: '0.1' } },
                tools: {},
              },
              serverInfo: { name: 'test-daemon', version: '0.1.0' },
            },
          }));
        } else if (rpc.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
        } else if (rpc.method === 'tools/call') {
          receivedToolCalls.push(rpc);
          res.writeHead(200, {
            'content-type': 'application/json',
            'mcp-session-id': 'sess-test-123',
          });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'accepted',
                  message_id: rpc.params?._meta?.[ARLO_MESSAGE_ID_META_KEY],
                }),
              }],
            },
          }));
        }
      });
    } else if (req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'mcp-session-id': 'sess-test-123',
      });
      res.flushHeaders();
      sseRes = res;
    }
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;

  const { RootConnection } = await import('@arlo/sdk');

  const connection = new RootConnection({
    url: new URL(`https://127.0.0.1:${port}/mcp`),
    agent: createPinnedHttpsAgent(DAEMON_CERT),
    binding: {
      endpoint_id: 'ep-root-test',
      generation: 1,
      root_token: 'test-token',
      group_id: 'grp-test',
      status: 'registered',
      ready: false,
      deliverable: false,
    },
  });

  try {
    const receivedNotifications: ArloMessageNotificationParams[] = [];
    const unsubscribe = connection.onNotification((params) => {
      receivedNotifications.push(params);
    });

    // Subscribing creates the handler on connection
    assert.equal(typeof unsubscribe, 'function');

    await connection.connect();
    assert.equal(connection.binding.endpoint_id, 'ep-root-test');

    // Send a message via sendMessage
    const sendRes = await connection.sendMessage({
      to: 'ep-target',
      text: 'hello from test',
    });
    assert.equal(sendRes.status, 'accepted');
    assert.ok(sendRes.message_id);

    // Verify _meta container had message-id
    assert.equal(receivedToolCalls.length, 1);
    assert.equal(receivedToolCalls[0].params.name, 'arlo_send_message');
    assert.equal(receivedToolCalls[0].params._meta[ARLO_MESSAGE_ID_META_KEY], sendRes.message_id);
    assert.equal(receivedToolCalls[0].params.arguments.to, 'ep-target');
    assert.equal(receivedToolCalls[0].params.arguments.text, 'hello from test');

    // Wait for SSE GET connection
    while (!sseRes) {
      await new Promise(r => setTimeout(r, 10));
    }

    // Send notification frame over SSE
    const testFrame: ArloMessageNotificationParams = {
      protocol_version: '0.1',
      daemon_id: 'daemon-test',
      message_id: 'msg-sse-1',
      delivery_id: 'del-sse-1',
      from_endpoint: 'ep-target',
      to_endpoint: 'ep-root-test',
      group_id: 'grp-test',
      target_generation: 1,
      delivery_seq: '1',
      text: 'inbound sse message',
      sent_at: new Date().toISOString(),
    };

    sseRes.write(`event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      method: ARLO_NOTIFICATION_METHOD,
      params: testFrame,
    })}\n\n`);

    while (receivedNotifications.length === 0) {
      await new Promise(r => setTimeout(r, 10));
    }

    assert.equal(receivedNotifications.length, 1);
    assert.deepEqual(receivedNotifications[0], testFrame);

    unsubscribe();
  } finally {
    connection.dispose();
    server.close();
  }
});

test('Seam 1: ControlClient sends confirmRootReady, submitReceipt, and releaseCredit', async () => {
  const https = await import('node:https');
  const { DAEMON_CERT, DAEMON_KEY } = await import('../probes/tls-fixtures.ts');
  const { ControlClient } = await import('@arlo/sdk');
  const calls: { url: string; method: string; body: any; token?: string }[] = [];

  const server = https.createServer({ cert: DAEMON_CERT, key: DAEMON_KEY }, (req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const parsedBody = body ? JSON.parse(body) : undefined;
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      calls.push({ url: req.url!, method: req.method!, body: parsedBody, token });

      if (req.url === '/control/v1/roots/ready') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ endpoint_id: parsedBody.endpoint_id, status: 'ready', ready: true, deliverable: true }));
      } else if (req.url === '/control/v1/roots/receipt') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else if (req.url === '/control/v1/roots/credit') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;

  const control = new ControlClient({ port, pinnedCertPem: DAEMON_CERT });

  try {
    const readyRes = await control.confirmRootReady('tok-1', { endpoint_id: 'ep-1' });
    assert.equal(readyRes.status, 'ready');
    assert.equal(readyRes.ready, true);
    assert.equal(readyRes.deliverable, true);

    const receiptRes = await control.submitReceipt('tok-1', {
      daemon_id: 'd-1',
      endpoint_id: 'ep-1',
      message_id: 'm-1',
      delivery_id: 'del-1',
      generation: 1,
      status: 'enqueued',
    });
    assert.equal(receiptRes.status, 'ok');

    const creditRes = await control.releaseCredit('tok-1', {
      endpoint_id: 'ep-1',
      message_id: 'm-1',
      event: 'claimed',
    });
    assert.equal(creditRes.status, 'ok');

    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, '/control/v1/roots/ready');
    assert.equal(calls[0].token, 'tok-1');
    assert.equal(calls[1].url, '/control/v1/roots/receipt');
    assert.equal(calls[2].url, '/control/v1/roots/credit');
  } finally {
    server.close();
  }
});
