import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArloDaemon, type ArloDaemonOptions } from '@arlo/daemon';
import { ControlClient, ArloErrorCode, type ArloMessageNotificationParams, type RootRegistrationResponse } from '@arlo/sdk';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from '../test-utils.ts';

type RootConnection = ReturnType<ControlClient['createRootConnection']>;
interface Root {
  binding: RootRegistrationResponse;
  connection: RootConnection;
  file: string;
  sessionId: string;
  continuityToken: string;
}

export async function autonomousSendingRig(options: ArloDaemonOptions = {}, rootNames: readonly string[] = ['a', 'b', 'c', 'foreign']) {
  const stateDir = createTempDir('autonomous-sending');
  let daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT, leaseNow: () => 0, ...options });
  let control: ControlClient;
  const roots = new Map<string, Root>();
  const notifications: ArloMessageNotificationParams[] = [];
  const settled = new Set<Promise<unknown>>();
  let receipt: 'enqueued' | 'not_enqueued' | 'drop' | 'disconnect' = 'enqueued';
  let holdCredits = false;
  const reception = (root: Root) => root.connection.onNotification(frame => {
    notifications.push(frame);
    if (receipt === 'disconnect') { root.connection.dispose(); return; }
    if (receipt === 'drop') return;
    const status = receipt;
    const operation = (async () => {
      const nativeId = `native-${frame.message_id}`;
      await control.submitReceipt(root.binding.root_token, {
        daemon_id: frame.daemon_id, endpoint_id: root.binding.endpoint_id,
        message_id: frame.message_id, delivery_id: frame.delivery_id,
        generation: frame.target_generation, status,
        ...(status === 'enqueued' ? { native_message_id: nativeId } : { reason: ArloErrorCode.QUEUE_LIMIT }),
      });
      if (status === 'enqueued' && !holdCredits) await control.releaseCredit(root.binding.root_token, {
        endpoint_id: root.binding.endpoint_id, message_id: frame.message_id,
        native_message_id: nativeId, event: 'claimed',
      });
    })();
    settled.add(operation);
    void operation.then(() => settled.delete(operation), () => settled.delete(operation));
  });
  const start = async () => {
    await daemon.start();
    control = new ControlClient({ stateDir });
    const runtime = await control.registerRuntime({ host_kind: 'pi' });
    for (const name of rootNames) {
      const file = path.join(stateDir, `${name}.jsonl`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, `public-owned-${name}`);
      const continuityToken = crypto.randomUUID();
      const sessionId = `allowance-${name}`;
      const binding = await control.registerRoot(runtime.runtime_token, {
        root_session_id: sessionId, group_name: name === 'foreign' ? 'other-group' : 'allowance-group',
        agent_incarnation: crypto.randomUUID(), plugin_generation: 1,
        continuity_token: continuityToken,
      });
      const root = { binding, connection: control.createRootConnection(binding, { heartbeat: false }), file, sessionId, continuityToken };
      roots.set(name, root);
      reception(root);
      await root.connection.connect();
      await control.confirmRootReady(binding.root_token, { endpoint_id: binding.endpoint_id });
    }
  };
  const request = (name: string, evidenceName = name) => {
    const root = roots.get(name)!;
    return { endpoint_id: root.binding.endpoint_id, generation: root.binding.generation,
      evidence: { kind: 'session-file' as const, session_file: roots.get(evidenceName)!.file } };
  };
  const status = (name = 'a', evidenceName = name) => control.getRootSendingStatus(roots.get(name)!.binding.root_token, request(name, evidenceName));
  const reloadRequest = async (name = 'a') => {
    const current = await status(name);
    return {
      ...request(name), daemon_id: current.daemon_id, rules_revision: current.rules_revision,
    };
  };
  const reloadWith = (name: string, value: Awaited<ReturnType<typeof reloadRequest>>) =>
    control.reloadSendingRules(roots.get(name)!.binding.root_token, value);
  const reload = async (name = 'a') => reloadWith(name, await reloadRequest(name));
  const continueRequest = async (name = 'a') => {
    const current = await status(name);
    return { ...request(name), daemon_id: current.daemon_id, request_id: crypto.randomUUID(), sequence: current.control_sequence + 1 };
  };
  const continueWith = (name: string, value: Awaited<ReturnType<typeof continueRequest>>) =>
    control.continueCollaboration(roots.get(name)!.binding.root_token, value);
  const grant = async (name = 'a') => continueWith(name, await continueRequest(name));
  const send = async (to = 'b', text = 'new business input', id?: string, from = 'a', replyTo?: string) => {
    const result = await roots.get(from)!.connection.sendMessage({ to: roots.get(to)!.binding.endpoint_id, text,
      ...(replyTo ? { reply_to: replyTo } : {}) }, id);
    await Promise.all([...settled]);
    return result;
  };
  const stop = async () => {
    for (const root of roots.values()) root.connection.dispose();
    await Promise.allSettled([...settled]);
    await daemon.stop();
  };
  try { await start(); } catch (error) { await stop(); removeTempDir(stateDir); throw error; }
  return {
    stateDir, roots, notifications, status, reloadRequest, reloadWith, reload, request, continueRequest, continueWith, grant, send,
    control: () => control,
    daemon: () => daemon,
    receipt: (value: typeof receipt) => { receipt = value; },
    holdCredits: () => { holdCredits = true; },
    async rotate(name = 'a') {
      const root = roots.get(name)!;
      const next = await control.connectRoot(root.binding.root_token, { endpoint_id: root.binding.endpoint_id, continuity_token: root.continuityToken });
      root.connection.dispose();
      root.binding = { ...root.binding, ...next };
      root.connection = control.createRootConnection(root.binding, { heartbeat: false });
      reception(root);
      await root.connection.connect();
      await control.confirmRootReady(root.binding.root_token, { endpoint_id: root.binding.endpoint_id });
    },
    async restart() {
      await stop();
      roots.clear();
      daemon = new ArloDaemon({ stateDir, rateLimit: UNPACED_RATE_LIMIT, leaseNow: () => 0, ...options });
      await start();
    },
    async close() { try { await stop(); } finally { removeTempDir(stateDir); } },
  };
}
