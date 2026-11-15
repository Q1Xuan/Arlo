import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ReceptionLedger } from '@arlo/adapter-sdk';
import { ArloDaemon } from '@arlo/daemon';
import { ControlClient, ArloError, ArloErrorCode, type RootConnection, type ArloMessageNotificationParams } from '@arlo/sdk';
import { createPiAdapter, PiInputSource } from '../packages/adapter-pi/src/index.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

// Pi is the adapter's peer, not a dependency of the repository test package.
const { SessionManager }: typeof import('../packages/adapter-pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js') =
  await import(new URL('../packages/adapter-pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js', import.meta.url).href);
type ExtensionAPI = Parameters<ReturnType<typeof createPiAdapter>>[0];
type ExtensionContext = Parameters<Parameters<ExtensionAPI['on']>[1]>[1];
type Command = Parameters<ExtensionAPI['registerCommand']>[1];
type Tool = Parameters<ExtensionAPI['registerTool']>[0];

function frame(sequence: number, text = `message ${sequence}`, generation = 1): ArloMessageNotificationParams {
  return {
    protocol_version: '0.1', daemon_id: 'daemon', message_id: `msg-${sequence}`,
    delivery_id: `delivery-${sequence}`, from_endpoint: 'sender', to_endpoint: 'receiver',
    group_id: 'group', target_generation: generation, delivery_seq: String(sequence), text,
    sent_at: '2026-10-10T00:00:00.000Z',
  };
}

// Capture only public extension callbacks; root storage, input ownership,
// runtime registration and reception accounting use the production adapter.
function piAttachment(id: string, sessions: string, manager?: ExtensionContext['sessionManager']) {
  if (!manager) {
    const persisted = SessionManager.create(process.cwd(), sessions, { id });
    persisted.appendMessage({ role: 'user', content: 'Persist the actual regression root through the public Pi API.', timestamp: Date.now() });
    persisted.appendSessionInfo(id);
    manager = persisted;
  }
  let invalid = false;
  const statuses: string[] = [];
  const notices: string[] = [];
  const commandNotices: string[] = [];
  let humanCommand = false;
  const controls: string[] = [];
  const messages: Parameters<ExtensionAPI['sendMessage']>[0][] = [];
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const ctx = {
    get mode() { if (invalid) throw new Error('Stale Pi extension context'); return 'tui'; },
    sessionManager: manager, isIdle: () => true, abort: () => {},
    ui: {
      setStatus: (_key: string, text: string) => { statuses.push(text); },
      notify: (text: string) => { (humanCommand ? commandNotices : notices).push(text); },
      setEditorComponent: () => {}, onTerminalInput: () => () => {}, addAutocompleteProvider: () => {},
      getEditorComponent: () => undefined, select: async () => undefined,
    },
  } as unknown as ExtensionContext;
  const api = {
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => { handlers.set(name, handler); },
    registerTool: (tool: Tool) => { tools.set(tool.name, tool); },
    registerCommand: (name: string, command: Command) => { commands.set(name, command); },
    appendEntry: () => {},
    sendUserMessage: (text: string) => { controls.push(text.slice('/arlo-wake '.length)); },
    sendMessage: (message: Parameters<ExtensionAPI['sendMessage']>[0]) => { messages.push(message); },
  } as unknown as ExtensionAPI;
  return {
    api, ctx, statuses, notices, controls, messages,
    invalidate: () => { invalid = true; },
    emit: (event: { type: string; reason: string }) => handlers.get(event.type)?.(event as never, ctx),
    wake: (token: string, context = ctx) => commands.get('arlo-wake')!.handler(token, context as Parameters<Command['handler']>[1]),
    async continueCollaboration() {
      const before = commandNotices.length;
      humanCommand = true;
      try { await commands.get('arlo-continue')!.handler('', ctx as Parameters<Command['handler']>[1]); }
      finally { humanCommand = false; }
      // Native command feedback is expected; unsolicited lifecycle notices
      // remain separately observable by every existing recovery assertion.
      const feedback = commandNotices.slice(before);
      assert.equal(feedback.length, 1);
      assert.match(feedback[0]!, /Usage: known/u);
      assert.match(feedback[0]!, /Granted: 20/u);
      assert.match(feedback[0]!, /Remaining: 20/u);
    },
    async tool(name: string, args = {}) {
      const result = await tools.get(name)!.execute('call', args, undefined, undefined, ctx as Parameters<Tool['execute']>[4]);
      const block = result.content[0]!;
      assert.equal(block.type, 'text');
      return JSON.parse((block as { text: string }).text);
    },
  };
}

test('a stale Pi wake before reload shutdown retains accepted input for the replacement attachment', { timeout: 60_000 }, async t => {
  const stateDir = createTempDir('pi-stale-wake');
  const daemon = new ArloDaemon({ stateDir });
  const attached: ReturnType<typeof piAttachment>[] = [];
  t.after(async () => {
    try {
      for (const peer of attached.toReversed()) await peer.emit({ type: 'session_shutdown', reason: 'quit' });
    } finally { await daemon.stop(); removeTempDir(stateDir); }
  });
  await daemon.start();
  async function attach(id: string, previous?: ReturnType<typeof piAttachment>) {
    const peer = piAttachment(id, path.join(stateDir, 'sessions'), previous?.ctx.sessionManager);
    attached.push(peer);
    await createPiAdapter({ stateDir, groupName: 'pi-stale-wake', autoStart: false })(peer.api);
    await peer.emit({ type: 'session_start', reason: previous ? 'reload' : 'startup' });
    assert.deepEqual(peer.notices, [], 'A stale wake must not turn reload into permanent retirement');
    await waitFor(() => peer.statuses.includes('Arlo ready'));
    return peer;
  }
  async function waitFor(matches: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!matches() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(matches(), 'The real Pi adapter must become ready and schedule retained input');
  }
  const alpha = await attach('alpha');
  const bravo = await attach('bravo');
  await alpha.continueCollaboration();
  const [originalEndpoint] = await alpha.tool('arlo_list_sessions');
  const first = await alpha.tool('arlo_send_message', { to: originalEndpoint.endpoint_id, text: 'retained across stale wake' });
  assert.equal(first.status, 'accepted');
  await waitFor(() => bravo.controls.length > 0);
  const oldControl = bravo.controls[0]!;
  // Exercise a stale callback before the authoritative shutdown callback.
  bravo.invalidate();
  await bravo.wake(oldControl);
  assert.equal(bravo.messages.length, 0);
  await bravo.emit({ type: 'session_shutdown', reason: 'reload' });
  const replacement = await attach('bravo', bravo);
  await waitFor(() => replacement.controls.length > 0);
  await bravo.wake(oldControl, replacement.ctx);
  await assert.rejects(bravo.tool('arlo_list_sessions'), { code: 'CALLER_NOT_ROOT' });
  await replacement.wake(oldControl);
  assert.equal(replacement.messages.length, 0, 'Neither old callback nor old token may claim retained input');
  const newControl = replacement.controls[0]!;
  await replacement.wake(newControl);
  await replacement.wake(newControl);
  assert.equal(replacement.messages.length, 1);
  assert.match(JSON.stringify(replacement.messages[0]!.content), /retained across stale wake/);
  const received = replacement.messages[0]!.details as { messages: { message_id: string }[] };
  assert.deepEqual(received.messages.map(message => message.message_id), [first.message_id]);
  assert.equal((await alpha.tool('arlo_get_message_status', { message_id: first.message_id })).status, 'accepted');
  const [resumedEndpoint] = await alpha.tool('arlo_list_sessions');
  assert.equal(resumedEndpoint.endpoint_id, originalEndpoint.endpoint_id);
  const second = await alpha.tool('arlo_send_message', { to: resumedEndpoint.endpoint_id, text: 'fresh after stale wake' });
  assert.equal(second.status, 'accepted');
  await waitFor(() => replacement.controls.length > 1);
  await replacement.wake(replacement.controls[1]!);
  assert.equal(replacement.messages.length, 2);
  assert.match(JSON.stringify(replacement.messages[1]!.content), /fresh after stale wake/);
});

test('Pi reload routes recovery readiness to the current attachment and preserves reception and replies',
  { timeout: 60_000 }, async t => {
    const stateDir = createTempDir('pi-reload-recovery');
    const daemon = new ArloDaemon({ stateDir });
    const attached: ReturnType<typeof piAttachment>[] = [];
    const connections: RootConnection[] = [];
    const createRootConnection = ControlClient.prototype.createRootConnection;
    ControlClient.prototype.createRootConnection = function(...args: Parameters<ControlClient['createRootConnection']>) {
      const connection = createRootConnection.apply(this, args);
      connections.push(connection);
      return connection;
    };
    t.after(async () => {
      ControlClient.prototype.createRootConnection = createRootConnection;
      try {
        for (const peer of attached.toReversed()) await peer.emit({ type: 'session_shutdown', reason: 'quit' });
      } finally { await daemon.stop(); removeTempDir(stateDir); }
    });
    await daemon.start();
    async function waitFor(matches: () => boolean, description: string, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (!matches() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(matches(), description);
    }
    async function attach(id: string, previous?: ReturnType<typeof piAttachment>) {
      const peer = piAttachment(id, path.join(stateDir, 'sessions'), previous?.ctx.sessionManager);
      attached.push(peer);
      await createPiAdapter({ stateDir, groupName: 'pi-reload-recovery', autoStart: false })(peer.api);
      await peer.emit({ type: 'session_start', reason: previous ? 'reload' : 'startup' });
      await waitFor(() => peer.statuses.includes('Arlo ready'), 'The current Pi attachment becomes ready');
      assert.deepEqual(peer.notices, []);
      return peer;
    }

    const alpha = await attach('reload-alpha');
    const bravo = await attach('reload-bravo');
    const [originalEndpoint] = await alpha.tool('arlo_list_sessions');
    await bravo.emit({ type: 'session_shutdown', reason: 'reload' });
    bravo.invalidate();
    const replacement = await attach('reload-bravo', bravo);
    const [resumedEndpoint] = await alpha.tool('arlo_list_sessions');
    assert.equal(resumedEndpoint.endpoint_id, originalEndpoint.endpoint_id);
    const currentConnection = connections.findLast(connection => connection.binding.endpoint_id === resumedEndpoint.endpoint_id)!;
    assert.ok(currentConnection);
    const oldStatuses = [...bravo.statuses];
    const statusOffset = replacement.statuses.length;

    currentConnection.dispose();
    await waitFor(() => {
      const statuses = replacement.statuses.slice(statusOffset);
      const connecting = statuses.indexOf('Arlo connecting');
      return connecting >= 0 && statuses.slice(connecting + 1).includes('Arlo ready');
    }, 'Recovery updates the replacement UI from connecting to ready', 30_000);
    assert.deepEqual(bravo.statuses, oldStatuses, 'Recovery cannot update the retired attachment UI');
    const recoveredConnection = connections.findLast(connection => connection.binding.endpoint_id === resumedEndpoint.endpoint_id)!;
    assert.notEqual(recoveredConnection, currentConnection);
    assert.ok(recoveredConnection.binding.generation > currentConnection.binding.generation);

    const [senderEndpoint] = await replacement.tool('arlo_list_sessions');
    const [recoveredEndpoint] = await alpha.tool('arlo_list_sessions');
    assert.equal(recoveredEndpoint.endpoint_id, originalEndpoint.endpoint_id);
    await alpha.continueCollaboration();
    const received = await alpha.tool('arlo_send_message', {
      to: recoveredEndpoint.endpoint_id, text: 'input after reload and transport recovery',
    });
    assert.equal(received.status, 'accepted');
    await waitFor(() => replacement.controls.length > 0, 'The replacement schedules newly received input');
    await replacement.wake(replacement.controls[0]!);
    assert.equal(replacement.messages.length, 1);
    assert.match(JSON.stringify(replacement.messages[0]!.content), /input after reload and transport recovery/);
    const details = replacement.messages[0]!.details as { messages: { message_id: string }[] };
    assert.deepEqual(details.messages.map(message => message.message_id), [received.message_id]);

    await replacement.continueCollaboration();
    const reply = await replacement.tool('arlo_send_message', {
      to: senderEndpoint.endpoint_id, reply_to: received.message_id, text: 'reply from the recovered replacement',
    });
    assert.equal(reply.status, 'accepted');
    await waitFor(() => alpha.controls.length > 0, 'The sender receives the replacement attachment reply');
    await alpha.wake(alpha.controls[0]!);
    assert.equal(alpha.messages.length, 1);
    const replyDetails = alpha.messages[0]!.details as { messages: { message_id: string; reply_to: string }[] };
    assert.deepEqual(replyDetails.messages.map(message => ({ message_id: message.message_id, reply_to: message.reply_to })),
      [{ message_id: reply.message_id, reply_to: received.message_id }]);
    assert.deepEqual(bravo.statuses, oldStatuses, 'Later reception and replies still leave the old attachment untouched');
    assert.deepEqual(replacement.notices, []);
  });

test('Pi rejects reattachment to a different configuration while retaining accepted input', { timeout: 60_000 }, async t => {
  const stateDir = createTempDir('pi-reload-config');
  const daemon = new ArloDaemon({ stateDir });
  const attached: ReturnType<typeof piAttachment>[] = [];
  const inputs = new Map<string, PiInputSource>();
  const prepare = PiInputSource.prototype.prepare;
  PiInputSource.prototype.prepare = function(frame) {
    inputs.set(frame.message_id, this);
    return prepare.call(this, frame);
  };
  t.after(async () => {
    PiInputSource.prototype.prepare = prepare;
    try {
      for (const peer of attached.toReversed()) await peer.emit({ type: 'session_shutdown', reason: 'quit' });
    } finally { await daemon.stop(); removeTempDir(stateDir); }
  });
  await daemon.start();
  async function attach(id: string, settingsPath: string, previous?: ReturnType<typeof piAttachment>) {
    const peer = piAttachment(id, path.join(stateDir, 'sessions'), previous?.ctx.sessionManager);
    attached.push(peer);
    await createPiAdapter({ stateDir, groupName: 'pi-reload-config', autoStart: false, settingsPath })(peer.api);
    await peer.emit({ type: 'session_start', reason: previous ? 'reload' : 'startup' });
    return peer;
  }
  const configPath = path.join(stateDir, 'original.json');
  const alpha = await attach('config-alpha', configPath);
  const bravo = await attach('config-bravo', configPath);
  const deadline = Date.now() + 5000;
  while ((!alpha.statuses.includes('Arlo ready') || !bravo.statuses.includes('Arlo ready')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await alpha.continueCollaboration();
  const [endpoint] = await alpha.tool('arlo_list_sessions');
  const sent = await alpha.tool('arlo_send_message', { to: endpoint.endpoint_id, text: 'keep the original configuration and input' });
  assert.equal(sent.status, 'accepted');
  await bravo.emit({ type: 'session_shutdown', reason: 'reload' });
  bravo.invalidate();
  const replacement = await attach('config-bravo', path.join(stateDir, 'independent.json'), bravo);
  assert.ok(replacement.notices.some(text => text.includes('Arlo stopped after a session or attachment change')),
    'A different configuration cannot take over the retained runtime');
  await assert.rejects(replacement.tool('arlo_list_sessions'), { code: 'CALLER_NOT_ROOT' });
  assert.equal(replacement.messages.length, 0);
  assert.equal(bravo.messages.length, 0);
  const status = await alpha.tool('arlo_get_message_status', { message_id: sent.message_id });
  assert.equal(status.status, 'accepted', 'Incompatible reattachment preserves the original accepted outcome');
  const input = inputs.get(sent.message_id)!;
  assert.deepEqual(input.snapshot({ instanceId: input.instanceId, generation: status.target_generation }).pending.map(item => item.messageId),
    [sent.message_id], 'Incompatible reattachment retains the unclaimed input');
});

for (const attachmentReason of ['startup', 'reload'] as const) {
  test(`Pi ${attachmentReason} activates reception after a transient participation update failure`, { timeout: 60_000 }, async t => {
    const stateDir = createTempDir(`pi-settings-${attachmentReason}`);
    const daemon = new ArloDaemon({ stateDir });
    const attached: ReturnType<typeof piAttachment>[] = [];
    const getParticipation = ControlClient.prototype.getRuntimeParticipation;
    let senderControl: ControlClient | undefined;
    let failNext = false;
    ControlClient.prototype.getRuntimeParticipation = async function(...args: Parameters<ControlClient['getRuntimeParticipation']>) {
      senderControl ??= this;
      if (failNext && this !== senderControl) {
        failNext = false;
        throw new ArloError(ArloErrorCode.CONNECTION_FAILED);
      }
      return getParticipation.apply(this, args);
    };
    t.after(async () => {
      ControlClient.prototype.getRuntimeParticipation = getParticipation;
      try {
        for (const peer of attached.toReversed()) await peer.emit({ type: 'session_shutdown', reason: 'quit' });
      } finally { await daemon.stop(); removeTempDir(stateDir); }
    });
    await daemon.start();
    async function waitFor(matches: () => boolean, description: string) {
      const deadline = Date.now() + 5000;
      while (!matches() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(matches(), description);
    }
    async function attach(id: string, previous?: ReturnType<typeof piAttachment>) {
      const peer = piAttachment(id, path.join(stateDir, 'sessions'), previous?.ctx.sessionManager);
      attached.push(peer);
      await createPiAdapter({ stateDir, groupName: 'pi-settings-recovery', autoStart: false,
        settingsPath: path.join(stateDir, 'arlo.json') })(peer.api);
      await peer.emit({ type: 'session_start', reason: previous ? 'reload' : 'startup' });
      return peer;
    }
    const alpha = await attach('settings-alpha');
    await waitFor(() => alpha.statuses.includes('Arlo ready') && alpha.statuses.includes('Arlo cross-host: off'), 'The sender is ready');
    let previous: ReturnType<typeof piAttachment> | undefined;
    let accepted: { message_id: string; status: string } | undefined;
    let originalEndpoint: string | undefined;
    if (attachmentReason === 'reload') {
      previous = await attach('settings-bravo');
      await waitFor(() => previous!.statuses.includes('Arlo ready'), 'The original receiver is ready');
      await alpha.continueCollaboration();
      const [endpoint] = await alpha.tool('arlo_list_sessions');
      originalEndpoint = endpoint.endpoint_id;
      accepted = await alpha.tool('arlo_send_message', { to: originalEndpoint, text: 'retained while settings recover' });
      assert.equal(accepted!.status, 'accepted');
      await previous.emit({ type: 'session_shutdown', reason: 'reload' });
      previous.invalidate();
    }
    failNext = true;
    const receiver = await attach('settings-bravo', previous);
    await waitFor(() => receiver.notices.some(text => text.includes('CONNECTION_FAILED')), 'The failed settings update is visible');
    await waitFor(() => receiver.statuses.includes('Arlo cross-host: off'), 'Polling confirms the saved setting after recovery');
    await waitFor(() => receiver.statuses.includes('Arlo ready'), 'Confirmed settings allow the current attachment to become ready');
    const [endpoint] = await alpha.tool('arlo_list_sessions');
    if (originalEndpoint) assert.equal(endpoint.endpoint_id, originalEndpoint, 'Reload retains the original endpoint');
    if (!accepted) {
      await alpha.continueCollaboration();
      accepted = await alpha.tool('arlo_send_message', { to: endpoint.endpoint_id, text: 'input after settings recover' });
      assert.equal(accepted!.status, 'accepted');
    }
    await waitFor(() => receiver.controls.length > 0, 'The recovered attachment schedules accepted input');
    await receiver.wake(receiver.controls[0]!);
    await receiver.wake(receiver.controls[0]!);
    assert.equal(receiver.messages.length, 1, 'The original input is consumed once');
    const details = receiver.messages[0]!.details as { messages: { message_id: string }[] };
    assert.deepEqual(details.messages.map(message => message.message_id), [accepted!.message_id]);
    assert.equal(previous?.messages.length ?? 0, 0, 'The old attachment never consumes the retained input');
  });
}

test('Pi reattachment consumes the original input once and invalidates every old consumer action', async () => {
  let idle = true;
  const controls: string[] = [];
  const input = new PiInputSource();
  const consumer = () => ({ current: () => true, idle: () => idle,
    sendControl: (token: string) => { controls.push(token); }, unavailable: () => {}, changed: () => {} });
  const callbacks = consumer();
  const original = input.attach(callbacks);
  const ledger = new ReceptionLedger({ host: input, currentGeneration: 1, initialCapacity: 1 });
  try {
    assert.equal((await ledger.receiveFrame(frame(1, 'retained body'))).status, 'enqueued');
    const oldControl = controls[0]!;
    const oldPreparation = input.prepare(frame(2));
    original.detach();
    const replacement = input.attach(callbacks, { suspended: true });
    ledger.advanceGeneration(2);
    assert.deepEqual(original.beforeSettle(), []);
    original.cancelPending();
    original.detach();
    original.operationFinished();
    assert.equal(original.control(oldControl), undefined);
    assert.equal(oldPreparation.enqueue(), 'not_enqueued');
    assert.deepEqual(replacement.beforeSettle(), [], 'Consumption waits for complete accounting');
    assert.deepEqual(ledger.reconcilePendingMessageIds(), ['msg-1']);
    assert.equal(ledger.getAvailableCapacity(), 0);
    replacement.activate();
    assert.equal(controls.length, 2);
    assert.equal(replacement.control(oldControl), undefined);
    assert.match(JSON.stringify(replacement.control(controls[1]!)?.content), /retained body/);
    assert.deepEqual(replacement.beforeSettle(), []);
    assert.equal(ledger.getAvailableCapacity(), 1);
    idle = false;
    assert.equal((await ledger.receiveFrame(frame(3, 'busy retained body', 2))).status, 'enqueued');
    assert.equal(controls.length, 2, 'Busy reception waits without issuing an idle control');
    replacement.detach();
    const busyReplacement = input.attach(callbacks, { suspended: true });
    ledger.advanceGeneration(3);
    assert.deepEqual(replacement.beforeSettle(), []);
    replacement.settled(true);
    busyReplacement.activate();
    assert.equal(controls.length, 2, 'Activating while busy still waits for a settlement boundary');
    const settledDrafts = busyReplacement.beforeSettle();
    assert.equal(settledDrafts.length, 1);
    assert.match(JSON.stringify(settledDrafts[0]?.content), /busy retained body/);
    assert.deepEqual(busyReplacement.beforeSettle(), []);
    assert.equal(ledger.getAvailableCapacity(), 1);
    assert.deepEqual(ledger.getUnconfirmedCredits().map(proof => ({ message: proof.message_id,
      delivery: proof.delivery_id, generation: proof.generation, event: proof.event })), [
      { message: 'msg-1', delivery: 'delivery-1', generation: 1, event: 'claimed' },
      { message: 'msg-3', delivery: 'delivery-3', generation: 2, event: 'claimed' },
    ]);
    assert.deepEqual(ledger.getRetainedEvidence().map(item => item.receipt.status), ['enqueued', 'enqueued']);
  } finally { input.detach(); ledger.dispose(); }
});

test('Pi root closure ends only unclaimed input with original dispatch evidence and seals every entry point', async () => {
  const controls: string[] = [];
  const input = new PiInputSource();
  input.attach({ current: () => true, idle: () => true, sendControl: token => { controls.push(token); },
    unavailable: () => {}, changed: () => {} });
  const ledger = new ReceptionLedger({ host: input, currentGeneration: 1, initialCapacity: 2 });
  try {
    assert.equal((await ledger.receiveFrame(frame(1, 'permanently handed off'))).status, 'enqueued');
    assert.equal(input.beforeSettle().length, 1);
    // A later Pi commit or processing failure cannot put this input back.
    assert.equal((await ledger.receiveFrame(frame(2, 'still pending'))).status, 'enqueued');
    const prepared = input.prepare(frame(3));
    const oldControl = controls.at(-1)!;
    input.detach(); // An attachment can stop before the actual root ends.
    input.close();
    input.close();
    assert.equal(prepared.enqueue(), 'not_enqueued');
    assert.equal(input.deferControl(oldControl), false);
    assert.equal(input.control(oldControl), undefined);
    assert.deepEqual(input.beforeSettle(), []);
    assert.throws(() => input.attach({ current: () => true, idle: () => true,
      sendControl: () => {}, unavailable: () => {}, changed: () => {} }));
    assert.deepEqual(ledger.reconcilePendingMessageIds(), []);
    assert.equal(ledger.getAvailableCapacity(), 2);
    assert.deepEqual(ledger.getUnconfirmedCredits().map(proof => ({ message_id: proof.message_id,
      delivery_id: proof.delivery_id, generation: proof.generation, event: proof.event })), [
      { message_id: 'msg-1', delivery_id: 'delivery-1', generation: 1, event: 'claimed' },
      { message_id: 'msg-2', delivery_id: 'delivery-2', generation: 1, event: 'discarded' },
    ]);
    assert.deepEqual(ledger.getRetainedEvidence().map(evidence => evidence.receipt.status), ['enqueued', 'enqueued']);
  } finally {
    input.detach();
    ledger.dispose();
  }
});

test('Pi reception retains complete pending credit when control delivery fails across a busy boundary', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let idle = true;
  let stopped = false;
  const controls: string[] = [];
  const input = new PiInputSource();
  input.attach({ current: () => !stopped, idle: () => idle, sendControl: text => { controls.push(text); },
    unavailable: () => { stopped = true; }, changed: () => {} });
  const ledger = new ReceptionLedger({ host: input, currentGeneration: 1, initialCapacity: 1 });
  try {
    assert.equal((await ledger.receiveFrame(frame(1))).status, 'enqueued');
    assert.equal(controls.length, 1);
    // A body-free wake can be delayed until after Pi becomes busy. No input
    // provider has permanently claimed the business input.
    idle = false;
    t.mock.timers.tick(1000);
    idle = true;
    input.operationFinished();
    await Promise.resolve();
    t.mock.timers.tick(1000);
    t.mock.timers.tick(1000);
    assert.equal(stopped, true, 'Unconfirmed controls must not leave an invisible, unscheduled backlog');
    assert.equal(controls.length, 3, 'Only bounded control retries are permitted');
    assert.equal(controls.some(text => text.includes('message 1')), false);
    assert.deepEqual(ledger.reconcilePendingMessageIds(), ['msg-1']);
    assert.equal(ledger.getAvailableCapacity(), 0);
    assert.equal(ledger.getRetainedEvidence()[0].receipt.status, 'enqueued');
    assert.deepEqual(ledger.getUnconfirmedCredits(), []);
  } finally {
    input.detach();
    ledger.dispose();
    t.mock.timers.reset();
  }
});

test('Pi cancellation invalidates old controls while later input is claimed exactly once with its original evidence', async () => {
  const controls: string[] = [];
  const input = new PiInputSource();
  input.attach({ current: () => true, idle: () => true, sendControl: text => { controls.push(text); },
    unavailable: () => {}, changed: () => {} });
  const ledger = new ReceptionLedger({ host: input, currentGeneration: 1, initialCapacity: 2 });
  try {
    assert.equal((await ledger.receiveFrame(frame(1, 'cancelled body'))).status, 'enqueued');
    const obsolete = controls[0];
    input.settled(true);
    assert.deepEqual(ledger.reconcilePendingMessageIds(), []);
    assert.equal(ledger.getAvailableCapacity(), 2);
    assert.equal((await ledger.receiveFrame(frame(2, 'fresh body'))).status, 'enqueued');
    assert.equal(input.control(obsolete), undefined);
    assert.deepEqual(ledger.reconcilePendingMessageIds(), ['msg-2']);
    const message = input.control(controls[1]);
    assert.ok(message);
    assert.match(JSON.stringify(message.content), /fresh body/);
    assert.doesNotMatch(JSON.stringify(message.content), /cancelled body/);
    assert.equal(input.control(controls[1]), undefined);
    assert.deepEqual(input.beforeSettle(), []);
    assert.deepEqual(ledger.reconcilePendingMessageIds(), []);
    assert.equal(ledger.getAvailableCapacity(), 2);
    assert.deepEqual(ledger.getUnconfirmedCredits().map(proof => ({ message_id: proof.message_id,
      delivery_id: proof.delivery_id, generation: proof.generation, event: proof.event })), [
      { message_id: 'msg-1', delivery_id: 'delivery-1', generation: 1, event: 'discarded' },
      { message_id: 'msg-2', delivery_id: 'delivery-2', generation: 1, event: 'claimed' },
    ]);
    assert.deepEqual(ledger.getRetainedEvidence().map(evidence => evidence.receipt.status), ['enqueued', 'enqueued']);
  } finally {
    input.detach();
    ledger.dispose();
  }
});

test('Pi busy reception accounts for the complete UTF-8 backlog and reuses credit after permanent handoff', async () => {
  const controls: string[] = [];
  const input = new PiInputSource();
  input.attach({ current: () => true, idle: () => false, sendControl: text => { controls.push(text); },
    unavailable: () => {}, changed: () => {} });
  const ledger = new ReceptionLedger({ host: input, currentGeneration: 1 });
  const text = 'é'.repeat(16 * 1024); // 32 KiB UTF-8; 32 messages fill the 1 MiB budget.
  try {
    for (let sequence = 1; sequence <= 32; sequence++) {
      assert.equal((await ledger.receiveFrame(frame(sequence, text))).status, 'enqueued');
    }
    assert.equal((await ledger.receiveFrame(frame(1, text))).status, 'enqueued');
    assert.deepEqual(await ledger.receiveFrame(frame(33, 'a')), { status: 'rejected', reason: 'QUEUE_LIMIT' });
    assert.deepEqual(controls, [], 'Busy reception must not schedule or interrupt a native run');
    const snapshot = input.snapshot({ instanceId: input.instanceId, generation: 1 });
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.pending.length, 32);
    assert.equal(snapshot.pending.reduce((bytes, item) => bytes + item.textBytes, 0), 1024 * 1024);
    assert.deepEqual(snapshot.inFlight, []);
    assert.equal(input.beforeSettle().length, 32);
    assert.deepEqual(input.beforeSettle(), []);
    assert.deepEqual(ledger.reconcilePendingMessageIds(), []);
    assert.equal(ledger.getAvailableCapacity(), 64);
    assert.equal(ledger.getUnconfirmedCredits().length, 32);
    assert.equal((await ledger.receiveFrame(frame(34, text))).status, 'enqueued');
    assert.equal(ledger.getAvailableCapacity(), 63);
    assert.deepEqual(ledger.reconcilePendingMessageIds(), ['msg-34']);
  } finally {
    input.detach();
    ledger.dispose();
  }
});

test('Pi detachment preserves full pending occupancy and original dispatch across a generation change', async () => {
  const controls: string[] = [];
  const input = new PiInputSource();
  input.attach({ current: () => true, idle: () => true, sendControl: text => { controls.push(text); },
    unavailable: () => {}, changed: () => {} });
  const ledger = new ReceptionLedger({ host: input, currentGeneration: 1, initialCapacity: 1 });
  try {
    assert.equal((await ledger.receiveFrame(frame(1))).status, 'enqueued');
    const prepared = input.prepare(frame(2));
    assert.deepEqual(ledger.reconcilePendingMessageIds(), ['msg-1'], 'Preparation cannot enqueue another input');
    assert.deepEqual(await ledger.receiveFrame(frame(3)), { status: 'rejected', reason: 'QUEUE_LIMIT' });
    input.detach();
    ledger.advanceGeneration(2);
    assert.equal(prepared.enqueue(), 'not_enqueued');
    assert.equal(input.control(controls[0]), undefined);
    assert.deepEqual(input.beforeSettle(), []);
    input.settled(true);
    const snapshot = input.snapshot({ instanceId: input.instanceId, generation: 2 });
    assert.equal(snapshot.pending.length, 1);
    assert.deepEqual(snapshot.pending[0].dispatch, {
      daemon_id: 'daemon', endpoint_id: 'receiver', message_id: 'msg-1', delivery_id: 'delivery-1', generation: 1,
    });
    assert.deepEqual(ledger.reconcilePendingMessageIds(), ['msg-1']);
    assert.equal(ledger.getAvailableCapacity(), 0);
    assert.deepEqual(ledger.getUnconfirmedCredits(), []);
    assert.equal(ledger.getRetainedEvidence().find(evidence => evidence.receipt.message_id === 'msg-1')?.receipt.status, 'enqueued');
  } finally {
    input.detach();
    ledger.dispose();
  }
});

test('Pi reception restores full credit through sustained alternating claim and discard cycles', async () => {
  const controls: string[] = [];
  const input = new PiInputSource();
  input.attach({ current: () => true, idle: () => true, sendControl: token => { controls.push(token); },
    unavailable: () => {}, changed: () => {} });
  const ledger = new ReceptionLedger({ host: input, currentGeneration: 1, initialCapacity: 1 });
  try {
    for (let sequence = 1; sequence <= 130; sequence++) {
      const message = frame(sequence, `cycle ${sequence}`);
      const accepted = await ledger.receiveFrame(message);
      assert.equal(accepted.status, 'enqueued');
      assert.equal(ledger.getAvailableCapacity(), 0);
      const token = controls.at(-1)!;
      if (sequence % 2 === 1) {
        assert.ok(input.control(token));
      } else {
        input.settled(true);
      }
      assert.equal(input.control(token), undefined);
      assert.deepEqual(input.beforeSettle(), []);
      assert.equal(ledger.getAvailableCapacity(), 1);
      assert.deepEqual(ledger.reconcilePendingMessageIds(), []);
      assert.deepEqual(await ledger.receiveFrame(message), accepted, 'Disposing pending input cannot change prior acceptance');
      assert.equal(controls.length, sequence, 'A duplicate frame or control cannot schedule the business input again');
      assert.equal(ledger.getUnconfirmedCredits().length, sequence);
    }
    const proofs = ledger.getUnconfirmedCredits();
    assert.equal(proofs.filter(proof => proof.event === 'claimed').length, 65);
    assert.equal(proofs.filter(proof => proof.event === 'discarded').length, 65);
    assert.equal(new Set(proofs.map(proof => proof.message_id)).size, 130);
    assert.equal(new Set(controls).size, 130);
    assert.equal(ledger.getRetainedEvidence().filter(evidence => evidence.receipt.status === 'enqueued').length, 130);
    assert.equal((await ledger.receiveFrame(frame(1, 'cycle 1'))).status, 'enqueued');
    assert.equal(controls.length, 130);
    assert.equal(ledger.getAvailableCapacity(), 1);
  } finally {
    input.detach();
    ledger.dispose();
  }
});

for (const ending of ['cancellation', 'detachment'] as const) {
  test(`Pi acknowledged completion controls outlive busy time and cannot claim after ${ending}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let idle = false;
    let stopped = false;
    const controls: string[] = [];
    const input = new PiInputSource();
    input.attach({ current: () => true, idle: () => idle, sendControl: token => { controls.push(token); },
      unavailable: () => { stopped = true; }, changed: () => {} });
    const ledger = new ReceptionLedger({ host: input, currentGeneration: 1, initialCapacity: 1 });
    try {
      // The public compaction notification can run before any input exists.
      input.operationFinished();
      assert.equal(controls.length, 1);
      const obsolete = controls[0];
      assert.equal(input.deferControl(obsolete), true);
      assert.equal((await ledger.receiveFrame(frame(1, 'old pending input'))).status, 'enqueued');
      t.mock.timers.tick(4000);
      assert.equal(stopped, false, 'A delivered control waiting for native completion is not lost');
      assert.equal(controls.length, 1);
      assert.equal(ledger.getAvailableCapacity(), 0);
      assert.deepEqual(ledger.reconcilePendingMessageIds(), ['msg-1']);

      if (ending === 'cancellation') input.cancelPending();
      else input.detach();
      assert.equal(input.deferControl(obsolete), false);
      idle = true;
      assert.equal(input.control(obsolete), undefined);
      assert.equal(ledger.getRetainedEvidence()[0].receipt.status, 'enqueued');

      if (ending === 'cancellation') {
        assert.equal(ledger.getAvailableCapacity(), 1);
        idle = false;
        input.operationFinished();
        const fresh = controls.at(-1)!;
        assert.notEqual(fresh, obsolete);
        assert.equal(input.deferControl(fresh), true);
        assert.equal((await ledger.receiveFrame(frame(2, 'fresh pending input'))).status, 'enqueued');
        t.mock.timers.tick(4000);
        idle = true;
        assert.equal(input.control(obsolete), undefined);
        const message = input.control(fresh);
        assert.ok(message);
        assert.match(JSON.stringify(message.content), /fresh pending input/);
        assert.doesNotMatch(JSON.stringify(message.content), /old pending input/);
        assert.equal(input.control(fresh), undefined);
        assert.equal(ledger.getAvailableCapacity(), 1);
        assert.deepEqual(ledger.getUnconfirmedCredits().map(proof => proof.event), ['discarded', 'claimed']);
      } else {
        input.operationFinished();
        assert.equal(controls.length, 1);
        assert.deepEqual(input.beforeSettle(), []);
        assert.equal(ledger.getAvailableCapacity(), 0);
        assert.deepEqual(ledger.reconcilePendingMessageIds(), ['msg-1']);
        assert.deepEqual(ledger.getUnconfirmedCredits(), []);
        const replacement = input.attach({ current: () => true, idle: () => idle,
          sendControl: token => { controls.push(token); }, unavailable: () => { stopped = true; }, changed: () => {} },
          { suspended: true });
        assert.equal(replacement.deferControl(obsolete), false);
        assert.equal(replacement.control(obsolete), undefined);
        replacement.activate();
        assert.equal(controls.length, 2);
        assert.equal(replacement.control(obsolete), undefined);
        assert.match(JSON.stringify(replacement.control(controls[1]!)?.content), /old pending input/);
        assert.equal(ledger.getAvailableCapacity(), 1);
        assert.deepEqual(ledger.getUnconfirmedCredits().map(proof => proof.event), ['claimed']);
      }
    } finally {
      input.detach();
      ledger.dispose();
      t.mock.timers.reset();
    }
  });
}


test('Pi delayed unacknowledged controls stop reception without settling or replaying accepted input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controls: string[] = [];
  const failures: string[] = [];
  const input = new PiInputSource();
  const attachment = input.attach({ current: () => true, idle: () => true,
    sendControl: token => { controls.push(token); },
    unavailable: code => { failures.push(code); }, changed: () => {} });
  const ledger = new ReceptionLedger({ host: input, currentGeneration: 1, initialCapacity: 1 });
  try {
    const accepted = await ledger.receiveFrame(frame(1, 'retained beyond settlement budget'));
    assert.equal(accepted.status, 'enqueued');
    for (let attempt = 0; attempt < 3; attempt++) t.mock.timers.tick(1000);
    assert.deepEqual(failures, ['PI_CONTROL_DELIVERY_UNCONFIRMED']);
    assert.equal(controls.length, 3);
    t.mock.timers.tick(60_000);
    attachment.settled(false);
    assert.equal(controls.length, 3, 'Neither elapsed time nor idle restarts control retries');
    for (const token of controls) {
      assert.equal(attachment.deferControl(token), false);
      assert.equal(attachment.control(token), undefined);
    }
    assert.deepEqual(attachment.beforeSettle(), []);
    assert.equal(ledger.getAvailableCapacity(), 0);
    assert.deepEqual(ledger.reconcilePendingMessageIds(), ['msg-1']);
    assert.deepEqual(ledger.getUnconfirmedCredits(), []);
    assert.deepEqual(await ledger.receiveFrame(frame(1, 'retained beyond settlement budget')), accepted);
    assert.equal(input.prepare(frame(2)).enqueue(), 'not_enqueued', 'Stopped reception cannot accept fresh input');
    const retained = input.snapshot({ instanceId: input.instanceId, generation: 1 }).pending;
    assert.equal(retained.length, 1);
    assert.equal(retained[0].textBytes, Buffer.byteLength('retained beyond settlement budget'));
    assert.equal(retained[0].dispatch?.message_id, 'msg-1');
    input.close();
    assert.equal(ledger.getAvailableCapacity(), 1, 'Only final teardown releases the pending credit');
    assert.deepEqual(ledger.getUnconfirmedCredits().map(proof => ({
      event: proof.event, message_id: proof.message_id, delivery_id: proof.delivery_id, generation: proof.generation,
    })), [{ event: 'discarded', message_id: 'msg-1', delivery_id: 'delivery-1', generation: 1 }]);
    input.close();
    assert.equal(ledger.getUnconfirmedCredits().length, 1, 'Teardown cannot release credit twice');
  } finally {
    input.close();
    ledger.dispose();
    t.mock.timers.reset();
  }
});

test('Pi recovery admits fresh input before native readiness can be published without consuming early', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controls: string[] = [];
  let finish!: () => void;
  const input = new PiInputSource();
  const attachment = input.attach({ current: () => true, idle: () => true,
    sendControl: token => { controls.push(token); }, unavailable: () => {}, changed: () => {},
    recover: () => new Promise<void>(resolve => { finish = resolve; }) });
  const ledger = new ReceptionLedger({ host: input, currentGeneration: 1, initialCapacity: 2 });
  try {
    await ledger.receiveFrame(frame(1));
    for (let attempt = 0; attempt < 3; attempt++) t.mock.timers.tick(1000);
    const token = controls.at(-1)!;
    const recovering = attachment.recoverControl(token)!;
    assert.equal((await ledger.receiveFrame(frame(2))).status, 'enqueued',
      'Registration may receive a fresh notification before its ready response completes');
    assert.equal(attachment.control(token), undefined);
    assert.deepEqual(attachment.beforeSettle(), []);
    assert.deepEqual(ledger.getUnconfirmedCredits(), []);
    finish(); await recovering;
    assert.ok(attachment.control(token));
    assert.equal(attachment.control(token), undefined);
    assert.deepEqual(ledger.getUnconfirmedCredits().map(proof => [proof.message_id, proof.event]),
      [['msg-1', 'claimed'], ['msg-2', 'claimed']]);
    assert.equal(ledger.getAvailableCapacity(), 2);
  } finally {
    finish?.(); input.close(); ledger.dispose(); t.mock.timers.reset();
  }
});

for (const ending of ['claim', 'cancel', 'detach', 'close', 'recovery failure'] as const) {
  test(`Pi late final control restores reception with original accounting: ${ending}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controls: string[] = [];
    let finish!: () => void;
    const input = new PiInputSource();
    const attachment = input.attach({ current: () => true, idle: () => true,
      sendControl: token => { controls.push(token); }, unavailable: () => {}, changed: () => {},
      recover: () => ending === 'recovery failure' ? Promise.reject(new Error('restore failed'))
        : new Promise<void>(resolve => { finish = resolve; }) });
    const ledger = new ReceptionLedger({ host: input, currentGeneration: 1, initialCapacity: 1 });
    try {
      await ledger.receiveFrame(frame(1, 'original retained body'));
      for (let attempt = 0; attempt < 3; attempt++) t.mock.timers.tick(1000);
      const token = controls.at(-1)!;
      for (const stale of controls.slice(0, -1)) assert.equal(attachment.recoverControl(stale), undefined);
      assert.equal(attachment.control(token), undefined);
      assert.equal(input.prepare(frame(2)).enqueue(), 'not_enqueued');
      assert.equal(ledger.getAvailableCapacity(), 0);
      assert.deepEqual(ledger.getUnconfirmedCredits(), []);
      const recovering = attachment.recoverControl(token)!;
      assert.ok(recovering);
      if (ending === 'recovery failure') {
        await assert.rejects(recovering, /restore failed/);
        assert.equal(input.prepare(frame(2)).enqueue(), 'not_enqueued');
        assert.equal(attachment.control(token), undefined);
        assert.equal(ledger.getAvailableCapacity(), 0);
        return;
      }
      if (ending === 'cancel') attachment.cancelPending();
      if (ending === 'detach') attachment.detach();
      if (ending === 'close') input.close();
      finish();
      await recovering;
      if (ending === 'detach' || ending === 'close') {
        assert.equal(attachment.control(token), undefined);
        assert.equal(input.prepare(frame(2)).enqueue(), 'not_enqueued');
        assert.equal(ledger.getAvailableCapacity(), ending === 'close' ? 1 : 0);
        return;
      }
      const draft = attachment.control(token);
      if (ending === 'claim') assert.match(JSON.stringify(draft?.content), /original retained body/);
      else assert.equal(draft, undefined, 'Cancelled delivery cannot claim or replay a body');
      assert.equal(attachment.control(token), undefined);
      assert.deepEqual(ledger.getUnconfirmedCredits().map(proof => ({ event: proof.event,
        message_id: proof.message_id, delivery_id: proof.delivery_id, generation: proof.generation })),
      [{ event: ending === 'claim' ? 'claimed' : 'discarded', message_id: 'msg-1', delivery_id: 'delivery-1', generation: 1 }]);
      assert.equal((await ledger.receiveFrame(frame(2, 'fresh after recovery'))).status, 'enqueued');
      assert.match(JSON.stringify(attachment.control(controls.at(-1)!)?.content), /fresh after recovery/);
      assert.equal(ledger.getAvailableCapacity(), 1);
    } finally {
      input.close(); ledger.dispose(); t.mock.timers.reset();
    }
  });
}

for (const boundary of ['reload', 'root replacement'] as const) {
  test(`Pi retains expired-control input through ${boundary} without authorizing old callbacks`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controls: string[] = [];
    const input = new PiInputSource();
    const old = input.attach({ current: () => true, idle: () => true,
      sendControl: token => { controls.push(token); }, unavailable: () => { input.detach(); }, changed: () => {} });
    const ledger = new ReceptionLedger({ host: input, currentGeneration: 1, initialCapacity: 1 });
    let replacement: PiInputSource | undefined;
    try {
      await ledger.receiveFrame(frame(1, 'original root body'));
      for (let attempt = 0; attempt < 3; attempt++) t.mock.timers.tick(1000);
      assert.equal(controls.length, 3);
      assert.equal(ledger.getAvailableCapacity(), 0);
      assert.deepEqual(ledger.getUnconfirmedCredits(), []);
      if (boundary === 'root replacement') {
        input.close();
        replacement = new PiInputSource();
      }
      const live = replacement ?? input;
      const next = live.attach({ current: () => true, idle: () => true,
        sendControl: token => { controls.push(token); }, unavailable: () => {}, changed: () => {} }, { suspended: true });
      for (const token of controls) {
        assert.equal(old.control(token), undefined);
        assert.equal(old.deferControl(token), false);
        assert.equal(next.control(token), undefined);
        assert.equal(next.deferControl(token), false);
      }
      old.settled(true);
      old.cancelPending();
      old.detach();
      assert.deepEqual(old.beforeSettle(), []);
      next.activate();
      if (boundary === 'reload') {
        const draft = next.control(controls.at(-1)!);
        assert.match(JSON.stringify(draft?.content), /original root body/);
        assert.equal(next.control(controls.at(-1)!), undefined);
        assert.deepEqual(ledger.getUnconfirmedCredits().map(proof => proof.event), ['claimed']);
      } else {
        assert.equal(controls.length, 3, 'A new root never receives the old body or wake');
        assert.deepEqual(next.beforeSettle(), []);
        assert.deepEqual(ledger.getUnconfirmedCredits().map(proof => proof.event), ['discarded']);
      }
      assert.equal(ledger.getAvailableCapacity(), 1);
      assert.deepEqual(ledger.reconcilePendingMessageIds(), []);
      assert.equal(ledger.getUnconfirmedCredits()[0].message_id, 'msg-1');
      assert.equal(ledger.getUnconfirmedCredits()[0].delivery_id, 'delivery-1');
      assert.equal(ledger.getUnconfirmedCredits()[0].generation, 1);
    } finally {
      input.close();
      replacement?.close();
      ledger.dispose();
      t.mock.timers.reset();
    }
  });
}
