import { ArloError, type SessionDiscoveryItem } from '@arlo/sdk';
import type { CustomEditor, ExtensionUIContext } from '@earendil-works/pi-coding-agent';

type Provider = ReturnType<Parameters<ExtensionUIContext['addAutocompleteProvider']>[0]>;
type Item = NonNullable<Awaited<ReturnType<Provider['getSuggestions']>>>['items'][number];
const DIRECTORY_TIMEOUT_MS = 2000;

function display(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
}

function hostName(kind: string): string {
  return kind === 'pi' ? 'Pi' : kind === 'dsh' ? 'DSH' : display(kind);
}

function sessionHostKind(session: SessionDiscoveryItem): string {
  return session.host_kind ?? session.host_type ?? 'unknown';
}

function sessionLabels(sessions: SessionDiscoveryItem[], kind: string): string[] {
  const ids = sessions.map(session => session.endpoint_id.replace(/^ep-/, ''));
  return sessions.map((session, index) => {
    const id = ids[index]!;
    let length = 6;
    while (length < id.length && ids.some((other, i) => i !== index && other.slice(0, length) === id.slice(0, length))) length++;
    return `${display(session.display_name ?? '') || 'Untitled session'} · ${hostName(kind)} · ${id.slice(0, length)}`;
  });
}

/** Native completion and selection belong to one draft of one live attachment. */
export function installContacts(options: {
  ui: ExtensionUIContext;
  current(): boolean;
  editor(): CustomEditor | undefined;
  list(): Promise<SessionDiscoveryItem[]>;
  onHostCompletion(): void;
}) {
  const { ui } = options;
  let disposed = false;
  let revision = 0;
  let selection: AbortController | undefined;
  let selectorOpen = false;
  const queries = new Set<AbortController>();
  const live = () => !disposed && options.current();
  const invalidate = () => {
    revision++;
    selection?.abort();
    for (const query of queries) query.abort();
  };
  const unsubscribe = ui.onTerminalInput(data => {
    // The public native selector confirms with Enter. Keep Tab selection local
    // to this selector, without changing editor or other dialog keybindings.
    if (selectorOpen && data === '\t') return { data: '\r' };
    return undefined;
  });

  function snapshot() {
    const editor = options.editor();
    if (!editor) return undefined;
    const version = revision;
    const factory = ui.getEditorComponent();
    const text = editor.getExpandedText();
    const cursor = editor.getCursor();
    return { editor, text, cursor, current: () => live() && revision === version &&
      options.editor() === editor && ui.getEditorComponent() === factory &&
      editor.getExpandedText() === text && editor.getCursor().line === cursor.line && editor.getCursor().col === cursor.col };
  }

  async function directory(signal: AbortSignal): Promise<SessionDiscoveryItem[]> {
    signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('DIRECTORY_TIMEOUT')), DIRECTORY_TIMEOUT_MS);
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([options.list(), interrupted]); }
    finally { clearTimeout(timer!); signal.removeEventListener('abort', abort!); }
  }

  function unavailable(error: unknown) {
    const code = error instanceof ArloError ? error.code : error instanceof Error && error.message === 'DIRECTORY_TIMEOUT'
      ? 'DIRECTORY_TIMEOUT' : 'DIRECTORY_QUERY_FAILED';
    ui.notify(`Arlo contacts unavailable: ${code}. Native input remains available.`, 'warning');
  }

  ui.addAutocompleteProvider(native => {
    const hosts = new WeakMap<Item, { kind: string; sessions: SessionDiscoveryItem[] }>();
    const prefixes = new WeakMap<Item, string>();
    return {
      triggerCharacters: [...new Set([...(native.triggerCharacters ?? []), '@'])],
      shouldTriggerFileCompletion: native.shouldTriggerFileCompletion?.bind(native),
      async getSuggestions(lines, cursorLine, cursorCol, request) {
        if (!live() || !/(?:^|\s)@$/.test(lines[cursorLine]!.slice(0, cursorCol))) {
          return native.getSuggestions(lines, cursorLine, cursorCol, request);
        }
        const draft = snapshot();
        if (!draft) return native.getSuggestions(lines, cursorLine, cursorCol, request);
        const query = new AbortController();
        queries.add(query);
        const signal = AbortSignal.any([request.signal, query.signal]);
        const [original, contacts] = await Promise.allSettled([
          native.getSuggestions(lines, cursorLine, cursorCol, { ...request, signal }), directory(signal),
        ]).finally(() => queries.delete(query));
        if (signal.aborted || !draft?.current()) return null;
        if (original.status === 'rejected') throw original.reason;
        if (contacts.status === 'rejected') {
          unavailable(contacts.reason);
          return original.value;
        }
        const groups = new Map<string, SessionDiscoveryItem[]>();
        for (const session of contacts.value) {
          if (!session.deliverable) continue;
          const kind = sessionHostKind(session);
          const sessions = groups.get(kind) ?? [];
          if (!sessions.some(item => item.endpoint_id === session.endpoint_id)) sessions.push(session);
          groups.set(kind, sessions);
        }
        const items: Item[] = [];
        for (const [kind, sessions] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
          sessions.sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? '') || a.endpoint_id.localeCompare(b.endpoint_id));
          const item = { value: `@arlo:${kind}`, label: `Arlo · ${hostName(kind)}`, description: `${sessions.length} online session${sessions.length === 1 ? '' : 's'}` };
          hosts.set(item, { kind, sessions });
          items.push(item);
        }
        for (const item of original.value?.items ?? []) {
          prefixes.set(item, original.value!.prefix);
          items.push(item);
        }
        return items.length ? { items, prefix: '@' } : original.value;
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const host = hosts.get(item);
        if (!host) return native.applyCompletion(lines, cursorLine, cursorCol, item, prefixes.get(item) ?? prefix);
        invalidate();
        const controller = new AbortController();
        selection = controller;
        const draft = snapshot();
        options.onHostCompletion();
        const current = () => !controller.signal.aborted && selection === controller && !!draft?.current();
        // Pi closes autocomplete after applyCompletion. Open its public dialog
        // in the next microtask, leaving the draft and paste registry intact.
        queueMicrotask(() => {
          if (!current()) return;
          const monitor = setInterval(() => { if (!current()) controller.abort(); }, 25);
          void (async () => {
            try {
              const labels = sessionLabels(host.sessions, host.kind);
              selectorOpen = true;
              const chosen = await ui.select(`Arlo · ${hostName(host.kind)}: select session`, labels, { signal: controller.signal });
              selectorOpen = false;
              if (chosen === undefined || !current()) return;
              const target = host.sessions[labels.indexOf(chosen)];
              if (!target) return;
              const available = await directory(controller.signal);
              if (!current()) return;
              if (!available.some(session => session.deliverable && session.endpoint_id === target.endpoint_id &&
                  sessionHostKind(session) === host.kind)) {
                ui.notify('Arlo contact is no longer available. Draft retained.', 'warning');
                return;
              }
              // Full IDs alone address messages. No choice sends or persists a
              // routing preference, and insertion is one native undo operation.
              draft!.editor.insertTextAtCursor(`arlo:${host.kind}:${target.endpoint_id} `);
            } catch (error) { if (current()) unavailable(error); }
            finally {
              clearInterval(monitor);
              selectorOpen = false;
              if (selection === controller) selection = undefined;
            }
          })();
        });
        return { lines, cursorLine, cursorCol };
      },
    };
  });
  return {
    invalidate,
    get querying() { return queries.size > 0; },
    get selecting() { return selection !== undefined && !selection.signal.aborted; },
    dispose() { disposed = true; invalidate(); unsubscribe(); },
  };
}
