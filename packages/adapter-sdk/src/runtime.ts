import { ReceptionLedger, receiptOutcome, type ReceptionHost } from './index.ts';
import crypto from 'node:crypto';
import {
  ArloErrorCode,
  ArloError,
  assertNodeRuntime,
  ControlClient,
  ConnectionLease,
  validateExplicitGroupName,
  validateHostKind,
  resolveCommunicationGroup,
  type ResolvedCommunicationGroup,
  FORBIDDEN_MODEL_ARGUMENT_KEYS,
  MAX_SINGLE_TEXT_BYTES,
  MAX_ROOT_PENDING_MESSAGES,
  ARLO_PROFILE_VERSION,
  type RootRegistrationResponse,
  type RootRegistrationRequest,
  type RootConnection,
  type SessionDiscoveryItem,
  type RootConfigurationEvidence,
  type RootConfigurationStatus,
  type RootSendingStatus,
  type ContinueCollaborationRequest,
  type RootFirstUseEvidence,
} from '@arlo/sdk';


/** Trusted adapter boundary. Handles are opaque live objects, never model arguments.
 * roots() must exclude children and removed/replaced instances. Events publish
 * changes to that same live set. Native scheduling and input stay in reception().
 */
export interface AdapterHost<Root extends object> {
  roots(): readonly Root[];
  sessionId(root: Root): string;
  sessionCwd(root: Root): string | undefined;
  /** Public persistence evidence for this exact live root. May flush through a
   * public host API; must never write frozen metadata or private host files. */
  rootConfigurationEvidence?(root: Root): RootConfigurationEvidence | undefined | Promise<RootConfigurationEvidence | undefined>;
  /** A public host creation witness and its validated durable ownership.
   * Existing roots and an absent record alone cannot establish first use. */
  rootFirstUseEvidence?(root: Root): RootFirstUseEvidence | undefined | Promise<RootFirstUseEvidence | undefined>;
  reception(root: Root): ReceptionHost;
  onCreated(listener: (root: Root) => void): () => void;
  onDisposed(listener: (root: Root) => void): () => void;
}

export interface SharedStartupOptions {
  stateDir?: string;
  idleTimeoutMs?: number;
  signal: AbortSignal;
}

/**
 * Applies the declared argument envelope for a model tool: no property from
 * `FORBIDDEN_MODEL_ARGUMENT_KEYS` and no key outside the tool's own declared
 * parameters may reach the daemon.
 */
function assertModelArgumentEnvelope(args: unknown, allowedKeys: readonly string[]): void {
  if (!args || typeof args !== 'object') return;
  for (const key of FORBIDDEN_MODEL_ARGUMENT_KEYS) {
    if (key in args) {
      throw new ArloError(
        ArloErrorCode.INVALID_ARGUMENT,
        `INVALID_ARGUMENT: forbidden argument property "${key}" in model tool call`
      );
    }
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new ArloError(
        ArloErrorCode.INVALID_ARGUMENT,
        `INVALID_ARGUMENT: undeclared argument property "${key}" in model tool call`
      );
    }
  }
}

export interface AdapterRuntimeOptions<Root extends object> {
  host: AdapterHost<Root>;
  /** Injected by Node host assembly; cancellation only stops this caller's wait. */
  startSharedDaemon?: (options: SharedStartupOptions) => Promise<unknown>;
  groupName?: string;
  /** Trusted host configuration only: return an already-confirmed Workspace binding. */
  getConfirmedWorkspaceDirectory?: (agent: Root) => string | undefined;
  /** Host presentation metadata. Published at registration and refreshed by authenticated heartbeats. */
  getSessionTitle?: (agent: Root) => string | undefined;
  stateDir?: string;
  controlClient?: ControlClient;
  /** Default on for the built-in client. Injected clients opt in explicitly. */
  autoStart?: boolean | { idleTimeoutMs?: number };
  hostType: string;
  hostVersion: string;
  /** Stable adapter identity; never derive it from a configurable display alias. */
  hostKind?: string;
  /** Applies to every root in this runtime. Defaults to false. */
  crossHostEnabled?: boolean;
  participationScope?: string;
  /** Controlled time and randomness at the transport recovery boundary. */
  recovery?: {
    random?: () => number;
    setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
    heartbeatIntervalMs?: number;
    leaseDurationMs?: number;
    now?: () => number;
  };
  /** Notified when a root binding transitions between ready and disconnected/unready. */
  onReady?: (agent: Root, ready: boolean) => void;
}

interface LiveRootBinding<Root extends object> {
  agent: Root;
  endpointId: string;
  rootToken: string;
  generation: number;
  groupId: string;
  groupName?: string;
  incarnation: string;
  active: boolean;
  ready: boolean;
  connection: RootConnection;
  reception: ReceptionHost;
  deduplicator: ReceptionLedger;
  stopNotification?: () => void;
  stopDisconnect?: () => void;
  lease?: ConnectionLease;
  continuityToken: string;
}

interface PendingRootRegistration<Root extends object> {
  agent: Root;
  request: RootRegistrationRequest;
  runtimeId: string;
  runtimeToken: string;
  daemonEpoch: number;
  registration?: RootRegistrationResponse;
  settled: Promise<void>;
  settle: () => void;
  cleanup?: Promise<void>;
}

export function createAdapterRuntime<Root extends object>(options: AdapterRuntimeOptions<Root>) {
  assertNodeRuntime();
  const { groupName: rawGroupName, stateDir, hostType, hostVersion, host } = options;
  const groupName = rawGroupName === undefined ? undefined : validateExplicitGroupName(rawGroupName).groupName;
  const hostKind = options.hostKind === undefined ? undefined : validateHostKind(options.hostKind);
  if (options.crossHostEnabled !== undefined && typeof options.crossHostEnabled !== 'boolean') {
    throw new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Cross-host participation must be a boolean');
  }
  let crossHostEnabled = options.crossHostEnabled ?? false;
  type CreateContact = (sessionId: string, signal: AbortSignal) => Promise<Root>;
  const sessionTitle = (agent: Root): string | undefined => {
    const title = options.getSessionTitle ? options.getSessionTitle(agent)?.trim() : host.sessionId(agent);
    if (!title) return undefined;
    // Presentation must never make the lease heartbeat invalid. Preserve whole
    // Unicode code points when bounding the registered and refreshed title.
    let bytes = 0;
    let bounded = '';
    for (const character of title) {
      bytes += Buffer.byteLength(character, 'utf8');
      if (bytes > 4096) break;
      bounded += character;
    }
    return bounded;
  };

  const controlClient = options.controlClient ?? new ControlClient({ stateDir });
  const pluginGeneration = Date.now();
  let runtimeToken: string | undefined;
  let runtimeId = `rt-${crypto.randomUUID()}`;
  let runtimeEstablished = false;
  let daemonId: string | undefined;
  let daemonEpoch = 0;
  let runtimeContinuity = crypto.randomBytes(32).toString('hex');
  let runtimeRegisteredPromise: Promise<string | undefined> | undefined;
  const schedule = options.recovery?.setTimeout ?? setTimeout;
  const cancelTimer = options.recovery?.clearTimeout ?? clearTimeout;
  const random = options.recovery?.random ?? Math.random;

  const activeBindings = new Map<Root, LiveRootBinding<Root>>();
  // Once evidence exists or its provider fails, an ambiguous first attempt is
  // never retried as new authorization. An unsaved root may supply proof later.
  const initializations = new WeakSet<Root>();
  const initializationRequests = new WeakMap<Root, {
    binding: LiveRootBinding<Root>; connection: RootConnection;
    pending: Promise<RootSendingStatus | undefined>;
  }>();
  const continuationRequests = new WeakMap<Root, {
    binding: LiveRootBinding<Root>; connection: RootConnection;
    request?: ContinueCollaborationRequest; pending?: Promise<RootSendingStatus>; actionId?: string;
  }>();
  const humanRequests = new WeakMap<Root, Map<string, ContinueCollaborationRequest>>();
  const authorizations = new WeakMap<Root, { id: string; pending?: Promise<RootSendingStatus> }>();
  const pendingAccounting = new Set<Promise<unknown>>();
  const retiringBindings = new Map<Root, Promise<void>>();
  function trackAccounting<T>(request: Promise<T>): Promise<T> {
    pendingAccounting.add(request);
    void request.then(() => pendingAccounting.delete(request), () => pendingAccounting.delete(request));
    return request;
  }
  const pendingRegistrations = new Map<Root, Promise<LiveRootBinding<Root> | undefined>>();
  const initialRegistrations = new Map<Root, PendingRootRegistration<Root>>();
  const retiredRegistrations = new Set<PendingRootRegistration<Root>>();
  const selections = new WeakMap<Root, Promise<ResolvedCommunicationGroup>>();
  const contactCreations = new Map<string, {
    selection: Promise<ResolvedCommunicationGroup>;
    first: ReturnType<typeof Promise.withResolvers<LiveRootBinding<Root>>>;
  }>();
  const registrationErrors = new WeakMap<Root, ArloError>();
  const epochs = new WeakMap<Root, number>();
  let initialIdentities = new WeakMap<Root, { incarnation: string; continuityToken: string }>();
  const switching = new Set<Root>();
  // Keep failed revocations retryable; losing the token must not allow a new
  // group to become active while the daemon still holds the previous binding.
  const revocations = new Map<Root, Map<string, string>>();
  const recoveryWaits = new Map<Root, { timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
  const recoveryRequested = new Set<Root>();
  let pluginDisposed = false;
  const pauseState: {
    paused: boolean; epoch: number; pausing?: Promise<void>; resuming?: Promise<void>; restoring: boolean;
  } = { paused: false, epoch: 0, restoring: false };
  const inactive = () => pluginDisposed || pauseState.paused;
  let shutdownPromise: Promise<void> | undefined;
  const startup = new AbortController();

  async function ensureRuntime(): Promise<string | undefined> {
    if (!runtimeRegisteredPromise) {
      runtimeRegisteredPromise = (async () => {
        const autoStart = options.autoStart ?? !options.controlClient;
        if (autoStart) {
          if (!options.startSharedDaemon) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY, 'Shared startup capability is not configured');
          await options.startSharedDaemon({
            stateDir,
            idleTimeoutMs: typeof autoStart === 'object' ? autoStart.idleTimeoutMs : undefined,
            signal: startup.signal,
          });
        }
        if (pluginDisposed) return undefined;
        const currentDaemon = await controlClient.refreshConnection();
        if (pluginDisposed) return undefined;
        if (daemonId && daemonId !== currentDaemon) {
          if (pauseState.paused || pauseState.restoring) throw new ArloError(ArloErrorCode.ACCOUNTING_UNAVAILABLE);
          // A new daemon has no old ledger. New local bindings must likewise
          // have no old native mapping or proof, even for the same SessionId.
          runtimeToken = undefined;
          daemonEpoch++;
          for (const agent of host.roots()) recoveryRequested.add(agent);
          runtimeId = `rt-${crypto.randomUUID()}`;
          runtimeEstablished = false;
          runtimeContinuity = crypto.randomBytes(32).toString('hex');
          initialIdentities = new WeakMap();
          initialRegistrations.clear();
          retiredRegistrations.clear();
          for (const binding of [...activeBindings.values()]) invalidateBinding(binding, false);
          revocations.clear();
        }
        daemonId = currentDaemon;
        if (runtimeToken) return runtimeToken;
        const res = runtimeEstablished
          ? await controlClient.reauthenticateRuntime({ runtime_id: runtimeId, continuity_token: runtimeContinuity })
          : await controlClient.registerRuntime({ runtime_id: runtimeId, host_type: hostType, host_version: hostVersion,
            host_kind: hostKind, cross_host_enabled: crossHostEnabled,
            participation_scope: options.participationScope, continuity_token: runtimeContinuity });
        if (pluginDisposed) {
          // Unload can run before the response supplies a token. The late
          // continuation still owns cleanup, but never reactivates the plugin.
          await controlClient.revokeRuntime(res.runtime_token).catch(() => {});
          return undefined;
        }
        runtimeId = res.runtime_id;
        runtimeEstablished = true;
        runtimeToken = res.runtime_token;
        // Other live roots also need their fresh binding after a daemon change.
        for (const agent of host.roots()) {
          if (!pendingRegistrations.has(agent) && !activeBindings.has(agent)) {
            void registerRootSession(agent, true).catch(() => {});
          }
        }
        return runtimeToken;
      })().finally(() => { runtimeRegisteredPromise = undefined; });
    }
    return runtimeRegisteredPromise;
  }

  function cancelRecoveryWait(agent: Root): void {
    const waiting = recoveryWaits.get(agent);
    if (!waiting) return;
    recoveryWaits.delete(agent);
    cancelTimer(waiting.timer);
    waiting.resolve();
  }

  function recoveryDelay(agent: Root, attempt: number): Promise<void> {
    // Equal jitter with an explicit floor: every wait is in [250 ms, 10 s].
    const ceiling = Math.min(10000, 500 * 2 ** Math.min(attempt, 5));
    const delay = Math.floor(ceiling / 2 + Math.max(0, Math.min(1, random())) * ceiling / 2);
    return new Promise(resolve => {
      const timer = schedule(() => { recoveryWaits.delete(agent); resolve(); }, delay);
      timer.unref?.();
      recoveryWaits.set(agent, { timer, resolve });
    });
  }

  function registerRootSession(agent: Root, delayFirst = false): Promise<LiveRootBinding<Root> | undefined> {
    const pending = pendingRegistrations.get(agent);
    if (pending) return pending;
    if (!host.roots().includes(agent) || inactive()) return Promise.resolve(undefined);
    registrationErrors.delete(agent);
    const contactCreation = contactCreations.get(host.sessionId(agent));
    if (!selections.has(agent)) {
      // Read trusted creation/Workspace state before any asynchronous startup;
      // a registration retry must never select a later Workspace or shell cwd.
      selections.set(agent, contactCreation?.selection ?? resolveCommunicationGroup({
        groupName,
        workspaceDir: groupName === undefined ? options.getConfirmedWorkspaceDirectory?.(agent) : undefined,
        sessionCwd: host.sessionCwd(agent),
      }));
    }
    const epoch = epochs.get(agent) ?? 0;
    const registration = (async () => {
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0 || delayFirst) await recoveryDelay(agent, attempt);
        if (inactive() || (epochs.get(agent) ?? 0) !== epoch || !host.roots().includes(agent)) return undefined;
        try {
          const binding = await registerRootSessionOnce(agent, epoch);
          if (binding?.ready) contactCreation?.first.resolve(binding);
          else contactCreation?.first.reject(new ArloError(ArloErrorCode.CHANNEL_NOT_READY));
          return binding;
        } catch (err) {
          // Explicit preparation observes its first failure. Normal transport
          // recovery keeps its existing policy and never recreates the Host Session.
          contactCreation?.first.reject(err);
          if ((epochs.get(agent) ?? 0) !== epoch) return undefined;
          if (pauseState.restoring || inactive() || err instanceof ArloError && [
            ArloErrorCode.ACCOUNTING_UNAVAILABLE, ArloErrorCode.RECEIPT_CONFLICT,
            ArloErrorCode.GROUP_CONTEXT_REQUIRED,
            ArloErrorCode.GROUP_DIRECTORY_UNAVAILABLE, ArloErrorCode.GIT_RESOLUTION_FAILED,
            ArloErrorCode.GIT_METADATA_INVALID,
            ArloErrorCode.UNSUPPORTED_PROFILE, ArloErrorCode.UNSUPPORTED_VERSION,
          ].some(code => code === err.code)) throw err;
        }
      }
    })().catch(error => {
      if ((epochs.get(agent) ?? 0) === epoch) {
        // Expose a fixed code to the real root without leaking host paths or
        // raw filesystem/Git exception text through a model tool result.
        registrationErrors.set(agent, new ArloError(error instanceof ArloError ? error.code : ArloErrorCode.CHANNEL_NOT_READY));
      }
      throw error;
    }).finally(() => {
      pendingRegistrations.delete(agent);
      if (recoveryRequested.delete(agent) && !inactive() && !switching.has(agent) &&
          (epochs.get(agent) ?? 0) === epoch && !registrationErrors.has(agent)) {
        void registerRootSession(agent, true).catch(() => {});
      }
    });
    pendingRegistrations.set(agent, registration);
    return registration;
  }

  async function revokePending(agent: Root): Promise<void> {
    // Explicit retirement keeps the old transport authenticated until its
    // final accounting settles; replacement registration must wait as well.
    await retiringBindings.get(agent);
    const pending = revocations.get(agent);
    if (!pending) return;
    for (const [endpointId, rootToken] of pending) {
      await controlClient.revokeRoot(runtimeToken ?? rootToken, { endpoint_id: endpointId });
      pending.delete(endpointId);
    }
    if (pending.size === 0) revocations.delete(agent);
  }

  function rememberRevocation(agent: Root, endpointId: string, rootToken: string): void {
    if (!rootToken) return;
    let pending = revocations.get(agent);
    if (!pending) revocations.set(agent, pending = new Map());
    pending.set(endpointId, rootToken);
  }

  function retireRegistration(agent: Root, attempt = initialRegistrations.get(agent)): void {
    if (!attempt) return;
    if (initialRegistrations.get(agent) === attempt) initialRegistrations.delete(agent);
    retiredRegistrations.add(attempt);
    void cleanupRegistration(attempt).catch(() => {});
  }

  function cleanupRegistration(attempt: PendingRootRegistration<Root>): Promise<void> {
    return attempt.cleanup ??= (async () => {
      await attempt.settled;
      if (pluginDisposed || attempt.daemonEpoch !== daemonEpoch) {
        retiredRegistrations.delete(attempt);
        return;
      }
      const ownerToken = attempt.runtimeId === runtimeId ? runtimeToken ?? attempt.runtimeToken : attempt.runtimeToken;
      try {
        // A lost response hides whether registration happened. Recover only
        // with the old request's exact instance/continuity proof, then revoke;
        // no notification connection or host insertion is created here.
        attempt.registration ??= await controlClient.registerRoot(ownerToken, attempt.request);
        if (pluginDisposed || attempt.daemonEpoch !== daemonEpoch) return;
        await controlClient.revokeRoot(ownerToken, { endpoint_id: attempt.registration.endpoint_id });
        retiredRegistrations.delete(attempt);
      } catch (error) {
        if (runtimeToken === ownerToken && error instanceof ArloError &&
            [ArloErrorCode.UNAUTHORIZED, ArloErrorCode.STALE_GENERATION].some(code => error.code === code)) runtimeToken = undefined;
        throw error;
      }
    })().finally(() => { attempt.cleanup = undefined; });
  }

  async function finishRetiredRegistrations(agent: Root): Promise<void> {
    // SessionId is only a serialization barrier. Ownership and cleanup use
    // each retired Root's retained request and credential, never its name.
    for (const attempt of retiredRegistrations) {
      if (attempt.request.root_session_id === host.sessionId(agent)) await cleanupRegistration(attempt);
    }
    for (const oldRoot of revocations.keys()) {
      if (host.sessionId(oldRoot) === host.sessionId(agent)) await revokePending(oldRoot);
    }
  }

  /** Trusted host/user group selection, deliberately absent from model tools. */
  async function switchRootGroup(agent: Root, name: string): Promise<void> {
    if (pluginDisposed || !host.roots().includes(agent)) {
      throw new ArloError(ArloErrorCode.CALLER_NOT_ROOT);
    }
    if (switching.has(agent)) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    const selected = { ...validateExplicitGroupName(name), source: 'explicit' as const };
    switching.add(agent);
    registrationErrors.delete(agent);
    epochs.set(agent, (epochs.get(agent) ?? 0) + 1);
    cancelRecoveryWait(agent);
    retireRegistration(agent);
    initialIdentities.delete(agent);
    selections.set(agent, Promise.resolve(selected));
    const binding = activeBindings.get(agent);
    if (binding) retireBinding(binding);
    try {
      // Any response from an earlier registration is revoked by its owning
      // continuation before replacement registration can begin.
      await pendingRegistrations.get(agent)?.catch(() => {});
      await revokePending(agent);
      const replacement = await registerRootSession(agent);
      if (!replacement?.ready) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    } finally {
      switching.delete(agent);
    }
  }

  function disconnectBinding(binding: LiveRootBinding<Root>, transport: 'close' | 'drain' = 'close'): void {
    const wasReady = binding.ready;
    binding.active = false;
    binding.ready = false;
    binding.stopDisconnect?.();
    binding.stopDisconnect = undefined;
    binding.lease?.stop();
    binding.lease = undefined;
    binding.stopNotification?.();
    binding.stopNotification = undefined;
    if (transport === 'close') binding.connection.dispose();
    if (wasReady) {
      try { options.onReady?.(binding.agent, false); } catch {}
    }
  }

  function invalidateBinding(binding: LiveRootBinding<Root>, revoke = true, transport: 'close' | 'drain' = 'close',
    preserveReception = false): string {
    disconnectBinding(binding, transport);
    if (!preserveReception) {
      binding.deduplicator.dispose();
      if (activeBindings.get(binding.agent) === binding) activeBindings.delete(binding.agent);
    }
    const rootToken = binding.rootToken;
    binding.rootToken = '';
    binding.continuityToken = '';
    if (revoke) rememberRevocation(binding.agent, binding.endpointId, runtimeToken ?? rootToken);
    return rootToken;
  }

  function drainAccounting(requests: Promise<unknown>[]): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      Promise.allSettled(requests).then(() => {}),
      // A broken injected client cannot hold teardown open indefinitely.
      new Promise<void>(resolve => { deadline = setTimeout(resolve, 15000); }),
    ]).finally(() => { clearTimeout(deadline); });
  }

  /** Explicit host retirement only; transport loss and daemon replacement do
   * not authorize a final snapshot against the old binding. */
  function retireBinding(binding: LiveRootBinding<Root>, preserveReception = false): void {
    const connection = binding.connection;
    const rootToken = binding.rootToken;
    const authorized = activeBindings.get(binding.agent) === binding && binding.active &&
      rootToken !== '' && binding.lease?.isValid() !== false;
    // Stop callbacks synchronously before asking host code for its final view.
    // Keep SSE open until the proofs already issued under this token settle.
    disconnectBinding(binding, 'drain');
    if (authorized) {
      binding.deduplicator.reconcilePendingMessageIds();
      for (const proof of binding.deduplicator.getUnconfirmedCredits()) {
        // Event proofs were already sent by their callback. Do not duplicate
        // a stalled claimed/discarded request during the unload grace period.
        if (proof.event === 'snapshot') {
          void trackAccounting(Promise.resolve().then(() => controlClient.releaseCredit(rootToken, proof))).catch(() => {});
        }
      }
    }
    invalidateBinding(binding, true, 'drain', preserveReception);
    const draining = drainAccounting([...pendingAccounting]).finally(() => {
      connection.dispose();
      if (retiringBindings.get(binding.agent) === draining) retiringBindings.delete(binding.agent);
    });
    retiringBindings.set(binding.agent, draining);
  }

  async function registerRootSessionOnce(agent: Root, epoch: number): Promise<LiveRootBinding<Root> | undefined> {
    const expectedDaemonEpoch = daemonEpoch;
    const current = () => !inactive() && (epochs.get(agent) ?? 0) === epoch &&
      daemonEpoch === expectedDaemonEpoch &&
      host.roots().includes(agent);
    if (!current()) return undefined;
    const selected = await selections.get(agent)!;
    if (!current()) return undefined;
    const rtToken = await ensureRuntime();
    if (!current() || !rtToken) return undefined;
    await finishRetiredRegistrations(agent);
    await revokePending(agent);
    if (!current()) return undefined;
    let binding = activeBindings.get(agent);
    if (binding?.ready && binding.active) return binding;
    const reconnecting = binding !== undefined;
    let registration: RootRegistrationResponse;
    if (binding) {
      try {
        const rotated = await controlClient.connectRoot(rtToken, {
          endpoint_id: binding.endpointId, continuity_token: binding.continuityToken,
        });
        registration = { ...binding.connection.binding, ...rotated };
      } catch (error) {
        if (runtimeToken === rtToken && error instanceof ArloError &&
            [ArloErrorCode.UNAUTHORIZED, ArloErrorCode.STALE_GENERATION].some(code => error.code === code)) runtimeToken = undefined;
        throw error;
      }
      if (!current() || activeBindings.get(agent) !== binding) {
        if (daemonEpoch === expectedDaemonEpoch && !pauseState.paused) {
          rememberRevocation(agent, registration.endpoint_id, rtToken);
          await revokePending(agent);
        }
        return undefined;
      }
      binding.rootToken = registration.root_token;
      binding.generation = registration.generation;
      binding.deduplicator.advanceGeneration(registration.generation);
      binding.connection = controlClient.createRootConnection(registration, { heartbeat: false, requireCrossHostParticipation: true });
      binding.active = true;
    } else {
      let identity = initialIdentities.get(agent);
      if (!identity) {
        identity = { incarnation: crypto.randomUUID(), continuityToken: crypto.randomBytes(32).toString('hex') };
        initialIdentities.set(agent, identity);
      }
      const { incarnation, continuityToken } = identity;
      const settled = Promise.withResolvers<void>();
      const attempt: PendingRootRegistration<Root> = {
        agent, runtimeId, runtimeToken: rtToken, daemonEpoch: expectedDaemonEpoch,
        settled: settled.promise, settle: settled.resolve,
        request: {
          root_session_id: host.sessionId(agent), display_name: sessionTitle(agent),
          ...(selected.source === 'explicit' ? { group_name: selected.groupName! } : { project_group_id: selected.groupId }),
          agent_incarnation: incarnation, plugin_generation: pluginGeneration, continuity_token: continuityToken,
        },
      };
      initialRegistrations.set(agent, attempt);
      try {
        registration = await controlClient.registerRoot(rtToken, attempt.request);
        attempt.registration = registration;
      } catch (error) {
        if (runtimeToken === rtToken && error instanceof ArloError &&
            [ArloErrorCode.UNAUTHORIZED, ArloErrorCode.STALE_GENERATION].some(code => error.code === code)) runtimeToken = undefined;
        if (!current()) retireRegistration(agent, attempt);
        throw error;
      } finally { attempt.settle(); }
      if (!current()) {
        retireRegistration(agent, attempt);
        await cleanupRegistration(attempt);
        return undefined;
      }
      let createdBinding: LiveRootBinding<Root> | undefined;
      const reception = host.reception(agent);
      const deduplicator = new ReceptionLedger({
        host: reception, windowSize: 1024, currentGeneration: registration.generation,
        initialCapacity: MAX_ROOT_PENDING_MESSAGES,
        onReceipt(proof) {
          const ownedBinding = createdBinding;
          if (!ownedBinding || pluginDisposed || activeBindings.get(agent) !== ownedBinding ||
              !ownedBinding.active || ownedBinding.lease?.isValid() === false) return;
          // Late host evidence is accounting, never a business-message retry.
          void trackAccounting(controlClient.submitReceipt(ownedBinding.rootToken, proof)).catch(() => {});
        },
        onCredit(proof) {
          const ownedBinding = createdBinding;
          if (!ownedBinding || pluginDisposed || activeBindings.get(agent) !== ownedBinding ||
              !ownedBinding.active || ownedBinding.lease?.isValid() === false) return;
          // The ledger retains offline evidence. Only the current connection
          // may send it, and the issued request captures its own token.
          void trackAccounting(controlClient.releaseCredit(ownedBinding.rootToken, proof))
            .then(() => deduplicator.acknowledgeCredit(proof.message_id)).catch(() => {});
        },
      });
      binding = {
        agent, endpointId: registration.endpoint_id, rootToken: registration.root_token,
        generation: registration.generation, groupId: registration.group_id, groupName: selected.groupName,
        incarnation, continuityToken, active: true, ready: false,
        connection: controlClient.createRootConnection(registration, { heartbeat: false, requireCrossHostParticipation: true }), reception, deduplicator,
      };
      createdBinding = binding;
      activeBindings.set(agent, binding);
      initialRegistrations.delete(agent);
    }

    // Every asynchronous continuation closes over its own immutable transport
    // identity. A new generation mutates the live binding, never this closure.
    const ownedBinding = binding;
    const connection = binding.connection;
    const rootToken = binding.rootToken;
    const generation = binding.generation;
    const deduplicator = binding.deduplicator;
    let lease: ConnectionLease | undefined;
    const isCurrent = () => current() && ownedBinding.active && activeBindings.get(agent) === ownedBinding &&
      ownedBinding.connection === connection && ownedBinding.generation === generation;
    const valid = () => isCurrent() && (!lease || lease.isValid());
    const reconcileCredit = async () => {
      if (!valid()) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      const pending = deduplicator.reconcilePendingMessageIds({
        requireComplete: reconnecting || pauseState.restoring,
        // Transport recovery retains the same ledger without inventing absence.
        // Reattaching a consumer still requires a complete host snapshot.
        allowMissingSnapshot: reconnecting && !pauseState.restoring,
      });
      // A complete snapshot proves absence for these original dispatches only.
      // Never replace the daemon's queue with a snapshot taken before an await:
      // a new notification can arrive while the individual proofs are sent.
      for (const proof of deduplicator.getUnconfirmedCredits()) {
        if (!valid()) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
        await trackAccounting(controlClient.releaseCredit(rootToken, proof));
        deduplicator.acknowledgeCredit(proof.message_id);
      }
      if (!valid()) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      return pending;
    };
    const recover = () => {
      if (!isCurrent()) return;
      disconnectBinding(ownedBinding);
      ownedBinding.rootToken = '';
      if (pendingRegistrations.has(agent)) recoveryRequested.add(agent);
      void registerRootSession(agent, true).catch(() => {});
    };
    binding.stopDisconnect = connection.onDisconnect(recover);
    binding.stopNotification = connection.onNotification(async params => {
      if (!valid()) return;
      if (params.protocol_version !== ARLO_PROFILE_VERSION || params.to_endpoint !== ownedBinding.endpointId ||
          params.group_id !== ownedBinding.groupId || params.target_generation !== generation || params.daemon_id !== daemonId) {
        await trackAccounting(controlClient.submitReceipt(rootToken, {
          daemon_id: params.daemon_id, endpoint_id: ownedBinding.endpointId,
          message_id: params.message_id, delivery_id: params.delivery_id, generation: params.target_generation,
          status: 'not_enqueued', reason: params.target_generation !== generation
            ? ArloErrorCode.STALE_GENERATION : ArloErrorCode.BINDING_MISMATCH,
        })).catch(() => {});
        return;
      }
      const receipt = await deduplicator.receiveFrame(params, valid);
      if (!valid()) return;
      await trackAccounting(controlClient.submitReceipt(rootToken, {
        daemon_id: params.daemon_id, endpoint_id: ownedBinding.endpointId,
        message_id: params.message_id, delivery_id: params.delivery_id, generation,
        ...receiptOutcome(receipt),
      })).catch(() => {});
    });
    try {
      await connection.connect();
      if (!valid()) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      if (!connection.sessionId) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      if (reconnecting) {
        // These are original dispatch receipts, never notifications or sends.
        // A retained uncertain insertion stays uncertain even if still pending.
        for (const proof of deduplicator.getRetainedEvidence()) {
          if (!valid()) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
          try { await trackAccounting(controlClient.submitReceipt(rootToken, proof.receipt)); }
          catch (error) {
            if (!(error instanceof ArloError) || error.code !== ArloErrorCode.REPLAY_RESULT_UNAVAILABLE) throw error;
          }
          if (!valid()) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
          if (proof.credit) {
            await trackAccounting(controlClient.releaseCredit(rootToken, proof.credit));
            deduplicator.acknowledgeCredit(proof.credit.message_id);
          }
        }
      }
      if (!valid()) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      lease = new ConnectionLease({
        ...options.recovery,
        heartbeat: async () => {
          await reconcileCredit();
          if (!valid()) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
          return controlClient.heartbeatRoot(rootToken, {
            endpoint_id: ownedBinding.endpointId, generation, display_name: sessionTitle(agent) ?? null,
          });
        },
        onExpire: recover,
      });
      ownedBinding.lease = lease;
      const pendingMessageIds = await reconcileCredit();
      if (!valid()) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      if (host.rootFirstUseEvidence && !initializations.has(agent)) {
        try {
          await initializeSending(agent, ownedBinding, connection, () => {
            if (!valid()) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
          });
        } catch {
          // Failure pauses outbound sending; reception and trusted human
          // recovery still become available on this same live binding.
        }
        if (!valid()) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      }
      await controlClient.confirmRootReady(rootToken, {
        endpoint_id: ownedBinding.endpointId, generation,
        reconciled_pending_message_ids: pendingMessageIds,
      });
      if (!valid()) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      ownedBinding.ready = true;
      try { options.onReady?.(ownedBinding.agent, true); } catch {}
      return ownedBinding;
    } catch (error) {
      if (activeBindings.get(agent) === ownedBinding && ownedBinding.connection === connection) {
        disconnectBinding(ownedBinding);
        ownedBinding.rootToken = '';
      }
      throw error;
    }
  }

  // Register existing live roots
  for (const root of host.roots()) {
    registerRootSession(root).catch(() => {});
  }

  // Dynamic registration when new agent is created
  const disposeCreated = host.onCreated(agent => {
    if (inactive()) return undefined;
    if (host.roots().includes(agent)) {
      registerRootSession(agent).catch(() => {});
    }
    return undefined;
  });

  // Dynamic revocation when agent is disposed
  const disposeDisposed = host.onDisposed(agent => {
    epochs.set(agent, (epochs.get(agent) ?? 0) + 1);
    cancelRecoveryWait(agent);
    retireRegistration(agent);
    const binding = activeBindings.get(agent);
    if (binding) {
      // AC 8: Synchronously invalidate binding, credentials, and callbacks
      retireBinding(binding);

      // Asynchronously clean up daemon endpoint
      void revokePending(agent).catch(() => {});
    }
    return undefined;
  });

  /** The host passes a live Root object; no SessionId, group or token is accepted as caller identity. */
  async function listContactSessions(caller: Root): Promise<SessionDiscoveryItem[]> {
    if (inactive() || !host.roots().includes(caller)) throw new ArloError(ArloErrorCode.CALLER_NOT_ROOT);
    const binding = activeBindings.get(caller);
    if (!binding || !binding.active || !binding.ready || binding.lease?.isValid() === false) {
      throw registrationErrors.get(caller) ?? new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    }
    const connection = binding.connection;
    const checkCurrent = () => {
      if (pluginDisposed || !host.roots().includes(caller) || !binding.active || !binding.ready || binding.lease?.isValid() === false ||
          activeBindings.get(caller) !== binding || binding.connection !== connection) {
        throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      }
    };
    checkCurrent();
    const content = await connection.listSessions();
    checkCurrent();
    let discovered: unknown;
    try { discovered = content.length === 1 ? JSON.parse(content[0]!.text) : undefined; }
    catch { throw new ArloError(ArloErrorCode.CORRUPTED_STATE); }
    if (!Array.isArray(discovered)) throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
    const localRoots = new Map([...activeBindings.values()].map(root => [root.endpointId, root.agent]));
    return discovered.map((item: unknown): SessionDiscoveryItem => {
      if (!item || typeof item !== 'object' || !('endpoint_id' in item) || typeof item.endpoint_id !== 'string' ||
          !('deliverable' in item) || item.deliverable !== true ||
          ('display_name' in item && typeof item.display_name !== 'string') ||
          ('host_type' in item && typeof item.host_type !== 'string') ||
          ('host_kind' in item && typeof item.host_kind !== 'string') ||
          ('host_version' in item && typeof item.host_version !== 'string')) {
        throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
      }
      const local = localRoots.get(item.endpoint_id);
      // Presentation is refreshed only after the daemon proves discoverability.
      // A title lookup can never manufacture a candidate or change its address.
      return {
        endpoint_id: item.endpoint_id,
        display_name: local ? sessionTitle(local) : 'display_name' in item ? item.display_name as string : undefined,
        ...('host_type' in item ? { host_type: item.host_type as string } : {}),
        ...('host_kind' in item ? { host_kind: item.host_kind as string } : {}),
        ...('host_version' in item ? { host_version: item.host_version as string } : {}),
        deliverable: true,
      };
    });
  }

  /** Reserve a fresh Host identity before publication, so it never joins a default group first. */
  async function createContactSession(caller: Root, create: CreateContact, suppliedSignal: AbortSignal): Promise<SessionDiscoveryItem> {
    if (pluginDisposed || !host.roots().includes(caller)) throw new ArloError(ArloErrorCode.CALLER_NOT_ROOT);
    const signal = AbortSignal.any([suppliedSignal, startup.signal]);
    const source = activeBindings.get(caller);
    const connection = source?.connection;
    const checkSource = () => {
      signal.throwIfAborted();
      if (!source || !source.active || !source.ready || source.lease?.isValid() === false ||
          activeBindings.get(caller) !== source || source.connection !== connection ||
          !host.roots().includes(caller)) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    };
    checkSource();
    const selection = selections.get(caller)!;
    await selection;
    checkSource();
    const sessionId = `session-${crypto.randomUUID()}`;
    const first = Promise.withResolvers<LiveRootBinding<Root>>();
    // Failure can arrive while the normal Host create still awaits attachment.
    void first.promise.catch(() => {});
    contactCreations.set(sessionId, { selection, first });
    try {
      const agent = await create(sessionId, signal);
      checkSource();
      if (host.sessionId(agent) !== sessionId || !host.roots().includes(agent)) {
        throw new ArloError(ArloErrorCode.CALLER_NOT_ROOT);
      }
      const aborted = Promise.withResolvers<never>();
      const abort = () => aborted.reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        const target = await Promise.race([first.promise, aborted.promise]);
        checkSource();
        if (target.agent !== agent || !target.active || !target.ready || target.lease?.isValid() === false ||
            activeBindings.get(agent) !== target || target.groupId !== source!.groupId) {
          throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
        }
        return { endpoint_id: target.endpointId, display_name: sessionTitle(agent),
          ...(hostKind === undefined ? {} : { host_kind: hostKind }),
          host_type: hostType, host_version: hostVersion, deliverable: true };
      } finally {
        signal.removeEventListener('abort', abort);
      }
    } finally {
      contactCreations.delete(sessionId);
    }
  }

  /** Capture only a ready binding belonging to the actual live caller object.
   * Registration failures remain visible; disposal takes precedence for tools.
   */
  function requireCallerBinding(caller: Root): LiveRootBinding<Root> {
    if (inactive()) {
      throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY, 'Plugin is disposed');
    }

    if (!caller || !host.roots().includes(caller) || !activeBindings.has(caller)) {
      const failure = caller && registrationErrors.get(caller);
      if (failure) throw failure;
      throw new ArloError(
        ArloErrorCode.CALLER_NOT_ROOT,
        'CALLER_NOT_ROOT: Tool caller must be a registered root session in this plugin'
      );
    }

    const callerBinding = activeBindings.get(caller)!;
    if (!callerBinding.active || !callerBinding.ready || callerBinding.lease?.isValid() === false) {
      throw registrationErrors.get(caller) ?? new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    }
    return callerBinding;
  }

  /** Read results may only escape through the same still-current connection.
   * Sends deliberately skip this check: their original outcome and message ID
   * remain valid evidence even if the connection is lost during the request.
   */
  function assertCurrentRead(caller: Root, binding: LiveRootBinding<Root>, connection: RootConnection): void {
    if (inactive() || !host.roots().includes(caller) || !binding.active || !binding.ready || binding.lease?.isValid() === false ||
        activeBindings.get(caller) !== binding || binding.connection !== connection) {
      throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    }
  }

  /** Human command boundary: accepts only the actual live host root object.
   * Evidence and result must remain attached to the same ready connection. */
  async function authorizeRoot(caller: Root, operationId?: string): Promise<RootSendingStatus> {
    const binding = requireCallerBinding(caller), connection = binding.connection;
    if (hostKind !== 'claudecode') throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
    let operation = authorizations.get(caller);
    if (!operation || operationId && operation.id !== operationId) { operation = { id: operationId ?? crypto.randomUUID() }; authorizations.set(caller, operation); }
    if (operation.pending) return operation.pending;
    const captured = operation;
    captured.pending = (async () => {
      assertCurrentRead(caller, binding, connection);
      const result = await trackAccounting(controlClient.authorizeRoot(binding.rootToken, {
        endpoint_id: binding.endpointId, generation: binding.generation, request_id: captured.id,
      }));
      assertCurrentRead(caller, binding, connection);
      authorizations.delete(caller); return result;
    })().finally(() => { captured.pending = undefined; });
    return captured.pending;
  }

  async function getRootConfiguration(caller: Root): Promise<RootConfigurationStatus> {
    const binding = requireCallerBinding(caller);
    const connection = binding.connection;
    const evidence = await host.rootConfigurationEvidence?.(caller);
    assertCurrentRead(caller, binding, connection);
    const result = await controlClient.getRootConfiguration(binding.rootToken, {
      endpoint_id: binding.endpointId,
      generation: binding.generation,
      ...(evidence === undefined ? {} : { evidence }),
    });
    assertCurrentRead(caller, binding, connection);
    return result;
  }

  /** Read-only human command. Unknown usage stays unknown, including after
   * daemon state loss; neither a query nor transport recovery grants a period. */
  async function getRootSendingStatus(caller: Root): Promise<RootSendingStatus> {
    const binding = requireCallerBinding(caller);
    const connection = binding.connection;
    const evidence = await host.rootConfigurationEvidence?.(caller);
    assertCurrentRead(caller, binding, connection);
    const result = await controlClient.getRootSendingStatus(binding.rootToken, {
      endpoint_id: binding.endpointId, generation: binding.generation,
      ...(evidence === undefined ? {} : { evidence }),
    });
    assertCurrentRead(caller, binding, connection);
    return result;
  }

  /** Coalesce trusted host notifications without carrying proof across a live
   * binding replacement. Undefined proof is deferred; failure or actual proof
   * consumes this runtime's attempt, including an ambiguous Daemon response. */
  function initializeSending(caller: Root, binding: LiveRootBinding<Root>,
    connection: RootConnection, validate: () => void): Promise<RootSendingStatus | undefined> {
    const generation = binding.generation;
    const rootToken = binding.rootToken;
    const current = () => {
      validate();
      if (activeBindings.get(caller) !== binding || binding.connection !== connection ||
          binding.generation !== generation || binding.rootToken !== rootToken) {
        throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      }
    };
    current();
    const existing = initializationRequests.get(caller);
    if (existing) {
      if (existing.binding !== binding || existing.connection !== connection) {
        return Promise.reject(new ArloError(ArloErrorCode.CHANNEL_NOT_READY));
      }
      return existing.pending;
    }
    if (!host.rootFirstUseEvidence || initializations.has(caller)) return Promise.resolve(undefined);
    const operation = { binding, connection, pending: Promise.resolve().then(async () => {
      current();
      let firstUse: RootFirstUseEvidence | undefined;
      try { firstUse = await host.rootFirstUseEvidence!(caller); }
      catch (error) { initializations.add(caller); throw error; }
      if (firstUse !== undefined) initializations.add(caller);
      current();
      if (!firstUse) return undefined;
      const result = await trackAccounting(controlClient.initializeRootSending(rootToken, {
        endpoint_id: binding.endpointId, generation,
        evidence: firstUse.evidence, first_use: firstUse,
      }));
      current();
      return result;
    }).finally(() => {
      if (initializationRequests.get(caller) === operation) initializationRequests.delete(caller);
    }) };
    initializationRequests.set(caller, operation);
    return operation.pending;
  }

  /** Trusted host persistence notification, never a model tool. A root whose
   * first native save was deferred may initialize after becoming ready. */
  async function initializeRootSending(caller: Root): Promise<RootSendingStatus | undefined> {
    const binding = requireCallerBinding(caller);
    const connection = binding.connection;
    const result = await initializeSending(caller, binding, connection,
      () => assertCurrentRead(caller, binding, connection));
    assertCurrentRead(caller, binding, connection);
    return result;
  }

  /** Trusted explicit reload. The Daemon owns file parsing and publication;
   * the live root and rule revision are checked across every asynchronous step. */
  async function reloadSendingRules(caller: Root): Promise<RootSendingStatus> {
    const binding = requireCallerBinding(caller);
    const connection = binding.connection;
    const evidence = await host.rootConfigurationEvidence?.(caller);
    assertCurrentRead(caller, binding, connection);
    const request = { endpoint_id: binding.endpointId, generation: binding.generation,
      ...(evidence === undefined ? {} : { evidence }) };
    const current = await controlClient.getRootSendingStatus(binding.rootToken, request);
    assertCurrentRead(caller, binding, connection);
    const result = await controlClient.reloadSendingRules(binding.rootToken, { ...request,
      daemon_id: current.daemon_id, rules_revision: current.rules_revision });
    assertCurrentRead(caller, binding, connection);
    return result;
  }

  /** Trusted explicit human operation, deliberately absent from model tools.
   * Concurrent submissions share one request. A transport failure retains that
   * request for an explicit retry, never creates another period automatically.
   * A replaced connection cannot carry the old operation into its new binding. */
  async function continueCollaboration(caller: Root, operationId?: string): Promise<RootSendingStatus> {
    const binding = requireCallerBinding(caller);
    const connection = binding.connection;
    let operation = continuationRequests.get(caller);
    if (!operation || operation.binding !== binding || operation.connection !== connection) {
      operation = { binding, connection, ...(hostKind === 'claudecode' && operation?.request ? { request: { ...operation.request, endpoint_id: binding.endpointId, generation: binding.generation } } : {}) };
      continuationRequests.set(caller, operation);
    }
    if (operationId && hostKind === 'claudecode') {
      let requests = humanRequests.get(caller);
      if (!requests) humanRequests.set(caller, requests = new Map());
      const previous = requests.get(operationId);
      if (!operation.pending) operation.request = previous ? { ...previous, endpoint_id: binding.endpointId, generation: binding.generation } : undefined;
      if (operation.pending && operation.actionId !== operationId) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    }
    if (operation.pending) return operation.pending;
    const captured = operation;
    captured.actionId = operationId;
    captured.pending = (async () => {
      if (!captured.request) {
        if (hostKind === 'claudecode') {
          captured.request = await controlClient.prepareContinuation(binding.rootToken, {
            endpoint_id: binding.endpointId, generation: binding.generation,
            request_id: operationId ?? crypto.randomUUID(),
          });
          assertCurrentRead(caller, binding, connection);
        } else {
          const evidence = await host.rootConfigurationEvidence?.(caller);
          assertCurrentRead(caller, binding, connection);
          const current = await controlClient.getRootSendingStatus(binding.rootToken, {
            endpoint_id: binding.endpointId, generation: binding.generation,
            ...(evidence === undefined ? {} : { evidence }),
          });
          assertCurrentRead(caller, binding, connection);
          captured.request = {
            endpoint_id: binding.endpointId, generation: binding.generation,
            daemon_id: current.daemon_id, request_id: operationId ?? crypto.randomUUID(), sequence: current.control_sequence + 1,
            ...(evidence === undefined ? {} : { evidence }),
          };
        }
      }
      if (operationId && hostKind === 'claudecode') {
        const requests = humanRequests.get(caller)!;
        if (!requests.has(operationId) && requests.size >= 10_000) throw new ArloError(ArloErrorCode.ACCOUNTING_UNAVAILABLE);
        requests.set(operationId, captured.request);
      }
      assertCurrentRead(caller, binding, connection);
      const result = await trackAccounting(controlClient.continueCollaboration(binding.rootToken, captured.request));
      assertCurrentRead(caller, binding, connection);
      if (continuationRequests.get(caller) === captured) continuationRequests.delete(caller);
      return result;
    })().catch(error => {
      // These authoritative refusals commit no new period. The next explicit
      // user operation may use repaired host evidence or a newer sequence.
      // Transport and persistence failures retain the original request because
      // a committed grant may have lost its response.
      if (error instanceof ArloError && [ArloErrorCode.ALLOWANCE_UNKNOWN, ArloErrorCode.INVALID_ARGUMENT,
        ArloErrorCode.STALE_GENERATION, ArloErrorCode.STALE_CONTROL_REQUEST,
        ArloErrorCode.CONTROL_REQUEST_CONFLICT, ArloErrorCode.UNAUTHORIZED].some(code => code === error.code)) {
        if (continuationRequests.get(caller) === captured) continuationRequests.delete(caller);
      }
      throw error;
    }).finally(() => { captured.pending = undefined; });
    return captured.pending;
  }

  async function listSessions(caller: Root, args: any = {}) {
    const callerBinding = requireCallerBinding(caller);
    const callerConnection = callerBinding.connection;

    // Forbidden model arguments check (AC 6)
    assertModelArgumentEnvelope(args, []);

    const content = await callerConnection.listSessions();
    assertCurrentRead(caller, callerBinding, callerConnection);
    return content;
  }

  /** Capture common configuration state before the caller reads its file. The
   * resulting update cannot overwrite a newer confirmation from a sibling. */
  async function prepareParticipationUpdate() {
    if (pluginDisposed) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    // Poll the authenticated transport directly. Re-reading protected discovery
    // on every settings tick is expensive on Windows and can starve readiness.
    // A paused root still verifies Daemon identity before it can resume.
    const token = runtimeToken && !pauseState.paused ? runtimeToken : await ensureRuntime();
    if (!token || pluginDisposed) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    let state: Awaited<ReturnType<ControlClient['getRuntimeParticipation']>>;
    try { state = await controlClient.getRuntimeParticipation(token); }
    catch (error) {
      if (!pluginDisposed && runtimeToken === token) {
        if (error instanceof ArloError && error.code === ArloErrorCode.UNAUTHORIZED) runtimeToken = undefined;
        await ensureRuntime();
      }
      throw error;
    }
    const current = () => {
      if (pluginDisposed || runtimeToken !== token) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
    };
    current();
    crossHostEnabled = state.cross_host_enabled;
    return { effective: state.cross_host_enabled, apply: async (enabled: boolean): Promise<boolean> => {
      if (typeof enabled !== 'boolean') throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
      current();
      const updated = await controlClient.updateRuntimeParticipation(token, enabled, state.revision);
      current();
      if (updated.cross_host_enabled !== enabled) throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
      crossHostEnabled = enabled;
      return enabled;
    } };
  }

  /** Plugin configuration applies to all roots, without replacing their bindings. */
  async function setCrossHostEnabled(enabled: boolean): Promise<boolean> {
    if (typeof enabled !== 'boolean') throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
    return (await prepareParticipationUpdate()).apply(enabled);
  }

  async function sendMessage(caller: Root, args: any) {
    const callerBinding = requireCallerBinding(caller);
    const callerConnection = callerBinding.connection;

    assertModelArgumentEnvelope(args, ['to', 'text', 'reply_to']);

    if (!args || typeof args.to !== 'string' || !args.to.trim() || args.to === '*' || args.to.toLowerCase() === 'all') {
      throw new ArloError(
        ArloErrorCode.INVALID_ARGUMENT,
        'INVALID_ARGUMENT: "to" must be a non-empty string endpoint ID without wildcards'
      );
    }

    if (typeof args.text !== 'string' || args.text.length === 0) {
      throw new ArloError(
        ArloErrorCode.INVALID_ARGUMENT,
        'INVALID_ARGUMENT: "text" must be a non-empty string'
      );
    }

    if (args.reply_to !== undefined && (typeof args.reply_to !== 'string' || !args.reply_to.trim())) {
      throw new ArloError(
        ArloErrorCode.INVALID_ARGUMENT,
        'INVALID_ARGUMENT: "reply_to" must be a non-empty string when present'
      );
    }

    const textBytes = Buffer.byteLength(args.text, 'utf8');
    if (textBytes > MAX_SINGLE_TEXT_BYTES) {
      throw new ArloError(
        ArloErrorCode.MESSAGE_TOO_LARGE,
        `MESSAGE_TOO_LARGE: text size (${textBytes} bytes) exceeds limit of 32 KiB`
      );
    }

    const result = await callerConnection.sendMessage({
      to: args.to.trim(),
      text: args.text,
      ...(args.reply_to !== undefined ? { reply_to: args.reply_to.trim() } : {}),
    });

    // This is the original call's immutable outcome, including its ID
    // when a lost connection leaves delivery uncertain. Returning it
    // does not reactivate the old binding or dispatch through a new one.
    return [{ type: 'text' as const, text: JSON.stringify(result) }];
  }

  async function getMessageStatus(caller: Root, args: any) {
    const callerBinding = requireCallerBinding(caller);
    const callerConnection = callerBinding.connection;

    assertModelArgumentEnvelope(args, ['message_id']);

    if (typeof args?.message_id !== 'string' || !args.message_id.trim()) {
      throw new ArloError(
        ArloErrorCode.INVALID_ARGUMENT,
        'INVALID_ARGUMENT: "message_id" must be a non-empty string'
      );
    }

    const result = await callerConnection.getMessageStatus(args.message_id);

    assertCurrentRead(caller, callerBinding, callerConnection);

    return [{ type: 'text' as const, text: JSON.stringify(result) }];
  }

  /** Stop this attachment synchronously, retaining the live roots' identity,
   * reception ledgers and continuity authorization. No root is revoked. */
  function pause(): Promise<void> {
    if (pluginDisposed) return shutdownPromise ?? Promise.resolve();
    if (pauseState.paused) return pauseState.pausing ?? Promise.resolve();
    pauseState.paused = true;
    pauseState.epoch++;
    for (const agent of recoveryWaits.keys()) cancelRecoveryWait(agent);
    const connections = [...activeBindings.values()].map(binding => {
      disconnectBinding(binding, 'drain');
      binding.rootToken = '';
      return binding.connection;
    });
    // Already issued proofs keep their original authorization until this
    // bounded drain finishes. No observer can issue new requests while paused.
    return pauseState.pausing = drainAccounting([...pendingAccounting, ...pendingRegistrations.values()])
      .finally(() => { for (const connection of connections) connection.dispose(); });
  }

  /** Reconnect retained roots, reconcile original evidence, then publish ready.
   * The host must first attach the consumer to the same live input owners. */
  function resume(): Promise<void> {
    if (pluginDisposed) return Promise.reject(new ArloError(ArloErrorCode.CHANNEL_NOT_READY));
    if (pauseState.resuming) return pauseState.resuming;
    if (!pauseState.paused) return Promise.resolve();
    const epoch = pauseState.epoch;
    const resuming = (async () => {
      await pauseState.pausing;
      if (pluginDisposed || pauseState.epoch !== epoch) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      const roots = host.roots();
      if (roots.length === 0 || roots.length !== activeBindings.size) {
        throw new ArloError(ArloErrorCode.ACCOUNTING_UNAVAILABLE);
      }
      pauseState.restoring = true;
      for (const [root, binding] of activeBindings) {
        if (!roots.includes(root) || host.reception(root) !== binding.reception) {
          throw new ArloError(ArloErrorCode.ACCOUNTING_UNAVAILABLE);
        }
        binding.deduplicator.reconcilePendingMessageIds({ requireComplete: true });
      }
      pauseState.paused = false;
      await Promise.all(roots.map(root => registerRootSession(root)));
      if (inactive() || pauseState.epoch !== epoch ||
          roots.some(root => !activeBindings.get(root)?.ready)) {
        throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
      }
    })().catch(async error => {
      if (pauseState.epoch === epoch && !pluginDisposed) await pause();
      throw error;
    }).finally(() => {
      if (pauseState.resuming === resuming) { pauseState.resuming = undefined; pauseState.restoring = false; }
    });
    return pauseState.resuming = resuming;
  }

  async function shutdown(preserveReception: boolean) {
    if (pluginDisposed) {
      if (!preserveReception) {
        // Final root disposal can follow an attachment suspension. Credentials
        // are already invalid; only the retained local reception remains.
        for (const binding of [...activeBindings.values()]) invalidateBinding(binding, false, 'drain');
      }
      return shutdownPromise;
    }
    pluginDisposed = true;
    startup.abort();
    initialRegistrations.clear();
    retiredRegistrations.clear();
    for (const agent of recoveryWaits.keys()) cancelRecoveryWait(agent);

    // 1. Synchronously invalidate all bindings, credentials, and callbacks.
    // Keep the underlying connections until issued accounting completes:
    // closing SSE immediately would invalidate those requests' root tokens.
    for (const binding of [...activeBindings.values()]) {
      retireBinding(binding, preserveReception);
    }

    // Dispose event listeners
    disposeCreated();
    disposeDisposed();

    // 2. Preserve authentication for issued events and the final complete
    // snapshots. Pending/in-flight or unavailable views never release credit.
    const tokenToRevoke = runtimeToken;
    runtimeToken = undefined;
    shutdownPromise = (async () => {
      try {
        await drainAccounting([...pendingAccounting, ...retiringBindings.values(),
          ...(pauseState.pausing ? [pauseState.pausing] : [])]);
      } finally {
        if (tokenToRevoke) await controlClient.revokeRuntime(tokenToRevoke).catch(() => {});
      }
    })();
    await shutdownPromise;

    // Note: Do NOT destroy host Root, do NOT cancel host agent's ongoing work!
  }

  /** Stop this attachment permanently while retaining each living root's
   * original reception ledger and host evidence observer. The host must retain
   * this runtime; suspension does not authorize re-registration or resumption.
   * dispose() releases the retained local reception on final root teardown. */
  function suspend() { return shutdown(true); }

  // AC 8: Plugin unload lifecycle, including final cleanup after suspension.
  function dispose() { return shutdown(false); }

  return { authorizeRoot, switchGroup: switchRootGroup, listContactSessions, createContactSession, getRootConfiguration, getRootSendingStatus, initializeRootSending, reloadSendingRules, continueCollaboration, setCrossHostEnabled, prepareParticipationUpdate,
    listSessions, sendMessage, getMessageStatus, pause, resume, suspend, dispose };
}
