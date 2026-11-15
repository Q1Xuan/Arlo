import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArloDaemon, TokenBucket } from '@arlo/daemon';
import { ArloErrorCode } from '@arlo/sdk';

test('Rate configuration rejects unsafe integers and overflowing credit capacity at startup', () => {
  const maxBurst = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);
  for (const limit of [
    { perMinute: 1e308, burst: 1 },
    { perMinute: Number.MAX_SAFE_INTEGER + 1, burst: 1 },
    { perMinute: 1, burst: 1e308 },
    { perMinute: 1, burst: maxBurst + 1 },
  ]) {
    for (const side of ['sender', 'receiver']) {
      assert.throws(
        () => new ArloDaemon({ rateLimit: { [side]: limit } }),
        (error: any) => error.code === ArloErrorCode.INVALID_ARGUMENT,
        `${side} must reject a limit whose integer arithmetic is unsafe`
      );
    }
  }
  assert.doesNotThrow(() => new TokenBucket(Number.MAX_SAFE_INTEGER, maxBurst));
});

test('Long idle periods saturate the burst and clock rollback never grants extra admission', () => {
  const bucket = new TokenBucket(60, 3);
  const drain = (time: number) => {
    for (let i = 0; i < 3; i++) {
      assert.equal(bucket.peek(time), true);
      bucket.spend();
    }
    assert.equal(bucket.peek(time), false);
  };
  drain(10_000);
  assert.equal(bucket.peek(9_000), false);
  assert.equal(bucket.peek(10_999), false);
  drain(Number.MAX_SAFE_INTEGER);
});
