import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { recordProbeEvidence } from './evidence.ts';
import {
  ARLO_MESSAGE_ID_META_KEY,
  createArloToolServer,
  callArloSendMessage,
  ArloProtocolErrorCode,
  RootBindingRegistry,
} from './mcp-metadata.ts';

test('root session identity survives MCP session rotation and every request requires its bound session', () => {
  const registry = new RootBindingRegistry();
  registry.registerRoot({
    endpointId: 'endpoint-A', rootEndpoint: 'endpoint-A', rootSessionId: 'host-session-A',
    generation: 1, credentialToken: 'fictional-token-A', sessionId: 'mcp-session-A',
  });
  const first = registry.validateRequest({ credentialToken: 'fictional-token-A', sessionId: 'mcp-session-A' });
  assert.equal(first.rootSessionId, 'host-session-A');
  assert.equal(first.sessionId, 'mcp-session-A');
  for (const sessionId of [undefined, '', 'host-session-A', 'mcp-session-B']) {
    assert.throws(() => registry.validateRequest({ credentialToken: 'fictional-token-A', sessionId }), /BINDING_MISMATCH/);
  }
  registry.advanceGeneration('endpoint-A', {
    generation: 2, credentialToken: 'fictional-token-A2', sessionId: 'mcp-session-A2',
  });
  const rotated = registry.validateRequest({ credentialToken: 'fictional-token-A2', sessionId: 'mcp-session-A2' });
  assert.equal(rotated.rootSessionId, 'host-session-A');
  assert.equal(rotated.sessionId, 'mcp-session-A2');
  assert.throws(() => registry.validateRequest({ credentialToken: 'fictional-token-A', sessionId: 'mcp-session-A' }), /STALE_GENERATION/);
  recordProbeEvidence('rootSessionBinding', { rootSessionId: rotated.rootSessionId, mcpSessionId: rotated.sessionId, generation: rotated.generation });
});

test('Seam 2.1: params._meta separates arlo/message-id from model arguments and rejects argument injection', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  let recordedMeta: Record<string, unknown> | undefined;
  let recordedArgs: Record<string, unknown> | undefined;

  const server = createArloToolServer({
    onSendMessage: (meta, args) => {
      recordedMeta = meta;
      recordedArgs = args;
      return { status: 'accepted', message_id: meta[ARLO_MESSAGE_ID_META_KEY] as string };
    },
  });

  const client = new Client(
    { name: 'test-root-client', version: '0.1.0' },
    { capabilities: {} }
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  // 1. Valid invocation via callArloSendMessage
  const result = await callArloSendMessage(client, {
    to: 'ep-receiver',
    text: 'hello receiver',
    reply_to: 'msg-parent-0',
  }, 'msg-client-generated-1234');

  assert.equal(result.status, 'accepted');
  assert.equal(result.message_id, 'msg-client-generated-1234');
  assert.deepEqual(recordedMeta, { [ARLO_MESSAGE_ID_META_KEY]: 'msg-client-generated-1234' });
  assert.deepEqual(recordedArgs, {
    to: 'ep-receiver',
    text: 'hello receiver',
    reply_to: 'msg-parent-0',
  });
  // Verify that arguments do not contain _meta or internal identity
  assert.equal((recordedArgs as any)?._meta, undefined);
  assert.equal((recordedArgs as any)?.from, undefined);
  assert.equal((recordedArgs as any)?.group, undefined);

  // 2. Model tries to inject _meta inside arguments -> INVALID_ARGUMENT
  await assert.rejects(
    async () => {
      await client.request({
        method: 'tools/call',
        params: {
          name: 'arlo_send_message',
          arguments: {
            to: 'ep-receiver',
            text: 'malicious injection',
            _meta: { 'arlo/message-id': 'forged-id' },
          },
          _meta: { [ARLO_MESSAGE_ID_META_KEY]: 'valid-meta-id' },
        },
      });
    },
    (err: any) => {
      return err.message?.includes(ArloProtocolErrorCode.INVALID_ARGUMENT);
    }
  );

  // 3. Model tries to inject identity 'from' or 'group' inside arguments -> INVALID_ARGUMENT
  for (const forbiddenKey of ['from', 'group_id', 'group', 'sender', 'daemon_id']) {
    await assert.rejects(
      async () => {
        await client.request({
          method: 'tools/call',
          params: {
            name: 'arlo_send_message',
            arguments: {
              to: 'ep-receiver',
              text: 'trying to spoof sender',
              [forbiddenKey]: 'ep-spoofed',
            },
            _meta: { [ARLO_MESSAGE_ID_META_KEY]: 'msg-valid-567' },
          },
        });
      },
      (err: any) => {
        return err.message?.includes(ArloProtocolErrorCode.INVALID_ARGUMENT);
      }
    );
  }

  // 4. Missing _meta['arlo/message-id'] -> INVALID_ARGUMENT
  await assert.rejects(
    async () => {
      await client.request({
        method: 'tools/call',
        params: {
          name: 'arlo_send_message',
          arguments: {
            to: 'ep-receiver',
            text: 'missing meta container',
          },
        },
      });
    },
    (err: any) => {
      return err.message?.includes(ArloProtocolErrorCode.INVALID_ARGUMENT);
    }
  );

  await client.close();
  await server.close();
});

test('Seam 2.2: Root identity and MCP session cross-reuse defense with distinct error taxonomy', () => {
  const registry = new RootBindingRegistry();

  // Register Root A at generation 1
  registry.registerRoot({
    rootEndpoint: 'root-ep-A',
    generation: 1,
    credentialToken: 'token-root-A-gen1',
    sessionId: 'mcp-session-A',
  });

  // Register Root B at generation 1
  registry.registerRoot({
    rootEndpoint: 'root-ep-B',
    generation: 1,
    credentialToken: 'token-root-B-gen1',
    sessionId: 'mcp-session-B',
  });

  // 1. Valid authentication for Root A
  const authA = registry.validateRequest({
    credentialToken: 'token-root-A-gen1',
    sessionId: 'mcp-session-A',
  });
  assert.equal(authA.rootEndpoint, 'root-ep-A');
  assert.equal(authA.generation, 1);

  // 2. Missing credential token (session ID is NOT a credential) -> UNAUTHORIZED
  assert.throws(
    () => registry.validateRequest({ credentialToken: undefined, sessionId: 'mcp-session-A' }),
    (err: any) => err.message?.startsWith(ArloProtocolErrorCode.UNAUTHORIZED)
  );

  // 3. Unknown credential token -> UNAUTHORIZED
  assert.throws(
    () => registry.validateRequest({ credentialToken: 'unknown-token', sessionId: 'mcp-session-A' }),
    (err: any) => err.message?.startsWith(ArloProtocolErrorCode.UNAUTHORIZED)
  );

  // 4. Root B's valid credentials with Root A's MCP Session -> BINDING_MISMATCH
  assert.throws(
    () => registry.validateRequest({ credentialToken: 'token-root-B-gen1', sessionId: 'mcp-session-A' }),
    (err: any) => err.message?.startsWith(ArloProtocolErrorCode.BINDING_MISMATCH)
  );

  // 5. Stale generation token after generation bump -> STALE_GENERATION
  registry.advanceGeneration('root-ep-A', 2, 'token-root-A-gen2', 'mcp-session-A-new');

  assert.throws(
    () => registry.validateRequest({ credentialToken: 'token-root-A-gen1', sessionId: 'mcp-session-A' }),
    (err: any) => err.message?.startsWith(ArloProtocolErrorCode.STALE_GENERATION)
  );

  // New generation token succeeds
  const authA2 = registry.validateRequest({
    credentialToken: 'token-root-A-gen2',
    sessionId: 'mcp-session-A-new',
  });
  assert.equal(authA2.rootEndpoint, 'root-ep-A');
  assert.equal(authA2.generation, 2);
});
