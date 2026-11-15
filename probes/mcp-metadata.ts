import type { Client } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { ARLO_PROTOCOL_OPTIONS } from './mcp-notification.ts';

export const ARLO_MESSAGE_ID_META_KEY = 'arlo/message-id';

export const ArloProtocolErrorCode = {
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  BINDING_MISMATCH: 'BINDING_MISMATCH',
  STALE_GENERATION: 'STALE_GENERATION',
  CALLER_NOT_ROOT: 'CALLER_NOT_ROOT',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  UNSUPPORTED_PROFILE: 'UNSUPPORTED_PROFILE',
  CHANNEL_NOT_READY: 'CHANNEL_NOT_READY',
  RATE_LIMITED: 'RATE_LIMITED',
  QUEUE_LIMIT: 'QUEUE_LIMIT',
  STALE_SEQUENCE: 'STALE_SEQUENCE',
  REPLAY_RESULT_UNAVAILABLE: 'REPLAY_RESULT_UNAVAILABLE',
  RECEIPT_CONFLICT: 'RECEIPT_CONFLICT',
} as const;

export type ArloProtocolErrorCode = typeof ArloProtocolErrorCode[keyof typeof ArloProtocolErrorCode];

export interface ArloSendMessageArgs {
  [key: string]: unknown;
  to: string;
  text: string;
  reply_to?: string;
}

export interface ArloSendMessageResult {
  status: 'accepted' | 'rejected' | 'unknown';
  message_id: string;
  reason?: string;
}

const FORBIDDEN_ARGUMENT_KEYS = new Set([
  '_meta',
  'from',
  'group',
  'group_id',
  'sender',
  'daemon_id',
  'credentials',
  'target_generation',
]);

export function callArloSendMessage(
  client: Client,
  args: ArloSendMessageArgs,
  messageId: string
): Promise<ArloSendMessageResult> {
  return client.callTool(
    {
      name: 'arlo_send_message',
      arguments: args as Record<string, unknown>,
      _meta: {
        [ARLO_MESSAGE_ID_META_KEY]: messageId,
      },
    } as any
  ).then(res => {
    const textContent = (res as any)?.content?.[0]?.text;
    if (textContent) {
      try {
        return JSON.parse(textContent);
      } catch {
        // fallback
      }
    }
    return { status: 'accepted', message_id: messageId };
  });
}

export interface ToolServerOptions {
  onSendMessage?: (
    meta: Record<string, unknown>,
    args: Record<string, unknown>
  ) => ArloSendMessageResult | Promise<ArloSendMessageResult>;
}

export function createArloToolServer(options: ToolServerOptions = {}): Server {
  const server = new Server(
    { name: 'arlo-tool-server', version: '0.1.0' },
    { capabilities: { tools: {} }, ...ARLO_PROTOCOL_OPTIONS }
  );

  server.setRequestHandler('tools/call' as any, async (request: any) => {
    const { name, arguments: args, _meta } = request.params ?? {};

    if (name === 'arlo_send_message') {
      // 1. Verify standard request _meta container
      if (!_meta || typeof _meta !== 'object') {
        throw new Error(`${ArloProtocolErrorCode.INVALID_ARGUMENT}: missing standard request _meta container`);
      }
      const messageId = _meta[ARLO_MESSAGE_ID_META_KEY];
      if (typeof messageId !== 'string' || !messageId) {
        throw new Error(`${ArloProtocolErrorCode.INVALID_ARGUMENT}: _meta must contain non-empty string ${ARLO_MESSAGE_ID_META_KEY}`);
      }

      // 2. Verify model arguments
      if (!args || typeof args !== 'object') {
        throw new Error(`${ArloProtocolErrorCode.INVALID_ARGUMENT}: missing arguments`);
      }
      for (const forbiddenKey of FORBIDDEN_ARGUMENT_KEYS) {
        if (forbiddenKey in args) {
          throw new Error(`${ArloProtocolErrorCode.INVALID_ARGUMENT}: forbidden argument property "${forbiddenKey}"`);
        }
      }
      if (typeof args.to !== 'string' || !args.to) {
        throw new Error(`${ArloProtocolErrorCode.INVALID_ARGUMENT}: "to" argument must be a non-empty string`);
      }
      if (typeof args.text !== 'string' || !args.text) {
        throw new Error(`${ArloProtocolErrorCode.INVALID_ARGUMENT}: "text" argument must be a non-empty string`);
      }
      if (args.reply_to !== undefined && typeof args.reply_to !== 'string') {
        throw new Error(`${ArloProtocolErrorCode.INVALID_ARGUMENT}: "reply_to" argument must be a string if present`);
      }

      const result = options.onSendMessage
        ? await options.onSendMessage(_meta, args)
        : { status: 'accepted' as const, message_id: messageId };

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }

    throw new Error(`Method not found: ${name}`);
  });

  return server;
}

export interface RootBindingCredentials {
  generation: number;
  credentialToken: string;
  sessionId: string;
}

export interface RootBinding {
  endpointId?: string;
  rootSessionId?: string;
  rootEndpoint: string;
  generation: number;
  credentialToken: string;
  sessionId: string;
}

export interface AuthenticatedRootSession {
  endpointId: string;
  rootSessionId: string;
  rootEndpoint: string;
  generation: number;
  sessionId: string;
}

export class RootBindingRegistry {
  private activeBindings = new Map<string, RootBinding>();
  private tokenToBinding = new Map<string, RootBinding>();
  private staleTokens = new Set<string>();

  registerRoot(binding: RootBinding): void {
    const endpointId = binding.endpointId || binding.rootEndpoint;
    const rootSessionId = binding.rootSessionId || binding.sessionId;
    const normalized: RootBinding = {
      ...binding,
      endpointId,
      rootSessionId,
      rootEndpoint: endpointId,
      sessionId: binding.sessionId,
    };
    this.activeBindings.set(endpointId, normalized);
    this.tokenToBinding.set(binding.credentialToken, normalized);
  }

  advanceGeneration(
    rootEndpoint: string,
    credentialsOrGen: RootBindingCredentials | number,
    newToken?: string,
    newSessionId?: string
  ): void {
    const old = this.activeBindings.get(rootEndpoint);
    if (old) {
      this.tokenToBinding.delete(old.credentialToken);
      this.staleTokens.add(old.credentialToken);
    }
    let gen: number;
    let token: string;
    let sess: string;
    if (typeof credentialsOrGen === 'object') {
      gen = credentialsOrGen.generation;
      token = credentialsOrGen.credentialToken;
      sess = credentialsOrGen.sessionId;
    } else {
      gen = credentialsOrGen;
      token = newToken!;
      sess = newSessionId!;
    }
    const updated: RootBinding = {
      endpointId: rootEndpoint,
      rootEndpoint,
      generation: gen,
      credentialToken: token,
      sessionId: sess,
      rootSessionId: old?.rootSessionId ?? sess,
    };
    this.activeBindings.set(rootEndpoint, updated);
    this.tokenToBinding.set(token, updated);
  }

  validateRequest(request: { credentialToken?: string; sessionId?: string }): AuthenticatedRootSession {
    if (!request.credentialToken) {
      throw new Error(`${ArloProtocolErrorCode.UNAUTHORIZED}: missing authentication credential`);
    }

    if (this.staleTokens.has(request.credentialToken)) {
      throw new Error(`${ArloProtocolErrorCode.STALE_GENERATION}: credential belongs to stale connection generation`);
    }

    const binding = this.tokenToBinding.get(request.credentialToken);
    if (!binding) {
      throw new Error(`${ArloProtocolErrorCode.UNAUTHORIZED}: invalid credential token`);
    }

    // The transport session is distinct from the stable host session identity.
    // Omitting it must not bypass the binding check.
    if (!request.sessionId || binding.sessionId !== request.sessionId) {
      throw new Error(`${ArloProtocolErrorCode.BINDING_MISMATCH}: root credentials do not match MCP session binding`);
    }

    return {
      endpointId: binding.endpointId || binding.rootEndpoint,
      rootSessionId: binding.rootSessionId || binding.sessionId,
      rootEndpoint: binding.rootEndpoint,
      generation: binding.generation,
      sessionId: binding.sessionId,
    };
  }
}
