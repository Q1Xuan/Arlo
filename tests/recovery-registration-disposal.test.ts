import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlClient, ArloError, ArloErrorCode, type RootRegistrationResponse } from '@arlo/sdk';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { fixture } from '../probes/fixture.ts';
import { MessageStatusFixture } from './helpers/message-status-fixture.ts';

test('Disposal during a lost registration response retires the old instance before registering its replacement', { timeout: 30000 }, async t => {
  const rig = await MessageStatusFixture.create({ roots: 0 });
  const host = await fixture();
  const accepted = Promise.withResolvers<void>();
  const releaseLoss = Promise.withResolvers<void>();
  let oldRegistration: RootRegistrationResponse | undefined;
  const attempts: Parameters<ControlClient['registerRoot']>[1][] = [];
  class LostRegistrationClient extends ControlClient {
    override async registerRoot(...args: Parameters<ControlClient['registerRoot']>) {
      attempts.push(args[1]);
      const response = await super.registerRoot(...args);
      if (!oldRegistration) {
        oldRegistration = response;
        accepted.resolve();
        await releaseLoss.promise;
        throw new ArloError(ArloErrorCode.CONNECTION_LOST);
      }
      return response;
    }
  }
  t.after(async () => { releaseLoss.resolve(); await host.ctx.fiber.dispose(); await rig.dispose(); });
  await host.ctx.plugin(createArloHarnessPlugin({
    stateDir: rig.stateDir, groupName: 'team-status', controlClient: new LostRegistrationClient({ stateDir: rig.stateDir }),
    recovery: { random: () => 0 },
  }));
  await accepted.promise;
  const originalAgent = host.root.agent;
  await host.root.dispose();
  host.root = await host.ctx.agents.create({
    sessionId: originalAgent.session.id, agentOptions: { provider: 'arlo-local', model: 'scripted' },
  });
  releaseLoss.resolve();
  let roots = await rig.control.listRoots();
  for (let attempt = 0; attempt < 120; attempt++) {
    roots = await rig.control.listRoots();
    if (roots.some(root => root.endpoint_id !== oldRegistration!.endpoint_id && root.deliverable)) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(roots.find(root => root.endpoint_id === oldRegistration!.endpoint_id)?.status, 'revoked');
  const replacement = roots.find(root => root.endpoint_id !== oldRegistration!.endpoint_id && root.deliverable);
  assert.ok(replacement, 'The replacement must not remain blocked behind an unacknowledged old registration');
  assert.notEqual(host.root.agent, originalAgent);
  assert.notEqual(attempts.at(-1)!.agent_incarnation, attempts[0]!.agent_incarnation);
  assert.notEqual(attempts.at(-1)!.continuity_token, attempts[0]!.continuity_token);
  assert.equal(roots.filter(root => root.status === 'registered').length, 1);
});
