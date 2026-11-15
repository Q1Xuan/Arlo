import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ArloDaemon } from '@arlo/daemon';
import {
  ArloErrorCode,
  ArloError,
  ControlClient,
  DaemonClient,
  type RootRegistrationRequest,
  type RootRegistrationResponse,
} from '@arlo/sdk';
import {
  createArloHarnessPlugin,
  ARLO_REGISTRY_OWNER_KEY,
} from '@arlo/adapter-dsh/runtime';
import { fixture, LocalModel, toolResponse } from '../probes/fixture.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('ArloHarnessPlugin registers real roots, isolates child agents, and handles lifecycle with strict defense', async () => {
  const stateDir = createTempDir('harness-adapter-test');
  const daemon = new ArloDaemon({ stateDir });

  try {
    const { port } = await daemon.start();
    const registrations = new Map<string, RootRegistrationResponse>();
    class TrackingControlClient extends ControlClient {
      async registerRoot(token: string, request: RootRegistrationRequest) {
        const response = await super.registerRoot(token, request);
        registrations.set(request.root_session_id, response);
        return response;
      }
    }
    const controlClient = new TrackingControlClient({ stateDir, port });
    const userClient = new DaemonClient({ stateDir });

    const model = new LocalModel();
    const host = await fixture(model);

    try {
      const pluginDef = createArloHarnessPlugin({
        groupName: 'team-deepseek',
        stateDir,
        controlClient,
      });

      // 1. Single valid integration per registry (AC 3) & repeated load defense
      const fork1 = await host.ctx.plugin(pluginDef);
      const fork2 = await host.ctx.plugin(pluginDef);
      assert.ok(Reflect.has(host.ctx.agents, ARLO_REGISTRY_OWNER_KEY));

      // Wait briefly for root registration to complete
      let rootsDiag: any[] = [];
      for (let i = 0; i < 30; i++) {
        rootsDiag = await userClient.listRoots();
        if (rootsDiag.length >= 1 && rootsDiag[0].ready) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // AC 1: Only real roots are registered; child agents are NOT registered
      assert.equal(rootsDiag.length, 1);
      const rootDiag = rootsDiag[0];
      assert.equal(rootDiag.status, 'registered');
      assert.equal(rootDiag.ready, true);
      assert.equal(rootDiag.deliverable, true);

      // 2. Dynamic registration on new root creation
      const root2 = await host.ctx.agents.create({
        sessionId: SessionId('fictional-second-root'),
        agentOptions: { provider: 'arlo-local', model: 'scripted' },
      });

      for (let i = 0; i < 30; i++) {
        rootsDiag = await userClient.listRoots();
        if (rootsDiag.length >= 2 && registrations.has(String(root2.agent.session.id))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(rootsDiag.length, 2);

      // A new child agent created under root2 is NOT registered
      const child2 = await root2.agent.ctx.agents.create({
        sessionId: SessionId('fictional-second-child'),
        parentAgent: root2.agent,
        agentOptions: { provider: 'arlo-local', model: 'scripted' },
      });
      await new Promise((r) => setTimeout(r, 200));
      rootsDiag = await userClient.listRoots();
      assert.equal(rootsDiag.length, 2); // Still 2, child2 is not registered!

      // 3. Model tool facade: caller identification & sub-agent isolation (AC 6)
      // Root agent execution succeeds
      model.script.push(toolResponse('arlo_list_sessions'));
      host.root.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'call list sessions' }],
          source: { kind: 'arlo', form: 'relay' },
        })
      );
      await host.root.agent.whenIdle();
      // Host root agent finished turn without error

      // Child agent execution fails with CALLER_NOT_ROOT
      model.script.push(toolResponse('arlo_list_sessions'));
      host.child.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'child tries to call list sessions' }],
          source: { kind: 'arlo', form: 'relay' },
        })
      );

      // We expect child tool execution to throw or fail with CALLER_NOT_ROOT
      await host.child.agent.whenIdle();
      // The child's session events show the error
      const childEvents = host.child.agent.session.snapshotEvents();
      const toolResultEvents = childEvents.filter((e) => e.type === 'tool/result');
      assert.ok(toolResultEvents.length > 0);
      const lastResult = JSON.stringify(toolResultEvents[toolResultEvents.length - 1]);
      assert.ok(
        lastResult.includes('CALLER_NOT_ROOT'),
        `Child tool execution must fail with CALLER_NOT_ROOT, got: ${lastResult}`
      );

      // 4. Agent replacement: disposing root2 revokes its binding
      const root2Endpoint = registrations.get(String(root2.agent.session.id))!.endpoint_id;
      await root2.dispose();
      for (let i = 0; i < 30; i++) {
        rootsDiag = await userClient.listRoots();
        const r2 = rootsDiag.find((r) => r.endpoint_id === root2Endpoint);
        if (r2?.status === 'revoked') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(rootsDiag.find(r => r.endpoint_id === root2Endpoint)?.status, 'revoked');

      // 5. Plugin unload lifecycle (AC 8)
      // Disposing the plugin synchronously invalidates bindings and does NOT destroy host agents
      await fork1.dispose();
      assert.equal(host.root.agent.status, 'idle'); // Host agent is NOT destroyed!
      assert.equal(host.child.agent.status, 'idle'); // Host child agent is NOT destroyed!

      // After plugin disposal, owner key is cleaned up
      assert.equal(Reflect.has(host.ctx.agents, ARLO_REGISTRY_OWNER_KEY), false);

      // Plugin can be cleanly reloaded
      const fork3 = await host.ctx.plugin(pluginDef);
      assert.ok(Reflect.has(host.ctx.agents, ARLO_REGISTRY_OWNER_KEY));
      for (let i = 0; i < 30; i++) {
        rootsDiag = await userClient.listRoots();
        if (registrations.get(String(host.root.agent.session.id))?.endpoint_id !== rootDiag.endpoint_id &&
            rootsDiag.filter(r => r.status === 'registered').length === 1) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const reloadedEndpoint = registrations.get(String(host.root.agent.session.id))!.endpoint_id;
      assert.notEqual(reloadedEndpoint, rootDiag.endpoint_id);

      // 6. In-flight agent disposal race (AC 8 / Spec)
      // When a root agent is created and immediately disposed while registration is in-flight,
      // the adapter revokes the in-flight registration and leaves no stale active bindings.
      const racingRoot = await host.ctx.agents.create({
        sessionId: SessionId('racing-disposed-root'),
        agentOptions: { provider: 'arlo-local', model: 'scripted' },
      });
      // Synchronously dispose immediately without waiting for registerRoot to settle
      await racingRoot.dispose();
      for (let i = 0; i < 30; i++) {
        rootsDiag = await userClient.listRoots();
        if (rootsDiag.filter(r => r.status === 'registered').every(r => r.endpoint_id === reloadedEndpoint)) break;
        await new Promise(r => setTimeout(r, 100));
      }
      assert.deepEqual(rootsDiag.filter(r => r.status === 'registered').map(r => r.endpoint_id), [reloadedEndpoint]);

      // 7. Same SessionId in independent registry / host integration (AC 3)
      // Different registries with identical SessionId create independent bindings and endpoints
      const host2 = await fixture(new LocalModel());
      try {
        const pluginDef2 = createArloHarnessPlugin({
          groupName: 'team-deepseek',
          stateDir,
          controlClient,
        });
        const forkHost2 = await host2.ctx.plugin(pluginDef2);
        for (let i = 0; i < 100; i++) {
          rootsDiag = await userClient.listRoots();
          // A disposed root can still be finishing registration in the first
          // runtime. Wait for the second host, not merely any two endpoints.
          const registered = rootsDiag.filter((r) => r.status === 'registered');
          if (registered.length === 2 && new Set(registered.map((r) => r.runtime_id)).size === 2) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        // Independent endpoint created for host2's root
        const registeredRoots = rootsDiag.filter((r) => r.status === 'registered');
        assert.equal(registeredRoots.length, 2);
        assert.equal(new Set(registeredRoots.map(r => r.endpoint_id)).size, 2);
        assert.equal(new Set(registeredRoots.map(r => r.runtime_id)).size, 2);
        await forkHost2.dispose();
      } finally {
        await host2.ctx.fiber.dispose();
      }
      await fork3.dispose();
    } finally {
      await host.ctx.fiber.dispose();
    }
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
