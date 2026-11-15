// Actual installed candidate bubble, history, queue and display lifecycle acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const consumer = path.resolve(process.argv[2]);
const require = createRequire(path.join(consumer, 'package.json'));
const root = fs.mkdtempSync(path.resolve('.scratch/display-'));
console.log('Fixture:', root);
fs.writeFileSync(path.join(root, 'reference.txt'), 'NATIVE_FILE_CANARY\n');
const fixture = path.join(root, 'fixture');
fs.mkdirSync(fixture);
fs.copyFileSync(new URL('display-fixture.mjs', import.meta.url), path.join(fixture, 'host.mjs'));
const display = path.join(root, 'display');
fs.mkdirSync(display);
fs.writeFileSync(path.join(display, 'plugin.mjs'), 'export function apply() {}\n');
fs.copyFileSync(new URL('candidates/0.2.1-rc.2/contact-display.cjs', import.meta.url), path.join(display, 'client.cjs'));
fs.writeFileSync(path.join(display, 'package.json'), JSON.stringify({ name: 'arlo-contact-display', type: 'module', exports: { '.': './plugin.mjs', './client': './client.cjs' }, dsh: { client: { platform: 'web', inject: ['react', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-conversation'] } } }));
fs.symlinkSync(path.join(consumer, 'node_modules'), path.join(display, 'node_modules'));
fs.copyFileSync(new URL('display-client.cjs', import.meta.url), path.join(fixture, 'display.cjs'));
fs.writeFileSync(path.join(fixture, 'plugin.mjs'), 'export function apply() {}\n');
fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'display-observer', type: 'module',
  exports: { '.': './plugin.mjs', './client': './display.cjs' }, dsh: { client: { platform: 'web', inject: [
    '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-input-trigger', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-session-controller' ] } } }));
fs.mkdirSync(path.join(fixture, 'node_modules'));
fs.symlinkSync(display, path.join(fixture, 'node_modules/display-observer'));
fs.symlinkSync(path.join(consumer, 'node_modules/@deepseek-ai'), path.join(fixture, 'node_modules/@deepseek-ai'));
const home = path.join(root, 'home'), profile = path.join(home, 'profiles/web');
fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
fs.symlinkSync(fixture, path.join(profile, 'node_modules/display-observer'));
fs.symlinkSync(display, path.join(profile, 'node_modules/arlo-contact-display'));
fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'submission-profile', private: true, type: 'module',
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
// Resolve all upstream packages from the independent frozen consumer.
fs.symlinkSync(path.join(consumer, 'node_modules/@deepseek-ai'), path.join(profile, 'node_modules/@deepseek-ai'));
const overlay = path.join(root, 'probe.yml');
fs.writeFileSync(overlay, [
  ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'agent-instructions', 'hmr'].map(id => `- id: ${id}\n  disabled: true`),
  '- id: ui-plugin-manager\n  config:\n    registryProbeEnabled: false',
  `- insert:\n    - id: submission-observer\n      name: ${JSON.stringify(pathToFileURL(path.join(fixture, 'host.mjs')).href)}\n    - id: display-observer\n      name: display-observer\n    - id: arlo-contact-display\n      name: arlo-contact-display`,
].join('\n'));
const child = spawn(process.execPath, [require.resolve('@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
  cwd: root, env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
    SUBMISSION_REPORT: path.join(root, 'report.json'), DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', browser, page;
const assets = [], assetReads = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
child.stdout.on('data', data => logs += data);
child.stderr.on('data', data => logs += data);
async function until(read, accept, label) {
  for (let i = 0; i < 300; i++) {
    const value = await read();
    if (accept(value)) return value;
    if (child.exitCode !== null) throw new Error(`Host exited: ${child.exitCode}`);
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const report = await until(() => fs.existsSync(path.join(root, 'report.json')) && JSON.parse(fs.readFileSync(path.join(root, 'report.json'))), Boolean, 'Host');
  const control = async (route = '/state', value) => {
    const response = await fetch(report.control + route, { method: value === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${report.token}` }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const body = await response.json();
    assert.equal(response.ok, true, JSON.stringify(body));
    return body;
  };
  const state = () => control();

  const { serializeContact } = createRequire(new URL('../packages/adapter-dsh/package.json', import.meta.url))('./client.cjs');
  const ep1 = 'ep-cross-host-one', ep2 = 'ep-cross-host-two';
  const label = '联系 同名😀';
  const malformed = '<arlo-contact>{broken}</arlo-contact>\nBAD';
  const invalid = [serializeContact(ep1).replace('endpoint_id', 'unknown'),
    serializeContact(ep1).replace('"ep-cross-host-one"', '42'),
    serializeContact(ep1).replace('do not automatically resend', 'automatically resend'),
    serializeContact(ep1).replace('"endpoint_id":', '"extra":true,"endpoint_id":')];
  const text = `BEFORE ${serializeContact(ep1, label)} MIDDLE ${serializeContact(ep2, label)} AFTER ${malformed} ${invalid.join('\n')} @docs/reference.txt ${serializeContact(ep1, '长😀'.repeat(250))}`;
  await control('/seed', { text });

  const url = await until(() => logs.match(/dsh web: (http:\/\/[^\s]+)/)?.[1], Boolean, 'Web URL');
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.ARLO_BROWSER_EXECUTABLE ? { executablePath: process.env.ARLO_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ locale: 'en-US' });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => console.error('Browser:', error.message));
  page.on('console', message => { if (message.type() === 'error') console.error('Browser:', message.text()); });
  page.on('response', response => { if (response.status() >= 400) console.error('HTTP:', response.status(), new URL(response.url()).pathname); });
  await page.addInitScript(() => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'submission-a' })));
  page.on('response', response => {
    if (response.ok() && response.request().resourceType() === 'script') assetReads.push((async () => {
      const bytes = await response.body();
      assets.push({ url: new URL(response.url()).pathname, sha256: sha(bytes), containsDisplayExtension: bytes.includes(fs.readFileSync(path.join(display, 'client.cjs'))) });
    })());
  });
  await page.goto(url);
  const welcome = page.getByRole('button', { name: 'Continue', exact: true });
  await page.locator('[data-composer-input]').waitFor();
  if (await welcome.isVisible()) await welcome.click();
  const input = page.locator('[data-composer-input]');
  await page.getByText('Display contract', { exact: true }).first().click();
  const submitted = await until(state, s => s.requests.length === 1, 'native prompt');
  assert.ok(JSON.stringify(submitted.requests[0]).includes('<arlo-contact>'), 'Model retains the raw envelope');
  assert.ok(JSON.stringify(submitted.requests[0]).includes('do not automatically resend'));
  const check = async () => {
    await until(() => page.locator(`[title="${ep2}"]`).count(), count => count === 1, 'endpoint chip');
    assert.equal(await page.locator(`[title="${ep1}"]`).count(), 2);
    assert.equal(await page.locator(`[title="${ep2}"]`).innerText(), label);
    assert.ok((await page.locator('body').innerText()).includes(malformed));
    for (const raw of invalid) assert.ok((await page.locator('body').innerText()).includes(raw.trim()));
  };
  await check();
  const before = await state();
  await page.reload();
  await check();
  assert.deepEqual(await state(), before, 'Reload and display do not create roots or call the model');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator(`[title="${ep2}"]`).evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.keyboard.press('ControlOrMeta+C');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), label);
  assert.deepEqual(await state(), before, 'Copy is presentation-only');
  await control('/hold');
  await control('/queue', { text: 'BLOCKING_TURN' });
  await until(state, value => value.requests.length === 2, 'held model request');
  const queuedText = `QUEUE_BEGIN ${serializeContact('ep-queue-one', label)} ${serializeContact('ep-queue-two', '长😀'.repeat(250))} ${invalid.join('\n')} QUEUE_END`;
  await control('/queue', { text: queuedText });
  await until(() => page.locator('[title="ep-queue-two"]').count(), count => count === 1, 'native queue reference after long envelope');
  const queueChip = page.locator('[title="ep-queue-two"]');
  assert.equal(await queueChip.innerText(), '长😀'.repeat(250), 'CSS truncation happens after recognition');
  const queueBefore = await state();
  assert.ok(JSON.stringify(queueBefore.queue).includes(JSON.stringify(queuedText).slice(1, -1)));
  await page.reload();
  await until(() => queueChip.count(), count => count === 1, 'queue reload');
  assert.deepEqual(await state(), queueBefore);
  await delay(500);
  await input.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace'); await page.keyboard.type('@');
  await page.getByRole('option', { name: 'Unload display extension', exact: true }).click();
  await until(() => page.locator('[title="ep-queue-two"]').count(), count => count === 0, 'extension removal');
  assert.ok((await page.locator('body').innerText()).includes('<arlo-contact>'));
  await delay(500);
  await input.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace'); await page.keyboard.type('@');
  await page.getByRole('option', { name: 'Reload display extension', exact: true }).click();
  await until(() => page.locator('[title="ep-queue-two"]').count(), count => count === 1, 'extension registration restored exactly once');
  assert.deepEqual(await state(), queueBefore);
  console.log('PASS native queue: original content, long Unicode label, endpoint identity, reload and extension cleanup');
  console.log('PASS native bubble/history/copy: ordered contacts, distinct endpoints, Unicode, malformed fallback, raw model semantics');
  await Promise.all(assetReads);
  assert.ok(assets.some(asset => asset.containsDisplayExtension), 'Browser fetched the exact reviewed extension bytes');
  const seedDir = path.join(path.dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist/assets');
  const seedHashes = new Set(fs.readdirSync(seedDir).filter(file => file.endsWith('.js')).map(file => sha(fs.readFileSync(path.join(seedDir, file)))));
  assert.ok(assets.some(asset => seedHashes.has(asset.sha256)), 'Browser fetched an unchanged installed native seed');
  fs.writeFileSync(path.join(root, 'browser-assets.json'), JSON.stringify(assets, null, 2));
  console.log('DISPLAY_CONTRACT_PASSED', root);
} catch (error) {
  if (page) console.error('Page:', (await page.locator('body').innerText()).slice(-5000));
  console.error(logs.replace(/token=[^\s]+/g, 'token=<redacted>').slice(-6000));
  throw error;
} finally {
  await browser?.close();
  child.kill('SIGTERM');
}
