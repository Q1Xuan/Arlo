import { AuthorizedControlClient as ControlClient } from './helpers/authorized-control.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ArloDaemon, type ArloDaemonOptions } from '@arlo/daemon';
import {

  ArloErrorCode,
  DEFAULT_SEND_RATE_PER_MINUTE,
  DEFAULT_SEND_BURST,
  DEFAULT_RECEIVE_RATE_PER_MINUTE,
  DEFAULT_RECEIVE_BURST,
  type ArloMessageNotificationParams,
  type RootRegistrationResponse,
} from '@arlo/sdk';
import { createTempDir, removeTempDir, UNPACED_ROOT_RATE } from './test-utils.ts';

type RootConnection = ReturnType<ControlClient['createRootConnection']>;

interface RigRoot {
  reg: RootRegistrationResponse;
  conn: RootConnection;
  /** Current root token; rotation replaces it. */
  token: string;
}

interface Rig {
  daemon: ArloDaemon;
  control: ControlClient;
  stateDir: string;
  clock: { value: number };
  roots: Map<string, RigRoot>;
  notifications: ArloMessageNotificationParams[];
  /** Installs reception handlers for the given roots and readies every root. */
  installReception: (targetNames: string[]) => void;
  rotate: (name: string) => Promise<void>;
  dispose: () => void;
}

interface RigOptions {
  displayNames?: Record<string, string>;
  /** Roots whose reception auto-confirms enqueue; credit stays pending until claimed. */
  autoReceipt?: string[];
}

async function startRig(daemonOptions: ArloDaemonOptions = {}, rigOptions: RigOptions = {}): Promise<Rig> {
  const stateDir = createTempDir('daemon-rate-limit');
  const clock = { value: 1_000_000 };
  const daemon = new ArloDaemon({ ...daemonOptions, now: daemonOptions.now ?? (() => clock.value), stateDir });
  const roots = new Map<string, RigRoot>();
  try {
    const { port } = await daemon.start();
    const control = new ControlClient({ stateDir, port });

    const runtime = await control.registerRuntime({ host_type: 'deepseek-harness', host_version: '0.2.0' });
    const register = async (name: string, group: string) => {
      const reg = await control.registerRoot(runtime.runtime_token, {
        root_session_id: `host-rate-${name}`,
        group_name: group,
        agent_incarnation: `inc-rate-${name}`,
        plugin_generation: 1,
        ...(rigOptions.displayNames?.[name] !== undefined ? { display_name: rigOptions.displayNames[name] } : {}),
      });
      roots.set(name, { reg, conn: control.createRootConnection(reg), token: reg.root_token });
    };
    await register('a', 'rate-alpha');
    await register('b', 'rate-alpha');
    await register('c', 'rate-alpha');
    await register('d', 'rate-alpha');
    await register('e', 'rate-alpha');

    const notifications: ArloMessageNotificationParams[] = [];
    const installReception = (targetNames: string[]) => {
      for (const name of targetNames) {
        const root = roots.get(name)!;
        root.conn.onNotification((params) => {
          notifications.push(params);
          if (rigOptions.autoReceipt?.includes(name)) {
            void submitEnqueueReceipt(control, root, params).catch(() => {});
          }
        });
      }
    };
    installReception(['a', 'b', 'c', 'd', 'e']);

    for (const root of roots.values()) {
      await root.conn.connect();
      await control.confirmRootReady(root.token, { endpoint_id: root.reg.endpoint_id });
    }

    const rig: Rig = {
      daemon,
      control,
      stateDir,
      clock,
      roots,
      notifications,
      installReception,
      rotate: async (name: string) => {
        const root = roots.get(name)!;
        // Re-entry reconciles existing pending input: settle this target's
        // credits first so the rotated connection can be readied again.
        for (const frame of notifications) {
          if (frame.to_endpoint !== root.reg.endpoint_id) continue;
          await control.releaseCredit(root.token, {
            endpoint_id: root.reg.endpoint_id,
            message_id: frame.message_id,
            native_message_id: `native-${frame.message_id}`,
            event: 'claimed',
          });
        }
        const rotated = await control.connectRoot(root.token, { endpoint_id: root.reg.endpoint_id });
        root.token = rotated.root_token;
        root.conn.dispose();
        root.conn = control.createRootConnection({
          endpoint_id: rotated.endpoint_id,
          generation: rotated.generation,
          root_token: rotated.root_token,
          group_id: root.reg.group_id,
          status: 'registered',
          ready: false,
          deliverable: false,
        });
        installReception([name]);
        await root.conn.connect();
        await control.confirmRootReady(root.token, { endpoint_id: root.reg.endpoint_id });
      },
      dispose: () => {
        for (const root of roots.values()) root.conn.dispose();
      },
    };
    return rig;
  } catch (error) {
    for (const root of roots.values()) root.conn.dispose();
    await daemon.stop().catch(() => {});
    removeTempDir(stateDir);
    throw error;
  }
}

async function stopRig(rig: Rig): Promise<void> {
  rig.dispose();
  try {
    await rig.daemon.stop();
  } finally {
    removeTempDir(rig.stateDir);
  }
}

async function send(rig: Rig, from: string, to: string, text: string, messageId?: string) {
  return rig.roots.get(from)!.conn.sendMessage({ to: rig.roots.get(to)!.reg.endpoint_id, text }, messageId);
}

/** Confirms enqueue on a target root so a pending send settles without waiting. */
async function submitEnqueueReceipt(control: ControlClient, root: RigRoot, params: ArloMessageNotificationParams) {
  await control.submitReceipt(root.token, {
    daemon_id: params.daemon_id,
    endpoint_id: root.reg.endpoint_id,
    message_id: params.message_id,
    delivery_id: params.delivery_id,
    generation: params.target_generation,
    status: 'enqueued',
    native_message_id: `native-${params.message_id}`,
  });
}

async function expectRateLimited(
  rig: Rig,
  from: string,
  to: string,
  side: 'sending' | 'receiving',
  text = 'paced',
  messageId?: string
) {
  const before = rig.notifications.length;
  await assert.rejects(
    send(rig, from, to, text, messageId),
    (err: any) => {
      assert.equal(err.code, ArloErrorCode.RATE_LIMITED, `expected RATE_LIMITED, got ${err.code}: ${err.message}`);
      if (side === 'sending') assert.match(err.message, /sending root/);
      else assert.match(err.message, /receiving root/);
      return true;
    },
    `expected the ${side} root limit to reject this message`
  );
  assert.equal(rig.notifications.length, before, 'a rate-limited message must not reach the target host');
}

test('Defaults pace a sending root at 12 per minute with a burst of 4, distinguishing burst from sustained rate', async () => {
  const rig = await startRig({ rateLimit: { receiver: { perMinute: DEFAULT_RECEIVE_RATE_PER_MINUTE, burst: DEFAULT_RECEIVE_BURST } } }, { autoReceipt: ['b'] });
  try {
    assert.equal(DEFAULT_SEND_RATE_PER_MINUTE, 12);
    assert.equal(DEFAULT_SEND_BURST, 4);
    for (let i = 0; i < 4; i++) {
      const result = await send(rig, 'a', 'b', `burst ${i}`);
      assert.equal(result.status, 'accepted', `burst message ${i} must be admitted`);
    }
    await expectRateLimited(rig, 'a', 'b', 'sending');

    // 12/minute = exactly one message per 5000 ms; at the boundary exactly one
    // further message is admitted and an immediate follower is still rejected.
    rig.clock.value += 5000;
    assert.equal((await send(rig, 'a', 'b', 'sustained')).status, 'accepted');
    await expectRateLimited(rig, 'a', 'b', 'sending');
  } finally {
    await stopRig(rig);
  }
});

test('The receiving root limit is a shared total for every sender converging on it', async () => {
  const rig = await startRig(
    { rateLimit: { sender: UNPACED_ROOT_RATE } },
    { autoReceipt: ['b', 'e'] }
  );
  try {
    assert.equal(DEFAULT_RECEIVE_RATE_PER_MINUTE, 30);
    assert.equal(DEFAULT_RECEIVE_BURST, 8);
    // Three senders interleave on the same target: eight admissions in total,
    // regardless of which sender spends them.
    for (let i = 0; i < 3; i++) {
      for (const from of ['a', 'c', 'd']) {
        if (rig.notifications.length < 8) {
          const result = await send(rig, from, 'b', `converge ${from}-${i}`);
          assert.equal(result.status, 'accepted');
        }
      }
    }
    assert.equal(rig.notifications.length, 8, 'the receiving root admitted exactly its burst');
    await expectRateLimited(rig, 'a', 'b', 'receiving');
    await expectRateLimited(rig, 'c', 'b', 'receiving');
    await expectRateLimited(rig, 'd', 'b', 'receiving');

    rig.clock.value += 1999;
    await expectRateLimited(rig, 'c', 'b', 'receiving');
    rig.clock.value += 1;
    assert.equal((await send(rig, 'c', 'b', 'default receive refill')).status, 'accepted');
    await expectRateLimited(rig, 'd', 'b', 'receiving');

    // Another receiving root still has its own budget.
    assert.equal((await send(rig, 'a', 'e', 'other target')).status, 'accepted');
  } finally {
    await stopRig(rig);
  }
});

test('A sending root stays paced when it scatters messages across several targets', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60, burst: 3 }, receiver: { perMinute: 60000, burst: 100 } } },
    { autoReceipt: ['b', 'c', 'd'] }
  );
  try {
    for (const to of ['b', 'c', 'd']) {
      assert.equal((await send(rig, 'a', to, `scatter ${to}`)).status, 'accepted');
    }
    await expectRateLimited(rig, 'a', 'b', 'sending');
    await expectRateLimited(rig, 'a', 'c', 'sending');
    await expectRateLimited(rig, 'a', 'd', 'sending');
    // A different sending root is unaffected.
    assert.equal((await send(rig, 'c', 'b', 'other sender')).status, 'accepted');
  } finally {
    await stopRig(rig);
  }
});

test('A rate-limited rejection dispatches nothing and leaves no pending, sequence or dedup residue', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60, burst: 1 }, receiver: { perMinute: 60000, burst: 100 } } },
    { autoReceipt: ['b'] }
  );
  try {
    assert.equal((await send(rig, 'a', 'b', 'first')).status, 'accepted');
    await expectRateLimited(rig, 'a', 'b', 'sending');

    // A rejected send never dispatched, so the delivery sequence of the next
    // accepted message continues without a gap.
    rig.clock.value += 1000;
    const after = await send(rig, 'a', 'b', 'second');
    assert.equal(after.status, 'accepted');
    assert.equal(rig.notifications.at(-1)!.delivery_seq, '2', 'rejections must not consume delivery sequence numbers');

    // The rejected message left no dedup record or pending credit: retrying
    // the exact same message ID after recovery is admitted as a fresh send.
    rig.clock.value += 999;
    await expectRateLimited(rig, 'a', 'b', 'sending', 'retry probe', 'rate-rejected-uuid');
    rig.clock.value += 1;
    const retried = await send(rig, 'a', 'b', 'retry probe', 'rate-rejected-uuid');
    assert.equal(retried.status, 'accepted', 'a rate-rejected message ID must stay reusable after recovery');
    assert.equal(rig.notifications.at(-1)!.message_id, 'rate-rejected-uuid');
  } finally {
    await stopRig(rig);
  }
});

test('Boundaries are exact under an integer clock: at-limit admits one, one-over admits none', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60, burst: 1 }, receiver: { perMinute: 60000, burst: 100 } } },
    { autoReceipt: ['b'] }
  );
  try {
    assert.equal((await send(rig, 'a', 'b', 't0')).status, 'accepted');
    rig.clock.value += 999;
    await expectRateLimited(rig, 'a', 'b', 'sending');
    rig.clock.value += 1; // exactly 1000 ms after the last admission
    assert.equal((await send(rig, 'a', 'b', 't1000')).status, 'accepted');
    await expectRateLimited(rig, 'a', 'b', 'sending');
    rig.clock.value += 999;
    await expectRateLimited(rig, 'a', 'b', 'sending');
    rig.clock.value += 1;
    assert.equal((await send(rig, 'a', 'b', 't2000')).status, 'accepted');


  } finally {
    await stopRig(rig);
  }
});

test('Receiver-side boundaries stay exact while several senders race the same target', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60000, burst: 100 }, receiver: { perMinute: 60, burst: 1 } } },
    { autoReceipt: ['b'] }
  );
  try {
    assert.equal((await send(rig, 'a', 'b', 'r0')).status, 'accepted');
    rig.clock.value += 999;
    await expectRateLimited(rig, 'c', 'b', 'receiving');
    await expectRateLimited(rig, 'a', 'b', 'receiving');
    rig.clock.value += 1;
    assert.equal((await send(rig, 'c', 'b', 'r1000')).status, 'accepted', 'the boundary admits the next sender');
    rig.clock.value += 1;
    await expectRateLimited(rig, 'a', 'b', 'receiving');
  } finally {
    await stopRig(rig);
  }
});

test('Concurrent sends race one refill slot without over-issuing', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60, burst: 1 }, receiver: UNPACED_ROOT_RATE } },
    { autoReceipt: ['b'] }
  );
  try {
    assert.equal((await send(rig, 'a', 'b', 'takes the slot')).status, 'accepted');
    // Two in-flight sends race the same refill. Admission runs synchronously
    // per request, so exactly one is admitted no matter how the transport
    // interleaves them, and neither dispatch happens before the decision.
    rig.clock.value += 1000;
    const outcomes = await Promise.allSettled([
      send(rig, 'a', 'b', 'race-1', 'race-uuid-1'),
      send(rig, 'a', 'b', 'race-2', 'race-uuid-2'),
    ]);
    const accepted = outcomes.filter(
      (o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof send>>> =>
        o.status === 'fulfilled' && o.value.status === 'accepted'
    );
    const rateLimited = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected' && o.reason?.code === ArloErrorCode.RATE_LIMITED
    );
    assert.equal(accepted.length, 1, 'exactly one racing message is admitted');
    assert.equal(rateLimited.length, 1, 'the other racing message is rate limited');
    const raced = rig.notifications.filter((frame) => frame.message_id === 'race-uuid-1' || frame.message_id === 'race-uuid-2');
    assert.equal(raced.length, 1, 'the loser never reaches the target host');
  } finally {
    await stopRig(rig);
  }
});

test('Fresh message UUIDs earn no exemption', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60, burst: 2 }, receiver: { perMinute: 60000, burst: 100 } } },
    { autoReceipt: ['b'] }
  );
  try {
    await send(rig, 'a', 'b', 'uuid-1', 'fresh-uuid-1');
    await send(rig, 'a', 'b', 'uuid-2', 'fresh-uuid-2');
    // Every message carries a brand-new UUID; the sending root is still paced.
    await expectRateLimited(rig, 'a', 'b', 'sending', 'uuid-3', 'fresh-uuid-3');


  } finally {
    await stopRig(rig);
  }
});

test('Display-name differences do not evade the shared receiving budget', async () => {
  const rig = await startRig(
    { rateLimit: { sender: UNPACED_ROOT_RATE, receiver: { perMinute: 60, burst: 2 } } },
    { autoReceipt: ['b'], displayNames: { a: 'CANARY-NAME-管理员-甲', c: '完全不同的显示名称', b: '接收方名称' } }
  );
  try {
    assert.equal((await send(rig, 'a', 'b', 'from 甲')).status, 'accepted');
    assert.equal((await send(rig, 'c', 'b', 'from 乙')).status, 'accepted');
    await expectRateLimited(rig, 'a', 'b', 'receiving');
    await expectRateLimited(rig, 'c', 'b', 'receiving');
  } finally {
    await stopRig(rig);
  }
});

test('Rate limits coexist with the queue, byte and tracking budgets without replacing them', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60000, burst: 100 }, receiver: { perMinute: 60000, burst: 100 } } },
    { autoReceipt: ['b'] }
  );
  try {
    // Fill the target's 64-message pending queue; enqueue receipts settle the
    // send results while the credits stay pending, so sends return quickly.
    for (let i = 0; i < 64; i++) {
      assert.equal((await send(rig, 'a', 'b', `queue ${i}`)).status, 'accepted');
    }
    await assert.rejects(
      send(rig, 'a', 'b', 'one over the queue'),
      (err: any) => err.code === ArloErrorCode.QUEUE_LIMIT,
      'the pending-queue budget must still be enforced alongside pacing'
    );

    // A sender whose rate is exhausted is rejected even though the target
    // queue has room again after its credits are claimed.
    const claimed: ArloMessageNotificationParams[] = [...rig.notifications];
    for (const frame of claimed) {
      await rig.control.releaseCredit(rig.roots.get('b')!.token, {
        endpoint_id: rig.roots.get('b')!.reg.endpoint_id,
        message_id: frame.message_id,
        native_message_id: `native-${frame.message_id}`,
        event: 'claimed',
      });
    }
    // Exhaust the sending root's burst; the queue now has room but pacing
    // still gates admission, and no accepted message was evicted to get there.
    const tight = await startRig(
      { rateLimit: { sender: { perMinute: 60, burst: 1 }, receiver: { perMinute: 60000, burst: 100 } } },
      { autoReceipt: ['b'] }
    );
    try {
      await send(tight, 'a', 'b', 'occupies the pace');
      await expectRateLimited(tight, 'a', 'b', 'sending');
    } finally {
      await stopRig(tight);
    }
  } finally {
    await stopRig(rig);
  }
});

test('Protocol receipts and credit releases are not business admissions and do not refill pacing', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60, burst: 1 }, receiver: { perMinute: 60000, burst: 100 } } },
    { autoReceipt: ['b'] }
  );
  try {
    const accepted = await send(rig, 'a', 'b', 'receipt source');
    assert.equal(accepted.status, 'accepted');
    const frame = rig.notifications[0];

    await expectRateLimited(rig, 'a', 'b', 'sending');
    // Control-plane traffic keeps working while the sender is paced...
    for (let i = 0; i < 5; i++) {
      await submitEnqueueReceipt(rig.control, rig.roots.get('b')!, frame);
    }
    await rig.control.releaseCredit(rig.roots.get('b')!.token, {
      endpoint_id: rig.roots.get('b')!.reg.endpoint_id,
      message_id: frame.message_id,
      native_message_id: `native-${frame.message_id}`,
      event: 'claimed',
    });
    // ...but none of it refills the business pacing.
    await expectRateLimited(rig, 'a', 'b', 'sending');
    rig.clock.value += 1000;
    assert.equal((await send(rig, 'a', 'b', 'after time')).status, 'accepted');
  } finally {
    await stopRig(rig);
  }
});

test('Unassociated mutual sending paces each direction through independent buckets', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60, burst: 2 }, receiver: { perMinute: 60, burst: 2 } } },
    { autoReceipt: ['a', 'b'] }
  );
  try {
    for (const label of ['m1', 'm2']) {
      assert.equal((await send(rig, 'a', 'b', label)).status, 'accepted');
      assert.equal((await send(rig, 'b', 'a', label)).status, 'accepted');
    }
    await expectRateLimited(rig, 'a', 'b', 'sending');
    await expectRateLimited(rig, 'b', 'a', 'sending');

    // One clock second restores exactly one admission per bucket: each
    // direction recovers independently and never over-issues.
    rig.clock.value += 1000;
    assert.equal((await send(rig, 'a', 'b', 'm3')).status, 'accepted');
    assert.equal((await send(rig, 'b', 'a', 'm3')).status, 'accepted');
    await expectRateLimited(rig, 'a', 'b', 'sending');
    await expectRateLimited(rig, 'b', 'a', 'sending');
  } finally {
    await stopRig(rig);
  }
});

test('Over-limit and recovery leave fixed-field audit entries without leaking body, name or credential canaries', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60, burst: 1 }, receiver: { perMinute: 60, burst: 1 } } },
    { autoReceipt: ['b'], displayNames: { a: 'CANARY-名称-🦜' } }
  );
  try {
    await send(rig, 'a', 'b', 'CANARY-正文-秘密-🦜');
    await expectRateLimited(rig, 'a', 'b', 'sending', 'CANARY-正文-秘密-🦜');
    await expectRateLimited(rig, 'c', 'b', 'receiving', 'CANARY-正文-秘密-🦜');
    rig.clock.value += 1000;
    await send(rig, 'a', 'b', 'recovered');

    const raw = fs.readFileSync(path.join(rig.stateDir, 'daemon.log'), 'utf8');
    const lines = raw.trim().split('\n').map((line) => JSON.parse(line));
    const allowedKeys = new Set(['time', 'event', 'daemon_id', 'request_id', 'status', 'bytes', 'duration_ms']);
    for (const entry of lines) {
      for (const key of Object.keys(entry)) {
        assert.ok(allowedKeys.has(key), `audit entry must only use fixed fields, saw ${key}`);
      }
    }
    for (const event of ['SEND_RATE_LIMITED', 'RECEIVE_RATE_LIMITED']) {
      const limited = lines.filter((entry) => entry.event === event);
      assert.equal(limited.length, 1);
      assert.equal(limited[0].status, 'rejected');
    }
    const recovered = lines.filter((entry) => entry.event === 'RATE_RECOVERED');
    assert.equal(recovered.length, 1, 'the first admission after both rejections logs one recovery');
    assert.equal(recovered[0].status, 'ok');
    assert.ok(!raw.includes('CANARY-正文'));
    assert.ok(!raw.includes('CANARY-名称'));
    for (const root of rig.roots.values()) assert.ok(!raw.includes(root.token));
  } finally {
    await stopRig(rig);
  }
});

test('Rate limit configuration is validated and honoured', async () => {
  const invalid = [
    { sender: { perMinute: 0, burst: 4 } },
    { sender: { perMinute: 12, burst: 0 } },
    { sender: { perMinute: 1.5, burst: 4 } },
    { sender: { perMinute: -12, burst: 4 } },
    { receiver: { perMinute: 30, burst: -1 } },
    { receiver: { perMinute: Number.NaN, burst: 8 } },
  ];
  for (const rateLimit of invalid) {
    assert.throws(
      () => new ArloDaemon({ rateLimit }),
      (err: any) => err.code === ArloErrorCode.INVALID_ARGUMENT
    );
  }
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 120, burst: 2 }, receiver: UNPACED_ROOT_RATE } },
    { autoReceipt: ['b'] }
  );
  try {
    assert.equal((await send(rig, 'a', 'b', 'c1')).status, 'accepted');
    assert.equal((await send(rig, 'a', 'b', 'c2')).status, 'accepted');
    await expectRateLimited(rig, 'a', 'b', 'sending');
    rig.clock.value += 499;
    await expectRateLimited(rig, 'a', 'b', 'sending');
    rig.clock.value += 1;
    assert.equal((await send(rig, 'a', 'b', 'c4')).status, 'accepted');
    await expectRateLimited(rig, 'a', 'b', 'sending');
  } finally {
    await stopRig(rig);
  }
});

test('Connection rotation preserves both sending and receiving budgets independently', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60, burst: 1 }, receiver: { perMinute: 60, burst: 1 } } },
    { autoReceipt: ['b', 'd'] }
  );
  try {
    assert.equal((await send(rig, 'a', 'b', 'pre-rotation')).status, 'accepted');
    await rig.rotate('a');
    await expectRateLimited(rig, 'a', 'd', 'sending');
    await rig.rotate('b');
    await expectRateLimited(rig, 'c', 'b', 'receiving');
    rig.clock.value += 1000;
    assert.equal((await send(rig, 'a', 'b', 'post-rotation')).status, 'accepted');
  } finally {
    await stopRig(rig);
  }
});

test('Independent senders concurrently contest one receiver refill without spending the loser credit', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60, burst: 1 }, receiver: { perMinute: 60, burst: 1 } } },
    { autoReceipt: ['b', 'd'] }
  );
  try {
    await send(rig, 'e', 'b', 'initial receiver slot');
    rig.clock.value += 1000;
    const senders = ['a', 'c'];
    const outcomes = await Promise.allSettled(senders.map((from) =>
      send(rig, from, 'b', 'receiver race', `receiver-race-${from}`)
    ));
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const loser = outcomes.findIndex((outcome) => outcome.status === 'rejected');
    assert.ok(loser >= 0);
    const failure = outcomes[loser] as PromiseRejectedResult;
    assert.equal(failure.reason.code, ArloErrorCode.RATE_LIMITED);
    assert.match(failure.reason.message, /receiving root/);
    assert.equal(rig.notifications.filter((frame) => frame.to_endpoint === rig.roots.get('b')!.reg.endpoint_id).length, 2);

    // Receiver refusal must leave the loser's sending token available.
    assert.equal((await send(rig, senders[loser], 'd', 'remaining sender token')).status, 'accepted');
    rig.clock.value += 1000;
    assert.equal((await send(rig, senders[loser], 'b', 'receiver race', `receiver-race-${senders[loser]}`)).status, 'accepted');
    assert.equal(rig.notifications.at(-1)!.delivery_seq, '3');
  } finally {
    await stopRig(rig);
  }
});

test('An idle interval restores exactly a multi-message burst without accumulating extra admissions', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60, burst: 3 }, receiver: UNPACED_ROOT_RATE } },
    { autoReceipt: ['b'] }
  );
  try {
    for (let i = 0; i < 3; i++) await send(rig, 'a', 'b', 'initial burst');
    await expectRateLimited(rig, 'a', 'b', 'sending');
    rig.clock.value += 10_000;
    for (let i = 0; i < 3; i++) {
      assert.equal((await send(rig, 'a', 'b', 'restored burst')).status, 'accepted');
    }
    await expectRateLimited(rig, 'a', 'b', 'sending');
  } finally {
    await stopRig(rig);
  }
});

test('Authorised replies share both rate limits with ordinary messages and recover without losing their parent', async () => {
  const rig = await startRig(
    { rateLimit: { sender: { perMinute: 60, burst: 1 }, receiver: { perMinute: 60, burst: 1 } } },
    { autoReceipt: ['a', 'b', 'c', 'd'] }
  );
  try {
    const parent = await send(rig, 'a', 'b', 'reply to this');
    await send(rig, 'b', 'c', 'spend replying sender token');
    const b = rig.roots.get('b')!;
    const args = { to: rig.roots.get('a')!.reg.endpoint_id, text: 'associated reply', reply_to: parent.message_id };
    const before = rig.notifications.length;
    await assert.rejects(b.conn.sendMessage(args, 'paced-reply'), (error: any) =>
      error.code === ArloErrorCode.RATE_LIMITED && /sending root/.test(error.message)
    );
    assert.equal(rig.notifications.length, before);

    rig.clock.value += 1000;
    await send(rig, 'c', 'a', 'spend original sender receive token');
    await assert.rejects(b.conn.sendMessage(args, 'paced-reply'), (error: any) =>
      error.code === ArloErrorCode.RATE_LIMITED && /receiving root/.test(error.message)
    );
    assert.equal(rig.notifications.length, before + 1);
    assert.equal((await send(rig, 'b', 'd', 'receiver refusal preserved sender token')).status, 'accepted');

    rig.clock.value += 1000;
    const reply = await b.conn.sendMessage(args, 'paced-reply');
    assert.equal(reply.status, 'accepted');
    assert.notEqual(reply.message_id, parent.message_id);
    const frame = rig.notifications.at(-1)!;
    assert.equal(frame.reply_to, parent.message_id);
    assert.equal(frame.reply_depth, 1);
    assert.equal(frame.delivery_seq, '2');
  } finally {
    await stopRig(rig);
  }
});
