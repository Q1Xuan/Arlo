import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { captureRootConfigurationEvidence, type RootConfigurationEvidence } from '@arlo/sdk';

/** Public persistence boundary for opaque AdapterHost fixtures. Each actual
 * root object owns its own artifact; a display ID never serves as evidence. */
export function fixtureRootEvidence(stateDir: string) {
  const files = new WeakMap<object, string>();
  return (root: object): RootConfigurationEvidence => {
    let file = files.get(root);
    if (!file) {
      const directory = path.join(stateDir, 'fixture-host-sessions');
      fs.mkdirSync(directory, { recursive: true });
      file = path.join(directory, `${crypto.randomUUID()}.jsonl`);
      fs.writeFileSync(file, 'Persisted by the controlled public AdapterHost fixture.\n');
      files.set(root, file);
    }
    return captureRootConfigurationEvidence(file);
  };
}
