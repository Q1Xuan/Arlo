// Opt-in real Claude TUI driver. No business messages or human grants originate here.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { launchClaudeCodeWithSidecar, readBridgeBootstrap } from '../../packages/adapter-claudecode/src/index.ts';

process.umask(0o077);
const root = process.env.ARLO_ACCEPTANCE_ROOT;
const label = process.env.ARLO_ACCEPTANCE_LABEL;
const owner = process.env.ARLO_ACCEPTANCE_OWNER;
if (!root || !['a', 'b'].includes(label) || !owner ||
    JSON.parse(fs.readFileSync(path.join(root, '.arlo-owner.json'))).owner !== owner) {
  throw new Error('Acceptance ownership is unavailable');
}
const directory = path.join(root, label);
const shippedMod = path.resolve(import.meta.dirname, '../../packages/adapter-claudecode/mod');
const privateMod = path.join(directory, 'work/production-mod');
fs.cpSync(shippedMod, privateMod, { recursive: true,
  filter: file => !path.relative(shippedMod, file).split(path.sep).includes('types') });
function modInventory(base) {
  const entries = [];
  const visit = relative => {
    const location = path.join(base, relative);
    if (!fs.lstatSync(location).isDirectory() || fs.lstatSync(location).isSymbolicLink()) {
      throw new Error('ACCEPTANCE_MOD_COPY_UNSAFE');
    }
    for (const entry of fs.readdirSync(location, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // Claude generates this editor configuration on first load; the shipped
      // Mod's .gitignore already identifies it as local editor support.
      if (entry.name === 'types' || relative === '' && entry.name === 'tsconfig.json') continue;
      const next = path.join(relative, entry.name);
      const file = path.join(base, next);
      if (entry.isDirectory()) visit(next);
      else if (entry.isFile() && !entry.isSymbolicLink()) {
        entries.push([next.split(path.sep).join('/'), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
      } else throw new Error('ACCEPTANCE_MOD_COPY_UNSAFE');
    }
  };
  visit('');
  return { count: entries.length, sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
const initialShippedMod = modInventory(shippedMod);
const initialPrivateMod = modInventory(privateMod);
const modSeal = { schemaVersion: 1, algorithm: 'sha256',
  excludes: ['types directory', 'generated root tsconfig.json (local editor support)'], initialShippedSha256: initialShippedMod.sha256,
  initialPrivateSha256: initialPrivateMod.sha256, initialFileCount: initialPrivateMod.count,
  initialExactCopy: initialShippedMod.sha256 === initialPrivateMod.sha256 && initialShippedMod.count === initialPrivateMod.count };
fs.writeFileSync(path.join(directory, 'mod-copy.json'), JSON.stringify(modSeal), { mode: 0o600 });
if (!modSeal.initialExactCopy) throw new Error('ACCEPTANCE_MOD_COPY_MISMATCH');
// The existing embedding seam only redirects the shipped Mod to an exact private
// copy, allowing a real hot reload without editing shared repository sources.
const processes = [];
const spawnOwned = (command, args, options) => {
  const child = spawn(command, args.map((arg, index) =>
    args[index - 1] === '--plugin-dir' && arg === shippedMod ? privateMod : arg), options);
  const role = args[0] === '--version' ? 'version' : command === process.execPath ? 'sidecar' : 'host';
  const record = value => {
    if (processes.length >= 64) return;
    processes.push({ at: Date.now(), role, pid: child.pid, ...value });
    write('processes.json', processes);
  };
  child.once('spawn', () => record({ event: 'spawn' }));
  child.once('error', error => record({ event: 'error',
    code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? error.code : 'CHILD_PROCESS_ERROR' }));
  child.once('exit', (code, signal) => record({ event: 'exit', code, signal }));
  return child;
};
const sessionId = process.env.ARLO_ACCEPTANCE_SESSION_ID;
const observerToken = randomBytes(32).toString('hex');
let eventCount = 0;
let killOnMarker = false;
let previousRecovery;
const observer = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/observe' ||
      request.headers.authorization !== `Bearer ${observerToken}`) {
    response.writeHead(403).end(); return;
  }
  let body = '';
  for await (const part of request) {
    body += part;
    if (body.length > 8192) { response.writeHead(413).end(); return; }
  }
  try {
    const event = JSON.parse(body);
    const allowed = ['type', 'sessionId', 'turnId', 'agentId', 'reason', 'markers', 'userPromptTags', 'tool',
      'toolUseId', 'to', 'replyTo', 'denied', 'status', 'messageId', 'busyWork',
      'agents', 'teammateId', 'parentAgentId', 'isTeammate', 'background', 'subagentType', 'name',
      'agentTranscriptReadable', 'transcriptArloCallCount', 'transcriptArloDeniedCount', 'toolErrorCode',
      'command', 'originKind', 'commandArgumentsEmpty', 'outputObserved', 'mode', 'remaining', 'nextGrant',
      'pauseReason', 'authorizationCode', 'authorizationSucceeded', 'crossHostEnabled', 'textAvailable', 'stage', 'code'];
    if (!event || typeof event.type !== 'string' || Object.keys(event).some(key => !allowed.includes(key))) throw new Error();
    if (++eventCount > 2000) throw new Error();
    fs.appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ at: Date.now(), ...event }) + '\n', { mode: 0o600 });
    if (killOnMarker && event.type === 'turn.start' && event.markers?.length) {
      killOnMarker = false;
      previousRecovery = readBridgeBootstrap(handle.bridgeBootstrapPath);
      const interruptedSidecar = handle.sidecarProcess;
      const interruptedExit = new Promise(resolve => interruptedSidecar.once('exit', resolve));
      interruptedSidecar.kill('SIGKILL');
      // Fault at the real host's handoff boundary, before the production Mod's
      // claim hook runs. No input/receipt/ledger record is synthesized.
      await interruptedExit;
      write('fault.json', { type: 'sidecar-killed-before-claim', marker: event.markers[0], hostPid: handle.claudeProcess.pid });
    }
    response.writeHead(204).end();
  } catch { response.writeHead(400).end(); }
});
await new Promise(resolve => observer.listen(0, '127.0.0.1', resolve));
let handle;
let stopping = false;
let timer;
const write = (name, value) => {
  const file = path.join(directory, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
};
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await handle?.stop();
  await new Promise(resolve => observer.close(resolve));
  let finalExactCopy = false;
  try {
    const finalShippedMod = modInventory(shippedMod);
    const finalPrivateMod = modInventory(privateMod);
    finalExactCopy = finalPrivateMod.sha256 === initialPrivateMod.sha256 &&
      finalShippedMod.sha256 === initialShippedMod.sha256 &&
      finalPrivateMod.count === initialPrivateMod.count && finalShippedMod.count === initialShippedMod.count;
    Object.assign(modSeal, { finalShippedSha256: finalShippedMod.sha256, finalPrivateSha256: finalPrivateMod.sha256,
      finalFileCount: finalPrivateMod.count, finalExactCopy });
  } catch { modSeal.finalExactCopy = false; modSeal.inventoryFailed = true; }
  write('mod-copy.json', modSeal);
  if (!finalExactCopy) process.exitCode = 1;
  write('stopped.json', { hostExit: handle?.claudeProcess.exitCode, sidecarExit: handle?.sidecarProcess.exitCode,
    productionModExactCopy: modSeal.initialExactCopy && finalExactCopy,
    productionModSha256: modSeal.initialPrivateSha256, productionModFileCount: modSeal.initialFileCount,
    modSeal, processes });
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
try {
  handle = await launchClaudeCodeWithSidecar({
    sessionId, stateDir: path.join(root, 'state'), cwd: path.join(directory, 'work'),
    spawnFn: spawnOwned,
    groupName: 'issue105-' + owner, timeoutMs: 120000,
    claudeCommand: process.env.ARLO_ACCEPTANCE_CLAUDE || 'claude',
    env: {
      CLAUDE_CONFIG_DIR: path.join(directory, 'config'),
      XDG_CONFIG_HOME: path.join(directory, 'xdg-config'),
      XDG_DATA_HOME: path.join(directory, 'xdg-data'),
      XDG_CACHE_HOME: path.join(directory, 'xdg-cache'),
      ARLO_ACCEPTANCE_OBSERVER_URL: `http://127.0.0.1:${observer.address().port}/observe`,
      ARLO_ACCEPTANCE_OBSERVER_TOKEN: observerToken,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    },
    claudeArgs: ['--setting-sources', 'user', '--effort', 'low', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--permission-mode', 'dontAsk', '--tools', 'Read,Bash,Agent,TeamCreate,TeamDelete,SendMessage',
      '--allowedTools', 'Read,Bash(sleep *),Agent,TeamCreate,TeamDelete,SendMessage',
      '--plugin-dir', path.join(import.meta.dirname, 'witness-mod'),
      '--append-system-prompt', 'This is an isolated Arlo acceptance workspace. Never modify settings or access credentials. Answer incoming arithmetic questions in your local assistant response using the exact response label requested in that message, followed by the computed answer, and include the received correlation marker verbatim. Use arlo_send_message only when a direct human request explicitly asks you to send. Use the full endpoint ID provided.'],
  });
  const publish = async () => {
    const material = readBridgeBootstrap(handle.bridgeBootstrapPath);
    let status;
    if (material.status === 'active') {
      status = await fetch(material.url + '/api/v1/bridge/status', {
        headers: { Authorization: 'Bearer ' + material.token, 'x-session-id': material.sessionId },
        signal: AbortSignal.timeout(2000),
      }).then(response => response.json());
    }
    write('live.json', { hostPid: handle.claudeProcess.pid, hostExit: handle.claudeProcess.exitCode,
      sidecarPid: handle.sidecarProcess.pid, sessionId: status?.sessionId ?? material.sessionId,
      instanceId: status?.instanceId, generation: status?.generation, status: status?.status ?? material.status });
    if (previousRecovery && material.status === 'active' && material.instanceId !== previousRecovery.instanceId &&
        handle.sidecarProcess.exitCode === null && status?.generation > 0) {
      const staleToken = await fetch(material.url + '/api/v1/bridge/status', {
        headers: { Authorization: 'Bearer ' + previousRecovery.token, 'x-session-id': material.sessionId },
      });
      const staleInstance = await fetch(material.url + '/api/v1/bridge/messages/pending', {
        headers: { Authorization: 'Bearer ' + material.token, 'x-session-id': material.sessionId,
          'x-bridge-instance': previousRecovery.instanceId, 'x-bridge-generation': '1' },
      });
      write('recovery.json', { staleTokenStatus: staleToken.status, staleInstanceStatus: staleInstance.status,
        newSidecarPid: handle.sidecarProcess.pid, instanceId: material.instanceId });
      previousRecovery = undefined;
    }
  };
  await publish();
  let busy = false;
  timer = setInterval(async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      const actionFile = path.join(directory, 'action.json');
      if (fs.existsSync(actionFile)) {
        const action = JSON.parse(fs.readFileSync(actionFile)); fs.unlinkSync(actionFile);
        if (action.type === 'stop') { await stop(); return; }
        if (action.type === 'kill-sidecar') {
          previousRecovery = readBridgeBootstrap(handle.bridgeBootstrapPath);
          const interruptedSidecar = handle.sidecarProcess;
          const interruptedExit = new Promise(resolve => interruptedSidecar.once('exit', resolve));
          const killedAt = Date.now();
          interruptedSidecar.kill('SIGKILL');
          await interruptedExit;
          write('queued-fault.json', { killedAt, exitedAt: Date.now(), hostPid: handle.claudeProcess.pid });
        }
        else if (action.type === 'kill-on-marker') { killOnMarker = true; write('armed.json', { armed: true }); }
        else if (action.type === 'probe-stale-attachment') {
          const material = readBridgeBootstrap(handle.bridgeBootstrapPath);
          const result = await fetch(material.url + '/api/v1/bridge/messages/pending', {
            headers: { Authorization: 'Bearer ' + material.token, 'x-session-id': action.sessionId,
              'x-bridge-instance': action.instanceId, 'x-bridge-generation': String(action.generation) },
            signal: AbortSignal.timeout(2000),
          });
          await result.arrayBuffer();
          write('stale-attachment.json', { sessionId: action.sessionId, instanceId: action.instanceId,
            generation: action.generation, status: result.status });
        }
        else throw new Error('Unsupported acceptance action');
      }
      if (handle.claudeProcess.exitCode !== null) { await stop(); return; }
      await publish();
    } catch { write('diagnostic.json', { code: 'ACCEPTANCE_OBSERVATION_UNAVAILABLE' }); }
    finally { busy = false; }
  }, 200);
} catch (error) {
  const phase = /waiting for (Sidecar readiness|Claude Code startup|Claude Code version probe|the Mod to attach and register its root)/.exec(error.message ?? '')?.[1];
  write('failure.json', { code: 'ACCEPTANCE_ROOT_STARTUP_FAILED',
    ...(phase ? { phase } : {}),
    ...(/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? { causeCode: error.code } : {}) });
  await stop();
  process.exitCode = 1;
}
