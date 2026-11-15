import https from 'node:https';
import { Readable } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { createPinnedHttpsAgent } from './transport-tls.ts';

export interface TlsObservation { protocol: string | null; resumed: boolean }

// MCP's public fetch option needs streaming responses: buffering an SSE response
// would prevent notifications from reaching the host until the connection closes.
// This adapter deliberately supports only the SDK's string request bodies.
export function createPinnedFetch(cert: string, onAuthenticated: (event: TlsObservation) => void = () => {}) {
  const agent = createPinnedHttpsAgent(cert);
  const fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (url.protocol !== 'https:') throw new Error('HTTPS_REQUIRED');
    if (!['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('LOOPBACK_LITERAL_REQUIRED');
    }
    if (init.body != null && typeof init.body !== 'string') throw new Error('UNSUPPORTED_REQUEST_BODY');
    init.signal?.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const request = https.request(url, {
        agent, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)),
      }, response => {
        const status = response.statusCode!;
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new Error(`REDIRECT_FORBIDDEN:${status}`));
          return;
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
          else if (value !== undefined) headers.set(key, value);
        }
        const noBody = init.method === 'HEAD' || [204, 205, 304].includes(status);
        if (noBody) response.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }));
      });
      const abort = () => request.destroy(new Error('REQUEST_ABORTED'));
      init.signal?.addEventListener('abort', abort, { once: true });
      request.on('close', () => init.signal?.removeEventListener('abort', abort));
      request.on('error', reject);
      request.on('socket', socket => {
        socket.once('secureConnect', () => {
          const tlsSocket = socket as TLSSocket;
          onAuthenticated({ protocol: tlsSocket.getProtocol(), resumed: tlsSocket.isSessionReused() });
        });
      });
      // Node buffers these bytes until TLS authentication has succeeded.
      request.end(init.body ?? undefined);
    });
  };
  return { fetch, close: () => agent.destroy() };
}
