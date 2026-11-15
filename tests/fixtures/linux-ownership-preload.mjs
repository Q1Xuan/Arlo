import cp from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

// The read-only chroot cannot access the outer acceptance resource root. Keep
// independent per-process counters inside its owned home, including CLI children
// which intentionally construct a fresh environment.
const directory = '/home/network';
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
process.env.ARLO_LOW_LEVEL_NETWORK_FILE = `${directory}/${process.pid}-${randomUUID()}.json`;
await import('../../probes/isolation.mjs');
for (const name of ['spawn', 'spawnSync']) {
  const original = cp[name];
  cp[name] = (command, args, options = {}) => original(command, args, {
    ...options, env: { ...(options.env ?? process.env), NODE_OPTIONS: `--import=${import.meta.url}` },
  });
}
syncBuiltinESMExports();
