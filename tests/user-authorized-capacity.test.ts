import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, type RootConnection, type RootSendingStatus } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

interface LedgerSnapshot {
  version: number;
  authority: string;
  namespace: string;
  rows: unknown[];
  operations: Array<{ id: string; fingerprint: string; result: RootSendingStatus }>;
  checksum: string;
}

test('a new Claude authorization cannot exceed ledger capacity or invalidate existing allowance', async t => {
  const stateDir = createTempDir('user-authorized-capacity-');
  const daemon = new ArloDaemon({ stateDir });
  const connections: RootConnection[] = [];
  t.after(async () => {
    for (const connection of connections) connection.dispose();
    await daemon.stop();
    removeTempDir(stateDir);
  });
  await daemon.start();
  const control = new ControlClient({ stateDir });
  const runtime = await control.registerRuntime({ host_kind: 'claudecode' });
  async function attach(sessionId: string) {
    const binding = await control.registerRoot(runtime.runtime_token, {
      root_session_id: sessionId, group_name: 'capacity',
      agent_incarnation: crypto.randomUUID(), plugin_generation: 1,
    });
    const connection = control.createRootConnection(binding, { heartbeat: false });
    connections.push(connection);
    await connection.connect();
    await control.confirmRootReady(binding.root_token, { endpoint_id: binding.endpoint_id });
    const request = { endpoint_id: binding.endpoint_id, generation: binding.generation };
    return {
      status: () => control.getRootSendingStatus(binding.root_token, request),
      authorize: () => control.authorizeRoot(binding.root_token, { ...request, request_id: crypto.randomUUID() }),
      grant: async () => {
        const status = await control.getRootSendingStatus(binding.root_token, request);
        return control.continueCollaboration(binding.root_token, {
          ...request, daemon_id: status.daemon_id, sequence: status.control_sequence + 1,
          request_id: crypto.randomUUID(),
        });
      },
    };
  }
  const existing = await attach('capacity-existing');
  await existing.authorize();
  const original = await existing.grant();

  // Seed the documented durable snapshot boundary from real committed results.
  // One root and 9,998 retained operations leave one of the 10,000 slots free;
  // another authorization needs both a new root and its committed result.
  const file = path.join(stateDir, 'user-authorized-roots.json');
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8')) as LedgerSnapshot;
  const authorization = ledger.operations[0];
  while (ledger.operations.length < 9_998) {
    ledger.operations.push({ ...authorization, id: `capacity-operation-${ledger.operations.length}` });
  }
  ledger.checksum = crypto.createHash('sha256').update(JSON.stringify([
    ledger.version, ledger.authority, ledger.namespace, ledger.rows, ledger.operations,
  ])).digest('hex');
  fs.writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 });
  assert.equal((await existing.status()).period_id, original.period_id, 'The near-capacity snapshot must be valid');

  const newcomer = await attach('capacity-newcomer');
  await assert.rejects(newcomer.authorize(), { code: 'CONTROL_HISTORY_UNAVAILABLE' });
  const preserved = await existing.status();
  assert.equal(preserved.root_configuration.ownership, 'user-authorized');
  assert.equal(preserved.period_id, original.period_id);
  assert.equal(preserved.remaining, 20);
  assert.equal((await newcomer.status()).root_configuration.reason, 'AUTHORIZATION_REQUIRED');
});
