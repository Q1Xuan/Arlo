import {
  DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_LEASE_DURATION_MS, ArloError, ArloErrorCode,
} from '../protocol/index.ts';

export interface ConnectionLeaseOptions {
  heartbeat: () => Promise<{ lease_duration_ms: number }>;
  onExpire: () => void;
  /** Monotonic clock, also used by synchronous business/notification guards. */
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
}

/** Owns one connection's heartbeat and conservative local authorization deadline.
 * Timers wake the owner; isValid() enforces expiry even when those timers stall. */
export class ConnectionLease {
  private readonly options: ConnectionLeaseOptions;
  private readonly now: () => number;
  private readonly schedule: NonNullable<ConnectionLeaseOptions['setTimeout']>;
  private readonly cancel: NonNullable<ConnectionLeaseOptions['clearTimeout']>;
  private readonly interval: number;
  private readonly duration: number;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private deadline: number;
  private stopped = false;

  constructor(options: ConnectionLeaseOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.schedule = options.setTimeout ?? setTimeout;
    this.cancel = options.clearTimeout ?? clearTimeout;
    this.interval = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.duration = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    if (!Number.isSafeInteger(this.interval) || this.interval <= 0 ||
        !Number.isSafeInteger(this.duration) || this.duration <= 0 || this.interval >= this.duration) {
      throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
    }
    // Construct before the readiness request, or at subscription confirmation.
    // A delayed response must never become a fresh authorization period.
    this.deadline = this.now() + this.duration;
    this.scheduleExpiry();
    this.scheduleHeartbeat();
  }

  isValid(): boolean {
    if (this.stopped) return false;
    if (this.now() >= this.deadline) {
      this.expire();
      return false;
    }
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer !== undefined) this.cancel(this.heartbeatTimer);
    if (this.expiryTimer !== undefined) this.cancel(this.expiryTimer);
  }

  private expire(): void {
    if (this.stopped) return;
    this.stop();
    this.options.onExpire();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) this.cancel(this.expiryTimer);
    this.expiryTimer = this.schedule(() => {
      if (this.isValid()) this.scheduleExpiry();
    }, Math.max(0, this.deadline - this.now()));
    this.expiryTimer.unref?.();
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = this.schedule(() => { void this.tick(); }, this.interval);
    this.heartbeatTimer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.isValid()) return;
    const startedAt = this.now();
    try {
      const response = await this.options.heartbeat();
      if (!this.isValid()) return;
      if (!Number.isSafeInteger(response.lease_duration_ms) || response.lease_duration_ms <= 0) {
        this.expire();
        return;
      }
      // The daemon can only receive the request at or after startedAt. Taking
      // that earlier instant avoids extending its lease by response latency.
      this.deadline = startedAt + Math.min(this.duration, response.lease_duration_ms);
      if (!this.isValid()) return;
      this.scheduleExpiry();
      this.scheduleHeartbeat();
    } catch { this.expire(); }
  }
}
