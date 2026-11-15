import { createAdapterRuntime, createParticipationSettings, readParticipationPreference, participationScope, type AdapterRuntimeOptions } from '@arlo/adapter-sdk';
import { createDshReceptionHost } from './reception.ts';
export { createDshReceptionHost, arloMessage } from './reception.ts';
import { symbols, type Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { randomUUID } from 'node:crypto';
import * as jsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ensureSharedDaemon } from '@arlo/daemon/shared';
import { captureRootConfigurationEvidence, ArloError, ArloErrorCode, validateExplicitGroupName,
  type SessionDiscoveryItem, type RootConfigurationStatus, type RootSendingStatus, type RootFirstUseEvidence,
  type RootConfigurationEvidence } from '@arlo/sdk';

export const ARLO_REGISTRY_OWNER_KEY = Symbol.for('arlo.registry-owner');

/** Canonical immutable public origin; mutable events and model settings are excluded. */
function sessionOrigin(header: Agent['session']['header']): string {
  return JSON.stringify([header.id, header.createdAt, header.cwd, header.parentSession,
    header.isSeeded, header.origin, header.delegationDepth ?? 0, header.agentPreset]);
}
function backendIdentity(service: object | undefined): unknown {
  return service && (Reflect.get(service, symbols.original) ?? service);
}

/** The baseline publishes these methods on its concrete service. The candidate
 * publishes an explicit Host-only accessor; neither branch guesses storage paths. */
interface JsonlOwnership {
  open: Context['sessionPersistence']['open'];
  resolveCurrentLog(id: Agent['session']['id']): Promise<string | undefined>;
  hasPendingSession(id: Agent['session']['id']): boolean;
}
function jsonlBackend(ctx: Context): JsonlOwnership | undefined {
  const accessor: unknown = Reflect.get(jsonlPersistence, 'ownershipOf');
  const service = typeof accessor === 'function' ? accessor(ctx.get('sessionPersistence'))
    : typeof Reflect.get(jsonlPersistence, 'default') === 'function' ? ctx.get('sessionPersistence') : undefined;
  if (service?.name !== 'session-persistence-jsonl' || typeof service.open !== 'function' ||
      typeof service.resolveCurrentLog !== 'function' || typeof service.hasPendingSession !== 'function') return undefined;
  return service as JsonlOwnership;
}

/** The backend resolves and validates its own artifact; no private layout or
 * mutable header fields participate in ownership evidence. */
async function persistAndValidateSession(ctx: Context, session: Agent['session'],
  persistence: JsonlOwnership, origin: string): Promise<RootConfigurationEvidence | undefined> {
  let sessionFile: string | undefined;
  try {
    await ctx.sessions.flush(session);
    sessionFile = await persistence.resolveCurrentLog(session.id);
    if (!sessionFile) return undefined;
    const evidence = captureRootConfigurationEvidence(sessionFile, undefined, origin);
    const handle = await persistence.open(session.id, 'read');
    try {
      if (sessionOrigin(handle.header) !== origin) throw new Error('Native session origin changed');
      // A valid header alone cannot authenticate a damaged durable body.
      await handle.read();
    } finally { await handle.close(); }
    const current = captureRootConfigurationEvidence(sessionFile, undefined, origin);
    if (current.file_identity !== evidence.file_identity || current.file_revision !== evidence.file_revision) {
      throw new Error('Native session artifact changed');
    }
    return evidence;
  } catch {
    return sessionFile ? { kind: 'session-file', session_file: sessionFile, invalid: true } : undefined;
  }
}
export type ArloPluginOptions = Omit<AdapterRuntimeOptions<Agent>, 'host' | 'startSharedDaemon' | 'hostType' | 'hostVersion' | 'hostKind'> & {
  hostType?: string;
  hostVersion?: string;
  settingsPath?: string;
};

export function createArloHarnessPlugin(options: ArloPluginOptions) {
  // Preserve synchronous validation even before a host registry attaches.
  if (options.groupName !== undefined) validateExplicitGroupName(options.groupName);
  type Runtime = ReturnType<typeof createAdapterRuntime<Agent>>;
  const owners = new WeakMap<Agent, Runtime>();
  const settings = new WeakMap<Runtime, ReturnType<typeof createParticipationSettings>>();
  type CreateContact = (sessionId: string, signal: AbortSignal) => Promise<Agent>;
  const plugin = (ctx: Context) => {
    if (Reflect.has(ctx.agents, ARLO_REGISTRY_OWNER_KEY)) return;
    const token = Symbol('arlo.registry-token');
    Object.defineProperty(ctx.agents, ARLO_REGISTRY_OWNER_KEY, { value: token, configurable: true, writable: true });
    const existingSessions = new WeakSet(ctx.sessions.list());
    const firstUses = new WeakMap<Agent, {
      session: Agent['session']; backend: JsonlOwnership; origin: string; creationId: string;
      evidence?: Promise<RootFirstUseEvidence | undefined>;
    }>();
    // Agent publication enters both registries before this synchronous public
    // announcement. Only a JSONL create-owned, still unmaterialized Session
    // can witness creation; resume and late attachment have no pending entry.
    ctx.on('session/created', session => {
      // An old unmaterialized Session can remain create-owned across a late
      // mount. Replayed announcements or reattachment do not make it new.
      if (existingSessions.has(session)) return;
      const agent = ctx.agents.get(session.id);
      const backend = jsonlBackend(ctx);
      if (!agent || firstUses.has(agent) || agent.session !== session || ctx.sessions.get(session.id) !== session ||
          !ctx.agents.roots().includes(agent) || !backend) return;
      try {
        if (!backend.hasPendingSession(session.id)) return;
        firstUses.set(agent, { session, backend, origin: sessionOrigin(session.header), creationId: randomUUID() });
      } catch { /* Unavailable public storage evidence cannot confer eligibility. */ }
    });
    const ownsWitness = (agent: Agent, witness: NonNullable<ReturnType<typeof firstUses.get>>) =>
      agent.session === witness.session && ctx.sessions.get(witness.session.id) === witness.session &&
      ctx.agents.get(witness.session.id) === agent && ctx.agents.roots().includes(agent) &&
      // Cordis returns a fresh traced proxy per service lookup; its exported
      // original symbol preserves the actual backend identity across awaits.
      backendIdentity(ctx.get('sessionPersistence')) === backendIdentity(witness.backend) &&
      sessionOrigin(witness.session.header) === witness.origin;
    const runtime = createAdapterRuntime<Agent>({
      ...options,
      hostType: options.hostType ?? 'deepseek-harness',
      hostVersion: options.hostVersion ?? '0.2.0',
      hostKind: 'deepseek-harness',
      ...(options.settingsPath ? {
        crossHostEnabled: readParticipationPreference(options.settingsPath),
        participationScope: participationScope(options.settingsPath),
      } : {}),
      startSharedDaemon: ensureSharedDaemon,
      host: {
        roots: () => ctx.agents.roots(),
        sessionId: agent => String(agent.session.id),
        sessionCwd: agent => agent.session.header.cwd,
        rootConfigurationEvidence: async agent => {
          // The backend alone resolves its artifact. Never derive its private
          // layout or attach a marker to immutable Session metadata.
          const persistence = jsonlBackend(ctx);
          // A Host can load its backend from another physical package copy.
          // Couple to the published service contract, not module class identity.
          if (!persistence) return undefined;
          return persistAndValidateSession(ctx, agent.session, persistence, sessionOrigin(agent.session.header));
        },
        rootFirstUseEvidence: agent => {
          const witness = firstUses.get(agent);
          if (!witness || !ownsWitness(agent, witness)) return undefined;
          return witness.evidence ??= (async () => {
            const evidence = await persistAndValidateSession(ctx, witness.session, witness.backend, witness.origin);
            if (!evidence || evidence.invalid || !ownsWitness(agent, witness)) return undefined;
            return { kind: 'new-session-materialized', evidence, creation_id: witness.creationId };
          })();
        },
        reception: createDshReceptionHost,
        onCreated: listener => ctx.on('agent/created', ({ agent, signal }) => {
          // A preceding Host listener can cancel publication while the pending
          // root is still visible. Let the Host unwind it without registering it.
          if (signal?.aborted) return undefined;
          if (ctx.agents.roots().includes(agent)) owners.set(agent, runtime);
          listener(agent);
          return undefined;
        }),
        onDisposed: listener => ctx.on('agent/disposed', ({ agent }) => {
          owners.delete(agent);
          listener(agent);
          return undefined;
        }),
      },
    });
    if (options.settingsPath) {
      const preferences = createParticipationSettings({ configPath: options.settingsPath,
        prepare: () => runtime.prepareParticipationUpdate() });
      settings.set(runtime, preferences);
      ctx.effect(() => () => preferences.dispose());
      void preferences.refresh().catch(() => {});
    }
    for (const root of ctx.agents.roots()) owners.set(root, runtime);
    // Model tool facade: arlo_list_sessions (AC 6)
    ctx.tools.register(
      defineTool({
        name: 'arlo_list_sessions',
        description: 'List other ready root sessions in the current communication group',
        parameters: {},
        output: {
          schema: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            endpoint_id: { type: 'string', required: true },
            deliverable: { type: 'boolean', required: true },
            display_name: { type: 'string' }, host_type: { type: 'string' },
            host_version: { type: 'string' }, host_kind: { type: 'string' },
          } } },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          const caller = exec?.agent ?? ctx.agents.currentInitiator?.() ?? ctx.agents.requireInitiator();
          const content = await runtime.listSessions(caller, args);
          return JSON.parse(content[0]!.text);
        },
      })
    );

    // Model tool facade: arlo_send_message (Issue #7, reply association Issue #13)
    ctx.tools.register(
      defineTool({
        name: 'arlo_send_message',
        description: 'Send a unicast text message to another registered root session in the same communication group',
        parameters: {
          to: {
            type: 'string',
            description: 'Target endpoint ID',
            required: true,
          },
          text: {
            type: 'string',
            description: 'Message text content (max 32 KiB)',
            required: true,
          },
          reply_to: {
            type: 'string',
            description:
              'Optional message ID of an inbound message this endpoint has the right to reply to; the reply target must be that message\'s original sender',
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {
            status: { type: 'string', enum: ['accepted', 'rejected', 'unknown'], required: true },
            message_id: { type: 'string', required: true }, reason: { type: 'string' },
          } },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          const caller = exec?.agent ?? ctx.agents.currentInitiator?.() ?? ctx.agents.requireInitiator();
          const content = await runtime.sendMessage(caller, args);
          return JSON.parse(content[0]!.text);
        },
      })
    );

    // Model tool facade: arlo_get_message_status (Issue #9)
    ctx.tools.register(
      defineTool({
        name: 'arlo_get_message_status',
        description:
          'Query the reception status of a message this root session sent. Returns receipt metadata only, never message text or task completion.',
        parameters: {
          message_id: {
            type: 'string',
            description: 'Message ID returned by arlo_send_message',
            required: true,
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: true, properties: {
            status: { type: 'string', enum: ['in_flight', 'accepted', 'rejected', 'unknown', 'receipt_conflict', 'result_unavailable'], required: true },
            message_id: { type: 'string', required: true },
            daemon_id: { type: 'string', required: true },
          } },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          const caller = exec?.agent ?? ctx.agents.currentInitiator?.() ?? ctx.agents.requireInitiator();
          const content = await runtime.getMessageStatus(caller, args);
          return JSON.parse(content[0]!.text);
        },
      })
    );


    ctx.effect(() => async () => {
      const disposed = runtime.dispose();
      for (const root of ctx.agents.roots()) if (owners.get(root) === runtime) owners.delete(root);
      if (Reflect.get(ctx.agents, ARLO_REGISTRY_OWNER_KEY) === token) Reflect.deleteProperty(ctx.agents, ARLO_REGISTRY_OWNER_KEY);
      await disposed;
    });
  };
  const owner = (agent: Agent): Runtime => {
    const runtime = owners.get(agent);
    if (!runtime) throw new ArloError(ArloErrorCode.CALLER_NOT_ROOT);
    return runtime;
  };
  plugin.inject = ['agents', 'tools', 'sessions'];
  plugin.switchGroup = async (agent: Agent, name: string): Promise<void> => owner(agent).switchGroup(agent, name);
  plugin.listContactSessions = async (agent: Agent): Promise<SessionDiscoveryItem[]> => owner(agent).listContactSessions(agent);
  plugin.getRootConfiguration = async (agent: Agent): Promise<RootConfigurationStatus> => owner(agent).getRootConfiguration(agent);
  plugin.getRootSendingStatus = async (agent: Agent): Promise<RootSendingStatus> => owner(agent).getRootSendingStatus(agent);
  plugin.continueCollaboration = async (agent: Agent): Promise<RootSendingStatus> => owner(agent).continueCollaboration(agent);
  plugin.reloadSendingRules = async (agent: Agent): Promise<RootSendingStatus> => owner(agent).reloadSendingRules(agent);
  plugin.participation = async (agent: Agent, enabled?: boolean) => {
    const preferences = settings.get(owner(agent));
    if (!preferences) throw new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Arlo settings location is not configured');
    return enabled === undefined ? preferences.refresh() : preferences.set(enabled);
  };
  plugin.createContactSession = async (agent: Agent, create: CreateContact, signal: AbortSignal): Promise<SessionDiscoveryItem> =>
    owner(agent).createContactSession(agent, create, signal);
  return plugin;
}
