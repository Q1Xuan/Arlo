import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// This worker is opt-in and may only touch the acceptance runner's private root.
const rootValue = process.env.ARLO_ACCEPTANCE_ROOT;
const owner = process.env.ARLO_ACCEPTANCE_OWNER;
let root;
try {
  if (!rootValue || !path.isAbsolute(rootValue) || !owner) throw new Error();
  root = path.resolve(rootValue);
  const markerPath = path.join(root, '.arlo-owner.json');
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink() ||
      !fs.lstatSync(markerPath).isFile() || fs.lstatSync(markerPath).isSymbolicLink()) throw new Error();
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker.owner !== owner || marker.purpose !== 'issue105-real-acceptance') throw new Error();
} catch {
  throw new Error('ACCEPTANCE_RESOURCE_OWNERSHIP_REQUIRED');
}
process.umask(0o077);

const { ArloDaemon } = await import('@arlo/daemon/server');
const { DaemonClient, assertSafeStatePath } = await import('@arlo/sdk');
assertSafeStatePath(root);
const stateDir = path.join(root, 'state');
const daemon = new ArloDaemon({ stateDir });
const client = new DaemonClient({ stateDir });
const limit = 256;
const observation = {
  publicQueries: ['DaemonClient.getStatus()', 'DaemonClient.listRoots()'],
  readOnlyInstrumentation: [
    'ArloDaemon.endpoints: rootSessionId, pendingMessagesCount, pendingBytes',
    'ArloDaemon.messageExchange.messages: dispatch identity, reception status, pendingCredit, reply association, bounded receipt metadata',
  ],
  rationale: 'Public diagnostics omit rootSessionId and the per-message pending-credit ledger. This worker reads those live in-process fields without calling admission, authorization, receipt, release, or model tools.',
  intervalMs: 100,
  maxEndpoints: limit,
  maxMessages: limit,
};
let interval;
let sampling;
let stopping;
let snapshot;
let started = false;
let startup;

function assertOwnedRoot() {
  const marker = path.join(root, '.arlo-owner.json');
  if (!fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink() ||
      JSON.parse(fs.readFileSync(marker, 'utf8')).owner !== owner) {
    throw new Error('ACCEPTANCE_RESOURCE_OWNERSHIP_REQUIRED');
  }
  assertSafeStatePath(root);
}

// IDs are bounded opaque metadata. No arbitrary text, paths, tokens, certificates,
// or keys are included, even if a future runtime record gains more properties.
function id(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(value) ? value : null;
}
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function code(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : undefined;
}
async function publish(value) {
  assertOwnedRoot();
  const target = path.join(root, 'daemon.json');
  const temporary = path.join(root, `.daemon-${process.pid}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    const deadline = performance.now() + 3000;
    while (true) {
      try {
        fs.renameSync(temporary, target);
        break;
      } catch (error) {
        // Windows CRT readers can briefly deny replacement of the old file.
        // Yield so the real Daemon keeps serving while that reader closes;
        // persistent access errors still fail this bounded observation.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) ||
            performance.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
        assertOwnedRoot();
      }
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  snapshot = value;
}
function ipc(message) {
  if (process.connected) process.send(message, () => {});
}

async function sample() {
  const [health, roots] = await Promise.all([client.getStatus(), client.listRoots()]);
  if (health.daemon_id !== daemon.daemonId || health.pid !== process.pid) {
    throw new Error('ACCEPTANCE_DAEMON_IDENTITY_CHANGED');
  }
  // TypeScript private fields remain ordinary JS properties. This is acceptance
  // instrumentation only; it neither invokes MessageExchange.status() (which can
  // evict records) nor adds a production diagnostic/API surface.
  const liveEndpoints = daemon.endpoints;
  const liveMessages = daemon.messageExchange.messages;
  if (!(liveEndpoints instanceof Map) || !(liveMessages instanceof Map)) {
    throw new Error('ACCEPTANCE_OBSERVER_BOUNDARY_CHANGED');
  }
  const endpoints = roots.slice(0, limit).map(row => {
    const live = liveEndpoints.get(row.endpoint_id);
    return {
      endpointId: id(row.endpoint_id), sessionId: id(live?.rootSessionId),
      status: row.status === 'registered' ? 'registered' : 'revoked',
      ready: row.ready === true, deliverable: row.deliverable === true,
      generation: count(row.generation),
      pendingMessagesCount: count(live?.pendingMessagesCount), pendingBytes: count(live?.pendingBytes),
    };
  });
  const messages = [...liveMessages.values()].slice(-limit).map(row => ({
    messageId: id(row.messageId), deliveryId: id(row.deliveryId),
    fromEndpoint: id(row.fromEndpoint), toEndpoint: id(row.toEndpoint),
    targetGeneration: count(row.targetGeneration), deliverySeq: id(row.deliverySeq),
    status: row.conflict ? 'receipt_conflict' :
      ['in_flight', 'accepted', 'rejected', 'unknown'].includes(row.status) ? row.status : 'unknown',
    holdsPendingCredit: row.pendingCredit === true,
    replyTo: id(row.replyTo), nativeMessageId: id(row.nativeMessageId),
    lateEvidence: row.lateEvidence === true,
    ...(code(row.reason) ? { reason: code(row.reason) } : {}),
    ...(row.returnedOutcome && ['accepted', 'rejected', 'unknown'].includes(row.returnedOutcome.status)
      ? { originalStatus: row.returnedOutcome.status } : {}),
  }));
  await publish({
    schemaVersion: 1, observedAt: new Date().toISOString(), daemonId: health.daemon_id,
    pid: health.pid, status: health.status, endpoints, messages,
    endpointsTruncated: roots.length > limit, messagesTruncated: liveMessages.size > limit,
    observation,
  });
}

function requestSample() {
  if (stopping || sampling) return sampling;
  // Windows TerminateProcess cannot deliver Node's SIGTERM handler. The owned
  // driver requests graceful shutdown through a private, owner-checked file.
  const stopFile = path.join(root, 'daemon-stop.json');
  if (fs.existsSync(stopFile)) {
    assertOwnedRoot();
    if (JSON.parse(fs.readFileSync(stopFile, 'utf8')).owner !== owner) {
      throw new Error('ACCEPTANCE_RESOURCE_OWNERSHIP_REQUIRED');
    }
    fs.unlinkSync(stopFile);
    return stop();
  }
  sampling = sample().finally(() => { sampling = undefined; });
  return sampling;
}
function stop() {
  return stopping ??= (async () => {
    clearInterval(interval);
    await sampling?.catch(() => {});
    await startup?.catch(() => {});
    await daemon.stop();
    if (snapshot) await publish({ ...snapshot, observedAt: new Date().toISOString(), status: 'stopped' });
    ipc({ type: 'stopped', daemonId: daemon.daemonId, pid: process.pid });
    if (process.connected) process.disconnect();
  })();
}
function fail() {
  process.exitCode = 1;
  ipc({ type: 'error', code: 'ACCEPTANCE_DAEMON_OBSERVER_FAILED', pid: process.pid });
  void stop().catch(() => {
    if (process.connected) process.disconnect();
  });
}

process.on('message', message => {
  if (message?.type === 'shutdown') void stop().catch(fail);
});
process.once('SIGINT', () => { void stop().catch(fail); });
process.once('SIGTERM', () => { void stop().catch(fail); });
process.once('disconnect', () => { void stop().catch(fail); });

try {
  startup = daemon.start();
  await startup;
  started = true;
  if (stopping) await daemon.stop();
  else {
    await requestSample();
    ipc({ type: 'ready', daemonId: daemon.daemonId, pid: process.pid });
    interval = setInterval(() => { void requestSample()?.catch(fail); }, 100);
  }
} catch {
  if (!started) ipc({ type: 'error', code: 'ACCEPTANCE_DAEMON_START_FAILED', pid: process.pid });
  fail();
}
