import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventually, inbound, lastTool, modelText, modelTool, nativeScenario, sendFromNative } from './harness.mjs';

const draft = peer => peer.events().findLast(event => event.type === 'draft')?.text;
const paste = (peer, text) => peer.write(`\x1b[200~${text}\x1b[201~`);

async function chooseHost(peer, key = '\r') {
  const offset = peer.output.length;
  peer.write('@');
  await eventually(() => peer.output.slice(offset), text => text.includes('Arlo · Pi'), 'live host row');
  peer.write(key);
  await eventually(() => peer.output.slice(offset), text => text.includes('Arlo · Pi: select session'), 'session selector');
}

async function setDraft(peer, text) {
  const offset = peer.events().length;
  peer.editorAction({ type: 'draft', text });
  await eventually(() => peer.events().slice(offset), events => events.some(event => event.type === 'editor_action'), 'public editor draft change');
  await eventually(() => draft(peer), current => current === text, 'new draft observed');
}

test('native @ selects a live Pi endpoint in the current draft and explicit submission sends, replies and queries reception',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('contacts-roundtrip');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo');
    await bravo.ready();
    const prefix = 'Send our conclusion to ';
    const suffix = ' after reviewing it.';
    alpha.write(`\x1b[200~${prefix}${suffix}\x1b[201~`);
    await eventually(() => draft(alpha), text => text === prefix + suffix, 'existing native draft');
    alpha.write('\x02'.repeat(suffix.length) + '@');
    await eventually(() => alpha.output, text => text.includes('Arlo · Pi'), 'native @ host candidates');
    alpha.write('\t');
    await eventually(() => alpha.output, text => text.includes('Arlo · Pi: select session'), 'live session selector');
    alpha.write('\r');
    const selected = await eventually(() => draft(alpha), text => /@arlo:pi:ep-[0-9a-f-]+/.test(text ?? ''),
      'full endpoint inserted at the original cursor');
    assert.match(selected, /^Send our conclusion to @arlo:pi:ep-[0-9a-f-]+  after reviewing it\.$/);
    assert.equal(rig.requests.length, 0, 'Choosing a contact neither starts the model nor invokes send');
    assert.equal(alpha.events().filter(event => event.type === 'tool_execution_end').length, 0);
    const endpoint = selected.match(/@arlo:pi:(ep-[0-9a-f-]+)/)[1];
    alpha.write('PI_CONTACT_REQUEST: ');
    await eventually(() => draft(alpha), text => text?.includes('PI_CONTACT_REQUEST:  after reviewing it.'),
      'editing continues immediately after the mention');
    let sent, replied, alphaStep = 0, bravoStep = 0;
    rig.handlers.set('alpha', request => {
      const source = inbound(request.body, 'PI_CONTACT_REPLY');
      if (source) {
        assert.equal(source.reply_to, sent.message_id);
        return modelText('The associated reply arrived.')(request);
      }
      if (alphaStep++ === 0) {
        assert.ok(JSON.stringify(request.body).includes(endpoint));
        return modelTool('arlo_send_message', { to: endpoint, text: 'PI_CONTACT_CONCLUSION: context organized by the current model.' })(request);
      }
      if (alphaStep === 2) {
        sent = lastTool(request.body);
        assert.equal(sent.status, 'accepted');
        return modelTool('arlo_get_message_status', { message_id: sent.message_id })(request);
      }
      assert.equal(lastTool(request.body).status, 'accepted');
      return modelText('The receiving host accepted the conclusion.')(request);
    });
    rig.handlers.set('bravo', request => {
      if (bravoStep++ === 0) {
        const source = inbound(request.body, 'PI_CONTACT_CONCLUSION');
        assert.ok(source);
        assert.equal(source.text.includes('PI_CONTACT_REQUEST'), false, 'The model sends its organized message');
        return modelTool('arlo_send_message', { to: source.from_endpoint, reply_to: source.message_id,
          text: 'PI_CONTACT_REPLY: associated response.' })(request);
      }
      replied = lastTool(request.body);
      assert.equal(replied.status, 'accepted');
      return modelText('The reply was accepted.')(request);
    });
    alpha.write('\r');
    await eventually(() => alpha.events(), events => events.some(event => event.type === 'agent_settled') &&
      rig.requests.some(request => request.peer === 'alpha' && inbound(request.body, 'PI_CONTACT_REPLY')),
    'native explicit submission and associated reply', 30_000);
    await eventually(() => replied, result => result?.status === 'accepted',
      'The replying model observes its actual accepted tool result');
    assert.ok(sent && replied);
    assert.equal(alpha.events().find(event => event.type === 'tool_execution_end' && event.toolName === 'arlo_send_message').isError, false);
    const sends = alpha.events().filter(event => event.type === 'tool_execution_end' && event.toolName === 'arlo_send_message').length;
    rig.handlers.set('alpha', request => {
      assert.equal(request.body.messages[0].content.includes('Arlo contact mentions in this submitted prompt'), false);
      return modelText('Ordinary input stays in this session.')(request);
    });
    const settled = alpha.events().filter(event => event.type === 'agent_settled').length;
    await alpha.submit('PI_ORDINARY_FOLLOWUP: continue my local work.');
    await eventually(() => alpha.events(), events => events.filter(event => event.type === 'agent_settled').length > settled,
      'later ordinary input completes without forwarding');
    assert.equal(alpha.events().filter(event => event.type === 'tool_execution_end' && event.toolName === 'arlo_send_message').length, sends);
    assert.deepEqual(rig.errors, []);
  });

test('selector Escape leaves a running Pi task and already accepted pending input intact',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('contacts-busy-escape');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo');
    await bravo.ready();
    let held;
    rig.handlers.set('alpha', request => { held = request; });
    await alpha.submit('PI_CONTACT_BUSY: keep my current work running.');
    await eventually(() => held, Boolean, 'existing native model operation');
    const sent = await sendFromNative(rig, bravo, 'alpha', 'PI_CONTACT_PENDING: already accepted before selector cancellation.');
    assert.equal(sent.receipt.status, 'accepted');
    await chooseHost(alpha);
    alpha.write('\x1b');
    await eventually(() => alpha.events(), events => events.some(event => event.type === 'terminal_escape' && !event.idle),
      'Escape belongs to the active selector during a run');
    assert.equal(held.closed, false, 'Selector Escape must not abort model work');
    assert.equal(alpha.events().some(event => event.type === 'agent_settled' && event.aborted), false);
    rig.handlers.set('alpha', modelText('Process the accepted input after current work.'));
    modelText('The original work completed.')(held);
    await eventually(() => alpha.events(), events => events.some(event => event.type === 'agent_settled'), 'run settles after pending reception');
    assert.equal(rig.requests.filter(request => request.peer === 'alpha' && inbound(request.body, 'PI_CONTACT_PENDING')).length, 1);
    assert.equal(alpha.output.includes('Arlo cancelled'), false, 'Menu cancellation does not discard accepted input');
    assert.deepEqual(rig.errors, []);
  });

test('old directory and selection results cannot overwrite edited drafts or a replacement editor',
  { timeout: 150_000 }, async t => {
    const rig = await nativeScenario('contacts-stale-editor');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha', {}, { files: { 'A_EDITOR_REPLACED/native.md': 'Native file after editor replacement.\n' } });
    await alpha.ready();
    const bravo = await rig.start('bravo');
    await bravo.ready();
    rig.directoryGate.mode = 'hold';
    const queryOffset = alpha.output.length;
    alpha.write('@');
    await eventually(() => rig.directoryGate.held.length, count => count > 0, 'old real directory query is pending');
    await setDraft(alpha, 'Replacement draft');
    rig.releaseDirectory();
    await alpha.submit('PI_STALE_QUERY_BARRIER: preserve this edited context.');
    await eventually(() => alpha.events(), events => events.some(event => event.type === 'agent_settled'), 'late directory result has a native processing barrier');
    assert.equal(alpha.output.slice(queryOffset).includes('Arlo · Pi'), false);
    assert.equal(alpha.output.slice(queryOffset).includes('contacts unavailable'), false, 'Obsolete query errors are suppressed too');
    await setDraft(alpha, 'Original selector draft ');
    await chooseHost(alpha);
    await setDraft(alpha, 'Edited while selecting');
    alpha.write(' CONTINUED');
    await eventually(() => draft(alpha), text => text === 'Edited while selecting CONTINUED', 'draft change closes the obsolete selector');
    assert.equal(draft(alpha).includes('@arlo:'), false);
    await setDraft(alpha, 'Replacement editor draft ');
    await chooseHost(alpha);
    alpha.editorAction({ type: 'editor' });
    await eventually(() => alpha.events(), events => events.some(event => event.type === 'editor_action' && event.action.type === 'editor'),
      'public editor factory is replaced while selecting');
    alpha.write(' NEW_EDITOR');
    await eventually(() => draft(alpha), text => text === 'Replacement editor draft @ NEW_EDITOR', 'old selector cannot write into replacement editor');
    await setDraft(alpha, 'After editor replacement ');
    const replacedOffset = alpha.output.length;
    alpha.write('@');
    await eventually(() => alpha.output.slice(replacedOffset), text => text.includes('bin/'),
      'native file completion remains available after editor replacement');
    assert.equal(alpha.output.slice(replacedOffset).includes('Arlo · Pi'), false,
      'Contacts must not offer insertion into a detached editor');
    alpha.write('A_EDITOR_');
    await eventually(() => alpha.output.slice(replacedOffset), text => text.includes('A_EDITOR_REPLACED/'),
      'replacement editor still searches real native files');
    assert.equal(alpha.events().some(event => event.type === 'tool_execution_end'), false);
    assert.deepEqual(rig.errors, []);
  });

test('Escape while the contact directory is loading cancels selection without aborting work or accepted input',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('contacts-loading-escape');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo');
    await bravo.ready();
    let held;
    rig.handlers.set('alpha', request => { held = request; });
    await alpha.submit('PI_CONTACT_LOADING_BUSY: continue this task while I edit.');
    await eventually(() => held, Boolean, 'original native model work');
    await sendFromNative(rig, bravo, 'alpha', 'PI_LOADING_PENDING: retain this accepted input.');
    rig.directoryGate.mode = 'hold';
    const offset = alpha.output.length;
    alpha.write('@');
    await eventually(() => rig.directoryGate.held.length, count => count > 0, 'contact discovery waits for a real HTTPS response');
    alpha.write('\x1b');
    await eventually(() => alpha.events(), events => events.some(event => event.type === 'terminal_escape'), 'loading selector receives Escape');
    alpha.write(' continued');
    await eventually(() => draft(alpha), text => text === '@ continued', 'native draft remains editable after closing loading contacts');
    rig.releaseDirectory();
    assert.equal(held.closed, false, 'Closing pending contact discovery must not abort the existing model operation');
    assert.equal(alpha.output.slice(offset).includes('Arlo cancelled'), false);
    rig.handlers.set('alpha', modelText('Process retained input.'));
    modelText('Original task completes.')(held);
    await eventually(() => alpha.events(), events => events.some(event => event.type === 'agent_settled'), 'original run completes normally');
    assert.equal(rig.requests.filter(request => request.peer === 'alpha' && inbound(request.body, 'PI_LOADING_PENDING')).length, 1);
    assert.equal(alpha.events().some(event => event.type === 'agent_settled' && event.aborted), false);
    assert.deepEqual(rig.errors, []);
  });

for (const change of ['new', 'reload']) {
  test(`late contact discovery cannot insert into a native /${change} context`,
    { timeout: 150_000 }, async t => {
      const rig = await nativeScenario(`contacts-context-${change}`);
      t.after(() => rig.close());
      t.diagnostic(`Evidence: ${rig.directory}`);
      const alpha = await rig.start('alpha');
      await alpha.ready();
      const bravo = await rig.start('bravo');
      await bravo.ready();
      rig.directoryGate.mode = 'hold';
      const outputOffset = alpha.output.length;
      alpha.write('@');
      await eventually(() => rig.directoryGate.held.length, count => count > 0, 'old contact directory response is held');
      alpha.write('\x1b');
      await eventually(() => alpha.events(), events => events.some(event => event.type === 'terminal_escape'), 'pending discovery is closed');
      await setDraft(alpha, '');
      await alpha.submit(`/${change}`);
      await eventually(() => alpha.events(), events => events.some(event => event.type === 'session_start' && event.reason === change),
        `real native /${change} replaces the attachment`);
      await setDraft(alpha, 'New context draft');
      rig.releaseDirectory();
      await alpha.submit(' PI_CONTEXT_BARRIER: process only the new draft.');
      await eventually(() => alpha.events(), events => events.some(event => event.type === 'agent_settled'), 'new native context finishes normally');
      assert.equal(alpha.output.slice(outputOffset).includes('Arlo · Pi'), false);
      assert.equal(alpha.output.slice(outputOffset).includes('contacts unavailable'), false);
      const request = rig.requests.find(request => request.peer === 'alpha');
      const submitted = JSON.stringify(request.body.messages.filter(message => message.role === 'user'));
      assert.ok(submitted.includes('New context draft PI_CONTEXT_BARRIER'));
      assert.equal(submitted.includes('@arlo:'), false);
      assert.equal(alpha.events().some(event => event.type === 'tool_execution_end'), false);
      assert.deepEqual(rig.errors, []);
    });
}

test('same titles and colliding short IDs stay bound to full endpoints across rename, offline selection and replacement sessions',
  { timeout: 180_000 }, async t => {
    let sequence = 0;
    const rig = await nativeScenario('contacts-identity', {
      randomUUID: () => `12345678-1234-4123-8123-${String(++sequence).padStart(12, '0')}`,
    });
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha');
    await alpha.ready();
    const bravo = await rig.start('bravo', {}, { title: 'Duplicate' });
    await bravo.ready();
    const charlie = await rig.start('charlie', {}, { title: 'Duplicate' });
    await charlie.ready();
    const delta = await rig.start('delta', {}, { title: null });
    await delta.ready();
    let step = 0, peers;
    rig.handlers.set('alpha', request => {
      if (step++ === 0) return modelTool('arlo_list_sessions', {})(request);
      peers = lastTool(request.body);
      return modelText('Live contact identities were discovered.')(request);
    });
    await alpha.submit('PI_CONTACT_IDENTITIES: discover permitted online sessions.');
    await eventually(() => alpha.events(), events => events.some(event => event.type === 'agent_settled'), 'real model directory lookup');
    const duplicates = peers.filter(peer => peer.display_name === 'Duplicate').sort((a, b) => a.endpoint_id.localeCompare(b.endpoint_id));
    assert.equal(duplicates.length, 2);
    await setDraft(alpha, 'Send to ');
    const menuOffset = alpha.output.length;
    await chooseHost(alpha);
    const menu = alpha.output.slice(menuOffset).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert.ok(menu.includes('Untitled session · Pi ·'));
    const ids = [...new Set([...menu.matchAll(/Duplicate · Pi · ([0-9a-f-]+)/g)].map(match => match[1]))];
    assert.equal(ids.length, 2);
    assert.ok(ids.every(id => id.length > 6), 'Colliding display IDs are extended in the real selector');
    alpha.write('\x1b[B'); // Untitled sorts first; choose the first Duplicate.
    await bravo.submit('/name Renamed');
    await charlie.submit('/name Renamed');
    alpha.write('\r');
    const selected = await eventually(() => draft(alpha), text => text?.includes('@arlo:pi:'), 'rename retains the full selected endpoint');
    assert.ok(selected.includes(duplicates[0].endpoint_id));
    await setDraft(alpha, 'Choose a target that goes offline ');
    const goneOffset = alpha.output.length;
    await chooseHost(alpha);
    alpha.write('\x1b[B');
    await bravo.quit();
    await charlie.quit();
    alpha.write('\r');
    await eventually(() => alpha.output.slice(goneOffset), text => text.includes('contact is no longer available'), 'offline selection reports unavailability');
    assert.equal(draft(alpha), 'Choose a target that goes offline @');
    const echo = await rig.start('echo', {}, { title: 'Duplicate' });
    await echo.ready();
    let sendStep = 0;
    rig.handlers.set('alpha', request => {
      if (sendStep++ === 0) return modelTool('arlo_send_message', {
        to: duplicates[0].endpoint_id, text: 'PI_OLD_ENDPOINT: must not be guessed onto a replacement.',
      })(request);
      assert.ok(JSON.stringify(request.body.messages.findLast(message => message.role === 'tool')).includes('TARGET_UNAVAILABLE'));
      return modelText('That exact contact is no longer available.')(request);
    });
    await setDraft(alpha, selected);
    const settled = alpha.events().filter(event => event.type === 'agent_settled').length;
    alpha.write('\r');
    await eventually(() => alpha.events(), events => events.filter(event => event.type === 'agent_settled').length > settled,
      'old endpoint fails explicitly instead of choosing a replacement');
    assert.equal(alpha.events().findLast(event => event.type === 'tool_execution_end' && event.toolName === 'arlo_send_message').isError, true);
    assert.equal(rig.requests.some(request => request.peer !== 'alpha' && inbound(request.body, 'PI_OLD_ENDPOINT')), false);
    assert.deepEqual(rig.errors, []);
  });

for (const [binding, undoKey, keybindings] of [
  ['native', process.platform === 'win32' ? '\x1a' : '\x1b[45;5u', undefined],
  // CustomEditor dispatches app actions first. Ctrl+Z also suspends Pi on
  // POSIX, so explicitly unbind it when assigning that key to editor undo.
  ['configured', '\x1a', { 'tui.editor.undo': 'ctrl+z', 'app.suspend': [] }],
]) {
  test(`native contact cancellation preserves large paste and cursor, and undo has no phantom completion step (${binding})`,
    { timeout: 120_000 }, async t => {
      const rig = await nativeScenario(`contacts-draft-${binding}`);
      t.after(() => rig.close());
      t.diagnostic(`Evidence: ${rig.directory}`);
      const alpha = await rig.start('alpha', {}, { keybindings });
      await alpha.ready();
      const bravo = await rig.start('bravo');
      await bravo.ready();
      const large = Array.from({ length: 45 }, (_, i) => `PI_LONG_PASTE_${i}: retained original context`).join('\n');
      const prefix = `${large}\nAsk `;
      const suffix = ' trailing draft';
      paste(alpha, large);
      await eventually(() => draft(alpha), text => text === large, 'large paste stored by native editor');
      paste(alpha, '\nAsk ' + suffix);
      await eventually(() => draft(alpha), text => text === prefix + suffix, 'large native paste is retained');
      alpha.write('\x02'.repeat(suffix.length));
      for (let attempt = 0; attempt < 3; attempt++) {
        await chooseHost(alpha);
        const offset = alpha.events().length;
        alpha.write('\x1b');
        await eventually(() => alpha.events().slice(offset), events => events.some(event => event.type === 'terminal_escape'),
          'this selector cancellation reaches the terminal');
        assert.equal(draft(alpha), prefix + '@' + suffix);
        alpha.write(undoKey);
        await eventually(() => draft(alpha), text => text === prefix + suffix, 'undo removes typed @ immediately after cancelling');
      }
      await chooseHost(alpha, '\t');
      alpha.write('\t');
      await eventually(() => draft(alpha), text => text?.includes('@arlo:pi:ep-'), 'Tab selects a real session');
      alpha.write(undoKey);
      await eventually(() => draft(alpha), text => text === prefix + '@' + suffix, 'one undo removes the entire endpoint suffix');
      alpha.write(undoKey);
      await eventually(() => draft(alpha), text => text === prefix + suffix, 'a second undo removes @ without a phantom step');
      alpha.write('HERE');
      await eventually(() => draft(alpha), text => text === prefix + 'HERE' + suffix, 'cursor and all pasted context survive selection and undo');
      assert.equal(rig.requests.length, 0);
      assert.equal(alpha.events().some(event => event.type === 'agent_start'), false);
      assert.deepEqual(rig.errors, []);
    });
}

test('native file search and commands remain usable with no contact host or a failing or timed-out directory',
  { timeout: 120_000 }, async t => {
    const rig = await nativeScenario('contacts-files-failures');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha', {}, { files: {
      'notes/PI_NATIVE_FILE.md': 'A real file returned by native fd search.\n',
      'docs/PI_OTHER_FILE.md': 'Another real file in a different directory.\n',
    } });
    await alpha.ready();
    const emptyOffset = alpha.output.length;
    alpha.write('@');
    await eventually(() => alpha.output.slice(emptyOffset), text => text.includes('notes/'), 'native candidates with no online contact');
    assert.equal(alpha.output.slice(emptyOffset).includes('Arlo · Pi'), false, 'No empty host or installation placeholder');
    alpha.write('\x1b');
    await setDraft(alpha, '');
    const fileOffset = alpha.output.length;
    alpha.write('@PI_NATIVE_');
    await eventually(() => alpha.output.slice(fileOffset), text => text.includes('PI_NATIVE_FILE.md'), 'real native fuzzy file search');
    alpha.write('\t');
    await eventually(() => draft(alpha), text => text?.includes('@notes/PI_NATIVE_FILE.md'), 'native file completion');
    assert.equal(rig.requests.length, 0);
    await setDraft(alpha, 'Timeout draft ');
    rig.directoryGate.mode = 'hold';
    const timeoutOffset = alpha.output.length;
    alpha.write('@');
    await eventually(() => rig.directoryGate.held.length, count => count > 0, 'real directory request held at HTTPS boundary');
    await eventually(() => alpha.output.slice(timeoutOffset), text => text.includes('DIRECTORY_TIMEOUT'), 'bounded directory timeout feedback');
    assert.equal(draft(alpha), 'Timeout draft @');
    alpha.write('\x1b');
    await setDraft(alpha, 'New draft survives old replies');
    rig.releaseDirectory();
    await setDraft(alpha, 'Preserve this draft ');
    rig.directoryGate.mode = 'fail';
    const failedOffset = alpha.output.length;
    alpha.write('@');
    await eventually(() => alpha.output.slice(failedOffset), text => text.includes('Arlo contacts unavailable:'), 'directory failure is distinguishable from no contacts');
    assert.equal(draft(alpha), 'Preserve this draft @');
    alpha.write('\x1b');
    rig.releaseDirectory();
    await setDraft(alpha, '');
    const settled = alpha.events().filter(event => event.type === 'agent_settled').length;
    await alpha.submit('PI_DIRECTORY_BARRIER: keep native submission usable.');
    await eventually(() => alpha.events(), events => events.filter(event => event.type === 'agent_settled').length > settled,
      'ordinary native input remains usable');
    const commandOffset = alpha.output.length;
    alpha.write('/name');
    await eventually(() => alpha.output.slice(commandOffset), text => text.includes('Set session display name'), 'native command completion');
    assert.deepEqual(rig.errors, []);
  });

// A host-only control separates native app dispatch from Arlo's selector and
// no-op completion undo handling. Use the same installed host peer as above.
test('native editor without Arlo preserves app suspend precedence over a conflicting undo binding',
  { timeout: 60_000, skip: process.platform !== 'linux' }, async t => {
    const rig = await nativeScenario('contacts-native-control');
    t.after(() => rig.close());
    t.diagnostic(`Evidence: ${rig.directory}`);
    const alpha = await rig.start('alpha', {}, {
      enabled: false, keybindings: { 'tui.editor.undo': ['ctrl+z', 'ctrl+-'] },
    });
    await eventually(() => draft(alpha), text => text === '', 'native editor starts without Arlo');
    paste(alpha, 'Native draft ');
    await eventually(() => draft(alpha), text => text === 'Native draft ', 'native draft');
    alpha.write('@');
    await eventually(() => draft(alpha), text => text === 'Native draft @', 'native typed at sign');
    const offset = alpha.output.length;
    try {
      alpha.write('\x1a');
      await eventually(() => alpha.output.slice(offset), text => text.includes('\x1b[?2004l'),
        'native suspend stops bracketed paste instead of undoing');
      assert.equal(draft(alpha), 'Native draft @');
    } finally { process.kill(alpha.terminal.pid, 'SIGCONT'); }
    await eventually(() => alpha.output.slice(offset), text => text.includes('\x1b[?2004h'), 'native TUI resumes');
    alpha.write('\x1b[45;5u');
    await eventually(() => draft(alpha), text => text === 'Native draft ', 'unambiguous native undo removes at sign');
    alpha.write('HERE');
    await eventually(() => draft(alpha), text => text === 'Native draft HERE', 'native editing continues');
    assert.equal(rig.requests.length, 0);
    assert.equal(alpha.events().some(event => event.type === 'tool_execution_end'), false);
    assert.deepEqual(rig.errors, []);
  });
