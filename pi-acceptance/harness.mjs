import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from '@lydell/node-pty';
import { spawnSync } from 'node:child_process';
import { cliProcess } from '../tests/fixtures/pi-component-distribution.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = path.resolve(here, '..');
const installation = process.env.ARLO_PI_INSTALL_REPORT
  ? JSON.parse(fs.readFileSync(process.env.ARLO_PI_INSTALL_REPORT, 'utf8')) : undefined;
if (installation) assert.equal(installation.status, 'passed', 'Installed acceptance requires a successful Pi build report');
const entries = installation?.entries;
const { ArloDaemon } = await import(entries ? pathToFileURL(entries.daemonEntry).href : '@arlo/daemon');
export const { ControlClient, MAX_ROOT_PENDING_MESSAGES, MAX_ROOT_PENDING_BYTES, MAX_SINGLE_TEXT_BYTES,
  enforceWindowsAcl, captureRootConfigurationEvidence } = await import(entries ? pathToFileURL(entries.sdkEntry).href : '@arlo/sdk');
// Source acceptance must share the adapter's host peer too. The independently
// installed PTY harness has another Pi copy with separate editor keybindings.
const piEntry = entries?.piEntry ?? fs.realpathSync(path.join(repo,
  'packages/adapter-pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js'));
export const { VERSION: piVersion } = await import(pathToFileURL(piEntry).href);
const cli = entries?.piCli ?? path.join(path.dirname(piEntry), 'bundle/cli.js');
const adapterEntry = entries ? pathToFileURL(entries.adapterEntry).href : process.env.ARLO_PI_ADAPTER_ENTRY ??
  pathToFileURL(path.join(repo, 'packages/adapter-pi/src/index.ts')).href;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function eventually(read, predicate, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await pause(20);
  }
  throw new Error(`Timed out: ${label}`);
}

function stream(response, model, delta, finishReason, usage = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: `local-${crypto.randomUUID()}`, object: 'chat.completion.chunk', created: 1, model };
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40, ...usage } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

export const modelText = (text = 'Controlled local response.', usage = {}) => ({ response, body }) =>
  stream(response, body.model, { content: text }, 'stop', usage);
export const modelTool = (name, args) => ({ response, body }) =>
  stream(response, body.model, { tool_calls: [{ index: 0, id: `call-${crypto.randomUUID()}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
export function lastTool(body, name) {
  const result = body.messages.findLast(message => message.role === 'tool' && (!name || message.name === name));
  assert.ok(result, `Expected actual model tool result ${name ?? ''}`);
  const text = typeof result.content === 'string' ? result.content
    : result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  return JSON.parse(text);
}
export function inbound(body, marker) {
  for (const message of [...body.messages].reverse()) {
    if (message.role !== 'user') continue;
    const text = typeof message.content === 'string' ? message.content
      : message.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (!text?.includes(marker)) continue;
    const match = text.match(/\{"arlo":\{[^\n]+\}\}/);
    if (match) return { text, ...JSON.parse(match[0]).arlo };
  }
  return undefined;
}

/** The controlled model discovers and sends in response to a native user submit. */
export async function sendFromNative(rig, peer, targetName, text) {
  let step = 0, receipt, status;
  const settled = peer.events().filter(event => event.type === 'agent_settled').length;
  rig.handlers.set(peer.name, request => {
    if (step++ === 0) return modelTool('arlo_list_sessions', {})(request);
    if (step === 2) {
      const peers = lastTool(request.body);
      const target = peers.find(item => item.display_name === targetName);
      assert.ok(target, `The model must discover ${targetName}`);
      return modelTool('arlo_send_message', { to: target.endpoint_id, text })(request);
    }
    if (step === 3) {
      receipt = lastTool(request.body);
      assert.equal(receipt.status, 'accepted');
      return modelTool('arlo_get_message_status', { message_id: receipt.message_id })(request);
    }
    status = lastTool(request.body);
    assert.equal(status.status, 'accepted');
    return modelText('Message accepted by the receiving host.')(request);
  });
  await peer.submit(`Find ${targetName}, send this request, and query its reception: ${text}`);
  await eventually(() => peer.events(), events => events.filter(event => event.type === 'agent_settled').length > settled,
    `${peer.name} sends and queries through native model tools`, 30_000);
  assert.deepEqual(rig.errors, []);
  assert.ok(receipt && status);
  return { receipt, status };
}

/** Submit a native human sending command and await its own public notification. */
export async function sendingCommand(peer, command) {
  await eventually(() => peer.events().findLast(event => event.type === 'draft'),
    event => event?.text === '', `${peer.name} editor finishes the previous submission`);
  const offset = peer.events().length;
  await peer.submit(command);
  const notification = await eventually(() => peer.events().slice(offset).findLast(event =>
    event.type === 'notification' && event.message.includes('Arlo dispatch attempts')),
    Boolean, `${peer.name} human sending command completes`);
  return notification.message;
}

/** Complete real first-use persistence before a legacy recovery barrier is armed. */
export async function completeOrdinaryTurn(peer) {
  const completed = peer.events().filter(event => event.type === 'agent_settled_handler_complete').length;
  await peer.submit('Complete an ordinary local turn before the recovery fixture begins.');
  await eventually(() => peer.events(), events => events.filter(event => event.type === 'agent_settled_handler_complete').length > completed,
    `${peer.name} completes its ordinary setup turn`);
  await eventually(() => peer.events().findLast(event => event.type === 'draft'),
    event => event?.text === '', `${peer.name} editor is ready after ordinary setup`);
}

/** Explicit trusted fixture operation for synthetic SDK load senders. Native
 * Pi roots retain their real automatic initial allowance and human commands. */
export async function grantSdkLoadRoot(rig, control, binding, sessionId, grant) {
  const { SessionManager } = await import(pathToFileURL(piEntry).href);
  const manager = SessionManager.create(rig.directory, path.join(rig.directory, 'sdk-load-sessions'), { id: sessionId });
  manager.appendMessage({ role: 'user', content: 'Authorize this SDK capacity load fixture.', timestamp: Date.now() });
  const header = manager.getHeader();
  const evidence = captureRootConfigurationEvidence(manager.getSessionFile(), undefined,
    JSON.stringify([header.id, header.timestamp, header.cwd, header.parentSession]));
  const request = { endpoint_id: binding.endpoint_id, generation: binding.generation, evidence };
  const before = await control.getRootSendingStatus(binding.root_token, request);
  assert.equal(before.root_configuration.ownership, 'verified');
  const { config_id: configId, config_path: configPath } = before.root_configuration;
  assert.ok(configId);
  const rules = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { version: 1, roots: {} };
  rules.roots[configId] = { mode: 'bounded', grant };
  fs.writeFileSync(configPath, JSON.stringify(rules), { mode: 0o600 });
  const reloaded = await control.reloadSendingRules(binding.root_token, {
    ...request, daemon_id: before.daemon_id, rules_revision: before.rules_revision,
  });
  assert.equal(reloaded.mode, 'bounded');
  assert.equal(reloaded.next_grant, grant);
  const continued = await control.continueCollaboration(binding.root_token, {
    ...request, daemon_id: reloaded.daemon_id, request_id: crypto.randomUUID(), sequence: reloaded.control_sequence + 1,
  });
  assert.equal(continued.knowledge, 'known');
  assert.equal(continued.remaining, grant);
  return continued;
}

export async function nativeScenario(label, options = {}) {
  const expectedNode = process.env.ARLO_PI_EXPECTED_NODE ?? 'v24.13.1';
  assert.equal(process.version, expectedNode,
    'Pi acceptance driver Node differs from the selected candidate; this is a probe configuration failure');
  if (expectedNode !== 'v24.13.1') assert.ok(installation,
    'Node candidate acceptance requires installed JavaScript, without workspace source fallback');
  const directory = fs.mkdtempSync(path.join(os.homedir(), `arlo-issue62-${label}-`));
  enforceWindowsAcl(directory, true);
  fs.writeFileSync(path.join(directory, '.arlo-owner.json'), JSON.stringify({ owner: crypto.randomUUID(), pid: process.pid }));
  const stateDir = path.join(directory, 'daemon');
  fs.mkdirSync(stateDir);
  enforceWindowsAcl(stateDir, true);
  // The existing daemon's Windows ownership helper runs only in this process
  // tree. No machine or user execution policy is changed.
  if (process.platform === 'win32') process.env.PSExecutionPolicyPreference = 'Bypass';
  let idleStopped = false;
  const daemon = new ArloDaemon({ stateDir, idleTimeoutMs: options.idleTimeoutMs,
    leaseDurationMs: options.leaseDurationMs, rateLimit: options.rateLimit,
    onIdleStopped: () => { idleStopped = true; } });
  const randomUUID = crypto.randomUUID;
  if (options.randomUUID) crypto.randomUUID = options.randomUUID;
  // Transport faults hold or reject real HTTPS data-plane requests. The
  // production directory, identity checks and endpoint policy remain in use.
  const daemonSockets = new Set();
  const directoryGate = { mode: 'open', held: [] };
  const creditGate = { mode: 'open', hold: false, held: [], attempts: 0 };
  const receiptGate = { mode: 'open', held: [] };
  const heartbeatGate = { mode: 'open', held: [] };
  const connectGate = { mode: 'open', held: [] };
  const readyGate = { mode: 'open', held: [] };
  const accounting = [];
  const receipts = [];
  const heartbeats = [];
  const readiness = [];
  const interceptors = new Map([
    ['/control/v1/roots/credit', { gate: creditGate, records: accounting }],
    ['/control/v1/roots/receipt', { gate: receiptGate, records: receipts }],
    ['/control/v1/roots/heartbeat', { gate: heartbeatGate, records: heartbeats }],
    // Connect bodies contain continuity credentials, so they are never recorded.
    ['/control/v1/roots/connect', { gate: connectGate }],
    ['/control/v1/roots/ready', { gate: readyGate, records: readiness }],
  ]);
  const createServer = https.createServer;
  https.createServer = function(options, listener) {
    const srv = createServer.call(this, options, (request, response) => {
      const interceptor = request.method === 'POST' && interceptors.get(request.url);
      if (interceptor) {
        const { gate, records } = interceptor;
        if (gate === creditGate) creditGate.attempts++;
        const forward = (fail = false) => {
          if (records) {
            let raw = '';
            request.on('data', chunk => { raw += chunk; });
            response.once('finish', () => records.push({ path: request.url,
              status: response.statusCode, proof: JSON.parse(raw) }));
          }
          if (gate.mode === 'drop') {
            for (const socket of daemonSockets) socket.destroy();
            daemonSockets.clear();
            return;
          }
          if (gate.mode === 'fail' || fail) {
            request.resume();
            response.writeHead(503, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'controlled control-plane failure' }));
          } else {
            listener(request, response);
            request.resume();
          }
        };
        if (gate.mode === 'hold' || gate.hold) {
          request.pause();
          gate.held.push(forward);
        } else forward();
        return;
      }
      if (request.method === 'POST' && request.url === '/control/v1/runtimes/revoke') {
        response.once('finish', () => accounting.push({ path: request.url, status: response.statusCode }));
      }
      if (request.method !== 'POST' || request.url !== '/mcp' || directoryGate.mode === 'open') {
        return listener(request, response);
      }
      if (directoryGate.mode === 'fail') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'controlled directory failure' }));
        return;
      }
      request.pause();
      directoryGate.held.push(() => { listener(request, response); request.resume(); });
    });
    srv.on('secureConnection', socket => {
      daemonSockets.add(socket);
      socket.on('close', () => daemonSockets.delete(socket));
    });
    return srv;
  };
  try { await daemon.start(); }
  catch (error) { crypto.randomUUID = randomUUID; throw error; }
  finally { https.createServer = createServer; }
  const peers = [];
  const requests = [];
  const errors = [];
  const handlers = new Map();
  const server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const entry = { peer: body.model, body, response, closed: false };
      requests.push(entry);
      response.on('close', () => { entry.closed = true; });
      fs.appendFileSync(path.join(directory, 'model-requests.jsonl'), JSON.stringify({ peer: body.model, body }) + '\n');
      await (handlers.get(body.model) ?? modelText())(entry);
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      if (!response.writableEnded) response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  async function start(name, settings = {}, native = {}) {
    let loadedAdapterEntry = adapterEntry;
    let setupReport;
    const home = path.join(directory, name);
    fs.mkdirSync(home, { mode: 0o700 });
    enforceWindowsAcl(home, true);
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
      quietStartup: true, theme: 'dark', doubleEscapeAction: 'none', cacheWarming: 'off',
      showTerminalProgress: false, compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } }, ...settings,
    }));
    if (native.enabled === false) fs.writeFileSync(path.join(home, 'arlo-enabled.json'), JSON.stringify({ enabled: false }));
    if (native.keybindings) fs.writeFileSync(path.join(home, 'keybindings.json'), JSON.stringify(native.keybindings));
    if (process.env.ARLO_PI_FD) {
      fs.mkdirSync(path.join(home, 'bin'));
      fs.copyFileSync(process.env.ARLO_PI_FD, path.join(home, 'bin', process.platform === 'win32' ? 'fd.exe' : 'fd'));
    }
    for (const [file, text] of Object.entries(native.files ?? {})) {
      const target = path.join(home, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers: { acceptance: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-only',
      models: [{ id: name, name, input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    if (native.setup) {
      assert.ok(entries, 'CLI setup acceptance requires consumed compiled packages');
      const setupCli = native.cli ?? path.resolve(path.dirname(entries.daemonEntry), '../bin/arlo.js');
      const setupArgs = [setupCli, 'setup', '--host', 'pi', '--target', native.target ?? path.resolve(path.dirname(entries.piEntry), '..'),
        ...(!native.acquire ? ['--adapter', path.resolve(path.dirname(entries.adapterEntry), '..')] : []), '--agent-dir', home, '--apply', '--json'];
      await native.beforeSetup?.({ home, setupArgs, setupCli });
      const registered = native.acquire ? await cliProcess(setupCli, setupArgs.slice(1), { directory: home, env: native.packageEnv })
        : spawnSync(process.execPath, setupArgs, { encoding: 'utf8', cwd: home });
      fs.writeFileSync(path.join(home, 'setup-command.json'), JSON.stringify({ executable: process.execPath, args: setupArgs,
        status: registered.status, signal: registered.signal, stdout: registered.stdout, stderr: registered.stderr }, null, 2));
      assert.equal(registered.status, 0, registered.stderr + registered.stdout);
      setupReport = JSON.parse(registered.stdout);
      assert.equal(setupReport.phase, 'configured-pending-start-or-reload');
      if (native.acquire) {
        const manifest = JSON.parse(fs.readFileSync(path.join(setupReport.adapter.directory, 'package.json'), 'utf8'));
        loadedAdapterEntry = pathToFileURL(path.join(setupReport.adapter.directory, manifest.exports['.'].default)).href;
      }
      // Existing user preference enables participation; package registration
      // itself must never grant communication authorization.
      fs.writeFileSync(path.join(home, 'arlo.json'), JSON.stringify({ crossHostEnabled: true }));
    }
    fs.writeFileSync(path.join(home, 'events.jsonl'), '');
    const fixture = path.join(home, 'fixture.mjs');
    fs.writeFileSync(fixture, fs.readFileSync(path.join(here, 'fixture.mjs'), 'utf8')
      .replace("'ARLO_PI_ADAPTER_MODULE'", JSON.stringify(loadedAdapterEntry)));
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'ComSpec', 'OS', 'PROCESSOR_ARCHITECTURE']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home,
      PI_CODING_AGENT_DIR: home, PI_TELEMETRY: 'false', PI_OFFLINE: '1', TERM: 'xterm-256color',
      PSExecutionPolicyPreference: 'Bypass', ARLO_PI_SCENARIO_DIR: home, ARLO_PI_STATE_DIR: stateDir,
      ARLO_PI_GROUP: `native-${label}`, ARLO_PI_ADAPTER_ENTRY: loadedAdapterEntry,
      ...(native.setup ? { ARLO_PI_SETUP_MODE: '1', ARLO_STATE_DIR: stateDir } : {}),
      ...(native.missingCapability ? { ARLO_PI_MISSING_CAPABILITY: native.missingCapability } : {}),
      ...(native.invalidHeaderIdentity ? { ARLO_PI_INVALID_HEADER_IDENTITY: '1' } : {}),
      ...(native.settingsPath ? { ARLO_PI_SETTINGS_PATH: native.settingsPath } : {}),
      ...(options.observeNativeHistory ? { ARLO_PI_OBSERVE_NATIVE_HISTORY: '1' } : {}),
      NODE_OPTIONS: `--import=${pathToFileURL(path.join(repo, 'probes/isolation.mjs')).href}`,
    });
    const terminal = spawn(process.execPath, [cli, '--offline', '--no-approve', '--no-context-files',
      ...(!native.setup ? ['--no-extensions'] : []), '--no-skills', '--no-prompt-templates', '--no-themes', '--no-builtin-tools',
      '--extension', fixture, '--model', `acceptance/${name}`, '--thinking', 'off',
      '--session-id', name, ...(native.title === null ? [] : ['--name', native.title ?? name]),
      ...((native.enabled !== false && (native.experimental ?? options.experimental ?? process.env.ARLO_PI_EXPERIMENTAL === '1')) ? ['--arlo-experimental'] : [])],
    { cwd: native.setup ? directory : home, env, cols: 120, rows: 32, name: 'xterm-256color' });
    let output = '';
    let exit;
    terminal.onData(data => {
      output += data;
      fs.appendFileSync(path.join(home, 'terminal.log'), data);
      // Terminal capability queries need responses from the test terminal.
      if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
      if (data.includes('\x1b[c')) terminal.write('\x1b[?1;2c');
    });
    terminal.onExit(event => { exit = event; });
    const peer = { name, home, terminal, setupReport,
      get output() { return output; }, get exit() { return exit; },
      events() {
        const text = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8');
        // A concurrent append may expose an unfinished final record. Retain
        // it for the next observation; malformed complete records still fail.
        return text.slice(0, text.lastIndexOf('\n') + 1).split('\n')
          .filter(Boolean).map(line => JSON.parse(line));
      },
      write: text => terminal.write(text),
      async submit(text) {
        const events = peer.events();
        const draft = events.findLast(event => event.type === 'draft')?.text ?? '';
        // Finish a native paste before sending its distinct submit key. The
        // public fixture hook marks this key as unmodified, because Windows Pi
        // otherwise consults the desktop's current physical Shift state.
        terminal.write(`\x1b[200~${text}\x1b[201~`);
        await eventually(() => peer.events().slice(events.length),
          updates => updates.some(event => event.type === 'draft' && event.text === draft + text),
          `${name} native draft receives submission text`);
        fs.writeFileSync(path.join(home, 'submit-key.json'), JSON.stringify({ draft: draft + text }));
        terminal.write('\r');
        await eventually(() => peer.events().slice(events.length),
          updates => updates.some(event => event.type === 'native_submit_key'),
          `${name} native submit key reaches the editor`);
        // Commands can notify before the editor clears their input. Observe
        // that public clear before the next paste reads the previous draft.
        await eventually(() => peer.events().slice(events.length),
          updates => exit || updates.some(event => event.type === 'draft' && event.text === ''),
          `${name} native editor clears the submitted draft`);
      },
      async quit() {
        // Keep the native double-Ctrl-C gesture in one terminal write. A
        // delayed parent timer can otherwise miss the host's 500 ms window.
        terminal.write('\x03\x03');
        await eventually(() => exit, Boolean, `${name} native root exits`, 10_000);
      },
      gate(name, state) { fs.writeFileSync(path.join(home, `${name}.json`), JSON.stringify({ state })); },
      editorAction(action) { fs.writeFileSync(path.join(home, 'editor-action.json'), JSON.stringify(action)); },
      async ready() { await eventually(() => ({ output, exit }), value => {
        assert.equal(value.exit, undefined, `Pi exited before ready: ${JSON.stringify(value.exit)}\n${value.output}`);
        return value.output.includes('Arlo ready');
      }, `${name} native readiness`, 40_000); },
    };
    peers.push(peer);
    return peer;
  }
  const releaseGate = (gate, { fail = false } = {}) => {
    gate.mode = 'open';
    if ('hold' in gate) gate.hold = false;
    for (const release of gate.held.splice(0)) release(fail);
  };
  function releaseCredits(options) {
    releaseGate(creditGate, options);
  }
  function releaseDirectory() {
    releaseGate(directoryGate);
  }
  async function close() {
    releaseCredits();
    releaseDirectory();
    releaseGate(receiptGate);
    releaseGate(heartbeatGate);
    releaseGate(connectGate);
    releaseGate(readyGate);
    for (const peer of peers) {
      if (!peer.exit) peer.write('\x03');
    }
    await pause(150);
    for (const peer of peers) {
      if (!peer.exit) {
        peer.write('\x03');
      }
    }
    await eventually(() => peers.every(peer => peer.exit), Boolean, 'native Pi shutdown', 5_000).catch(() => {});
    for (const peer of peers) if (!peer.exit) peer.terminal.kill();
    await eventually(() => peers.every(peer => peer.exit), Boolean, 'owned Pi processes exited', 5_000);
    // Release ConPTY's input handle and output worker even after a graceful
    // child exit; the exit event alone does not release those terminal resources.
    for (const peer of peers) {
      try { peer.terminal.kill(); } catch { /* The terminal may already be closed. */ }
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await daemon.stop();
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({
      node: process.version, platform: process.platform, pi: piVersion,
      installation: installation ? { consumer: installation.consumer, entries } : undefined,
      requests: requests.map(({ peer, body }) => ({ peer, body })),
      accounting,
      receipts, heartbeats, readiness,
      peers: peers.map(peer => ({ name: peer.name, events: peer.events(), exit: peer.exit })),
      errors: errors.map(String),
    }, null, 2) + '\n');
  }
  return { directory, stateDir, groupName: `native-${label}`, start, async close() {
    try { await close(); }
    finally { crypto.randomUUID = randomUUID; }
  }, handlers, requests, errors,
    directoryGate, creditGate, receiptGate, heartbeatGate, connectGate, readyGate,
    accounting, receipts, heartbeats, readiness,
    get idleStopped() { return idleStopped; },
    releaseCredit: releaseCredits,
    releaseCredits,
    releaseDirectory,
    releaseReceipt: () => releaseGate(receiptGate),
    releaseHeartbeat: () => releaseGate(heartbeatGate),
    releaseConnect: () => releaseGate(connectGate),
    releaseReady: () => releaseGate(readyGate),
    dropConnections: () => {
      for (const socket of daemonSockets) socket.destroy();
      daemonSockets.clear();
    },
  };
}
