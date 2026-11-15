import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { LocalModel } from './fixture.ts';
import { runSecureTransportScenario } from './secure-transport-scenario.ts';

export const name = 'arlo-installed-https-transport-probe';
export const inject = ['agents', 'llm', 'tools', 'systemPrompt'];

export async function apply(ctx: Context) {
  // Cordis can reapply an injected plugin as services settle during startup.
  // A probe run owns one registry; repeated applications must not create roots.
  const owner = Symbol.for('arlo.m0.installed-transport-probe');
  if (Reflect.has(ctx.agents, owner)) return;
  Object.defineProperty(ctx.agents, owner, { value: true });
  const report: Record<string, unknown> = {
    runtime: { node: process.version, electron: process.versions.electron ?? null, platform: process.platform },
    publicPluginEntry: 'cordis.patch.yml', pass: false,
  };
  try {
    const model = new LocalModel();
    ctx.llm.registerAdapter(['arlo-https-local'], model);
    // Fixture setup only. The reception path below never creates/resumes agents.
    const roots = [];
    for (const id of ['fictional-https-root-a', 'fictional-https-root-b']) {
      const fixture = await ctx.agents.create({ sessionId: SessionId(id),
        agentOptions: { provider: 'arlo-https-local', model: 'scripted' } });
      fixture.agent.ctx.systemPrompt.variable('cwd', () => process.cwd());
      roots.push(fixture);
    }
    try {
      assert.ok(roots.every(root => ctx.agents.roots().includes(root.agent)));
      report.observations = await runSecureTransportScenario(roots[0]!.agent, roots[1]!.agent, true);
      assert.ok(model.requests.length > 0, 'The installed host must actually consume input using the local model');
      report.localModelRequests = model.requests.length;
      report.pass = true;
    } finally {
      for (const root of roots) await root.dispose();
    }
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    writeFileSync(process.env.ARLO_TRANSPORT_REPORT!, JSON.stringify(report, null, 2) + '\n');
  }
}
