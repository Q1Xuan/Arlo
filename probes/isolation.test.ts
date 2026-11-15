import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('fixture HOME is owned; environment and filesystem cannot reach outside canary', () => {
  assert.equal(process.env.HOME, process.cwd());
  assert.match(readFileSync('.arlo-owner', 'utf8'), /Arlo issue 2/);
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert.equal(process.env.HTTP_PROXY, undefined);
  const outsideCanary = process.env.ARLO_OUTSIDE_CANARY;
  assert.ok(outsideCanary);
  assert.throws(() => readFileSync(outsideCanary), { code: 'ERR_ACCESS_DENIED' });
  assert.equal(process.permission.has('child'), false);
  assert.equal(process.permission.has('addons'), false);
});
