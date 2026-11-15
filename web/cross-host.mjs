import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { eventually, modelTool, modelText, lastTool, inbound } from '../pi-acceptance/harness.mjs';

/** Real browser input, real Pi TTY, one Daemon, and serial local models. */
export async function crossHostScenario({ piRig, piPeer, page, input, menu, draft, control, until, fixture, report, passed }) {
  const sendButton = page.getByRole('button', { name: 'Send message', exact: true });
  const evidence = report.crossHost = { piDirectory: piRig.directory, matrix: [] };
  const chip = input.locator('[data-composer-chip]');
  function receivedInputs(state) {
    return state.roots.map(root => ({ id: root.id, inputs: root.events.filter(event => event.type === 'user/message') }));
  }
  async function assertDraftOnly(before, piRequests) {
    const state = await control('/state');
    assert.equal(state.requests.length, before.requests.length, 'Editing contacts must not request the DSH model');
    assert.equal(piRig.requests.length, piRequests, 'Editing contacts must not request the Pi model');
    assert.deepEqual(state.creationAttempts, before.creationAttempts, 'Editing contacts must not create a root');
    assert.deepEqual(receivedInputs(state), receivedInputs(before), 'Editing contacts must not insert a native message');
    assert.deepEqual(Object.fromEntries(Object.entries(state.sessions).map(([name, session]) => [name, session.inbox])),
      Object.fromEntries(Object.entries(before.sessions).map(([name, session]) => [name, session.inbox])),
      'Editing contacts must preserve pending native inputs');
    return state;
  }
  async function pickPi(text = '@') {
    await draft(text);
    await menu.getByText('Pi', { exact: true }).click();
    await menu.getByRole('option').filter({ hasText: 'pi-cross-host' }).click();
    await chip.waitFor();
    assert.match(await chip.innerText(), /Pi/u);
  }
  async function piSetting(enabled) {
    const offset = piPeer.output.length;
    await piPeer.submit(`/arlo-settings ${enabled ? 'on' : 'off'}`);
    await eventually(() => piPeer.output.slice(offset), output => output.includes(
      `Cross-host communication ${enabled ? 'enabled' : 'disabled'}`), 'Pi settings acknowledgement');
    assert.equal(JSON.parse(fs.readFileSync(path.join(piPeer.home, 'arlo.json'), 'utf8')).crossHostEnabled, enabled);
  }
  async function dshSetting(enabled) {
    await draft('/arlo-settings');
    await menu.getByRole('option').filter({ hasText: 'arlo-settings' }).click();
    await input.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText(enabled ? 'on' : 'off');
    const acknowledgement = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/arloContact/participation' && response.request().method() === 'POST');
    await page.keyboard.press('Enter');
    const envelope = await (await acknowledgement).json();
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope));
    assert.equal(envelope.result.value.effective, enabled);
    assert.equal(JSON.parse(fs.readFileSync(path.join(report.scratch, 'home/profiles/web/arlo.json'), 'utf8')).crossHostEnabled, enabled);
  }
  async function piTool(name, args, prompt = `Exercise ${name} through this native submission.`, contact) {
    const settled = piPeer.events().filter(event => event.type === 'agent_settled').length;
    let step = 0, result;
    piRig.handlers.set(piPeer.name, request => {
      if (step++ === 0) {
        if (contact) {
          const user = request.body.messages.findLast(message => message.role === 'user');
          const text = typeof user.content === 'string' ? user.content : user.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
          const mention = text.match(/@arlo:[a-z0-9.-]+:(ep-[0-9a-f-]+)/);
          assert.equal(mention?.[1], contact.endpoint_id, 'The model must address the endpoint selected in the current native draft');
          return modelTool(name, { ...args, to: mention[1] })(request);
        }
        return modelTool(name, args)(request);
      }
      const tool = request.body.messages.findLast(message => message.role === 'tool');
      const text = typeof tool.content === 'string' ? tool.content : tool.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      try { result = JSON.parse(text); } catch { result = { error: text }; }
      return modelText('Controlled communication check completed.')(request);
    });
    await piPeer.submit(prompt);
    await eventually(() => piPeer.events(), events => events.filter(event => event.type === 'agent_settled').length > settled,
      `Pi actual model tool ${name}`, 30_000);
    assert.ok(result);
    return result;
  }
  for (const [piEnabled, dshEnabled] of [[false, false], [true, false], [false, true], [true, true]]) {
    await piSetting(piEnabled);
    await dshSetting(dshEnabled);
    const dshPeers = await control('/contacts', { session: 'A' });
    const piPeers = await piTool('arlo_list_sessions', {});
    const allowed = piEnabled && dshEnabled;
    assert.equal(dshPeers.some(peer => peer.host_kind === 'pi'), allowed);
    assert.equal(piPeers.some(peer => peer.host_kind === 'deepseek-harness'), allowed);
    assert.ok(dshPeers.some(peer => peer.endpoint_id === fixture.endpointBySession.B), 'Same-host DSH discovery survives every setting');
    await draft('@');
    await menu.getByRole('option').filter({ hasText: 'New conversation' }).waitFor();
    if (allowed) await menu.getByText('Pi', { exact: true }).waitFor();
    assert.equal(await menu.getByText('Pi', { exact: true }).count(), allowed ? 1 : 0);
    await page.keyboard.press('Escape');
    evidence.matrix.push({ piEnabled, dshEnabled, allowed, dshPeers, piPeers });
  }
  passed('native-settings-persist-and-four-bilateral-combinations-match-real-discovery');

  // Forward the native Pi drilldown to the real Host with its existing internal
  // child identity. Published root validation supplies every failure response;
  // the browser's bounded read-only retry and visible error remain genuine.
  const beforeQueryFailure = await control('/state');
  const beforeQueryPiRequests = piRig.requests.length;
  await draft('PI_CONTACT_QUERY_FAILURE_DRAFT @');
  await menu.getByText('Pi', { exact: true }).waitFor();
  const queryFailures = [];
  const rejectContactQuery = async route => {
    const request = route.request();
    const payload = request.postDataJSON();
    assert.equal(request.method(), 'POST');
    assert.equal(payload.method, 'arloContact/list');
    assert.equal(payload.payload.args.sessionId, fixture.ids.A);
    payload.payload.args.sessionId = fixture.ids.child;
    const response = await route.fetch({ postData: JSON.stringify(payload), maxRetries: 0, maxRedirects: 0 });
    assert.equal(response.ok(), true);
    const envelope = await response.json();
    assert.equal(envelope.result.ok, false);
    assert.equal(envelope.result.error.code, 'arlo/contact-unavailable');
    assert.equal(envelope.result.error.details.reason, 'CALLER_NOT_ROOT');
    queryFailures.push({ rpcId: payload.rpcId, error: envelope.result.error });
    await route.fulfill({ response });
  };
  await page.route('**/api/arloContact/list', rejectContactQuery);
  try {
    await menu.getByText('Pi', { exact: true }).click();
    await menu.getByRole('option').filter({ hasText: 'Type @ again to retry' }).waitFor({ timeout: 20000 });
    assert.ok(queryFailures.length > 0);
    assert.equal(await menu.getByRole('option').filter({ hasText: 'pi-cross-host' }).count(), 0);
    assert.equal(await chip.count(), 0);
    assert.equal(await input.innerText(), 'PI_CONTACT_QUERY_FAILURE_DRAFT @arlo:pi:');
    evidence.queryFailure = { boundary: 'Real authenticated contact RPC with a fixture-owned internal child caller',
      failures: queryFailures, draft: await input.innerText(), visibleError: await menu.innerText() };
    await assertDraftOnly(beforeQueryFailure, beforeQueryPiRequests);
    await page.screenshot({ path: path.join(report.scratch, 'logs/cross-host-query-failure.png') });
    await page.keyboard.press('Escape');
  } finally {
    await page.unroute('**/api/arloContact/list', rejectContactQuery);
  }
  passed('native-pi-contact-query-failure-preserves-draft-shows-error-and-sends-nothing');

  const beforeCancel = await control('/state');
  const beforeCancelPiRequests = piRig.requests.length;
  await draft('PI_CONTACT_CANCEL_DRAFT @');
  await menu.getByText('Pi', { exact: true }).click();
  await menu.getByRole('option').filter({ hasText: 'pi-cross-host' }).waitFor();
  const cancelledDraft = await input.innerText();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert.equal(await input.innerText(), cancelledDraft, 'Cancelling Pi selection preserves the native draft');
  assert.equal(await chip.count(), 0, 'Cancelling before selection inserts no contact');
  await assertDraftOnly(beforeCancel, beforeCancelPiRequests);
  evidence.selectionCancellation = { gesture: 'Escape in Pi contacts', draft: cancelledDraft };
  passed('native-pi-selection-cancellation-preserves-draft-and-sends-nothing');

  // Only mutate the browser's request timezone. The real Host validates and
  // rejects the prompt; its ordinary submit failure restores the selected chip.
  await pickPi();
  await input.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(' Preserve this selected Pi. PI_CONTACT_SUBMIT_FAILURE_DRAFT');
  const failedDraft = await input.innerText();
  const failedChip = await chip.innerText();
  const beforeSubmitFailure = await control('/state');
  const beforeSubmitPiRequests = piRig.requests.length;
  const selectedPi = (await control('/contacts', { session: 'A' })).find(contact => contact.host_kind === 'pi');
  assert.ok(selectedPi);
  let rejectedRequest;
  const rejectPrompt = async route => {
    const request = route.request();
    if (request.method() !== 'POST' || !request.postData()?.includes('PI_CONTACT_SUBMIT_FAILURE_DRAFT')) return route.fallback();
    const payload = request.postDataJSON();
    const alter = value => {
      if (!value || typeof value !== 'object') return false;
      if (value.sessionId === fixture.ids.A && Array.isArray(value.content)) {
        assert.ok(JSON.stringify(value.content).includes(selectedPi.endpoint_id), 'Submission preserves the full selected Pi endpoint');
        value.clientTimeZone = 'ARLO_INVALID_TIME_ZONE';
        return true;
      }
      return Object.values(value).some(alter);
    };
    if (!alter(payload)) return route.fallback();
    rejectedRequest = payload;
    await route.continue({ postData: JSON.stringify(payload) });
  };
  await page.route('**/api/**', rejectPrompt);
  let rejectedEnvelope;
  try {
    const rejectedResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && response.request().postData()?.includes('PI_CONTACT_SUBMIT_FAILURE_DRAFT'));
    await sendButton.click();
    rejectedEnvelope = await (await rejectedResponse).json();
    assert.equal(rejectedEnvelope.result.ok, false, JSON.stringify(rejectedEnvelope));
    await until(() => input.innerText(), text => rejectedRequest && text === failedDraft,
      'Real Host submission failure restores the selected Pi draft');
    await until(() => sendButton.isEnabled(), Boolean, 'Host submission failure releases the submit guard');
  } finally {
    await page.unroute('**/api/**', rejectPrompt);
  }
  assert.equal(await chip.innerText(), failedChip);
  await assertDraftOnly(beforeSubmitFailure, beforeSubmitPiRequests);
  evidence.submitFailure = { boundary: 'Real Host prompt clientTimeZone validation', endpoint: selectedPi.endpoint_id,
    error: rejectedEnvelope.result.error, restoredDraft: await input.innerText(), restoredChip: await chip.innerText() };
  passed('native-selected-pi-host-submit-failure-restores-contact-and-draft-without-send-or-retry');

  // The receiving Pi model reads the real inbound source, sends an associated
  // reply, then queries that reply's reception through its real model tools.
  let replyStep = 0, received, reply, replyStatus;
  piRig.handlers.set(piPeer.name, request => {
    if (replyStep++ === 0) {
      received = inbound(request.body, 'ARLO_MODEL_COMPOSED_');
      assert.ok(received, 'Pi must receive the real DSH model-composed input');
      return modelTool('arlo_send_message', { to: received.from_endpoint, reply_to: received.message_id,
        text: 'PI_NATIVE_ASSOCIATED_REPLY' })(request);
    }
    if (replyStep === 2) {
      reply = lastTool(request.body);
      assert.equal(reply.status, 'accepted');
      return modelTool('arlo_get_message_status', { message_id: reply.message_id })(request);
    }
    replyStatus = lastTool(request.body);
    assert.equal(replyStatus.status, 'accepted');
    return modelText('Cross-host reply accepted by the receiving host.')(request);
  });
  const before = await control('/state');
  const beforePiSelection = piRig.requests.length;
  await pickPi();
  const selection = await control('/state');
  assert.equal(selection.requests.length, before.requests.length);
  assert.equal(piRig.requests.length, beforePiSelection);
  await input.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(' Ask this Pi to review our previous conclusion. DSH_NATIVE_CROSS_HOST_SUBMIT');
  await sendButton.click();
  const submitted = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'DSH current model receives the explicit submission');
  const request = submitted.requests.findLast(item => item.sessionId === fixture.ids.A);
  assert.ok(JSON.stringify(request.messages).includes('DSH_NATIVE_CROSS_HOST_SUBMIT'));
  await control('/release', { session: 'A', send: true });
  await eventually(() => replyStatus, Boolean, 'Real Pi processes DSH input, replies and queries reception', 30_000);
  const replied = await until(() => control('/state'), state => state.sessions.A.events.some(event =>
    event.type === 'user/message' && JSON.stringify(event).includes('PI_NATIVE_ASSOCIATED_REPLY')), 'DSH receives the associated Pi reply');
  const replyEvent = replied.sessions.A.events.find(event => event.type === 'user/message' && JSON.stringify(event).includes('PI_NATIVE_ASSOCIATED_REPLY'));
  assert.ok(JSON.stringify(replyEvent).includes(received.message_id));
  assert.ok(!received.text.includes('DSH_NATIVE_CROSS_HOST_SUBMIT'), 'The DSH model organizes the content');
  await control('/release', { session: 'A', send: false });
  await until(() => control('/state'), state => state.sessions.A.status === 'idle', 'DSH finishes processing the reply');
  evidence.dshToPi = { received, reply, replyStatus, replyEvent };
  passed('browser-at-host-contact-submit-current-dsh-model-real-pi-processing-associated-reply');

  // Pi actively starts the next exchange by native submission and model tools.
  const peers = await piTool('arlo_list_sessions', {});
  const sender = peers.find(peer => peer.display_name === 'Arlo acceptance sender');
  assert.equal(sender.endpoint_id, fixture.endpointBySession.A);
  await eventually(() => piPeer.events().findLast(event => event.type === 'draft')?.text, text => text === '', 'Pi native draft is ready');
  const selectionOffset = piPeer.output.length;
  const requestsBeforeSelection = piRig.requests.length;
  piPeer.write('Send our reviewed conclusion to @');
  const hostLabel = `Arlo · ${sender.host_kind}`;
  await eventually(() => piPeer.output.slice(selectionOffset), text => text.includes(hostLabel), 'Pi native @ shows the real DSH host');
  piPeer.write('\r');
  await eventually(() => piPeer.output.slice(selectionOffset), text => text.includes(`${hostLabel}: select session`), 'Pi native DSH session selector');
  const hostPeers = peers.filter(peer => peer.host_kind === sender.host_kind && peer.deliverable)
    .sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? '') || a.endpoint_id.localeCompare(b.endpoint_id));
  const selectedIndex = hostPeers.findIndex(peer => peer.endpoint_id === sender.endpoint_id);
  assert.ok(selectedIndex >= 0);
  piPeer.write('\x1b[B'.repeat(selectedIndex) + '\r');
  const selectedDraft = await eventually(() => piPeer.events().findLast(event => event.type === 'draft')?.text,
    text => text?.includes(`@arlo:${sender.host_kind}:${sender.endpoint_id}`), 'Pi native selection inserts the exact DSH endpoint');
  assert.equal(piRig.requests.length, requestsBeforeSelection, 'Contact selection does not submit or call the model');
  const active = await piTool('arlo_send_message', { text: 'PI_NATIVE_ACTIVE_SEND' },
    ' with a new request through Arlo.', sender);
  assert.equal(active.status, 'accepted');
  const activeStatus = await piTool('arlo_get_message_status', { message_id: active.message_id });
  assert.equal(activeStatus.status, 'accepted');
  await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A) && state.sessions.A.events.some(event =>
    event.type === 'user/message' && JSON.stringify(event).includes('PI_NATIVE_ACTIVE_SEND')), 'DSH actively processes the Pi request');
  let reverseReply;
  piRig.handlers.set(piPeer.name, request => {
    reverseReply = inbound(request.body, 'DSH_NATIVE_ASSOCIATED_REPLY');
    assert.equal(reverseReply?.reply_to, active.message_id);
    assert.equal(reverseReply.from_endpoint, sender.endpoint_id);
    return modelText('The DSH associated reply arrived in the original Pi root.')(request);
  });
  await control('/release', { session: 'A', reply: true });
  await until(() => control('/state'), state => state.sessions.A.status === 'idle', 'DSH Pi-request processing settles');
  await eventually(() => reverseReply, Boolean, 'DSH model sends an associated reply to the initiating Pi root');
  evidence.piToDsh = { selectedDraft, active, activeStatus, reverseReply };
  passed('pi-native-at-exact-dsh-contact-model-send-status-active-reception-and-associated-reply');

  // A selected draft and exact cached endpoint do not keep old permission.
  await draft('@');
  await menu.getByText('Pi', { exact: true }).click();
  await menu.getByRole('option').filter({ hasText: 'pi-cross-host' }).click();
  await chip.waitFor();
  await piSetting(false);
  await input.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(' Send this stale selection. DSH_STALE_CROSS_HOST_DRAFT');
  const piRequestCount = piRig.requests.length;
  await sendButton.click();
  await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A), 'Stale draft is submitted to its current model');
  await control('/release', { session: 'A', send: true });
  const rejected = await until(() => control('/state'), state => state.sessions.A.status === 'idle', 'Final Daemon admission rejects the stale draft');
  assert.ok(JSON.stringify(rejected.sessions.A.events).includes('CROSS_HOST_DISABLED'));
  assert.equal(piRig.requests.length, piRequestCount);
  const cached = await piTool('arlo_send_message', { to: sender.endpoint_id, text: 'PI_DISABLED_CACHED_ENDPOINT' });
  assert.match(cached.error, /CROSS_HOST_DISABLED/u);
  const historical = await piTool('arlo_get_message_status', { message_id: active.message_id });
  assert.equal(historical.status, 'accepted');
  evidence.afterDisable = { cached, historical };
  passed('disabled-native-stale-draft-and-model-cached-address-rejected-original-status-retained');

  // Keep A and the real Pi together while moving every other online DSH root
  // through the trusted group operation. The menu must not invent an online DSH
  // category in order to retain the independent native new-conversation action.
  await piSetting(true);
  for (const session of ['B', 'C', 'U']) {
    await control('/switch-group', { session, group: `arlo-cross-host-isolated-${session.toLowerCase()}` });
  }
  const onlyPi = await control('/contacts', { session: 'A' });
  assert.equal(onlyPi.length, 1);
  assert.equal(onlyPi[0].host_kind, 'pi');
  assert.equal(onlyPi[0].endpoint_id, selectedPi.endpoint_id);
  const beforeNew = await control('/state');
  const beforeNewPiRequests = piRig.requests.length;
  const previousRoots = new Set(beforeNew.roots.map(root => root.id));
  await draft('@');
  await menu.getByRole('option').filter({ hasText: 'New conversation' }).waitFor();
  await menu.getByText('Pi', { exact: true }).waitFor();
  assert.equal(await menu.getByText('DSH', { exact: true }).count(), 0);
  assert.equal(await menu.getByRole('option').filter({ hasText: /New.*Pi|Pi.*new/iu }).count(), 0);
  const onlyPiMenu = await menu.innerText();
  await page.screenshot({ path: path.join(report.scratch, 'logs/cross-host-pi-only-menu.png') });
  await menu.getByRole('option').filter({ hasText: 'New conversation' }).click();
  await chip.waitFor();
  assert.match(await chip.innerText(), /New conversation/u);
  await assertDraftOnly(beforeNew, beforeNewPiRequests);
  await input.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(' Start an independent DSH conversation. PI_ONLY_NEW_DSH_DRAFT');
  await sendButton.click();
  const createdState = await until(() => control('/state'), state => state.waiting.includes(fixture.ids.A),
    'Explicit new-conversation submit prepares a real DSH root before the current model');
  const created = createdState.roots.filter(root => !previousRoots.has(root.id));
  assert.equal(created.length, 1);
  assert.equal(created[0].meta.parentSession, undefined);
  assert.equal(created[0].meta.origin, undefined);
  assert.equal(createdState.creationAttempts.length, beforeNew.creationAttempts.length + 1);
  const newPeers = await control('/contacts', { session: 'A' });
  assert.equal(newPeers.filter(contact => contact.host_kind === 'pi').length, 1);
  const newDsh = newPeers.filter(contact => contact.host_kind === 'deepseek-harness');
  assert.equal(newDsh.length, 1);
  assert.equal(newDsh[0].deliverable, true);
  const newRequest = createdState.requests.findLast(request => request.sessionId === fixture.ids.A);
  assert.ok(JSON.stringify(newRequest.messages).includes(newDsh[0].endpoint_id));
  assert.ok(JSON.stringify(newRequest.messages).includes('PI_ONLY_NEW_DSH_DRAFT'));
  assert.equal(piRig.requests.length, beforeNewPiRequests, 'New conversation creates no Pi session or model request');
  assert.ok(!created[0].events.some(event => event.type === 'user/message'), 'Root preparation does not copy or send the draft');
  await control('/release', { session: 'A', send: false });
  await until(() => control('/state'), state => state.sessions.A.status === 'idle', 'The explicit new-conversation model turn settles');
  evidence.piOnlyNewDsh = { contactsBefore: onlyPi, menu: onlyPiMenu, createdRoot: created[0].id,
    createdEndpoint: newDsh[0].endpoint_id, creation: createdState.creationAttempts.at(-1) };
  passed('pi-only-online-contacts-retain-independent-new-dsh-action-without-empty-dsh-category-or-new-pi');
  assert.deepEqual(piRig.errors, []);
}
