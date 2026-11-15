import { AuthorizedControlClient as ControlClient } from './helpers/authorized-control.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ArloDaemon } from '@arlo/daemon';
import {

  ArloErrorCode,
  MAX_DELIVERY_SEQ,
  type ArloMessageNotificationParams,
  type RootRegistrationResponse,
} from '@arlo/sdk';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from './test-utils.ts';

type RootConnection = ReturnType<ControlClient['createRootConnection']>;

interface Rig {
  daemon: ArloDaemon;
  control: ControlClient;
  rootA: RootRegistrationResponse;
  rootB: RootRegistrationResponse;
  rootC: RootRegistrationResponse;
  connA: RootConnection;
  connB: RootConnection;
  connC: RootConnection;
  /** Currently valid control token for root B; rotation invalidates the previous one. */
  token: string;
  /** Installs the target's reception handler; every new connection needs it. */
  installReception: (connection: RootConnection) => void;
  notifications: ArloMessageNotificationParams[];
  dispose: () => void;
}

async function startRig(
  daemonOptions: ConstructorParameters<typeof ArloDaemon>[0] = {},
  rigOptions: { autoReceipt?: boolean; authorizeSenderBeforeConnection?: boolean } = {}
): Promise<Rig> {
  const stateDir = createTempDir('daemon-retention');
  const daemon = new ArloDaemon({ rateLimit: UNPACED_RATE_LIMIT, ...daemonOptions, stateDir });
  const { port } = await daemon.start();
  const control = new ControlClient({ stateDir, port });

  const runtime = await control.registerRuntime({ host_type: 'deepseek-harness', host_version: '0.2.0' });
  const register = (suffix: string, group: string) =>
    control.registerRoot(runtime.runtime_token, {
      root_session_id: `host-retention-${suffix}`,
      group_name: group,
      agent_incarnation: `inc-retention-${suffix}`,
      plugin_generation: 1,
    });
  const rootA = await register('a', 'retention-alpha');
  const rootB = await register('b', 'retention-alpha');
  const rootC = await register('c', 'retention-beta');
  if (rigOptions.authorizeSenderBeforeConnection) await control.fixtureAuthorize(rootA);

  const connA = control.createRootConnection(rootA);
  const connB = control.createRootConnection(rootB);
  const connC = control.createRootConnection(rootC);
  const notifications: ArloMessageNotificationParams[] = [];
  const installReception = (connection: RootConnection) => {
    connection.onNotification((params) => {
      notifications.push(params);
      if (rigOptions.autoReceipt !== false) {
        void control.submitReceipt(rig.token, {
          daemon_id: params.daemon_id,
          endpoint_id: rootB.endpoint_id,
          message_id: params.message_id,
          delivery_id: params.delivery_id,
          generation: params.target_generation,
          status: 'enqueued',
          native_message_id: `native-${params.message_id}`,
        }).catch(() => {});
      }
    });
  };
  const rig: Rig = {
    daemon,
    control,
    rootA,
    rootB,
    rootC,
    connA,
    connB,
    connC,
    token: rootB.root_token,
    installReception,
    notifications,
    dispose: () => {
      connA.dispose();
      connB.dispose();
      connC.dispose();
    },
  };
  installReception(connB);

  await connA.connect();
  await connB.connect();
  await connC.connect();
  await control.confirmRootReady(rootA.root_token, { endpoint_id: rootA.endpoint_id });
  await control.confirmRootReady(rootB.root_token, { endpoint_id: rootB.endpoint_id });
  await control.confirmRootReady(rootC.root_token, { endpoint_id: rootC.endpoint_id });

  return rig;
}

async function stopRig(rig: Rig): Promise<void> {
  const stateDir = rig.daemon.stateDir;
  rig.dispose();
  await rig.daemon.stop();
  removeTempDir(stateDir);
}

function bindingOf(
  binding: { endpoint_id: string; generation: number; root_token: string },
  groupId: string
): RootRegistrationResponse {
  return {
    endpoint_id: binding.endpoint_id,
    generation: binding.generation,
    root_token: binding.root_token,
    group_id: groupId,
    status: 'registered',
    ready: false,
    deliverable: false,
  };
}

// The target host consumed everything the daemon still counts as pending.
async function releaseAllCredits(rig: Rig): Promise<void> {
  for (const frame of rig.notifications) {
    await rig.control.releaseCredit(rig.token, {
      endpoint_id: rig.rootB.endpoint_id,
      message_id: frame.message_id,
      native_message_id: `native-${frame.message_id}`,
      event: 'claimed',
    });
  }
}

async function rotateTarget(rig: Rig, conn: RootConnection): Promise<RootConnection> {
  await releaseAllCredits(rig);
  const rotated = await rig.control.connectRoot(rig.token, { endpoint_id: rig.rootB.endpoint_id });
  assert.equal(rotated.generation, 2);
  rig.token = rotated.root_token;
  conn.dispose();
  const next = rig.control.createRootConnection(bindingOf(rotated, rig.rootB.group_id));
  rig.installReception(next);
  await next.connect();
  await rig.control.confirmRootReady(rig.token, { endpoint_id: rig.rootB.endpoint_id });
  return next;
}

async function waitForNotification(rig: Rig): Promise<ArloMessageNotificationParams> {
  const deadline = Date.now() + 5000;
  while (rig.notifications.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(rig.notifications.length, 1, 'The target received exactly one dispatch');
  return rig.notifications[0];
}

test('Delivery sequences stay canonical and monotonic inside one generation and restart with the next', async () => {
  const rig = await startRig();
  let rotated: RootConnection | undefined;
  try {
    for (let i = 0; i < 3; i++) {
      const result = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: `sequence ${i}` });
      assert.equal(result.status, 'accepted');
    }
    assert.deepEqual(
      rig.notifications.map((frame) => frame.delivery_seq),
      ['1', '2', '3'],
      'A generation numbers its dispatches from one without gaps'
    );
    assert.deepEqual([...new Set(rig.notifications.map((frame) => frame.target_generation))], [1]);
    for (const frame of rig.notifications) {
      assert.match(frame.delivery_seq, /^[1-9]\d*$/, 'A delivery sequence is a canonical decimal string');
      assert.ok(BigInt(frame.delivery_seq) <= MAX_DELIVERY_SEQ, 'A delivery sequence stays inside uint64');
    }

    rotated = await rotateTarget(rig, rig.connB);
    const afterRotation = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'after rotation' });
    assert.equal(afterRotation.status, 'accepted');
    assert.equal(rig.notifications.at(-1)!.delivery_seq, '1', 'The new generation restarts its own sequence');
    assert.equal(rig.notifications.at(-1)!.target_generation, 2);

    const second = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'second of the generation' });
    assert.equal(second.status, 'accepted');
    assert.equal(rig.notifications.at(-1)!.delivery_seq, '2');
  } finally {
    rotated?.dispose();
    await stopRig(rig);
  }
});

test('An exhausted uint64 delivery sequence stops new dispatch instead of wrapping', async () => {
  const rig = await startRig({ initialDeliverySeq: MAX_DELIVERY_SEQ - 1n });
  let rotated: RootConnection | undefined;
  try {
    const last = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'final sequence' });
    assert.equal(last.status, 'accepted');
    assert.equal(rig.notifications.at(-1)!.delivery_seq, String(MAX_DELIVERY_SEQ));

    await assert.rejects(
      rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'must not wrap' }),
      (err: any) => err.code === ArloErrorCode.SEQUENCE_EXHAUSTED
    );
    assert.equal(rig.notifications.length, 1, 'No dispatch may follow an exhausted sequence');

    // The exhausted generation leaves discovery rather than promising delivery.
    assert.deepEqual(JSON.parse((await rig.connA.listSessions())[0].text), []);
    await assert.rejects(
      rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'still exhausted' }),
      (err: any) => err.code === ArloErrorCode.TARGET_UNAVAILABLE
    );

    // A new generation makes the target dispatchable again.
    rotated = await rotateTarget(rig, rig.connB);
    const recovered = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'new generation' });
    assert.equal(recovered.status, 'accepted');
    assert.equal(rig.notifications.at(-1)!.target_generation, 2);
    assert.equal(rig.notifications.at(-1)!.delivery_seq, String(MAX_DELIVERY_SEQ));
  } finally {
    rotated?.dispose();
    await stopRig(rig);
  }
});

test('A repeated tool request during retention returns the original receipt without re-dispatching', async () => {
  const rig = await startRig();
  try {
    const first = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'retained text' });
    assert.equal(first.status, 'accepted');
    assert.equal(rig.notifications.length, 1);

    // The target's own receipt already established the native association, so
    // a later receipt that switched native identity would be refused.
    assert.equal(rig.notifications[0].delivery_seq, '1');
    const repeat = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'retained text' }, first.message_id);
    assert.deepEqual(repeat, first, 'A repeated request returns the original receipt');
    assert.equal(rig.notifications.length, 1, 'A retained message ID is never dispatched twice');
    assert.equal(rig.notifications[0].delivery_seq, '1');
  } finally {
    await stopRig(rig);
  }
});

test('Reusing a retained message ID with different content, owner, or target reports MESSAGE_ID_CONFLICT', async () => {
  const rig = await startRig();
  try {
    const original = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'original payload' });
    assert.equal(original.status, 'accepted');

    const conflicts: Array<[string, () => Promise<unknown>]> = [
      ['content', () => rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'different payload' }, original.message_id)],
      ['target', () => rig.connA.sendMessage({ to: rig.rootC.endpoint_id, text: 'original payload' }, original.message_id)],
      ['owner', () => rig.connC.sendMessage({ to: rig.rootB.endpoint_id, text: 'original payload' }, original.message_id)],
    ];
    for (const [axis, attempt] of conflicts) {
      await assert.rejects(attempt(), (err: any) => err.code === ArloErrorCode.MESSAGE_ID_CONFLICT, `${axis} mismatch`);
    }

    assert.equal(rig.notifications.length, 1, 'A conflicting reuse never dispatches');
    const retained = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'original payload' }, original.message_id);
    assert.deepEqual(retained, original, 'The original receipt survives conflicting reuse');
  } finally {
    await stopRig(rig);
  }
});

test('A receipt settles the outcome while only credit release frees the pending budget', async () => {
  const rig = await startRig({}, { autoReceipt: false, authorizeSenderBeforeConnection: true });
  try {
    const inFlight = rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'accounted message' });
    const frame = await waitForNotification(rig);

    // Before any receipt the daemon ledger holds the pending input.
    await assert.rejects(
      rig.control.confirmRootReady(rig.rootB.root_token, {
        endpoint_id: rig.rootB.endpoint_id,
        reconciled_pending_message_ids: [],
      }),
      (err: any) => err.code === ArloErrorCode.ACCOUNTING_UNAVAILABLE
    );

    const receipt = {
      daemon_id: rig.daemon.daemonId,
      endpoint_id: rig.rootB.endpoint_id,
      message_id: frame.message_id,
      delivery_id: frame.delivery_id,
      generation: frame.target_generation,
      status: 'enqueued' as const,
      native_message_id: 'native-accounted',
    };
    await rig.control.submitReceipt(rig.rootB.root_token, receipt);
    await rig.control.submitReceipt(rig.rootB.root_token, receipt);

    const sent = await inFlight;
    assert.equal(sent.status, 'accepted');

    // Acceptance is not consumption: the credit is still held.
    await assert.rejects(
      rig.control.confirmRootReady(rig.rootB.root_token, {
        endpoint_id: rig.rootB.endpoint_id,
        reconciled_pending_message_ids: [],
      }),
      (err: any) => err.code === ArloErrorCode.ACCOUNTING_UNAVAILABLE
    );

    const credit = {
      endpoint_id: rig.rootB.endpoint_id,
      message_id: sent.message_id,
      native_message_id: 'native-accounted',
      event: 'claimed' as const,
    };
    await rig.control.releaseCredit(rig.rootB.root_token, credit);
    await rig.control.releaseCredit(rig.rootB.root_token, credit);

    // The retried release is idempotent: exactly one credit was returned.
    await rig.control.confirmRootReady(rig.rootB.root_token, {
      endpoint_id: rig.rootB.endpoint_id,
      reconciled_pending_message_ids: [],
    });
    assert.equal(rig.notifications.length, 1, 'Neither a receipt retry nor a credit retry re-dispatches');
  } finally {
    await stopRig(rig);
  }
});

test('A record holding pending credit is never evicted as ordinary cache', async () => {
  const rig = await startRig({ messageRecordTtlMs: 0 }, { autoReceipt: false, authorizeSenderBeforeConnection: true });
  try {
    const inFlight = rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'activity record' });
    const frame = await waitForNotification(rig);
    await rig.control.submitReceipt(rig.rootB.root_token, {
      daemon_id: rig.daemon.daemonId,
      endpoint_id: rig.rootB.endpoint_id,
      message_id: frame.message_id,
      delivery_id: frame.delivery_id,
      generation: frame.target_generation,
      status: 'enqueued',
      native_message_id: 'native-activity',
    });
    const sent = await inFlight;
    assert.equal(sent.status, 'accepted');

    // Accepted but still holding pending credit: an activity record, so a zero
    // retention window must not turn it into retired cache.
    const whileHeld = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'activity record' }, sent.message_id);
    assert.deepEqual(whileHeld, sent, 'A record holding pending credit survives ordinary eviction');
    assert.equal(rig.notifications.length, 1);

    // Releasing credit settles the record; the retained ledger then protects
    // the ID rather than dispatching it again.
    await rig.control.releaseCredit(rig.rootB.root_token, {
      endpoint_id: rig.rootB.endpoint_id,
      message_id: sent.message_id,
      native_message_id: 'native-activity',
      event: 'discarded',
    });
    await assert.rejects(
      rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'activity record' }, sent.message_id),
      (err: any) => err.code === ArloErrorCode.REPLAY_RESULT_UNAVAILABLE,
      'The settled result is gone and is not fabricated'
    );
    assert.equal(rig.notifications.length, 1, 'A settled ID is never dispatched twice');
  } finally {
    await stopRig(rig);
  }
});

test('A settled dispatch record stops serving its result once the retention window passes', async () => {
  let clock = Date.now();
  const rig = await startRig({ now: () => clock, messageRecordTtlMs: 24 * 60 * 60 * 1000 });
  try {
    const sent = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'bounded retention' });
    assert.equal(sent.status, 'accepted');
    await rig.control.releaseCredit(rig.token, {
      endpoint_id: rig.rootB.endpoint_id,
      message_id: sent.message_id,
      native_message_id: `native-${sent.message_id}`,
      event: 'claimed',
    });

    const insideWindow = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'bounded retention' }, sent.message_id);
    assert.deepEqual(insideWindow, sent, 'Inside the window a settled record still answers');
    assert.equal(rig.notifications.length, 1);

    // Only time passes: the 24 hour bound applies on use, not by a sweep.
    clock += 24 * 60 * 60 * 1000;
    await assert.rejects(
      rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'bounded retention' }, sent.message_id),
      (err: any) => err.code === ArloErrorCode.REPLAY_RESULT_UNAVAILABLE,
      'Past the window the original result is gone and is not fabricated'
    );
    assert.equal(rig.notifications.length, 1, 'An expired logical ID is never dispatched again');
  } finally {
    await stopRig(rig);
  }
});

test('An undecided result after a lost connection is retained instead of being evicted', async () => {
  const rig = await startRig({ messageRecordTtlMs: 0 }, { autoReceipt: false, authorizeSenderBeforeConnection: true });
  try {
    const inFlight = rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'lost after dispatch' });
    await waitForNotification(rig);

    rig.connB.dispose();
    const outcome = await inFlight;
    assert.equal(outcome.status, 'unknown');
    assert.equal(outcome.reason, ArloErrorCode.CONNECTION_LOST);

    // The undecided result is an activity record: it answers again instead of
    // degrading into a fresh attempt against a disconnected target.
    const repeat = await rig.connA.sendMessage({ to: rig.rootB.endpoint_id, text: 'lost after dispatch' }, outcome.message_id);
    assert.deepEqual(repeat, outcome, 'An undecided result is not ordinary cache');
  } finally {
    await stopRig(rig);
  }
});
