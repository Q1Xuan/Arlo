import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ArloDaemon, generateSelfSignedLoopbackCert } from '@arlo/daemon';
import { MessageStatusFixture, type MessageStatusFixtureOptions } from './helpers/message-status-fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

async function connectedFixture(options: MessageStatusFixtureOptions): Promise<MessageStatusFixture> {
  const credentials = generateSelfSignedLoopbackCert();
  let setupClient: tls.TLSSocket | undefined;
  try {
    return await MessageStatusFixture.create({ ...options, tlsCert: credentials.certPem,
      tlsKey: credentials.keyPem, onStarted: async port => {
      // Windows private-file checks can outlast the short test idle window.
      // A completed TLS handshake proves server admission; client TCP connect
      // can arrive before the server has canceled its idle timer.
      setupClient = tls.connect({ port, host: '127.0.0.1', ca: credentials.certPem });
      try { await once(setupClient, 'secureConnect'); }
      catch (error) { setupClient.destroy(); throw error; }
      return () => setupClient?.destroy();
    } });
  } finally { setupClient?.destroy(); }
}

test('an unattended auto-started daemon exits and releases its discovery and startup lock', async () => {
  const stateDir = createTempDir('idle-exit');
  const stopped = Promise.withResolvers<void>();
  const daemon = new ArloDaemon({ stateDir, idleTimeoutMs: 50, onIdleStopped: stopped.resolve });
  try {
    await daemon.start();
    await Promise.race([stopped.promise, delay(15000, undefined, { ref: false }).then(() => { throw new Error('idle exit did not complete'); })]);
    assert.equal(fs.existsSync(path.join(stateDir, 'discovery.json')), false);
    const replacement = new ArloDaemon({ stateDir });
    await replacement.start();
    await replacement.stop();
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('a newly connected client cancels idle shutdown even before its TLS handshake', async () => {
  const stateDir = createTempDir('idle-connection');
  const stopped = Promise.withResolvers<void>();
  let didStop = false;
  const daemon = new ArloDaemon({ stateDir, idleTimeoutMs: 150,
    onIdleStopped: () => { didStop = true; stopped.resolve(); } });
  let socket: net.Socket | undefined;
  try {
    const { port } = await daemon.start();
    socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    await delay(400);
    assert.equal(didStop, false);
    socket.destroy();
    await Promise.race([stopped.promise, delay(15000, undefined, { ref: false }).then(() => { throw new Error('disconnect did not permit idle exit'); })]);
  } finally {
    socket?.destroy();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('pending accepted input and unknown delivery survive all root connections closing', async () => {
  for (const accepted of [true, false]) {
    let stopped = false;
    const fixture = await connectedFixture({ idleTimeoutMs: 3000, ...(accepted ? {} : { ackTimeoutMs: 100 }),
      onIdleStopped: () => { stopped = true; } });
    try {
      if (accepted) fixture.roots[1].onNotification(async (frame, root) => {
        await fixture.control.submitReceipt(root.registration.root_token, {
          endpoint_id: root.registration.endpoint_id, daemon_id: frame.daemon_id,
          message_id: frame.message_id, delivery_id: frame.delivery_id,
          generation: frame.target_generation, status: 'enqueued', native_message_id: 'idle-native',
        });
      });
      const sent = await fixture.send(0, 1, 'retain my unresolved input');
      assert.equal(sent.status, accepted ? 'accepted' : 'unknown');
      for (const root of fixture.roots) root.connection.dispose();
      // The control-plane agent can retain idle HTTP sockets independently of
      // the root SSE connections. Close it too: only the ledger may keep the
      // daemon alive during the following interval.
      fixture.control.dispose();
      await delay(4500);
      assert.equal(stopped, false);
      assert.equal(fs.existsSync(path.join(fixture.stateDir, 'discovery.json')), true);
    } finally { await fixture.dispose(); }
  }
});

test('idle shutdown does not remove a replacement discovery record', async () => {
  const stateDir = createTempDir('idle-ownership');
  let stopped = false;
  const daemon = new ArloDaemon({ stateDir, idleTimeoutMs: 100, onIdleStopped: () => { stopped = true; } });
  try {
    await daemon.start();
    const file = path.join(stateDir, 'discovery.json');
    const original = fs.readFileSync(file, 'utf8');
    const replacement = JSON.parse(original);
    replacement.daemon_id = 'replacement-instance';
    fs.writeFileSync(file, JSON.stringify(replacement));
    await delay(300);
    assert.equal(stopped, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).daemon_id, 'replacement-instance');
    fs.writeFileSync(file, original);
  } finally { await daemon.stop(); removeTempDir(stateDir); }
});

test('connected roots keep settled receipts available; disconnect permits idle exit', async () => {
  const stopped = Promise.withResolvers<void>();
  let didStop = false;
  const fixture = await connectedFixture({ idleTimeoutMs: 3000,
    onIdleStopped: () => { didStop = true; stopped.resolve(); } });
  try {
    fixture.roots[1].onNotification(async (frame, root) => {
      await fixture.control.submitReceipt(root.registration.root_token, {
        endpoint_id: root.registration.endpoint_id, daemon_id: frame.daemon_id,
        message_id: frame.message_id, delivery_id: frame.delivery_id,
        generation: frame.target_generation, status: 'not_enqueued',
      });
    });
    assert.equal((await fixture.send(0, 1, 'settled rejection')).status, 'rejected');
    await delay(3500);
    assert.equal(didStop, false);
    for (const root of fixture.roots) root.connection.dispose();
    fixture.control.dispose();
    await Promise.race([stopped.promise, delay(15000, undefined, { ref: false }).then(() => { throw new Error('settled cache prevented idle exit'); })]);
  } finally { await fixture.dispose(); }
});

test('manually started daemons do not opt into automatic idle shutdown', async () => {
  const stateDir = createTempDir('manual-idle');
  let stopped = false;
  const daemon = new ArloDaemon({ stateDir, onIdleStopped: () => { stopped = true; } });
  try {
    await daemon.start();
    await delay(300);
    assert.equal(stopped, false);
    assert.equal(fs.existsSync(path.join(stateDir, 'discovery.json')), true);
  } finally { await daemon.stop(); removeTempDir(stateDir); }
});
