// Acceptance-only observer of the public browser entry reconciliation API.
window.__ModuleLoader__.load({ id: 'display-observer', factory() {
  return { inject: ['inputTriggers', 'modules'], apply(ctx) {
    const graph = window.__DSH_BOOT__;
    ctx.effect(() => ctx.inputTriggers.registerSource({
      name: 'display-lifecycle', trigger: '@', order: -200,
      candidates: async () => [{ name: 'Unload display extension', value: 'unload' }, { name: 'Reload display extension', value: 'reload' }],
      onPick: ({ candidate }) => {
        const removed = 'arlo-contact-display';
        const next = candidate.value === 'unload' ? { ...graph,
          entries: graph.entries.filter(row => row.id !== removed),
          batches: graph.batches.map(batch => ({ ...batch, entries: batch.entries.filter(id => id !== removed) })).filter(batch => batch.entries.length),
        } : graph;
        void ctx.modules.entries.sync(next);
        return { text: '' };
      },
    }));
  } };
} });
