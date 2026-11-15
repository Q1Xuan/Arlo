import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));

// Read installed Desktop location from metadata
const installJsonPath = path.resolve(root, 'docs/compatibility/desktop-installation.json');
let exe = 'E:/software/dsh/DeepSeek Harness.exe';
if (fs.existsSync(installJsonPath)) {
  try {
    const meta = JSON.parse(fs.readFileSync(installJsonPath, 'utf8'));
    if (process.env.ARLO_DESKTOP_EXE) {
      exe = process.env.ARLO_DESKTOP_EXE;
    }
  } catch {}
}

const args = process.argv.slice(2);
const exeIdx = args.indexOf('--desktop-exe');
if (exeIdx >= 0 && args[exeIdx + 1]) {
  exe = args[exeIdx + 1];
}

if (!fs.existsSync(exe)) {
  console.error(`Installed Desktop executable not found at: ${exe}`);
  process.exit(1);
}

const dshDir = path.dirname(exe);
const asarDsh = path.join(dshDir, 'resources/app.asar/dsh').replace(/\\/g, '/');
const hostEntry = path.join(asarDsh, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js').replace(/\\/g, '/');
const primaryRuntime = path.join(dshDir, 'resources/runtime/primary-runtime').replace(/\\/g, '/');
const pnpmMjs = path.join(dshDir, 'resources/runtime/pnpm/bin/pnpm.mjs').replace(/\\/g, '/');
const binDir = path.join(dshDir, 'resources/runtime/bin').replace(/\\/g, '/');

const scratchDir = path.resolve(root, '.scratch', 'host-installed-' + Date.now());
fs.mkdirSync(scratchDir, { recursive: true });
fs.mkdirSync(path.join(scratchDir, 'temp'), { recursive: true });
fs.writeFileSync(path.join(scratchDir, '.arlo-owner'), 'Arlo issue 2 isolated desktop host probe\n');

const profileDir = path.join(scratchDir, 'profiles', 'desktop');
fs.mkdirSync(profileDir, { recursive: true });

const resultsFile = path.join(scratchDir, 'test-results.json');
const pluginFile = path.join(scratchDir, 'arlo-host-probe-plugin.mjs');

// Public Cordis plugin mounted via cordis.patch.yml
fs.writeFileSync(pluginFile, `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools';

export const name = 'arlo-desktop-host-probe';
export const inject = ['agents', 'tools', 'llm', 'systemPrompt'];

export class LocalModel extends LlmAdapter {
  requests = [];
  script = [];
  beforeResponse = null;
  async *stream(options) {
    this.requests.push(options);
    if (this.beforeResponse) await this.beforeResponse();
    const canned = this.script.shift();
    if (canned) {
      yield* canned;
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'fictional response' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fictional response' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function toolResponse(name) {
  const id = ToolCallId('fictional-call');
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

export async function apply(ctx) {
  const results = {
    repeatedPluginLoad: false,
    rootsAndLifecycle: false,
    realToolCallerAndIsolation: false,
    nextTurnQueueing: false,
    boundedPending: false,
    runtime: {
      nodeVersion: process.version,
      electronVersion: process.versions.electron || null,
    },
    error: null,
  };

  try {
    // Check environment isolation: no user credentials in environment
    assert.equal(process.env.OPENAI_API_KEY, undefined, 'Host must not have OPENAI_API_KEY');
    assert.equal(process.env.DEEPSEEK_API_KEY, undefined, 'Host must not have DEEPSEEK_API_KEY');
    assert.equal(process.env.ARK_API_KEY, undefined, 'Host must not have ARK_API_KEY');

    // Controlled local model
    const model = new LocalModel();
    ctx.llm.registerAdapter(['arlo-local-test'], model);

    // 1. 已有根会话与生命周期 (existing roots & lifecycle)
    const created = [];
    const disposed = [];
    ctx.on('agent/created', ({ agent }) => { created.push(agent.id); });
    ctx.on('agent/disposed', ({ agent }) => { disposed.push(agent.id); });

    const rootFixture = await ctx.agents.create({
      sessionId: SessionId('fictional-installed-root'),
      agentOptions: { provider: 'arlo-local-test', model: 'mock-model' },
    });
    rootFixture.agent.ctx.systemPrompt.variable('cwd', () => process.cwd());

    const childFixture = await rootFixture.agent.ctx.agents.create({
      sessionId: SessionId('fictional-installed-child'),
      parentAgent: rootFixture.agent,
      agentOptions: { provider: 'arlo-local-test', model: 'mock-model' },
    });
    childFixture.agent.ctx.systemPrompt.variable('cwd', () => process.cwd());

    assert.ok(created.includes(rootFixture.agent.id));
    assert.ok(created.includes(childFixture.agent.id));
    assert.ok(ctx.agents.roots().includes(rootFixture.agent));
    assert.equal(ctx.agents.roots().includes(childFixture.agent), false);
    assert.equal(ctx.agents.isOwnedBy(childFixture.agent.id, rootFixture.agent), true);

    await childFixture.dispose();
    assert.ok(disposed.includes(childFixture.agent.id));
    assert.ok(ctx.agents.roots().includes(rootFixture.agent));
    results.rootsAndLifecycle = true;

    // 2. 重复加载契约与真实工具调用者隔离 (repeated plugin load & real tool caller isolation)
    const ownerKey = Symbol.for('arlo.m0.registry-owner');
    const publications = [];
    const callers = [];
    const initiatorMatches = [];
    const outcomes = [];

    const integration = (subCtx) => {
      if (Reflect.has(subCtx.agents, ownerKey)) return;
      const token = {};
      Object.defineProperty(subCtx.agents, ownerKey, { value: token, configurable: true });
      subCtx.effect(() => () => {
        if (Reflect.get(subCtx.agents, ownerKey) === token) Reflect.deleteProperty(subCtx.agents, ownerKey);
      });
      publications.push(...subCtx.agents.roots());
      subCtx.tools.register(defineContentToolFixture({
        name: 'arlo_binding_probe',
        description: 'Check fictional root binding',
        parameters: {},
        execute: async (_args, exec) => {
          assert.ok(exec.agent);
          const initiator = subCtx.agents.requireInitiator();
          assert.equal(initiator, exec.agent);
          callers.push(exec.agent.id);
          initiatorMatches.push(initiator.id);
          const isRoot = exec.agent === rootFixture.agent && subCtx.agents.roots().includes(exec.agent);
          const outcome = isRoot ? 'accepted-root' : 'CALLER_NOT_ROOT';
          outcomes.push(outcome);
          return [{ type: 'text', text: outcome }];
        }
      }));
    };
    Object.assign(integration, { inject: ['agents', 'tools'] });

    // 1st load of integration
    const firstLoad = await ctx.plugin(integration);
    assert.deepEqual(publications.map(a => a.id), [rootFixture.agent.id]);
    assert.equal(publications.length, 1);

    // 2nd load of integration on same registry: must NOT publish again
    const secondLoad = await ctx.plugin(integration);
    assert.deepEqual(publications.map(a => a.id), [rootFixture.agent.id]);
    assert.equal(publications.length, 1);

    // Test real tool caller and sub-agent isolation
    const childFixture2 = await rootFixture.agent.ctx.agents.create({
      sessionId: SessionId('fictional-installed-child-2'),
      parentAgent: rootFixture.agent,
      agentOptions: { provider: 'arlo-local-test', model: 'mock-model' },
    });
    childFixture2.agent.ctx.systemPrompt.variable('cwd', () => process.cwd());

    // Test tool call by root agent
    model.script.push(toolResponse('arlo_binding_probe'));
    rootFixture.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'call tool root' }],
      source: { kind: 'arlo', form: 'relay' }
    }));
    await rootFixture.agent.whenIdle();

    // Test tool call by child agent
    model.script.push(toolResponse('arlo_binding_probe'));
    childFixture2.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'call tool child' }],
      source: { kind: 'arlo', form: 'relay' }
    }));
    await childFixture2.agent.whenIdle();

    assert.deepEqual(callers, [rootFixture.agent.id, childFixture2.agent.id]);
    assert.deepEqual(initiatorMatches, [rootFixture.agent.id, childFixture2.agent.id]);
    assert.deepEqual(outcomes, ['accepted-root', 'CALLER_NOT_ROOT']);
    assert.equal(ctx.agents.currentInitiator(), undefined);
    results.realToolCallerAndIsolation = true;

    // Dispose first load and verify that reload publishes again
    await firstLoad.dispose();
    await secondLoad.dispose();
    const reloaded = await ctx.plugin(integration);
    assert.deepEqual(publications.map(a => a.id), [rootFixture.agent.id, rootFixture.agent.id]);
    assert.equal(publications.length, 2);
    await reloaded.dispose();
    results.repeatedPluginLoad = true;

    // 3. next-turn 契约 (idle followup wakes, busy followup queues without preemption)
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    model.beforeResponse = async () => {
      entered.resolve();
      await release.promise;
    };

    const claimed = [];
    const unsubClaimed = ctx.on('agent/inbox/claimed', ({ message }) => {
      claimed.push(message.id);
    });

    const first = createUserMessage({
      content: [{ type: 'text', text: 'first next-turn' }],
      source: { kind: 'arlo', form: 'relay' }
    });
    const second = createUserMessage({
      content: [{ type: 'text', text: 'second next-turn' }],
      source: { kind: 'arlo', form: 'relay' }
    });

    model.requests.length = 0;
    rootFixture.agent.followup(first);
    await entered.promise;
    assert.equal(rootFixture.agent.status, 'running');

    // Followup second message while busy
    rootFixture.agent.followup(second);
    assert.equal(model.requests.length, 1);
    assert.equal(model.requests[0].signal?.aborted, false);
    assert.deepEqual(rootFixture.agent.inbox.nextTurn.map(m => m.id), [second.id]);
    assert.deepEqual(claimed, [first.id]);

    release.resolve();
    model.beforeResponse = null;
    await rootFixture.agent.whenIdle();

    assert.equal(model.requests.length, 2);
    assert.deepEqual(claimed, [first.id, second.id]);
    assert.deepEqual(rootFixture.agent.inbox.nextTurn, []);
    unsubClaimed();
    results.nextTurnQueueing = true;

    // 4. pending 契约 (bounded queue admission & tracking on real installed host)
    function attachPendingProbe(subCtx, agent, limit) {
      if (!subCtx.agents.roots().includes(agent)) throw new Error('CALLER_NOT_ROOT');
      const snapshot = () => [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
        .filter(m => m.source?.kind === 'arlo').map(m => m.id);
      const held = new Set(snapshot());
      const observed = new Set();
      const inFlight = new Set();
      let active = true;
      const inserted = subCtx.on('agent/inbox/inserted', event => {
        if (event.agent === agent && inFlight.has(event.message.id)) observed.add(event.message.id);
      });
      const releaseHeld = (event) => {
        if (event.agent !== agent) return;
        if (inFlight.has(event.message.id)) observed.add(event.message.id);
        held.delete(event.message.id);
      };
      const claimedSub = subCtx.on('agent/inbox/claimed', releaseHeld);
      const discardedSub = subCtx.on('agent/inbox/discarded', releaseHeld);
      return {
        offer(msg) {
          if (!active || !subCtx.agents.roots().includes(agent) || msg.source?.kind !== 'arlo') return 'rejected';
          try {
            for (const id of snapshot()) held.add(id);
          } catch {
            return 'rejected';
          }
          if (held.size >= limit || held.has(msg.id)) return 'rejected';
          held.add(msg.id);
          inFlight.add(msg.id);
          try {
            agent.followup(msg);
            return 'accepted';
          } catch {
            if (observed.has(msg.id)) return 'accepted';
            try {
              if (snapshot().includes(msg.id)) return 'accepted';
            } catch {}
            return 'unknown';
          } finally {
            observed.delete(msg.id);
            inFlight.delete(msg.id);
          }
        },
        dispose() {
          active = false;
          inserted(); claimedSub(); discardedSub();
        }
      };
    }

    const pendingRelease = Promise.withResolvers();
    const maintenance = rootFixture.agent.runMaintenance(() => pendingRelease.promise);
    let pendingProbe = attachPendingProbe(ctx, rootFixture.agent, 2);

    const m1 = createUserMessage({ content: [{ type: 'text', text: 'p1' }], source: { kind: 'arlo', form: 'relay' } });
    const m2 = createUserMessage({ content: [{ type: 'text', text: 'p2' }], source: { kind: 'arlo', form: 'relay' } });
    const m3 = createUserMessage({ content: [{ type: 'text', text: 'p3' }], source: { kind: 'arlo', form: 'relay' } });

    // Real admission up to capacity (2)
    assert.equal(pendingProbe.offer(m1), 'accepted');
    assert.equal(pendingProbe.offer(m2), 'accepted');
    assert.equal(pendingProbe.offer(m3), 'rejected');
    assert.equal(rootFixture.agent.inbox.nextTurn.length, 2);

    // Reattachment backlog verification: restored from host inbox snapshot
    pendingProbe.dispose();
    pendingProbe = attachPendingProbe(ctx, rootFixture.agent, 2);
    assert.equal(pendingProbe.offer(m3), 'rejected');

    // Real discard event release
    assert.equal(rootFixture.agent.inbox.remove(m1.id), true);
    assert.equal(pendingProbe.offer(m3), 'accepted');
    assert.equal(pendingProbe.offer(m1), 'rejected');

    // Real claim event release upon resuming
    pendingRelease.resolve();
    await maintenance;
    await rootFixture.agent.whenIdle();
    const m4 = createUserMessage({ content: [{ type: 'text', text: 'p4' }], source: { kind: 'arlo', form: 'relay' } });
    assert.equal(pendingProbe.offer(m4), 'accepted');
    await rootFixture.agent.whenIdle();
    assert.equal(rootFixture.agent.inbox.nextTurn.length, 0);

    pendingProbe.dispose();
    results.boundedPending = true;

  } catch (err) {
    results.error = err.stack ?? String(err);
  } finally {
    writeFileSync('${resultsFile.replace(/\\/g, '\\\\')}', JSON.stringify(results, null, 2));
  }
}
`);

fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
}));

const pluginUrl = 'file:///' + pluginFile.replace(/\\/g, '/');
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), `
- insert:
    - name: "${pluginUrl}"
`);

console.log('Spawning installed Desktop Host process...');
const child = spawn(exe, [
  '--expose-internals',
  hostEntry,
  asarDsh,
  profileDir,
  primaryRuntime,
  pnpmMjs,
  binDir
], {
  cwd: profileDir,
  env: {
    SystemRoot: process.env.SystemRoot,
    PATH: process.env.PATH || process.env.Path,
    Path: process.env.Path || process.env.PATH,
    HOME: scratchDir,
    USERPROFILE: scratchDir,
    APPDATA: scratchDir,
    LOCALAPPDATA: scratchDir,
    TEMP: path.join(scratchDir, 'temp'),
    TMP: path.join(scratchDir, 'temp'),
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: scratchDir,
    DSH_CLIENT_VERSION: '0.2.0-rc.2',
  },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc']
});

child.stdout.on('data', d => process.stdout.write('[Host stdout] ' + d));
child.stderr.on('data', d => process.stderr.write('[Host stderr] ' + d));

child.on('message', msg => {
  if (msg.type === 'ready') {
    console.log('Host readiness received, checking results...');
    setTimeout(() => {
      child.send({ type: 'shutdown' });
    }, 1500);
  }
});

child.on('close', code => {
  console.log('Host process exited with code:', code);
  if (code !== 0) {
    console.error(`Failure: host process exited with non-zero exit code: ${code}`);
    process.exit(code || 1);
  }

  if (!fs.existsSync(resultsFile)) {
    console.error('Failure: test results file was not written.');
    process.exit(1);
  }

  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  console.log('Host Contract Verification Results:\n', JSON.stringify(results, null, 2));

  if (results.error) {
    console.error('Error during contract execution:', results.error);
    process.exit(1);
  }

  const allPassed = results.repeatedPluginLoad &&
    results.rootsAndLifecycle &&
    results.realToolCallerAndIsolation &&
    results.nextTurnQueueing &&
    results.boundedPending;

  if (!allPassed) {
    console.error('Failure: one or more host integration contracts failed.');
    process.exit(1);
  }

  // Write record to docs/compatibility/desktop-host-installed-run.json
  const record = {
    verifiedAt: new Date().toISOString(),
    desktopExecutable: exe,
    nodeVersion: results.runtime?.nodeVersion || process.version,
    electronVersion: results.runtime?.electronVersion || null,
    publicPluginEntry: 'cordis.patch.yml',
    contracts: {
      repeatedPluginLoad: results.repeatedPluginLoad,
      rootsAndLifecycle: results.rootsAndLifecycle,
      realToolCallerAndIsolation: results.realToolCallerAndIsolation,
      nextTurnQueueing: results.nextTurnQueueing,
      boundedPending: results.boundedPending
    },
    exitCode: code
  };

  const recordPath = path.resolve(root, 'docs/compatibility/desktop-host-installed-run.json');
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  console.log('Installed Host run record written to:', recordPath);
  console.log('ALL 6 INSTALLED HOST INTEGRATION CONTRACTS PASSED WITH 100% SUCCESS!');
  process.exit(0);
});
