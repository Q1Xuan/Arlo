import crypto from 'node:crypto';

/** Internal wire encoding shared by explicit names and canonical project identities. */
export function encodeCommunicationGroup(category: 'exp' | 'git' | 'dir', identity: string): string {
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(['arlo-group', 1, category, identity]), 'utf8').digest('hex');
  return `grp_v1_${category}_${hash}`;
}
