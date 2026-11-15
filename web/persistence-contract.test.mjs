import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const consumer = path.resolve(process.argv[2]);
const require = createRequire(path.join(consumer, 'package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const persistence = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);

test('candidate publishes a Host-only accessor for its actual JSONL backend', async () => {
  assert.equal(typeof persistence.ownershipOf, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-jsonl-contract-'));
  const ctx = new Context();
  try {
    await ctx.plugin(persistence, { root, compression: 'none' });
    const backend = persistence.ownershipOf(ctx.sessionPersistence);
    assert.ok(backend);
    assert.equal(backend.identity, ctx.sessionPersistence.identity);
    assert.equal(typeof backend.resolveCurrentLog, 'function');
    assert.equal(typeof backend.hasPendingSession, 'function');
    assert.equal(persistence.ownershipOf({ name: 'session-persistence-jsonl',
      resolveCurrentLog() {}, hasPendingSession() {}, open() {} }), undefined,
      'A matching shape does not authenticate a JSONL backend');
    assert.equal(await backend.resolveCurrentLog('missing-session'), undefined);
    assert.equal(backend.hasPendingSession('missing-session'), false);
  } finally {
    await ctx.fiber.dispose();
    fs.rmSync(root, { recursive: true });
  }
});
