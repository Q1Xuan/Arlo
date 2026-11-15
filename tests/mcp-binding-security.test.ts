import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArloDaemon } from '@arlo/daemon';
import {
  ArloErrorCode,
  ControlClient,
  createPinnedHttpsAgent,
  sendSecureArloRequest,
  readDiscoveryRecord,
} from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

test('MCP transport verifies root token, endpoint, generation, and MCP session binding with strict defense', async () => {
  const stateDir = createTempDir('mcp-security');
  const daemon = new ArloDaemon({ stateDir });

  try {
    const { port } = await daemon.start();
    const control = new ControlClient({ stateDir, port });
    const discovery = readDiscoveryRecord(stateDir);
    const agent = createPinnedHttpsAgent(discovery.cert_pem, { minVersion: 'TLSv1.2', disableSessionResumption: true });
    const mcpUrl = `https://127.0.0.1:${port}/mcp`;

    const rt = await control.registerRuntime({ host_type: 'deepseek-harness' });
    const rootA = await control.registerRoot(rt.runtime_token, {
      root_session_id: 'host-sess-a',
      group_name: 'group-alpha',
      agent_incarnation: 'inc-a',
      plugin_generation: 1,
    });
    const rootB = await control.registerRoot(rt.runtime_token, {
      root_session_id: 'host-sess-b',
      group_name: 'group-alpha',
      agent_incarnation: 'inc-b',
      plugin_generation: 1,
    });

    // 0. Wire revision negotiation defense: incompatible revision rejected
    const badWireRes = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: rootA.root_token,
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-client', version: '0.1' } },
      }),
    });
    assert.equal(badWireRes.status, 400);
    const badWireJson = JSON.parse(badWireRes.body);
    assert.match(badWireJson.error?.message, /UNSUPPORTED_VERSION/);

    // 1. Initialize MCP for Root A
    const initResA = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: rootA.root_token,
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '0.1' } },
      }),
    });
    assert.equal(initResA.status, 200);
    const sessA = initResA.headers['mcp-session-id'] as string;
    assert.ok(sessA, 'MCP session ID must be returned on initialize');
    const initJsonA = JSON.parse(initResA.body);
    assert.equal(initJsonA.result?.protocolVersion, '2025-06-18');
    assert.deepEqual(initJsonA.result?.capabilities?.experimental?.['arlo/session-messaging'], { version: '0.1' });

    // Initialize MCP for Root B
    const initResB = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: rootB.root_token,
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client-b', version: '0.1' } },
      }),
    });
    assert.equal(initResB.status, 200);
    const sessB = initResB.headers['mcp-session-id'] as string;
    assert.ok(sessB);
    assert.notEqual(sessA, sessB);

    // 2. Cannot authorize solely on MCP Session ID
    // Missing Authorization header
    const noAuth = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      method: 'POST',
      headers: { 'mcp-session-id': sessA },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    assert.equal(noAuth.status, 401);

    // Invalid token with valid mcp-session-id
    const badToken = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: 'bad-token-1234',
      method: 'POST',
      headers: { 'mcp-session-id': sessA },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    assert.equal(badToken.status, 401);

    // Post-initialization request omitting mcp-session-id header is rejected
    const omitSessHeader = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: rootA.root_token,
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/list', params: {} }),
    });
    assert.equal(omitSessHeader.status, 403);
    assert.equal(JSON.parse(omitSessHeader.body).error, ArloErrorCode.BINDING_MISMATCH);

    // 3. Cross-root session mismatch (rootA's token with rootB's session)
    const crossMatch = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: rootA.root_token,
      method: 'POST',
      headers: { 'mcp-session-id': sessB },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    });
    assert.equal(crossMatch.status, 403);
    const crossJson = JSON.parse(crossMatch.body);
    assert.equal(crossJson.error, ArloErrorCode.BINDING_MISMATCH);

    // 3b. Endpoint ID mismatch header check
    const epMismatch = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: rootA.root_token,
      method: 'POST',
      headers: { 'mcp-session-id': sessA, 'x-arlo-endpoint-id': rootB.endpoint_id },
      body: JSON.stringify({ jsonrpc: '2.0', id: 51, method: 'tools/list', params: {} }),
    });
    assert.equal(epMismatch.status, 403);
    assert.equal(JSON.parse(epMismatch.body).error, ArloErrorCode.BINDING_MISMATCH);

    // 3c. Stale generation header check
    const genMismatch = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: rootA.root_token,
      method: 'POST',
      headers: { 'mcp-session-id': sessA, 'x-arlo-generation': '999' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 52, method: 'tools/list', params: {} }),
    });
    assert.equal(genMismatch.status, 403);
    assert.equal(JSON.parse(genMismatch.body).error, ArloErrorCode.STALE_GENERATION);

    // 4. Stale generation token defense
    const connA = await control.connectRoot(rootA.root_token, { endpoint_id: rootA.endpoint_id });
    assert.equal(connA.generation, 2);

    // Using generation 1 token now fails with STALE_GENERATION
    const staleReq = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: rootA.root_token, // Old token!
      method: 'POST',
      headers: { 'mcp-session-id': sessA },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }),
    });
    assert.equal(staleReq.status, 403);
    const staleJson = JSON.parse(staleReq.body);
    assert.equal(staleJson.error, ArloErrorCode.STALE_GENERATION);

    // Calling tools/list on uninitialized new generation fails because initialize is required first
    const uninitCall = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: connA.root_token,
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 61, method: 'tools/list', params: {} }),
    });
    assert.equal(uninitCall.status, 400);

    // Initialize new generation for Root A
    const initResA2 = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: connA.root_token,
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 62,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '0.1' } },
      }),
    });
    assert.equal(initResA2.status, 200);
    const sessA2 = initResA2.headers['mcp-session-id'] as string;
    assert.ok(sessA2);

    // 5. Model tools surface separation
    // tools/list must NOT contain control methods (e.g. register, revoke, connect)
    const listRes = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: connA.root_token,
      method: 'POST',
      headers: { 'mcp-session-id': sessA2 },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
    });
    assert.equal(listRes.status, 200);
    const listJson = JSON.parse(listRes.body);
    const toolNames = (listJson.result?.tools ?? []).map((t: any) => t.name);
    assert.ok(toolNames.includes('arlo_list_sessions'));
    assert.ok(!toolNames.includes('register_root'));
    assert.ok(!toolNames.includes('revoke_root'));
    assert.ok(!toolNames.includes('connect_root'));
    assert.ok(!toolNames.includes('register_runtime'));

    // 6. Model tool calling & argument rejection
    // Argument injection: forbidden argument properties must be rejected
    const injectRes = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: connA.root_token,
      method: 'POST',
      headers: { 'mcp-session-id': sessA2 },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'arlo_list_sessions',
          arguments: {
            from: 'ep-hacked',
            group_id: 'fake-group',
          },
        },
      }),
    });
    assert.equal(injectRes.status, 200);
    const injectJson = JSON.parse(injectRes.body);
    assert.equal(injectJson.result?.isError, true, 'HTTP success must not hide the rejected tool call');
    assert.match(injectJson.result?.content?.[0]?.text, /INVALID_ARGUMENT/);

    // In this slice, arlo_list_sessions returns empty list because active reception is not yet ready
    const validCall = await sendSecureArloRequest({
      url: mcpUrl,
      agent,
      token: connA.root_token,
      method: 'POST',
      headers: { 'mcp-session-id': sessA2 },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'arlo_list_sessions',
          arguments: {},
        },
      }),
    });
    assert.equal(validCall.status, 200);
    const validJson = JSON.parse(validCall.body);
    const contentText = validJson.result?.content?.[0]?.text;
    assert.deepEqual(JSON.parse(contentText), []);
  } finally {
    await daemon.stop();
    removeTempDir(stateDir);
  }
});
