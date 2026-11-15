import { SessionId } from '@deepseek-ai/dsh-session';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';

/** Capture the submitter selection and preserve the native Host creation path.
 * @param {import('./host-types.mjs').HostContext} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} caller
 * @param {import('./host-types.mjs').ContactOptions['newSessionModel']} configuredModel
 * @param {AbortSignal} signal
 */
export async function prepareRootCreation(ctx, caller, configuredModel, signal) {
    signal.throwIfAborted();
    // Capture the selection for A's next request, including a pending user
    // switch. A request's provider-default effort is not a user selection.
    const pending = ctx.sessionProjections.stateOf(caller.session, 'modelSelection')?.pending;
    const header = caller.session.requestHeader();
    const modelSelection = { ...(configuredModel ?? pending ?? (header ? {
      provider: header.config.provider, model: header.config.model,
      ...(header.config.reasoningEffort === undefined || header.adapterDefaults?.reasoningEffort === true
        ? {} : { reasoningEffort: header.config.reasoningEffort }),
    } : ctx.agentDefaultModel.currentSelection())) };
    {
      try {
        // Core routing treats the catalog as advisory. This explicit creation
        // entry must reject unavailable routes before publishing a new root.
        const { provider, model } = modelSelection;
        if (!ctx.llm.listProviders().some(item => item.id === provider)
          || !(await ctx.llm.listModels(provider)).some(item => item.id === model)) {
          throw new Error('Configured route is not available.');
        }
        await ctx.llm.resolveModelInfo(provider, model, signal);
        signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted) throw error;
        throw new RemoteError('arlo/contact-create-failed', 'The configured Arlo new-conversation model is unavailable.', {
          reason: 'MODEL_UNAVAILABLE',
        });
      }
    }
    const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(caller.id));
    const location = workspace ? { workspaceId: workspace.id } : { cwd: caller.session.header.cwd };
    return async (/** @type {string} */ identity, /** @type {AbortSignal} */ creationSignal) => {
        const options = { modelSelection, signal: creationSignal, fresh: true };
        const created = await ctx.sessionController.create({ sessionId: SessionId(identity), ...location }, options);
        const agent = ctx.agents.get(created.sessionId);
        if (!agent) throw new Error('The created root is no longer live.');
        return agent;
    };
}
