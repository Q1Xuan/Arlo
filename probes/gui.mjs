import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { extractHostAndUrl, isLoopback } from './gui-network-guard.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

let exe = 'E:/software/dsh/DeepSeek Harness.exe';
const installJsonPath = path.resolve(root, 'docs/compatibility/desktop-installation.json');
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

const scratchDir = path.resolve(root, '.scratch', 'gui-test-' + Date.now());
fs.mkdirSync(scratchDir, { recursive: true });
fs.mkdirSync(path.join(scratchDir, 'temp'), { recursive: true });
fs.writeFileSync(path.join(scratchDir, '.arlo-owner'), 'Arlo issue 2 isolated desktop GUI probe\n');

const profileDir = path.join(scratchDir, 'profiles', 'desktop');
fs.mkdirSync(profileDir, { recursive: true });

// Process tracking - ONLY kill processes spawned by this test
const spawnedChildren = new Set();
function registerChild(child) {
  spawnedChildren.add(child);
  child.on('exit', () => spawnedChildren.delete(child));
}

function killSpawned(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {}
}

function cleanupAll() {
  for (const child of spawnedChildren) {
    killSpawned(child);
  }
  spawnedChildren.clear();
}

process.on('exit', cleanupAll);
process.on('SIGINT', () => { cleanupAll(); process.exit(130); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(143); });
process.on('uncaughtException', (err) => {
  cleanupAll();
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Clean independent test package.json - does NOT copy from user profiles
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
}));

fs.writeFileSync(path.join(profileDir, 'cordis.yml'), '[]\n');

const hostEvidenceFile = path.join(scratchDir, 'host-isolation-evidence.json');
const phase1HostEvidenceFile = path.join(scratchDir, 'host-isolation-evidence-phase1.json');
const phase2HostEvidenceFile = path.join(scratchDir, 'host-isolation-evidence-phase2.json');

// Copy independent network guard plugin to scratchDir
const guardPluginFile = path.join(scratchDir, 'arlo-network-guard-plugin.mjs');
fs.copyFileSync(path.resolve(root, 'probes/gui-network-guard.mjs'), guardPluginFile);
const guardPluginUrl = 'file:///' + guardPluginFile.replace(/\\/g, '/');

// Create message display probe plugin (independent of network guard)
const displayPluginFile = path.join(scratchDir, 'arlo-display-probe-plugin.mjs');
fs.writeFileSync(displayPluginFile, `
import assert from 'node:assert/strict';
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';

export const name = 'arlo-display-probe-plugin';
export const inject = ['agents', 'llm'];

export class LocalModel extends LlmAdapter {
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'Controlled local response to Arlo message' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Controlled local response to Arlo message' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export async function apply(ctx) {
  const model = new LocalModel();
  ctx.llm.registerAdapter(['arlo-local-test'], model);

  ctx.on('agent/created', async ({ agent }) => {
    try {
      agent.ctx.systemPrompt.variable('cwd', () => process.cwd());
    } catch {}

    const msg = createUserMessage({
      content: [{ type: 'text', text: 'Arlo External Message Verification Probe' }],
      source: { kind: 'arlo', form: 'relay' },
    });
    agent.followup(msg);
  });
}
`);
const displayPluginUrl = 'file:///' + displayPluginFile.replace(/\\/g, '/');

// Base independent test patch: explicitly configures local controlled model and disables telemetry
const baseTestPatch = `
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: arlo-local-test
    model: mock-model
- id: ui-settings-account
  name: "@deepseek-ai/dsh-client-ui-settings-account"
  config:
    version: 1
    step: done
    purpose: development
    process: standard
    completion: completed
    usage: detailed
    developerTools: true
- id: desktop-product-telemetry
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: session-log-deepseek
  disabled: true
  config:
    enabled: false
`;

// Phase 1 has BOTH the network guard plugin AND the display probe plugin
const phase1Patch = baseTestPatch + `
- insert:
    - name: "${guardPluginUrl}"
    - name: "${displayPluginUrl}"
`;

// Phase 2 keeps network guard plugin active, but UNINSTALLS display probe plugin
const phase2Patch = baseTestPatch + `
- insert:
    - name: "${guardPluginUrl}"
`;

function getIsolatedEnv(evidenceFile) {
  return {
    SystemRoot: process.env.SystemRoot,
    PATH: process.env.PATH || process.env.Path,
    Path: process.env.Path || process.env.PATH,
    HOME: scratchDir,
    USERPROFILE: scratchDir,
    APPDATA: scratchDir,
    LOCALAPPDATA: scratchDir,
    TEMP: path.join(scratchDir, 'temp'),
    TMP: path.join(scratchDir, 'temp'),
    DSH_HOME: scratchDir,
    DSH_CLIENT_VERSION: '0.2.0-rc.2',
    OTEL_SDK_DISABLED: 'true',
    DSH_TELEMETRY: 'false',
    DSH_TELEMETRY_DISABLED: 'true',
    DSH_TELEMETRY_MODE: 'OFF',
    ARLO_HOST_EVIDENCE_FILE: evidenceFile,
  };
}

async function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function connectToCdp(port) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find(t => t.url?.includes('dsh-app://app') || t.title?.includes('DeepSeek'));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let rpcId = 1;
        const pending = new Map();
        const monitoredRequests = [];
        const externalViolations = [];

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
          if (msg.method === 'Network.requestWillBeSent') {
            const reqUrl = msg.params?.request?.url;
            if (reqUrl) {
              monitoredRequests.push(reqUrl);
              const isInternalScheme = /^(dsh-app|file|devtools|chrome-extension|data|blob):/i.test(reqUrl);
              const info = extractHostAndUrl([reqUrl], 'fetch');
              if (!isInternalScheme && (!info.valid || !isLoopback(info.host))) {
                console.log('[Renderer external violation detected]', reqUrl);
                externalViolations.push({
                  url: reqUrl,
                  host: info.host || 'UNRECOGNIZED_TARGET',
                  method: msg.params?.request?.method,
                  time: new Date().toISOString()
                });
              }
            }
          }
        };

        const sendCdp = (method, params = {}) => new Promise((resolve) => {
          const id = ++rpcId;
          pending.set(id, resolve);
          ws.send(JSON.stringify({ id, method, params }));
        });

        await sendCdp('Runtime.enable');
        await sendCdp('Page.enable');
        await sendCdp('Network.enable');

        return { ws, sendCdp, page, monitoredRequests, externalViolations };
      }
    } catch {}
  }
  throw new Error(`Failed to connect to CDP page on port ${port}`);
}

async function main() {
  console.log('=== Step 3: Desktop Renderer Display Verification (Isolated) ===\n');

  // --- Phase 1: Plugin Mounted ---
  console.log('Phase 1: Starting Desktop with Arlo probe plugin and network guard mounted...');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), phase1Patch);

  const child1 = spawn(exe, [
    '--remote-debugging-port=9335',
    '--user-data-dir=' + path.join(scratchDir, 'user-data'),
    '--no-sandbox',
  ], {
    env: getIsolatedEnv(phase1HostEvidenceFile),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  registerChild(child1);

  let child1PrematureExit = null;
  let child1ExpectedStop = false;
  child1.on('exit', (code, signal) => {
    if (!child1ExpectedStop && code !== 0 && code !== null) {
      child1PrematureExit = { code, signal };
      console.error(`child1 exited prematurely with code ${code}, signal ${signal}`);
    }
  });

  const { ws: ws1, sendCdp: sendCdp1, monitoredRequests: reqs1, externalViolations: ext1 } = await connectToCdp(9335);
  console.log('CDP connected to Desktop Renderer. Waiting for editor...');

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(r => setTimeout(r, 1000));
    const evalRes = await sendCdp1('Runtime.evaluate', {
      expression: '!!document.querySelector(".RlGAzG_input, [data-composer-input=\\"true\\"]")',
      returnByValue: true
    });
    if (evalRes.result?.result?.value === true) break;
  }

  console.log('Composer ready. Sending prompt to trigger agent and Arlo relay...');
  await sendCdp1('Runtime.evaluate', {
    expression: `(() => {
      const editor = document.querySelector('.RlGAzG_input, [data-composer-input="true"]');
      if (editor) { editor.focus(); return true; }
      return false;
    })()`
  });
  await new Promise(r => setTimeout(r, 2000));
  await sendCdp1('Input.insertText', { text: 'Probe trigger turn' });
  await new Promise(r => setTimeout(r, 1000));
  await sendCdp1('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sendCdp1('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await new Promise(r => setTimeout(r, 500));

  // If text remains in editor, trigger send via click
  await sendCdp1('Runtime.evaluate', {
    expression: `(() => {
      const editor = document.querySelector('.RlGAzG_input, [data-composer-input="true"]');
      if (editor && editor.innerText?.trim()) {
        const btns = Array.from(document.querySelectorAll('button'));
        const sendBtn = btns.find(b => b.querySelector('svg') && !b.disabled && (b.className?.includes('send') || b.getAttribute('aria-label')?.includes('发') || b.closest('.composer, [data-composer], footer')));
        if (sendBtn) {
          sendBtn.click();
          return true;
        }
      }
      return false;
    })()`
  });

  let phase1Found = false;
  let phase1Details = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const evalRes = await sendCdp1('Runtime.evaluate', {
      expression: `
        (() => {
          const turnTrigger = document.querySelector('[data-turn-trigger="true"]');
          if (turnTrigger) {
            const btn = turnTrigger.querySelector('button');
            if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
          }
          const bodyText = document.body ? document.body.innerText : '';
          const hasArlo = bodyText.includes('Arlo External Message Verification Probe');
          const arloNode = Array.from(document.querySelectorAll('*')).find(el => el.textContent?.includes('Arlo External Message Verification Probe') && el.children.length === 0);
          const userBubble = arloNode ? arloNode.closest('[data-chat-flow-kind="user"], .chat-bubble-user') : null;
          const systemBubble = arloNode ? arloNode.closest('[data-chat-flow-kind="system"], .chat-bubble-system') : null;
          const turnTriggerParent = arloNode ? arloNode.closest('[data-turn-trigger="true"]') : null;
          return {
            hasArlo,
            hasTurnTrigger: !!turnTrigger,
            turnTriggerHeader: turnTrigger ? turnTrigger.querySelector('button')?.innerText : null,
            arloInUserBubble: !!userBubble,
            arloInSystemBubble: !!systemBubble,
            arloInTurnTrigger: !!turnTriggerParent,
            turnTriggerExpandedText: turnTrigger ? turnTrigger.innerText : null
          };
        })()
      `,
      returnByValue: true
    });
    const res = evalRes.result?.result?.value;
    if (res?.hasTurnTrigger && res?.hasArlo) {
      phase1Found = true;
      phase1Details = res;
      break;
    }
  }

  assert.ok(phase1Found, 'Phase 1: Arlo message must be rendered inside TurnTriggerNodeView');
  assert.equal(phase1Details.arloInUserBubble, false, 'Phase 1: Arlo message must not be rendered in a human user bubble');
  assert.equal(phase1Details.arloInSystemBubble, false, 'Phase 1: Arlo message must not be rendered in a system bubble');
  assert.equal(phase1Details.arloInTurnTrigger, true, 'Phase 1: Arlo message must be wrapped in TurnTriggerNodeView');

  console.log('Phase 1 assertion passed. Capturing screenshot...');
  try { await sendCdp1('Page.bringToFront'); } catch {}
  await new Promise(r => setTimeout(r, 500));
  const ss1 = await sendCdp1('Page.captureScreenshot', { format: 'png' });
  const buf1 = Buffer.from(ss1.result.data, 'base64');
  const ss1Path = path.resolve(root, 'docs/compatibility/desktop-arlo-display.png');
  fs.writeFileSync(ss1Path, buf1);
  console.log(`Saved: ${ss1Path} (${buf1.length} bytes)`);

  // Phase 1 network validation
  if (child1PrematureExit) {
    throw new Error(`Phase 1 host child exited unexpectedly with code ${child1PrematureExit.code}`);
  }
  assert.equal(ext1.length, 0, 'Phase 1 Renderer: zero unexpected external requests');

  assert.ok(fs.existsSync(phase1HostEvidenceFile), 'Phase 1 host isolation evidence must be written');
  const phase1HostEvidence = JSON.parse(fs.readFileSync(phase1HostEvidenceFile, 'utf8'));
  assert.equal(phase1HostEvidence.negativeControlProven, true, 'Phase 1 negative control must be proven');
  assert.equal(phase1HostEvidence.noUserCredentials, true, 'Phase 1 no user credentials in host');
  assert.equal(phase1HostEvidence.unexpectedExternalCallsCount, 0, 'Phase 1 zero unexpected external calls in host');

  child1ExpectedStop = true;
  ws1.close();
  killSpawned(child1);
  await new Promise(r => setTimeout(r, 2000));

  const phase1HostEvidencePost = JSON.parse(fs.readFileSync(phase1HostEvidenceFile, 'utf8'));
  assert.equal(phase1HostEvidencePost.unexpectedExternalCallsCount, 0, 'Phase 1 host post-exit evidence must remain zero');

  // --- Phase 2: Plugin Uninstalled ---
  console.log('\nPhase 2: Uninstalling display plugin from cordis.patch.yml (keeping network guard active) and re-reading history...');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), phase2Patch);

  const child2 = spawn(exe, [
    '--remote-debugging-port=9335',
    '--user-data-dir=' + path.join(scratchDir, 'user-data'),
    '--no-sandbox',
  ], {
    env: getIsolatedEnv(phase2HostEvidenceFile),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  registerChild(child2);

  let child2PrematureExit = null;
  let child2ExpectedStop = false;
  child2.on('exit', (code, signal) => {
    if (!child2ExpectedStop && code !== 0 && code !== null) {
      child2PrematureExit = { code, signal };
      console.error(`child2 exited prematurely with code ${code}, signal ${signal}`);
    }
  });

  const { ws: ws2, sendCdp: sendCdp2, monitoredRequests: reqs2, externalViolations: ext2 } = await connectToCdp(9335);
  console.log('CDP connected to uninstalled instance. Verifying history...');

  let phase2Found = false;
  let phase2Details = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const evalRes = await sendCdp2('Runtime.evaluate', {
      expression: `
        (() => {
          let turnTrigger = document.querySelector('[data-turn-trigger="true"]');
          if (!turnTrigger) {
            const sidebarItem = Array.from(document.querySelectorAll('*')).find(el =>
              el.textContent?.includes('Probe trigger turn') &&
              (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button' || el.className?.includes('item') || el.className?.includes('session'))
            );
            if (sidebarItem) sidebarItem.click();
            turnTrigger = document.querySelector('[data-turn-trigger="true"]');
          }
          if (turnTrigger) {
            const btn = turnTrigger.querySelector('button');
            if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
          }
          const bodyText = document.body ? document.body.innerText : '';
          const hasArlo = bodyText.includes('Arlo External Message Verification Probe');
          const arloNode = Array.from(document.querySelectorAll('*')).find(el => el.textContent?.includes('Arlo External Message Verification Probe') && el.children.length === 0);
          const userBubble = arloNode ? arloNode.closest('[data-chat-flow-kind="user"], .chat-bubble-user') : null;
          const systemBubble = arloNode ? arloNode.closest('[data-chat-flow-kind="system"], .chat-bubble-system') : null;
          const turnTriggerParent = arloNode ? arloNode.closest('[data-turn-trigger="true"]') : null;
          return {
            hasArlo,
            hasTurnTrigger: !!turnTrigger,
            turnTriggerHeader: turnTrigger ? turnTrigger.querySelector('button')?.innerText : null,
            arloInUserBubble: !!userBubble,
            arloInSystemBubble: !!systemBubble,
            arloInTurnTrigger: !!turnTriggerParent,
            turnTriggerExpandedText: turnTrigger ? turnTrigger.innerText : null
          };
        })()
      `,
      returnByValue: true
    });
    const res = evalRes.result?.result?.value;
    if (res?.hasTurnTrigger && res?.hasArlo) {
      phase2Found = true;
      phase2Details = res;
      break;
    }
  }

  assert.ok(phase2Found, 'Phase 2: Historical Arlo message must safely render inside TurnTriggerNodeView without plugin');
  assert.equal(phase2Details.arloInUserBubble, false, 'Phase 2: Historical Arlo message must not be rendered in a human user bubble');
  assert.equal(phase2Details.arloInSystemBubble, false, 'Phase 2: Historical Arlo message must not be rendered in a system bubble');
  assert.equal(phase2Details.arloInTurnTrigger, true, 'Phase 2: Historical Arlo message must be wrapped in TurnTriggerNodeView');

  console.log('Phase 2 assertion passed. Capturing uninstalled history screenshot...');
  try { await sendCdp2('Page.bringToFront'); } catch {}
  await new Promise(r => setTimeout(r, 500));
  const ss2 = await sendCdp2('Page.captureScreenshot', { format: 'png' });
  const buf2 = Buffer.from(ss2.result.data, 'base64');
  const ss2Path = path.resolve(root, 'docs/compatibility/desktop-arlo-display-uninstalled.png');
  fs.writeFileSync(ss2Path, buf2);
  console.log(`Saved: ${ss2Path} (${buf2.length} bytes)`);

  // Phase 2 network validation
  if (child2PrematureExit) {
    throw new Error(`Phase 2 host child exited unexpectedly with code ${child2PrematureExit.code}`);
  }
  assert.equal(ext2.length, 0, 'Phase 2 Renderer: zero unexpected external requests');

  assert.ok(fs.existsSync(phase2HostEvidenceFile), 'Phase 2 host isolation evidence must be written');
  const phase2HostEvidence = JSON.parse(fs.readFileSync(phase2HostEvidenceFile, 'utf8'));
  assert.equal(phase2HostEvidence.negativeControlProven, true, 'Phase 2 negative control must be proven');
  assert.equal(phase2HostEvidence.noUserCredentials, true, 'Phase 2 no user credentials in host');
  assert.equal(phase2HostEvidence.unexpectedExternalCallsCount, 0, 'Phase 2 zero unexpected external calls in host');

  child2ExpectedStop = true;
  ws2.close();
  killSpawned(child2);
  await new Promise(r => setTimeout(r, 2000));

  const phase2HostEvidencePost = JSON.parse(fs.readFileSync(phase2HostEvidenceFile, 'utf8'));
  assert.equal(phase2HostEvidencePost.unexpectedExternalCallsCount, 0, 'Phase 2 host post-exit evidence must remain zero');

  // Combined host isolation evidence
  const combinedHostEvidence = {
    negativeControlProven: phase1HostEvidencePost.negativeControlProven && phase2HostEvidencePost.negativeControlProven,
    noUserCredentials: phase1HostEvidencePost.noUserCredentials && phase2HostEvidencePost.noUserCredentials,
    phase1HostExternalRequestsCount: phase1HostEvidencePost.unexpectedExternalCallsCount,
    phase2HostExternalRequestsCount: phase2HostEvidencePost.unexpectedExternalCallsCount,
    unexpectedExternalCallsCount: phase1HostEvidencePost.unexpectedExternalCallsCount + phase2HostEvidencePost.unexpectedExternalCallsCount,
    unexpectedExternalCalls: [
      ...phase1HostEvidencePost.unexpectedExternalCalls,
      ...phase2HostEvidencePost.unexpectedExternalCalls
    ]
  };
  fs.writeFileSync(hostEvidenceFile, JSON.stringify(combinedHostEvidence, null, 2) + '\n');

  const evidence = {
    verifiedAt: new Date().toISOString(),
    desktopExecutable: exe,
    installedHostVerified: true,
    isolation: {
      independentTestProfile: true,
      controlledLocalModelOnly: true,
      noUserCredentialsInherited: true,
      externalRequestDeniedProven: true,
      phase1HostExternalRequestsCount: phase1HostEvidencePost.unexpectedExternalCallsCount,
      phase2HostExternalRequestsCount: phase2HostEvidencePost.unexpectedExternalCallsCount,
      hostExternalRequestsCount: combinedHostEvidence.unexpectedExternalCallsCount,
      phase1RendererRequestsMonitored: reqs1.length,
      phase1RendererExternalRequestsCount: ext1.length,
      phase2RendererRequestsMonitored: reqs2.length,
      phase2RendererExternalRequestsCount: ext2.length,
      rendererExternalRequestsCount: ext1.length + ext2.length,
      rendererNetworkMonitored: true,
      externalNetworkCoverage: 'both_phases_host_and_renderer'
    },
    phase1PluginPresent: {
      renderedAsTurnTrigger: phase1Details.hasTurnTrigger && phase1Details.arloInTurnTrigger,
      turnTriggerHeader: phase1Details.turnTriggerHeader,
      notHumanUserBubble: !phase1Details.arloInUserBubble,
      notSystemBubble: !phase1Details.arloInSystemBubble,
      screenshot: 'desktop-arlo-display.png',
      screenshotBytes: buf1.length
    },
    phase2PluginUninstalled: {
      safeHistoryRead: true,
      renderedAsTurnTrigger: phase2Details.hasTurnTrigger && phase2Details.arloInTurnTrigger,
      turnTriggerHeader: phase2Details.turnTriggerHeader,
      notHumanUserBubble: !phase2Details.arloInUserBubble,
      notSystemBubble: !phase2Details.arloInSystemBubble,
      screenshot: 'desktop-arlo-display-uninstalled.png',
      screenshotBytes: buf2.length
    },
    exitCode: 0
  };

  const evidencePath = path.resolve(root, 'docs/compatibility/display-evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Display verification evidence recorded at: ${evidencePath}`);
  console.log('\nALL DESKTOP DISPLAY AND NETWORK CONTRACTS FULLY VERIFIED (Exit code 0)!');
  process.exit(0);
}

main().catch(err => {
  console.error('Desktop GUI Display verification failed:', err);
  process.exit(1);
});
