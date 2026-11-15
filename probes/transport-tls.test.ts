import assert from 'node:assert/strict';
import { test } from 'node:test';
import https from 'node:https';
import { recordProbeEvidence } from './evidence.ts';
import { DAEMON_CERT, DAEMON_KEY, IMPOSTER_CERT, IMPOSTER_KEY } from './tls-fixtures.ts';
import {
  createPinnedHttpsAgent,
  sendSecureArloRequest,
  type SecureRequestOptions,
} from './transport-tls.ts';

test('Seam 5.1: Pinned certificate authentication, imposter on port receives 0 bytes of sensitive data, first connect & reconnect', async () => {
  // 1. Start genuine Daemon HTTPS listener on loopback
  let genuineReceivedBodies: string[] = [];
  const genuineServer = https.createServer({ key: DAEMON_KEY, cert: DAEMON_CERT }, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      genuineReceivedBodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
  });

  await new Promise<void>(resolve => genuineServer.listen(0, '127.0.0.1', () => resolve()));
  const genuinePort = (genuineServer.address() as any).port;

  try {
    const agent = createPinnedHttpsAgent(DAEMON_CERT);

    // 2. First connection to genuine server -> succeeds
    const res1 = await sendSecureArloRequest({
      url: `https://127.0.0.1:${genuinePort}/arlo/bootstrap`,
      agent,
      token: 'bootstrap-canary-token-1234',
      body: JSON.stringify({ sensitive: 'payload-1' }),
    });
    assert.equal(res1.status, 200);
    assert.equal(genuineReceivedBodies.length, 1);
    assert.match(genuineReceivedBodies[0], /payload-1/);

    // 3. Reconnection to genuine server -> succeeds
    const res2 = await sendSecureArloRequest({
      url: `https://127.0.0.1:${genuinePort}/arlo/data`,
      agent,
      token: 'bootstrap-canary-token-1234',
      body: JSON.stringify({ sensitive: 'payload-2' }),
    });
    assert.equal(res2.status, 200);
    assert.equal(genuineReceivedBodies.length, 2);

    // 4. Close genuine server and start imposter server on the EXACT SAME PORT
    await new Promise<void>(resolve => genuineServer.close(() => resolve()));

    let imposterReceivedAppBytes = 0;
    let imposterReceivedRequests = 0;
    const imposterServer = https.createServer({ key: IMPOSTER_KEY, cert: IMPOSTER_CERT }, (req, res) => {
      imposterReceivedRequests++;
      req.on('data', chunk => { imposterReceivedAppBytes += chunk.length; });
      req.on('end', () => {
        res.writeHead(200);
        res.end();
      });
    });

    await new Promise<void>(resolve => imposterServer.listen(genuinePort, '127.0.0.1', () => resolve()));

    try {
      // Client connects to the same port, which is now occupied by imposter with different cert
      await assert.rejects(
        async () => {
          await sendSecureArloRequest({
            url: `https://127.0.0.1:${genuinePort}/arlo/sensitive-data`,
            agent,
            token: 'secret-credential-token-never-leak',
            body: JSON.stringify({ sensitiveSecretCanary: 'VERY_SECRET_DATA' }),
          });
        },
        /PINNED_CERT_MISMATCH|certificate|CERT_/i
      );

      // Verify ZERO sensitive application bytes reached imposter
      assert.equal(imposterReceivedRequests, 0, 'Imposter must not receive any HTTP application requests');
      assert.equal(imposterReceivedAppBytes, 0, 'Imposter must receive 0 bytes of sensitive application data');
      recordProbeEvidence('tlsPinning', { genuineRequestCount: genuineReceivedBodies.length, imposterReceivedRequests, imposterReceivedAppBytes });
    } finally {
      await new Promise<void>(resolve => imposterServer.close(() => resolve()));
    }
  } finally {
    genuineServer.close();
  }
});

test('Seam 5.2: Redirect rejection (301/302/307/308), TLS 1.2/1.3 negotiated, non-resumed session, and proxy immunity', async () => {
  // 1. Setup server that can return redirects and check TLS
  let currentResponseCode = 200;
  let serverNegotiatedProtocol: string | undefined;

  const testServer = https.createServer({ key: DAEMON_KEY, cert: DAEMON_CERT }, (req, res) => {
    serverNegotiatedProtocol = (req.socket as any).getProtocol();
    if (currentResponseCode >= 300 && currentResponseCode < 400) {
      res.writeHead(currentResponseCode, {
        Location: 'https://127.0.0.1:9999/redirected-target',
      });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>(resolve => testServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (testServer.address() as any).port;

  try {
    const agent = createPinnedHttpsAgent(DAEMON_CERT, {
      minVersion: 'TLSv1.2',
      disableSessionResumption: true,
    });

    // 2. Verify redirect rejection for 301, 302, 307, 308
    for (const code of [301, 302, 307, 308]) {
      currentResponseCode = code;
      await assert.rejects(
        async () => {
          await sendSecureArloRequest({
            url: `https://127.0.0.1:${port}/redirect-check`,
            agent,
          });
        },
        new RegExp(`REDIRECT_FORBIDDEN.*${code}`)
      );
    }

    // 3. Reset to 200 and verify actual negotiated TLS protocol (1.2 or 1.3)
    currentResponseCode = 200;
    const res1 = await sendSecureArloRequest({
      url: `https://127.0.0.1:${port}/tls-protocol-check`,
      agent,
    });
    assert.equal(res1.status, 200);
    assert.ok(
      res1.negotiatedProtocol === 'TLSv1.2' || res1.negotiatedProtocol === 'TLSv1.3',
      `Actual negotiated TLS protocol must be TLSv1.2 or TLSv1.3, got ${res1.negotiatedProtocol}`
    );
    assert.equal(res1.negotiatedProtocol, serverNegotiatedProtocol);

    // 4. Verify TLS session resumption is disabled across multiple requests
    const res2 = await sendSecureArloRequest({
      url: `https://127.0.0.1:${port}/tls-resumption-check`,
      agent,
    });
    assert.equal(res2.status, 200);
    assert.equal(res1.sessionReused, false, 'First connection must not reuse session');
    assert.equal(res2.sessionReused, false, 'Subsequent connection must have session resumption disabled');

    // 5. Verify environment HTTP proxy immunity
    const origHttpProxy = process.env.HTTP_PROXY;
    const origHttpsProxy = process.env.HTTPS_PROXY;
    try {
      process.env.HTTP_PROXY = 'http://proxy.invalid:8080';
      process.env.HTTPS_PROXY = 'http://proxy.invalid:8080';

      const resProxy = await sendSecureArloRequest({
        url: `https://127.0.0.1:${port}/proxy-immunity-check`,
        agent,
      });
      assert.equal(resProxy.status, 200, 'Loopback connection must bypass external HTTP/HTTPS proxies');
    } finally {
      if (origHttpProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = origHttpProxy;
      if (origHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = origHttpsProxy;
    }

    // 6. Verify global TLS verification is NOT disabled
    assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'Must not globally disable TLS verification');
    recordProbeEvidence('tlsConnections', {
      negotiatedProtocol: res1.negotiatedProtocol, serverNegotiatedProtocol,
      sessionReused: [res1.sessionReused, res2.sessionReused],
    });
  } finally {
    testServer.close();
  }
});
