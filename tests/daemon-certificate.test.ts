import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import tls from 'node:tls';
import https from 'node:https';
import { once } from 'node:events';
import { createPinnedHttpsAgent } from '@arlo/sdk';
import { generateSelfSignedLoopbackCert } from '../packages/daemon/src/security/cert.ts';

test('Daemon certificates use valid positive DER serial numbers for every random prefix', t => {
  for (const suffix of ['0001020304050607', 'ffff020304050607', '8001020304050607', '0000000000000000', '0102030405060708']) {
    t.mock.method(crypto, 'randomBytes', () => Buffer.from(suffix, 'hex'));
    try {
      const { certPem, keyPem } = generateSelfSignedLoopbackCert();
      const certificate = new crypto.X509Certificate(certPem);
      assert.ok(!certificate.serialNumber.startsWith('-'));
      assert.ok(BigInt(`0x${certificate.serialNumber}`) > 0n);
      assert.ok(certificate.verify(certificate.publicKey));
      assert.doesNotThrow(() => tls.createSecureContext({ cert: certPem, key: keyPem }));
    } finally { t.mock.restoreAll(); }
  }
});

test('Daemon certificates are immediately usable with a slightly advanced application clock', async t => {
  const generatedAt = Date.now() + 30_000;
  t.mock.timers.enable({ apis: ['Date'], now: generatedAt });
  let credentials: ReturnType<typeof generateSelfSignedLoopbackCert>;
  try {
    credentials = generateSelfSignedLoopbackCert(7);
  } finally {
    // OpenSSL verifies with the real system clock; only certificate generation
    // observes the advanced JavaScript clock in this test process.
    t.mock.timers.reset();
  }
  const certificate = new crypto.X509Certificate(credentials.certPem);
  const server = https.createServer({ cert: credentials.certPem, key: credentials.keyPem }, (_request, response) => {
    response.end('pinned daemon ready');
  });
  const agent = createPinnedHttpsAgent(credentials.certPem);
  t.after(async () => {
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const body = await new Promise<string>((resolve, reject) => {
    const request = https.get(`https://127.0.0.1:${address.port}/`, { agent }, response => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => resolve(body));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('Pinned TLS handshake timed out')));
  });
  assert.equal(body, 'pinned daemon ready');
  const remainingValidity = certificate.validToDate.getTime() - generatedAt;
  assert.ok(remainingValidity > 7 * 24 * 60 * 60 * 1000 - 1000);
  assert.ok(remainingValidity <= 7 * 24 * 60 * 60 * 1000,
    'Clock tolerance must not extend the requested certificate expiry');
});
