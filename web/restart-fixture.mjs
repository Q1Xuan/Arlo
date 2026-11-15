import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';

// Test-only observer and local model. The ordinary Web composer submits the
// prompt; this plugin never fabricates a Host event or a Arlo registration.
export const name = 'arlo-uninstalled-web-observer';
export const inject = ['agents', 'llm', 'sessionController', 'workspaceController', 'configEditor'];

export function apply(ctx) {
  const token = randomBytes(24).toString('hex');
  const sessionId = SessionId('arlo-web-after-uninstall');
  const requests = [];
  const errors = [];
  class LocalModel extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'scripted', name: 'Isolated ordinary model after uninstall' }]; }
    async *stream(options) {
      requests.push({ sessionId: String(options.sessionId), provider: options.provider, model: options.model,
        messages: structuredClone(options.messages), tools: (options.tools ?? []).map(tool => tool.name) });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Ordinary local work succeeds after Arlo uninstall.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ordinary local work succeeds after Arlo uninstall.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['arlo-web-local', 'arlo-web-configured'], new LocalModel());
  const snapshot = () => ({ sessionId, requests, errors,
    plugins: ctx.configEditor.configuration().map(item => ({ id: item.entry.id, name: item.entry.options.name })),
    roots: ctx.agents.roots().map(agent => ({ id: agent.id, status: agent.status })),
    runtime: { executable: process.execPath, node: process.version, platform: process.platform } });
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end('{}'); return; }
    if (request.method === 'GET' && request.url === '/state') { response.end(JSON.stringify(snapshot())); return; }
    if (request.method === 'POST' && request.url === '/stop') {
      assert.ok(ctx.appExit, 'The ordinary launcher owns shutdown');
      response.end('{"ok":true}');
      setImmediate(() => ctx.appExit(0));
      return;
    }
    response.writeHead(404).end('{}');
  });
  const unsubscribe = ctx.appReady.onReady(() => {
    void (async () => {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const { workspace } = await ctx.workspaceController.create({ path: process.cwd() });
      await ctx.sessionController.create({ sessionId, workspaceId: workspace.workspaceId });
      await ctx.sessionController.selectModel({ sessionId, provider: 'arlo-web-local', model: 'scripted' });
      await writeFile(process.env.ARLO_WEB_FIXTURE_REPORT, JSON.stringify({ ready: true, token,
        controlUrl: `http://127.0.0.1:${server.address().port}`, ...snapshot() }));
    })().catch(async error => {
      errors.push(error.stack ?? String(error));
      await writeFile(process.env.ARLO_WEB_FIXTURE_REPORT, JSON.stringify({ ready: false, errors }));
    });
  });
  ctx.effect(() => () => { unsubscribe(); server.closeAllConnections(); server.close(); });
}
