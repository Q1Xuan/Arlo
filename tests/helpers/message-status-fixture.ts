import { AuthorizedControlClient as ControlClient } from './authorized-control.ts';
import { ArloDaemon, type ArloDaemonOptions } from '@arlo/daemon';
import {

  type ArloMessageNotificationParams,
  type RootConnection,
  type RootRegistrationResponse,
} from '@arlo/sdk';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from '../test-utils.ts';

export type ReceiptStrategy = (
  params: ArloMessageNotificationParams,
  root: MessageStatusRoot
) => void | Promise<void>;

export interface MessageStatusRoot {
  /** Stable position in the fixture, used only for test readability. */
  readonly index: number;
  readonly registration: RootRegistrationResponse;
  readonly connection: RootConnection;
  /** Layer a receipt strategy for frames delivered to this root. */
  onNotification(strategy: ReceiptStrategy): void;
  notifications: ArloMessageNotificationParams[];
  /** Resolves after the next notification frame is observed. */
  nextNotification(): Promise<ArloMessageNotificationParams>;
}

export interface MessageStatusFixtureOptions extends ArloDaemonOptions {
  /** Number of roots to register in the shared group. */
  roots?: number;
  groupName?: string;
  /** Transport-only tests may freeze daemon leases and drive their own deadlines. */
  rootHeartbeat?: boolean;
  /** Public MCP client wait when capacity assertions deliberately hold many ACKs. */
  sendRequestTimeoutMs?: number;
  /** Test setup before registration; optional cleanup also runs before failed startup is stopped. */
  onStarted?: (port: number) => Promise<void | (() => void)>;
}

/**
 * A controllable clock for retention assertions. Tests advance it explicitly
 * instead of sleeping, so expiry is deterministic rather than timing-dependent.
 */
export class TestClock {
  private current: number;

  constructor(start = 1_000_000) {
    this.current = start;
  }

  now = (): number => this.current;

  advance(ms: number): void {
    this.current += ms;
  }
}

/**
 * Boots a real daemon over loopback HTTPS with N ready roots in one group, so
 * tests exercise the real SDK transport, control plane, and MCP tool surface
 * rather than private containers.
 */
export class MessageStatusFixture {
  readonly stateDir: string;
  readonly daemon: ArloDaemon;
  readonly control: ControlClient;
  readonly roots: MessageStatusRoot[] = [];
  readonly runtimeToken: string;

  private constructor(stateDir: string, daemon: ArloDaemon, control: ControlClient, runtimeToken: string) {
    this.stateDir = stateDir;
    this.daemon = daemon;
    this.control = control;
    this.runtimeToken = runtimeToken;
  }

  static async create(options: MessageStatusFixtureOptions = {}): Promise<MessageStatusFixture> {
    const { roots: rootCount = 2, groupName = 'team-status', rootHeartbeat = true,
      sendRequestTimeoutMs, onStarted, ...daemonOptions } = options;
    const stateDir = createTempDir('message-status');
    // These fixtures exercise receipts, reply depth and capacity. Dedicated
    // pacing tests pass their own limits (including undefined for defaults).
    const daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT, ...daemonOptions });
    let cleanupStarted: void | (() => void) = undefined;
    try {
      const { port } = await daemon.start();
      cleanupStarted = await onStarted?.(port);
      const control = new ControlClient({ stateDir, port, sendRequestTimeoutMs: sendRequestTimeoutMs });
      const runtime = await control.registerRuntime({
        host_type: 'deepseek-harness',
        host_version: '0.2.0',
      });
      const fixture = new MessageStatusFixture(stateDir, daemon, control, runtime.runtime_token);

      for (let index = 0; index < rootCount; index++) {
        const registration = await control.registerRoot(runtime.runtime_token, {
          root_session_id: `host-status-${index}`,
          group_name: groupName,
          agent_incarnation: `inc-status-${index}`,
          plugin_generation: 1,
        });
        const connection = control.createRootConnection(registration, { heartbeat: rootHeartbeat });
        fixture.roots.push(fixture.attachRoot(index, registration, connection));
      }

      for (const root of fixture.roots) {
        await root.connection.connect();
      }
      for (const root of fixture.roots) {
        await control.confirmRootReady(root.registration.root_token, {
          endpoint_id: root.registration.endpoint_id,
        });
      }
      // Publishing readiness and the target's SSE stream becoming writable are
      // separate state transitions, so wait for the daemon to agree before a
      // test dispatches anything.
      for (const root of fixture.roots) {
        await fixture.waitForDeliverable(root.index, true);
      }
      return fixture;
    } catch (error) {
      cleanupStarted?.();
      cleanupStarted = undefined;
      await daemon.stop().catch(() => {});
      removeTempDir(stateDir);
      throw error;
    } finally {
      cleanupStarted?.();
    }
  }

  private attachRoot(
    index: number,
    registration: RootRegistrationResponse,
    connection: RootConnection
  ): MessageStatusRoot {
    const root: MessageStatusRoot = {
      index,
      registration,
      connection,
      notifications: [],
      onNotification: () => {},
      nextNotification: () => Promise.reject(new Error('notification waiter not armed')),
    };

    const strategies: ReceiptStrategy[] = [];
    let waiter: PromiseWithResolvers<ArloMessageNotificationParams> | undefined;

    // The notification handler is installed exactly once. Layered strategies
    // run in order without displacing the test's existing receipt strategy.
    root.onNotification = (next) => {
      strategies.push(next);
    };
    root.nextNotification = () => {
      waiter ??= Promise.withResolvers<ArloMessageNotificationParams>();
      return waiter.promise;
    };

    connection.onNotification(async (params) => {
      root.notifications.push(params);
      waiter?.resolve(params);
      waiter = undefined;
      for (const strategy of strategies) {
        await strategy(params, root);
      }
    });

    return root;
  }

  /**
   * Sends from `from` to `to`. The daemon assigns the message ID unless the
   * caller replays a known one.
   */
  async send(
    from: number,
    to: number,
    text: string,
    messageId?: string
  ): Promise<{ status: string; message_id: string; reason?: string }> {
    return this.roots[from].connection.sendMessage(
      { to: this.roots[to].registration.endpoint_id, text },
      messageId
    );
  }

  /** Returns the observed frame for a message, failing loudly if never seen. */
  frameFor(rootIndex: number, messageId: string): ArloMessageNotificationParams {
    const found = this.roots[rootIndex].notifications.find((n) => n.message_id === messageId);
    if (!found) throw new Error(`no notification frame observed for message ${messageId}`);
    return found;
  }

  /** Waits until the daemon reports the target's deliverability as `expected`. */
  async waitForDeliverable(index: number, expected: boolean): Promise<boolean> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const list = await this.control.listRoots(this.runtimeToken);
      const found = list.find((r) => r.endpoint_id === this.roots[index].registration.endpoint_id);
      if (found?.deliverable === expected) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async dispose(): Promise<void> {
    for (const root of this.roots) root.connection.dispose();
    await this.daemon.stop().catch(() => {});
    removeTempDir(this.stateDir);
  }
}
