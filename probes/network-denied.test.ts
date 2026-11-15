import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

test('a caught external request still poisons the probe process', async () => {
  assert.throws(() => fetch('https://example.invalid/fictional-model'), /EXTERNAL_NETWORK_FORBIDDEN/);

  // DNS resolve & promises resolve must fail closed
  assert.throws(() => dns.resolve('google.com', () => {}), /EXTERNAL_NETWORK_FORBIDDEN/);
  await assert.rejects(async () => dns.promises.resolve('google.com'), /EXTERNAL_NETWORK_FORBIDDEN/);
  await assert.rejects(async () => dns.promises.lookup('google.com'), /EXTERNAL_NETWORK_FORBIDDEN/);

  // Net connect overloads
  assert.throws(() => net.connect({ host: 'external.invalid', port: 80 }), /EXTERNAL_NETWORK_FORBIDDEN/);
  assert.throws(() => net.connect(80, 'external.invalid'), /EXTERNAL_NETWORK_FORBIDDEN/);

  // TLS connect overloads
  assert.throws(() => tls.connect({ host: 'external.invalid', port: 443 }), /EXTERNAL_NETWORK_FORBIDDEN/);
  assert.throws(() => tls.connect(443, { host: 'external.invalid' }), /EXTERNAL_NETWORK_FORBIDDEN/);
  assert.throws(() => tls.connect(443, 'external.invalid', { rejectUnauthorized: false }), /EXTERNAL_NETWORK_FORBIDDEN/);
  assert.throws(() => tls.connect(443, { servername: 'external.invalid' }), /EXTERNAL_NETWORK_FORBIDDEN/);

  assert.equal(process.exitCode, 1);
  writeFileSync('network-denied-confirmed', 'confirmed');
});

