import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

// Loaded only by the isolated acceptance runner into the installed npm DSH.
// These are real host Sessions, model requests and model tool calls. The
// controller observes the host; it does not replace any application RPC.
export const name = 'arlo-web-acceptance-fixture';
export const inject = ['agents', 'llm', 'sessions', 'sessionController', 'sessionProjections', 'workspaceController', 'workspaceRegistry', 'configEditor'];

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
}

class LocalModel extends LlmAdapter {
  requests = [];
  waiting = new Map();
  held = new Set();
  statusQueries = new Set();
  configuredFault;

  async listModels(provider) {
    if (provider === 'arlo-web-configured') {
      if (this.configuredFault === 'catalog-failure') throw new Error('ARLO_CONFIGURED_CATALOG_UNAVAILABLE');
      return [{ provider, id: 'scripted-configured', name: 'Arlo configured new conversation model' }];
    }
    return [
      { provider, id: 'scripted', name: 'Arlo isolated acceptance model' },
      { provider, id: 'scripted-at-submit', name: 'Arlo model selected after picking' },
    ];
  }

  async resolveModel(provider, model, signal) {
    if (provider === 'arlo-web-configured' && this.configuredFault === 'resolution-failure') {
      throw new Error('ARLO_CONFIGURED_MODEL_METADATA_UNAVAILABLE');
    }
    return super.resolveModel(provider, model, signal);
  }

  release(sessionId, send, reply = false, queryStatus = false) {
    const gate = this.waiting.get(sessionId);
    assert.ok(gate, `No model request is waiting for ${sessionId}`);
    this.waiting.delete(sessionId);
    gate.resolve({ send, reply, queryStatus });
  }

  async *stream(options) {
    const sessionId = String(options.sessionId ?? 'auxiliary');
    const request = {
      index: this.requests.length,
      sessionId,
      provider: options.provider,
      model: options.model,
      purpose: options.purpose ?? null,
      messages: structuredClone(options.messages),
      tools: (options.tools ?? []).map(tool => tool.name),
      state: 'entered',
    };
    this.requests.push(request);
    if (options.messages.at(-1)?.role === 'tool') {
      try { request.toolResult = JSON.parse(messageText(options.messages.at(-1))); } catch { /* Native error text has no canonical success DTO. */ }
      if (this.statusQueries.delete(sessionId)) {
        const id = ToolCallId(`arlo-web-status-${request.index}`);
        const args = JSON.stringify({ message_id: request.toolResult.message_id });
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id, name: 'arlo_get_message_status', argumentsDelta: args };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'arlo_get_message_status', arguments: args } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
    }
    if (options.purpose || !this.held.has(sessionId) || options.messages.at(-1)?.role === 'tool') {
      request.state = 'finished';
      yield* textResponse('Controlled local completion.');
      return;
    }

    const gate = Promise.withResolvers();
    assert.ok(!this.waiting.has(sessionId), 'Only one held request per Session');
    this.waiting.set(sessionId, gate);
    const abort = () => gate.reject(options.signal.reason ?? new Error('Model request cancelled'));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    let decision;
    try {
      decision = await gate.promise;
    } catch (error) {
      request.state = 'aborted';
      throw error;
    } finally {
      if (this.waiting.get(sessionId) === gate) this.waiting.delete(sessionId);
      options.signal?.removeEventListener('abort', abort);
    }
    if (decision.queryStatus) this.statusQueries.add(sessionId);
    if (decision.reply) {
      // Derive reply authority only from the model-visible received input.
      const sourceText = messageText(options.messages.findLast(message => message.role === 'user' &&
        messageText(message).includes('{"arlo":{')));
      const source = JSON.parse(sourceText.match(/\{"arlo":\{[^\n]+\}\}/)[0]).arlo;
      assert.equal(typeof source.from_endpoint, 'string');
      assert.equal(typeof source.message_id, 'string');
      assert.ok(request.tools.includes('arlo_send_message'));
      const args = JSON.stringify({ to: source.from_endpoint, reply_to: source.message_id, text: 'DSH_NATIVE_ASSOCIATED_REPLY' });
      const id = ToolCallId(`arlo-web-reply-${request.index}`);
      request.state = 'reply-tool-emitted';
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'arlo_send_message', argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'arlo_send_message', arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    if (!decision.send) {
      request.state = 'finished-without-send';
      yield* textResponse('Controlled completion without contacting another Session.');
      return;
    }

    // The endpoint is read solely from the submitted model-visible user text.
    // The test controller never supplies a destination or tool arguments.
    // A model switch appends a user-role model-selection notice after the real
    // submitted user input. Resolve the latest user input carrying its contact,
    // rather than mistaking that Host notice for the user's submission.
    const submitted = messageText(options.messages.findLast(message => message.role === 'user' && messageText(message).includes('<arlo-contact>')));
    const matches = [...submitted.matchAll(/<arlo-contact>([\s\S]*?)<\/arlo-contact>/g)];
    assert.ok(matches.length > 0, 'The submitted prompt must carry contact instructions');
    request.deliveries = [];
    for (const [index, match] of matches.entries()) {
      const contact = JSON.parse(match[1]);
      assert.equal(typeof contact.endpoint_id, 'string');
      assert.ok(contact.endpoint_id.length > 0);
      assert.ok(request.tools.includes('arlo_send_message'), 'Real model request must expose the Arlo send tool');
      const adjacentInstruction = submitted.slice(match.index + match[0].length, matches[index + 1]?.index);
      const task = adjacentInstruction.match(/\bMIXED_[A-Z]+_TASK\b/)?.[0];
      const generatedText = `ARLO_MODEL_COMPOSED_${request.index}_${index}: I reviewed the request and am contacting this Session with the relevant background.${task ? ` Assigned review: ${task}.` : ''}`;
      const args = JSON.stringify({ to: contact.endpoint_id, text: generatedText });
      const id = ToolCallId(`arlo-web-model-call-${request.index}-${index}`);
      request.state = 'tool-emitted';
      request.selectedEndpoint = contact.endpoint_id;
      request.generatedText = generatedText;
      request.deliveries.push({ endpoint: contact.endpoint_id, text: generatedText, toolCallId: id });
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index, id, name: 'arlo_send_message', argumentsDelta: args };
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: 'arlo_send_message', arguments: args } };
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

export function apply(ctx) {
  assert.ok(ctx.appReady, 'This fixture requires the real DSH launcher');
  assert.ok(process.env.ARLO_WEB_FIXTURE_REPORT, 'The runner must provide an isolated report path');
  const token = randomBytes(24).toString('hex');
  const ids = Object.fromEntries(['A', 'B', 'C', 'U', 'D', 'child', 'cold'].map(key => [key, `arlo-web-${key.toLowerCase()}`]));
  const model = new LocalModel();
  model.held.add(ids.B);
  const registration = ctx.llm.registerAdapter(['arlo-web-local', 'arlo-web-configured'], model);
  const events = new Map();
  const disposable = new Map();
  const errors = [];
  const endpointBySession = {};
  let liveContact;
  let contactEntry;
  const contactReady = Promise.withResolvers();
  const contactLifecycle = { mounts: 0, unmounts: 0 };
  // Only contact-dependent access belongs to this injection. The real model,
  // controller and held Host lifecycle gate must survive plugin removal.
  ctx.inject(['arloContact'], scope => {
    const service = scope.arloContact;
    liveContact = service;
    contactLifecycle.mounts++;
    contactReady.resolve();
    scope.effect(() => () => {
      if (liveContact === service) liveContact = undefined;
      contactLifecycle.unmounts++;
    });
  });
  const contactService = () => {
    assert.ok(liveContact, 'The Arlo contact plugin is not mounted');
    return liveContact;
  };
  const configuredContact = () => {
    const configured = ctx.configEditor.configuration().find(item => item.entry.options.name === '@arlo/adapter-dsh');
    assert.ok(configured, 'The real profile configuration editor must expose the Arlo plugin');
    contactEntry = configured.entry;
    return configured;
  };
  let creationGate;
  let workspaceId;
  const creationAttempts = [];
  let ready = false;
  let controlUrl;
  // A real Host plugin can delay/reject a root's normal lifecycle. Keep this
  // fault at the public lifecycle seam; never replace a Arlo/Host method.
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (!ready || Object.values(ids).includes(agent.id)) return;
    const attempt = { id: agent.id, state: 'created' };
    creationAttempts.push(attempt);
    if (!creationGate) return;
    if (creationGate.skip > 0) {
      creationGate.skip--;
      return;
    }
    const gate = creationGate;
    creationGate = undefined;
    gate.attempt = attempt;
    attempt.state = 'waiting';
    gate.signal = signal;
    attempt.signalAborted = signal?.aborted ?? false;
    const aborted = () => { attempt.signalAborted = true; };
    signal?.addEventListener('abort', aborted, { once: true });
    let action;
    try {
      action = await gate.promise;
    } finally {
      signal?.removeEventListener('abort', aborted);
    }
    if (action === 'fail') {
      attempt.state = 'rejected';
      throw new Error('ARLO_FIXTURE_HOST_CREATE_FAILED');
    }
    if (action === 'detach-workspace') {
      await ctx.workspaceRegistry.delete(workspaceId);
      attempt.state = 'workspace-deleted';
      return;
    }
    attempt.state = signal?.aborted ? 'cancelled' : 'released';
  });
  let activeCreationGate;
  ctx.on('session/event', (session, event) => {
    const log = events.get(session.id) ?? [];
    log.push(structuredClone(event));
    events.set(session.id, log);
  });

  const report = async () => {
    await writeFile(process.env.ARLO_WEB_FIXTURE_REPORT, `${JSON.stringify({
      ready, controlUrl, token, ids, endpointBySession, errors,
      runtime: { node: process.version, platform: process.platform, electron: process.versions.electron ?? null },
      provider: 'arlo-web-local',
    }, null, 2)}\n`);
  };
  const sessionIdOf = value => {
    const sessionId = ids[value] ?? value;
    assert.ok(Object.values(ids).includes(sessionId) || ctx.agents.get(SessionId(sessionId)), 'Unknown fixture Session');
    return SessionId(sessionId);
  };
  const agentOf = value => {
    const agent = ctx.agents.get(sessionIdOf(value));
    assert.ok(agent, `Session ${value} has no live Agent`);
    return agent;
  };
  const snapshot = () => ({
    ready, ids, endpointBySession, errors, creationAttempts,
    contactPlugin: { ...contactLifecycle, available: Boolean(liveContact),
      entryId: contactEntry?.id ?? null, disabled: contactEntry?.disabled ?? false },
    roots: ctx.agents.roots().map(agent => ({
      id: agent.id, meta: agent.session.header, options: agent.options,
      status: agent.status, projections: ctx.sessionProjections.snapshot(agent.session),
      events: events.get(agent.id) ?? [],
    })),
    waiting: [...model.waiting.keys()],
    requests: model.requests,
    sessions: Object.fromEntries(Object.entries(ids).map(([key, sessionId]) => {
      const agent = ctx.agents.get(SessionId(sessionId));
      return [key, {
        id: sessionId,
        live: Boolean(agent),
        root: agent ? ctx.agents.roots().includes(agent) : false,
        status: agent?.status ?? null,
        inbox: agent ? { nextTurn: agent.inbox.nextTurn, nextStep: agent.inbox.nextStep } : null,
        projections: agent ? ctx.sessionProjections.snapshot(agent.session) : null,
        events: events.get(sessionId) ?? [],
      }];
    })),
  });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end('{"error":"unauthorized"}');
      return;
    }
    try {
      if (request.method === 'GET' && request.url === '/state') {
        response.end(JSON.stringify(snapshot()));
        return;
      }
      assert.equal(request.method, 'POST');
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        assert.ok(body.length <= 8192, 'Controller body too large');
      }
      const args = JSON.parse(body || '{}');
      if (request.url === '/release') {
        model.release(sessionIdOf(args.session), args.send === true, args.reply === true, args.queryStatus === true);
      } else if (request.url === '/hold') {
        model.held.add(sessionIdOf(args.session));
      } else if (request.url === '/switch-group') {
        assert.equal(typeof args.group, 'string');
        await contactService().harness.switchGroup(agentOf(args.session), args.group);
      } else if (request.url === '/dispose') {
        const handle = disposable.get(sessionIdOf(args.session));
        assert.ok(handle, 'Only fixture-owned AgentHandles can be disposed; use switch-group for controller-created roots');
        await handle.dispose();
      } else if (request.url === '/rename') {
        await ctx.sessionController.rename({ sessionId: sessionIdOf(args.session), title: args.title });
      } else if (request.url === '/select-model') {
        assert.ok(['scripted', 'scripted-at-submit'].includes(args.model));
        await ctx.sessionController.selectModel({ sessionId: sessionIdOf(args.session), provider: 'arlo-web-local', model: args.model });
      } else if (request.url === '/configured-model-fault') {
        assert.ok(['removed-provider', 'catalog-failure', 'resolution-failure'].includes(args.fault));
        // Exercise the public adapter registration/catalog/metadata boundary.
        // A's provider remains live; no Host or Arlo service method is replaced.
        if (args.fault === 'removed-provider') registration.replace(['arlo-web-local']);
        else model.configuredFault = args.fault;
      } else if (request.url === '/gate-create') {
        assert.ok(!activeCreationGate, 'Only one creation gate can be active');
        activeCreationGate = creationGate = Promise.withResolvers();
        activeCreationGate.skip = args.skip ?? 0;
      } else if (request.url === '/release-create') {
        assert.ok(activeCreationGate, 'No creation gate is active');
        assert.ok(['continue', 'fail', 'detach-workspace'].includes(args.action));
        activeCreationGate.resolve(args.action);
        activeCreationGate = undefined;
      } else if (request.url === '/catalog') {
        response.end(JSON.stringify(await ctx.sessionController.modelCatalog()));
        return;
      } else if (request.url === '/configuration') {
        const configured = configuredContact();
        response.end(JSON.stringify({ entryId: configured.entry.id, config: configured.entry.options.config }));
        return;
      } else if (request.url === '/disable-contact-plugin') {
        const { entry } = configuredContact();
        assert.ok(!entry.disabled && liveContact, 'The fixture can only disable its active Arlo plugin');
        // Public Loader lifecycle used by the real installed Host. No service,
        // browser factory, application RPC or disposal method is replaced.
        await entry.update({ disabled: true });
      } else if (request.url === '/enable-contact-plugin') {
        const { entry } = configuredContact();
        assert.ok(entry.disabled && !liveContact, 'The fixture can only enable its disabled Arlo plugin');
        await entry.update({ disabled: false });
      } else if (request.url === '/sessions') {
        response.end(JSON.stringify(await ctx.sessionController.list({}, new AbortController().signal)));
        return;
      } else if (request.url === '/contacts') {
        response.end(JSON.stringify(await contactService().list(sessionIdOf(args.session), new AbortController().signal)));
        return;
      } else if (request.url === '/stop') {
        assert.ok(ctx.appExit, 'The real launcher must own graceful shutdown');
        response.end(JSON.stringify({ ok: true }));
        setImmediate(() => ctx.appExit(0));
        return;
      } else {
        throw new Error('Unknown fixture operation');
      }
      response.end(JSON.stringify({ ok: true }));
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: String(error) }));
    }
  });

  const boot = async () => {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    controlUrl = `http://127.0.0.1:${server.address().port}`;
    await report();
    await contactReady.promise;
    configuredContact();
    const { workspace } = await ctx.workspaceController.create({ path: process.env.ARLO_WEB_WORKSPACE_DIR ?? process.cwd() });
    workspaceId = workspace.workspaceId;
    for (const key of ['A', 'B', 'C', 'U', 'D']) {
      await ctx.sessionController.create({ sessionId: SessionId(ids[key]), workspaceId: workspace.workspaceId });
      // Setup must not mutate the native artifact while its first allowance
      // is being durably opened and revalidated by the shared Daemon.
      const deadline = Date.now() + 20000;
      while (true) {
        try {
          await contactService().list(SessionId(ids[key]), new AbortController().signal);
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await delay(100);
        }
      }
      const initial = await contactService().harness.getRootSendingStatus(agentOf(key));
      assert.equal(initial.knowledge, 'known', `Fixture root ${key} must finish initial allowance before native setup writes`);
      assert.equal(initial.remaining, 20);
      await ctx.sessionController.selectModel({ sessionId: SessionId(ids[key]), provider: 'arlo-web-local', model: 'scripted' });
    }
    for (const [key, title] of [['A', 'Arlo acceptance sender'], ['B', 'Shared contact title'], ['C', 'Shared contact title'], ['D', 'Other communication group']]) {
      await ctx.sessionController.rename({ sessionId: SessionId(ids[key]), title });
    }
    await contactService().harness.switchGroup(agentOf('D'), 'arlo-web-other-group');
    const parent = agentOf('A');
    const child = await parent.ctx.agents.create({
      sessionId: SessionId(ids.child), parentAgent: parent,
      meta: { cwd: process.cwd(), origin: 'subagent' },
      agentOptions: { provider: 'arlo-web-local', model: 'scripted' },
    });
    child.agent.ctx.systemPrompt.variable('cwd', () => process.cwd());
    disposable.set(ids.child, child);
    const cold = await ctx.agents.create({
      sessionId: SessionId(ids.cold), meta: { cwd: process.cwd() },
      agentOptions: { provider: 'arlo-web-local', model: 'scripted' },
    });
    cold.agent.ctx.systemPrompt.variable('cwd', () => process.cwd());
    disposable.set(ids.cold, cold);
    await ctx.sessionController.rename({ sessionId: SessionId(ids.cold), title: 'Cold historical Session' });
    cold.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ARLO_COLD_HISTORY_CANARY' }], source: { kind: 'user' } }));
    await cold.agent.whenIdle();
    assert.equal(await ctx.sessions.flush(cold.agent.session), true, 'Cold fixture must have real persistence');
    await cold.dispose();
    assert.equal(ctx.agents.get(SessionId(ids.cold)), undefined);
    agentOf('A').followup(createUserMessage({ content: [{ type: 'text', text: 'ARLO_A_EXISTING_WORK_CONTEXT' }], source: { kind: 'user' } }));
    await agentOf('A').whenIdle();
    model.held.add(ids.A);
    // Public discovery intentionally withholds the host's Session IDs. Each
    // root's own endpoint is the sole ID absent from its peer list; intersect
    // those real lists to label the fixture's same-title roots in evidence.
    const peers = {};
    for (const key of ['A', 'B', 'C', 'U']) {
      const deadline = Date.now() + 20000;
      let lastError;
      while (Date.now() < deadline) {
        try {
          const list = await contactService().list(SessionId(ids[key]), new AbortController().signal);
          if (list.length === 3 && list.every(item => item.deliverable)) {
            peers[key] = list;
            break;
          }
          lastError = new Error(`Root ${key} has ${list.length} contacts; waiting for three ready peers`);
        } catch (error) {
          lastError = error;
        }
        await delay(100);
      }
      assert.ok(peers[key], `Fixture registration did not settle: ${String(lastError)}`);
    }
    const endpoints = new Set(Object.values(peers).flat().map(item => item.endpoint_id));
    assert.equal(endpoints.size, 4, 'Only the four live same-group roots should be discoverable');
    for (const [key, items] of Object.entries(peers)) {
      const otherIds = new Set(items.map(item => item.endpoint_id));
      const own = [...endpoints].filter(endpoint => !otherIds.has(endpoint));
      assert.equal(own.length, 1, `Discovery must exclude only self for fixture root ${key}`);
      endpointBySession[key] = own[0];
    }
    // Hold B in an actual model turn, so later active reception is visible in
    // the public nextTurn inbox before any second model request can consume it.
    agentOf('B').followup(createUserMessage({ content: [{ type: 'text', text: 'ARLO_B_BASELINE_HOLD' }], source: { kind: 'user' } }));
    ready = true;
    await report();
  };
  const unsubscribe = ctx.appReady.onReady(() => {
    void boot().catch(async error => {
      errors.push(error instanceof Error ? error.stack : String(error));
      await report();
    });
  });
  ctx.effect(() => () => {
    unsubscribe();
    server.closeAllConnections();
    server.close();
  });
}
