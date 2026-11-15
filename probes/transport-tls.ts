import https from 'node:https';
import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { isLoopback } from './gui-network-guard.mjs';

export interface PinnedAgentOptions {
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  disableSessionResumption?: boolean;
}

export function createPinnedHttpsAgent(
  pinnedCertPem: string,
  options: PinnedAgentOptions = {}
): https.Agent {
  const x509 = new crypto.X509Certificate(pinnedCertPem);
  const pinnedFingerprint = crypto.createHash('sha256').update(x509.raw).digest('hex');

  return new https.Agent({
    ca: [pinnedCertPem],
    rejectUnauthorized: true,
    minVersion: options.minVersion ?? 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    maxCachedSessions: options.disableSessionResumption !== false ? 0 : 100,
    checkServerIdentity(_hostname, cert) {
      const serverFingerprint = crypto.createHash('sha256').update(cert.raw).digest('hex');
      if (serverFingerprint !== pinnedFingerprint) {
        const err = new Error(
          `PINNED_CERT_MISMATCH: server certificate fingerprint ${serverFingerprint} does not match pinned ${pinnedFingerprint}`
        );
        (err as any).code = 'ERR_TLS_CERT_ALTNAME_INVALID';
        throw err;
      }
      return undefined;
    },
  });
}

export interface SecureRequestOptions {
  url: string;
  agent: https.Agent;
  token?: string;
  body?: string;
  method?: string;
  headers?: Record<string, string>;
}

export interface SecureResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  negotiatedProtocol?: string;
  sessionReused?: boolean;
}

export function sendSecureArloRequest(options: SecureRequestOptions): Promise<SecureResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    if (url.protocol !== 'https:') {
      return reject(new Error('INVALID_ARGUMENT: Arlo transport strictly requires HTTPS'));
    }
    if (!isLoopback(url.hostname)) {
      return reject(new Error(`EXTERNAL_NETWORK_FORBIDDEN: ${url.hostname} is not loopback`));
    }

    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
    };
    if (options.token) {
      headers['authorization'] = `Bearer ${options.token}`;
    }
    if (options.body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(options.body));
    }

    let negotiatedProtocol: string | undefined;
    let sessionReused: boolean | undefined;

    const req = https.request(
      url,
      {
        method: options.method ?? (options.body ? 'POST' : 'GET'),
        agent: options.agent,
        headers,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        // Verify no redirects (301, 302, 307, 308) are followed
        if ([301, 302, 307, 308].includes(statusCode)) {
          res.resume();
          return reject(
            new Error(`REDIRECT_FORBIDDEN: redirects are not permitted for Arlo endpoints (received HTTP ${statusCode})`)
          );
        }

        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status: statusCode,
            headers: res.headers,
            body: data,
            negotiatedProtocol,
            sessionReused,
          });
        });
      }
    );

    req.on('socket', (socket) => {
      socket.on('secureConnect', () => {
        const tlsSocket = socket as TLSSocket;
        negotiatedProtocol = tlsSocket.getProtocol() || undefined;
        sessionReused = typeof tlsSocket.isSessionReused === 'function' ? tlsSocket.isSessionReused() : false;
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}
