import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

assert.equal(process.version, process.env.ARLO_EXPECTED_NODE, 'Host Node patch must match the pinned candidate');
if (process.env.ARLO_EXPECTED_ELECTRON) {
  assert.equal(process.versions.electron, process.env.ARLO_EXPECTED_ELECTRON);
}
writeFileSync('runtime-observed.json', JSON.stringify({
  node: process.version, electron: process.versions.electron ?? null,
  platform: process.platform, arch: process.arch,
}));
