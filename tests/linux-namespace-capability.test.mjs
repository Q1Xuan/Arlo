import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namespaceUnavailable } from './helpers/linux-namespace-capability.mjs';

test('namespace probe recognizes runner uid-map denial without masking fixture failures', () => {
  assert.equal(namespaceUnavailable({ status: 1, stderr: 'unshare: write failed /proc/self/uid_map: Operation not permitted\n' }), true);
  assert.equal(namespaceUnavailable({ status: 1, stderr: 'unshare: unshare failed: Operation not permitted\n' }), true);
  assert.equal(namespaceUnavailable({ error: { code: 'ENOENT' } }), true);
  assert.equal(namespaceUnavailable({ status: 0, stderr: '' }), false);
  assert.equal(namespaceUnavailable({ status: 1, stderr: 'fixture assertion failed\n' }), false);
  assert.equal(namespaceUnavailable({ status: 1, stderr: 'unshare: write failed /unexpected: Operation not permitted\n' }), false);
  assert.equal(namespaceUnavailable({ error: { code: 'ETIMEDOUT' }, status: null, stderr: '' }), false);
});
