import { ArloError, ArloErrorCode } from '@arlo/sdk';

/**
 * Deterministic token bucket pacing per-root message admission.
 *
 * All arithmetic stays in integers: one message costs 60,000 units and one
 * elapsed millisecond refills `perMinute` units, so exactly-at-limit and
 * one-over boundaries never depend on floating-point accumulation or on
 * wall-clock jitter. Time comes from the daemon's injected clock.
 */
export class TokenBucket {
  /** Credit units consumed by one admitted message. */
  static readonly UNITS_PER_MESSAGE = 60_000;

  readonly perMinute: number;
  readonly burst: number;

  private credit: number;
  private lastRefillMs?: number;
  private rejectedSinceAdmission = false;

  constructor(perMinute: number, burst: number) {
    if (!Number.isSafeInteger(perMinute) || perMinute < 1) {
      throw new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Rate limit perMinute must be a safe integer >= 1');
    }
    if (!Number.isSafeInteger(burst) || burst < 1 ||
        burst > Math.floor(Number.MAX_SAFE_INTEGER / TokenBucket.UNITS_PER_MESSAGE)) {
      throw new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Rate limit burst must have a safe integer credit capacity');
    }
    this.perMinute = perMinute;
    this.burst = burst;
    this.credit = burst * TokenBucket.UNITS_PER_MESSAGE;
  }

  /**
   * Refills up to `nowMs` and reports whether one admission is available,
   * without spending it. A false result marks the bucket as rejected so the
   * next admitted message is audited as a recovery.
   */
  peek(nowMs: number): boolean {
    this.refill(nowMs);
    if (this.credit < TokenBucket.UNITS_PER_MESSAGE) {
      this.rejectedSinceAdmission = true;
      return false;
    }
    return true;
  }

  /**
   * Spends one admission after a passing peek in the same synchronous turn.
   * Returns 'recovered' when this is the first admission after a rejection.
   */
  spend(): 'ok' | 'recovered' {
    if (this.credit < TokenBucket.UNITS_PER_MESSAGE) {
      throw new Error('TokenBucket.spend() called without a passing peek in the same turn');
    }
    this.credit -= TokenBucket.UNITS_PER_MESSAGE;
    const recovered = this.rejectedSinceAdmission;
    this.rejectedSinceAdmission = false;
    return recovered ? 'recovered' : 'ok';
  }

  private refill(nowMs: number): void {
    if (this.lastRefillMs === undefined) {
      this.lastRefillMs = nowMs;
      return;
    }
    const elapsed = Math.max(0, nowMs - this.lastRefillMs);
    if (elapsed > 0) {
      this.lastRefillMs = nowMs;
      const capacity = this.burst * TokenBucket.UNITS_PER_MESSAGE;
      // Clamp the refill before adding it: stored credit always stays within
      // the validated safe integer capacity, even after a long idle period.
      this.credit += Math.min(capacity - this.credit, elapsed * this.perMinute);
    }
  }
}
