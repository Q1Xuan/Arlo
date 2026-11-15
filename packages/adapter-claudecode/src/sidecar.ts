import {
  createAdapterRuntime,
  createParticipationSettings,
  participationScope,
  readParticipationPreference,
  type AdapterHost,
} from '@arlo/adapter-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { ControlClient, enforceWindowsAcl, ArloError, ArloErrorCode, resolveStateDir, type RootSendingStatus } from '@arlo/sdk';
import { ensureSharedDaemon } from '@arlo/daemon/shared';
import {
  bridgeBootstrapPath,
  liveSessionPath,
  publishActiveBridgeBootstrap,
  publishLiveSession,
  removeBridgeBootstrap,
} from './bridge-bootstrap.ts';
import { BridgeRequestError, CLAUDE_CODE_VERSION, generateBridgeToken } from './contract.ts';
import { ClaudeCodeBridgeServer } from './bridge-server.ts';
import { ClaudeCodeReceptionHost } from './reception-host.ts';

function sendingStatusText(status: RootSendingStatus): string {
  return [
    'Arlo dispatch attempts', status.root_configuration.guidance, `Mode: ${status.mode}`, `Period: ${status.period_id ?? 'unknown'}`,
    `Usage: ${status.knowledge}`, `Granted: ${status.granted ?? 'unknown'}`, `Used: ${status.used ?? 'unknown'}`,
    `Remaining: ${status.mode === 'continuous' ? 'unlimited' : status.remaining ?? 'unknown'}`,
    `Next grant: ${status.next_grant}`, `Pause reason: ${status.pause_reason ?? 'none'}`,
    `Rules problem: ${status.rules_error ?? 'none'}`,
    ...(status.initial_allowance ? [
      `Initial allowance: ${status.initial_allowance.eligibility} (${status.initial_allowance.reason})`,
      status.initial_allowance.guidance,
    ] : []),
  ].join('\n');
}

export interface ClaudeCodeSidecarOptions {
  sessionId: string;
  /** Stable id from process launch. Context switches keep bootstrap files under this id. */
  launchSessionId?: string;
  token?: string;
  port?: number;
  host?: string;
  stateDir?: string;
  groupName?: string;
  crossHostEnabled?: boolean;
  settingsPath?: string;
  cwd?: string;
  controlClient?: ControlClient;
  autoStart?: boolean;
}

interface ClaudeCodeRoot {
  sessionId: string;
  cwd?: string;
  receptionHost: ClaudeCodeReceptionHost;
}

export class ClaudeCodeSidecar {
  readonly token: string;
  readonly storageDir: string;
  readonly launchSessionId: string;
  readonly bootstrapPath: string;
  private readonly liveSessionFile: string;
  readonly bridgeServer: ClaudeCodeBridgeServer;
  readonly host: AdapterHost<ClaudeCodeRoot>;
  runtime?: ReturnType<typeof createAdapterRuntime<ClaudeCodeRoot>>;
  private root: ClaudeCodeRoot;
  private readonly settingsPath: string;
  private settings?: ReturnType<typeof createParticipationSettings>;
  private readonly createdListeners = new Set<(root: ClaudeCodeRoot) => void>();
  private readonly disposedListeners = new Set<(root: ClaudeCodeRoot) => void>();
  private active = false;
  private ready = false;
  private started = false;
  private stopped = false;
  private starting?: Promise<{ url: string; port: number; token: string }>;
  private stopping?: Promise<void>;

  constructor(options: ClaudeCodeSidecarOptions) {
    if (!options.sessionId) throw new Error('sessionId is required for ClaudeCodeSidecar');
    this.token = options.token || generateBridgeToken();
    this.storageDir = resolveStateDir(options.stateDir);
    this.launchSessionId = options.launchSessionId ?? options.sessionId;
    this.bootstrapPath = bridgeBootstrapPath(this.storageDir, this.launchSessionId);
    this.liveSessionFile = liveSessionPath(this.storageDir, this.launchSessionId);
    this.settingsPath = options.settingsPath ?? path.join(this.storageDir, 'claudecode', 'arlo.json');
    const scope = participationScope(this.settingsPath);
    if (options.crossHostEnabled !== undefined && typeof options.crossHostEnabled !== 'boolean') {
      throw new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Cross-host participation must be a boolean');
    }
    // A launch option supplies the first preference only. Later launches must
    // preserve the human's saved setting, including a concurrent first save.
    if (options.crossHostEnabled !== undefined && !fs.existsSync(this.settingsPath)) {
      const directory = path.dirname(this.settingsPath);
      const created = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (created) enforceWindowsAcl(created, true);
      try {
        fs.writeFileSync(this.settingsPath, JSON.stringify({ crossHostEnabled: options.crossHostEnabled }) + '\n',
          { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const crossHostEnabled = readParticipationPreference(this.settingsPath);

    this.root = this.createRoot(options.sessionId, options.cwd);

    this.bridgeServer = new ClaudeCodeBridgeServer({
      sessionId: this.sessionId,
      token: this.token,
      port: options.port ?? 0,
      host: options.host || '127.0.0.1',
      receptionHost: this.receptionHost,
      onHandshake: () => this.activateRoot(),
      onRetire: () => this.retireRoot(),
      onActivate: sessionId => this.replaceRoot(sessionId),
      onCommand: async (request, identity) => {
        const root = this.root;
        const runtime = this.runtime;
        if (!this.active || this.stopped || !runtime || root.sessionId !== identity.sessionId) {
          throw new BridgeRequestError(409, 'CONFLICT', 'Bridge context has no active root');
        }
        if (request.name === 'arlo-root-config') {
          const status = await runtime.getRootConfiguration(root);
          return { text: [
            'Arlo root configuration', `Current root authenticated: ${status.root_authenticated}`,
            `Configuration ID: ${status.config_id ?? 'Unavailable'}`, `Configuration location: ${status.config_path}`,
            `Ownership: ${status.ownership} (${status.reason})`, `Historical first eligibility: ${status.history}`,
            status.guidance,
          ].join('\n') };
        }
        if (request.name === 'arlo-settings') {
          const status = request.arguments === '' ? await this.settings!.refresh()
            : await this.settings!.set(request.arguments === 'on');
          return { text: `Cross-host communication: ${status.effective ? 'on' : 'off'}` };
        }
        if (['arlo-authorize', 'arlo-continue'].includes(request.name) && !request.operationId) {
          throw new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'The Mod must provide a stable human action identity.');
        }
        const status = request.name === 'arlo-authorize'
          ? await runtime.authorizeRoot(root, request.operationId)
          : request.name === 'arlo-continue'
          ? await runtime.continueCollaboration(root, request.operationId)
          : request.name === 'arlo-reload-sending-rules' ? await runtime.reloadSendingRules(root)
          : await runtime.getRootSendingStatus(root);
        return { text: sendingStatusText(status) };
      },
      onToolCall: (request, identity) => {
        // Capture the actual live root synchronously. Model arguments never
        // select the caller, and an awaited call cannot adopt a later root.
        const root = this.root;
        const runtime = this.runtime;
        if (!this.active || this.stopped || !runtime || root.sessionId !== identity.sessionId) {
          throw new BridgeRequestError(409, 'CONFLICT', 'Bridge context has no active root');
        }
        switch (request.name) {
          case 'arlo_list_sessions': return runtime.listSessions(root, request.arguments);
          case 'arlo_send_message': return runtime.sendMessage(root, request.arguments);
          case 'arlo_get_message_status': return runtime.getMessageStatus(root, request.arguments);
        }
      },
    });

    this.host = {
      roots: () => (this.active ? [this.root] : []),
      sessionId: (r) => r.sessionId,
      sessionCwd: (r) => r.cwd,
      reception: (r) => r.receptionHost.endpointReception,
      onCreated: (listener) => {
        this.createdListeners.add(listener);
        return () => {
          this.createdListeners.delete(listener);
        };
      },
      onDisposed: (listener) => {
        this.disposedListeners.add(listener);
        return () => {
          this.disposedListeners.delete(listener);
        };
      },
    };

    this.resetReady();

    this.runtime = createAdapterRuntime<ClaudeCodeRoot>({
      host: this.host,
      hostType: 'claudecode',
      hostKind: 'claudecode',
      hostVersion: CLAUDE_CODE_VERSION,
      crossHostEnabled,
      participationScope: scope,
      groupName: options.groupName,
      stateDir: this.storageDir,
      controlClient: options.controlClient,
      autoStart: options.autoStart ?? options.controlClient === undefined,
      startSharedDaemon: ensureSharedDaemon,
      onReady: (root, ready) => {
        if (root !== this.root || !this.active || this.stopped) return;
        this.ready = ready;
        if (ready) {
          this.resolveReady();
          void this.settings?.refresh().catch(() => {});
        }
      },
    });
  }

  private readyPromise!: Promise<void>;
  private resolveReady: () => void = () => {};

  get sessionId(): string {
    return this.root.sessionId;
  }

  get receptionHost(): ClaudeCodeReceptionHost {
    return this.root.receptionHost;
  }

  private createRoot(sessionId: string, cwd?: string): ClaudeCodeRoot {
    return { sessionId, cwd, receptionHost: new ClaudeCodeReceptionHost({ sessionId, storageDir: this.storageDir }) };
  }

  private resetReady(): void {
    this.readyPromise = new Promise(resolve => { this.resolveReady = resolve; });
  }

  private retireRoot(): void {
    const wasActive = this.active;
    this.active = false;
    this.ready = false;
    this.resetReady();
    try {
      this.receptionHost.retire();
    } finally {
      if (wasActive) for (const listener of this.disposedListeners) listener(this.root);
    }
  }

  private async replaceRoot(sessionId: string): Promise<ClaudeCodeReceptionHost> {
    if (this.stopped || !this.started || this.active) throw new Error('Sidecar cannot activate a context');
    // A failed retirement must be repaired before any later activation can
    // reopen that session's durable input, including a resume of the same ID.
    this.receptionHost.retire();
    publishLiveSession(this.liveSessionFile, sessionId);
    const next = this.createRoot(sessionId, this.root.cwd);
    await next.receptionHost.recover();
    if (this.stopped || !this.started) {
      next.receptionHost.retire();
      throw new Error('Sidecar is stopped');
    }
    this.root = next;
    this.resetReady();
    this.publishBootstrap();
    this.activateRoot();
    return next.receptionHost;
  }

  private activateRoot(): void {
    if (this.stopped || !this.started) throw new Error('Sidecar is not accepting a Mod handshake');
    if (this.active) return;
    this.settings ??= createParticipationSettings({ configPath: this.settingsPath,
      prepare: () => {
        if (!this.ready) throw new ArloError(ArloErrorCode.CHANNEL_NOT_READY);
        return this.runtime!.prepareParticipationUpdate();
      } });
    this.active = true;
    for (const listener of this.createdListeners) listener(this.root);
    void this.settings.refresh().catch(() => {});
  }

  async waitForReady(timeoutMs = 10000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for ClaudeCodeSidecar to become ready`));
      }, timeoutMs);
    });
    try {
      await Promise.race([this.readyPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  get url(): string {
    return this.bridgeServer.url;
  }

  get port(): number {
    return this.bridgeServer.port;
  }

  start(): Promise<{ url: string; port: number; token: string }> {
    if (this.stopped) return Promise.reject(new Error('Sidecar is stopped'));
    return this.starting ??= this.startBridge();
  }

  private async startBridge(): Promise<{ url: string; port: number; token: string }> {
    await this.receptionHost.recover();
    if (this.stopped) throw new Error('Sidecar is stopped');
    await this.bridgeServer.start();
    if (this.stopped) throw new Error('Sidecar is stopped');
    publishLiveSession(this.liveSessionFile, this.sessionId);
    this.publishBootstrap();
    this.started = true;
    return {
      url: this.bridgeServer.url,
      port: this.bridgeServer.port,
      token: this.token,
    };
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.started = false;
    this.settings?.dispose();
    let retirementError: unknown;
    try { this.retireRoot(); } catch (error) { retirementError = error; }
    const bridgeStopping = this.bridgeServer.stop();
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      try {
        await this.runtime?.dispose();
      } finally {
        await bridgeStopping;
      }
      if (retirementError) throw retirementError;
      removeBridgeBootstrap(this.bootstrapPath);
    })();
    return this.stopping;
  }

  private publishBootstrap(): void {
    publishActiveBridgeBootstrap(this.bootstrapPath, {
      sessionId: this.sessionId,
      url: this.bridgeServer.url,
      token: this.token,
      instanceId: this.bridgeServer.instanceId,
    });
  }
}

