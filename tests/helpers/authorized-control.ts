import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ControlClient as ProductionControlClient, ArloErrorCode, ArloError, ARLO_MESSAGE_ID_META_KEY,
  createPinnedHttpsAgent, readDiscoveryRecord, sendSecureArloRequest,
  type ControlClientOptions, type RootRegistrationResponse,
  type RootRegistrationOptions, type RootConfigurationEvidence,
  type ArloSendMessageArgs, type ArloSendMessageResult,
} from '@arlo/sdk';

/** Existing receipt/capacity/pacing fixtures represent a human-authorized
 * collaboration. They use a real durable root artifact and the public trusted
 * continue command. Long budget regressions explicitly model another human
 * command after twenty attempts; autonomous allowance tests use the production
 * ControlClient directly and must never import this fixture. */
export class AuthorizedControlClient extends ProductionControlClient {
  private readonly fixtureStateDir: string;
  private readonly roots = new Map<string, RootRegistrationResponse>();
  private readonly artifacts = new Map<string, string>();
  private readonly renewals = new Map<string, Promise<void>>();
  private readonly authorized = new Set<string>();
  private readonly requests = new Map<string, RootRegistrationOptions>();
  private readonly sendRequestTimeoutMs?: number;
  private rootEvidence?: (root: RootRegistrationOptions) => Promise<RootConfigurationEvidence | undefined>;

  constructor(options: ControlClientOptions & { stateDir: string;
    sendRequestTimeoutMs?: number;
    rootEvidence?: (root: RootRegistrationOptions) => Promise<RootConfigurationEvidence | undefined> }) {
    super(options);
    this.fixtureStateDir = options.stateDir;
    this.rootEvidence = options.rootEvidence;
    this.sendRequestTimeoutMs = options.sendRequestTimeoutMs;
  }

  get stateDirectory(): string { return this.fixtureStateDir; }

  setRootEvidence(provider: (root: RootRegistrationOptions) => Promise<RootConfigurationEvidence | undefined>): void {
    this.rootEvidence = provider;
  }

  override async registerRuntime(options: Parameters<ProductionControlClient['registerRuntime']>[0] = {}) {
    // Preserve explicit classifications and the documented legacy DSH mapping.
    return super.registerRuntime(options.host_kind === undefined && options.host_type === undefined
      ? { ...options, host_kind: 'test.fixture' } : options);
  }

  override async registerRoot(...args: Parameters<ProductionControlClient['registerRoot']>) {
    const root = await super.registerRoot(...args);
    const name = crypto.createHash('sha256').update(args[1].root_session_id).digest('hex');
    const artifact = path.join(this.fixtureStateDir, `authorized-root-${name}.jsonl`);
    // The same logical root keeps its physical artifact. Duplicate active
    // owners are rejected by the daemon rather than silently sharing grants.
    if (!fs.existsSync(artifact)) fs.writeFileSync(artifact, `fixture-root:${name}\n`);
    this.artifacts.set(root.endpoint_id, artifact);
    this.roots.set(root.endpoint_id, root);
    this.requests.set(root.endpoint_id, args[1]);
    return root;
  }

  override async connectRoot(...args: Parameters<ProductionControlClient['connectRoot']>) {
    const connected = await super.connectRoot(...args);
    const root = this.roots.get(connected.endpoint_id);
    if (root) {
      const current = { ...root, ...connected };
      this.roots.set(current.endpoint_id, current);
      // The next business send represents the fixture user's explicit command
      // after lost continuity. Receiving-only roots need no sending grant.
      if (args[1].continuity_token === undefined) this.authorized.delete(current.endpoint_id);
    }
    return connected;
  }

  override createRootConnection(...args: Parameters<ProductionControlClient['createRootConnection']>) {
    const connection = super.createRootConnection(...args);
    // Authenticate discovery once per connection, just as the production SDK
    // does. Repeating synchronous OS ACL inspection for each outstanding ACK
    // would stall the very transport window this fixture is observing.
    const requestDiscovery = this.sendRequestTimeoutMs === undefined ? undefined : readDiscoveryRecord(this.fixtureStateDir);
    const send = this.sendRequestTimeoutMs === undefined ? connection.sendMessage.bind(connection)
      : async (message: ArloSendMessageArgs, messageId?: string): Promise<ArloSendMessageResult> => {
        // Daemon capacity tests keep ACKs outstanding while several real human
        // grants commit. Use the SDK's public pinned HTTPS request with an
        // explicit fixture wait; normal SDK transport deadlines remain intact.
        const discovery = requestDiscovery!;
        const agent = createPinnedHttpsAgent(discovery.cert_pem);
        let response;
        try {
          response = await sendSecureArloRequest({ url: `https://127.0.0.1:${discovery.port}/mcp`,
            agent, method: 'POST', token: connection.binding.root_token,
            headers: { 'x-arlo-endpoint-id': connection.binding.endpoint_id,
              'x-arlo-generation': String(connection.binding.generation),
              'mcp-session-id': connection.sessionId! }, timeoutMs: this.sendRequestTimeoutMs,
            body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call',
              params: { name: 'arlo_send_message', arguments: message,
                _meta: { [ARLO_MESSAGE_ID_META_KEY]: messageId ?? crypto.randomUUID() } } }) });
        } finally { agent.destroy(); }
        const result = JSON.parse(response.body).result;
        const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
        if (result.isError) {
          const code = Object.values(ArloErrorCode).find(value => text === value || text.startsWith(`${value}:`));
          throw new ArloError(code ?? ArloErrorCode.CORRUPTED_STATE, text);
        }
        return JSON.parse(text) as ArloSendMessageResult;
      };
    connection.sendMessage = async (...messageArgs) => {
      const endpointId = connection.binding.endpoint_id;
      if (!this.authorized.has(endpointId)) await this.userContinue(connection.binding, false);
      for (;;) {
        try { return await send(...messageArgs); }
        catch (error) {
          if ((error as { code?: string }).code !== ArloErrorCode.ALLOWANCE_EXHAUSTED) throw error;
          await this.userContinue(connection.binding, true);
        }
      }
    };
    return connection;
  }

  private async userContinue(root: RootRegistrationResponse, exhausted: boolean): Promise<void> {
    let renewal = this.renewals.get(root.endpoint_id);
    if (!renewal) {
      renewal = this.authorize(root, exhausted);
      this.renewals.set(root.endpoint_id, renewal);
    }
    try {
      await renewal;
      this.authorized.add(root.endpoint_id);
    } finally {
      if (this.renewals.get(root.endpoint_id) === renewal) this.renewals.delete(root.endpoint_id);
    }
  }

  /** Complete the fixture user's durable authorization during setup, before a
   * receipt regression starts its notification/ACK observation deadline. */
  async fixtureAuthorize(root: RootRegistrationResponse): Promise<void> {
    await this.userContinue(root, false);
  }

  async fixtureSendingStatus(root: RootRegistrationResponse) {
    return this.getRootSendingStatus(root.root_token, await this.sendingRequest(root));
  }

  private async sendingRequest(root: RootRegistrationResponse) {
    const artifact = this.artifacts.get(root.endpoint_id);
    if (!artifact) throw new Error('Missing durable fixture root artifact');
    const evidence = this.rootEvidence ? await this.rootEvidence(this.requests.get(root.endpoint_id)!)
      : { kind: 'session-file' as const, session_file: artifact };
    return { endpoint_id: root.endpoint_id, generation: root.generation,
      ...(evidence ? { evidence } : {}) };
  }

  private async authorize(root: RootRegistrationResponse, exhausted: boolean): Promise<void> {
    const request = await this.sendingRequest(root);
    let status = await this.getRootSendingStatus(root.root_token, request);
    if (status.root_configuration.reason === 'AUTHORIZATION_REQUIRED') {
      await this.authorizeRoot(root.root_token, { ...request, request_id: crypto.randomUUID() });
      status = await this.getRootSendingStatus(root.root_token, request);
    }
    // Unknown host classifications are intentional in participation negatives;
    // they cannot prove ownership and receive no implicit fixture authority.
    if (status.root_configuration.reason === 'EVIDENCE_UNAVAILABLE') return;
    if (!['verified', 'user-authorized'].includes(status.root_configuration.ownership)) {
      throw new Error(`Fixture root ownership failed: ${status.root_configuration.reason}`);
    }
    if (status.knowledge === 'unknown' || exhausted && status.remaining === 0) {
      await this.continueCollaboration(root.root_token, { ...request, daemon_id: status.daemon_id,
        request_id: crypto.randomUUID(), sequence: status.control_sequence + 1 });
    }
  }
}
