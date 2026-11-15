import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExplicitGroupName, ArloErrorCode, ArloError } from '@arlo/sdk';

test('valid explicit group names are NFC normalized, trimmed, and assigned opaque group IDs', () => {
  // Simple ASCII
  const g1 = validateExplicitGroupName('  core-team  ');
  assert.equal(g1.groupName, 'core-team');
  assert.match(g1.groupId, /^grp_v1_exp_[0-9a-f]{64}$/);

  // Unicode / Chinese
  const g2 = validateExplicitGroupName('  研发第一组  ');
  assert.equal(g2.groupName, '研发第一组');
  assert.match(g2.groupId, /^grp_v1_exp_[0-9a-f]{64}$/);

  // Unicode NFC normalization: decomposed "e\u0301" vs composed "\u00e9"
  const decomposed = 'caf\u0065\u0301';
  const composed = 'caf\u00e9';
  const resDecomposed = validateExplicitGroupName(decomposed);
  const resComposed = validateExplicitGroupName(composed);
  assert.equal(resDecomposed.groupName, composed);
  assert.equal(resDecomposed.groupId, resComposed.groupId);

  // Single character
  const single = validateExplicitGroupName('X');
  assert.equal(single.groupName, 'X');

  // Exact 64 Unicode characters
  const name64 = '一'.repeat(64);
  const res64 = validateExplicitGroupName(name64);
  assert.equal(res64.groupName, name64);
  assert.equal(validateExplicitGroupName('🚀'.repeat(64)).groupName, '🚀'.repeat(64));
  assert.equal(validateExplicitGroupName('\u00a0\u3000team\u3000\u00a0').groupName, 'team');

  // Case sensitivity: 'DevTeam' and 'devteam' produce distinct names and IDs
  const upper = validateExplicitGroupName('DevTeam');
  const lower = validateExplicitGroupName('devteam');
  assert.equal(upper.groupName, 'DevTeam');
  assert.equal(lower.groupName, 'devteam');
  assert.notEqual(upper.groupId, lower.groupId);
});

test('invalid explicit group names are rejected with INVALID_ARGUMENT', () => {
  // Non-string
  assert.throws(() => validateExplicitGroupName(null), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);
  assert.throws(() => validateExplicitGroupName(123), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);

  // Empty or whitespace only
  assert.throws(() => validateExplicitGroupName(''), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);
  assert.throws(() => validateExplicitGroupName('   \t  '), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);

  // Exceeds 64 Unicode characters (65 characters)
  const name65 = '字'.repeat(65);
  assert.throws(() => validateExplicitGroupName(name65), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);
  assert.throws(() => validateExplicitGroupName('🚀'.repeat(65)), { code: ArloErrorCode.INVALID_ARGUMENT });

  // Control characters and newlines
  assert.throws(() => validateExplicitGroupName('team\nalpha'), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);
  assert.throws(() => validateExplicitGroupName('team\r\nalpha'), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);
  assert.throws(() => validateExplicitGroupName('team\u0000'), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);
  assert.throws(() => validateExplicitGroupName('team\u001b'), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);
  assert.throws(() => validateExplicitGroupName('team\u007f'), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);

  // Path separators and traversal
  assert.throws(() => validateExplicitGroupName('path/to/group'), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);
  assert.throws(() => validateExplicitGroupName('path\\to\\group'), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);
  assert.throws(() => validateExplicitGroupName('../group'), (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT);
});

test('Communication Group rejects controls and Unicode line breaks before trimming', () => {
  const forbidden = [
    ...Array.from({ length: 32 }, (_, i) => String.fromCodePoint(i)),
    ...Array.from({ length: 33 }, (_, i) => String.fromCodePoint(0x7f + i)),
    '\u2028', '\u2029',
  ];
  for (const character of forbidden) {
    for (const name of [`${character}team`, `team${character}`, `team${character}other`]) {
      assert.throws(
        () => validateExplicitGroupName(name),
        { code: ArloErrorCode.INVALID_ARGUMENT },
        `Must reject ${JSON.stringify(name)}`,
      );
    }
  }
});
