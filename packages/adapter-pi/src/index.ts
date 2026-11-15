import { createAdapterRuntime, createParticipationSettings, readParticipationPreference, participationScope, type AdapterRuntimeOptions } from '@arlo/adapter-sdk';
import path from 'node:path';
import fs from 'node:fs';
import { ensureSharedDaemon } from '@arlo/daemon/shared';
import { ArloError, ArloErrorCode, validateExplicitGroupName, captureRootConfigurationEvidence, type RootConfigurationEvidence } from '@arlo/sdk';
import {
  CustomEditor, VERSION, getAgentDir, parseSessionEntries, type ExtensionContext, type ExtensionFactory, type SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import { setKeybindings } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { PiInputSource, type PiInputAttachment } from './input.ts';
import { installContacts } from './contacts.ts';
import { piSessionOrigin, witnessPiCreation } from './initial.ts';
import { formalPiVersions, inspectPiCompatibility, missingPiMethods, type PiCompatibilityPolicy } from './compatibility.ts';

export { PiInputSource, type PiInputConsumer, type PiInputAttachment } from './input.ts';
export { inspectPiCompatibility, type PiCompatibilityReport, type PiCompatibilityPolicy } from './compatibility.ts';
export type { PiEnvironmentEvidence, PiEnvironmentRecord, PiInstallationIdentity } from './environment.ts';

type SessionManager = ExtensionContext['sessionManager'];
interface PiRoot {
  context: ExtensionContext;
  manager: SessionManager;
  header: NonNullable<ReturnType<SessionManager['getHeader']>>;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  attachment?: object;
  lastAttachment?: object;
  input: PiInputSource;
  runtime?: ReturnType<typeof createAdapterRuntime<PiRoot>>;
  settings?: ReturnType<typeof createParticipationSettings>;
  participationScope: string;
  stopped?: Promise<void>;
  ended?: Promise<void>;
  ready: boolean;
  onReady?: (ready: boolean) => void;
  reusable: boolean;
  firstUse?: ReturnType<typeof witnessPiCreation>;
}

const REGISTRY = Symbol.for('arlo.pi-root-inputs.v1');
interface Registry { roots: WeakMap<SessionManager, PiRoot> }
const processState = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
const registry = processState[REGISTRY] ??= { roots: new WeakMap() };

function sameRoot(root: PiRoot, manager: SessionManager): boolean {
  try {
    return root.manager === manager && manager.getHeader() === root.header &&
      manager.getSessionId() === root.sessionId && manager.getSessionFile() === root.sessionFile;
  } catch { return false; }
}

function liveRoot(root: PiRoot): boolean {
  if (root.ended || (root.stopped && !root.reusable) || !root.attachment) return false;
  try {
    // Pi's context getters reject after native runtime replacement/reload.
    // IDs and even a reused manager/header cannot prove instance continuity.
    return root.context.mode === 'tui' && sameRoot(root, root.context.sessionManager) &&
      root.manager.getCwd() === root.cwd;
  } catch { return false; }
}

function configurationEvidence(root: PiRoot): RootConfigurationEvidence | undefined {
  if (!liveRoot(root)) return undefined;
  const sessionFile = root.manager.getSessionFile();
  if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;
  const evidence: RootConfigurationEvidence = { kind: 'session-file', session_file: sessionFile };
  let descriptor: number | undefined;
  try {
    // open() may initialize or migrate a Pi session; querying must never do
    // either. Parse only the bounded durable header with Pi's public parser.
    descriptor = fs.openSync(sessionFile, 'r');
    const pinned = captureRootConfigurationEvidence(sessionFile, descriptor,
      piSessionOrigin(root.header));
    const buffer = Buffer.alloc(64 * 1024);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, length).indexOf(10);
    if (newline < 0) return { ...evidence, invalid: true };
    const entries = parseSessionEntries(buffer.subarray(0, newline).toString('utf8'));
    const header = entries[0];
    const liveHeader = root.manager.getHeader();
    if (entries.length !== 1 || header?.type !== 'session' || !liveHeader ||
        header.id !== root.sessionId || header.id !== liveHeader.id ||
        header.version !== liveHeader.version || header.timestamp !== liveHeader.timestamp ||
        header.cwd !== liveHeader.cwd || header.parentSession !== liveHeader.parentSession) {
      return { ...evidence, invalid: true };
    }
    if (captureRootConfigurationEvidence(sessionFile, descriptor).file_revision !== pinned.file_revision) {
      return { ...evidence, invalid: true };
    }
    return pinned;
  } catch {
    return { ...evidence, invalid: true };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function stopRoot(root: PiRoot, mode: 'pause' | 'retire'): Promise<void> {
  if (mode === 'retire') root.reusable = false;
  root.settings?.dispose();
  root.attachment = undefined;
  root.ready = false;
  root.onReady = undefined;
  root.input.detach();
  return root.stopped = (!root.reusable ? root.runtime?.suspend() : root.runtime?.pause()) ?? Promise.resolve();
}

function endRoot(root: PiRoot): Promise<void> {
  if (root.ended) return root.ended;
  root.settings?.dispose();
  root.attachment = undefined;
  root.ready = false;
  root.onReady = undefined;
  // Seal providers, prepared notifications and control wakes before emitting
  // final evidence. The runtime still holds the original dispatch authority.
  root.input.close();
  return root.ended = root.runtime?.dispose() ?? Promise.resolve();
}

export interface PiAdapterOptions {
  stateDir?: string;
  groupName?: string;
  autoStart?: AdapterRuntimeOptions<object>['autoStart'];
  /** Shared plugin configuration; defaults to Pi's active agent directory. */
  settingsPath?: string;
  /** Explicitly investigate an unverified host; mandatory contracts still apply. */
  compatibility?: PiCompatibilityPolicy;
}

function reason(error: unknown): string {
  return error instanceof ArloError ? error.code : ArloErrorCode.CHANNEL_NOT_READY;
}

function formatArloStatus(pending: number, ready: boolean, cancelled = 0): string {
  if (pending > 0) return `Arlo: ${pending} pending`;
  if (cancelled > 0) return 'Arlo pending messages cancelled';
  return ready ? 'Arlo ready' : 'Arlo connecting';
}

/** Existing native Pi roots; headless/print runs and internal subagents do not register. */
export function createPiAdapter(options: PiAdapterOptions = {}): ExtensionFactory {
  if (options.groupName !== undefined) validateExplicitGroupName(options.groupName);
  return pi => {
    const missingRegistration = missingPiMethods(pi, ['on', 'registerCommand', 'registerTool'], 'pi');
    if (missingRegistration.length) throw new Error(`MISSING_PI_CAPABILITY: ${missingRegistration.join(', ')}`);
    if (typeof pi.registerFlag === 'function') pi.registerFlag('arlo-experimental', {
      type: 'boolean', default: false,
      description: 'Try an unverified Pi version while retaining required Arlo contracts',
    });
    const policy = (): PiCompatibilityPolicy => options.compatibility === 'experimental' ||
      (typeof pi.getFlag === 'function' && pi.getFlag('arlo-experimental') === true) ? 'experimental' : 'verified';
    const diagnoseCompatibility = (ctx: ExtensionContext) => {
      const diagnosis = inspectPiCompatibility(pi, ctx, policy());
      // Pi's native extension-error surface remains available if notifications
      // themselves are missing. Never call the missing API to explain failure.
      if (typeof ctx.ui?.notify !== 'function') throw new Error('MISSING_PI_CAPABILITY: ui.notify');
      return diagnosis;
    };
    const attachment = {};
    let root: PiRoot | undefined;
    let inputAttachment: PiInputAttachment | undefined;
    let contacts: ReturnType<typeof installContacts> | undefined;
    let interruptionRequested = false;
    let runOpen = false;
    let standaloneCompaction: {
      reason: SessionBeforeCompactEvent['reason']; signal: AbortSignal; interrupted: boolean; completed: boolean;
    } | undefined;

    const current = (): boolean => {
      if (!root || root.attachment !== attachment) return false;
      if (liveRoot(root)) return true;
      // A stale context cannot distinguish reload from final root teardown.
      // Stop this consumer now; the native shutdown reason decides permanence.
      void stop('pause');
      return false;
    };

    const stop = (mode: 'pause' | 'retire' = 'pause'): Promise<void> => {
      contacts?.dispose();
      inputAttachment?.detach();
      if (!root || root.lastAttachment !== attachment) return root?.stopped ?? Promise.resolve();
      return stopRoot(root, mode);
    };

    const stopReception = (ctx: ExtensionContext, text: string): Promise<void> => {
      ctx.ui.setStatus('arlo', 'Arlo reception stopped');
      ctx.ui.notify(text, 'error');
      return stop();
    };

    const caller = (ctx: ExtensionContext): PiRoot => {
      if (!current() || ctx.mode !== 'tui' || ctx.sessionManager !== root!.manager) {
        throw new ArloError(ArloErrorCode.CALLER_NOT_ROOT);
      }
      return root!;
    };

    const initializeSending = async (owner: PiRoot): Promise<void> => {
      if (!current() || root !== owner) return;
      try { await owner.runtime!.initializeRootSending(owner); }
      catch { /* Sending status explains the pause; local work still proceeds. */ }
    };

    const reportReady = async (owner: PiRoot, ctx: ExtensionContext, reattaching: boolean): Promise<void> => {
      if (!current()) return;
      if (reattaching) {
        try {
          await owner.runtime!.resume();
          if (!current()) return;
          owner.ready = true;
          inputAttachment!.activate();
          ctx.ui.setStatus('arlo', 'Arlo ready');
        } catch (error) {
          if (current()) await stopReception(ctx, `Arlo unavailable: ${reason(error)}. Pending input is retained.`);
        }
        return;
      }
      const deadline = Date.now() + 30_000;
      while (current() && Date.now() < deadline) {
        if (owner.ready) {
          inputAttachment!.activate();
          return;
        }
        try {
          await owner.runtime!.listContactSessions(owner);
          if (!current()) return;
          owner.ready = true;
          inputAttachment!.activate();
          ctx.ui.setStatus('arlo', formatArloStatus(owner.input.pendingCount, true));
          return;
        } catch (error) {
          if (!current()) return;
          if (reason(error) !== ArloErrorCode.CHANNEL_NOT_READY) {
            ctx.ui.notify(`Arlo unavailable: ${reason(error)}`, 'error');
            await stop();
            return;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (current() && !owner.ready) {
        ctx.ui.notify('Arlo unavailable: CHANNEL_NOT_READY', 'error');
        await stop();
      }
    };

    pi.on('session_start', async (event, ctx) => {
      if (ctx.mode !== 'tui') return;
      const diagnosis = diagnoseCompatibility(ctx);
      if (!diagnosis.formal && diagnosis.policy !== 'experimental') {
        ctx.ui.notify(`Arlo unavailable: UNSUPPORTED_PI_VERSION (${VERSION}). Formal versions: ${formalPiVersions.join(', ')}. Use --arlo-experimental to explicitly investigate this unverified host.`, 'error');
        return;
      }
      if (diagnosis.missing.length) {
        ctx.ui.notify(`Arlo unavailable: MISSING_PI_CAPABILITY: ${diagnosis.missing.join(', ')}`, 'error');
        return;
      }
      if (!diagnosis.rootContext) {
        ctx.ui.notify('Arlo unavailable: ROOT_CONTEXT_REQUIRED', 'error');
        return;
      }
      if (diagnosis.policy === 'experimental') ctx.ui.notify(`Arlo experimental: Pi ${VERSION}; ${diagnosis.formal ? 'baseline has known scheduling limits' : 'runtime behavior is unverified'}. Formal support is unchanged.`, 'warning');
      const manager = ctx.sessionManager;
      const previous = registry.roots.get(manager);
      const configPath = options.settingsPath ?? path.join(getAgentDir(), 'arlo.json');
      let scope: string;
      try { scope = participationScope(configPath); }
      catch (error) { ctx.ui.notify(`Arlo settings unavailable: ${reason(error)}`, 'error'); return; }
      const reattaching = event.reason === 'reload' && previous?.reusable === true &&
        !previous.attachment && previous.participationScope === scope && sameRoot(previous, manager);
      if (root || (!reattaching && (previous && liveRoot(previous) || event.reason === 'reload'))) {
        if (root) void stop('retire');
        if (previous && previous !== root) void stopRoot(previous, 'retire');
        ctx.ui.notify('Arlo stopped after a session or attachment change. Pending input is retained.', 'warning');
        return;
      }
      if (previous && !reattaching) await endRoot(previous);
      // An asynchronous retirement must not authorize an already stale start.
      try { if (ctx.mode !== 'tui' || ctx.sessionManager !== manager) return; }
      catch { return; }
      const header = manager.getHeader();
      const sessionFile = manager.getSessionFile();
      if (!header || !header.id || header.id !== manager.getSessionId() || !sessionFile || !manager.getCwd()) {
        ctx.ui.notify('Arlo unavailable: ROOT_CONTEXT_REQUIRED', 'error');
        return;
      }
      const owner: PiRoot = reattaching ? previous! : {
        context: ctx, manager, header, sessionId: manager.getSessionId(), sessionFile,
        cwd: manager.getCwd(), input: new PiInputSource(), ready: false, reusable: true, participationScope: scope,
      };
      if (!reattaching) {
        try { owner.firstUse = witnessPiCreation(manager, event.reason, (type, data) => pi.appendEntry(type, data)); }
        catch { /* Public persistence failure leaves human recovery available. */ }
      }
      let enabled: boolean;
      try { enabled = readParticipationPreference(configPath); }
      catch (error) { ctx.ui.notify(`Arlo settings unavailable: ${reason(error)}`, 'error'); return; }
      owner.context = ctx;
      owner.stopped = undefined;
      owner.attachment = owner.lastAttachment = attachment;
      root = owner;
      registry.roots.set(manager, owner);
      inputAttachment = owner.input.attach({
        current,
        idle: () => current() && !interruptionRequested && ctx.isIdle(),
        sendControl: text => {
          if (!current()) return;
          // A body-free completion control may need to wait through an
          // interrupted manual operation. Claiming still checks its boundary.
          pi.sendUserMessage(`/arlo-wake ${text}`, { expandPromptTemplates: true });
        },
        unavailable: code => {
          if (!current()) return;
          owner.ready = false;
          owner.stopped = owner.runtime!.pause();
          ctx.ui.setStatus('arlo', 'Arlo reception waiting for native control');
          ctx.ui.notify(`Arlo reception paused: ${code}. Pending input and unresolved credit are retained. The final native control may restore this attachment when its handler runs. No automatic resend.`, 'warning');
        },
        recover: async () => {
          if (!current()) return;
          await owner.runtime!.resume();
          if (!current()) return;
          owner.stopped = undefined;
          owner.ready = true;
        },
        changed: (pending, cancelled) => {
          if (!current()) return;
          if (cancelled > 0) ctx.ui.notify(`Arlo cancelled ${cancelled} pending message${cancelled === 1 ? '' : 's'}.`, 'info');
          ctx.ui.setStatus('arlo', formatArloStatus(pending, owner.ready, cancelled));
        },
      }, { suspended: true });

      // Pi 1.1.0's default retry/compaction Escape handlers abort only those
      // stages, omitting the run abort flag. Public CustomEditor dispatch keeps
      // focus, configured app.interrupt, autocomplete, and idle native behavior.
      let editor: ReceptionEditor | undefined;
      class ReceptionEditor extends CustomEditor {
        private readonly completionUndos: string[] = [];
        private draftState(): string {
          return JSON.stringify([this.getText(), this.getExpandedText(), this.getCursor()]);
        }
        recordHostCompletion(): void { this.completionUndos.push(this.draftState()); }
        override handleInput(data: string): void {
          if ((contacts?.selecting || contacts?.querying) && keybindings.matches(data, 'app.interrupt')) {
            contacts.invalidate();
            return;
          }
          contacts?.invalidate();
          const nativeEscape = this.onEscape;
          const nativeSubmit = this.onSubmit;
          this.onSubmit = text => {
            this.completionUndos.length = 0;
            nativeSubmit?.(text);
          };
          this.onEscape = () => {
            if (current() && ctx.isIdle() && owner.input.pendingCount > 0) {
              // Later settled handlers may still hold controls after Pi has
              // published idle. No run owns cancellation at this boundary.
              inputAttachment!.cancelPending();
            } else if (current() && !ctx.isIdle()) {
              interruptionRequested = true;
              if (standaloneCompaction && !runOpen) standaloneCompaction.interrupted = true;
              ctx.abort();
            } else nativeEscape?.();
          };
          try {
            const undo = keybindings.matches(data, 'tui.editor.undo');
            const before = undo ? this.draftState() : undefined;
            super.handleInput(data);
            // Pi pushes an undo snapshot even for the host drill-down's
            // unchanged completion. Consume only those recorded no-op steps,
            // using the user's actual undo key and public editor behavior.
            if (undo) {
              while (this.completionUndos.at(-1) === before && this.draftState() === before) {
                this.completionUndos.pop();
                super.handleInput(data);
              }
            }
          }
          finally { this.onEscape = nativeEscape; this.onSubmit = nativeSubmit; }
        }
        override setText(text: string): void { contacts?.invalidate(); super.setText(text); }
        override insertTextAtCursor(text: string): void { contacts?.invalidate(); super.insertTextAtCursor(text); }
      }
      let keybindings: ConstructorParameters<typeof CustomEditor>[2];
      const editorFactory: NonNullable<Parameters<typeof ctx.ui.setEditorComponent>[0]> = (tui, theme, bindings) => {
        keybindings = bindings;
        // Bundled Pi and its public editor can have distinct TUI module state.
        // The host supplies the authoritative user-configured keybindings.
        setKeybindings(bindings);
        return editor = new ReceptionEditor(tui, theme, bindings, { embedWorkingStatus: true });
      };
      ctx.ui.setEditorComponent(editorFactory);
      ctx.ui.setStatus('arlo', formatArloStatus(owner.input.pendingCount, owner.ready));
      owner.onReady = ready => {
        if (!current()) return;
        owner.ready = ready;
        ctx.ui.setStatus('arlo', formatArloStatus(owner.input.pendingCount, ready));
      };
      owner.runtime ??= createAdapterRuntime<PiRoot>({
        ...options,
        hostType: 'pi', hostKind: 'pi', hostVersion: VERSION, crossHostEnabled: enabled,
        participationScope: owner.participationScope,
        startSharedDaemon: ensureSharedDaemon,
        getSessionTitle: live => live.manager.getSessionName(),
        onReady: (live, ready) => live.onReady?.(ready),
        host: {
          // The runtime belongs to the root, not the first runner's closure.
          roots: () => owner.attachment && owner.reusable && sameRoot(owner, owner.manager) ? [owner] : [],
          sessionId: live => live.sessionId,
          sessionCwd: live => live.cwd,
          // Pi publishes paths before the first conversation is durable.
          // A path alone cannot prove ownership, and stale memory cannot
          // substitute for a valid persisted header on later queries.
          rootConfigurationEvidence: configurationEvidence,
          rootFirstUseEvidence: live => liveRoot(live) ? live.firstUse?.() : undefined,
          reception: live => live.input,
          onCreated: () => () => {},
          onDisposed: () => () => {},
        },
      });
      let readinessStarted = false;
      const settingsFailed = (error: unknown) => {
        if (current()) ctx.ui.notify(`Arlo settings update failed: ${reason(error)}`, 'error');
      };
      owner.settings = createParticipationSettings({ configPath,
        prepare: () => owner.runtime!.prepareParticipationUpdate(),
        changed: state => {
          if (!current()) return;
          contacts?.invalidate();
          ctx.ui.setStatus('arlo-participation', state.effective === null
            ? state.error ? `Arlo cross-host update failed: ${state.error}` : 'Arlo cross-host: updating'
            : `Arlo cross-host: ${state.effective ? 'on' : 'off'}`);
          // The first update may fail while the transport recovers. Start the
          // current consumer after any first successful confirmation, including
          // a later poll or command, without resuming it on every preference edit.
          if (state.effective !== null && !readinessStarted) {
            readinessStarted = true;
            void reportReady(owner, ctx, reattaching).catch(settingsFailed);
          }
        },
      });
      contacts = installContacts({ ui: ctx.ui, current,
        editor: () => ctx.ui.getEditorComponent() === editorFactory ? editor : undefined,
        list: () => owner.runtime!.listContactSessions(owner), onHostCompletion: () => editor?.recordHostCompletion() });
      void owner.settings.refresh().catch(settingsFailed);
    });

    pi.registerCommand('arlo-doctor', {
      description: 'Read current Pi compatibility, reception and persistent root evidence',
      async handler(args, ctx) {
        if (args.trim()) { ctx.ui.notify('Use /arlo-doctor with no arguments.', 'error'); return; }
        const diagnosis = diagnoseCompatibility(ctx);
        const owner = current() && ctx.sessionManager === root!.manager ? root : undefined;
        let ownership = 'unknown (ROOT_CONTEXT_REQUIRED)';
        if (owner) {
          try {
            const status = await owner.runtime!.getRootConfiguration(owner);
            if (!current()) return;
            ownership = `${status.ownership} (${status.reason})`;
          } catch (error) { ownership = `unknown (${reason(error)})`; }
        }
        ctx.ui.notify([
          'Arlo compatibility', `Pi version: ${diagnosis.version}`, `Policy: ${diagnosis.policy}`,
          `Formal versions: ${formalPiVersions.join(', ')}`,
          `Host support policy: ${diagnosis.hostSupportPolicy}`,
          `Runtime: ${diagnosis.runtime.platform}/${diagnosis.runtime.arch}/Node ${diagnosis.runtime.node}`,
          `Node executable: ${process.execPath}`,
          ...(diagnosis.observedWindows ? [
            diagnosis.observedWindows.status === 'observed'
              ? `Observed Windows: ${diagnosis.observedWindows.osRelease}; ${diagnosis.observedWindows.productName} ${diagnosis.observedWindows.displayVersion}; build ${diagnosis.observedWindows.build} (${diagnosis.observedWindows.source})`
              : `Observed Windows: unavailable (${diagnosis.observedWindows.reason}); OS release ${diagnosis.observedWindows.osRelease}`,
            `Measured Windows: ${(diagnosis.environmentEvidence.measuredWindows ?? []).map(windows =>
              `${windows.osRelease}; ${windows.productName} ${windows.displayVersion}; build ${windows.build}`).join(' | ') || 'unavailable'}`,
          ] : []),
          diagnosis.installation.adapter
            ? `Adapter identity: ${diagnosis.installation.adapter.name}@${diagnosis.installation.adapter.version} (${diagnosis.installation.adapter.artifactSha256})`
            : 'Adapter identity: unavailable',
          `Evidence binding: ${diagnosis.installation.binding}`,
          `Environment evidence: ${diagnosis.environmentEvidence.status} (${diagnosis.environmentEvidence.reason})`,
          ...(diagnosis.environmentEvidence.scope ? [`Environment scope: ${diagnosis.environmentEvidence.scope}`] : []),
          ...(diagnosis.environmentEvidence.status === 'unverified' ? ['当前环境尚未验证'] : [
            `Measured acceptance: ${diagnosis.environmentEvidence.acceptance}`,
            `Tested capabilities: ${diagnosis.environmentEvidence.testedCapabilities.join('; ')}`,
            `Environment limits: ${diagnosis.environmentEvidence.limitations.join('; ')}`,
          ]),
          `Required interface: ${diagnosis.missing.length ? `missing ${diagnosis.missing.join(', ')}` : 'available'}`,
          `Current native root: ${diagnosis.rootContext ? 'valid' : 'unavailable'}`,
          `Required contracts: ${diagnosis.requiredContracts.ready ? 'satisfied' : 'unavailable'} (${diagnosis.requiredContracts.reason})`,
          `Reception: ${owner?.ready ? 'ready' : 'unavailable'}`, `Ownership: ${ownership}`,
          'Busy scheduling: limited; ordinary preflight and delayed settlement can suspend reception. Pending input is retained; unknown does not permit resend.',
          'Required contracts and reception readiness are current checks, not a complete native acceptance result. Experimental mode does not expand formal support.',
        ].join('\n'), owner?.ready ? 'info' : 'warning');
      },
    });

    pi.registerCommand('arlo-root-config', {
      description: 'Query configuration ownership for the current native Pi root',
      async handler(args, ctx) {
        try {
          const owner = caller(ctx);
          if (args.trim()) {
            ctx.ui.notify('Use /arlo-root-config with no arguments.', 'error');
            return;
          }
          const status = await owner.runtime!.getRootConfiguration(owner);
          if (!current()) return;
          ctx.ui.notify([
            'Arlo root configuration',
            `Current root authenticated: ${status.root_authenticated}`,
            `Configuration ID: ${status.config_id ?? 'Unavailable'}`,
            `Configuration location: ${status.config_path}`,
            `Ownership: ${status.ownership} (${status.reason})`,
            `Historical first eligibility: ${status.history}`,
            status.guidance,
          ].join('\n'), status.ownership === 'verified' ? 'info' : 'warning');
        } catch (error) {
          if (current()) ctx.ui.notify(`Arlo root configuration unavailable: ${reason(error)}`, 'error');
        }
      },
    });

    for (const operation of ['status', 'continue', 'reload']) {
      const name = operation === 'continue' ? 'arlo-continue' : operation === 'reload' ? 'arlo-reload-sending-rules' : 'arlo-send-status';
      pi.registerCommand(name, {
        description: operation === 'continue'
          ? 'Explicitly continue collaboration for the current native root with a new dispatch attempt allowance'
          : operation === 'reload' ? 'Reload private autonomous communication rules and report the current native root status'
          : 'Query the current native root sending state and dispatch attempt allowance',
        async handler(args, ctx) {
          try {
            const owner = caller(ctx);
            if (args.trim()) {
              ctx.ui.notify(`Use /${name} with no arguments.`, 'error');
              return;
            }
            const status = operation === 'continue'
              ? await owner.runtime!.continueCollaboration(owner)
              : operation === 'reload' ? await owner.runtime!.reloadSendingRules(owner)
              : await owner.runtime!.getRootSendingStatus(owner);
            if (!current()) return;
            ctx.ui.notify([
              'Arlo dispatch attempts', `Mode: ${status.mode}`, `Period: ${status.period_id ?? 'unknown'}`,
              `Usage: ${status.knowledge}`, `Granted: ${status.granted ?? 'unknown'}`, `Used: ${status.used ?? 'unknown'}`,
              `Remaining: ${status.mode === 'continuous' ? 'unlimited' : status.remaining ?? 'unknown'}`, `Next grant: ${status.next_grant}`,
              `Pause reason: ${status.pause_reason ?? 'none'}`,
              `Rules problem: ${status.rules_error ?? 'none'}`,
              ...(status.initial_allowance ? [
                `Initial allowance: ${status.initial_allowance.eligibility} (${status.initial_allowance.reason})`,
                status.initial_allowance.guidance,
              ] : []),
            ].join('\n'), status.pause_reason || status.rules_error ? 'warning' : 'info');
          } catch (error) {
            const diagnostic = operation === 'reload' && error instanceof ArloError && error.code === ArloErrorCode.SENDING_RULES_INVALID
              ? `: ${error.message.slice(0, 1024)}` : '';
            if (current()) ctx.ui.notify(`Arlo sending operation failed: ${reason(error)}${diagnostic}`, 'error');
          }
        },
      });
    }

    pi.registerCommand('arlo-settings', {
      description: 'Save Arlo cross-host communication preference for this Pi configuration',
      async handler(args, ctx) {
        try {
          const owner = caller(ctx);
          const choice = args.trim() || await ctx.ui.select('Arlo cross-host communication', ['Off (default)', 'On']);
          if (choice === undefined || !current()) return;
          if (!['on', 'off', 'On', 'Off (default)'].includes(choice)) {
            ctx.ui.notify('Use /arlo-settings on or /arlo-settings off.', 'error');
            return;
          }
          const status = await owner.settings!.set(choice === 'on' || choice === 'On');
          if (current()) ctx.ui.notify(`Cross-host communication ${status.effective ? 'enabled' : 'disabled'}.`, 'info');
        } catch (error) {
          if (current()) ctx.ui.notify(`Arlo settings update failed: ${reason(error)}`, 'error');
        }
      },
    });

    pi.registerCommand('arlo-wake', {
      description: 'Internal Arlo reception control',
      async handler(token, ctx) {
        const available = () => current() && ctx.mode === 'tui' && ctx.sessionManager === root!.manager;
        if (!available()) return;
        const currentInput = inputAttachment!;
        const recovery = currentInput.recoverControl(token);
        if (recovery) {
          try { await recovery; }
          catch {
            if (available()) await stopReception(ctx, 'Arlo cannot restore reception. Pending input is retained.');
            return;
          }
          if (!available()) return;
        }
        while (!ctx.isIdle()) {
          if (!currentInput.deferControl(token)) return;
          try { await ctx.waitForIdle(); }
          catch {
            if (current()) await stopReception(ctx, 'Arlo cannot schedule received input. Pending input is retained.');
            return;
          }
          if (!available()) return;
        }
        if (!currentInput.deferControl(token)) return;
        if (standaloneCompaction?.completed) {
          const operation = standaloneCompaction;
          standaloneCompaction = undefined;
          // Manual and pre-prompt automatic compaction check abort before
          // emitting session_compact. Escape in a later success handler has
          // no failed/aborted-settled event. Match its public signal and editor
          // intent at actual idle, while no agent run owns cancellation.
          if (!runOpen && operation.interrupted && operation.signal.aborted && interruptionRequested) {
            interruptionRequested = false;
            currentInput.cancelPending();
            return;
          }
        }
        if (interruptionRequested) return;
        const message = currentInput.control(token);
        if (!message) return;
        // Pi dispatches extension commands after settlement deferral and
        // before its asynchronous ordinary-prompt preflight. This callback
        // checks live/idle/token, claims, and hands off in one JS stack after
        // any native operation whose completion notification preceded idle.
        pi.sendMessage(message, { triggerTurn: true });
      },
    });
    pi.on('agent_start', () => { if (current()) runOpen = true; });
    pi.on('before_provider_request', async () => {
      if (!current()) return;
      await initializeSending(root!);
    });
    pi.on('before_agent_start', event => {
      // Pi 1.2 adds custom turns without a user prompt. Only a submitted user
      // prompt may establish contact instructions, including on the baseline.
      if (!current() || ('messageType' in event && event.messageType !== 'user') ||
          !('prompt' in event) || typeof event.prompt !== 'string' ||
          !/@arlo:[a-z0-9.-]+:ep-[0-9a-f-]+/.test(event.prompt)) return;
      return { systemPrompt: `${event.systemPrompt}\n\nArlo contact mentions in this submitted prompt have the form @arlo:<host>:<full-endpoint>. A mention selects a recipient only. If the user explicitly asks to send, organize the requested context and call arlo_send_message with that exact full endpoint. Never substitute a title or short ID, guess a replacement for an unavailable endpoint, or forward later ordinary prompts to this recipient. accepted means queued, not read or completed; unknown does not permit automatic resend.` };
    });
    pi.on('agent_before_settle', async (event, ctx) => {
      if (!current() || interruptionRequested || ctx.sessionManager !== root!.manager) return;
      // A reception-only first turn may materialize its first conversation in
      // the assistant response, after the provider hook has already run.
      await initializeSending(root!);
      if (!current() || interruptionRequested || ctx.sessionManager !== root!.manager) return;
      const entries = inputAttachment!.beforeSettle();
      if (entries.length > 0) return { entries: [...event.entries, ...entries], continue: true };
    });
    pi.on('agent_settled', event => {
      if (!current()) return;
      runOpen = false;
      // Native session replacement aborts an active run before session_shutdown.
      // Only a user interrupt may cancel pending input as an aborted run.
      if (event.aborted) {
        if (!interruptionRequested) return;
        interruptionRequested = false;
      }
      inputAttachment!.settled(event.aborted);
    });
    pi.on('session_before_compact', event => {
      if (current() && !runOpen) {
        standaloneCompaction = { reason: event.reason, signal: event.signal, interrupted: false, completed: false };
      }
    });
    pi.on('session_compact', event => {
      if (!current()) return;
      if (standaloneCompaction?.reason === event.reason) standaloneCompaction.completed = true;
      inputAttachment!.operationFinished();
    });
    pi.on('session_compact_failed', event => {
      if (!current()) return;
      if (standaloneCompaction?.reason === event.reason) standaloneCompaction = undefined;
      // Standalone compaction has no agent_settled. Its failed event alone
      // cannot prove a user interrupt, because extensions may also cancel it.
      if (event.aborted && interruptionRequested && !runOpen) {
        interruptionRequested = false;
        inputAttachment!.cancelPending();
      } else if (!interruptionRequested) inputAttachment!.operationFinished();
    });
    // Before-events can be cancelled or fail without replacing the root.
    // Invalidate draft work there; retire authority at native shutdown only.
    pi.on('session_before_switch', () => { contacts?.invalidate(); });
    pi.on('session_before_fork', () => { contacts?.invalidate(); });
    pi.on('session_before_tree', () => { contacts?.invalidate(); });
    pi.on('session_shutdown', async (event, ctx) => {
      contacts?.dispose();
      // An unattached reload still leaves the living root's input owner in the
      // registry. Its eventual native teardown must close that retained input.
      let owner = root;
      if (!owner) {
        try { owner = registry.roots.get(ctx.sessionManager); }
        catch { return; }
      }
      if (!owner) return;
      if (event.reason === 'quit') {
        if (owner.lastAttachment === attachment) {
          inputAttachment?.cancelPending();
          owner.input.cancelPending();
        }
        await endRoot(owner);
        return;
      }
      if (event.reason === 'reload' && owner.reusable) {
        await stopRoot(owner, 'pause');
      } else {
        await endRoot(owner);
      }
    });

    pi.registerTool({
      name: 'arlo_list_sessions', label: 'Arlo sessions',
      description: 'List other online, ready root sessions in this communication group. Use the full endpoint_id to address a session.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, args, _signal, _update, ctx) {
        const owner = caller(ctx);
        return { content: await owner.runtime!.listSessions(owner, args), details: {} };
      },
    });
    pi.registerTool({
      name: 'arlo_send_message', label: 'Send Arlo message',
      description: 'Send text to one full endpoint from arlo_list_sessions or an @arlo:<host>:<full-endpoint> mention in the current prompt, only when asked to send. accepted means queued, not read or completed. unknown must not trigger an automatic resend. To reply, use the received message_id as reply_to and its from_endpoint as to.',
      parameters: Type.Object({
        to: Type.String({ description: 'Full endpoint ID; never a display name or short ID.' }),
        text: Type.String({ description: 'Message body, at most 32 KiB of UTF-8.' }),
        reply_to: Type.Optional(Type.String({ description: 'Original inbound message ID for an associated reply.' })),
      }, { additionalProperties: false }),
      async execute(_id, args, _signal, _update, ctx) {
        const owner = caller(ctx);
        // Pi saves an assistant tool call before executing it. A fresh root
        // first woken by reception can now prove its initial durable history.
        await initializeSending(owner);
        caller(ctx);
        return { content: await owner.runtime!.sendMessage(owner, args), details: {} };
      },
    });
    pi.registerTool({
      name: 'arlo_get_message_status', label: 'Arlo reception status',
      description: 'Query reception metadata for a message this root sent. This reports acceptance, never task completion.',
      parameters: Type.Object({ message_id: Type.String() }, { additionalProperties: false }),
      async execute(_id, args, _signal, _update, ctx) {
        const owner = caller(ctx);
        return { content: await owner.runtime!.getMessageStatus(owner, args), details: {} };
      },
    });
  };
}
