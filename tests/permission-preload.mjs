import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { installPermissionGuard } from './helpers/permission-guard.mjs';

// Recreated corruption fixtures must retain private default permissions too.
process.umask(0o077);
let root = process.env.ARLO_TEST_ROOT;
let owner = process.env.ARLO_TEST_OWNER;
export const createdTestRoot = !root;
if (!root) {
  // Windows needs a private ancestor; POSIX permits the sticky temporary root.
  const parent = process.platform === 'win32' || !fs.existsSync(os.tmpdir()) ? os.homedir() : os.tmpdir();
  root = fs.mkdtempSync(path.join(parent, 'arlo-test-run-'));
  owner = randomUUID();
  fs.writeFileSync(path.join(root, '.arlo-test-owner.json'), JSON.stringify({ owner }), { mode: 0o600, flag: 'wx' });
}
if (!owner || fs.lstatSync(root).isSymbolicLink() ||
    JSON.parse(fs.readFileSync(path.join(root, '.arlo-test-owner.json'), 'utf8')).owner !== owner) {
  throw new Error('TEST_RESOURCE_OWNERSHIP_REQUIRED');
}
export const testRoot = fs.realpathSync(root);
process.env.ARLO_TEST_ROOT = testRoot;
process.env.ARLO_TEST_OWNER = owner;
installPermissionGuard({ root: testRoot, owner });
if (createdTestRoot && process.platform === 'win32') {
  const { enforceWindowsAcl } = await import('../packages/sdk/src/security/index.ts');
  enforceWindowsAcl(testRoot, true);
}
