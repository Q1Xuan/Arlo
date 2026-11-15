import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/** Restart the same real Web/profile after uninstall, using only a test model. */
export async function restartAfterUninstall({ consumer, dirs, profile, fixtureDirectory, chromium, env, report, passed }) {
  const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const histories = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.jsonl(?:\.zstd)?$/.test(entry.name)) histories.push(file);
    }
  };
  for (const directory of [dirs.home, dirs.config, dirs.local, dirs.project]) walk(directory);
  assert.ok(histories.length > 0, 'The preceding native run must have persisted real session history and root headers');
  const configFiles = ['package.json', 'cordis.patch.yml', 'arlo.json'].map(name => path.join(profile, name)).filter(fs.existsSync);
  const preserved = [...new Set([...histories, ...configFiles])].map(file => ({ file, sha256: digest(file) }));
  const profilePatch = path.join(profile, 'cordis.patch.yml');
  const originalProfilePatch = fs.existsSync(profilePatch) ? fs.readFileSync(profilePatch) : undefined;
  const observer = path.join(fixtureDirectory, 'restart-observer.mjs');
  fs.copyFileSync(new URL('./restart-fixture.mjs', import.meta.url), observer);
  const overlay = path.join(dirs.logs, 'restart-after-uninstall.patch.yml');
  fs.writeFileSync(overlay, [
    ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'agent-instructions', 'hmr'].map(id => `- id: ${id}\n  disabled: true`),
    '- id: ui-plugin-manager\n  config:\n    registryProbeEnabled: false',
    '- insert:', `    - id: arlo-uninstalled-web-observer\n      name: ${JSON.stringify(pathToFileURL(observer).href)}`,
  ].join('\n') + '\n');
  const fixtureReport = path.join(dirs.logs, 'restart-fixture.json');
  const network = path.join(dirs.logs, 'restart-network.json');
  const argv = [path.join(consumer, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'];
  const child = spawn(process.execPath, argv, { cwd: dirs.project, windowsHide: true,
    env: { ...env, ARLO_WEB_FIXTURE_REPORT: fixtureReport, ARLO_LOW_LEVEL_NETWORK_FILE: network }, stdio: ['ignore', 'pipe', 'pipe'] });
  let boot = '', fixture, browser;
  const evidence = report.afterUninstallRestart = { command: { executable: process.execPath, argv, cwd: dirs.project },
    observerSha256: digest(observer), overlaySha256: digest(overlay), preserved, historyFiles: histories.length };
  child.stdout.on('data', chunk => { boot += chunk; });
  child.stderr.on('data', chunk => { boot += chunk; });
  const until = async (read, predicate, label, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await read();
      if (predicate(value)) return value;
      if (child.exitCode !== null) throw new Error(`Restarted DSH exited ${child.exitCode}: ${label}`);
      await delay(100);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const control = async (route, method = 'GET') => {
    const response = await fetch(fixture.controlUrl + route, { method, headers: { authorization: `Bearer ${fixture.token}` } });
    assert.ok(response.ok); return response.json();
  };
  try {
    fixture = await until(() => {
      try { return JSON.parse(fs.readFileSync(fixtureReport, 'utf8')); } catch { return undefined; }
    }, value => value?.ready || value?.errors?.length, 'ordinary restarted Host observer');
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.runtime.executable, process.execPath);
    assert.equal(fixture.runtime.node, process.version);
    assert.equal(fixture.plugins.some(plugin => plugin.name === '@arlo/adapter-dsh'), false);
    const authenticatedUrl = await until(() => boot.match(/dsh web: (http:\/\/[^\s]+)/)?.[1], Boolean, 'restarted native Web URL');
    browser = await chromium.launch({ headless: true, ...(process.env.ARLO_BROWSER_EXECUTABLE ? { executablePath: process.env.ARLO_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ locale: 'en-US' });
    const external = [], errors = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      external.push(url.origin); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(id => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })), fixture.sessionId);
    await page.goto(authenticatedUrl);
    const input = page.locator('[data-composer-input][contenteditable="true"]').first();
    await input.waitFor();
    const graph = await page.evaluate(() => window.__DSH_BOOT__.entries.map(entry => entry.id));
    assert.equal(graph.some(id => id === '@arlo/adapter-dsh' || id.startsWith('@arlo/adapter-dsh/')), false);
    evidence.onboardingActions = [];
    for (const name of ['Continue', 'Configure later']) {
      const button = page.getByRole('button', { name, exact: true });
      try { await button.waitFor({ state: 'visible', timeout: 5000 }); }
      catch (error) { if (error.name === 'TimeoutError') continue; throw error; }
      await button.click();
      evidence.onboardingActions.push(name);
    }
    await input.click();
    await page.keyboard.insertText('CLI_DSH_AFTER_UNINSTALL_ORDINARY_WORK');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const state = await until(() => control('/state'), state => state.requests.length > 0 &&
      state.roots.some(root => root.id === fixture.sessionId && root.status === 'idle'), 'ordinary restarted native model turn settles');
    assert.ok(state.requests.some(request => JSON.stringify(request.messages).includes('CLI_DSH_AFTER_UNINSTALL_ORDINARY_WORK')));
    assert.equal(state.requests.some(request => request.tools.some(tool => tool.startsWith('arlo_'))), false);
    await page.getByText('Ordinary local work succeeds after Arlo uninstall.', { exact: true }).waitFor();
    assert.deepEqual(state.errors, []); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    Object.assign(evidence, { runtime: state.runtime, plugins: state.plugins, browserModuleIds: graph,
      requests: state.requests, ordinarySessionId: fixture.sessionId });
  } catch (error) {
    evidence.error = error.stack ?? String(error);
    throw error;
  } finally {
    await browser?.close();
    if (fixture?.controlUrl) await control('/stop', 'POST').catch(error => { evidence.shutdownError = String(error); });
    for (let attempt = 0; child.exitCode === null && attempt < 100; attempt++) await delay(100);
    evidence.exitCode = child.exitCode;
    evidence.signal = child.signalCode;
    const redacted = boot.replace(/token=[^\s)]+/g, 'token=<redacted>');
    fs.writeFileSync(path.join(dirs.logs, 'restart-boot.log'), fixture?.token ? redacted.replaceAll(fixture.token, '<redacted>') : redacted);
    if (child.exitCode === null) { child.kill(); evidence.cleanup = 'Owned restarted Host did not stop through appExit in 10 seconds'; }
  }
  assert.equal(evidence.exitCode, 0, 'Restarted Host exits normally through appExit');
  assert.equal(evidence.signal, null);
  for (const { file, sha256 } of preserved) {
    if (file === profilePatch && digest(file) !== sha256 && evidence.onboardingActions.includes('Continue')) {
      const acknowledgment = Buffer.from('- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n');
      assert.deepEqual(fs.readFileSync(file), Buffer.concat([originalProfilePatch, acknowledgment]),
        'The observed native Continue action may only append its exact welcome preference; every original profile/model byte stays unchanged');
      evidence.nativePreferenceAcknowledgment = { file, beforeSha256: sha256, afterSha256: digest(file),
        appendedSha256: createHash('sha256').update(acknowledgment).digest('hex'), action: 'Continue' };
    } else assert.equal(digest(file), sha256, `Uninstall and ordinary restart preserve existing bytes: ${file}`);
  }
  evidence.preservedAfter = preserved.map(({ file }) => ({ file, sha256: digest(file) }));
  evidence.network = JSON.parse(fs.readFileSync(network, 'utf8'));
  assert.equal(evidence.network.deniedConnections, 0);
  passed('same-native-dsh-profile-restarts-without-arlo-and-keeps-model-config-history-and-root-headers');
}
