import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  ArloDaemon,
  ArloErrorCode,
  ArloError,
  ControlClient,
  DaemonClient,
  type EndpointDiagnosticInfo,
} from '@arlo/daemon';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('ArloDaemon handles runtime and root session lifecycle with strict isolation', async () => {
  const stateDir = createTempDir('daemon-root-lifecycle');
  const daemon = new ArloDaemon({ stateDir });

  try {
    const { port } = await daemon.start();
    const control = new ControlClient({ stateDir, port });
    const userClient = new DaemonClient({ stateDir });

    // 1. Runtime registration with bootstrap token
    const rt1 = await control.registerRuntime({ host_type: 'deepseek-harness', host_version: '0.2.0' });
    assert.match(rt1.runtime_id, /^rt-[0-9a-f-]{36}$/);
    assert.match(rt1.runtime_token, /^[0-9a-f]{64}$/);

    // Cannot register runtime with invalid token
    const badControl = new ControlClient({ stateDir, port, bootstrapToken: 'invalid-token' });
    await assert.rejects(
      () => badControl.registerRuntime(),
      (err: any) => err instanceof ArloError && err.code === ArloErrorCode.UNAUTHORIZED
    );

    // 2. Root session registration with valid runtime token
    const root1 = await control.registerRoot(rt1.runtime_token, {
      root_session_id: 'host-session-alpha',
      display_name: 'Session Alpha',
      group_name: 'project-arlo',
      agent_incarnation: 'inc-001',
      plugin_generation: 1,
    });

    assert.match(root1.endpoint_id, /^ep-[0-9a-f-]{36}$/);
    assert.equal(root1.generation, 1);
    assert.match(root1.root_token, /^[0-9a-f]{64}$/);
    assert.match(root1.group_id, /^grp_v1_exp_[0-9a-f]{64}$/);
    assert.equal(root1.status, 'registered');
    assert.equal(root1.ready, false);
    assert.equal(root1.deliverable, false);

    // Root registration fails without valid runtime token
    await assert.rejects(
      () =>
        control.registerRoot('invalid-runtime-token', {
          root_session_id: 'host-session-beta',
          group_name: 'project-arlo',
          agent_incarnation: 'inc-002',
          plugin_generation: 1,
        }),
      (err: any) => err instanceof ArloError && err.code === ArloErrorCode.UNAUTHORIZED
    );

    // Root registration fails with invalid group name (e.g. contains control char or newline)
    await assert.rejects(
      () =>
        control.registerRoot(rt1.runtime_token, {
          root_session_id: 'host-session-beta',
          group_name: 'invalid\ngroup',
          agent_incarnation: 'inc-002',
          plugin_generation: 1,
        }),
      (err: any) => err instanceof ArloError && err.code === ArloErrorCode.INVALID_ARGUMENT
    );

    // 3. Independent bindings for same SessionId and same display_name across runtimes
    const rt2 = await control.registerRuntime({ host_type: 'deepseek-harness-2', host_version: '0.2.0' });
    const root2 = await control.registerRoot(rt2.runtime_token, {
      root_session_id: 'host-session-alpha', // Same host session ID as root1!
      display_name: 'Session Alpha',        // Same display name as root1!
      group_name: 'project-arlo',
      agent_incarnation: 'inc-other-proc',
      plugin_generation: 1,
    });

    assert.notEqual(root1.endpoint_id, root2.endpoint_id);
    assert.notEqual(root1.root_token, root2.root_token);
    assert.equal(root1.group_id, root2.group_id); // Same normalized group

    // 4. Cross-runtime and cross-root unauthorized access defense
    // rt1 cannot connect or revoke root2 owned by rt2
    await assert.rejects(
      () => control.connectRoot(rt1.runtime_token, { endpoint_id: root2.endpoint_id }),
      (err: any) => err instanceof ArloError && err.code === ArloErrorCode.UNAUTHORIZED
    );
    await assert.rejects(
      () => control.revokeRoot(rt1.runtime_token, { endpoint_id: root2.endpoint_id }),
      (err: any) => err instanceof ArloError && err.code === ArloErrorCode.UNAUTHORIZED
    );

    // root1's root token cannot connect or revoke root2
    await assert.rejects(
      () => control.connectRoot(root1.root_token, { endpoint_id: root2.endpoint_id }),
      (err: any) => err instanceof ArloError && err.code === ArloErrorCode.UNAUTHORIZED
    );
    await assert.rejects(
      () => control.revokeRoot(root1.root_token, { endpoint_id: root2.endpoint_id }),
      (err: any) => err instanceof ArloError && err.code === ArloErrorCode.UNAUTHORIZED
    );

    // 5. Connection generation advance and stale token defense
    const conn1 = await control.connectRoot(root1.root_token, { endpoint_id: root1.endpoint_id });
    assert.equal(conn1.endpoint_id, root1.endpoint_id);
    assert.equal(conn1.generation, 2);
    assert.notEqual(conn1.root_token, root1.root_token);

    // Old token from generation 1 is now stale and rejected
    await assert.rejects(
      () => control.connectRoot(root1.root_token, { endpoint_id: root1.endpoint_id }),
      (err: any) => err instanceof ArloError && err.code === ArloErrorCode.STALE_GENERATION
    );

    // 6. Revocation of single root
    const rev1 = await control.revokeRoot(conn1.root_token, { endpoint_id: root1.endpoint_id });
    assert.equal(rev1.status, 'revoked');

    // Revoked endpoint cannot be reconnected
    await assert.rejects(
      () => control.connectRoot(rt1.runtime_token, { endpoint_id: root1.endpoint_id }),
      (err: any) => err instanceof ArloError && err.code === ArloErrorCode.TARGET_UNAVAILABLE
    );

    // 7. Revocation of entire runtime
    const revRt2 = await control.revokeRuntime(rt2.runtime_token);
    assert.equal(revRt2.runtime_id, rt2.runtime_id);
    assert.deepEqual(revRt2.revoked_endpoints, [root2.endpoint_id]);

    // rt2 cannot register any more roots
    await assert.rejects(
      () =>
        control.registerRoot(rt2.runtime_token, {
          root_session_id: 'new-sess',
          group_name: 'group1',
          agent_incarnation: 'inc',
          plugin_generation: 1,
        }),
      (err: any) =>
        err instanceof ArloError &&
        (err.code === ArloErrorCode.UNAUTHORIZED || err.code === ArloErrorCode.STALE_GENERATION)
    );

    // 8. Read-only diagnostic verification
    const allRoots = await userClient.listRoots();
    assert.equal(allRoots.length, 2);
    for (const r of allRoots) {
      assert.equal(r.ready, false);
      assert.equal(r.deliverable, false);
      assert.equal(r.status, 'revoked');
      // Verify no sensitive fields leaked in diagnostic objects
      assert.equal((r as any).root_token, undefined);
      assert.equal((r as any).root_session_id, undefined);
      assert.equal((r as any).runtime_token, undefined);
      assert.equal((r as any).host_path, undefined);
    }

    const status = await userClient.getStatus();
    assert.equal(status.active_endpoints_count, 0);
    assert.equal(status.revoked_endpoints_count, 2);

    const doctor = await userClient.getDoctor();
    assert.equal(doctor.overall_status, 'healthy');
    const capCheck = doctor.checks.find((c) => c.name === 'endpoint_capacity');
    assert.ok(capCheck);
    assert.equal(capCheck.status, 'pass');

    // 9. Verify audit log integrity
    const logPath = path.join(stateDir, 'daemon.log');
    assert.ok(fs.existsSync(logPath));
    const logLines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const logEvents = logLines.map((l) => JSON.parse(l));

    const eventsSet = new Set(logEvents.map((e) => e.event));
    assert.ok(eventsSet.has('RUNTIME_REGISTERED'));
    assert.ok(eventsSet.has('ROOT_REGISTERED'));
    assert.ok(eventsSet.has('ROOT_CONNECTED'));
    assert.ok(eventsSet.has('ROOT_REVOKED'));
    assert.ok(eventsSet.has('RUNTIME_REVOKED'));

    // Verify canary check: tokens and host session IDs NEVER appear in log lines
    for (const line of logLines) {
      assert.ok(!line.includes(rt1.runtime_token), 'Runtime token must not leak in logs');
      assert.ok(!line.includes(root1.root_token), 'Root token must not leak in logs');
      assert.ok(!line.includes('host-session-alpha'), 'Host session ID must not leak in logs');
    }
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});

test('ArloDaemon enforces maximum 256 registered endpoints limit', async () => {
  const stateDir = createTempDir('daemon-root-limit');
  const daemon = new ArloDaemon({ stateDir });

  try {
    const { port } = await daemon.start();
    const control = new ControlClient({ stateDir, port });
    const rt = await control.registerRuntime({ host_type: 'bulk-test' });

    // Register 256 endpoints
    for (let i = 0; i < 256; i++) {
      const res = await control.registerRoot(rt.runtime_token, {
        root_session_id: `session-${i}`,
        group_name: `group-${i % 4}`,
        agent_incarnation: `inc-${i}`,
        plugin_generation: 1,
      });
      assert.equal(res.status, 'registered');
    }

    // 257th registration must be rejected with QUEUE_LIMIT
    await assert.rejects(
      () =>
        control.registerRoot(rt.runtime_token, {
          root_session_id: 'session-256-overflow',
          group_name: 'group-0',
          agent_incarnation: 'inc-overflow',
          plugin_generation: 1,
        }),
      (err: any) => err instanceof ArloError && err.code === ArloErrorCode.QUEUE_LIMIT
    );
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
