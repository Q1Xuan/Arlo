import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import type { RequestListener } from 'node:http';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ArloDaemon } from '@arlo/daemon';
import { createPiAdapter } from '../packages/adapter-pi/src/index.ts';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from './test-utils.ts';

// Resolve the adapter's actual public Pi peer rather than reconstructing a
// SessionManager or keeping an in-memory custom marker alive across reload.
const { SessionManager }: typeof import('../packages/adapter-pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js') =
  await import(new URL('../packages/adapter-pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js', import.meta.url).href);
type Manager = ReturnType<typeof SessionManager.open>;
type ExtensionAPI = Parameters<ReturnType<typeof createPiAdapter>>[0];
type ExtensionContext = Parameters<Parameters<ExtensionAPI['on']>[1]>[1];
type Command = Parameters<ExtensionAPI['registerCommand']>[1];
type Tool = Parameters<ExtensionAPI['registerTool']>[0];

async function waitFor(ready: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(ready(), 'The current Pi attachment must be ready through the real SDK and Daemon');
}

/** Capture public Pi extension registration only; all root, transport and
 * configuration behavior is supplied by the production adapter/runtime. */
function attachment(manager: Manager, receiving = false) {
  const events = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, Command>();
  const tools = new Map<string, Tool>();
  const statuses: string[] = [];
  const notices: string[] = [];
  const controls: string[] = [];
  let stale = false;
  const ctx = {
    get mode() { if (stale) throw new Error('Native root was replaced'); return 'tui'; },
    sessionManager: manager, isIdle: () => true, abort: () => {},
    ui: {
      setStatus: (_key: string, text: string) => statuses.push(text),
      notify: (text: string) => notices.push(text),
      setEditorComponent: () => {}, getEditorComponent: () => undefined,
      onTerminalInput: () => () => {}, addAutocompleteProvider: () => {},
      select: async () => undefined,
    },
  } as unknown as ExtensionContext;
  const api = {
    on: (event: string, handler: (event: never, ctx: ExtensionContext) => unknown) => events.set(event, handler),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
    sendUserMessage: (text: string) => {
      assert.ok(receiving, 'Configuration commands must not schedule the model');
      controls.push(text);
      queueMicrotask(() => {
        void commands.get('arlo-wake')!.handler(text.slice('/arlo-wake '.length), ctx as Parameters<Command['handler']>[1]);
      });
    },
    sendMessage: () => assert.ok(receiving, 'Configuration commands must not inject model messages'),
  } as unknown as ExtensionAPI;
  return {
    api, ctx, notices, statuses, tools, controls,
    invalidate: () => { stale = true; },
    emit: (type: string, reason: string) => events.get(type)?.({ type, reason } as never, ctx),
    beforeProvider: () => events.get('before_provider_request')?.({ type: 'before_provider_request' } as never, ctx),
    async command(args = '', context = ctx) {
      const before = notices.length;
      await commands.get('arlo-root-config')!.handler(args, context as Parameters<Command['handler']>[1]);
      return notices.slice(before).at(-1);
    },
    async collaborationCommand(name: 'arlo-send-status' | 'arlo-continue' | 'arlo-reload-sending-rules', args = '', context = ctx) {
      const command = commands.get(name);
      assert.ok(command, `The public Pi extension must register /${name}`);
      const before = notices.length;
      await command.handler(args, context as Parameters<Command['handler']>[1]);
      return notices.slice(before).at(-1);
    },
    async tool(name: string, args = {}) {
      const result = await tools.get(name)!.execute('call', args, undefined, undefined, ctx as Parameters<Tool['execute']>[4]);
      const block = result.content[0]!;
      assert.equal(block.type, 'text');
      return JSON.parse((block as { text: string }).text);
    },
  };
}

function id(display: string | undefined): string {
  assert.ok(display);
  const match = display.match(/^Configuration ID: (.+)$/m);
  assert.ok(match, display);
  assert.notEqual(match[1], 'Unavailable', display);
  return match[1]!;
}

async function fixture(t: TestContext, label: string, unpaced = false) {
  const directory = createTempDir(label);
  const stateDir = path.join(directory, 'daemon');
  const sessions = path.join(directory, 'sessions');
  const settingsPath = path.join(directory, 'arlo.json');
  const attached: ReturnType<typeof attachment>[] = [];
  let daemon = new ArloDaemon({ stateDir, ...(unpaced ? { rateLimit: UNPACED_RATE_LIMIT } : {}) });
  let beforeQuery: (() => void) | undefined;
  const createServer = https.createServer;
  // Controlled transport boundary: the current native header has already
  // been read when its real HTTPS configuration request reaches the Daemon.
  https.createServer = ((options: https.ServerOptions, listener?: RequestListener) => createServer(options, (request, response) => {
    if (request.method === 'POST' && request.url === '/control/v1/roots/configuration' && beforeQuery) {
      const action = beforeQuery;
      beforeQuery = undefined;
      action();
    }
    listener?.(request, response);
  })) as typeof https.createServer;
  try { await daemon.start(); }
  finally { https.createServer = createServer; }
  t.after(async () => {
    try { for (const peer of attached.toReversed()) await peer.emit('session_shutdown', 'quit'); }
    finally { await daemon.stop(); removeTempDir(directory); }
  });
  return {
    directory, stateDir, sessions,
    beforeConfigurationQuery: (action: () => void) => { beforeQuery = action; },
    async attach(manager: Manager, reason = 'startup', receiving = false) {
      const peer = attachment(manager, receiving);
      attached.push(peer);
      createPiAdapter({ stateDir, groupName: 'root-config-contract', settingsPath, autoStart: false })(peer.api);
      await peer.emit('session_start', reason);
      await waitFor(() => peer.statuses.includes('Arlo ready'));
      return peer;
    },
    async restartDaemon() {
      await daemon.stop();
      daemon = new ArloDaemon({ stateDir });
      await daemon.start();
    },
  };
}

test('a pristine public Pi root stays ready before persistence and automatically receives its first allowance before the provider request',
  { timeout: 120_000 }, async t => {
    const rig = await fixture(t, 'pi-first-allowance', true);
    const manager = SessionManager.create(rig.directory, rig.sessions, { id: 'first-pi-root' });
    const first = await rig.attach(manager);
    assert.equal(fs.existsSync(manager.getSessionFile()!), false);
    assert.match(await first.collaborationCommand('arlo-send-status') ?? '', /Usage: unknown/u);
    manager.appendMessage({ role: 'user', content: 'Start the actual native conversation.', timestamp: Date.now() });
    await first.beforeProvider();
    const initial = await first.collaborationCommand('arlo-send-status');
    assert.match(initial ?? '', /Granted: 20\nUsed: 0\nRemaining: 20/u);
    assert.match(initial ?? '', /Initial allowance: consumed \(INITIAL_ALLOWANCE_CONSUMED\)/u);
    const period = /^Period: (.+)$/mu.exec(initial!)![1];
    const receiverManager = SessionManager.create(rig.directory, rig.sessions, { id: 'first-pi-receiver' });
    receiverManager.appendMessage({ role: 'user', content: 'Existing receiving root.', timestamp: Date.now() });
    await rig.attach(receiverManager, 'resume', true);
    const contacts = await first.tool('arlo_list_sessions');
    const sent = await first.tool('arlo_send_message', { to: contacts[0].endpoint_id, text: 'Use the automatic allowance.' });
    assert.equal(sent.status, 'accepted');
    await first.beforeProvider();
    const used = await first.collaborationCommand('arlo-send-status');
    assert.match(used ?? '', /Used: 1\nRemaining: 19/u);
    assert.match(used ?? '', new RegExp(`Period: ${period}`, 'u'));
  });

test('deferred Pi creation survives native reload but an explicit human period wins over the later automatic callback',
  { timeout: 120_000 }, async t => {
    const rig = await fixture(t, 'pi-deferred-reload');
    const manager = SessionManager.create(rig.directory, rig.sessions, { id: 'deferred-pi-root' });
    const first = await rig.attach(manager);
    await first.emit('session_shutdown', 'reload');
    first.invalidate();
    const fresh = await rig.attach(manager, 'reload');
    manager.appendMessage({ role: 'user', content: 'Public conversation after native reload.', timestamp: Date.now() });
    const continued = await fresh.collaborationCommand('arlo-continue');
    const period = /^Period: (.+)$/mu.exec(continued!)![1];
    await fresh.beforeProvider();
    await first.beforeProvider();
    assert.equal(await first.collaborationCommand('arlo-continue'), undefined,
      'Retired callbacks cannot initialize or grant for the replacement attachment');
    const state = await fresh.collaborationCommand('arlo-send-status');
    assert.match(state ?? '', /Granted: 20\nUsed: 0\nRemaining: 20/u);
    assert.match(state ?? '', new RegExp(`Period: ${period}`, 'u'));
    assert.match(state ?? '', /Initial allowance: consumed/u);
  });

test('a failed public Pi artifact read stays unproven after repair and native continuation restores sending',
  { timeout: 120_000 }, async t => {
    const rig = await fixture(t, 'pi-first-read-failure');
    const manager = SessionManager.create(rig.directory, rig.sessions, { id: 'unreadable-pi-root' });
    const first = await rig.attach(manager);
    manager.appendMessage({ role: 'user', content: 'A genuine persisted conversation.', timestamp: Date.now() });
    const open = fs.openSync;
    const failure = t.mock.method(fs, 'openSync', (file: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (String(file) === manager.getSessionFile() && flags === 'r') throw new Error('Native artifact read unavailable');
      return open(file, flags, mode);
    });
    await first.beforeProvider();
    failure.mock.restore();
    await first.beforeProvider();
    const failed = await first.collaborationCommand('arlo-send-status');
    assert.match(failed ?? '', /Usage: unknown/u);
    assert.match(failed ?? '', /FIRST_USE_UNPROVEN/u);
    assert.match(failed ?? '', /explicitly continue collaboration/u);
    assert.match(await first.collaborationCommand('arlo-continue') ?? '', /Remaining: 20/u);
  });

test('Pi initial eligibility publication faults before, during and after commit keep public status and prevent automatic retries',
  { timeout: 240_000 }, async t => {
    for (const window of ['before', 'during', 'after'] as const) {
      await t.test(window, async sub => {
        const rig = await fixture(sub, `pi-first-publication-${window}`);
        const manager = SessionManager.create(rig.directory, rig.sessions, { id: `pi-first-${window}` });
        const first = await rig.attach(manager);
        manager.appendMessage({ role: 'user', content: 'Persist the real public session.', timestamp: Date.now() });
        const rename = fs.renameSync;
        const marker = path.join(rig.stateDir, 'sending-controls.initialized');
        const ledger = path.join(rig.stateDir, 'sending-controls.json');
        const failure = sub.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
          if (String(to) === (window === 'before' ? marker : ledger)) {
            if (window !== 'after') throw new Error(`Injected ${window} publication fault`);
            rename(from, to);
            // Change real host persistence through its public API after the
            // durable commit, before the Daemon may open the new live period.
            manager.appendSessionInfo('Public metadata changed during publication');
            return;
          }
          rename(from, to);
        });
        await first.beforeProvider();
        failure.mock.restore();
        await first.beforeProvider();
        const state = await first.collaborationCommand('arlo-send-status');
        assert.match(state ?? '', /Usage: unknown/u);
        assert.match(state ?? '', /Pause reason: ALLOWANCE_UNKNOWN/u);
        assert.match(state ?? '', window === 'after' ? /INITIAL_ALLOWANCE_CONSUMED/u
          : window === 'during' ? /HISTORY_UNAVAILABLE/u : /FIRST_USE_UNPROVEN/u);
        assert.match(state ?? '', window === 'during' ? /Restore complete protected history/u : /continue collaboration/u);
        if (window !== 'during') assert.match(await first.collaborationCommand('arlo-continue') ?? '', /Remaining: 20/u);
      });
    }
  });

test('only the original physical Pi owner gets an initial allowance and reopening it after Daemon loss keeps consumed eligibility with unknown usage',
  { timeout: 120_000 }, async t => {
    const rig = await fixture(t, 'pi-first-owner-and-loss');
    const originalManager = SessionManager.create(rig.directory, rig.sessions, { id: 'same-initial-session-id' });
    const original = await rig.attach(originalManager);
    originalManager.appendMessage({ role: 'user', content: 'The original physical root.', timestamp: Date.now() });
    await original.beforeProvider();
    const originalId = id(await original.command());
    const period = /^Period: (.+)$/mu.exec((await original.collaborationCommand('arlo-send-status'))!)![1];
    const otherManager = SessionManager.create(rig.directory, path.join(rig.directory, 'other-store'),
      { id: 'same-initial-session-id' });
    const other = await rig.attach(otherManager);
    otherManager.appendMessage({ role: 'user', content: 'Distinct actual Pi instance with a reused SessionId.', timestamp: Date.now() });
    await other.beforeProvider();
    assert.match(await other.collaborationCommand('arlo-send-status') ?? '', /Usage: unknown/u);
    assert.match(await other.command() ?? '', /Ownership: conflict/u);
    await original.emit('session_shutdown', 'quit');
    original.invalidate();
    await other.emit('session_shutdown', 'quit');
    other.invalidate();
    await rig.restartDaemon();
    const reopened = await rig.attach(SessionManager.open(originalManager.getSessionFile()!), 'resume');
    await reopened.beforeProvider();
    assert.equal(id(await reopened.command()), originalId);
    const lost = await reopened.collaborationCommand('arlo-send-status');
    assert.match(lost ?? '', /Used: unknown\nRemaining: unknown/u);
    assert.match(lost ?? '', /Initial allowance: consumed/u);
    assert.match(lost ?? '', new RegExp(`Period: ${period}`, 'u'));
    const continued = await reopened.collaborationCommand('arlo-continue');
    assert.match(continued ?? '', /Remaining: 20/u);
    assert.notEqual(/^Period: (.+)$/mu.exec(continued!)![1], period);
  });

test('Pi public persisted session reload uses a fresh manager, adapter and Daemon to recover the same root configuration',
  { timeout: 60_000 }, async t => {
    const rig = await fixture(t, 'pi-root-config-reopen');
    const manager = SessionManager.create(rig.directory, rig.sessions, { id: 'persisted-pi-root' });
    manager.appendMessage({ role: 'user', content: 'Persist through the public Pi API.', timestamp: Date.now() });
    manager.appendSessionInfo('Shared title');
    const file = manager.getSessionFile()!;
    const first = await rig.attach(manager);
    const transcript = fs.readFileSync(file, 'utf8');
    const display = await first.command();
    const configId = id(display);
    assert.match(display!, /Ownership: verified \(BOUND\)/);
    assert.match(display!, /Current root authenticated: true/);
    assert.match(display!, /Historical first eligibility: unknown/);
    assert.equal(fs.readFileSync(file, 'utf8'), transcript, 'Arlo never writes a host session or frozen header');
    assert.deepEqual([...first.tools.keys()].sort(), ['arlo_get_message_status', 'arlo_list_sessions', 'arlo_send_message']);

    await first.emit('session_shutdown', 'quit');
    first.invalidate();
    await rig.restartDaemon();
    const reopened = SessionManager.open(file);
    assert.notEqual(reopened, manager);
    assert.notEqual(reopened.getHeader(), manager.getHeader());
    assert.equal(reopened.getSessionId(), manager.getSessionId());
    assert.equal(reopened.getSessionName(), 'Shared title');
    const fresh = await rig.attach(reopened);
    assert.equal(id(await fresh.command()), configId);
    reopened.appendMessage({ role: 'user', content: 'Ordinary append preserves durable ownership.', timestamp: Date.now() });
    assert.equal(id(await fresh.command()), configId);
    assert.match(await fresh.command('another-root') ?? '', /with no arguments/);
    assert.match(await fresh.command('', { ...fresh.ctx, sessionManager: manager } as ExtensionContext) ?? '', /CALLER_NOT_ROOT/);
    assert.equal(await first.command(), undefined, 'A retired command callback cannot reveal a replacement configuration');
  });

test('Pi public reload applies private root rules to actual dispatches while retaining current usage and failed snapshots',
  { timeout: 120_000 }, async t => {
    const rig = await fixture(t, 'pi-sending-rules-public', true);
    const manager = SessionManager.create(rig.directory, rig.sessions, { id: 'rule-controlled-sender' });
    manager.appendMessage({ role: 'user', content: 'Durable sender.', timestamp: Date.now() });
    const receiverManager = SessionManager.create(rig.directory, rig.sessions, { id: 'rule-independent-receiver' });
    receiverManager.appendMessage({ role: 'user', content: 'Durable receiver.', timestamp: Date.now() });
    const sender = await rig.attach(manager);
    const receiver = await rig.attach(receiverManager, 'startup', true);
    const configId = id(await sender.command());
    const rulesPath = path.join(rig.stateDir, 'autonomous-communication.json');
    const writeRules = (mode: 'bounded' | 'continuous', grant: number) => fs.writeFileSync(rulesPath,
      JSON.stringify({ version: 1, roots: { [configId]: { mode, grant } } }), { mode: 0o600 });
    const original = await sender.collaborationCommand('arlo-continue');
    const period = /^Period: (.+)$/mu.exec(original!)![1];
    writeRules('continuous', 7);
    assert.match(await sender.collaborationCommand('arlo-send-status') ?? '', /Mode: bounded/u,
      'File edits wait for an explicit trusted reload');
    assert.match(await sender.collaborationCommand('arlo-reload-sending-rules', 'other-root') ?? '', /with no arguments/u);
    const loaded = await sender.collaborationCommand('arlo-reload-sending-rules');
    assert.match(loaded!, /Mode: continuous/u);
    assert.match(loaded!, /Remaining: unlimited/u);
    assert.match(loaded!, /Granted: 20/u);
    assert.match(loaded!, /Next grant: 7/u);
    const contacts = await sender.tool('arlo_list_sessions');
    assert.equal(contacts.length, 1);
    for (let attempt = 0; attempt < 21; attempt++) {
      const sent = await sender.tool('arlo_send_message', { to: contacts[0].endpoint_id, text: `continuous attempt ${attempt + 1}` });
      assert.equal(sent.status, 'accepted');
    }
    const continuous = await sender.collaborationCommand('arlo-continue');
    assert.match(continuous!, /Used: 21/u);
    assert.match(continuous!, new RegExp(`Period: ${period}`, 'u'), 'Continuous continuation does not issue or clear a period');
    assert.match(await receiver.collaborationCommand('arlo-send-status') ?? '', /Mode: bounded/u);
    writeRules('bounded', 3);
    const bounded = await sender.collaborationCommand('arlo-reload-sending-rules');
    assert.match(bounded!, /Used: 21/u);
    assert.match(bounded!, /Granted: 20/u);
    assert.match(bounded!, /Remaining: 0/u);
    assert.match(bounded!, /ALLOWANCE_EXHAUSTED/u);
    await assert.rejects(sender.tool('arlo_send_message', { to: contacts[0].endpoint_id, text: 'switch back must refuse' }),
      { code: 'ALLOWANCE_EXHAUSTED' });
    const renewed = await sender.collaborationCommand('arlo-continue');
    assert.match(renewed!, /Granted: 3/u);
    assert.match(renewed!, /Used: 0/u);
    fs.writeFileSync(rulesPath, '{"version":1,"roots":');
    assert.match(await sender.collaborationCommand('arlo-reload-sending-rules') ?? '', /SENDING_RULES_INVALID/u);
    const preserved = await sender.collaborationCommand('arlo-send-status');
    assert.match(preserved!, /Mode: bounded/u);
    assert.match(preserved!, /Granted: 3/u);
    assert.match(preserved!, /Next grant: 3/u);
    assert.match(preserved!, /Rules problem: /u);
    assert.deepEqual(sender.controls, []);
    assert.deepEqual([...sender.tools.keys()].sort(), ['arlo_get_message_status', 'arlo_list_sessions', 'arlo_send_message']);
  });

test('Pi public human sending commands bind the current actual root and ordinary user messages do not grant a period',
  { timeout: 120_000 }, async t => {
    const rig = await fixture(t, 'pi-collaboration-commands');
    const manager = SessionManager.create(rig.directory, rig.sessions, { id: 'human-collaboration-root' });
    manager.appendMessage({ role: 'user', content: 'Persist this real root.', timestamp: Date.now() });
    const peer = await rig.attach(manager);
    const before = await peer.collaborationCommand('arlo-send-status');
    assert.match(before!, /Usage: unknown/u);
    assert.match(before!, /Used: unknown/u);
    assert.match(before!, /Remaining: unknown/u);
    assert.match(before!, /ALLOWANCE_UNKNOWN/u);
    assert.match(await peer.collaborationCommand('arlo-continue', '20') ?? '', /with no arguments/u);
    assert.match(await peer.collaborationCommand('arlo-send-status') ?? '', /ALLOWANCE_UNKNOWN/u);
    const restored = await peer.collaborationCommand('arlo-continue');
    assert.match(restored!, /Granted: 20/u);
    assert.match(restored!, /Remaining: 20/u);
    assert.match(restored!, /dispatch attempts/u);
    const period = /^Period: (.+)$/mu.exec(restored!)![1];
    manager.appendMessage({ role: 'user', content: '/arlo-continue as ordinary conversation text', timestamp: Date.now() });
    assert.match(await peer.collaborationCommand('arlo-send-status') ?? '', new RegExp(`Period: ${period}`, 'u'));
    assert.deepEqual([...peer.tools.keys()].sort(), ['arlo_get_message_status', 'arlo_list_sessions', 'arlo_send_message']);
    const other = SessionManager.create(rig.directory, rig.sessions, { id: 'other-root' });
    assert.match(await peer.collaborationCommand('arlo-continue', '', { ...peer.ctx, sessionManager: other }) ?? '', /CALLER_NOT_ROOT/u);
    await peer.emit('session_shutdown', 'quit');
    peer.invalidate();
    assert.equal(await peer.collaborationCommand('arlo-continue'), undefined, 'A retired human command cannot grant its replacement root');
    await rig.restartDaemon();
    const fresh = await rig.attach(SessionManager.open(manager.getSessionFile()!));
    const lost = await fresh.collaborationCommand('arlo-send-status');
    assert.match(lost!, /Granted: 20/u);
    assert.match(lost!, /Used: unknown/u);
    assert.match(lost!, /Remaining: unknown/u);
    assert.match(lost!, /ALLOWANCE_UNKNOWN/u);
    const newPeriod = await fresh.collaborationCommand('arlo-continue');
    assert.match(newPeriod!, /Remaining: 20/u);
    assert.notEqual(/^Period: (.+)$/mu.exec(newPeriod!)![1], period, 'A new human command is required after lost usage state');
  });

test('Pi public reload command explains invalid version, grant and partial JSON without a separate status query',
  { timeout: 60_000 }, async t => {
    const rig = await fixture(t, 'pi-sending-rules-errors');
    const manager = SessionManager.create(rig.directory, rig.sessions, { id: 'rule-diagnostic-root' });
    manager.appendMessage({ role: 'user', content: 'Persist the root for trusted rule loading.', timestamp: Date.now() });
    const peer = await rig.attach(manager);
    const configId = id(await peer.command());
    const rulesPath = path.join(rig.stateDir, 'autonomous-communication.json');
    for (const [file, explanation] of [
      [JSON.stringify({ version: 2, roots: {} }), /version must be 1/u],
      [JSON.stringify({ version: 1, roots: { [configId]: { mode: 'bounded', grant: 0 } } }), /grant must be a positive safe integer/u],
      ['{"version":1,"roots":', /complete valid JSON/u],
    ] as const) {
      fs.writeFileSync(rulesPath, file, { mode: 0o600 });
      const display = await peer.collaborationCommand('arlo-reload-sending-rules');
      assert.match(display ?? '', /SENDING_RULES_INVALID/u);
      assert.match(display ?? '', explanation);
    }
    assert.deepEqual(peer.controls, [], 'Invalid human reload commands do not schedule the model');
  });

test('Pi public paths without durable conversations are unknown and cannot be treated as historical first eligibility',
  { timeout: 60_000 }, async t => {
    const rig = await fixture(t, 'pi-root-config-unwritten');
    const manager = SessionManager.create(rig.directory, rig.sessions, { id: 'not-yet-written' });
    manager.appendCustomEntry('unrelated-extension', { marker: true });
    manager.appendSessionInfo('Setup is not persistence');
    const file = manager.getSessionFile()!;
    assert.equal(fs.existsSync(file), false, 'Pi publicly keeps setup/custom entries in memory until conversation');
    const peer = await rig.attach(manager);
    const unknown = await peer.command();
    assert.match(unknown!, /Configuration ID: Unavailable/);
    assert.match(unknown!, /Current root authenticated: true/);
    assert.match(unknown!, /Ownership: unknown \(EVIDENCE_UNAVAILABLE\)/);
    assert.match(unknown!, /Historical first eligibility: unknown/);
    assert.equal(fs.existsSync(file), false);
    manager.appendMessage({ role: 'user', content: 'Now the real host writes its session.', timestamp: Date.now() });
    assert.match(await peer.command() ?? '', /Ownership: verified \(BOUND\)/);
  });

test('Pi human continuation can recover after the public host makes an initially unsaved root durable',
  { timeout: 60_000 }, async t => {
    const rig = await fixture(t, 'pi-collaboration-unsaved');
    const manager = SessionManager.create(rig.directory, rig.sessions, { id: 'unsaved-collaboration-root' });
    const peer = await rig.attach(manager);
    assert.match(await peer.collaborationCommand('arlo-continue') ?? '', /ALLOWANCE_UNKNOWN/u);
    manager.appendMessage({ role: 'user', content: 'The actual host now persists this root.', timestamp: Date.now() });
    assert.match(await peer.collaborationCommand('arlo-continue') ?? '', /Remaining: 20/u);
  });

test('Pi copied persisted records and distinct public sessions sharing a bare SessionId cannot merge root configuration',
  { timeout: 60_000 }, async t => {
    const rig = await fixture(t, 'pi-root-config-copy');
    const original = SessionManager.create(rig.directory, rig.sessions, { id: 'reused-bare-id' });
    original.appendMessage({ role: 'user', content: 'Original persistent owner.', timestamp: Date.now() });
    original.appendSessionInfo('Same display name');
    const owner = await rig.attach(original);
    const ownerId = id(await owner.command());
    const copiedFile = path.join(rig.sessions, 'copied-session.jsonl');
    fs.copyFileSync(original.getSessionFile()!, copiedFile);
    const copiedManager = SessionManager.open(copiedFile);
    assert.equal(copiedManager.getSessionId(), original.getSessionId());
    const copy = await rig.attach(copiedManager);
    const conflict = await copy.command();
    assert.match(conflict!, /Ownership: conflict \(OWNER_CONFLICT\)/);
    assert.match(conflict!, /Configuration ID: Unavailable/);
    assert.equal(id(await owner.command()), ownerId);

    const separate = SessionManager.create(rig.directory, path.join(rig.directory, 'other-sessions'), { id: 'reused-bare-id' });
    separate.appendMessage({ role: 'user', content: 'Separate actual root.', timestamp: Date.now() });
    separate.appendSessionInfo('Same display name');
    const other = await rig.attach(separate);
    assert.match(await other.command() ?? '', /Ownership: conflict \(OWNER_CONFLICT\)/);
  });

test('concurrent actual Pi managers opening one persisted session cannot both claim its live root configuration',
  { timeout: 60_000 }, async t => {
    const rig = await fixture(t, 'pi-root-config-concurrent');
    const manager = SessionManager.create(rig.directory, rig.sessions, { id: 'concurrent-pi-root' });
    manager.appendMessage({ role: 'user', content: 'One persistent session, two live native instances.', timestamp: Date.now() });
    const reopened = SessionManager.open(manager.getSessionFile()!);
    assert.notEqual(reopened, manager);
    const first = await rig.attach(manager);
    const second = await rig.attach(reopened);
    const results = await Promise.all([first.command(), second.command()]);
    assert.equal(results.filter(display => display?.includes('Ownership: verified (BOUND)')).length, 1);
    assert.equal(results.filter(display => display?.includes('Ownership: conflict (OWNER_CONFLICT)')).length, 1);
    const winner = results[0]!.includes('Ownership: verified') ? first : second;
    const loser = winner === first ? second : first;
    const ownerId = id(results.find(display => display?.includes('Ownership: verified')));
    await winner.emit('session_shutdown', 'quit');
    winner.invalidate();
    assert.equal(id(await loser.command()), ownerId, 'After the original live owner closes, the same durable file can resume');
  });

test('Pi missing and malformed durable evidence stays unknown even when the live public manager remembers its header',
  { timeout: 60_000 }, async t => {
    const rig = await fixture(t, 'pi-root-config-invalid');
    const manager = SessionManager.create(rig.directory, rig.sessions, { id: 'lost-durable-evidence' });
    manager.appendMessage({ role: 'user', content: 'Persisted before loss.', timestamp: Date.now() });
    const file = manager.getSessionFile()!;
    const peer = await rig.attach(manager);
    id(await peer.command());
    // Simulate external history damage; these are fixtures, never adapter writes.
    fs.writeFileSync(file, 'invalid-jsonl\n');
    assert.match(await peer.command() ?? '', /Ownership: unknown \(EVIDENCE_INVALID\)/);
    assert.throws(() => SessionManager.open(file), /not a valid/);
    fs.unlinkSync(file);
    assert.match(await peer.command() ?? '', /Ownership: unknown \(EVIDENCE_UNAVAILABLE\)/);
  });

test('Pi pins the exact validated public session file when it is replaced before the trusted HTTPS query arrives',
  { timeout: 60_000 }, async t => {
    const rig = await fixture(t, 'pi-root-config-evidence-pin');
    const manager = SessionManager.create(rig.directory, rig.sessions, { id: 'replaced-during-query' });
    manager.appendMessage({ role: 'user', content: 'Validate this physical session file.', timestamp: Date.now() });
    const file = manager.getSessionFile()!;
    const transcript = fs.readFileSync(file, 'utf8');
    const peer = await rig.attach(manager);
    rig.beforeConfigurationQuery(() => {
      // Preserve the header/SessionId while replacing the physical artifact.
      // A path and previously valid header must not silently bind this copy.
      fs.renameSync(file, `${file}.original`);
      fs.writeFileSync(file, transcript);
    });
    assert.match(await peer.command() ?? '', /Ownership: conflict \(OWNER_CONFLICT\)/);
    assert.equal(fs.readFileSync(file, 'utf8'), transcript);
    fs.unlinkSync(file);
    fs.renameSync(`${file}.original`, file);
    assert.match(await peer.command() ?? '', /Ownership: verified \(BOUND\)/);
  });

test('a fresh Pi public manager cannot inherit an old configuration after a different same-ID session is copied over its physical file',
  { timeout: 60_000 }, async t => {
    const rig = await fixture(t, 'pi-root-config-overwrite-origin');
    const original = SessionManager.create(rig.directory, rig.sessions, { id: 'copied-over-id' });
    original.appendMessage({ role: 'user', content: 'The original root owns its user rules.', timestamp: Date.now() });
    const file = original.getSessionFile()!;
    const first = await rig.attach(original);
    id(await first.command());
    await first.emit('session_shutdown', 'quit');
    first.invalidate();

    const source = SessionManager.create(rig.directory, path.join(rig.directory, 'other-origin'), { id: 'copied-over-id' });
    source.appendMessage({ role: 'user', content: 'Another actual root happens to reuse a bare ID.', timestamp: Date.now() });
    assert.notEqual(source.getHeader()!.timestamp, original.getHeader()!.timestamp);
    const before = fs.statSync(file, { bigint: true });
    fs.copyFileSync(source.getSessionFile()!, file);
    const after = fs.statSync(file, { bigint: true });
    assert.equal(after.ino, before.ino, 'Copying over an existing file preserves its physical inode');
    assert.equal(after.birthtimeNs, before.birthtimeNs, 'The file creation identity also survives in-place copy');
    const reloaded = SessionManager.open(file);
    assert.equal(reloaded.getSessionId(), original.getSessionId());
    assert.equal(reloaded.getHeader()!.timestamp, source.getHeader()!.timestamp);
    const replacement = await rig.attach(reloaded);
    assert.match(await replacement.command() ?? '', /Ownership: conflict \(OWNER_CONFLICT\)/);
  });
