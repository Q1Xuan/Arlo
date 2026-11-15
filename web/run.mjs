import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';

const repo = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const consumer = path.resolve(option('--consumer', '.artifacts/issue36-web/consumer'));
const output = path.resolve(option('--output', `.scratch/web-${process.platform}.json`));
const fixtureSource = path.resolve(option('--fixture', path.join(consumer, 'web/fixture.mjs')));
const configuredModel = args.includes('--new-session-model') ? JSON.parse(option('--new-session-model')) : undefined;
const expectModelUnavailable = args.includes('--expect-model-unavailable');
const modelFault = option('--model-fault');
const multiContact = args.includes('--multi-contact');
const contactRendering = args.includes('--contact-rendering');
const contactReadinessCancel = args.includes('--contact-readiness-cancel');
const contactReadiness = args.includes('--contact-readiness') || contactReadinessCancel;
const pluginUnload = args.includes('--plugin-unload');
const roundTrip = args.includes('--round-trip');
const crossHost = args.includes('--cross-host');
const cliSetup = args.includes('--cli-setup');
const cliRecovery = args.includes('--cli-recovery');
if (cliRecovery) assert.ok(cliSetup && process.platform === 'linux', 'The native permission-failure recovery scenario requires Linux CLI setup');
const setupCli = path.resolve(option('--setup-cli', path.join(consumer, 'node_modules/@arlo/daemon/bin/arlo.js')));
const setupCommands = [];
const experimentalCompatibility = args.includes('--experimental');
const appIcons = option('--app-icons');
assert.ok(appIcons === undefined || ['extracted', 'missing'].includes(appIcons), '--app-icons must be extracted or missing');
if (appIcons) assert.equal(process.platform, 'linux', 'The controlled desktop-icon scenarios require Linux');
const require = createRequire(path.join(consumer, 'package.json'));
// Load the same delivered SDK as the Host, including on runtimes that cannot
// execute the repository's TypeScript sources.
const { enforceWindowsAcl } = await import(pathToFileURL(require.resolve('@arlo/sdk')).href);
if (process.env.ARLO_PI_EXPECTED_NODE) assert.equal(process.version, process.env.ARLO_PI_EXPECTED_NODE,
  'Web acceptance driver Node differs from the selected candidate; this is a probe configuration failure');
const installedDelivery = await import(pathToFileURL(require.resolve('@arlo/adapter-dsh/delivery')).href);
const composition = installedDelivery.requireDshWebComposition(consumer, { experimental: experimentalCompatibility });
const { chromium } = require('playwright');
const clientEntry = require.resolve('@arlo/adapter-dsh/client');
const clientBytes = fs.readFileSync(clientEntry);
const clientSource = ts.createSourceFile(clientEntry, clientBytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
// Inspect executable syntax, so declaration-only JSDoc imports do not become
// false positives. This self-contained client delegates transport to ctx.remote.
const forbiddenClientSyntax = [];
function inspectClient(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier
    || ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && ['require', 'fetch', 'eval'].includes(node.expression.text)
        && !(['0.2.1-rc.2', '0.2.1-rc.5'].includes(composition.hostVersion) && node.expression.text === 'require'
          && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
          && ['react', '@deepseek-ai/dsh-client-ui-primitives'].includes(node.arguments[0].text)))
    || ts.isIdentifier(node) && ['process', 'Buffer', 'WebSocket', 'XMLHttpRequest', 'Worker'].includes(node.text)) {
    forbiddenClientSyntax.push(node.getText(clientSource));
  }
  ts.forEachChild(node, inspectClient);
}
inspectClient(clientSource);
assert.deepEqual(forbiddenClientSyntax, [], 'The installed browser entry must have no runtime imports, Node globals or direct transport');
const scratch = fs.mkdtempSync(path.join(os.homedir(), 'arlo-web-38-'));
enforceWindowsAcl(scratch, true);
if (process.platform !== 'win32') fs.chmodSync(scratch, 0o700);
const dirs = Object.fromEntries(['home', 'config', 'local', 'temp', 'project', 'state', 'logs'].map(name => {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  return [name, dir];
}));
fs.writeFileSync(path.join(scratch, '.arlo-owner.json'), JSON.stringify({ purpose: 'Issue 38 real DSH Web acceptance' }));
fs.writeFileSync(path.join(dirs.project, 'reference.txt'), 'ARLO_FILE_REFERENCE_CANARY\n');
const fixtureDirectory = path.join(scratch, 'fixture');
fs.mkdirSync(fixtureDirectory);
const fixtureModule = path.join(fixtureDirectory, 'fixture.mjs');
fs.copyFileSync(fixtureSource, fixtureModule);
fs.symlinkSync(path.join(consumer, 'node_modules'), path.join(fixtureDirectory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const profile = path.join(dirs.home, 'profiles', 'web');
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
enforceWindowsAcl(profile, true);
if (process.platform !== 'win32') fs.chmodSync(path.dirname(profile), 0o700);
fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
  name: 'arlo-web-acceptance-profile', private: true, type: 'module',
  ...(cliSetup ? { custom: { preserve: true } } : { dependencies: { '@arlo/adapter-dsh': '0.1.0' } }),
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}, null, 2));
const link = path.join(profile, 'node_modules', '@arlo', 'adapter-dsh');
if (!cliSetup) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(consumer, 'node_modules', '@arlo', 'adapter-dsh'), link, process.platform === 'win32' ? 'junction' : 'dir');
}
fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
const runSetup = (command, expectedExit = 0) => {
  const argv = [setupCli, command, '--host', 'dsh', '--target', path.join(consumer, 'node_modules/@deepseek-ai/dsh'),
    '--adapter', path.join(consumer, 'node_modules/@arlo/adapter-dsh'), '--profile', 'web', '--dsh-home', dirs.home,
    '--json', ...(command === 'setup-status' ? [] : ['--apply'])];
  const result = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 180_000, windowsHide: true });
  const entry = { argv, exitCode: result.status, signal: result.signal, report: JSON.parse(result.stdout), stderr: result.stderr };
  setupCommands.push(entry);
  fs.writeFileSync(path.join(dirs.logs, 'setup-commands.json'), JSON.stringify(setupCommands, null, 2));
  assert.equal(result.status, expectedExit, JSON.stringify(entry));
  return entry.report;
};
if (cliSetup) {
  if (cliRecovery) {
    const modules = path.join(profile, 'node_modules'); fs.mkdirSync(modules, { mode: 0o500 });
    try {
      assert.equal(runSetup('setup', 1).error, 'HOST_PACKAGE_OPERATION_FAILED');
      assert.equal(runSetup('setup-status').transaction, 'prepared');
    } finally { fs.chmodSync(modules, 0o700); }
    const profileFile = path.join(profile, 'package.json'); const current = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    current.custom.afterFailedSetup = true; fs.writeFileSync(profileFile, JSON.stringify(current));
  }
  assert.equal(runSetup('setup').phase, 'configured-pending-start-or-reload');
  assert.equal(runSetup('setup').phase, 'already-configured-pending-reload');
  assert.equal(runSetup('setup-status').runtime, 'unobserved');
}
let piRig, piPeer;
if (crossHost) {
  const { nativeScenario } = await import('../pi-acceptance/harness.mjs');
  piRig = await nativeScenario('cross-host');
  piPeer = await piRig.start('pi-cross-host', {}, cliSetup ? { setup: true } : {});
  await piPeer.ready();
}
// Same real profile and browser-loading route used by the DSH Web scaffold.
// All model requests go through the isolated LocalModel fixture.
const overlay = path.join(scratch, 'acceptance.patch.yml');
fs.writeFileSync(overlay, [
  ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'agent-instructions', 'hmr'].map(id => `- id: ${id}\n  disabled: true`),
  '- id: ui-plugin-manager\n  config:\n    registryProbeEnabled: false',
  ...(cliSetup ? [] : ['- insert:']),
  `${cliSetup ? '- id: arlo-contact\n  config:\n    ' : "    - id: arlo-contact\n      name: '@arlo/adapter-dsh'\n      config:\n        "}${cliSetup && crossHost ? '' : `groupName: ${piRig?.groupName ?? 'arlo-web-acceptance'}${cliSetup ? '\n    ' : '\n        '}`}stateDir: ${JSON.stringify(piRig?.stateDir ?? dirs.state)}${crossHost ? `${cliSetup ? '\n    ' : '\n        '}autoStart: false` : ''}${configuredModel ? `${cliSetup ? '\n    ' : '\n        '}newSessionModel: ${JSON.stringify(configuredModel)}` : ''}${experimentalCompatibility ? `${cliSetup ? '\n    ' : '\n        '}experimentalCompatibility: true` : ''}`,
  ...(cliSetup ? ['- insert:'] : []),
  `    - id: arlo-web-fixture\n      name: ${JSON.stringify(pathToFileURL(fixtureModule).href)}`,
].join('\n') + '\n');
const reportFile = path.join(dirs.logs, 'fixture.json');
const networkFile = path.join(dirs.logs, 'network.json');
const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, {
  HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.config, LOCALAPPDATA: dirs.local,
  XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.local, XDG_DATA_HOME: dirs.local,
  XDG_STATE_HOME: dirs.state, TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp,
  DSH_HOME: dirs.home, DSH_TELEMETRY_DISABLED: '1', PSExecutionPolicyPreference: 'Bypass',
  ARLO_WEB_FIXTURE_REPORT: reportFile, ARLO_LOW_LEVEL_NETWORK_FILE: networkFile,
  ...(cliSetup && crossHost ? { ARLO_WEB_WORKSPACE_DIR: piRig.directory } : {}),
  NODE_OPTIONS: `--import=${pathToFileURL(path.join(consumer, 'probes/isolation.mjs')).href}`,
});
let appIconFixture;
if (appIcons) {
  // Keep real PATH detection and the installed Host resolver. Control only the
  // desktop resource that extraction sees inside this run's private XDG home.
  const applications = path.join(dirs.local, 'applications');
  fs.mkdirSync(applications);
  const icon = path.join(dirs.local, 'cursor.png');
  if (appIcons === 'extracted') {
    const source = path.resolve(option('--app-icon-file', '/usr/share/pixmaps/co.anysphere.cursor.png'));
    fs.copyFileSync(source, icon);
    appIconFixture = { source, sha256: createHash('sha256').update(fs.readFileSync(icon)).digest('hex') };
  }
  fs.writeFileSync(path.join(applications, 'cursor.desktop'),
    `[Desktop Entry]\nType=Application\nName=Cursor\nExec=cursor\nIcon=${appIcons === 'extracted' ? icon : 'arlo-intentionally-unavailable-icon'}\n`);
  env.XDG_DATA_DIRS = dirs.local;
}
const report = {
  issue: crossHost ? 67 : contactRendering || contactReadiness ? 44 : multiContact ? 39 : 38, status: 'failed', startedAt: new Date().toISOString(), platform: process.platform,
  appIcons, appIconFixture, appIconResponses: [],
  configuredModel,
  cliSetup, cliRecovery, setupCommands,
  expectModelUnavailable,
  modelFault,
  node: process.version, osRelease: os.release(), scratch,
  composition,
  bundleManifestSha256: createHash('sha256').update(fs.readFileSync(path.join(consumer, '../manifest.json'))).digest('hex'),
  runnerSha256: createHash('sha256').update(fs.readFileSync(import.meta.filename)).digest('hex'),
  fixtureSha256: createHash('sha256').update(fs.readFileSync(fixtureSource)).digest('hex'),
  fixtureSource: args.includes('--fixture') ? fixtureSource : 'installed-consumer',
  checks: [], browserErrors: [], browserConsole: [], browserConsoleDetails: [], failedHttpRequests: [], externalBrowserRequests: [],
};
const child = spawn(process.execPath, [path.join(consumer, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
  'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'],
{ cwd: dirs.project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let boot = '';
child.stdout.on('data', chunk => { boot += chunk; });
child.stderr.on('data', chunk => { boot += chunk; });
let browser, page, fixture;
const pluginResponses = new Map();
let seedResponse;
function redactDiagnostics(text) {
  const redacted = text.replace(/token=[^\s)]+/g, 'token=<redacted>');
  return fixture?.token ? redacted.replaceAll(fixture.token, '<redacted>') : redacted;
}
async function until(read, predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    if (child.exitCode !== null) throw new Error(`DSH exited ${child.exitCode}: ${redactDiagnostics(boot).slice(-2500)}`);
    await delay(100);
  }
  const last = JSON.stringify(value, (key, item) => key === 'token' ? '<redacted>' : item);
  throw new Error(`Timed out: ${label}; last=${last?.slice(0, 1000)}`);
}
async function control(route, data) {
  const response = await fetch(fixture.controlUrl + route, {
    method: data === undefined ? 'GET' : 'POST',
    // Each private controller request owns its socket; avoid stale keepalive
    // reuse after browser interaction. This never retries a business message.
    headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json', connection: 'close' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}
function passed(name) { report.checks.push(name); console.log(`PASS ${name}`); }
function rejectPromptWithInvalidTimeZone(canary, onInjected) {
  return async route => {
    const request = route.request();
    if (request.method() !== 'POST' || !request.postData()?.includes(canary)) return route.fallback();
    const payload = request.postDataJSON();
    const alter = value => {
      if (!value || typeof value !== 'object') return false;
      if (value.sessionId === fixture.ids.A && Array.isArray(value.content)) {
        value.clientTimeZone = 'ARLO_INVALID_TIME_ZONE';
        return true;
      }
      return Object.values(value).some(alter);
    };
    if (!alter(payload)) return route.fallback();
    onInjected();
    // Forward to the real Host. Its published prompt validation produces the
    // failure; the runner never fabricates an RPC result or a Arlo outcome.
    return route.continue({ postData: JSON.stringify(payload) });
  };
}
try {
  fixture = await until(() => {
    if (!fs.existsSync(reportFile)) return undefined;
    try { return fixture = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch { return undefined; }
  }, value => value?.ready || value?.errors?.length, 'real host fixture readiness', 180000);
  assert.deepEqual(fixture.errors, []);
  if (cliSetup) {
    const runtimeLine = boot.split('\n').find(line => line.startsWith('{"event":"arlo-host-loaded"'));
    assert.ok(runtimeLine, 'The loaded Host reports its own integration identity');
    const live = JSON.parse(runtimeLine);
    assert.equal(live.runtime.executable, process.execPath);
    assert.equal(live.runtime.version, process.versions.node);
    assert.equal(live.adapter, fs.realpathSync(require.resolve('@arlo/adapter-dsh')));
    assert.equal(live.requiredContracts, 'ready');
    assert.equal(live.communication, 'unobserved');
    report.hostRuntime = live;
    passed('cli-native-bundle-reports-live-host-node-and-installed-adapter');
  }
  const authenticatedUrl = await until(() => boot.match(/dsh web: (http:\/\/[^\s]+)/)?.[1], Boolean, 'authenticated Web URL');
  browser = await chromium.launch({ headless: true, ...(process.env.ARLO_BROWSER_EXECUTABLE
    ? { executablePath: process.env.ARLO_BROWSER_EXECUTABLE } : {}) });
  report.browser = {
    version: browser.version(), playwrightVersion: require('playwright/package.json').version, headless: true,
  };
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    report.externalBrowserRequests.push(url.origin);
    return route.abort();
  });
  page = await context.newPage();
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) {
      report.browserConsole.push(message.text().slice(0, 2000));
      report.browserConsoleDetails.push({
        observedAt: new Date().toISOString(), lastCompletedCheck: report.checks.at(-1) ?? null,
        type: message.type(), location: message.location(),
      });
    }
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/open-in-app/icon/')) {
      report.appIconResponses.push({ pathname: new URL(response.url()).pathname, status: response.status(),
        contentType: response.headers()['content-type'] });
    }
    if (response.status() >= 400) report.failedHttpRequests.push({ pathname: new URL(response.url()).pathname, status: response.status() });
    if (response.ok() && new URL(response.url()).pathname.startsWith('/plugins/')) pluginResponses.set(response.url(), response);
    if (response.ok() && new URL(response.url()).pathname === composition.frontend.asset) seedResponse = response;
  });
  await page.addInitScript(id => {
    localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }));
  }, contactReadiness ? fixture.ids.cold : fixture.ids.A);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  const beforeReadiness = contactReadiness ? await until(() => control('/state'),
    state => state.waiting.includes(fixture.ids.B), 'B holds its baseline turn before cold-session discovery') : undefined;
  await page.goto(authenticatedUrl);
  const input = page.locator('[data-composer-input][contenteditable="true"]').first();
  await input.waitFor();
  if (appIcons) {
    const icon = page.getByRole('button', { name: 'Open in Cursor', exact: true }).locator('img');
    await icon.waitFor({ state: 'visible' });
    await until(() => icon.evaluate(image => image.complete && image.naturalWidth > 0), Boolean, 'native Cursor icon is decoded');
    const response = report.appIconResponses.find(item => item.pathname === '/open-in-app/icon/cursor');
    assert.equal(response?.status, 200, 'The real native page must load a successful Cursor icon response');
    assert.match(response.contentType, appIcons === 'extracted' ? /^image\/png/ : /^image\/svg\+xml/);
    report.appIconDisplay = await icon.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
    await page.screenshot({ path: path.join(dirs.logs, `app-icons-${appIcons}.png`) });
    passed(`native-cursor-icon-${appIcons}-decodes-without-failed-request`);
  }
  const menu = page.getByRole('listbox', { name: 'Trigger suggestions' });
  async function draft(text) {
    if (text.startsWith('@ep-')) text = `@arlo:deepseek-harness:${text.slice(1)}`;
    await input.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    if (text) await page.keyboard.type(text);
  }
  async function continueCurrentRoot() {
    await draft('/arlo-continue');
    await menu.getByRole('option').filter({ hasText: 'arlo-continue' }).click();
    const response = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/arloContact/continueCollaboration' && response.request().method() === 'POST');
    await page.keyboard.press('Enter');
    const envelope = await (await response).json();
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope));
    assert.equal(envelope.result.value.knowledge, 'known');
    return envelope.result.value;
  }
  await until(() => control('/state'), state => state.waiting.includes(fixture.ids.B), 'B held in real model turn');
  if (contactReadiness) {
    assert.equal(beforeReadiness.sessions.cold.live, false, 'The selected session begins as persisted history');
    const contactRpcUrl = new URL('/api/arloContact/list', authenticatedUrl);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(contactRpcUrl.hostname));
    const evidence = report.contactReadiness = {
      boundary: 'Delay the real authenticated read-only HTTP response; native session restoration is not gated.',
      scenario: contactReadinessCancel ? 'cold-start-cancellation-and-reopen' : 'cold-start-single-at-success',
      origin: contactRpcUrl.origin, pathname: contactRpcUrl.pathname, maxRetries: 0, maxRedirects: 0,
      postCancellationObservationMs: 1500, queries: [], delayedResponses: [], cancellations: [],
    };
    const held = [];
    let nextGate;
    function holdNextQuery(label) {
      assert.equal(nextGate, undefined, 'Only one next contact query may be held');
      const gate = { label, release: Promise.withResolvers(), finished: Promise.withResolvers() };
      held.push(gate);
      nextGate = gate;
      return gate;
    }
    async function delayContactResponse(route) {
      const request = route.request();
      evidence.queries.push({ observedAt: new Date().toISOString(), method: request.method() });
      const gate = nextGate;
      if (!gate) return route.fallback();
      nextGate = undefined;
      gate.started = true;
      try {
        const message = request.postDataJSON();
        assert.equal(request.method(), 'POST');
        assert.equal(message.method, 'arloContact/list');
        assert.equal(message.payload.args.sessionId, fixture.ids.cold);
        // Forward this exact authenticated request once. Only the delivery time
        // changes; no Host result, contact list or error is manufactured.
        const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 30000 });
        assert.equal(response.ok(), true, `Real contact RPC returned HTTP ${response.status()}`);
        const bytes = await response.body();
        const envelope = JSON.parse(bytes.toString('utf8'));
        assert.equal(envelope.rpcId, message.rpcId);
        gate.evidence = {
          label: gate.label, sessionId: message.payload.args.sessionId, rpcId: message.rpcId,
          heldAt: new Date().toISOString(), httpStatus: response.status(),
          responseSha256: createHash('sha256').update(bytes).digest('hex'),
          resultOk: envelope.result.ok, errorCode: envelope.result.error?.code,
          errorReason: envelope.result.error?.details?.reason,
        };
        evidence.delayedResponses.push(gate.evidence);
        gate.received = true;
        await gate.release.promise;
        gate.evidence.releasedAt = new Date().toISOString();
        try {
          await route.fulfill({ response });
          gate.evidence.releaseOutcome = 'original-response-forwarded';
        } catch (error) {
          // Chromium may have removed the request after the user's cancellation.
          // Only that observed abort permits an unsuccessful late fulfillment.
          if (request.failure()?.errorText !== 'net::ERR_ABORTED') throw error;
          gate.evidence.releaseOutcome = 'browser-request-already-aborted';
        }
        gate.evidence.browserFailure = request.failure()?.errorText ?? null;
      } catch (error) {
        gate.error = redactDiagnostics(error.stack ?? String(error));
        await route.abort().catch(() => {});
      } finally {
        gate.finished.resolve();
      }
    }
    const loading = menu.locator('[role="status"][data-source="arlo-contact"]');
    async function observeWaiting(gate) {
      await until(() => gate, value => value.received || value.error, `${gate.label}: real contact response is held`);
      assert.equal(gate.error, undefined);
      await loading.waitFor();
      assert.equal(await loading.getAttribute('aria-label'), 'Loading…');
      assert.equal(await menu.getByText('New conversation', { exact: true }).count(), 0);
      gate.evidence.waitingDraft = await input.innerText();
    }
    async function releaseQuery(gate) {
      gate.release.resolve();
      await gate.finished.promise;
      assert.equal(gate.error, undefined);
    }
    function receptionState(state) {
      return Object.fromEntries(Object.entries(state.sessions).map(([key, session]) => [key, {
        received: session.events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'arlo'),
        nextTurn: session.inbox?.nextTurn ?? [], nextStep: session.inbox?.nextStep ?? [],
      }]));
    }
    async function assertReadOnly() {
      const state = await control('/state');
      assert.equal(state.requests.length, beforeReadiness.requests.length, 'Contact discovery makes no model request');
      assert.deepEqual(state.creationAttempts, beforeReadiness.creationAttempts, 'Contact discovery creates no conversation');
      assert.deepEqual(state.roots.filter(root => root.id !== fixture.ids.cold).map(root => root.id).sort(),
        beforeReadiness.roots.map(root => root.id).sort(), 'Only the selected historical root may be restored');
      assert.deepEqual(receptionState(state), receptionState(beforeReadiness), 'Contact discovery sends no message or queued input');
    }
    async function observeCancelled(gate, expectedDraft, gesture) {
      await menu.waitFor({ state: 'hidden' });
      const queryCount = evidence.queries.length;
      await releaseQuery(gate);
      const deadline = Date.now() + evidence.postCancellationObservationMs;
      do {
        assert.equal(await input.innerText(), expectedDraft, 'A stale contact response must preserve the current draft');
        assert.equal(await menu.isVisible(), false, 'A stale contact response must not reopen the dismissed menu');
        assert.equal(evidence.queries.length, queryCount, 'The cancelled query must not continue polling');
        await delay(100);
      } while (Date.now() < deadline);
      await assertReadOnly();
      evidence.cancellations.push({ gesture, draft: expectedDraft, queryCount });
      await page.screenshot({ path: path.join(dirs.logs, `contact-readiness-cancelled-${gesture}.png`) });
    }
    await context.route(contactRpcUrl.href, delayContactResponse);
    try {
      // Each clear-and-type uses real keystrokes through DSH's native input state machine.
      if (contactReadinessCancel) {
        const escaped = holdNextQuery('escape');
        await draft('@');
        report.initialDraft = await input.innerText();
        await observeWaiting(escaped);
        await page.screenshot({ path: path.join(dirs.logs, 'contact-readiness-waiting.png') });
        await page.keyboard.press('Escape');
        await observeCancelled(escaped, '@', 'escape');

        const edited = holdNextQuery('input-edit');
        await draft('@');
        await observeWaiting(edited);
        await draft('READINESS_REPLACEMENT_DRAFT_CANARY');
        await observeCancelled(edited, 'READINESS_REPLACEMENT_DRAFT_CANARY', 'input-edit');
        passed('contact-discovery-response-wait-cancels-through-escape-and-input-edit-without-stale-results-or-side-effects');
      }

      const queryCountBeforeSuccess = evidence.queries.length;
      if (!contactReadinessCancel) assert.equal(queryCountBeforeSuccess, 0, 'Cold success begins with the first contact query');
      const successful = holdNextQuery(contactReadinessCancel ? 'post-cancellation-reopen' : 'cold-single-at-success');
      await draft('@');
      if (!contactReadinessCancel) report.initialDraft = await input.innerText();
      await observeWaiting(successful);
      if (!contactReadinessCancel) await page.screenshot({ path: path.join(dirs.logs, 'contact-readiness-waiting.png') });
      await releaseQuery(successful);
      await menu.getByText('New conversation', { exact: true }).waitFor({ timeout: 20000 });
      assert.equal(await input.innerText(), '@', contactReadinessCancel
        ? 'The reopened query stays unchanged until its real response is ready'
        : 'The first and only @ stays unchanged until cold-session discovery is ready');
      const firstResponse = successful.evidence;
      const queryCount = evidence.queries.length - queryCountBeforeSuccess;
      const initiallyUnavailable = firstResponse.resultOk === false
        && firstResponse.errorCode === 'arlo/contact-unavailable'
        && ['CALLER_NOT_ROOT', 'CHANNEL_NOT_READY'].includes(firstResponse.errorReason);
      const completedQuery = {
        label: successful.label, queryCount, firstResultOk: firstResponse.resultOk,
        firstErrorCode: firstResponse.errorCode, firstErrorReason: firstResponse.errorReason,
        retryObserved: initiallyUnavailable && queryCount > 1,
      };
      if (contactReadinessCancel) evidence.reopen = completedQuery;
      else evidence.coldSingleAt = completedQuery;
      if (initiallyUnavailable) assert.ok(queryCount > 1, 'The same @ query retries the real not-ready response');
      await assertReadOnly();
    } finally {
      nextGate = undefined;
      for (const gate of held) gate.release.resolve();
      await Promise.all(held.filter(gate => gate.started).map(gate => gate.finished.promise));
      await context.unroute(contactRpcUrl.href, delayContactResponse);
    }
  } else {
    await input.fill('@');
    report.initialDraft = await input.innerText();
  }
  await menu.getByText('Arlo contacts', { exact: true }).waitFor({ timeout: 15000 });
  passed('installed-host-and-browser-contact-source-loaded');
  const browserGraph = await page.evaluate(() => ({ entries: window.__DSH_BOOT__.entries, batches: window.__DSH_BOOT__.batches }));
  const clientRow = browserGraph.entries.find(entry => entry.id === '@arlo/adapter-dsh');
  assert.ok(clientRow, 'The actual DSH browser graph must load the new adapter package');
  assert.ok(clientRow.inject.includes('@deepseek-ai/dsh-api-gateway'), 'Contacts retain the authenticated Host gateway');
  const browserDependencies = browserGraph.entries.flatMap(entry => [entry.id, ...(entry.inject ?? []), ...(entry.external ?? [])]);
  assert.deepEqual(browserDependencies.filter(id => id.startsWith('node:') || /^@arlo\/(?:daemon|sdk|adapter-sdk|dsh-contact)(?:\/|$)/u.test(id)
    || /^@arlo\/adapter-dsh\/(?!client$)/u.test(id)), [], 'The browser graph must exclude the Node runtime and communication packages');
  const clientBatch = browserGraph.batches.find(batch => batch.entries.includes(clientRow.id));
  assert.ok(clientBatch, 'The adapter must belong to a real browser batch');
  const clientBatchUrl = new URL(clientBatch.url, page.url()).href;
  const clientResponse = pluginResponses.get(clientBatchUrl);
  assert.ok(clientResponse, 'The browser must actually request its declared adapter batch');
  const responseBytes = await clientResponse.body();
  assert.ok(responseBytes.includes(clientBytes), 'The fetched browser resource must contain the exact installed ./client bytes');
  report.browserAdapter = {
    package: clientRow.id, installedEntry: fs.realpathSync(clientEntry),
    clientSha256: createHash('sha256').update(clientBytes).digest('hex'),
    loadedUrl: new URL(clientBatchUrl).pathname + new URL(clientBatchUrl).search,
    responseSha256: createHash('sha256').update(responseBytes).digest('hex'),
    inject: clientRow.inject, browserModuleIds: browserGraph.entries.map(entry => entry.id),
    executableImports: forbiddenClientSyntax,
  };
  passed('actual-browser-batch-contains-installed-adapter-client-without-node-runtime-or-direct-transport');
  assert.ok(seedResponse, 'The native browser must request the checked installed frontend seed');
  report.browserSeed = { asset: new URL(seedResponse.url()).pathname,
    sha256: createHash('sha256').update(await seedResponse.body()).digest('hex') };
  assert.equal(report.browserSeed.sha256, composition.frontend.sha256,
    'The native browser must execute the exact resource validated with the installed Host composition');
  passed('actual-browser-seed-matches-checked-installed-composition');
  report.pluginConfiguration = await control('/configuration', {});
  assert.deepEqual(report.pluginConfiguration.config.newSessionModel, configuredModel, 'Actual Host profile configuration preserves the optional model setting');
  if (crossHost) {
    const { crossHostScenario } = await import('./cross-host.mjs');
    await crossHostScenario({ piRig, piPeer, page, input, menu, draft, control, until, fixture, report, passed });
  } else if (pluginUnload) {
    await menu.getByRole('option').filter({ hasText: 'New conversation' }).click();
    await input.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(' PLUGIN_UNLOAD_CREATE_CANARY');
    const before = await control('/state');
    await page.evaluate(() => { window.arloUnloadSentinel = 'same-browser-realm'; });
    await control('/gate-create', {});
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state === 'waiting', 'Creation before actual plugin disposal');
    await control('/disable-contact-plugin', {});
    await until(() => control('/state'), state => !state.contactPlugin.available
      && state.contactPlugin.unmounts === before.contactPlugin.unmounts + 1
      && state.creationAttempts.at(-1)?.signalAborted, 'The real Loader disposal cancels the pending Host creation');
    await input.waitFor();

    await page.getByText('Shared contact title', { exact: true }).first().click();
    await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId),
      id => id === fixture.ids.B, 'Select the replacement session with the plugin disabled');
    await draft('@');
    await menu.getByRole('option').filter({ hasText: 'reference.txt' }).waitFor();
    assert.equal(await menu.getByText('Arlo contacts', { exact: true }).count(), 0,
      'Plugin disposal removes its actual browser source while native sources stay mounted');
    await draft('PLUGIN_UNLOAD_REPLACEMENT_DRAFT');
    await control('/release-create', { action: 'continue' });
    const after = await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state !== 'waiting', 'The disposed creation finishes cleanup');
    assert.equal(await page.evaluate(() => window.arloUnloadSentinel), 'same-browser-realm', 'The test must not reload the browser');
    assert.equal(await input.innerText(), 'PLUGIN_UNLOAD_REPLACEMENT_DRAFT');
    assert.equal(after.requests.length, before.requests.length);
    assert.equal(after.creationAttempts.length, before.creationAttempts.length + 1);
    assert.ok(!after.roots.some(root => root.events.some(event => event.type === 'user/message'
      && JSON.stringify(event).includes('PLUGIN_UNLOAD_CREATE_CANARY'))));
    report.pluginUnload = { lifecycle: after.contactPlugin, attempt: after.creationAttempts.at(-1),
      replacementDraft: await input.innerText(), sameBrowserRealm: true };
    passed('real-plugin-unload-cancels-preparation-removes-browser-source-and-preserves-replacement-draft');
  } else if (contactReadiness) {
    assert.equal(beforeReadiness.sessions.cold.live, false, 'The restored session starts as persisted history');
    await menu.getByText('New conversation', { exact: true }).waitFor({ timeout: 20000 });
    await menu.getByText('Files & folders', { exact: true }).waitFor();
    await menu.getByText('Sessions', { exact: true }).waitFor();
    await menu.getByRole('option', { name: 'reference.txt', exact: true }).waitFor();
    report.menuText = await menu.innerText();
    const arloIndex = report.menuText.indexOf('Arlo contacts');
    const filesIndex = report.menuText.indexOf('Files & folders');
    assert.ok(arloIndex >= 0 && arloIndex < filesIndex && arloIndex < report.menuText.indexOf('Sessions'));
    const contactSection = report.menuText.slice(arloIndex, filesIndex);
    assert.match(contactSection, /DSH/);
    assert.equal(await input.innerText(), '@', contactReadinessCancel
      ? 'The reopened @ remains unchanged while discovery becomes ready'
      : 'The first @ remains unchanged while discovery becomes ready');
    report.selectedSession = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId);
    assert.equal(report.selectedSession, fixture.ids.cold);
    report.finalState = await control('/state');
    assert.equal(report.finalState.sessions.cold.live, true);
    assert.equal(report.finalState.requests.length, beforeReadiness.requests.length, 'Opening contacts sends no model request');
    assert.equal(report.finalState.creationAttempts.length, beforeReadiness.creationAttempts.length, 'Opening contacts creates no conversation');
    // Cross-host discovery groups ready contacts by Host. Drill down through
    // that native category before checking a concrete same-group endpoint.
    await menu.getByText('DSH', { exact: true }).click();
    await menu.getByRole('option').filter({ hasText: fixture.endpointBySession.B.slice(0, 8) }).waitFor();
    report.contactMenuText = await menu.innerText();
    assert.match(report.contactMenuText, /Shared contact title/);
    assert.ok(report.contactMenuText.includes(fixture.endpointBySession.B.slice(0, 8)));
    const afterDrilldown = await control('/state');
    assert.equal(afterDrilldown.requests.length, beforeReadiness.requests.length);
    assert.equal(afterDrilldown.creationAttempts.length, beforeReadiness.creationAttempts.length);
    await page.screenshot({ path: path.join(dirs.logs, contactReadinessCancel ? 'contact-readiness-reopened.png' : 'contact-readiness.png') });
    passed(contactReadinessCancel
      ? 'contact-query-reopens-after-cancellation-with-ready-contacts-before-files-and-history-without-sending'
      : 'cold-history-single-at-shows-ready-contacts-before-files-and-history-without-sending');
  } else if (contactRendering) {
    await draft(`@${fixture.endpointBySession.B}`);
    await menu.getByRole('option').filter({ hasText: 'Shared contact title' }).filter({ hasText: '· DSH ·' }).click();
    await input.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(' Write a short poem. CONTACT_RENDER_CANARY');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const submitted = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'A receives the selected contact');
    const prompt = JSON.stringify(submitted.requests.findLast(item => item.sessionId === fixture.ids.A).messages);
    assert.ok(prompt.includes(fixture.endpointBySession.B));
    assert.match(prompt, /arlo_send_message/);
    assert.equal(submitted.sessions.B.inbox.nextTurn.length, 0);
    await page.getByText('Write a short poem. CONTACT_RENDER_CANARY', { exact: false }).first().waitFor();
    const visible = await page.locator('body').innerText();
    assert.ok(!visible.includes('<arlo-contact>'), 'Sent contact must render as a session chip, not raw contact markup');
    assert.ok(!visible.includes('The user selected this exact Arlo contact'), 'Model contact instructions must not appear in the transcript');
    assert.match(visible, /Contact Shared contact title/);
    const sentChip = page.locator('[data-ref-chip="session"]').filter({ hasText: 'Contact Shared contact title' });
    assert.equal(await sentChip.count(), 1);
    assert.equal(await sentChip.locator('svg').count(), 1, 'Contact uses the native session reference icon');
    assert.ok((await sentChip.getAttribute('title')).includes(fixture.endpointBySession.B));
    await page.screenshot({ path: path.join(dirs.logs, 'contact-sent.png') });
    passed('sent-contact-shows-label-and-body-without-model-instructions');

    // Queue through the real composer while A's first model turn is held. The
    // queued projection consumes a different path from the transcript bubble.
    await draft(`@${fixture.endpointBySession.B}`);
    await menu.getByRole('option').filter({ hasText: 'Shared contact title' }).filter({ hasText: '· DSH ·' }).click();
    await input.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(' QUEUED_CONTACT_RENDER_CANARY');
    await page.getByRole('button', { name: 'Queue message', exact: true }).click();
    const queued = await until(() => control('/state'), state => state.sessions.A.inbox.nextTurn.some(item =>
      JSON.stringify(item).includes('QUEUED_CONTACT_RENDER_CANARY')), 'The real Host accepts the contact into A queue');
    assert.equal(queued.requests.length, submitted.requests.length, 'Queueing must not start another model turn or send to B');
    assert.equal(queued.sessions.B.inbox.nextTurn.length, 0);
    const queue = page.locator('[data-queue-dock]');
    const queuedChip = queue.locator('[data-ref-chip="session"]');
    await queuedChip.waitFor();
    assert.equal(await queuedChip.count(), 1);
    assert.match(await queuedChip.innerText(), /Contact Shared contact title/);
    assert.equal(await queuedChip.getAttribute('title'), fixture.endpointBySession.B);
    assert.ok(!(await queue.innerText()).includes('<arlo-contact>'));
    assert.ok(!(await queue.innerText()).includes('The user selected this exact Arlo contact'));
    await page.screenshot({ path: path.join(dirs.logs, 'contact-queued.png') });
    passed('queued-contact-uses-readable-native-chip-with-exact-endpoint-and-no-tool-send');

    await control('/rename', { session: 'B', title: 'Renamed contact keeps endpoint' });
    const renamed = await until(() => control('/contacts', { session: 'A' }), contacts => contacts.some(contact =>
      contact.endpoint_id === fixture.endpointBySession.B && contact.display_name === 'Renamed contact keeps endpoint'), 'The normal Host title update reaches contact discovery');
    assert.equal(renamed.find(contact => contact.display_name === 'Renamed contact keeps endpoint').endpoint_id, fixture.endpointBySession.B);
    assert.equal(await queuedChip.getAttribute('title'), fixture.endpointBySession.B);
    assert.match(await queuedChip.innerText(), /Contact Shared contact title/, 'Already submitted labels retain their display snapshot');
    await queue.getByRole('button', { name: 'Remove queued message', exact: true }).click();
    await until(() => control('/state'), state => state.sessions.A.inbox.nextTurn.length === 0, 'Remove only the acceptance-owned queued input');
    await draft(`@${fixture.endpointBySession.B}`);
    await menu.getByRole('option').filter({ hasText: 'Renamed contact keeps endpoint' }).click();
    assert.match(await input.innerText(), /Renamed contact keeps endpoint/);
    await draft('');
    assert.equal((await control('/state')).requests.length, submitted.requests.length, 'Renaming and picking again do not call the model');
    assert.equal(await sentChip.getAttribute('title'), fixture.endpointBySession.B);
    report.contactTitleUpdate = { endpoint: fixture.endpointBySession.B, oldLabel: await sentChip.innerText(), currentTitle: 'Renamed contact keeps endpoint' };
    passed('title-update-refreshes-contact-menu-without-changing-queued-or-historical-address');
    await control('/release', { session: 'A', send: false });
    await until(() => control('/state'), state => state.sessions.A.status === 'idle', 'A finishes contact rendering turn');
    await page.reload();
    await input.waitFor();

    await sentChip.waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes('<arlo-contact>'));
    passed('contact-label-survives-history-reload');

    const beforeMixed = await control('/state');
    await draft(`@${fixture.endpointBySession.C}`);
    await menu.getByRole('option').filter({ hasText: 'Shared contact title' }).filter({ hasText: '· DSH ·' }).click();
    await input.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(' FIRST_TARGET_TASK @');
    await menu.getByRole('option').filter({ hasText: 'New conversation' }).click();
    await input.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(' SECOND_TARGET_TASK @arlo-web-cold');
    await menu.getByRole('option').filter({ hasText: 'Cold historical Session' }).click();
    await input.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(' MIXED_RENDER_CANARY');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const mixed = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'A receives mixed contact and history references');
    assert.equal(mixed.roots.length, beforeMixed.roots.length + 1);
    const mixedPrompt = JSON.stringify(mixed.requests.findLast(item => item.sessionId === fixture.ids.A).messages);
    assert.ok(mixedPrompt.includes(fixture.endpointBySession.C));
    assert.match(mixedPrompt, /ARLO_COLD_HISTORY_CANARY/);
    await page.getByText('MIXED_RENDER_CANARY', { exact: false }).first().waitFor();
    const mixedVisible = await page.locator('body').innerText();
    assert.ok(!mixedVisible.includes('<arlo-contact>'));
    assert.ok(!mixedVisible.includes('The user selected this exact Arlo contact'));
    const contactChips = page.locator('[data-ref-chip="session"]').filter({ hasText: /^Contact / });
    assert.equal(await contactChips.count(), 3, 'Existing and newly created contacts all retain session chips');
    const nativeChip = page.locator('[data-ref-chip="session"]').filter({ hasText: 'Cold historical Session' }).last();
    assert.equal(await nativeChip.getAttribute('class'), await contactChips.last().getAttribute('class'), 'Contacts reuse native reference styling');
    assert.match(mixedVisible, /FIRST_TARGET_TASK[\s\S]*Contact [\s\S]*SECOND_TARGET_TASK[\s\S]*Cold historical Session[\s\S]*MIXED_RENDER_CANARY/);
    await page.screenshot({ path: path.join(dirs.logs, 'contact-mixed-sent.png') });
    passed('multiple-existing-new-and-native-history-references-keep-order-and-native-style');
  } else if (multiContact) {
    const sendButton = page.getByRole('button', { name: 'Send message', exact: true });
    const chips = input.locator('[data-composer-chip]');
    async function append(text) {
      await input.click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.insertText(text);
    }
    async function pick(query, label) {
      await append(` @${query}`);
      await menu.getByRole('option').filter({ hasText: label }).click();
    }
    const pickNew = () => pick('', 'New conversation');
    const pickExisting = key => pick(`arlo:deepseek-harness:${fixture.endpointBySession[key]}`, key === 'U' ? 'Untitled session' : 'Shared contact title');
    const rootsAdded = (state, before) => state.roots.filter(root => !before.roots.some(old => old.id === root.id));
    const arloMessages = root => root.events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'arlo');
    const receptions = state => [
      ...state.roots.flatMap(root => arloMessages(root).map(event => ({ root: root.id, text: event.data.content[0].text }))),
      ...state.sessions.B.inbox.nextTurn.map(message => ({ root: fixture.ids.B, text: message.content[0].text })),
    ];
    function promptContacts(request) {
      const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      const text = textOf(request.messages.findLast(message => message.role === 'user' && textOf(message).includes('<arlo-contact>')));
      return [...text.matchAll(/<arlo-contact>([\s\S]*?)<\/arlo-contact>/g)].map(match => JSON.parse(match[1]));
    }
    async function delivered(before, expectedSlots, expectedNewCount, label) {
      const submitted = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), `${label}: A receives ready contacts`);
      const created = rootsAdded(submitted, before);
      assert.equal(created.length, expectedNewCount);
      assert.equal(submitted.creationAttempts.length, before.creationAttempts.length + expectedNewCount);
      const request = submitted.requests.findLast(item => item.sessionId === fixture.ids.A);
      const contacts = promptContacts(request);
      assert.equal(contacts.length, expectedSlots.length);
      assert.equal(new Set(contacts.map(contact => contact.endpoint_id)).size, contacts.length, 'Different chips keep distinct identities');
      for (const [index, endpoint] of expectedSlots.entries()) if (endpoint) assert.equal(contacts[index].endpoint_id, endpoint);
      const available = await control('/contacts', { session: 'A' });
      for (const contact of contacts) assert.ok(available.some(item => item.endpoint_id === contact.endpoint_id && item.deliverable), 'Every submitted endpoint is ready in A current group');
      const createdEndpoints = new Map();
      for (const root of created) {
        assert.equal(root.meta.parentSession, undefined);
        assert.equal(root.events.some(event => event.type === 'user/message'), false, 'Preparation must not send or copy A history');
        const peers = await control('/contacts', { session: root.id });
        const own = available.filter(item => !peers.some(peer => peer.endpoint_id === item.endpoint_id));
        assert.equal(own.length, 1);
        createdEndpoints.set(own[0].endpoint_id, root.id);
      }
      assert.deepEqual(contacts.filter((item, index) => !expectedSlots[index]).map(item => createdEndpoints.get(item.endpoint_id)), created.map(root => root.id), 'Each new chip retains its own root in selection order');
      await control('/release', { session: 'A', send: true });
      const toolsCompleted = await until(() => control('/state'), state => state.sessions.A.status === 'idle', `${label}: single-target tools complete`);
      const results = toolsCompleted.sessions.A.events.slice(submitted.sessions.A.events.length).filter(event => event.type === 'tool/result');
      assert.equal(results.length, contacts.length);
      for (const result of results) {
        assert.notEqual(result.data.message.isError, true, JSON.stringify(result));
        assert.match(JSON.stringify(result.data.message), /accepted/, 'Each successful composition uses the existing accepted result');
      }
      const completed = await until(() => control('/state'), state => {
        const deliveries = state.requests.find(item => item.index === request.index).deliveries;
        const received = receptions(state);
        return deliveries.every(delivery => received.some(message => message.text === delivery.text))
          && created.every(root => state.roots.find(item => item.id === root.id)?.status === 'idle'
            && state.requests.some(item => item.sessionId === root.id && item.state === 'finished'));
      }, `${label}: actual reception and first receiver model turns complete`);
      const emitted = completed.requests.find(item => item.index === request.index);
      assert.equal(emitted.deliveries.length, contacts.length);
      // B stays active, so its actual reception is visible in the public nextTurn inbox.
      const received = receptions(completed);
      for (const [index, delivery] of emitted.deliveries.entries()) {
        const matches = received.filter(message => message.text === delivery.text);
        assert.equal(matches.length, 1, 'Each independently composed message is received exactly once');
        const existingKey = Object.keys(fixture.endpointBySession).find(key => fixture.endpointBySession[key] === delivery.endpoint);
        if (existingKey) assert.equal(matches[0].root, fixture.ids[existingKey], 'Same-title/untitled contacts receive their own message');
        else assert.equal(matches[0].root, createdEndpoints.get(delivery.endpoint), 'Each new tag message reaches its own root');
        assert.equal(delivery.endpoint, contacts[index].endpoint_id, 'Model sends to the matching tag endpoint');
      }
      assert.equal(new Set(emitted.deliveries.map(item => item.text)).size, contacts.length, 'The model composes separate target messages');
      for (const root of created) {
        const firstRequest = completed.requests.find(item => item.sessionId === root.id);
        assert.equal(firstRequest.model, configuredModel?.model ?? request.model);
        assert.equal(firstRequest.provider, configuredModel?.provider ?? request.provider);
        assert.ok(!JSON.stringify(firstRequest.messages).includes('ARLO_A_EXISTING_WORK_CONTEXT'));
      }
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId), fixture.ids.A);
      const visibleSessions = JSON.stringify(await control('/sessions', {}));
      assert.ok(created.every(root => visibleSessions.includes(root.id)), 'New roots remain ordinary visible Sessions');
      report.multiCases ??= [];
      report.multiCases.push({ label, contacts, created: created.map(root => root.id), deliveries: emitted.deliveries });
      passed(label);
      return { submitted, completed, request };
    }
    await draft('');
    const beforeExisting = await control('/state');
    for (const key of ['B', 'C', 'U']) await pickExisting(key);
    await pick('reference.txt', 'reference.txt');
    await pick('arlo-web-cold', 'Cold historical Session');
    assert.equal(await chips.count(), 5);
    await append(' Contact each selected conversation with its own relevant message. MULTI_EXISTING_CANARY');
    assert.equal((await control('/state')).requests.length, beforeExisting.requests.length);
    await sendButton.click();
    const existing = await delivered(beforeExisting, ['B', 'C', 'U'].map(key => fixture.endpointBySession[key]), 0, 'multi-existing-same-title-untitled-and-original-file-history-references');
    assert.match(JSON.stringify(existing.request.messages), /ARLO_COLD_HISTORY_CANARY/);
    assert.match(JSON.stringify(existing.request.messages), /reference\.txt/);
    assert.equal(existing.completed.sessions.cold.live, false);

    // Production admission pacing allows 12 sends/minute, burst 4. Preserve
    // that policy: refill two credits before sending two more messages.
    await delay(10000);

    const beforeNew = await control('/state');
    await draft('');
    await pickNew();
    await pickNew();
    await pickNew();
    assert.equal(await chips.count(), 3, 'Each selection inserts a distinct new conversation chip');
    await input.click();
    await page.keyboard.press('ControlOrMeta+End');
    // Host inserts a trailing space. Backspace through it and the last chip.
    for (let i = 0; i < 5 && await chips.count() === 3; i++) await page.keyboard.press('Backspace');
    assert.equal(await chips.count(), 2, 'Removing a chip removes only that prospective root');
    await control('/select-model', { session: 'A', model: 'scripted-at-submit' });
    await append(' Contact both independent new conversations. MULTI_NEW_CANARY');
    assert.deepEqual((await control('/state')).roots.map(root => root.id), beforeNew.roots.map(root => root.id));
    await control('/gate-create', {});
    await sendButton.click();
    const gated = await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state === 'waiting', 'Multiple new roots wait on real Host creation');
    await page.getByText(/Creating new conversation/).first().waitFor();
    await sendButton.dispatchEvent('click');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    assert.equal((await control('/state')).creationAttempts.length, gated.creationAttempts.length);
    assert.equal((await control('/state')).requests.length, beforeNew.requests.length);
    await control('/release-create', { action: 'continue' });
    await delivered(beforeNew, [null, null], 2, 'multiple-new-chips-removal-submit-time-model-and-duplicate-send-gestures');

    // Four interleaved contacts need a full burst; each credit takes 5 seconds.
    await delay(20000);

    await draft('');
    const beforeMixed = await control('/state');
    await pickExisting('B');
    await append(' Review the API. MIXED_API_TASK');
    await pickNew();
    await append(' Examine the design. MIXED_DESIGN_TASK');
    await pickExisting('C');
    await append(' Review tests. MIXED_TEST_TASK');
    await pickNew();
    await append(' Check documentation. MIXED_DOCS_TASK');
    await pick('reference.txt', 'reference.txt');
    await pick('arlo-web-cold', 'Cold historical Session');
    await append(' Contact each existing and new conversation separately. MULTI_MIXED_CANARY');
    assert.equal(await chips.count(), 6);
    await sendButton.click();
    const mixed = await delivered(beforeMixed, [fixture.endpointBySession.B, null, fixture.endpointBySession.C, null], 2, 'interleaved-existing-new-file-history-tags-keep-ordered-identities-and-deliver-separate-messages');
    const mixedPrompt = JSON.stringify(mixed.request.messages.findLast(message => JSON.stringify(message).includes('MULTI_MIXED_CANARY')));
    let previousTask = -1;
    for (const task of ['MIXED_API_TASK', 'MIXED_DESIGN_TASK', 'MIXED_TEST_TASK', 'MIXED_DOCS_TASK']) {
      const position = mixedPrompt.indexOf(task);
      assert.ok(position > previousTask, 'Adjacent target task prose keeps its original order');
      previousTask = position;
    }
    const mixedDelivery = mixed.completed.requests.find(item => item.index === mixed.request.index).deliveries;
    assert.deepEqual(mixedDelivery.map(item => item.text.match(/MIXED_[A-Z]+_TASK/)?.[0]), ['MIXED_API_TASK', 'MIXED_DESIGN_TASK', 'MIXED_TEST_TASK', 'MIXED_DOCS_TASK'], 'The deterministic model composes each target task from the prose adjacent to its tag');
    assert.match(JSON.stringify(mixed.request.messages), /ARLO_COLD_HISTORY_CANARY/);
    assert.match(mixedPrompt, /reference\.txt/);

    // Refill two credits for the next pair of single-target tool calls.
    await delay(10000);

    // A stale selected identity remains stale even beside another same-title target.
    await draft('');
    await pickExisting('B');
    await pickExisting('C');
    await control('/switch-group', { session: 'C', group: 'arlo-multi-stale' });
    await append(' Contact these exact identities. MULTI_STALE_CANARY');
    const beforeStale = await control('/state');
    await sendButton.click();
    const staleSubmitted = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'A receives two selected identities including stale C');
    assert.deepEqual(promptContacts(staleSubmitted.requests.findLast(item => item.sessionId === fixture.ids.A)).map(item => item.endpoint_id), [fixture.endpointBySession.B, fixture.endpointBySession.C]);
    await control('/release', { session: 'A', send: true });
    const staleDone = await until(() => control('/state'), state => state.sessions.A.status === 'idle', 'Multi stale single-target tool results');
    const staleResults = staleDone.sessions.A.events.slice(beforeStale.sessions.A.events.length).filter(event => event.type === 'tool/result');
    assert.equal(staleResults.length, 2);
    assert.equal(staleResults.filter(event => event.data.message.isError).length, 1);
    assert.match(JSON.stringify(staleResults), /TARGET_UNAVAILABLE/);
    assert.equal(staleDone.sessions.B.inbox.nextTurn.length, beforeStale.sessions.B.inbox.nextTurn.length + 1);
    assert.equal(arloMessages(staleDone.sessions.C).length, arloMessages(beforeStale.sessions.C).length);
    assert.equal(staleDone.requests.filter(item => item.state === 'tool-emitted').length, beforeStale.requests.filter(item => item.state === 'tool-emitted').length + 1, 'No automatic business retry');
    passed('multi-existing-stale-target-reuses-single-target-error-without-substitution-or-retry');

    await draft('');
    await pickExisting('B');
    await pickNew();
    await pickNew();
    await append(' Preserve all selected tags. MULTI_CREATE_FAILURE_CANARY');
    const originalDraft = await input.innerText();
    const beforeFailure = await control('/state');
    await control('/gate-create', {});
    await sendButton.click();
    await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state === 'waiting', 'Multi creation error reaches Host lifecycle');
    await control('/release-create', { action: 'fail' });
    await until(() => sendButton.isEnabled(), Boolean, 'Multi creation error releases submit guard');
    const failed = await control('/state');
    assert.equal(await input.innerText(), originalDraft);
    assert.equal(await chips.count(), 3);
    assert.equal(failed.requests.length, beforeFailure.requests.length);
    assert.equal(failed.creationAttempts.length, beforeFailure.creationAttempts.length + 1, 'Host error stops preparation without retry');
    assert.equal(rootsAdded(failed, beforeFailure).length, 0);
    passed('multi-host-create-failure-preserves-all-tags-without-submission-or-retry');

    // Reject the second normal root creation after the first has become ready.
    // Already-created ordinary Sessions remain; no new rollback policy is added.
    await control('/gate-create', { skip: 1 });
    await sendButton.click();
    await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state === 'waiting', 'Second selected new root reaches Host lifecycle');
    await control('/release-create', { action: 'fail' });
    await until(() => sendButton.isEnabled(), Boolean, 'Later creation error releases submit guard');
    const laterFailed = await control('/state');
    assert.equal(await input.innerText(), originalDraft);
    assert.equal(laterFailed.requests.length, beforeFailure.requests.length);
    assert.equal(rootsAdded(laterFailed, failed).length, 1, 'A later Host failure retains the earlier ordinary root');
    assert.equal(laterFailed.creationAttempts.length, failed.creationAttempts.length + 2);
    passed('later-new-root-create-failure-retains-earlier-root-and-entire-draft-without-send-or-retry');

    await draft('');
    await pickExisting('B');
    await pickNew();
    await pickNew();
    await append(' Preserve all tags on Host rejection. MULTI_SUBMIT_FAILURE_CANARY');
    const beforeSubmitFailure = await control('/state');
    const submitDraft = await input.innerText();
    let rejectedPrompt = false;
    const rejectPrompt = rejectPromptWithInvalidTimeZone('MULTI_SUBMIT_FAILURE_CANARY', () => { rejectedPrompt = true; });
    await context.route('**/api/**', rejectPrompt);
    await sendButton.click();
    await until(async () => rejectedPrompt && await sendButton.isEnabled(), Boolean, 'Actual Host rejects prepared multi-contact prompt');
    await context.unroute('**/api/**', rejectPrompt);
    const submitFailed = await control('/state');
    assert.equal(await input.innerText(), submitDraft);
    assert.equal(await chips.count(), 3);
    assert.equal(rootsAdded(submitFailed, beforeSubmitFailure).length, 2);
    assert.equal(submitFailed.creationAttempts.length, beforeSubmitFailure.creationAttempts.length + 2);
    assert.equal(submitFailed.requests.length, beforeSubmitFailure.requests.length);
    passed('multi-real-host-prompt-rejection-retains-created-roots-and-draft-without-send-or-retry');

    await draft('');
    await pickNew();
    await pickNew();
    await append(' Keep both tags if the source changes group. MULTI_GROUP_CHANGE_CANARY');
    const groupDraft = await input.innerText();
    const beforeGroupChange = await control('/state');
    await control('/gate-create', { skip: 1 });
    await sendButton.click();
    await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state === 'waiting', 'Second root is preparing while first root is ready');
    await control('/switch-group', { session: 'A', group: 'arlo-multi-source-changed' });
    await control('/release-create', { action: 'continue' });
    await until(() => sendButton.isEnabled(), Boolean, 'Multi preparation rejects stale source binding');
    const groupChanged = await control('/state');
    assert.equal(await input.innerText(), groupDraft);
    assert.equal(rootsAdded(groupChanged, beforeGroupChange).length, 2);
    assert.equal(groupChanged.creationAttempts.length, beforeGroupChange.creationAttempts.length + 2);
    assert.equal(groupChanged.requests.length, beforeGroupChange.requests.length);
    assert.deepEqual(await control('/contacts', { session: 'A' }), [], 'Old group endpoints never become ready contacts in the new group');
    passed('multi-group-change-during-later-preparation-retains-roots-and-draft-without-submission');
    report.finalState = groupChanged;
  } else if (configuredModel) {
    if (!expectModelUnavailable) {
      // Establish explicit human allowance for this seeded sender before the
      // model-priority scenario; this must not rely on inferred first-use credit.
      report.configuredContinuation = await continueCurrentRoot();
      await draft('@');
      await menu.getByRole('option').filter({ hasText: 'New conversation' }).waitFor();
    }
    const baseline = await control('/state');
    const ordinaryDefault = (await control('/catalog', {})).default;
    await menu.getByRole('option').filter({ hasText: 'New conversation' }).click();
    await input.click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Ask the new conversation for a review. CONFIGURED_MODEL_BODY_CANARY');
    const preservedDraft = await input.innerText();
    assert.equal(await input.locator('[data-composer-chip] select, [data-composer-chip] [role="combobox"]').count(), 0, 'The contact chip introduces no model selector');
    if (modelFault) await control('/configured-model-fault', { fault: modelFault });
    assert.deepEqual((await control('/state')).roots.map(root => root.id), baseline.roots.map(root => root.id));
    assert.equal((await control('/state')).requests.length, baseline.requests.length);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    if (expectModelUnavailable) {
      const outcome = await until(async () => ({ state: await control('/state'), text: await page.locator('body').innerText() }),
        value => value.state.waiting.includes(fixture.ids.A) || /configured.*model.*unavailable/i.test(value.text), 'Unavailable configured model rejects preparation visibly');
      assert.deepEqual(outcome.state.roots.map(root => root.id), baseline.roots.map(root => root.id), 'Unavailable configured model must fail before creating a root');
      assert.equal(outcome.state.creationAttempts.length, baseline.creationAttempts.length);
      assert.equal(outcome.state.requests.length, baseline.requests.length, 'Neither A nor B may call a model or fall back');
      assert.match(outcome.text, /configured.*model.*unavailable/i);
      await until(() => page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), Boolean, 'Model rejection releases the submit guard');
      assert.equal(await input.innerText(), preservedDraft, 'Unavailable model preserves the complete original draft');
      assert.equal(await input.locator('[data-composer-chip]').count(), 1);
      for (const previous of baseline.roots) assert.deepEqual(outcome.state.roots.find(root => root.id === previous.id).options, previous.options, 'Failure preserves all existing root models');
      assert.deepEqual((await control('/catalog', {})).default, ordinaryDefault);
      report.unavailableModel = { configuredModel, modelFault, draft: preservedDraft, visibleError: outcome.text };
      report.finalState = outcome.state;
      passed('unavailable-configured-model-fails-visibly-before-root-or-model-request-preserves-draft-and-never-falls-back');
    } else {
    const submitted = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'A receives configured new conversation contact');
    const created = submitted.roots.filter(root => !baseline.roots.some(previous => previous.id === root.id));
    assert.equal(created.length, 1);
    const newRoot = created[0];
    assert.equal(newRoot.meta.parentSession, undefined);
    assert.equal(submitted.requests.findLast(request => request.sessionId === fixture.ids.A).model, 'scripted');
    await control('/release', { session: 'A', send: true });
    const completed = await until(() => control('/state'), state => state.sessions.A.status === 'idle'
      && state.requests.some(request => request.sessionId === newRoot.id) && state.roots.find(root => root.id === newRoot.id)?.status === 'idle', 'Configured new root handles A real tool delivery');
    const firstRequest = completed.requests.find(request => request.sessionId === newRoot.id);
    assert.equal(firstRequest.provider, configuredModel.provider);
    assert.equal(firstRequest.model, configuredModel.model, 'The plugin-configured model overrides A model in B actual first request');
    const received = completed.roots.find(root => root.id === newRoot.id).events.find(event => event.type === 'user/message' && event.data?.source?.kind === 'arlo');
    assert.match(received.data.content[0].text, /^ARLO_MODEL_COMPOSED_/);
    assert.ok(!JSON.stringify(firstRequest.messages).includes('ARLO_A_EXISTING_WORK_CONTEXT'));
    assert.ok(!JSON.stringify(received).includes('CONFIGURED_MODEL_BODY_CANARY'));
    for (const previous of baseline.roots) assert.deepEqual(completed.roots.find(root => root.id === previous.id).options, previous.options, 'Existing roots keep their selected model');
    assert.deepEqual((await control('/catalog', {})).default, ordinaryDefault);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId), fixture.ids.A);
    report.configuredConversation = { id: newRoot.id, firstRequest, received, ordinaryDefault };
    report.finalState = completed;
    passed('configured-model-overrides-A-in-new-root-first-request-and-real-tool-delivery-preserves-existing-models-and-default');
    }
  } else {
  report.contactPaste = { input: 'Native clipboard copy and paste of acceptance-owned text', cases: [] };
  async function pasteCopiedContact(kind, copiedText, identity, beforePaste) {
    await draft('');
    await page.keyboard.press('ControlOrMeta+V');
    const pasted = await until(() => input.innerText(), text => text.includes(identity),
      `${kind}: native paste preserves the selected contact identity in the visible draft`);
    assert.equal(await input.locator('[data-composer-chip]').count(), 0,
      'The native plain-text paste must not turn a copied marker into a selected contact');
    // Read only data copied by this test. A second real copy checks the pasted
    // draft's exact clipboard text without depending on DOM newline rendering.
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('ControlOrMeta+C');
    const roundTrip = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(roundTrip, copiedText, 'Native paste preserves the complete copied text and exact identity');
    const afterPaste = await control('/state');
    assert.deepEqual(afterPaste.roots.map(root => root.id), beforePaste.roots.map(root => root.id),
      'Pasting a contact creates or restores no root');
    assert.deepEqual(afterPaste.creationAttempts, beforePaste.creationAttempts);
    assert.equal(afterPaste.requests.length, beforePaste.requests.length, 'Pasting a contact starts no model request');
    for (const [key, previous] of Object.entries(beforePaste.sessions)) {
      const current = afterPaste.sessions[key];
      assert.deepEqual(current.inbox, previous.inbox, `Pasting leaves ${key}'s pending input unchanged`);
      const received = session => session.events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'arlo');
      assert.deepEqual(received(current), received(previous), `Pasting delivers no message to ${key}`);
    }
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId), fixture.ids.A);
    report.contactPaste.cases.push({
      kind, identity, visibleDraft: pasted, clipboardSha256: createHash('sha256').update(roundTrip).digest('hex'),
      rootCount: afterPaste.roots.length, modelRequestCount: afterPaste.requests.length, noSideEffects: true,
    });
    await page.screenshot({ path: path.join(dirs.logs, `contact-paste-${kind}.png`) });
    passed(`native-paste-of-${kind}-preserves-exact-text-without-creation-model-request-or-delivery`);
  }
  const initial = await control('/state');
  await menu.getByRole('option').filter({ hasText: 'New conversation' }).click({ timeout: 5000 });
  await input.locator('[data-composer-chip]').waitFor();
  assert.match(await input.innerText(), /New conversation/);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  const serializedNew = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(serializedNew, /<arlo-new-contact>[a-f0-9-]{36}<\/arlo-new-contact>/);
  await page.keyboard.press('ControlOrMeta+C');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), serializedNew);
  assert.deepEqual((await control('/state')).roots.map(root => root.id), initial.roots.map(root => root.id));
  await pasteCopiedContact('new-conversation', serializedNew,
    serializedNew.match(/<arlo-new-contact>([a-f0-9-]{36})<\/arlo-new-contact>/)[1], initial);
  await draft('');
  const cancelled = await control('/state');
  assert.deepEqual(cancelled.roots.map(root => root.id), initial.roots.map(root => root.id));
  assert.equal(cancelled.requests.length, initial.requests.length);
  passed('selecting-copying-serializing-and-removing-new-conversation-does-not-create-or-call-model');
  // Text that looks like serialized plugin data is still ordinary user text.
  // Only the provenance of a genuinely selected structured reference can
  // authorize explicit submission preparation.
  const literalMarker = '<arlo-new-contact>00000000-0000-0000-0000-000000000000</arlo-new-contact>';
  await draft(literalMarker);
  assert.equal(await input.locator('[data-composer-chip]').count(), 0);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const literalSubmitted = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'A receives ordinary marker-shaped user text');
  assert.deepEqual(literalSubmitted.roots.map(root => root.id), initial.roots.map(root => root.id), 'Literal text with no selected contact chip must not create a Session');
  assert.ok(JSON.stringify(literalSubmitted.requests.findLast(item => item.sessionId === fixture.ids.A).messages).includes(literalMarker), 'Marker-shaped user text must remain verbatim');
  await control('/release', { session: 'A', send: false });
  await until(() => control('/state'), state => state.sessions.A.status === 'idle', 'A finishes reading ordinary marker-shaped text');
  passed('literal-new-contact-marker-without-selected-chip-remains-text-and-never-creates');
  await draft('@');
  await menu.getByText('Arlo contacts', { exact: true }).waitFor();
  // Native file/history providers load independently of the Arlo source.
  // A mounted contact section does not mean their asynchronous results are ready.
  await menu.getByRole('option', { name: 'reference.txt', exact: true }).waitFor();
  await menu.getByRole('option').filter({ hasText: 'Other communication group' }).waitFor();
  await menu.getByRole('option').filter({ hasText: 'arlo-web-child' }).waitFor();
  const menuText = await menu.innerText();
  assert.match(menuText, /reference\.txt/);
  assert.match(menuText, /Shared contact title/);
  assert.match(menuText, /DSH/);
  assert.match(menuText, /Other communication group/);
  assert.match(menuText, /arlo-web-child/);
  report.menu = menuText;
  await menu.getByText('DSH', { exact: true }).click();
  await menu.getByRole('option').filter({ hasText: 'Untitled session' }).waitFor();
  await page.screenshot({ path: path.join(dirs.logs, 'contact-menu.png') });
  const contacts = await control('/contacts', { session: 'A' });
  assert.equal(contacts.length, 3, 'Only B, C and untitled U are same-group receivable roots');
  assert.equal(contacts.filter(item => item.display_name === 'Shared contact title').length, 2);
  const before = await control('/state');
  assert.equal(before.sessions.B.inbox.nextTurn.length, 0);
  passed('same-group-receivable-roots-with-duplicate-and-untitled-labels');
  // Resolve B through a title change on the Host, then restore its duplicate
  // title: the selected row still carries an endpoint, never its title address.
  await control('/rename', { session: 'B', title: 'B identity for acceptance' });
  const target = (await control('/contacts', { session: 'A' })).find(item => item.display_name === 'B identity for acceptance');
  assert.ok(target);
  await control('/rename', { session: 'B', title: 'Shared contact title' });
  await draft(`@${target.endpoint_id}`);
  const option = menu.getByRole('option').filter({ hasText: 'Shared contact title' }).filter({ hasText: '· DSH ·' });
  await until(() => option.count(), count => count === 1, 'exact endpoint contact search');
  await option.click();
  const chip = input.locator('[data-composer-chip]');
  await chip.waitFor();
  assert.match(await chip.innerText(), /Contact Shared contact title/);
  const selected = await control('/state');
  assert.equal(selected.sessions.B.inbox.nextTurn.length, 0);
  assert.equal(selected.requests.length, before.requests.length);
  passed('selecting-contact-does-not-send-or-call-model');
  await input.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  const serializedExisting = await page.evaluate(() => navigator.clipboard.readText());
  const copiedContact = serializedExisting.match(/<arlo-contact>([\s\S]*?)<\/arlo-contact>/);
  assert.ok(copiedContact, 'The real selected contact copies its complete envelope');
  assert.equal(JSON.parse(copiedContact[1]).endpoint_id, target.endpoint_id);
  await pasteCopiedContact('existing-contact', serializedExisting, target.endpoint_id, selected);
  // Continue the original send regression with a freshly selected structured
  // reference to the same exact target, using the ordinary @ menu.
  await draft(`@${target.endpoint_id}`);
  await until(() => option.count(), count => count === 1, 'exact endpoint contact search after paste');
  await option.click();
  await chip.waitFor();
  await input.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' Please review the current work and send the relevant background. USER_BODY_CANARY');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const submitted = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'A sees submitted prompt');
  const request = submitted.requests.findLast(item => item.sessionId === fixture.ids.A);
  assert.match(JSON.stringify(request.messages), /USER_BODY_CANARY/);
  assert.ok(JSON.stringify(request.messages).includes(target.endpoint_id));
  assert.equal(submitted.sessions.B.inbox.nextTurn.length, 0);
  passed('submission-gives-exact-target-to-A-without-delivery');
  await control('/release', { session: 'A', send: true, queryStatus: roundTrip });
  const delivered = await until(() => control('/state'), state => state.sessions.B.inbox.nextTurn.length === 1, 'B receives only the model tool message');
  const received = delivered.sessions.B.inbox.nextTurn[0];
  assert.equal(received.source.kind, 'arlo');
  assert.match(received.content[0].text, /^ARLO_MODEL_COMPOSED_/);
  assert.ok(!JSON.stringify(received).includes('USER_BODY_CANARY'));
  assert.equal(delivered.sessions.C.inbox.nextTurn.length, 0);
  report.delivery = { endpoint: target.endpoint_id, received };
  passed('A-tool-call-delivers-model-composed-message-to-exact-B');
  await until(() => control('/state'), state => state.sessions.A.status === 'idle', 'A completes tool turn');
  report.finalState = await control('/state');
  assert.match(JSON.stringify(report.finalState.sessions.A.events), /accepted/);
  passed('existing-send-tool-reports-accepted');
  if (roundTrip) {
    const queued = await control('/state');
    const accepted = queued.requests.findLast(item => item.sessionId === fixture.ids.A && item.toolResult?.daemon_id)?.toolResult;
    assert.equal(accepted.status, 'accepted');
    assert.equal(queued.sessions.B.inbox.nextTurn.length, 1, 'Acceptance precedes the busy receiver claiming input');
    await control('/release', { session: 'B', send: false });
    const claimed = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.B)
      && state.sessions.B.inbox.nextTurn.length === 0
      && state.requests.some(item => item.sessionId === fixture.ids.B && JSON.stringify(item.messages).includes(received.content[0].text)),
      'B claims and presents the actual inbound message to its model');
    await control('/release', { session: 'B', reply: true, queryStatus: true });
    const replied = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A)
      && state.requests.some(item => item.sessionId === fixture.ids.B && item.toolResult?.daemon_id),
      'B sends the associated reply and queries its receipt through model tools');
    const replyStatus = replied.requests.findLast(item => item.sessionId === fixture.ids.B && item.toolResult?.daemon_id).toolResult;
    assert.equal(replyStatus.status, 'accepted');
    const replyInput = replied.requests.findLast(item => item.sessionId === fixture.ids.A);
    assert.match(JSON.stringify(replyInput.messages), /DSH_NATIVE_ASSOCIATED_REPLY/);
    assert.ok(JSON.stringify(replyInput.messages).includes(accepted.message_id));
    assert.equal('completed' in replyStatus, false, 'Receipt status does not assert task completion');
    await control('/release', { session: 'A', send: false });
    await until(() => control('/state'), state => state.sessions.A.status === 'idle' && state.sessions.B.status === 'idle', 'Both real model turns settle');
    report.roundTrip = { acceptedBeforeClaim: accepted, receiverClaimed: claimed.sessions.B.inbox,
      replyStatus, replyInput };
    passed('native-dsh-busy-acceptance-claim-model-processing-associated-reply-and-both-status-queries');
  } else {

  await draft('@arlo-web-cold');
  await menu.getByRole('option').filter({ hasText: 'Cold historical Session' }).click();
  assert.match(await input.locator('[data-composer-chip]').innerText(), /Cold historical Session/);
  await input.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' Read the referenced history. HISTORY_REQUEST_CANARY');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const history = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'A reads the original history reference');
  const historyRequest = history.requests.findLast(item => item.sessionId === fixture.ids.A);
  assert.match(JSON.stringify(historyRequest.messages), /ARLO_COLD_HISTORY_CANARY/);
  assert.match(JSON.stringify(historyRequest.messages), /HISTORY_REQUEST_CANARY/);
  assert.equal(history.sessions.cold.live, false, 'Reading history must not activate its recipient');
  assert.equal(history.sessions.B.inbox.nextTurn.length, 1, 'History reference does not send another message');
  await control('/release', { session: 'A', send: false });
  await until(() => control('/state'), state => state.sessions.A.status === 'idle', 'A finishes reading history');
  passed('original-history-reference-reads-cold-history-without-sending-or-resuming');
  await draft('@reference.txt');
  await menu.getByRole('option', { name: 'reference.txt', exact: true }).click();
  assert.equal(await input.locator('[data-composer-chip]').innerText(), 'reference.txt');
  await input.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' Use this file reference. FILE_REQUEST_CANARY');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const file = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'A receives original file reference');
  assert.match(JSON.stringify(file.requests.findLast(item => item.sessionId === fixture.ids.A).messages), /reference\.txt/);
  assert.equal(file.sessions.B.inbox.nextTurn.length, 1);
  await control('/release', { session: 'A', send: false });
  await until(() => control('/state'), state => state.sessions.A.status === 'idle', 'A completes file reference turn');
  passed('original-file-reference-remains-a-reference-without-sending');
  const staleEndpoint = fixture.endpointBySession.C;
  await draft(`@${staleEndpoint}`);
  await menu.getByRole('option').filter({ hasText: 'Shared contact title' }).filter({ hasText: '· DSH ·' }).click();
  await control('/switch-group', { session: 'C', group: 'arlo-selected-target-left' });
  assert.ok(!(await control('/contacts', { session: 'A' })).some(item => item.endpoint_id === staleEndpoint));
  await input.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' Contact exactly the selected session. STALE_TARGET_CANARY');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const staleSubmit = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'A receives selected stale endpoint');
  const staleRequest = staleSubmit.requests.findLast(item => item.sessionId === fixture.ids.A);
  assert.ok(JSON.stringify(staleRequest.messages).includes(staleEndpoint));
  await control('/release', { session: 'A', send: true });
  const staleDone = await until(() => control('/state'), state => state.sessions.A.status === 'idle', 'Stale target tool result');
  const staleTool = staleDone.sessions.A.events.findLast(event => event.type === 'tool/result');
  assert.ok(staleTool);
  assert.equal(staleTool.data.message.isError, true);
  assert.match(staleTool.data.message.content[0].text, /TARGET_UNAVAILABLE/);
  assert.equal(staleDone.sessions.B.inbox.nextTurn.length, 1, 'The same-title B must not substitute for C');
  assert.equal(staleDone.sessions.C.events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'arlo').length, 0);
  assert.equal(staleDone.requests.filter(item => item.state === 'tool-emitted').length, 2, 'No automatic retry of a business message');
  report.staleTarget = { endpoint: staleEndpoint, result: staleTool };
  report.finalState = staleDone;
  passed('selected-target-leaves-group-without-substitution-or-business-retry');
  await draft(`@${fixture.endpointBySession.U}`);
  await menu.getByRole('option').filter({ hasText: 'Untitled session' }).click();
  assert.match(await input.locator('[data-composer-chip]').innerText(), /Contact Untitled session/);
  await input.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' Contact this untitled session. UNTITLED_REQUEST_CANARY');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'A receives untitled endpoint');
  await control('/release', { session: 'A', send: true });
  const untitled = await until(() => control('/state'), state => state.sessions.U.events.some(event =>
    event.type === 'user/message' && event.data?.source?.kind === 'arlo'), 'Untitled U receives model message');
  assert.equal(untitled.requests.findLast(item => item.state === 'tool-emitted').selectedEndpoint, fixture.endpointBySession.U);
  assert.equal(untitled.sessions.B.inbox.nextTurn.length, 1);
  await until(() => control('/state'), state => state.sessions.A.status === 'idle' && state.sessions.U.status === 'idle', 'Untitled delivery completes');
  report.finalState = await control('/state');
  passed('untitled-contact-is-delivered-to-its-exact-endpoint');
  const beforeNew = await control('/state');
  const previousRoots = new Set(beforeNew.roots.map(root => root.id));
  await draft('@');
  await menu.getByRole('option').filter({ hasText: 'New conversation' }).click();
  // Pick first, then change the sender's model and explicit communication group.
  // The unrelated D root retains the old model as the ordinary DSH default.
  await control('/select-model', { session: 'A', model: 'scripted-at-submit' });
  await control('/select-model', { session: 'D', model: 'scripted' });
  await control('/switch-group', { session: 'A', group: 'arlo-explicit-group-at-submit' });
  const ordinaryDefault = (await control('/catalog', {})).default;
  assert.equal(ordinaryDefault.model, 'scripted');
  assert.deepEqual(await control('/contacts', { session: 'A' }), [], 'Same directory must not replace the explicit communication group');
  // Rebinding an existing root does not confer fresh first-use allowance. The
  // human explicitly continues through the native command before testing send.
  // Repick the chip after the command replaces the composer draft.
  report.groupContinuation = await continueCurrentRoot();
  passed('native-human-continuation-after-group-change-restores-known-allowance');
  await control('/select-model', { session: 'A', model: 'scripted' });
  await draft('@');
  await menu.getByRole('option').filter({ hasText: 'New conversation' }).click();
  // Preserve the model-at-submit regression after repicking the contact.
  await control('/select-model', { session: 'A', model: 'scripted-at-submit' });
  await control('/select-model', { session: 'D', model: 'scripted' });
  await input.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(` Review the relevant background with this new independent conversation. NEW_ROOT_USER_BODY_CANARY Keep this literal text: ${literalMarker}`);
  const edited = await control('/state');
  assert.deepEqual(edited.roots.map(root => root.id), beforeNew.roots.map(root => root.id));
  assert.equal(edited.requests.length, beforeNew.requests.length);
  passed('editing-new-conversation-and-changing-model-and-group-before-submit-creates-nothing');
  await control('/gate-create', {});
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const gated = await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state === 'waiting', 'Normal Host root creation is held in a public lifecycle listener');
  await page.getByText('Creating new conversation…', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(dirs.logs, 'new-conversation-progress.png') });
  // Repeat the user's send gestures while the genuine Host operation is busy.
  // dispatchEvent reaches the disabled button's React handler without waiting
  // for it to re-enable and accidentally testing a second submission.
  await page.getByRole('button', { name: 'Send message', exact: true }).dispatchEvent('click');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const repeated = await control('/state');
  assert.equal(repeated.creationAttempts.length, gated.creationAttempts.length);
  assert.equal(repeated.requests.length, edited.requests.length, 'A must not receive the draft while B is still preparing');
  await control('/release-create', { action: 'continue' });
  const newSubmitted = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'New root is ready before A receives the submitted contact');
  const created = newSubmitted.roots.filter(root => !previousRoots.has(root.id));
  assert.equal(created.length, 1, 'One explicit submission must create one independent root');
  const newRoot = created[0];
  assert.ok(!Object.values(fixture.ids).includes(newRoot.id), 'Never adopt an unrelated blank or historical Session');
  assert.equal(newRoot.meta.parentSession, undefined);
  assert.equal(newRoot.meta.origin, undefined);
  assert.equal(newRoot.meta.cwd, newSubmitted.roots.find(root => root.id === fixture.ids.A).meta.cwd);
  const newRequest = newSubmitted.requests.findLast(item => item.sessionId === fixture.ids.A);
  const contactData = [...JSON.stringify(newRequest.messages).matchAll(/ep-[a-f0-9-]+/g)].map(match => match[0]);
  const newContacts = await control('/contacts', { session: 'A' });
  assert.equal(newContacts.length, 1, 'The new root must join A\'s explicit group, separate from same-directory peers');
  assert.equal(newContacts[0].deliverable, true);
  assert.ok(contactData.includes(newContacts[0].endpoint_id), 'Only a ready endpoint is submitted to A');
  assert.match(JSON.stringify(newRequest.messages), /NEW_ROOT_USER_BODY_CANARY/);
  const newPrompt = newRequest.messages.findLast(message => JSON.stringify(message).includes('NEW_ROOT_USER_BODY_CANARY'));
  assert.ok(JSON.stringify(newPrompt).includes(literalMarker), 'A literal marker alongside the selected chip must remain untouched');
  assert.equal((JSON.stringify(newPrompt).match(/<arlo-contact>/g) ?? []).length, 1, 'Only the genuinely selected chip becomes a contact instruction');
  assert.equal(newRequest.model, 'scripted-at-submit');
  assert.ok(!newRoot.events.some(event => event.type === 'user/message'), 'Preparing B must not copy A history or send the user body');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId), fixture.ids.A);
  assert.deepEqual((await control('/catalog', {})).default, ordinaryDefault, 'Creating a Arlo root must preserve ordinary DSH model defaults');
  passed('submit-creates-fresh-independent-ready-root-in-current-explicit-group-and-keeps-A-open');
  passed('visible-creation-progress-and-repeated-send-gestures-create-only-one-root');
  await control('/release', { session: 'A', send: true });
  const newDelivered = await until(() => control('/state'), state => state.roots.find(root => root.id === newRoot.id)?.events.some(event =>
    event.type === 'user/message' && event.data?.source?.kind === 'arlo'), 'New root receives A\'s real Arlo tool message');
  const newReceived = newDelivered.roots.find(root => root.id === newRoot.id).events.find(event =>
    event.type === 'user/message' && event.data?.source?.kind === 'arlo');
  assert.match(newReceived.data.content[0].text, /^ARLO_MODEL_COMPOSED_/);
  assert.ok(!JSON.stringify(newReceived).includes('NEW_ROOT_USER_BODY_CANARY'));
  assert.ok(!JSON.stringify(newReceived).includes('ARLO_A_EXISTING_WORK_CONTEXT'));
  const completedNew = await until(() => control('/state'), state => state.sessions.A.status === 'idle' && state.roots.find(root => root.id === newRoot.id)?.status === 'idle', 'A and the new root complete their real tool/model turns');
  assert.equal(completedNew.requests.findLast(item => item.sessionId === newRoot.id).model, 'scripted-at-submit', 'B uses A\'s submit-time model in its actual first request');
  assert.ok(!JSON.stringify(completedNew.requests.findLast(item => item.sessionId === newRoot.id).messages).includes('ARLO_A_EXISTING_WORK_CONTEXT'));
  const visibleSessions = await control('/sessions', {});
  assert.ok(JSON.stringify(visibleSessions).includes(newRoot.id), 'B remains a normal visible Session after its turn');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId), fixture.ids.A);
  await control('/rename', { session: newRoot.id, title: 'New root retained normally' });
  await page.getByText('New root retained normally', { exact: true }).first().click();
  await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId), id => id === newRoot.id, 'The new root opens through the normal session list');
  await page.getByText('Arlo acceptance sender', { exact: true }).first().click();
  await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId), id => id === fixture.ids.A, 'Return to A through the normal session list');
  report.newConversation = { id: newRoot.id, endpoint: newContacts[0].endpoint_id, received: newReceived, ordinaryDefault };
  report.finalState = completedNew;
  passed('A-tool-delivers-model-composed-context-to-new-root-using-submit-time-model-without-copying-history');
  passed('created-root-supports-normal-title-and-session-list-open');
  await draft('@');
  await menu.getByRole('option').filter({ hasText: 'New conversation' }).click();
  await input.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' Preserve this draft on Host creation failure. CREATE_FAILURE_DRAFT_CANARY');
  const beforeFailure = await control('/state');
  await control('/gate-create', {});
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state === 'waiting', 'Host creation failure reaches the real lifecycle');
  await control('/release-create', { action: 'fail' });
  await until(() => input.innerText(), text => text.includes('CREATE_FAILURE_DRAFT_CANARY'), 'The failed creation restores the original composer draft');
  await until(() => page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), Boolean, 'Existing submit protection releases after creation failure');
  const failedCreation = await control('/state');
  assert.deepEqual(failedCreation.roots.map(root => root.id).sort(), beforeFailure.roots.map(root => root.id).sort());
  assert.equal(failedCreation.requests.length, beforeFailure.requests.length, 'Creation errors must not become A messages or send outcomes');
  assert.equal(failedCreation.creationAttempts.length, beforeFailure.creationAttempts.length + 1, 'No automatic creation retry');
  assert.match(await input.innerText(), /New conversation/);
  report.hostCreateFailure = { attempt: failedCreation.creationAttempts.at(-1), draft: await input.innerText() };
  passed('normal-host-create-failure-restores-draft-releases-guard-and-does-not-send-or-retry');
  await draft('');
  async function newDraft(canary) {
    await draft('@');
    await menu.getByRole('option').filter({ hasText: 'New conversation' }).click();
    await input.click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(` Preserve the new conversation request. ${canary}`);
  }
  await newDraft('PREPARATION_FAILURE_DRAFT_CANARY');
  const beforePreparationFailure = await control('/state');
  await control('/gate-create', {});
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state === 'waiting', 'New root reaches the Host lifecycle before preparation failure');
  // This is an actual trusted Host group change while create is in flight.
  // The captured old sender binding must not be reported as a ready target.
  await control('/switch-group', { session: 'A', group: 'arlo-group-changed-during-create' });
  await control('/release-create', { action: 'continue' });
  await until(() => input.innerText(), text => text.includes('PREPARATION_FAILURE_DRAFT_CANARY'), 'Preparation failure restores the original draft');
  await until(() => page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), Boolean, 'Preparation failure releases the submit guard');
  const preparationFailed = await control('/state');
  assert.equal(preparationFailed.roots.length, beforePreparationFailure.roots.length + 1, 'Preparation failure does not automatically destroy the created Host root');
  assert.equal(preparationFailed.requests.length, beforePreparationFailure.requests.length);
  assert.equal(preparationFailed.creationAttempts.length, beforePreparationFailure.creationAttempts.length + 1);
  assert.deepEqual(await control('/contacts', { session: 'A' }), [], 'An obsolete source group must never leak a target to A');
  report.preparationFailure = { created: preparationFailed.creationAttempts.at(-1), draft: await input.innerText() };
  passed('group-change-during-preparation-retains-created-root-and-draft-without-send-or-retry');

  await newDraft('SUBMIT_FAILURE_DRAFT_CANARY');
  const beforeSubmitFailure = await control('/state');
  let injectedPromptFailure = false;
  const rejectPrompt = rejectPromptWithInvalidTimeZone('SUBMIT_FAILURE_DRAFT_CANARY', () => { injectedPromptFailure = true; });
  await context.route('**/api/**', rejectPrompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => input.innerText(), text => injectedPromptFailure && text.includes('SUBMIT_FAILURE_DRAFT_CANARY'), 'Real Host prompt rejection restores the draft after successful creation');
  await context.unroute('**/api/**', rejectPrompt);
  await until(() => page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), Boolean, 'Prompt rejection releases the submit guard');
  const submitFailed = await control('/state');
  assert.equal(submitFailed.roots.length, beforeSubmitFailure.roots.length + 1, 'A submit rejection retains the normally created root');
  assert.equal(submitFailed.requests.length, beforeSubmitFailure.requests.length);
  assert.equal(submitFailed.creationAttempts.length, beforeSubmitFailure.creationAttempts.length + 1);
  report.submitFailure = { injectedAt: 'browser-to-Host prompt request clientTimeZone validation', created: submitFailed.creationAttempts.at(-1), draft: await input.innerText() };
  passed('real-host-submit-rejection-keeps-new-root-restores-draft-and-does-not-send-or-retry');

  await newDraft('SWITCH_DURING_CREATE_CANARY');
  const beforeSwitch = await control('/state');
  await control('/gate-create', {});
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state === 'waiting', 'In-flight creation before switching sessions');
  await page.getByText('Shared contact title', { exact: true }).first().click();
  await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId),
    id => id === fixture.ids.B, 'Switch to B through the normal session list');
  await draft('REPLACEMENT_SESSION_DRAFT_CANARY');
  await control('/release-create', { action: 'continue' });
  await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state !== 'waiting', 'The held Host lifecycle is released after its session view is replaced');
  await page.getByText('Arlo acceptance sender', { exact: true }).first().click();
  await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId),
    id => id === fixture.ids.A, 'Return to A to observe completion of its original submit guard');
  // A's editor is non-editable during submission. The lifecycle listener alone
  // finishes before the complete Host RPC and is not evidence of settlement.
  await input.waitFor();

  const afterSwitch = await control('/state');
  assert.equal(afterSwitch.requests.length, beforeSwitch.requests.length, 'A stale submission must not prompt either the old or replacement session');
  assert.equal(afterSwitch.creationAttempts.length, beforeSwitch.creationAttempts.length + 1, 'Session switching must not retry creation');
  await page.getByText('Shared contact title', { exact: true }).first().click();
  await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId),
    id => id === fixture.ids.B, 'Reopen B after A has settled');
  await input.waitFor();

  assert.equal(await input.innerText(), 'REPLACEMENT_SESSION_DRAFT_CANARY', 'The old preparation must not restore its draft into B');
  assert.deepEqual(afterSwitch.sessions.B.inbox, beforeSwitch.sessions.B.inbox,
    'Switching preserves the replacement session pending inputs, including earlier accepted messages');
  assert.ok(!afterSwitch.roots.some(root => root.events.some(event => event.type === 'user/message'
    && JSON.stringify(event).includes('SWITCH_DURING_CREATE_CANARY'))));
  report.sessionSwitch = { attempt: afterSwitch.creationAttempts.at(-1), selectedSession: fixture.ids.B,
    retainedRoots: afterSwitch.roots.filter(root => !beforeSwitch.roots.some(previous => previous.id === root.id)).map(root => root.id),
    replacementDraft: await input.innerText() };
  await page.getByText('Arlo acceptance sender', { exact: true }).first().click();
  await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current')).sessionId),
    id => id === fixture.ids.A, 'Return to A after checking the replacement draft');
  passed('session-switch-during-preparation-preserves-replacement-draft-without-message-or-retry');

  await newDraft('UNLOAD_DURING_CREATE_CANARY');
  const beforeUnload = await control('/state');
  await control('/gate-create', {});
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state === 'waiting', 'In-flight create before browser unload');
  await page.reload();
  await control('/release-create', { action: 'continue' });
  await input.waitFor();

  const afterUnload = await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state !== 'waiting', 'Owned Host create settles after browser unload');
  assert.equal(afterUnload.requests.length, beforeUnload.requests.length, 'Unloaded submission must not contact A or B');
  assert.equal(afterUnload.creationAttempts.length, beforeUnload.creationAttempts.length + 1, 'Reload must not retry creation');
  report.unload = { attempt: afterUnload.creationAttempts.at(-1), retainedRoots: afterUnload.roots.filter(root => !beforeUnload.roots.some(previous => previous.id === root.id)).map(root => root.id), draft: await input.innerText() };
  passed('browser-unload-cancels-in-flight-creation-without-message-or-automatic-retry');

  await newDraft('ATTACH_FAILURE_DRAFT_CANARY');
  const beforeAttachFailure = await control('/state');
  await control('/gate-create', {});
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await until(() => control('/state'), state => state.creationAttempts.at(-1)?.state === 'waiting', 'New root awaits normal workspace attachment');
  await control('/release-create', { action: 'detach-workspace' });
  await until(() => input.innerText(), text => text.includes('ATTACH_FAILURE_DRAFT_CANARY'), 'Normal Host workspace attachment failure restores draft');
  await until(() => page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), Boolean, 'Attachment failure releases the submit guard');
  const attachFailed = await control('/state');
  assert.equal(attachFailed.roots.length, beforeAttachFailure.roots.length + 1, 'Normal Host attachment failure retains its created root');
  assert.equal(attachFailed.requests.length, beforeAttachFailure.requests.length);
  assert.equal(attachFailed.creationAttempts.length, beforeAttachFailure.creationAttempts.length + 1);
  report.attachFailure = { attempt: attachFailed.creationAttempts.at(-1), draft: await input.innerText() };
  report.finalState = attachFailed;
  passed('real-workspace-attachment-failure-retains-created-root-and-draft-without-send-or-retry');
  }
  }
  assert.deepEqual(report.browserErrors, []);
  assert.deepEqual(report.browserConsole, []);
  assert.deepEqual(report.failedHttpRequests, []);
  assert.deepEqual(report.externalBrowserRequests, []);
  assert.equal(JSON.parse(fs.readFileSync(networkFile, 'utf8')).deniedConnections, 0);
  passed('no-external-model-or-network-requests');
  report.status = 'passed';
} catch (error) {
  report.error = redactDiagnostics(error.stack ?? String(error));
  if (error.cause) report.errorCause = redactDiagnostics(error.cause.stack ?? String(error.cause));
  report.bootTail = redactDiagnostics(boot).slice(-12000);
  if (fixture?.controlUrl) report.failureState = await control('/state').catch(() => undefined);
  if (page) {
    report.pageText = await page.locator('body').innerText().catch(() => 'unavailable');
    await page.screenshot({ path: path.join(dirs.logs, 'failure.png') }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (fixture?.controlUrl) {
    await control('/release-create', { action: 'continue' }).catch(() => {});
    await control('/release', { session: 'A', send: false }).catch(() => {});
    await control('/release', { session: 'B', send: false }).catch(() => {});
    await control('/stop', {}).catch(() => {});
  }
  for (let attempt = 0; child.exitCode === null && attempt < 100; attempt++) await delay(100);
  report.hostExit = child.exitCode;
  if (cliSetup && child.exitCode === 0) {
    try {
      const current = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
      const userPatch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8');
      current.custom.after = true;
      fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify(current));
      assert.equal(runSetup('uninstall').phase, 'removed-pending-reload');
      assert.equal(runSetup('uninstall').phase, 'already-removed');
      assert.equal(runSetup('setup-status').configured, false);
      assert.equal(fs.existsSync(link), false);
      const after = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
      assert.deepEqual(after.custom, { preserve: true, after: true, ...(cliRecovery ? { afterFailedSetup: true } : {}) });
      assert.deepEqual(after.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
      assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), userPatch);
      passed('cli-owned-registration-uninstalled-with-later-profile-edits-preserved');
      if (report.status === 'passed') {
        const { restartAfterUninstall } = await import('./restart-after-uninstall.mjs');
        await restartAfterUninstall({ consumer, dirs, profile, fixtureDirectory, chromium, env, report, passed });
      }
      if (crossHost && report.status === 'passed') {
        const { eventually, inbound, modelText, sendFromNative } = await import('../pi-acceptance/harness.mjs');
        const otherPi = await piRig.start('pi-post-dsh-uninstall', {}, { setup: true });
        await otherPi.ready();
        piRig.handlers.set(otherPi.name, modelText('The remaining installed Pi client received normally.'));
        const marker = 'CLI_DSH_UNINSTALL_SHARED_DAEMON_SURVIVES';
        const sent = await sendFromNative(piRig, piPeer, otherPi.name, marker);
        const received = await eventually(() => piRig.requests.find(request => request.peer === otherPi.name &&
          inbound(request.body, marker)), Boolean, 'remaining Pi clients actively communicate after DSH uninstall');
        const delivery = inbound(received.body, marker);
        assert.equal(delivery.message_id, sent.receipt.message_id);
        assert.deepEqual(piRig.errors, []);
        report.sharedDaemonAfterDshUninstall = {
          sender: piPeer.name, receiver: otherPi.name, receiverHome: otherPi.home,
          receipt: sent.receipt, status: sent.status, receivedMessageId: delivery.message_id,
          boundary: 'Existing native Pi TUI model tools and newly CLI-registered Pi TUI active reception on the original shared Daemon',
        };
        passed('native-cli-pi-clients-communicate-through-original-shared-daemon-after-dsh-uninstall');
      }
    } catch (error) {
      report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
    }
  }
  if (child.exitCode !== 0 && report.status === 'passed') {
    report.status = 'failed';
    report.error = 'Owned DSH host did not exit cleanly.';
    process.exitCode = 1;
  }
  if (child.exitCode === null) {
    child.kill();
    report.cleanup = 'Host did not exit within 10 s; terminated the owned child process.';
  } else report.cleanup = 'Host exited through appExit after releasing held model turns.';
  if (piRig) await piRig.close();
  fs.writeFileSync(path.join(dirs.logs, 'boot.log'), redactDiagnostics(boot));
  report.finishedAt = new Date().toISOString();
  if (fs.existsSync(networkFile)) report.network = JSON.parse(fs.readFileSync(networkFile, 'utf8'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.status}: ${output}${report.error ? `\n${report.error}` : ''}`);
}
