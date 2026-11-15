import fs from 'node:fs';
import path from 'node:path';
import { ArloDaemon } from '@arlo/daemon';
import { MAX_LOG_FILE_SIZE } from '../../packages/daemon/src/logging/index.ts';

const stateDir = process.env.ARLO_STATE_DIR!;
const daemon = new ArloDaemon({ stateDir });
process.on('disconnect', () => { void daemon.stop(); });
process.on('message', (message: { id: number; command: { action: string } }) => {
  if (message.command.action !== 'seed-rotation') return;
  // This synchronous boundary setup runs in the logger's process, so a
  // heartbeat cannot append between measuring the file and filling it.
  const file = path.join(stateDir, 'daemon.log');
  const current = fs.readFileSync(file, 'utf8');
  const line = `${JSON.stringify(JSON.parse(current.split('\n')[0]))}\n`;
  const remaining = MAX_LOG_FILE_SIZE - 1 - Buffer.byteLength(current);
  const padding = line.repeat(Math.floor(remaining / Buffer.byteLength(line)));
  fs.appendFileSync(file, padding + ' '.repeat(remaining - Buffer.byteLength(padding)));
  process.send?.({ id: message.id, result: { seeded: true } });
});
process.send?.({ ready: true, ...await daemon.start() });
