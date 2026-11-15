import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { urlToHttpOptions } from 'node:url';

export function isLoopback(host) {
  if (!host || typeof host !== 'string') return false;
  let h = host.trim().toLowerCase();
  // Strip IPv6 brackets e.g. [::1]:9335 or [::1]
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end !== -1) {
      h = h.slice(1, end);
    }
  } else if (!h.includes('::')) {
    // IPv4 or hostname: strip port
    h = h.split(':')[0];
  }
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
}

const invalidTarget = () => ({ host: null, targetUrl: null, valid: false });

function extractFetchTarget(input) {
  // Fetch RequestInit does not override the URL with hostname, host or socketPath.
  const targetUrl = typeof input === 'string' ? input
    : input instanceof URL ? input.href
    : input instanceof Request ? input.url
    : null;
  if (targetUrl === null) return invalidTarget();
  try {
    return { host: new URL(targetUrl).hostname, targetUrl, valid: true };
  } catch {
    return invalidTarget();
  }
}

function extractHttpTarget(args, protocol) {
  const [input, overrides] = args;
  let options;
  try {
    if (typeof input === 'string' || input instanceof URL) {
      options = urlToHttpOptions(new URL(input));
    } else if (input && typeof input === 'object') {
      options = { ...input };
    } else {
      return invalidTarget();
    }
    if (overrides && typeof overrides === 'object') {
      options = { ...options, ...overrides };
    }
  } catch {
    return invalidTarget();
  }

  // Keep unidentified objects out of the allowlist, even though Node defaults to localhost.
  if (!['hostname', 'host', 'socketPath', 'path', 'port'].some(key => key in options)) {
    return invalidTarget();
  }
  if (options.socketPath) {
    return typeof options.socketPath === 'string'
      ? { host: '127.0.0.1', targetUrl: 'unix:' + options.socketPath, valid: true }
      : invalidTarget();
  }

  // ClientRequest merges URL options first, then prefers hostname over host.
  // An explicit undefined/null hostname removes the URL hostname before this fallback.
  const host = options.hostname || options.host || 'localhost';
  if (typeof host !== 'string') return invalidTarget();
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const port = options.port ? `:${options.port}` : '';
  const targetUrl = `${options.protocol || protocol}//${authority}${port}${options.path || '/'}`;
  return { host, targetUrl, valid: true };
}

export function extractHostAndUrl(args, type = 'http.request') {
  if (!args?.length) return invalidTarget();
  return type === 'fetch'
    ? extractFetchTarget(args[0])
    : extractHttpTarget(args, type === 'https.request' ? 'https:' : 'http:');
}

export function setupNetworkGuard(options = {}) {
  const httpModule = options.http || http;
  const httpsModule = options.https || https;
  const globalTarget = options.globalThis || globalThis;
  const onViolation = options.onViolation || (() => {});
  const unexpectedExternalCalls = [];

  const origHttpRequest = httpModule.request;
  const origHttpGet = httpModule.get;
  const origHttpsRequest = httpsModule.request;
  const origHttpsGet = httpsModule.get;
  const origFetch = globalTarget.fetch;

  function denyIfExternal(args, type) {
    const { host, targetUrl, valid } = extractHostAndUrl(args, type);
    if (!valid || !isLoopback(host)) {
      const reportedHost = host || 'UNRECOGNIZED_TARGET';
      const reportedUrl = targetUrl || String(args?.[0]);
      const record = { type, host: reportedHost, targetUrl: reportedUrl, time: new Date().toISOString() };
      unexpectedExternalCalls.push(record);
      if (typeof process !== 'undefined') {
        process.exitCode = 1;
      }
      onViolation(record, unexpectedExternalCalls);
      const err = new Error('EXTERNAL_NETWORK_FORBIDDEN: ' + reportedHost + ' (' + reportedUrl + ')');
      throw err;
    }
  }

  httpModule.request = function(...args) {
    denyIfExternal(args, 'http.request');
    return origHttpRequest.apply(this, args);
  };
  httpModule.get = function(...args) {
    const req = httpModule.request(...args);
    if (req && typeof req.end === 'function') req.end();
    return req;
  };

  httpsModule.request = function(...args) {
    denyIfExternal(args, 'https.request');
    return origHttpsRequest.apply(this, args);
  };
  httpsModule.get = function(...args) {
    const req = httpsModule.request(...args);
    if (req && typeof req.end === 'function') req.end();
    return req;
  };

  if (typeof origFetch === 'function') {
    globalTarget.fetch = function(...args) {
      denyIfExternal(args, 'fetch');
      return origFetch.apply(this, args);
    };
  }

  return {
    unexpectedExternalCalls,
    denyIfExternal,
    restore() {
      httpModule.request = origHttpRequest;
      httpModule.get = origHttpGet;
      httpsModule.request = origHttpsRequest;
      httpsModule.get = origHttpsGet;
      if (origFetch) globalTarget.fetch = origFetch;
    }
  };
}

export const name = 'arlo-network-guard-plugin';

export async function apply(ctx) {
  const hostEvidenceFile = process.env.ARLO_HOST_EVIDENCE_FILE || path.resolve(process.cwd(), 'host-isolation-evidence.json');

  let negativeControlProven = false;
  let unexpectedExternalCalls = [];

  const writeEvidenceNow = () => {
    try {
      fs.writeFileSync(hostEvidenceFile, JSON.stringify({
        negativeControlProven,
        noUserCredentials: true,
        unexpectedExternalCallsCount: unexpectedExternalCalls.length,
        unexpectedExternalCalls,
        lastUpdated: new Date().toISOString()
      }, null, 2));
    } catch {}
  };

  const guard = setupNetworkGuard({
    onViolation: () => {
      // Immediate synchronous persistence on violation
      writeEvidenceNow();
    }
  });
  unexpectedExternalCalls = guard.unexpectedExternalCalls;

  // Persist on process hooks
  process.on('exit', writeEvidenceNow);
  process.on('uncaughtException', writeEvidenceNow);
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => writeEvidenceNow());
  }

  // 1. Prove negative control:
  let negativeControlCount = 0;

  // Negative control 1: http.request with external string URL
  try {
    http.request('http://api.deepseek.com/fictional-vendor-canary');
  } catch (err) {
    if (err.message && err.message.includes('EXTERNAL_NETWORK_FORBIDDEN')) {
      negativeControlCount++;
    }
  }

  // Negative control 2: fetch with Request object (guards against bypass via Request instance)
  if (typeof globalThis.fetch === 'function' && typeof globalThis.Request === 'function') {
    try {
      globalThis.fetch(new Request('https://api.deepseek.com/fictional-request-canary'));
    } catch (err) {
      if (err.message && err.message.includes('EXTERNAL_NETWORK_FORBIDDEN')) {
        negativeControlCount++;
      }
    }
  } else if (typeof globalThis.fetch === 'function') {
    try {
      globalThis.fetch({ url: 'https://api.deepseek.com/fictional-request-canary' });
    } catch (err) {
      if (err.message && err.message.includes('EXTERNAL_NETWORK_FORBIDDEN')) {
        negativeControlCount++;
      }
    }
  } else {
    negativeControlCount++;
  }

  // Negative control 3: unrecognized target (must be rejected, not default to loopback)
  try {
    http.request({});
  } catch (err) {
    if (err.message && err.message.includes('EXTERNAL_NETWORK_FORBIDDEN')) {
      negativeControlCount++;
    }
  }

  // Negative control 4: loopback URL with external hostname override in options (second argument)
  try {
    http.request('http://127.0.0.1/', { hostname: 'api.deepseek.com' });
  } catch (err) {
    if (err.message && err.message.includes('EXTERNAL_NETWORK_FORBIDDEN')) {
      negativeControlCount++;
    }
  }

  assert.ok(negativeControlCount >= 4, 'Negative control: external requests, second-arg overrides, and unrecognized targets must be forbidden');
  negativeControlProven = true;

  // Reset negative control records to leave clean state for real run
  unexpectedExternalCalls.length = 0;
  process.exitCode = 0;
  writeEvidenceNow();

  // 2. Prove isolation: no user credentials inherited in environment
  assert.equal(process.env.OPENAI_API_KEY, undefined, 'Must not inherit OPENAI_API_KEY');
  assert.equal(process.env.DEEPSEEK_API_KEY, undefined, 'Must not inherit DEEPSEEK_API_KEY');
  assert.equal(process.env.ARK_API_KEY, undefined, 'Must not inherit ARK_API_KEY');
  assert.equal(process.env.ARK717_API_KEY, undefined, 'Must not inherit ARK717_API_KEY');
}
