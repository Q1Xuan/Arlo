import { prepareRootCreation } from './host-create.mjs';
import { TypertRemoteService, RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
import Schema from '@deepseek-ai/schemastery';
import { createArloHarnessPlugin } from '@arlo/adapter-dsh/runtime';
import { ArloError, ArloErrorCode } from '@arlo/sdk';
import { contactDescriptor, createContactDescriptor, participationDescriptor, rootConfigurationDescriptor,
  sendStatusDescriptor, continueCollaborationDescriptor, reloadSendingRulesDescriptor } from './client.cjs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { requireDshWebComposition, dshInstallationDirectory, requireDshHostContracts } from './delivery/index.mjs';

/** Preserve error codes without exposing arbitrary error text. @param {unknown} error */
function preparationReason(error) {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'CHANNEL_NOT_READY';
}

/** One Web integration owns both the contact source and its Harness binding. */
export const inject = ['agents', 'tools', 'sessions', 'typert', 'sessionProjections', 'sessionController', 'agentDefaultModel', 'workspaceRegistry', 'llm'];

/**
 * Trusted deployment configuration; no endpoint or group is accepted from the browser.
 * @type {Schema<import('./host-types.mjs').ContactOptions>}
 */
export const Config = Schema.object({
  groupName: Schema.string(),
  stateDir: Schema.string(),
  hostType: Schema.string().default('deepseek-harness'),
  hostVersion: Schema.string().default('0.2.0-rc.2'),
  experimentalCompatibility: Schema.boolean().default(false).description('Explicitly investigate an unverified complete DSH composition. Required contracts, patches and resource checks still apply.'),
  autoStart: Schema.boolean().default(true),
  settingsPath: Schema.string().description('Shared Arlo plugin settings file. Defaults to arlo.json in this DSH profile.'),
  // An object schema defaults to {}; the union keeps this entire option unset.
  newSessionModel: Schema.union([Schema.object({
    provider: Schema.string().pattern(/\S/u).required().description('DSH provider route ID.'),
    model: Schema.string().pattern(/\S/u).required().description('Model ID advertised by that provider.'),
  })]).description('Model for Arlo @ new conversations. Leave unset to use the sender\'s model at submission.'),
});

/** Contact discovery and explicit creation through the current live Host root. */
export class ArloContactService extends TypertRemoteService {
  /**
   * @param {import('./host-types.mjs').HostContext} ctx
   * @param {ReturnType<typeof createArloHarnessPlugin>} harness
   * @param {import('./host-types.mjs').ContactOptions['newSessionModel']} [newSessionModel]
   */
  constructor(ctx, harness, newSessionModel) {
    super(ctx, 'arloContact');
    // Host integrations may use the existing trusted switchGroup operation.
    // This property is deliberately absent from the Remote contribution.
    this.harness = harness;
    this.newSessionModel = newSessionModel;
  }

  /**
   * Resolve an existing root without creating, resuming, or sending to a session.
   * @param {import('@deepseek-ai/dsh-session').SessionId} sessionId
   * @param {AbortSignal} signal
   * @returns {Promise<import('@arlo/sdk').SessionDiscoveryItem[]>}
   */
  async list(sessionId, signal) {
    signal.throwIfAborted();
    const agent = this.ctx.agents.get(sessionId);
    if (!agent || !this.ctx.agents.roots().includes(agent)) {
      throw new RemoteError('arlo/contact-unavailable', 'The current session is not a live root.', {
        reason: 'CALLER_NOT_ROOT',
      });
    }
    try {
      const contacts = await this.harness.listContactSessions(agent);
      signal.throwIfAborted();
      return contacts;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RemoteError('arlo/contact-unavailable', 'Arlo contact discovery is unavailable.', {
        reason: preparationReason(error),
      });
    }
  }

  /** Native settings entry; endpoint, identity and groups remain Host-owned.
   * @param {import('@deepseek-ai/dsh-session').SessionId} sessionId
   * @param {boolean | null} enabled
   * @param {AbortSignal} signal
   */
  async participation(sessionId, enabled, signal) {
    signal.throwIfAborted();
    const agent = this.ctx.agents.get(sessionId);
    if (!agent || !this.ctx.agents.roots().includes(agent)) {
      throw new RemoteError('arlo/contact-unavailable', 'The current session is not a live root.', { reason: 'CALLER_NOT_ROOT' });
    }
    try {
      const state = await this.harness.participation(agent, enabled ?? undefined);
      signal.throwIfAborted();
      return state;
    } catch (error) {
      throw new RemoteError('arlo/contact-unavailable', 'Arlo settings update failed.', { reason: preparationReason(error) });
    }
  }

  /** Human query: resolve the actual live composer root; no configuration ID
   * or evidence crosses the Remote boundary.
   * @param {import('@deepseek-ai/dsh-session').SessionId} sessionId
   * @param {AbortSignal} signal
   * @returns {Promise<import('@arlo/sdk').RootConfigurationStatus>}
   */
  async rootConfiguration(sessionId, signal) {
    signal.throwIfAborted();
    const agent = this.ctx.agents.get(sessionId);
    if (!agent || !this.ctx.agents.roots().includes(agent)) {
      throw new RemoteError('arlo/contact-unavailable', 'The current session is not a live root.', { reason: 'CALLER_NOT_ROOT' });
    }
    try {
      const state = await this.harness.getRootConfiguration(agent);
      signal.throwIfAborted();
      return state;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RemoteError('arlo/contact-unavailable', 'Arlo root configuration query failed.', { reason: preparationReason(error) });
    }
  }

  /** Human read-only command for this exact current composer root.
   * @param {import('@deepseek-ai/dsh-session').SessionId} sessionId
   * @param {AbortSignal} signal
   * @returns {Promise<import('@arlo/sdk').RootSendingStatus>}
   */
  async sendStatus(sessionId, signal) {
    signal.throwIfAborted();
    const agent = this.ctx.agents.get(sessionId);
    if (!agent || !this.ctx.agents.roots().includes(agent)) {
      throw new RemoteError('arlo/contact-unavailable', 'The current session is not a live root.', { reason: 'CALLER_NOT_ROOT' });
    }
    try {
      const state = await this.harness.getRootSendingStatus(agent);
      signal.throwIfAborted();
      return state;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RemoteError('arlo/contact-unavailable', 'Arlo sending status query failed.', { reason: preparationReason(error) });
    }
  }

  /** Explicit trusted human continuation; no allowance, root token, sequence or
   * request identity is accepted from model or browser arguments.
   * @param {import('@deepseek-ai/dsh-session').SessionId} sessionId
   * @param {AbortSignal} signal
   * @returns {Promise<import('@arlo/sdk').RootSendingStatus>}
   */
  async continueCollaboration(sessionId, signal) {
    signal.throwIfAborted();
    const agent = this.ctx.agents.get(sessionId);
    if (!agent || !this.ctx.agents.roots().includes(agent)) {
      throw new RemoteError('arlo/contact-unavailable', 'The current session is not a live root.', { reason: 'CALLER_NOT_ROOT' });
    }
    try {
      const state = await this.harness.continueCollaboration(agent);
      signal.throwIfAborted();
      return state;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RemoteError('arlo/contact-unavailable', 'Arlo collaboration continuation failed.', { reason: preparationReason(error) });
    }
  }

  /** Trusted human reload of private rules for the current composer root.
   * @param {import('@deepseek-ai/dsh-session').SessionId} sessionId
   * @param {AbortSignal} signal
   * @returns {Promise<import('@arlo/sdk').RootSendingStatus>}
   */
  async reloadSendingRules(sessionId, signal) {
    signal.throwIfAborted();
    const agent = this.ctx.agents.get(sessionId);
    if (!agent || !this.ctx.agents.roots().includes(agent)) {
      throw new RemoteError('arlo/contact-unavailable', 'The current session is not a live root.', { reason: 'CALLER_NOT_ROOT' });
    }
    try {
      const state = await this.harness.reloadSendingRules(agent);
      signal.throwIfAborted();
      return state;
    } catch (error) {
      if (signal.aborted) throw error;
      // Only the rule parser emits this fixed, path-free diagnostic. Other
      // exceptions remain reduced to their stable reason at the browser seam.
      const diagnostic = error instanceof ArloError && error.code === ArloErrorCode.SENDING_RULES_INVALID
        ? error.message.slice(0, 1024) : undefined;
      throw new RemoteError('arlo/contact-unavailable', 'Arlo sending rules reload failed.', {
        reason: preparationReason(error), ...(diagnostic === undefined ? {} : { diagnostic }),
      });
    }
  }

  /**
   * Explicit submission preparation. User text, model overrides and groups never cross this RPC.
   * @param {import('@deepseek-ai/dsh-session').SessionId} sessionId
   * @param {AbortSignal} signal
   * @returns {Promise<import('@arlo/sdk').SessionDiscoveryItem>}
   */
  async create(sessionId, signal) {
    signal.throwIfAborted();
    const caller = this.ctx.agents.get(sessionId);
    if (!caller || !this.ctx.agents.roots().includes(caller)) {
      throw new RemoteError('arlo/contact-create-failed', 'The current session is not a live root.', { reason: 'CALLER_NOT_ROOT' });
    }
    const create = await prepareRootCreation(this.ctx, caller, this.newSessionModel, signal);
    try {
      return await this.harness.createContactSession(caller, create, signal);
    } catch (error) {
      // Preserve ordinary Host creation/attachment errors and their published
      // Session identity. No rollback, auto-retry or messaging result is added.
      if (signal.aborted || remoteErrorOf(error)) throw error;
      throw new RemoteError('arlo/contact-create-failed', 'The new conversation could not become a ready contact.', {
        reason: preparationReason(error),
      });
    }
  }
}

/**
 * Mount this package by its bare name so DSH also discovers its browser half.
 * @param {import('./host-types.mjs').HostContext} ctx
 * @param {import('./host-types.mjs').ContactOptions} config
 */
export function apply(ctx, config) {
  const composition = requireDshWebComposition(dshInstallationDirectory(fileURLToPath(import.meta.url)), {
    experimental: config.experimentalCompatibility === true,
  });
  requireDshHostContracts(ctx, { experimental: config.experimentalCompatibility === true, hostVersion: composition.hostVersion });
  const { newSessionModel, experimentalCompatibility, ...harnessOptions } = config;
  const harness = createArloHarnessPlugin({
    ...harnessOptions,
    hostVersion: composition.hostVersion ?? undefined,
    settingsPath: config.settingsPath ?? path.join(
      Reflect.get(ctx, 'profileContext')?.dir ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'arlo.json'),
    getSessionTitle: agent => ctx.sessionProjections.snapshot(agent.session, ['title']).values.title ?? undefined,
  });
  ctx.plugin(harness);
  new ArloContactService(ctx, harness, newSessionModel);
  ctx.effect(() => ctx.typert.register({
    package: '@arlo/adapter-dsh',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [contactDescriptor, createContactDescriptor, participationDescriptor, rootConfigurationDescriptor,
      sendStatusDescriptor, continueCollaborationDescriptor, reloadSendingRulesDescriptor],
  }), 'arlo-contact: Host discovery and explicit creation');
  // This is emitted by the loaded Host, rather than inferred from the setup CLI.
  // It contains installation identity only, never configuration or credentials.
  console.info(JSON.stringify({ event: 'arlo-host-loaded', host: 'dsh', hostVersion: composition.hostVersion,
    runtime: { executable: process.execPath, version: process.versions.node },
    adapter: fileURLToPath(import.meta.url), requiredContracts: 'ready', communication: 'unobserved' }));
}
