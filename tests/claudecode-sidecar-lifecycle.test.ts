import { fetchCurrentBridge } from './helpers/claudecode-bridge-client.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeCodeReceptionHost, ClaudeCodeSidecar } from '../packages/adapter-claudecode/src/index.ts';
import type { ArloMessageNotificationParams } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

async function attachMod(sidecar: ClaudeCodeSidecar): Promise<void> {
  const response = await fetchCurrentBridge(`${sidecar.url}/api/v1/bridge/handshake`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sidecar.token}`,
      'x-session-id': sidecar.sessionId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ modVersion: '0.1.0', capabilities: ['prompt.submit'] }),
  });
  assert.equal(response.status, 200);
}

test('Claude Code Sidecar - Lifecycle & Trusted CWD (Seam 2)', async (t) => {
  // The bridge enforces its private directory ACL through icacls, which the
  // permission guard only allows inside the owned test root; a raw os.tmpdir()
  // fixture makes that enforcement fail closed.
  const tempDir = createTempDir('sidecar-lifecycle');

  t.after(() => removeTempDir(tempDir));

  await t.test('sessionCwd returns undefined when cwd option is missing (no process.cwd fallback)', async () => {
    const sidecar = new ClaudeCodeSidecar({
      sessionId: 'session-no-cwd',
      stateDir: path.join(tempDir, 'no-cwd'),
      port: 0,
      autoStart: false,
    });

    assert.deepEqual(sidecar.host.roots(), [], 'The root is not live before recovery');
    await sidecar.start();
    assert.deepEqual(sidecar.host.roots(), [], 'The bridge alone does not prove a live Mod');
    await attachMod(sidecar);
    const roots = sidecar.host.roots();
    assert.equal(roots.length, 1);
    const root = roots[0];

    // Must be undefined, NOT process.cwd()
    assert.equal(
      sidecar.host.sessionCwd(root),
      undefined,
      'sessionCwd must return undefined when cwd is unknown, per docs/ADAPTER_LIFECYCLE.md'
    );

    await sidecar.stop();
  });

  await t.test('sessionCwd returns explicit cwd when provided', async () => {
    const explicitCwd = path.join(tempDir, 'explicit-workspace');
    fs.mkdirSync(explicitCwd, { recursive: true });

    const sidecar = new ClaudeCodeSidecar({
      sessionId: 'session-explicit-cwd',
      stateDir: path.join(tempDir, 'explicit-cwd'),
      cwd: explicitCwd,
      port: 0,
      autoStart: false,
    });

    await sidecar.start();
    await attachMod(sidecar);
    const root = sidecar.host.roots()[0];
    assert.equal(sidecar.host.sessionCwd(root), explicitCwd);

    await sidecar.stop();
  });

  await t.test('sidecar.stop() disposes runtime and removes roots from roots()', async () => {
    const sidecar = new ClaudeCodeSidecar({
      sessionId: 'session-stop-cleanup',
      stateDir: path.join(tempDir, 'stop-cleanup'),
      port: 0,
      autoStart: false,
    });

    let disposedEventFired = false;
    sidecar.host.onDisposed(() => {
      disposedEventFired = true;
    });

    await sidecar.start();
    await attachMod(sidecar);
    assert.equal(sidecar.host.roots().length, 1, 'Live sidecar must expose root');

    // Track runtime disposal
    let runtimeDisposeCalled = false;
    if (sidecar.runtime) {
      const origDispose = sidecar.runtime.dispose.bind(sidecar.runtime);
      sidecar.runtime.dispose = async () => {
        runtimeDisposeCalled = true;
        await origDispose();
      };
    }

    await sidecar.stop();

    assert.equal(disposedEventFired, true, 'onDisposed event must be emitted');
    assert.equal(runtimeDisposeCalled, true, 'sidecar.stop() must call and await runtime.dispose()');
    assert.deepEqual(sidecar.host.roots(), [], 'roots() must return empty array after sidecar is stopped');

    // Repeated stop should be idempotent and not throw
    await assert.doesNotReject(async () => {
      await sidecar.stop();
    }, 'Repeated stop() must be idempotent');
  });

  await t.test('recovers the disk queue before the root is published', async t => {
    const stateDir = path.join(tempDir, 'recover-before-live');
    const sessionId = 'session-recover-before-live';
    const seeded = new ClaudeCodeReceptionHost({ sessionId, storageDir: stateDir });
    const frame: ArloMessageNotificationParams = {
      protocol_version: '0.1',
      daemon_id: 'daemon-test',
      message_id: 'msg-recover',
      delivery_id: 'del-recover',
      from_endpoint: 'sender-endpoint',
      to_endpoint: 'cc-receiver-endpoint',
      group_id: 'group-test',
      target_generation: 1,
      delivery_seq: '1',
      text: 'queued before restart',
      sent_at: new Date().toISOString(),
    };
    await seeded.prepare(frame).enqueue();

    const sidecar = new ClaudeCodeSidecar({
      sessionId,
      stateDir,
      port: 0,
      autoStart: false,
    });
    t.after(() => sidecar.stop());
    assert.deepEqual(sidecar.host.roots(), []);
    assert.equal(sidecar.receptionHost.snapshot({ instanceId: sidecar.receptionHost.instanceId, generation: 1 }).pending.length, 0);

    await sidecar.start();
    assert.equal(sidecar.receptionHost.getPendingMessages()[0]?.messageId, 'msg-recover');
    assert.equal(sidecar.receptionHost.snapshot({
      instanceId: sidecar.receptionHost.instanceId,
      generation: 1,
    }).pending.length, 1, 'The full local snapshot retains recovered input');
    assert.equal(sidecar.receptionHost.endpointReception.snapshot!({
      instanceId: sidecar.receptionHost.instanceId, generation: 1,
    }).pending.length, 0, 'Recovered dispatches are not credit on the replacement endpoint');
    assert.deepEqual(sidecar.host.roots(), [], 'Recovered input must wait for the live Mod');
    await attachMod(sidecar);
    assert.equal(sidecar.host.roots().length, 1);

    await sidecar.stop();
  });

  await t.test('a stopped sidecar cannot be restarted or published by a late handshake', async () => {
    const sidecar = new ClaudeCodeSidecar({
      sessionId: 'session-stop-before-start', stateDir: path.join(tempDir, 'stop-before-start'),
    });
    await sidecar.stop();
    await assert.rejects(sidecar.start(), /stopped/);
    assert.deepEqual(sidecar.host.roots(), []);
  });
});
