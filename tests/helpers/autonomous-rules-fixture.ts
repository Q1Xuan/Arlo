import fs from 'node:fs';
import path from 'node:path';
import type { ArloDaemonOptions } from '@arlo/daemon';
import { autonomousSendingRig } from './autonomous-sending-fixture.ts';

type RootName = 'a' | 'b';

/** Two-root rule scenarios share the real dispatch and lifecycle fixture. */
export async function autonomousRulesRig(options: ArloDaemonOptions = {}) {
  const rig = await autonomousSendingRig(options, ['a', 'b']);
  const rulesPath = path.join(rig.stateDir, 'autonomous-communication.json');
  return {
    ...rig,
    rulesPath,
    writeRules: (value: unknown) => fs.writeFileSync(rulesPath, JSON.stringify(value), { mode: 0o600 }),
    send: (text = 'new business input', from: RootName = 'a', id?: string, replyTo?: string) =>
      rig.send(from === 'a' ? 'b' : 'a', text, id, from, replyTo),
  };
}
