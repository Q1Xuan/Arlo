import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function probeSourceSha256(root) {
  const hash = createHash('sha256');
  for (const name of readdirSync(path.join(root, 'probes')).sort()) {
    if (!/\.(?:ts|mjs|mts)$/.test(name)) continue;
    hash.update(name).update('\0').update(readFileSync(path.join(root, 'probes', name))).update('\0');
  }
  return hash.digest('hex');
}
