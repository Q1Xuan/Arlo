import fs from 'node:fs';
import path from 'node:path';
// Native setup loads its own extension from Pi's package registration. Keep
// this observer usable after /reload revokes that registration and its files.
const { createPiAdapter } = process.env.ARLO_PI_SETUP_MODE === '1' ? {} : await import('ARLO_PI_ADAPTER_MODULE');

// Acceptance observations use public Pi events. All business tools and input
// ownership are provided by the installed adapter, not this fixture.
export default async function fixture(pi) {
  const directory = process.env.ARLO_PI_SCENARIO_DIR;
  let draftObserver;
  const log = (type, detail = {}) => fs.appendFileSync(path.join(directory, 'events.jsonl'),
    JSON.stringify({ type, ...detail }) + '\n');
  const gate = async name => {
    const file = path.join(directory, `${name}.json`);
    if (!fs.existsSync(file) || JSON.parse(fs.readFileSync(file, 'utf8')).state !== 'hold') return;
    log('gate', { name });
    const started = Date.now();
    const deadline = started + 15_000;
    while (JSON.parse(fs.readFileSync(file, 'utf8')).state === 'hold') {
      if (Date.now() > deadline) throw new Error(`Acceptance gate timed out: ${name}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    log('gate_released', { name, heldMs: Date.now() - started });
  };
  const callers = globalThis[Symbol.for('arlo.acceptance.old-caller')] ??= {};
  let cancelSwitch = false;
  pi.on('session_before_switch', event => {
    log('session_before_switch', { reason: event.reason });
    return cancelSwitch ? { cancel: true } : undefined;
  });
  pi.on('session_before_fork', event => log('session_before_fork', { entryId: event.entryId }));
  pi.registerCommand('acceptance-root', {
    description: 'Exercise public Pi root lifecycle operations',
    async handler(action, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      try {
        if (action === 'resume') {
          const currentManager = ctx.sessionManager;
          const Manager = currentManager.constructor;
          const open = Manager.open;
          Manager.open = () => currentManager;
          try { await ctx.switchSession(sessionFile); }
          finally { Manager.open = open; }
        } else if (action === 'resume-original') await ctx.switchSession(callers.originalSessionFile);
        else if (action === 'fork') {
          const entry = ctx.sessionManager.getBranch().find(item => item.type === 'message' && item.message.role === 'user');
          await ctx.fork(entry.id, { position: 'at' });
        } else if (action === 'invalid-fork') await ctx.fork('missing-entry', { position: 'at' });
        else if (action === 'replacement-fails') await ctx.newSession({
          setup: async () => { throw new Error('PI_ACCEPTANCE_REPLACEMENT_FAILURE'); },
        });
        else if (action === 'cancel') {
          cancelSwitch = true;
          const result = await ctx.newSession();
          log('switch_cancelled', result);
        }
      } catch (error) { log('lifecycle_failed', { error: String(error) }); }
      finally { cancelSwitch = false; }
    },
  });
  pi.registerTool({
    name: 'acceptance_capture_caller', label: 'Capture native caller', description: 'Save a public Pi tool context',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_id, _args, _signal, _update, ctx) {
      callers.previous = ctx;
      return { content: [{ type: 'text', text: 'Native caller saved.' }], details: {} };
    },
  });
  pi.registerCommand('acceptance-stale-caller', {
    description: 'Attempt a nested communication tool through a saved native context',
    async handler(_args, _ctx) {
      try {
        const result = await callers.previous.executeTool('arlo_list_sessions', {});
        log('stale_caller_result', { result });
      } catch (error) { log('stale_caller_result', { error: String(error) }); }
    },
  });
  pi.registerCommand('acceptance-reload', {
    description: 'Exercise Pi public extension-command reload while streaming',
    async handler(_args, ctx) {
      log('acceptance_reload', { idle: ctx.isIdle() });
      await ctx.reload();
    },
  });
  pi.on('input', async event => {
    log('input', { source: event.source, text: event.text });
    if (event.source === 'extension') await gate('control-input');
  });
  pi.on('agent_settled', () => gate('before-adapter-settled'));
  const enabledFile = path.join(directory, 'arlo-enabled.json');
  if (process.env.ARLO_PI_SETUP_MODE !== '1' && (!fs.existsSync(enabledFile) || JSON.parse(fs.readFileSync(enabledFile, 'utf8')).enabled)) {
    // Contract fault injection at the public host boundary, never a version substitute.
    if (process.env.ARLO_PI_MISSING_CAPABILITY === 'sendMessage') pi.sendMessage = undefined;
    if (process.env.ARLO_PI_MISSING_CAPABILITY === 'notify') pi.on('session_start', (_event, ctx) => {
      ctx.ui.notify = undefined;
    });
    if (process.env.ARLO_PI_INVALID_HEADER_IDENTITY === '1') pi.on('session_start', (_event, ctx) => {
      const manager = ctx.sessionManager;
      const getHeader = manager.getHeader.bind(manager);
      manager.getHeader = () => ({ ...getHeader() });
    });
    const on = pi.on;
    const registerCommand = pi.registerCommand;
    if (process.env.ARLO_PI_MISSING_CAPABILITY === 'notify') {
      // Observe and rethrow real failures at registration's public boundary.
      // The native TUI may scroll long startup errors above its visible screen.
      const observeFailure = (boundary, handler) => async (...args) => {
        try { return await handler(...args); }
        catch (error) { log('adapter_error', { boundary, error: String(error) }); throw error; }
      };
      pi.on = (event, handler) => on(event, event === 'session_start' ? observeFailure(event, handler) : handler);
      pi.registerCommand = (name, command) => registerCommand(name, name === 'arlo-doctor'
        ? { ...command, handler: observeFailure(name, command.handler) } : command);
    }
    try {
      createPiAdapter({ stateDir: process.env.ARLO_PI_STATE_DIR,
        groupName: process.env.ARLO_PI_GROUP, settingsPath: process.env.ARLO_PI_SETTINGS_PATH, autoStart: false })(pi);
    } finally { pi.on = on; pi.registerCommand = registerCommand; }
  }
  pi.on('session_start', (event, ctx) => {
    // Observe the public UI boundary while preserving native notification
    // rendering. TUI redraws can repeat older notifications before a command
    // completes, so raw terminal text alone cannot identify its response.
    const observedUis = callers.observedUis ??= new WeakSet();
    if (!observedUis.has(ctx.ui) && typeof ctx.ui.notify === 'function') {
      observedUis.add(ctx.ui);
      const notify = ctx.ui.notify;
      ctx.ui.notify = (message, level) => {
        log('notification', { message, level });
        return notify.call(ctx.ui, message, level);
      };
      const setStatus = ctx.ui.setStatus;
      ctx.ui.setStatus = (key, text) => {
        log('status', { key, text });
        return setStatus.call(ctx.ui, key, text);
      };
    }
    const header = ctx.sessionManager.getHeader();
    log('session_start', {
      reason: event.reason, mode: ctx.mode, sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(), cwd: ctx.sessionManager.getCwd(),
      reusedManager: ctx.sessionManager === callers.lastManager, reusedHeader: header === callers.lastHeader,
    });
    callers.lastManager = ctx.sessionManager;
    callers.lastHeader = header;
    callers.originalSessionFile ??= ctx.sessionManager.getSessionFile();
    ctx.ui.onTerminalInput(data => {
      // ConPTY consumes explicit CSI-u Enter before Pi receives it. Raw CR
      // reaches Pi, but its Windows native modifier fallback can turn it into
      // Shift+Enter while somebody types elsewhere on the same desktop. Arm
      // only a harness-scripted submission after its exact draft is observed.
      const submitKey = path.join(directory, 'submit-key.json');
      if ((data === '\r' || data === '\x1b[13;2u') && fs.existsSync(submitKey) &&
          JSON.parse(fs.readFileSync(submitKey, 'utf8')).draft === ctx.ui.getEditorText()) {
        fs.unlinkSync(submitKey);
        log('native_submit_key', { normalizedShift: data !== '\r' });
        return { data: '\r' };
      }
      if (data === '\u001b') log('terminal_escape', { idle: ctx.isIdle() });
    });
    clearInterval(draftObserver);
    let previous;
    draftObserver = setInterval(() => {
      const actionFile = path.join(directory, 'editor-action.json');
      if (fs.existsSync(actionFile)) {
        const action = JSON.parse(fs.readFileSync(actionFile, 'utf8'));
        fs.unlinkSync(actionFile);
        if (action.type === 'draft') ctx.ui.setEditorText(action.text);
        else if (action.type === 'editor') ctx.ui.setEditorComponent(undefined);
        log('editor_action', { action });
      }
      const text = ctx.ui.getEditorText();
      if (text !== previous) { previous = text; log('draft', { text }); }
    }, 25);
  });
  pi.on('before_agent_start', async (event, ctx) => {
    log('before_agent_start', { messageType: event.messageType ?? 'user', prompt: event.prompt, idle: ctx.isIdle() });
    await gate('native-preflight');
    log('preflight_handler_complete', { prompt: event.prompt });
  });
  pi.on('agent_start', () => log('agent_start'));
  pi.on('agent_before_settle', async event => {
    log('agent_before_settle', { outcome: event.outcome });
    await gate('last-boundary');
  });
  pi.on('agent_settled', async (event, ctx) => {
    log('agent_settled', { aborted: event.aborted, idle: ctx.isIdle() });
    if (process.env.ARLO_PI_OBSERVE_NATIVE_HISTORY === '1') {
      log('native_history', { messages: ctx.sessionManager.getBranch()
        .filter(entry => entry.type === 'custom_message' && entry.customType === 'arlo-message')
        .flatMap(entry => entry.details?.messages ?? [entry.details])
        .map(detail => ({ message_id: detail.message_id, from_endpoint: detail.from_endpoint, reply_to: detail.reply_to })) });
    }
    await gate('settled');
    log('agent_settled_handler_complete', { aborted: event.aborted, idle: ctx.isIdle() });
  });
  pi.on('session_before_compact', (event, ctx) => {
    log('session_before_compact', { reason: event.reason, willRetry: event.willRetry });
    event.signal.addEventListener('abort', () => log('compaction_signal_aborted', {
      reason: event.reason, idle: ctx.isIdle(),
    }), { once: true });
  });
  pi.on('session_compact', async (event, ctx) => {
    log('session_compact', { reason: event.reason, idle: ctx.isIdle() });
    await gate('compaction-complete');
    log('session_compact_handler_complete', { reason: event.reason, idle: ctx.isIdle() });
  });
  pi.on('session_compact_failed', async (event, ctx) => {
    log('session_compact_failed', {
      aborted: event.aborted, reason: event.reason, willRetry: event.willRetry, idle: ctx.isIdle(),
    });
    await gate('compaction-failed');
    log('session_compact_failed_handler_complete', { idle: ctx.isIdle() });
  });
  pi.on('session_shutdown', event => {
    clearInterval(draftObserver);
    log('session_shutdown', { reason: event.reason });
  });
  pi.on('tool_execution_end', event => log('tool_execution_end', {
    toolName: event.toolName, result: event.result, isError: event.isError,
  }));
  pi.on('message_end', event => {
    if (event.message.role === 'custom' || event.message.role === 'assistant') {
      log('message_end', { message: event.message });
    }
  });
}
