import { AuthorizedControlClient as ControlClient } from './helpers/authorized-control.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArloDaemon } from '@arlo/daemon';
import {

  ArloErrorCode,
  type ArloMessageNotificationParams,
  type ReadyRootRequest,
  type RootReceiptRequest,
  type RootRegistrationResponse,
} from '@arlo/sdk';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { fixture } from '../probes/fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

// The transport boundary is the injection seam: the test captures the
// reception handler the plugin installs on its real MCP connection, then feeds
// it frames the daemon would only produce on a transport replay. No simulated
// adapter stands in for the real host.
class HandlerCapturingControlClient extends ControlClient {
  receptionHandler?: (params: ArloMessageNotificationParams) => void | Promise<void>;
  readonly receipts: RootReceiptRequest[] = [];
  rootRegistration?: RootRegistrationResponse;
  readonly frames: ArloMessageNotificationParams[] = [];
  private readySignal = Promise.withResolvers<void>();

  override createRootConnection(binding: RootRegistrationResponse) {
    const connection = super.createRootConnection(binding);
    const install = connection.onNotification.bind(connection);
    connection.onNotification = (handler: (params: ArloMessageNotificationParams) => void | Promise<void>) => {
      // The first connection belongs to the plugin under test. Every frame the
      // plugin sees, real or injected, is recorded here.
      this.receptionHandler ??= handler;
      const recorder = (params: ArloMessageNotificationParams) => {
        this.frames.push(params);
        return handler(params);
      };
      return install(recorder as never);
    };
    return connection;
  }

  override async registerRoot(token: string, request: Parameters<ControlClient['registerRoot']>[1]) {
    const response = await super.registerRoot(token, request);
    this.rootRegistration = response;
    return response;
  }

  override async submitReceipt(token: string, request: RootReceiptRequest) {
    this.receipts.push({ ...request });
    return super.submitReceipt(token, request);
  }

  override async confirmRootReady(token: string, request: ReadyRootRequest) {
    const response = await super.confirmRootReady(token, request);
    this.readySignal.resolve();
    return response;
  }

  waitForReady(): Promise<void> {
    return this.readySignal.promise;
  }

  async deliver(frame: ArloMessageNotificationParams): Promise<void> {
    await this.receptionHandler!(frame);
  }
}

test('An unrecoverable replayed frame is reported as uncertain, never as a fabricated rejection', { timeout: 30000 }, async () => {
  const stateDir = createTempDir('harness-replay-receipt');
  const daemon = new ArloDaemon({ stateDir });
  const host = await fixture();
  let sender: ReturnType<ControlClient['createRootConnection']> | undefined;
  let stopCounting: (() => void) | undefined;
  try {
    const { port } = await daemon.start();
    const control = new HandlerCapturingControlClient({ stateDir, port });
    await host.ctx.plugin(createArloHarnessPlugin({ groupName: 'replay-receipt', stateDir, controlClient: control }));
    await control.waitForReady();
    const root = control.rootRegistration!;
    assert.ok(control.receptionHandler, 'The plugin installed a real reception handler');

    const insertions: string[] = [];
    stopCounting = host.ctx.on('agent/inbox/inserted', ({ message }) => {
      if ((message.source as { kind?: string } | undefined)?.kind === 'arlo') {
        insertions.push(String(message.id));
      }
    });

    // A real same-group sender drives genuine dispatches into the plugin.
    const runtime = await control.registerRuntime({ host_type: 'deepseek-harness', host_version: '0.2.0' });
    const senderBinding = await control.registerRoot(runtime.runtime_token, {
      root_session_id: 'host-replay-sender',
      group_name: 'replay-receipt',
      agent_incarnation: 'inc-replay-sender',
      plugin_generation: 1,
    });
    sender = control.createRootConnection(senderBinding);
    await sender.connect();
    await control.confirmRootReady(senderBinding.root_token, { endpoint_id: senderBinding.endpoint_id });

    const first = await sender.sendMessage({ to: root.endpoint_id, text: 'delivered once' });
    assert.equal(first.status, 'accepted');
    const real = control.frames[0];
    assert.equal(real.delivery_seq, '1');
    assert.equal(insertions.length, 1, 'The real dispatch reached the host exactly once');

    // 1. The same sequence number with an unknown message ID: the result for
    //    that frame is gone, so the honest answer is uncertain.
    await control.deliver({ ...real, message_id: 'replay-duplicate-seq' });
    const duplicateSeq = control.receipts.find((r) => r.message_id === 'replay-duplicate-seq');
    assert.equal(duplicateSeq?.status, 'uncertain', 'A lost replay result is not reported as not_enqueued');
    assert.equal(duplicateSeq?.reason, ArloErrorCode.REPLAY_RESULT_UNAVAILABLE);
    assert.equal(insertions.length, 1, 'A seen sequence never reaches the host again');

    // 2. A frame that jumps the window forward is admissible...
    await control.deliver({ ...real, message_id: 'replay-forward', delivery_seq: '5000' });
    assert.equal(control.receipts.find((r) => r.message_id === 'replay-forward')?.status, 'enqueued');
    assert.equal(insertions.length, 2);

    // 3. ...and a frame before the window is not, and is not called rejected.
    await control.deliver({ ...real, message_id: 'replay-before-window', delivery_seq: '3' });
    const beforeWindow = control.receipts.find((r) => r.message_id === 'replay-before-window');
    assert.equal(beforeWindow?.status, 'uncertain', 'A frame before the window is not a proven rejection');
    assert.equal(beforeWindow?.reason, ArloErrorCode.STALE_SEQUENCE);
    assert.equal(insertions.length, 2, 'A frame before the window is never re-delivered');
  } finally {
    stopCounting?.();
    sender?.dispose();
    await host.ctx.fiber.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
