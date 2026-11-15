import assert from 'node:assert/strict';
import https from 'node:https';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPinnedHttpsAgent, sendSecureArloRequest } from '@arlo/sdk';
import { DAEMON_CERT, DAEMON_KEY } from '../probes/tls-fixtures.ts';

test('An interrupted TLS response rejects the control request instead of leaving accounting pending', { timeout: 5000 }, async () => {
  const server = https.createServer({ cert: DAEMON_CERT, key: DAEMON_KEY }, (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
    res.write('{');
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = createPinnedHttpsAgent(DAEMON_CERT);
  try {
    const outcome = await Promise.race([
      sendSecureArloRequest({
        url: `https://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/control/v1/roots/credit`,
        // The abort must settle before the independent request deadline.
        agent, timeoutMs: 2000,
      }).then(() => 'accepted', (error: { code?: string }) => error.code),
      delay(500, 'still-pending'),
    ]);
    assert.equal(outcome, 'CONNECTION_FAILED');
  } finally {
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('A trickling TLS response cannot extend the control request deadline or retain its socket', { timeout: 5000 }, async () => {
  const closed = Promise.withResolvers<void>();
  const server = https.createServer({ cert: DAEMON_CERT, key: DAEMON_KEY }, (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    const timer = setInterval(() => res.write(' '), 25);
    res.on('close', () => { clearInterval(timer); closed.resolve(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = createPinnedHttpsAgent(DAEMON_CERT);
  try {
    const outcome = await Promise.race([
      sendSecureArloRequest({
        url: `https://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/control/v1/roots/credit`,
        agent, timeoutMs: 200,
      }).then(() => 'accepted', (error: { code?: string }) => error.code),
      delay(1000, 'still-pending'),
    ]);
    assert.equal(outcome, 'CONNECTION_FAILED');
    assert.equal(await Promise.race([closed.promise.then(() => 'closed'), delay(500, 'open')]), 'closed');
  } finally {
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
