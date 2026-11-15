// Shared by the production Mod hooks and the Node test/embedding entrypoint.
// Only the official Mod host facade is used; this file has no Node dependencies.
//
// A pending input is { nativeMessageId, messageId, text, correlationMarker } as
// the bridge reports it; see ClaudeModPendingMessage in register.d.ts. The
// Sidecar owns the marker format, so this file only embeds the marker it was
// handed and looks for that same string in the host turn input.
const CLAIM_EVIDENCE_TIMEOUT_MS = 30000;
const BRIDGE_CONTRACT_VERSION = '2.0.0';
export const SIDECAR_RECOVERY_ATTEMPTS = 5;
export const SIDECAR_RECOVERY_BUDGET_MS = 30000;
const SIDECAR_RECOVERY_RETRY_MS = 250;
const IDENTITY_CHECK_INTERVAL_MS = 50;
const IDENTITY_CHECK_ATTEMPTS = 20;
const HUMAN_COMMANDS = [
  { name: 'arlo-authorize', description: 'Authorize binding of this live session ID without issuing allowance. Same-ID transcript continuity is not verified.', immediate: true },
  { name: 'arlo-send-status', description: 'Show this root session\'s autonomous sending allowance.', immediate: true },
  { name: 'arlo-continue', description: 'Start a new bounded allowance period for this root session.', immediate: true },
  { name: 'arlo-reload-sending-rules', description: 'Reload this root session\'s sending rules.', immediate: true },
  { name: 'arlo-settings', description: 'Show or change cross-host participation.', argumentHint: '[on|off]', immediate: true },
  { name: 'arlo-root-config', description: 'Show this root session\'s explicit authorization and configuration.', immediate: true },
];
const MODEL_TOOLS = [
  {
    name: 'arlo_list_sessions',
    description: 'List other online, ready root sessions in this communication group. Address them by their full endpoint_id.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    isDeferred: false,
  },
  {
    name: 'arlo_send_message',
    description: 'Send text to one full Arlo endpoint_id from arlo_list_sessions. accepted means queued, not read or completed. unknown must not trigger automatic resend. To reply, use the received message_id as reply_to and its from_endpoint as to.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Full Arlo endpoint ID; never a Claude session name, sessionId, agentId or short ID.' },
        text: { type: 'string', description: 'Message body, at most 32 KiB of UTF-8.' },
        reply_to: { type: 'string', description: 'Original inbound message ID for an associated reply.' },
      },
      required: ['to', 'text'], additionalProperties: false,
    },
    isDeferred: false,
  },
  {
    name: 'arlo_get_message_status',
    description: 'Query reception metadata for a message this root sent. Reports acceptance, never task completion; unavailable results do not permit automatic resend.',
    inputSchema: {
      type: 'object', properties: { message_id: { type: 'string' } },
      required: ['message_id'], additionalProperties: false,
    },
    isDeferred: false,
  },
];

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001F\u007F/\\]/.test(value);
}

function loopbackBridgeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' &&
      !url.username && !url.password && url.pathname === '/' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

function parseBootstrap(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Bridge bootstrap is invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Bridge bootstrap is invalid');
  const keys = Object.keys(value).sort().join();
  if (value.status === 'exhausted') {
    if (keys !== 'diagnostic,sessionId,status' || !validSessionId(value.sessionId) ||
        typeof value.diagnostic !== 'string' || !value.diagnostic || value.diagnostic.length > 500 ||
        /[0-9a-f]{32,}/i.test(value.diagnostic)) throw new Error('Bridge bootstrap is invalid');
    return { status: 'exhausted', sessionId: value.sessionId, diagnostic: value.diagnostic };
  }
  if (value.status !== 'active' || keys !== 'instanceId,sessionId,status,token,url' ||
      !validSessionId(value.sessionId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.instanceId) ||
      !/^[0-9a-f]{64}$/.test(value.token) || !loopbackBridgeUrl(value.url)) {
    throw new Error('Bridge bootstrap is invalid');
  }
  return { status: 'active', sessionId: value.sessionId, url: value.url, token: value.token, instanceId: value.instanceId };
}

function bridgeIdentity(body, sessionId) {
  if (!body || body.contractVersion !== BRIDGE_CONTRACT_VERSION ||
      typeof body.sessionId !== 'string' || !body.sessionId ||
      sessionId !== undefined && body.sessionId !== sessionId ||
      typeof body.instanceId !== 'string' || !body.instanceId ||
      !Number.isSafeInteger(body.generation) || body.generation < 0) {
    throw new Error('Bridge identity is unavailable');
  }
  return { sessionId: body.sessionId, instanceId: body.instanceId, generation: body.generation };
}

/** The prompt text handed to the host: business text plus this message's marker. */
export function composeSubmittedPrompt(text, marker) {
  return text ? `${text}\n\n${marker}` : marker;
}

/**
 * The host turn input, or undefined when the host carried none. Claude Code
 * reports the input it ingested as the turn.start event's `text`; the model
 * reply arrives separately on turn.complete, so a marker the model echoes back
 * is never seen here.
 */
function turnInput(event) {
  return typeof event?.text === 'string' ? event.text : undefined;
}

export class ClaudeCodeModDispatcher {
  constructor(options) {
    this.$ = options.$;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.promptSubmitTimeoutMs = options.promptSubmitTimeoutMs ?? 10000;
    this.claimEvidenceTimeoutMs = options.claimEvidenceTimeoutMs ?? CLAIM_EVIDENCE_TIMEOUT_MS;
    this.stopped = false;
    this.polling = false;
    this.sessionStarted = false;
    this.activeTurns = new Set();
    this.inFlightDispatch = new Set();
    // One entry per submitted input whose claim is not proven yet, keyed by its
    // own correlation marker.
    this.awaitingClaims = new Map();
  }

  isIdle() {
    return this.sessionStarted && !this.stopped && this.activeTurns.size === 0;
  }

  onTurnStart(turnId, event) {
    this.activeTurns.add(turnId);
    this.inspectClaimEvidence(event);
  }

  onTurnComplete(turnId, agentId) {
    if (agentId === undefined) this.activeTurns.delete(turnId);
    if (this.isIdle()) void this.pollOnce();
  }

  async start() {
    if (this.stopped || this.sessionStarted) return;
    if (this.starting) return this.starting;
    this.starting = this.initialize();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async initialize() {
    try {
      this.sessionId = await this.$.session.id();
      if (this.stopped) return;
      await this.rememberBootstrapPath();
      const material = await this.readBootstrapMaterial();
      if (material?.status === 'exhausted') {
        this.diagnose();
        return;
      }
      if (material?.status === 'active') {
        this.bridgeUrl = material.url;
        this.token = material.token;
        this.expectedInstanceId = material.instanceId;
      } else {
        this.bridgeUrl = await this.$.env.get('ARLO_CLAUDECODE_BRIDGE_URL');
        if (this.stopped) return;
        this.token = await this.$.env.get('ARLO_CLAUDECODE_BRIDGE_TOKEN');
      }
      if (this.stopped || !this.sessionId || !this.bridgeUrl || !this.token) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        const status = await this.discoverStatus();
        if (this.stopped) return;
        const discovered = bridgeIdentity(status);
        if (this.expectedInstanceId && discovered.instanceId !== this.expectedInstanceId) {
          throw new Error('Bridge instance does not match');
        }
        if (status.status === 'draining') {
          this.resumeAfter(Promise.resolve(discovered), discovered.sessionId);
          return;
        }
        if (discovered.sessionId !== this.sessionId) throw new Error('Bridge session does not match');
        let handshake;
        try {
          handshake = await this.request('/handshake', discovered, {
            modVersion: '0.1.0', capabilities: ['prompt.submit'],
          });
        } catch (error) {
          // A superseded module's already-issued handshake may win the CAS.
          // Only its definite refusal is retried, with newly observed identity.
          if (!this.stopped && error.status === 409 && attempt < 2) continue;
          throw error;
        }
        const identity = bridgeIdentity(handshake, this.sessionId);
        if (handshake.accepted !== true || identity.instanceId !== discovered.instanceId ||
            identity.generation <= discovered.generation) throw new Error('Bridge handshake was refused');
        // Keep the returned identity even if session.end interrupted the request:
        // retirement waits for initialization and can still fence that attachment.
        this.identity = identity;
        this.bindingStatus = 'active';
        if (!this.stopped) this.enable();
        return;
      }
    } catch {
      // A rejected or malformed handshake never enables reception scheduling.
      this.sessionStarted = false;
      if (!this.stopped) this.diagnose();
    }
  }

  enable() {
    if (this.stopped) return;
    this.sessionId = this.identity.sessionId;
    this.sessionStarted = true;
    this.timer = this.$.clock.every(this.pollIntervalMs, () => { void this.pollOnce(); });
  }

  diagnose() {
    try {
      void Promise.resolve(this.$.ui?.log('Arlo communication stopped: the current Claude Code session could not be verified. Local work can continue.')).catch(() => {});
    } catch {
      // A diagnostic surface that is unavailable never interrupts local work.
    }
  }

  async request(path, identity, body) {
    const response = await this.$.http.fetch(`${this.bridgeUrl}/api/v1/bridge${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: this.headers(identity),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw Object.assign(new Error('Bridge request was refused'), { status: response.status });
    return JSON.parse(response.text);
  }

  async requestForCurrentRoot(route, payload) {
    const identity = this.identity;
    const assertCurrent = () => {
      if (this.stopped || !this.sessionStarted || !identity || this.identity !== identity) {
        throw new Error('STALE_BINDING: Arlo communication is not attached to this root.');
      }
    };
    const verifySession = async () => {
      assertCurrent();
      let sessionId;
      try {
        sessionId = await this.$.session.id();
      } catch {
        throw new Error('SESSION_MISMATCH: Current Claude root cannot be verified.');
      } finally {
        assertCurrent();
      }
      if (sessionId !== identity.sessionId) throw new Error('SESSION_MISMATCH: Current Claude root changed.');
    };
    await verifySession();
    let response;
    try {
      response = await this.$.http.fetch(`${this.bridgeUrl}/api/v1/bridge${route}`, {
        method: 'POST', headers: this.headers(identity), body: JSON.stringify(payload),
      });
    } finally {
      // Transport rejection belongs to the captured root just as success does.
      await verifySession();
    }
    const body = JSON.parse(response.text);
    if (!response.ok) {
      throw Object.assign(new Error(body?.error?.code ? `${body.error.code}: ${body.error.message}` : 'Bridge request was refused.'), { code: body?.error?.code });
    }
    return body;
  }

  async callTool(name, args) {
    const body = await this.requestForCurrentRoot('/tools/call', { name, arguments: args });
    return { result: body.content.map(item => item.text).join('\n') };
  }

  async callCommand(name, args) {
    const writes = name === 'arlo-authorize' || name === 'arlo-continue';
    this.pendingCommands ??= new Map();
    let pending = this.pendingCommands.get(name);
    if (!pending) {
      pending = { operationId: crypto.randomUUID() };
      if (writes) this.pendingCommands.set(name, pending);
    }
    if (pending.promise) return pending.promise;
    pending.promise = (async () => {
      const body = await this.requestForCurrentRoot('/commands/call', { name, arguments: args,
        ...(writes ? { operationId: pending.operationId } : {}) });
      if (typeof body?.text !== 'string') throw new Error('Arlo command result unavailable.');
      if (this.pendingCommands.get(name) === pending) this.pendingCommands.delete(name);
      return { text: body.text };
    })().catch(error => {
      if (['INVALID_ARGUMENT', 'UNAUTHORIZED', 'STALE_GENERATION', 'STALE_CONTROL_REQUEST', 'CONTROL_REQUEST_CONFLICT', 'ALLOWANCE_UNKNOWN', 'BINDING_MISMATCH'].includes(error.code) && this.pendingCommands.get(name) === pending) this.pendingCommands.delete(name);
      throw error;
    }).finally(() => { pending.promise = undefined; });
    return pending.promise;
  }

  async discoverStatus() {
    for (let attempt = 0; attempt < IDENTITY_CHECK_ATTEMPTS; attempt++) {
      try {
        return await this.request('/status', { sessionId: this.sessionId });
      } catch (error) {
        // A fresh module can load after Claude has changed its id but before
        // the previous module's retirement reaches the Sidecar. A bounded
        // retry may observe the draining proof; never reuse the rejected root.
        if (this.stopped || error.status !== 403 || attempt === IDENTITY_CHECK_ATTEMPTS - 1) throw error;
        await new Promise(resolve => {
          this.cancelDiscovery = resolve;
          this.rotationTimer = this.$.clock.after(IDENTITY_CHECK_INTERVAL_MS, resolve);
        });
        this.cancelDiscovery = undefined;
        if (this.stopped) return undefined;
      }
    }
  }

  async retire(endingSessionId) {
    if (typeof endingSessionId !== 'string' || !endingSessionId) throw new Error('Ending session identity is unavailable');
    await this.starting;
    await this.activating?.catch(() => {});
    if (this.retirement && this.bindingStatus !== 'active') await this.retirement;
    let identity = this.bindingStatus === 'active' ? this.identity : undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!identity || identity.sessionId !== endingSessionId) {
        // session.end can interrupt a freshly loaded Mod before its first
        // identity read returns. The event's ending root remains authoritative
        // for retirement; authenticated discovery can revoke it without ever
        // enabling that aborted dispatcher. Refresh old draining proof too:
        // another attachment may have completed an activation since it issued.
        this.bridgeUrl ??= await this.$.env.get('ARLO_CLAUDECODE_BRIDGE_URL');
        this.token ??= await this.$.env.get('ARLO_CLAUDECODE_BRIDGE_TOKEN');
        const status = await this.request('/status', { sessionId: endingSessionId });
        identity = bridgeIdentity(status);
        if (status.status === 'draining') return identity;
        if (identity.sessionId !== endingSessionId) throw new Error('Ending session does not match');
      }
      let result;
      try {
        result = await this.request('/session/retire', identity, {});
      } catch (error) {
        if ((error.status === 403 || error.status === 409) && attempt < 2) {
          identity = undefined;
          continue;
        }
        throw error;
      }
      const retired = bridgeIdentity(result, endingSessionId);
      if (retired.instanceId !== identity.instanceId || retired.generation <= identity.generation) {
        throw new Error('Retirement was not confirmed');
      }
      this.bindingStatus = 'draining';
      return retired;
    }
  }

  resumeAfter(retirement, endingSessionId) {
    // session.end has one short shared host budget. Its event stops scheduling
    // immediately; identity discovery runs in fresh host timer callbacks after
    // the engine's end step, when $.session.id() can expose the replacement.
    void retirement.catch(() => {});
    this.retirement = retirement;
    let previous;
    let attempts = 0;
    const verify = async () => {
      try {
        await this.rememberBootstrapPath();
        if (this.stopped) return;
        const retired = await retirement;
        if (this.stopped) return;
        this.identity = retired;
        this.bindingStatus = 'draining';
        // A new dispatcher must use the recovered Sidecar, not the host's
        // launch-time coordinates. Tie the private material to the retirement
        // proof before activating a replacement root.
        if (this.bootstrapPath) {
          const material = await this.readBootstrapMaterial();
          if (material?.status !== 'active' || material.instanceId !== retired.instanceId) {
            throw new Error('Retired bridge coordinates are unavailable');
          }
          this.bridgeUrl = material.url;
          this.token = material.token;
        } else {
          this.bridgeUrl ??= await this.$.env.get('ARLO_CLAUDECODE_BRIDGE_URL');
          this.token ??= await this.$.env.get('ARLO_CLAUDECODE_BRIDGE_TOKEN');
        }
        if (this.stopped) return;
        const candidate = await this.$.session.id();
        if (this.stopped) return;
        if (typeof candidate === 'string' && candidate && candidate !== endingSessionId && candidate === previous) {
          this.activating = this.request('/session/activate', retired, { sessionId: candidate }).then(result => {
            const identity = bridgeIdentity(result, candidate);
            if (result.accepted !== true || identity.instanceId !== retired.instanceId ||
                identity.generation <= retired.generation) throw new Error('Activation was refused');
            this.identity = identity;
            this.bindingStatus = 'active';
          });
          await this.activating;
          if (!this.stopped) this.enable();
          return;
        }
        previous = candidate;
        if (++attempts >= IDENTITY_CHECK_ATTEMPTS) throw new Error('Current identity is unavailable');
        this.rotationTimer = this.$.clock.after(IDENTITY_CHECK_INTERVAL_MS, () => { void verify(); });
      } catch (error) {
        // A reloaded module can observe the retired generation while its old
        // module still has an activation in flight. A definite fence refusal
        // permits rediscovery, never replay of the same activation request.
        if (!this.stopped && (error.status === 403 || error.status === 409) &&
            (this.activationRetries ?? 0) < 2 && typeof previous === 'string' && previous) {
          this.activationRetries = (this.activationRetries ?? 0) + 1;
          try {
            const current = await this.$.session.id();
            if (this.stopped) return;
            if (current === previous && current !== endingSessionId) {
              await this.start();
              return;
            }
          } catch {
            // A failed identity read leaves communication disabled.
          }
        }
        if (!this.stopped) this.diagnose();
      }
    };
    this.rotationTimer = this.$.clock.after(0, () => { void verify(); });
  }

  async stop() {
    this.stopped = true;
    this.sessionStarted = false;
    this.timer?.cancel();
    this.timer = undefined;
    this.rotationTimer?.cancel();
    this.rotationTimer = undefined;
    this.cancelDiscovery?.();
    this.cancelDiscovery = undefined;
    // A submission that reached the host without claim evidence ends unresolved.
    // The business text is never submitted again.
    const awaiting = [...this.awaitingClaims.values()];
    for (const entry of awaiting) this.forgetClaim(entry);
    for (const entry of awaiting) await this.endUnproven(entry, 'SESSION_ENDED');
  }

  headers(identity = this.identity ?? { sessionId: this.sessionId }) {
    return {
      Authorization: `Bearer ${this.token}`,
      'x-session-id': identity.sessionId,
      ...(identity.instanceId === undefined ? {} : { 'x-bridge-instance': identity.instanceId }),
      ...(identity.generation === undefined ? {} : { 'x-bridge-generation': String(identity.generation) }),
      'Content-Type': 'application/json',
    };
  }

  async rememberBootstrapPath() {
    const configured = await this.$.env.get('ARLO_CLAUDECODE_BRIDGE_BOOTSTRAP');
    if (typeof configured === 'string' && configured.length > 0 && configured.length <= 4096 &&
        (/[/\\]/.test(configured) || configured.endsWith('.json')) && typeof this.$.fs?.read === 'function') {
      this.bootstrapPath = configured;
    }
  }

  async readBootstrapMaterial() {
    if (!this.bootstrapPath || typeof this.$.fs?.read !== 'function') return undefined;
    let text;
    try {
      text = await this.$.fs.read(this.bootstrapPath);
    } catch {
      return undefined;
    }
    try {
      return parseBootstrap(text);
    } catch {
      return undefined;
    }
  }

  async suspendForRecovery() {
    if (this.stopped || this.recovering || !this.bootstrapPath) return;
    this.recovering = true;
    this.sessionStarted = false;
    this.timer?.cancel();
    this.timer = undefined;
    this.identity = undefined;
    this.bindingStatus = undefined;
    const started = await this.$.clock.now();
    try {
      while (!this.stopped) {
        if ((await this.$.clock.now()) - started >= SIDECAR_RECOVERY_BUDGET_MS) {
          this.diagnose();
          return;
        }
        const material = await this.readBootstrapMaterial();
        if (material?.status === 'exhausted') {
          this.diagnose();
          return;
        }
        const sessionId = await this.$.session.id();
        if (this.stopped) return;
        if (material?.status === 'active' && material.sessionId === sessionId) {
          this.sessionId = sessionId;
          this.bridgeUrl = material.url;
          this.token = material.token;
          this.expectedInstanceId = material.instanceId;
          try {
            const status = await this.request('/status', { sessionId });
            if (this.stopped) return;
            const discovered = bridgeIdentity(status);
            if (discovered.instanceId !== material.instanceId || discovered.sessionId !== sessionId) {
              throw new Error('Bridge instance does not match');
            }
            if (status.status === 'draining') {
              this.resumeAfter(Promise.resolve(discovered), discovered.sessionId);
              return;
            }
            const handshake = await this.request('/handshake', discovered, {
              modVersion: '0.1.0', capabilities: ['prompt.submit'],
            });
            const identity = bridgeIdentity(handshake, sessionId);
            if (handshake.accepted !== true || identity.instanceId !== discovered.instanceId ||
                identity.generation <= discovered.generation) throw new Error('Bridge handshake was refused');
            this.identity = identity;
            this.bindingStatus = 'active';
            if (!this.stopped) this.enable();
            return;
          } catch {
            // Replacement coordinates are not authenticated yet.
          }
        }
        if (this.stopped) return;
        await new Promise(resolve => {
          this.rotationTimer = this.$.clock.after(SIDECAR_RECOVERY_RETRY_MS, resolve);
        });
      }
    } finally {
      this.recovering = false;
    }
  }

  async pollOnce() {
    if (this.polling || !this.isIdle()) return;
    this.polling = true;
    const identity = this.identity;
    try {
      const response = await this.$.http.fetch(`${this.bridgeUrl}/api/v1/bridge/messages/pending`, {
        method: 'GET', headers: this.headers(identity),
      });
      if (response.status === 401) {
        await this.suspendForRecovery();
        return;
      }
      if (!response.ok || !this.isIdle()) return;
      const body = JSON.parse(response.text);
      if (!body || !Array.isArray(body.messages)) return;
      for (const message of body.messages) {
        if (!this.isIdle()) break;
        await this.dispatchMessage(message, identity);
      }
    } catch {
      await this.suspendForRecovery();
    } finally {
      this.polling = false;
    }
  }

  async report(message, status, reason, identity = this.identity) {
    const timestamp = await this.$.clock.now();
    const response = await this.$.http.fetch(`${this.bridgeUrl}/api/v1/bridge/messages/settle`, {
      method: 'POST',
      headers: this.headers(identity),
      body: JSON.stringify({
        nativeMessageId: message.nativeMessageId,
        messageId: message.messageId,
        status,
        timestamp,
        ...(reason === undefined ? {} : { reason }),
      }),
    });
    return response.ok;
  }

  /**
   * Claim evidence. Only the host turn input counts: a turn that ingested this
   * message carries its marker there. An unrelated turn, the sender's own
   * submit hook and a model echo of the marker carry none.
   */
  inspectClaimEvidence(event) {
    if (this.awaitingClaims.size === 0) return;
    const input = turnInput(event);
    if (input === undefined) return;
    for (const entry of [...this.awaitingClaims.values()]) {
      if (entry.matched || !input.includes(entry.marker)) continue;
      entry.matched = true;
      // The host can start the turn before the handoff report is durable. Hold
      // the proof until the Sidecar records the submission it belongs to.
      if (entry.submitted) void this.reportClaim(entry, event?.turnId);
    }
  }

  async reportClaim(entry, turnId) {
    try {
      const timestamp = await this.$.clock.now();
      const response = await this.$.http.fetch(`${this.bridgeUrl}/api/v1/bridge/messages/claim`, {
        method: 'POST',
        headers: this.headers(entry.identity),
        body: JSON.stringify({
          nativeMessageId: entry.message.nativeMessageId,
          messageId: entry.message.messageId,
          correlationMarker: entry.marker,
          timestamp,
          ...(turnId === undefined ? {} : { turnId }),
        }),
      });
      if (response.ok) {
        this.forgetClaim(entry);
        return;
      }
      // A refused claim means the input already reached a final state. A
      // transport failure leaves it for the evidence window to end unknown.
      if (response.status === 404 || response.status === 409) this.forgetClaim(entry);
    } catch {
      // Keep the entry until the evidence window ends unresolved.
    }
  }

  awaitClaim(message, marker, identity) {
    if (this.awaitingClaims.has(marker)) return this.awaitingClaims.get(marker);
    const entry = {
      marker,
      message,
      identity,
      submitted: false,
      matched: false,
      timer: this.$.clock.after(this.claimEvidenceTimeoutMs, () => {
        void this.resolveUnproven(entry, 'CLAIM_EVIDENCE_TIMEOUT');
      }),
    };
    this.awaitingClaims.set(marker, entry);
    return entry;
  }

  forgetClaim(entry) {
    entry.timer?.cancel();
    entry.timer = undefined;
    this.awaitingClaims.delete(entry.marker);
  }

  async resolveUnproven(entry, reason) {
    this.forgetClaim(entry);
    await this.endUnproven(entry, reason);
  }

  /**
   * Ends one unproven handoff. A submission that never reached the host is
   * settled by its own outcome instead, including the prompt.submit timeout.
   */
  async endUnproven(entry, reason) {
    // The handoff report may still be pending. Keep the termination request on
    // the entry so dispatchMessage can apply it after that report completes.
    entry.endReason ??= reason;
    if (!entry.submitted) return;
    try {
      await this.report(entry.message, 'unknown', entry.endReason, entry.identity);
    } catch {
      // A failed report leaves the durable record conservative.
    }
  }

  async dispatchMessage(message, identity = this.identity) {
    if (!this.isIdle() || this.inFlightDispatch.has(message.nativeMessageId)) return;
    this.inFlightDispatch.add(message.nativeMessageId);
    try {
      const armed = await this.report(message, 'dispatching', undefined, identity);
      if (!armed) return;
      // The bridge request can outlive a turn change or session.end. Cancelling
      // here is safe because this attempt has not called the host at all.
      if (!this.isIdle()) {
        await this.report(message, 'enqueued', undefined, identity);
        return;
      }

      const marker = typeof message.correlationMarker === 'string' && message.correlationMarker
        ? message.correlationMarker
        : undefined;
      // There is no await between the final idle/lifecycle check and host entry,
      // so a claim can only be observed after this reservation exists.
      const entry = marker ? this.awaitClaim(message, marker, identity) : undefined;
      const handoff = await this.submitPrompt(marker ? composeSubmittedPrompt(message.text, marker) : message.text);
      if (handoff.result === 'dropped') {
        if (entry) this.forgetClaim(entry);
        await this.report(message, 'discarded', handoff.reason, identity);
        return;
      }
      if (handoff.result === 'failed') {
        if (entry) this.forgetClaim(entry);
        await this.report(message, 'unknown', 'PROMPT_SUBMIT_UNRESOLVED', identity);
        return;
      }
      // The handoff reached the host. It is not a claim.
      let handed = false;
      try {
        handed = await this.report(message, 'submitting', undefined, identity);
      } catch {
        // A lost response cannot tell us whether the durable handoff was
        // recorded. Both dispatching and submitting can safely end unknown.
      }
      if (!handed) {
        if (entry) this.forgetClaim(entry);
        await this.report(message, 'unknown', 'HANDOFF_REPORT_FAILED', identity);
        return;
      }
      if (!entry) {
        // A bridge that issued no marker still gets its business text delivered,
        // but no host turn can ever prove that claim.
        await this.report(message, 'unknown', 'CORRELATION_MARKER_UNAVAILABLE', identity);
        return;
      }
      entry.submitted = true;
      if (entry.endReason) {
        await this.endUnproven(entry, entry.endReason);
        return;
      }
      if (entry.matched) void this.reportClaim(entry);
    } catch {
      // Without a confirmed transition, keep the durable record conservative.
    } finally {
      this.inFlightDispatch.delete(message.nativeMessageId);
    }
  }

  /**
   * Enters the host with this message's prompt. `entered` is the host handoff
   * and never a claim; `dropped` is an explicit host refusal.
   */
  async submitPrompt(text) {
    let timeout;
    let submitted;
    try {
      submitted = Promise.resolve(this.$.prompt.submit({ text })).then(
        (value) => ({ ok: true, value }),
        () => ({ ok: false }),
      );
    } catch {
      return { result: 'failed' };
    }
    const expired = new Promise((resolve) => {
      timeout = this.$.clock.after(this.promptSubmitTimeoutMs, () => {
        resolve({ ok: false });
      });
    });
    try {
      const outcome = await Promise.race([submitted, expired]);
      if (!outcome.ok) return { result: 'failed' };
      if (outcome.value && Object.prototype.hasOwnProperty.call(outcome.value, 'drop')) {
        return { result: 'dropped', reason: typeof outcome.value.drop === 'string' ? outcome.value.drop : undefined };
      }
      return { result: 'entered' };
    } finally {
      timeout?.cancel();
    }
  }
}

export function register(on) {
  let dispatcher;
  let host;
  let revision = 0;
  const tools = new Map();
  const commands = new Set(HUMAN_COMMANDS.map(definition => definition.name));

  on('session.start', async ($, event, next) => {
    revision++;
    void dispatcher?.stop();
    // The Mod compiler requires lexical $.noun.action calls; the $ facade itself
    // cannot be captured inside an object or stored on a dispatcher instance.
    host = {
      session: { id: () => $.session.id() },
      env: {
        get: (name) => {
          // Literal names let the host enumerate the module's environment access.
          if (name === 'ARLO_CLAUDECODE_BRIDGE_URL') return $.env.get('ARLO_CLAUDECODE_BRIDGE_URL');
          if (name === 'ARLO_CLAUDECODE_BRIDGE_TOKEN') return $.env.get('ARLO_CLAUDECODE_BRIDGE_TOKEN');
          if (name === 'ARLO_CLAUDECODE_BRIDGE_BOOTSTRAP') return $.env.get('ARLO_CLAUDECODE_BRIDGE_BOOTSTRAP');
          return Promise.resolve(undefined);
        },
      },
      http: { fetch: (url, init) => $.http.fetch(url, init) },
      fs: { read: (filePath) => $.fs.read(filePath) },
      prompt: { submit: (input) => $.prompt.submit(input) },
      ui: { log: (text) => $.ui.log(text) },
      clock: {
        now: () => $.clock.now(),
        every: (delay, callback) => $.clock.every(delay, callback),
        after: (delay, callback) => $.clock.after(delay, callback),
      },
    };
    dispatcher = new ClaudeCodeModDispatcher({ $: host });
    await dispatcher.start();
    for (const definition of MODEL_TOOLS) {
      const registered = await $.tool.register(definition);
      tools.set(registered.tool, definition.name);
    }
    for (const definition of HUMAN_COMMANDS) await $.command.register(definition);
    return next(event);
  });

  on('command.run', async ($, event, next) => {
    if (!commands.has(event.command)) return next(event);
    // Claude stamps this origin; SDK, plugin and model-authored deliveries do
    // not prove that the person chose to change this root's sending allowance.
    if (event.agentId !== undefined || !['composer', 'bridge'].includes(event.origin?.kind)) {
      return { text: 'PERMISSION_DENIED: Arlo commands require a direct user action in the current root session.' };
    }
    if (typeof event.args !== 'string' || (event.command === 'arlo-settings'
      ? !['', 'on', 'off'].includes(event.args.trim())
      : event.args.trim() !== '')) {
      return { text: event.command === 'arlo-settings'
        ? 'INVALID_ARGUMENT: /arlo-settings accepts only on, off or no argument.'
        : `INVALID_ARGUMENT: /${event.command} does not accept arguments.` };
    }
    const current = dispatcher;
    try {
      if (!current) throw new Error('CHANNEL_NOT_READY: Arlo communication is unavailable.');
      return await current.callCommand(event.command, event.args.trim());
    } catch (error) {
      return { text: error?.message || 'Arlo command result unavailable.' };
    }
  }).catch(($, event, next) => commands.has(event.command)
    ? { text: 'Arlo command result unavailable. Check the current status before trying again.' }
    : next(event));

  on('tool.call', async ($, event, next) => {
    const name = tools.get(event.tool);
    if (!name) return next(event);
    if (event.agentId !== undefined) return { deny: 'PERMISSION_DENIED: Arlo tools are available only to the main root session.' };
    const current = dispatcher;
    try {
      if (!current) throw new Error('CHANNEL_NOT_READY: Arlo communication is unavailable.');
      // The official tool.call envelope spreads model arguments beside these
      // reserved host fields. Forward every other field for runtime validation.
      const { tool, tool_use_id, agentId, consent, requestMeta, ...args } = event;
      return await current.callTool(name, args);
    } catch (error) {
      // The host skips hooks that throw. An owned tool must return an explicit
      // refusal instead; uncertain HTTP results never trigger a resend.
      return { deny: `${error?.message || 'Arlo tool result unavailable.'} Delivery may be unknown; do not automatically resend.` };
    }
  }).catch(($, event, next) => tools.has(event.tool)
    ? { deny: 'Arlo tool result unavailable. Delivery may be unknown; do not automatically resend.' }
    : next(event));

  on('turn.start', async ($, event, next) => {
    // The turn input carries the correlation marker of the message the host
    // ingested, if it ingested one at all.
    if (event?.turnId) dispatcher?.onTurnStart(event.turnId, event);
    return next(event);
  });

  on('turn.complete', async ($, event, next) => {
    const current = dispatcher;
    const result = await next(event);
    if (event?.turnId) current?.onTurnComplete(event.turnId, event.agentId);
    return result;
  });

  on('session.end', async ($, event, next) => {
    const ending = dispatcher;
    // A late event for an already retired root never stops its replacement.
    if (!ending || ending.sessionStarted && event?.sessionId && ending.sessionId && event.sessionId !== ending.sessionId) return next(event);
    const currentRevision = ++revision;
    void ending.stop();
    const retirement = event?.sessionId
      ? ending.retire(event.sessionId)
      : Promise.reject(new Error('Ending session identity is unavailable'));
    void retirement.catch(() => {});
    const result = await next(event);
    if (currentRevision !== revision) return result;
    if (event?.reason === 'clear' || event?.reason === 'resume') {
      dispatcher = new ClaudeCodeModDispatcher({ $: host });
      dispatcher.resumeAfter(retirement, event.sessionId);
    }
    return result;
  });
}
