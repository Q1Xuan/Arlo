import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createPinnedHttpsAgent, sendSecureArloRequest, readDiscoveryRecord, DaemonClient } from '@arlo/sdk';
import { LogEventCode, MAX_LOG_FILE_SIZE } from '../packages/daemon/src/logging/index.ts';
import { acceptanceProcess } from './fixtures/acceptance-process.ts';
import { createTempDir, removeTempDir } from './test-utils.ts';

for (const debug of [false, true]) test(`Two real Harnesses keep normal, limit, protocol and host-fault logs private (DEBUG=${debug})`, { timeout: 150000 }, async () => {
  const stateDir = createTempDir('audit-state');
  const profiles = ['daemon', 'sender', 'receiver'].map(name => createTempDir(`audit-${name}`));
  const env = debug ? { DEBUG: '*' } : {};
  const daemon = acceptanceProcess('./harness-audit-daemon.ts', profiles[0], stateDir, env);
  const workers: ReturnType<typeof acceptanceProcess>[] = [];
  let agent: ReturnType<typeof createPinnedHttpsAgent> | undefined;
  try {
    await daemon.ready;
    workers.push(...profiles.slice(1).map(profile => acceptanceProcess('./harness-worker.ts', profile, stateDir, env)));
    await Promise.all(workers.map(worker => worker.ready));
    const [a, b] = workers;
    assert.equal(new Set([daemon.pid, a.pid, b.pid, process.pid]).size, 4);
    const tool = async (name: string, args: object) => {
      const response = await a.request({ action: 'tool', name, args });
      const text = response.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
      return response.isError ? { error: text } : JSON.parse(text);
    };
    const target = (await tool('arlo_list_sessions', {}))[0].endpoint_id;
    const canary = 'audit-body-credential-path-canary';
    const send = (text = canary) => tool('arlo_send_message', { to: target, text });
    await b.request({ action: 'hold' });
    assert.equal((await send()).status, 'accepted');
    assert.equal((await b.request({ action: 'snapshot' })).pending.length, 1);
    await b.request({ action: 'fault', mode: 'before-insertion' });
    assert.equal((await send()).status, 'unknown');
    assert.equal((await b.request({ action: 'snapshot' })).pending.length, 1);
    await b.request({ action: 'fault', mode: 'after-insertion' });
    assert.equal((await send()).status, 'unknown');
    assert.equal((await b.request({ action: 'snapshot' })).pending.length, 2);
    await b.request({ action: 'fault', mode: 'wrong-group' });
    assert.equal((await send()).status, 'rejected');
    assert.equal((await b.request({ action: 'snapshot' })).pending.length, 2);
    await b.request({ action: 'fault', mode: 'none' });
    assert.match(JSON.stringify(await send()), /RATE_LIMITED/);
    assert.match(JSON.stringify(await send(canary.repeat(2000))), /MESSAGE_TOO_LARGE/);
    await b.request({ action: 'release' });
    const discovery = readDiscoveryRecord(stateDir);
    const token = fs.readFileSync(path.join(stateDir, 'bootstrap.token'), 'utf8').trim();
    const secrets = [canary, token, stateDir, ...profiles, 'host-exception-secret-canary', 'host-before-insertion-secret-canary',
      fs.readFileSync(path.join(stateDir, 'daemon.key'), 'utf8')];
    agent = createPinnedHttpsAgent(discovery.cert_pem);
    const url = `https://127.0.0.1:${discovery.port}/control/v1/runtimes/register`;
    assert.equal((await sendSecureArloRequest({ url, agent, token: canary, body: '{}' })).status, 401);
    assert.equal((await sendSecureArloRequest({ url, agent, token, body: `{${canary}` })).status, 500);
    await assert.rejects(sendSecureArloRequest({ url, agent, token, body: canary.repeat(10000) }));
    const client = new DaemonClient({ stateDir });
    await client.getStatus();
    const logPath = path.join(stateDir, 'daemon.log');
    const before = fs.readFileSync(logPath, 'utf8');
    const entries = before.trim().split('\n').map(line => JSON.parse(line));
    for (const event of ['ROOT_SENDING_STATUS_QUERIED', 'COLLABORATION_CONTINUED', 'MESSAGE_DISPATCHED',
      'RECEIPT_RECORDED', 'CREDIT_RELEASED', 'SEND_RATE_LIMITED', 'AUTH_FAILURE', 'ERROR_OCCURRED']) {
      assert.ok(entries.some(entry => entry.event === event), `Exercised path must produce ${event}`);
    }
    // Seed only the size boundary; the production logger rotates the actual fault history.
    assert.equal((await daemon.request({ action: 'seed-rotation' })).seeded, true);
    await client.getStatus();
    await Promise.all(workers.map(worker => worker.stop({ action: 'stop' })));
    await daemon.stop();
    const logs = fs.readdirSync(stateDir).filter(name => /^daemon(?:\.\d)?\.log$/.test(name));
    assert.ok(logs.includes('daemon.1.log'), 'Fault history must survive real logger rotation');
    assert.ok(logs.length <= 3);
    const fields = new Set(['time', 'event', 'daemon_id', 'request_id', 'status', 'bytes', 'duration_ms']);
    const events = new Set<string>(Object.values(LogEventCode));
    for (const name of logs) {
      const file = path.join(stateDir, name);
      assert.ok(fs.statSync(file).size <= MAX_LOG_FILE_SIZE);
      const text = fs.readFileSync(file, 'utf8');
      for (const secret of secrets) assert.equal(text.includes(secret), false, 'No body, credential, path or host exception in audit logs');
      for (const entry of text.trim().split('\n').map(line => JSON.parse(line))) {
        assert.ok(Object.keys(entry).every(key => fields.has(key)));
        assert.ok(events.has(entry.event));
        assert.equal(entry.daemon_id, discovery.daemon_id);
        assert.ok(['ok', 'error', 'rejected'].includes(entry.status));
        assert.ok(Number.isFinite(entry.bytes) && entry.bytes >= 0);
        assert.ok(Number.isFinite(entry.duration_ms) && entry.duration_ms >= 0);
        assert.ok(Number.isFinite(Date.parse(entry.time)));
        if (entry.request_id) assert.match(entry.request_id, /^[0-9a-f-]{36}$/);
      }
    }
    for (const worker of [daemon, ...workers]) for (const secret of secrets) assert.equal(worker.output().includes(secret), false);
  } finally {
    agent?.destroy();
    const stopped = await Promise.allSettled([...workers.map(worker => worker.stop({ action: 'stop' })), daemon.stop()]);
    try {
      for (const profile of profiles) removeTempDir(profile);
    } finally { removeTempDir(stateDir); }
    const failures = stopped.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Acceptance process shutdown failed');
  }
});
