// Acceptance-only native client plugin. No Arlo endpoint is mounted.
(function () {
  const codec = { mode: 'strict', typeSymbol: 'submission-contract#string', create: () => ({ parse(value) {
    if (typeof value !== 'string') throw new TypeError('Expected string');
    return value;
  } }) };
  const descriptor = {
    id: 'submission-contract#submissionContract/create', service: 'submissionContract', namespace: 'submissionContract',
    method: 'create', invocation: { kind: 'direct' },
    parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec }],
    cancellation: { parameter: 'signal' }, result: codec,
  };
  if (typeof window === 'undefined') { module.exports = { descriptor }; return; }
  window.__ModuleLoader__.load({ id: 'submission-contract', factory() { return {
    inject: ['conversation', 'inputTriggers', 'remote', 'sessions'],
    async apply(ctx) {
      if (typeof ctx.conversation.registerSubmitPreparation !== 'function') throw new Error('SUBMISSION_PREPARATION_MISSING');
      if (typeof ctx.sessions.retain === 'function') {
        await ctx.sessions.refresh();
        ctx.effect(() => {
          const retained = ctx.sessions.retain('submission-a', { source: 'controllerOperation' });
          return () => retained.release();
        });
      }
      await ctx.remote.$mount({ package: 'submission-contract', descriptors: [descriptor] });
      ctx.inject(['remote.submissionContract'], scope => {
        let disposePreparation, serializationGate;
        const serializeReference = ref => ref === 'existing' ? '<existing-contact/>' : '<draft-root/>';
        const prepare = async (session, references, signal) => {
          const values = [];
          for (const reference of references) {
            if (reference.ref === 'existing') { values.push(reference.text); continue; }
            const result = await scope.remote.submissionContract.create(session.sessionId, signal);
            if (!result.ok) throw result.error;
            values.push(`<ordinary-root>${result.value}</ordinary-root>`);
          }
          return values;
        };
        const registerPreparation = () => { disposePreparation = scope.conversation.registerSubmitPreparation('contract-new', prepare); };
        scope.effect(() => { registerPreparation(); return () => disposePreparation(); });
        scope.effect(() => scope.inputTriggers.registerSource({
          name: 'contract-new', trigger: '@', order: -200,
          candidates: async () => [{ name: 'Contract new root', value: 'new' }, { name: 'Contract existing contact', value: 'existing' }, { name: 'Contract deferred root', value: 'deferred' }],
          onPick: ({ candidate }) => {
            const ref = candidate.value === 'new' ? 'same-ref' : candidate.value;
            return { insert: { source: 'contract-new', ref, label: candidate.name, appearance: 'session', clipboardText: serializeReference(ref) } };
          },
          codec: { clipboardText: serializeReference, serialize: async ref => {
            if (ref === 'deferred') { serializationGate = Promise.withResolvers(); await serializationGate.promise; }
            return serializeReference(ref);
          } },
        }));
        scope.effect(() => scope.inputTriggers.registerSource({
          name: 'contract-lifecycle', trigger: '@', order: -300,
          candidates: async () => serializationGate ? [
            { name: 'Replace preparation and release serializer', value: 'replace' },
            { name: 'Replace preparation without releasing serializer', value: 'withdraw' },
            { name: 'Release old serializer', value: 'release' },
          ] : [],
          onPick: ({ candidate }) => {
            if (candidate.value !== 'release') { disposePreparation(); registerPreparation(); }
            if (candidate.value !== 'withdraw') { serializationGate.resolve(); serializationGate = undefined; }
            return { text: '' };
          },
        }));
      });
    },
  }; } });
})();
