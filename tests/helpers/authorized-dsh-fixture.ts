import crypto from 'node:crypto';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createArloHarnessPlugin as productionPlugin, type ArloPluginOptions } from '@arlo/adapter-dsh/runtime';
import { captureRootConfigurationEvidence } from '@arlo/sdk';
import { fixture as productionFixture, LocalModel } from '../../probes/fixture.ts';
import { AuthorizedControlClient } from './authorized-control.ts';
import { createTempDir, removeTempDir } from '../test-utils.ts';

/** Legacy communication regressions explicitly model human-authorized periods.
 * Independent actual roots receive unique public IDs; the production default
 * root registration and allowance remain unchanged. */
export async function fixture(model = new LocalModel(), beforeAgents?: Parameters<typeof productionFixture>[1],
  options: Parameters<typeof productionFixture>[2] = {}) {
  const directory = createTempDir('authorized-dsh-host');
  try {
    const host = await productionFixture(model, beforeAgents, { ...options, sessionDirectory: directory,
      sessionId: `authorized-host-${crypto.randomUUID()}` });
    return { ...host, dispose: async () => { await host.ctx.fiber.dispose(); removeTempDir(directory); } };
  } catch (error) { removeTempDir(directory); throw error; }
}

const stores = new WeakMap<object, string>();

/** Only old receipt, transport and capacity regressions import this helper.
 * The real DSH backend owns and flushes the session through public APIs;
 * simulated user grants use the real authenticated SDK and Daemon. */
export function createArloHarnessPlugin(options: ArloPluginOptions) {
  const control = options.controlClient ?? new AuthorizedControlClient({ stateDir: options.stateDir! });
  if (!(control instanceof AuthorizedControlClient)) {
    throw new Error('Authorized DSH regression fixtures must use the test AuthorizedControlClient');
  }
  const implementation = productionPlugin({ ...options, controlClient: control });
  const plugin = async (ctx: Context) => {
    let directory = stores.get(ctx.agents);
    if (!directory) {
      directory = path.join(control.stateDirectory, 'authorized-dsh-sessions', crypto.randomUUID());
      stores.set(ctx.agents, directory);
    }
    if (!ctx.get('sessionPersistence')) await ctx.plugin(JsonlSessionPersistence, { root: directory });
    control.setRootEvidence(async request => {
      const agent = ctx.agents.get(SessionId(request.root_session_id));
      if (!agent || !ctx.agents.roots().includes(agent)) return undefined;
      await ctx.sessions.flush(agent.session);
      const persistence = ctx.get('sessionPersistence') as JsonlSessionPersistence;
      const sessionFile = await persistence.resolveCurrentLog(agent.session.id);
      const header = agent.session.header;
      const origin = JSON.stringify([header.id, header.createdAt, header.cwd, header.parentSession,
        header.isSeeded, header.origin, header.delegationDepth ?? 0, header.agentPreset]);
      return sessionFile ? captureRootConfigurationEvidence(sessionFile, undefined, origin) : undefined;
    });
    await ctx.plugin(implementation);
  };
  return Object.assign(plugin, implementation);
}
