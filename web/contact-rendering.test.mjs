import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--consumer', 'Usage: node web/contact-rendering.test.mjs --consumer DIR');
const consumerRequire = createRequire(path.join(path.resolve(args[1]), 'package.json'));
const dshRequire = createRequire(consumerRequire.resolve('@deepseek-ai/dsh/package.json'));
const frontendRequire = createRequire(dshRequire.resolve('@deepseek-ai/dsh-host-frontend-static/package.json'));
const primitives = fs.readFileSync(frontendRequire.resolve('@deepseek-ai/dsh-client-ui-primitives'), 'utf8');
const seed = fs.readFileSync(path.join(path.dirname(frontendRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')),
  'dist/assets/index-5SrrfWpU.js'), 'utf8');
const { serializeContact } = consumerRequire('@arlo/adapter-dsh/client');

// Execute the installed functions. Only JSX and their visual dependencies are stubbed.
const jsx = (type, props, key) => ({ type, props, key });
const css = { plainRun: 'plainRun', refChip: 'refChip', refIcon: 'refIcon', slashChip: 'slashChip' };
const clsx = (...parts) => parts.filter(Boolean).join(' ');
function loadProjection(source, begin, end, name) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start);
  assert.ok(start >= 0 && finish > start, `Expected installed ${name} boundaries`);
  const context = vm.createContext({ jsx, jsxs: jsx, Fragment: 'Fragment', clsx,
    css$22: css, markdownCss: {}, ReferenceIconRegular: 'ReferenceIconRegular',
    l: { jsx, jsxs: jsx, Fragment: 'Fragment' }, ue: clsx, no: css, dt: {}, e8: 'ReferenceIconRegular' });
  vm.runInContext(source.slice(start, finish), context);
  assert.equal(typeof context[name], 'function');
  return (text, slashNames = [], references, previewChars) => context[name](text, [], slashNames, 'skill', references, previewChars);
}
const fromPackage = loadProjection(primitives, '//#region lib/types/user-text.js', '//#endregion', 'projectUserText');
const fromSeed = loadProjection(seed, 'const A3=', 'const Nk=', 'Tk');
const conversation = fs.readFileSync(dshRequire.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8');
function loadQueueProjection(projection) {
  const begin = conversation.indexOf('const EMPTY_QUEUE = []');
  const end = conversation.indexOf('function textOf(content)', begin);
  assert.ok(begin >= 0 && end > begin, 'Expected installed QueueDock preview boundaries');
  const expression = conversation.match(/children: ([^\n]*\b(?:previewOf|projectQueuePreview)\(row\.content\)[^\n]*)/u)?.[1];
  assert.ok(expression, 'Read the actual installed admitted-queue render expression');
  const context = vm.createContext({ _deepseek_ai_dsh_client_ui_primitives: {
    projectUserText: (text, _sessions, slashNames, _kind, references, previewChars) => projection(text, slashNames, references, previewChars),
  } });
  vm.runInContext(conversation.slice(begin, end), context);
  return content => { context.row = { content }; return vm.runInContext(`(${expression})`, context); };
}
const queueProjections = [fromPackage, fromSeed].map(loadQueueProjection);
const visibleText = node => node == null || node === false ? '' : Array.isArray(node) ? node.map(visibleText).join('')
  : typeof node === 'string' || typeof node === 'number' ? String(node) : visibleText(node.props?.children);
const nodes = node => node && typeof node === 'object'
  ? [node, ...[].concat(node.props?.children ?? []).flatMap(nodes)] : [];
const endpoint = 'ep-a42660f0-e9d5-4acd-af4b-c13c48e5023e';
const label = '联系 无标题会话 · ep-a4266';
const legacy = serializeContact(endpoint);
const contact = serializeContact(endpoint, label);

function project(text) {
  const packaged = fromPackage(text);
  const seeded = fromSeed(text);
  assert.equal(JSON.stringify(seeded), JSON.stringify(packaged), 'Browser seed and package projection must agree');
  return seeded;
}

test('contact label uses native session icon, chip class and endpoint tooltip', () => {
  const tree = project(`${contact}写一首诗`);
  const chip = nodes(tree).find(node => node.props['data-ref-chip'] === 'session');
  assert.ok(chip);
  assert.equal(chip.props.title, endpoint);
  assert.equal(chip.props.className, 'refChip');
  assert.equal(nodes(tree).find(node => node.type === 'ReferenceIconRegular').props.kind, 'session');
  assert.equal(visibleText(tree), `${label}写一首诗`);
});

test('legacy contact shows a stable short endpoint', () => {
  assert.equal(visibleText(project(`${legacy}旧正文`)), 'Arlo · ep-a4266旧正文');
});

test('contact-only submission survives trimming', () => {
  assert.equal(visibleText(project(contact.trim())), label);
});

test('multiple references retain order and all surrounding text', () => {
  assert.equal(visibleText(project(`前\n${contact}中间\n${legacy}后\n`)), `前\n${label}中间\nArlo · ep-a4266后\n`);
});

test('title punctuation remains text, including brackets and HTML-like characters', () => {
  const title = '联系 标题 ] <b> & > · ep-a4266';
  const tree = project(serializeContact(endpoint, title));
  assert.equal(visibleText(tree), title);
  assert.ok(!nodes(tree).some(node => node.type === 'b'));
});

test('multiline and tabbed titles remain compact contact labels', () => {
  assert.equal(visibleText(project(serializeContact(endpoint, '联系 第一行\n第二行\t标题'))), '联系 第一行 第二行 标题');
});

for (const [name, raw] of [
  ['malformed JSON', legacy.replace(JSON.stringify({ endpoint_id: endpoint }), '{not json}')],
  ['non-string endpoint', legacy.replace(JSON.stringify({ endpoint_id: endpoint }), '{"endpoint_id":42}')],
  ['empty endpoint', legacy.replace(JSON.stringify({ endpoint_id: endpoint }), '{"endpoint_id":""}')],
  ['unknown payload fields', legacy.replace(JSON.stringify({ endpoint_id: endpoint }), JSON.stringify({ endpoint_id: endpoint, other: 'show me' }))],
  ['tag without guidance', `<arlo-contact>${JSON.stringify({ endpoint_id: endpoint })}</arlo-contact>\n正文`],
  ['changed guidance', legacy.replace('do not automatically resend', 'automatically resend')],
  ['unterminated guidance', `${legacy.trim()}正文`],
]) {
  test(`${name} remains fully visible`, () => assert.equal(visibleText(project(raw)), raw));
}

test('native session references keep their original rendering', () => {
  assert.equal(visibleText(project('@[原生会话](dsh-session:ImEi) hi')), '原生会话 hi');
});

test('contacts retain native file and skill previews and surrounding ordinary text', () => {
  for (const projection of [fromPackage, fromSeed]) {
    const opened = [];
    const tree = projection(`${contact}@docs/reference.txt /review /ordinary text`, ['review'], {
      openFile: value => opened.push(['file', value]),
      openSkill: value => opened.push(['skill', value]),
    });
    const chips = nodes(tree).filter(node => node.props?.['data-ref-chip']);
    assert.deepEqual(chips.map(node => node.props['data-ref-chip']), ['session', 'file', 'skill']);
    assert.equal(chips[0].props.title, endpoint);
    assert.equal(chips[0].type, 'span', 'A contact does not acquire file or skill preview behavior');
    assert.equal(visibleText(tree), `${label}reference.txt /review /ordinary text`);
    for (const chip of chips.slice(1)) chip.props.onClick({ detail: 0 });
    assert.deepEqual(opened, [['file', 'docs/reference.txt'], ['skill', 'review']]);
  }
});

test('actual installed queue preprocessing keeps the complete contact envelope until projection', () => {
  for (const projection of queueProjections) {
    const tree = projection([{ type: 'text', text: `${contact} QUEUED_BODY_CANARY` }]);
    const chip = nodes(tree).find(node => node.props?.['data-ref-chip'] === 'session');
    assert.ok(chip, 'Queue preprocessing must not flatten or truncate contact guidance before recognition');
    assert.equal(chip.props.title, endpoint);
    assert.equal(visibleText(tree), `${label} QUEUED_BODY_CANARY`);
    assert.ok(!visibleText(tree).includes('<arlo-contact>'));
  }
});

test('queue preview bounds visible Unicode text while preserving full endpoint tooltips', () => {
  for (const projection of queueProjections) {
    for (const text of [`${contact}${'正文😀'.repeat(160)}`, serializeContact(endpoint, '很长😀'.repeat(160))]) {
      const tree = projection([{ type: 'text', text }]);
      assert.equal(Array.from(visibleText(tree)).length, 201, '200 visible code points plus the existing ellipsis');
      assert.ok(visibleText(tree).endsWith('…'));
      assert.equal(nodes(tree).find(node => node.props?.['data-ref-chip'] === 'session').props.title, endpoint);
    }
  }
});

test('queue plain text and malformed contact envelopes retain their original compact preview rule', () => {
  for (const projection of queueProjections) {
    for (const raw of ['  ordinary\n text\t' + '正文😀'.repeat(100), `<arlo-contact>{broken}</arlo-contact>\n${'raw '.repeat(80)}`]) {
      const compact = Array.from(raw.replace(/\s+/g, ' ').trim());
      const expected = compact.length > 200 ? `${compact.slice(0, 200).join('')}…` : compact.join('');
      assert.equal(visibleText(projection([{ type: 'text', text: raw }])), expected);
    }
  }
});

test('a queued contact retains native file and history references and unselected slash text', () => {
  for (const projection of queueProjections) {
    const tree = projection([{ type: 'text', text: `${contact} @docs/reference.txt @[Historical](dsh-session:ImEi) /review text` }]);
    const chips = nodes(tree).filter(node => node.props?.['data-ref-chip']);
    assert.deepEqual(chips.map(node => node.props['data-ref-chip']), ['session', 'file', 'session']);
    assert.equal(chips[0].props.title, endpoint);
    assert.equal(chips[1].props.title, '@docs/reference.txt');
    assert.equal(chips[2].props.title, '@[Historical](dsh-session:ImEi)');
    assert.equal(visibleText(tree), `${label} reference.txt Historical /review text`);
  }
});
