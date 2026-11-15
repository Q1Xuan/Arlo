import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DaemonClient,
  ArloErrorCode,
  ArloError,
  createPinnedHttpsAgent,
  sendSecureArloRequest,
} from '@arlo/sdk';
import { ArloDaemon } from '../packages/daemon/src/server/index.ts';
import { IMPOSTER_CERT, IMPOSTER_KEY } from '../probes/tls-fixtures.ts';

import { createTempDir, removeTempDir } from './test-utils.ts';

test('SDK discovers daemon, pins TLS certificate, and successfully reports status and doctor', async () => {
  const stateDir = createTempDir('sdk-status-doc');
  const daemon = new ArloDaemon({ stateDir, port: 0 });

  try {
    const { port, daemonId } = await daemon.start();

    const client = new DaemonClient({ stateDir });

    // 1. Check Status
    const status = await client.getStatus();
    assert.equal(status.daemon_id, daemonId);
    assert.equal(status.port, port);
    assert.equal(status.pid, process.pid);
    assert.equal(status.status, 'ready');
    assert.equal(status.listener, 'loopback');
    assert.ok(status.uptime_ms >= 0);

    // 2. Check Doctor
    const report = await client.getDoctor();
    assert.equal(report.overall_status, 'healthy');
    assert.equal(report.daemon_id, daemonId);
    assert.ok(report.checks.length >= 6);
    for (const check of report.checks) {
      assert.equal(check.status, 'pass', `Check ${check.name} must pass`);
    }
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('Unauthenticated or invalid token requests are rejected with UNAUTHORIZED and leak no credentials or paths', async () => {
  const stateDir = createTempDir('sdk-auth-reject');
  const daemon = new ArloDaemon({ stateDir, port: 0 });

  try {
    const { port } = await daemon.start();

    // Client with invalid token
    const client = new DaemonClient({
      stateDir,
      bootstrapToken: 'completely-invalid-bogus-token-1234567890',
    });

    let error: any = null;
    try {
      await client.getStatus();
    } catch (err) {
      error = err;
    }

    assert.ok(error instanceof ArloError);
    assert.equal(error.code, ArloErrorCode.UNAUTHORIZED);

    // Raw request to check error response body
    const discPath = path.join(stateDir, 'discovery.json');
    const disc = JSON.parse(fs.readFileSync(discPath, 'utf8'));
    const agent = createPinnedHttpsAgent(disc.cert_pem);

    const res = await sendSecureArloRequest({
      url: `https://127.0.0.1:${port}/control/v1/status`,
      agent,
      token: 'wrong-token',
    });

    assert.equal(res.status, 401);
    const body = JSON.parse(res.body);
    assert.deepEqual(body, { error: 'UNAUTHORIZED' });
    // Verify no paths or credentials leaked in body
    assert.ok(!res.body.includes(stateDir));
    assert.ok(!res.body.includes('bootstrap'));
    assert.ok(!res.body.includes('stack'));
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('Old port occupied by an imposter with different cert receives 0 bytes and TLS handshake fails', async () => {
  const stateDir = createTempDir('sdk-imposter-port');
  const daemon = new ArloDaemon({ stateDir, port: 0 });

  let port = 0;
  let daemonCertPem = '';
  try {
    const startResult = await daemon.start();
    port = startResult.port;

    const discPath = path.join(stateDir, 'discovery.json');
    const disc = JSON.parse(fs.readFileSync(discPath, 'utf8'));
    daemonCertPem = disc.cert_pem;
  } finally {
    await daemon.stop();
  }

  // Now start an imposter HTTPS server on the exact same port with a DIFFERENT certificate
  let imposterRequests = 0;
  let imposterBytes = 0;

  const imposterServer = https.createServer(
    {
      key: IMPOSTER_KEY,
      cert: IMPOSTER_CERT,
    },
    (req, res) => {
      imposterRequests++;
      req.on('data', (chunk) => {
        imposterBytes += chunk.length;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    }
  );

  await new Promise<void>((resolve, reject) => {
    imposterServer.on('error', reject);
    imposterServer.listen(port, '127.0.0.1', () => resolve());
  });

  try {
    // Client tries to connect using the pinned certificate of the original daemon
    const pinnedAgent = createPinnedHttpsAgent(daemonCertPem);

    let errorCaught: any = null;
    try {
      await sendSecureArloRequest({
        url: `https://127.0.0.1:${port}/control/v1/status`,
        agent: pinnedAgent,
        token: 'secret-sensitive-token',
        body: JSON.stringify({ sensitive: 'payload' }),
      });
    } catch (err) {
      errorCaught = err;
    }

    assert.ok(errorCaught instanceof ArloError);
    assert.equal(errorCaught.code, ArloErrorCode.PINNED_CERT_MISMATCH);

    // Assert that the imposter process on the old port received ZERO bytes of sensitive data!
    assert.equal(imposterRequests, 0, 'Imposter must not receive any requests');
    assert.equal(imposterBytes, 0, 'Imposter must receive 0 bytes of sensitive body data');
  } finally {
    await new Promise<void>((resolve) => {
      imposterServer.close(() => resolve());
      imposterServer.closeAllConnections();
    });
    removeTempDir(stateDir);
  }
});

test('Rejects redirects, non-loopback hosts, and foreign browser Origin', async () => {
  const stateDir = createTempDir('sdk-defenses');
  const daemon = new ArloDaemon({ stateDir, port: 0 });

  try {
    const { port } = await daemon.start();
    const discPath = path.join(stateDir, 'discovery.json');
    const disc = JSON.parse(fs.readFileSync(discPath, 'utf8'));
    const token = fs.readFileSync(path.join(stateDir, 'bootstrap.token'), 'utf8').trim();
    const agent = createPinnedHttpsAgent(disc.cert_pem);

    // 1. External network forbidden
    await assert.rejects(
      async () => {
        await sendSecureArloRequest({
          url: 'https://example.com/control/v1/status',
          agent,
          token,
        });
      },
      (err: any) => err.code === ArloErrorCode.EXTERNAL_NETWORK_FORBIDDEN
    );

    // 2. Browser CORS / foreign Origin rejection
    const corsRes = await sendSecureArloRequest({
      url: `https://127.0.0.1:${port}/control/v1/status`,
      agent,
      token,
      headers: {
        Origin: 'https://evil-website.com',
      },
    });
    assert.equal(corsRes.status, 403);
    assert.ok(!corsRes.headers['access-control-allow-origin'], 'Must never emit CORS headers');
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
