import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { testRoot } from './permission-preload.mjs';
import { enforceWindowsAcl, type RateLimitOptions } from '@arlo/sdk';

/**
 * Generous per-root pacing for tests that verify other budgets, sequences or
 * retention and must not trip the default admission pacing (12/30 per minute).
 * The default limits themselves are exercised in tests/daemon-rate-limit.test.ts.
 */
export const UNPACED_ROOT_RATE = { perMinute: 60000, burst: 1000 };
export const UNPACED_RATE_LIMIT: RateLimitOptions = {
  sender: UNPACED_ROOT_RATE,
  receiver: UNPACED_ROOT_RATE,
};

// The guard is installed before the first fixture permission operation, even
// when a test file is invoked directly instead of through the suite runner.
export const scratchDir = testRoot;
const owned = new Map<string, string>();

export function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(scratchDir, `arlo-${prefix}-`));
  enforceWindowsAcl(dir, true);
  const owner = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, '.test-owner.json'), JSON.stringify({ owner, pid: process.pid }));
  owned.set(dir, owner);
  return dir;
}

export function removeTempDir(dir: string): void {
  const absolute = path.resolve(dir);
  const owner = owned.get(absolute);
  if (path.dirname(absolute) !== scratchDir || !owner || fs.lstatSync(absolute).isSymbolicLink() ||
      JSON.parse(fs.readFileSync(path.join(absolute, '.test-owner.json'), 'utf8')).owner !== owner) {
    throw new Error('Refusing cleanup outside an owned test directory');
  }
  // Windows can release a child's CLR/log handles just after its IPC exit.
  // Retry only this already verified owned directory, never a recomputed path.
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  owned.delete(absolute);
}

/** One record of a Claude Code Sidecar durable queue, as stored on disk. */
export interface DurableQueueRecord {
  messageId: string;
  status: string;
  correlationId?: string;
  text: string;
}

/**
 * Reads a Sidecar durable queue. The queue file is the only authority for an
 * input's settled state, so tests assert against it rather than memory.
 */
export function readDurableQueue(storageDir: string, sessionId: string): DurableQueueRecord[] {
  const queueFile = path.join(storageDir, sessionId, 'queue.jsonl');
  if (!fs.existsSync(queueFile)) return [];
  return fs.readFileSync(queueFile, 'utf8').split('\n').filter(line => line.trim())
    .map(line => JSON.parse(line) as DurableQueueRecord);
}

/** The settled state of one message in a Sidecar durable queue. */
export function durableStatus(storageDir: string, sessionId: string, messageId: string): string {
  const record = readDurableQueue(storageDir, sessionId).find(item => item.messageId === messageId);
  assert.ok(record, `No durable record for ${messageId}`);
  return record.status;
}

/** Waits until one message reaches the expected durable state, then returns it. */
export async function awaitDurableStatus(
  storageDir: string, sessionId: string, messageId: string, expected: string,
): Promise<DurableQueueRecord> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const record = readDurableQueue(storageDir, sessionId).find(item => item.messageId === messageId);
    if (record?.status === expected) return record;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const settled = readDurableQueue(storageDir, sessionId).find(item => item.messageId === messageId);
  assert.ok(settled, `No durable record for ${messageId}`);
  assert.equal(settled.status, expected);
  return settled;
}
