// Opt-in real Pi TUI / persisted DSH runtime. No simulated model or SDK sender.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

process.umask(0o077);
const root = process.env.ARLO_ACCEPTANCE_ROOT;
const label = process.env.ARLO_ACCEPTANCE_LABEL;
const owner = process.env.ARLO_ACCEPTANCE_OWNER;
if (!root || !['b', 'c'].includes(label) || !owner || fs.lstatSync(root).isSymbolicLink() ||
    JSON.parse(fs.readFileSync(path.join(root, '.arlo-owner.json'))).owner !== owner) {
  throw new Error('ACCEPTANCE_RESOURCE_OWNERSHIP_REQUIRED');
}
const directory = path.join(root, label);
const config = path.join(directory, 'config');
const write = (name, data) => {
  const file = path.join(directory, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
};
const log = (type, data = {}) => fs.appendFileSync(path.join(directory, 'native.private.jsonl'),
  JSON.stringify({ at: Date.now(), type, ...data }) + '\n', { mode: 0o600 });
const repo = path.resolve(import.meta.dirname, '../..');
const stateDir = path.join(root, 'state');
const groupName = 'issue105-' + owner;
let stopping;
let stopHost;
let timer;
let startupPhase = 'host-imports';
function stop() {
  return stopping ??= (async () => {
    clearInterval(timer);
    await stopHost?.();
    write('stopped.json', { stopped: true });
  })();
}
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
timer = setInterval(() => {
  const file = path.join(directory, 'action.json');
  if (!fs.existsSync(file)) return;
  const action = JSON.parse(fs.readFileSync(file));
  fs.unlinkSync(file);
  if (action.type === 'stop') void stop();
}, 100);

try {
  if (label === 'b') {
    const piEntry = fs.realpathSync(path.join(repo, 'packages/adapter-pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js'));
    const piCli = path.join(path.dirname(piEntry), 'bundle/cli.js');
    const models = process.env.ARLO_ACCEPTANCE_PI_MODELS || path.join(os.homedir(), '.pi/agent/models.json');
    fs.copyFileSync(models, path.join(config, 'models.json'));
    fs.chmodSync(path.join(config, 'models.json'), 0o600);
    fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark',
      cacheWarming: 'off', showTerminalProgress: false, compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } } }));
    const child = spawn(process.execPath, [piCli, '--offline', '--no-approve', '--no-context-files',
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-builtin-tools',
      '--extension', path.join(import.meta.dirname, 'pi-witness.mjs'), '--model',
      process.env.ARLO_ACCEPTANCE_PI_MODEL || 'dots/dots3-note-prev', '--thinking', 'off',
      '--session-id', process.env.ARLO_ACCEPTANCE_SESSION_ID], {
      cwd: path.join(directory, 'work'), stdio: 'inherit',
      env: { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: '1', PI_TELEMETRY: 'false' },
    });
    let exited = false;
    const exit = new Promise(resolve => child.once('exit', code => { exited = true; resolve(code); }));
    stopHost = async () => {
      if (!exited) child.kill('SIGTERM');
      write('host-exit.json', { code: await exit });
    };
    void exit.then(() => stop());
  } else {
    const { Context } = await import('@deepseek-ai/cordis');
    const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent');
    const { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop');
    const { default: LlmRuntime, createUserMessage } = await import('@deepseek-ai/dsh-llm');
    const { default: SessionStore, SessionId } = await import('@deepseek-ai/dsh-session');
    const { default: Projection } = await import('@deepseek-ai/dsh-session-projection');
    const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
    const { default: Tools } = await import('@deepseek-ai/dsh-tools');
    const { default: Persistence } = await import('@deepseek-ai/dsh-session-persistence-jsonl');
    const { createArloHarnessPlugin } = await import('../../packages/adapter-dsh/src/runtime.ts');
    const store = path.join(repo, 'node_modules/.pnpm');
    // pnpm shortens Windows virtual-store names, sometimes omitting the
    // version entirely. Validate the installed manifest rather than its path.
    const candidates = fs.readdirSync(store).filter(name => name.startsWith('@deepseek-ai+dsh-llm-pi-ai@'))
      .filter(name => {
        const manifest = JSON.parse(fs.readFileSync(path.join(store, name, 'node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json')));
        return manifest.name === '@deepseek-ai/dsh-llm-pi-ai' && manifest.version === '0.2.0-rc.2';
      });
    if (candidates.length !== 1) throw new Error('ACCEPTANCE_PROVIDER_INSTALLATION_AMBIGUOUS');
    const provider = await import(pathToFileURL(path.join(store, candidates[0], 'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js')).href);
    startupPhase = 'authorized-provider-profile';
    const models = JSON.parse(fs.readFileSync(process.env.ARLO_ACCEPTANCE_PI_MODELS || path.join(os.homedir(), '.pi/agent/models.json')));
    const modelPath = process.env.ARLO_ACCEPTANCE_PI_MODEL || 'dots/dots3-note-prev';
    const [route, ...parts] = modelPath.split('/');
    const model = parts.join('/');
    const profile = models.providers[route];
    if (!profile || !profile.models.some(row => row.id === model) || typeof profile.apiKey !== 'string' || profile.apiKey.startsWith('!')) {
      throw new Error('ACCEPTANCE_AUTHORIZED_PROVIDER_REQUIRED');
    }
    // Credential is consumed privately by the official DSH provider. It never
    // appears in an event, process argument or report.
    process.env.ARLO_CROSS_HOST_API_KEY = profile.apiKey;
    const ctx = new Context();
    stopHost = () => ctx.fiber.dispose();
    startupPhase = 'host-plugins';
    for (const plugin of [LlmRuntime, SessionStore]) await ctx.plugin(plugin);
    await ctx.plugin(Persistence, { root: path.join(directory, 'sessions') });
    for (const plugin of [Projection, SystemPrompt, Tools, AgentRegistry]) await ctx.plugin(plugin);
    await ctx.plugin(AgentLoop, { agents: [] });
    startupPhase = 'provider-plugin';
    const modelTimeoutMs = Number(process.env.ARLO_ACCEPTANCE_MODEL_TIMEOUT_MS || 600000);
    if (!Number.isInteger(modelTimeoutMs) || modelTimeoutMs < 1000 || modelTimeoutMs > 3600000) {
      throw new Error('ACCEPTANCE_MODEL_TIMEOUT_INVALID');
    }
    await ctx.plugin(provider, { providers: { [route]: { api: profile.api, baseURL: profile.baseUrl,
      apiKeyEnv: 'ARLO_CROSS_HOST_API_KEY', models: profile.models.map(row => ({ ...row, maxTokens: Math.min(row.maxTokens || 4096, 4096) })),
      timeoutMs: modelTimeoutMs, streamIdleTimeoutMs: modelTimeoutMs } } });
    const adapter = createArloHarnessPlugin({ stateDir, groupName, settingsPath: path.join(config, 'arlo.json'), autoStart: false });
    startupPhase = 'production-adapter';
    await ctx.plugin(adapter);
    ctx.on('session/event', (_session, event) => log('native', { event }));
    ctx.on('agent/inbox/claimed', ({ message }) => log('claimed', { message }));
    startupPhase = 'native-root-create';
    const handle = await ctx.agents.create({ sessionId: SessionId(process.env.ARLO_ACCEPTANCE_SESSION_ID),
      meta: { cwd: path.join(directory, 'work') }, agentOptions: { provider: route, model } });
    const agent = handle.agent;
    write('live.json', { sessionId: String(agent.session.id), status: 'active', hostKind: 'deepseek-harness',
      provider: route, model, interface: 'public DSH runtime; stdin human commands, no browser' });
    const input = readline.createInterface({ input: process.stdin });
    const pending = [];
    let processing = false;
    async function consume() {
      if (processing || stopping) return;
      processing = true;
      try {
        while (pending.length && !stopping) {
          const line = pending.shift();
          if (line.startsWith('/')) {
            const [name, value] = line.trim().split(/\s+/);
            let result;
            if (name === '/arlo-settings') result = await adapter.participation(agent, value === undefined ? undefined : value === 'on');
            else if (name === '/arlo-continue') result = await adapter.continueCollaboration(agent);
            else if (name === '/arlo-send-status') result = await adapter.getRootSendingStatus(agent);
            else throw new Error('ACCEPTANCE_UNSUPPORTED_HUMAN_COMMAND');
            log('command', { name, result });
          } else {
            agent.followup(createUserMessage({ content: [{ type: 'text', text: line }], source: { kind: 'user' } }));
            await agent.whenIdle();
            log('settled');
          }
        }
      } catch { log('driver-error', { code: 'ACCEPTANCE_DSH_HUMAN_INPUT_FAILED' }); process.exitCode = 1; }
      finally { processing = false; }
    }
    input.on('line', line => { if (line.trim()) { pending.push(line); void consume(); } });
    const dispose = stopHost;
    stopHost = async () => { input.close(); await dispose(); delete process.env.ARLO_CROSS_HOST_API_KEY; };
  }
} catch (error) {
  log('driver-error', { code: 'ACCEPTANCE_PEER_START_FAILED', errorName: error.name,
    startupPhase, failureCode: /^ACCEPTANCE_[A-Z_]{1,80}$/.test(error.message || '') ? error.message : null,
    errorCode: /^[A-Z_]{1,80}$/.test(error.code || '') ? error.code : null });
  process.exitCode = 1;
  await stop();
}
