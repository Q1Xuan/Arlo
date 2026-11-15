// Real installed composer occurrences -> trusted ordinary Host creation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const consumer = path.resolve(process.argv[2]);
const require = createRequire(path.join(consumer, 'package.json'));
const root = fs.mkdtempSync(path.resolve('.scratch/submission-'));
fs.writeFileSync(path.join(root, 'reference.txt'), 'NATIVE_FILE_CANARY\n');
const fixture = path.join(root, 'fixture');
fs.mkdirSync(fixture);
for (const [source, target] of [['submission-fixture.mjs', 'host.mjs'], ['submission-client.cjs', 'client.cjs']]) {
  fs.copyFileSync(new URL(source, import.meta.url), path.join(fixture, target));
}
fs.copyFileSync(new URL('../packages/adapter-dsh/host-create.mjs', import.meta.url), path.join(fixture, 'host-create.mjs'));
fs.writeFileSync(path.join(fixture, 'plugin.mjs'), "export const inject = ['typert', 'submissionObserver'];\nexport function apply(ctx) { ctx.submissionObserver.mount(ctx); }\n");
fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'submission-contract', type: 'module',
  exports: { '.': './plugin.mjs', './client': './client.cjs' }, dsh: { client: { platform: 'web', inject: [
    '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-input-trigger', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-session-controller' ] } } }));
fs.symlinkSync(path.join(consumer, 'node_modules'), path.join(fixture, 'node_modules'));
const home = path.join(root, 'home'), profile = path.join(home, 'profiles/web');
fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
fs.symlinkSync(fixture, path.join(profile, 'node_modules/submission-contract'));
fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'submission-profile', private: true, type: 'module',
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
// Resolve all upstream packages from the independent frozen consumer.
fs.symlinkSync(path.join(consumer, 'node_modules/@deepseek-ai'), path.join(profile, 'node_modules/@deepseek-ai'));
const overlay = path.join(root, 'probe.yml');
fs.writeFileSync(overlay, [
  ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'agent-instructions', 'hmr'].map(id => `- id: ${id}\n  disabled: true`),
  '- id: ui-plugin-manager\n  config:\n    registryProbeEnabled: false',
  `- insert:\n    - id: submission-observer\n      name: ${JSON.stringify(pathToFileURL(path.join(fixture, 'host.mjs')).href)}\n    - id: submission-contract\n      name: submission-contract`,
].join('\n'));
const child = spawn(process.execPath, [require.resolve('@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
  cwd: root, env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
    SUBMISSION_REPORT: path.join(root, 'report.json'), DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', browser, page;
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
  const url = await until(() => logs.match(/dsh web: (http:\/\/[^\s]+)/)?.[1], Boolean, 'Web URL');
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.ARLO_BROWSER_EXECUTABLE ? { executablePath: process.env.ARLO_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ locale: 'en-US' });
  page.on('pageerror', error => console.error('Browser:', error.message));
  page.on('console', message => { if (message.type() === 'error') console.error('Browser:', message.text()); });
  page.on('response', response => { if (response.status() >= 400) console.error('HTTP:', response.status(), new URL(response.url()).pathname); });
  await page.addInitScript(() => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'submission-a' })));
  await page.goto(url);
  const welcome = page.getByRole('button', { name: 'Continue', exact: true });
  await Promise.race([welcome.waitFor(), page.locator('[data-composer-input]').waitFor()]);
  if (await welcome.isVisible()) await welcome.click();
  const input = page.locator('[data-composer-input][contenteditable="true"]').first();
  await input.waitFor();
  await input.click();
  await page.keyboard.insertText('@');
  await page.getByRole('option').filter({ hasText: 'Contract new root' }).click({ timeout: 10000 });
  assert.equal((await state()).creations.length, 0, 'Picking is pure');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await input.click(); await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C'); await page.keyboard.press('ControlOrMeta+C');
  await page.keyboard.press('Backspace');
  assert.equal((await state()).creations.length, 0, 'Deleting a selected draft is pure');
  await page.keyboard.press('ControlOrMeta+V');
  await until(() => input.innerText(), text => text.includes('<draft-root/>'), 'native paste preserves copied marker text');
  assert.equal(await input.locator('[data-composer-chip]').count(), 0, 'Plain-text paste cannot manufacture selected provenance');
  assert.equal((await state()).creations.length, 0, 'Copy/paste and repeated serialization are pure');
  await input.click(); await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('@');
  await page.getByRole('option').filter({ hasText: 'Contract new root' }).click();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const submitted = await until(state, s => s.requests.length === 1, 'submit to model');
  assert.equal(submitted.creations.length, 1);
  assert.equal(submitted.creations[0].caller, 'submission-a');
  assert.ok(JSON.stringify(submitted.requests[0]).includes(submitted.creations[0].id));
  console.log('PASS explicit-submit-creates-one-ordinary-root-for-bound-session');
  // Same ref value, distinct real Lexical occurrences: each must create once.
  const append = async text => { await input.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(text); };
  const pickNew = async () => { await append(' @'); await page.getByRole('option').filter({ hasText: 'Contract new root' }).click(); };
  await pickNew();
  await append(' FIRST_SLOT');
  await append(' @');
  await page.getByRole('option').filter({ hasText: 'Contract existing contact' }).click();
  await append(' @reference.txt');
  await page.getByRole('option').filter({ hasText: 'reference.txt' }).click();
  await append(' @submission-b');
  await page.getByRole('option', { name: /^submission-b (now|.*ago)$/ }).click();
  await pickNew();
  await append(' SECOND_SLOT');
  assert.equal(await input.locator('[data-composer-chip]').count(), 5);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await input.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  await page.keyboard.press('ArrowRight');
  assert.equal((await state()).creations.length, 1, 'Copying and repeated serialization are pure');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const multi = await until(state, s => s.requests.length === 2, 'multiple occurrences');
  assert.equal(multi.creations.length, 3);
  assert.notEqual(multi.creations[1].id, multi.creations[2].id);
  const prompt = JSON.stringify(multi.requests.at(-1).messages);
  assert.match(prompt, new RegExp(`${multi.creations[1].id}.*FIRST_SLOT.*${multi.creations[2].id}.*SECOND_SLOT`));
  assert.match(prompt, /existing-contact/);
  assert.match(prompt, /reference\.txt/);
  assert.match(prompt, /submission-b/);
  console.log('PASS duplicate-occurrences-create-in-order-among-real-file-and-history-references');
  await append('<draft-root/> PLAIN_PASTE');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const plain = await until(state, s => s.requests.length === 3, 'plain marker text');
  assert.equal(plain.creations.length, 3, 'Plain text cannot authorize creation');
  console.log('PASS selection-copy-and-plain-text-have-no-creation-side-effects');
  await control('/mode', { failAt: plain.calls.length + 2 });
  await pickNew(); await append(' PARTIAL_FAILURE'); await pickNew();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const failed = await until(state, s => s.calls.at(-1)?.state === 'failed', 'second creation fails');
  await until(() => input.innerText(), text => text.includes('PARTIAL_FAILURE'), 'draft restoration');
  assert.equal(await input.locator('[data-composer-chip]').count(), 2);
  assert.equal(failed.requests.length, 3, 'No partially prepared prompt');
  assert.equal(failed.creations.length, 4);
  assert.ok(failed.roots.includes(failed.creations.at(-1).id), 'Published ordinary root survives failure');
  await delay(400);
  assert.equal((await state()).calls.length, failed.calls.length, 'No implicit retry');
  console.log('PASS partial-failure-retains-draft-and-published-root-without-prompt-or-retry');
  if (!process.argv.includes('--baseline')) {
    await input.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
    await append('@');
    await page.getByRole('option').filter({ hasText: 'Contract deferred root' }).click();
    await append(' SERIALIZATION_CANCEL');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await input.click(); await page.keyboard.insertText('@');
    await page.getByRole('option', { name: 'Replace preparation and release serializer', exact: true }).click();
    await until(() => input.innerText(), text => text.includes('SERIALIZATION_CANCEL'), 'withdrawn serialization restores draft');
    assert.equal((await state()).requests.length, 3, 'Withdrawn source cannot submit a marker or adopt a replacement preparation');
    assert.equal((await state()).calls.length, failed.calls.length);
    console.log('PASS source-lifetime-is-captured-before-asynchronous-serialization');
    await input.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('@');
    await page.getByRole('option', { name: 'Contract deferred root', exact: true }).click();
    await append(' STALE_SERIALIZATION');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await input.click(); await page.keyboard.insertText('@');
    await page.getByRole('option', { name: 'Replace preparation without releasing serializer', exact: true }).click();
    await page.getByText('submission-b', { exact: true }).first().click();
    await page.getByText('submission-a', { exact: true }).first().click();
    await until(() => input.innerText(), text => text.includes('STALE_SERIALIZATION'), 'cancelled serializer draft retained');
    await input.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('AUTHORITATIVE_EDIT');
    await page.getByText('submission-b', { exact: true }).first().click();
    await page.getByText('submission-a', { exact: true }).first().click();
    assert.equal((await input.innerText()).trim(), 'AUTHORITATIVE_EDIT', 'Later edits must replace the already-restored snapshot');
    await append(' @');
    await page.getByRole('option', { name: 'Release old serializer', exact: true }).click();
    await delay(400);
    assert.equal((await state()).requests.length, 3);
    assert.equal((await state()).calls.length, failed.calls.length);
    assert.equal((await input.innerText()).trim(), 'AUTHORITATIVE_EDIT');
    console.log('PASS late-serializer-settlement-does-not-resurrect-edited-drafts');
    await input.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
    await control('/mode', { holdAt: failed.calls.length + 2 });
    await pickNew(); await append(' PUBLISHED_BEFORE_CANCEL'); await pickNew(); await append(' SWITCH_CANCEL');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await until(state, s => s.calls.at(-1)?.state === 'entered', 'creation held');
    await append('LATER_TYPED_SUFFIX');
    await page.getByText('submission-b', { exact: true }).first().click();
    const switched = await until(state, s => s.calls.at(-1)?.state === 'aborted', 'switch cancels creation');
    assert.equal(switched.requests.length, 3);
    assert.equal(switched.creations.length, failed.creations.length + 1);
    assert.ok(switched.roots.includes(switched.creations.at(-1).id));
    await page.getByText('submission-a', { exact: true }).first().click();
    await until(() => input.innerText(), text => text.includes('SWITCH_CANCEL'), 'switched draft retained');
    assert.match(await input.innerText(), /LATER_TYPED_SUFFIX/);
    console.log('PASS session-switch-cancels-preparation-and-retains-real-reference-draft');
    assert.equal(await input.locator('[data-composer-chip]').count(), 2);
    await input.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
    const rejectUpload = route => route.request().headers()['content-type'] === 'application/octet-stream' ? route.abort() : route.fallback();
    await page.context().route('**/*', rejectUpload);
    await pickNew(); await append(' ATTACHMENT_INVALID');
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'blocked.txt', mimeType: 'text/plain', buffer: Buffer.from('blocked upload') });
    await page.getByRole('button', { name: 'Remove file blocked.txt', exact: true }).waitFor();
    await until(() => page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), enabled => !enabled, 'attachment validation blocks submit');
    await input.click(); await page.keyboard.press('Enter');
    assert.equal((await state()).calls.length, switched.calls.length, 'Invalid attachment cannot create a root');
    await page.getByRole('button', { name: 'Remove file blocked.txt', exact: true }).click();
    await page.context().unroute('**/*', rejectUpload);
    await input.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
    await control('/mode', { holdAt: switched.calls.length + 1 });
    await pickNew(); await append(' UNLOAD_CANCEL');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await until(state, s => s.calls.at(-1)?.state === 'entered', 'unload creation held');
    await pickNew(); await append(' DUPLICATE_GUARD');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await until(() => input.innerText(), text => text.includes('DUPLICATE_GUARD'), 'duplicate preparation rejected with draft');
    assert.equal((await state()).calls.length, switched.calls.length + 1);
    await control('/unload');
    const unloaded = await until(state, s => s.calls.at(-1)?.state === 'aborted', 'plugin unload cancels creation');
    await until(() => input.innerText(), text => text.includes('UNLOAD_CANCEL'), 'unload retains original draft');
    assert.equal(unloaded.requests.length, 3);
    assert.equal(unloaded.creations.length, switched.creations.length);
    await delay(400);
    assert.equal((await state()).calls.length, unloaded.calls.length);
    console.log('PASS attachment-rejection-duplicate-guard-and-plugin-unload');
  }
  console.log('SUBMISSION_CONTRACT_PASSED');
} catch (error) {
  if (page) console.error('Page:', (await page.locator('body').innerText()).slice(-5000));
  console.error(logs.replace(/token=[^\s]+/g, 'token=<redacted>').slice(-6000));
  throw error;
} finally {
  await browser?.close();
  child.kill('SIGTERM');
}
