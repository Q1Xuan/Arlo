import '../permission-preload.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ArloDaemon } from '@arlo/daemon';
const [stateDir, phase] = process.argv.slice(2);
const daemon = new ArloDaemon({ stateDir });
let armed = false;
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (armed && String(to) === path.join(stateDir, 'user-authorized-roots.json')) {
    if (phase === 'after') rename(from, to);
    process.kill(process.pid, 'SIGKILL');
    throw new Error('Unreachable after SIGKILL');
  }
  return rename(from, to);
};
process.on('message', message => {
  if (message === 'arm') { armed = true; process.send?.('armed'); }
  if (message === 'shutdown') void daemon.stop().finally(() => process.exit(0));
});
process.on('SIGTERM', () => { void daemon.stop().finally(() => process.exit(0)); });
await daemon.start();
process.send?.('ready');
