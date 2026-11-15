import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionId } from '@deepseek-ai/dsh-session';
import { fixture } from './fixture.ts';
import { runSecureTransportScenario } from './secure-transport-scenario.ts';
import { recordProbeEvidence } from './evidence.ts';

test('HTTPS MCP and real host reception share the pinned streaming transport', { timeout: 20000 }, async () => {
  const host = await fixture();
  try {
    const other = await host.ctx.agents.create({ sessionId: SessionId('fictional-second-root'),
      agentOptions: { provider: 'arlo-local', model: 'scripted' } });
    const observations = await runSecureTransportScenario(host.root.agent, other.agent);
    assert.equal(observations.wireRevision, '2025-06-18');
    recordProbeEvidence('httpsAndHost', observations);
  } finally { await host.ctx.fiber.dispose(); }
});
