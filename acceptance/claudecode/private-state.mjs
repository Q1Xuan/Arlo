import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertSafeStatePath, enforceWindowsAcl, verifyWindowsAcl } from '@arlo/sdk';

// Only the new, empty acceptance directory is changed. Never modify an ancestor
// such as USERPROFILE, TEMP or the user's existing Claude configuration.
const [directory, owner] = process.argv.slice(2);
const marker = path.join(directory, '.arlo-owner.json');
if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== path.resolve(directory) ||
    fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(marker).isSymbolicLink() ||
    !fs.lstatSync(marker).isFile() || fs.lstatSync(marker).nlink !== 1 ||
    fs.readdirSync(directory).some(name => name !== '.arlo-owner.json')) {
  throw new Error('ACCEPTANCE_RESOURCE_OWNERSHIP_REQUIRED');
}
const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
if (value.owner !== owner || value.purpose !== 'issue105-real-acceptance') {
  throw new Error('ACCEPTANCE_RESOURCE_OWNERSHIP_REQUIRED');
}
// Python 3.13's mkdir(0700), also used by tempfile, installs an explicit
// OWNER RIGHTS ACE. The SDK deliberately allows only the current SID and
// trusted administrators. Remove that extra grant from this owned empty root;
// retain the SDK's existing allowlist and enforce its normal private ACL.
// Add the explicit user grant first, so removing OWNER RIGHTS cannot briefly
// remove the caller's ordinary directory access (including the test guard's
// alias/ownership checks).
enforceWindowsAcl(directory, true);
execFileSync('icacls.exe', [directory, '/remove:g', '*S-1-3-4'], {
  windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
});
enforceWindowsAcl(marker, false);
if (!verifyWindowsAcl(directory).valid || !verifyWindowsAcl(marker).valid) {
  throw new Error('ACCEPTANCE_PRIVATE_ACL_REQUIRED');
}
assertSafeStatePath(directory);
