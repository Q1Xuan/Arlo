import crypto from 'node:crypto';
import path from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { fixture, LocalModel } from '../../probes/fixture.ts';

/** Independent process regressions now use the public durable Host backend,
 * so their test driver can authorize communication through the real human API. */
export async function persistedHarnessFixture(model: LocalModel, options: { sessionCwd?: string } = {}) {
  const profile = process.env.USERPROFILE ?? process.cwd();
  const identity = crypto.createHash('sha256').update(profile).digest('hex').slice(0, 16);
  return fixture(model, undefined, { ...options, sessionDirectory: path.join(profile, 'regression-sessions'),
    sessionId: `regression-root-${identity}` });
}

/** Each renewal represents a separate test-driver human operation. This is
 * only for regressions exercising other budgets; the autonomous acceptance
 * worker intentionally does not import or renew through this helper. */
export function humanSendAllowance(definition: ReturnType<typeof createArloHarnessPlugin>, agent: Agent) {
  let intentsRemaining = 0;
  return {
    reset() { intentsRemaining = 0; },
    async prepare(count = 1) {
      if (count > 20) throw new Error('Split the scripted human-approved batch at the default twenty-attempt period');
      if (intentsRemaining < count) {
        const granted = await definition.continueCollaboration(agent);
        if (granted.knowledge !== 'known' || granted.remaining !== 20) throw new Error('Public human operation did not grant a full default period');
        intentsRemaining = granted.remaining;
      }
      intentsRemaining -= count;
    },
  };
}
