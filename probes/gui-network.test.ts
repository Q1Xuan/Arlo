import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { urlToHttpOptions } from 'node:url';
import { extractHostAndUrl, isLoopback, setupNetworkGuard } from './gui-network-guard.mjs';
import type { NetworkViolationRecord } from './gui-network-guard.mjs';

test('HTTP guard agrees with native hostname precedence in both directions', () => {
  const cases = [
    { url: 'http://api.deepseek.com/', options: { host: '127.0.0.1' }, host: 'api.deepseek.com', blocked: true },
    { url: 'http://127.0.0.1/', options: { host: 'api.deepseek.com' }, host: '127.0.0.1', blocked: false },
    { url: 'http://127.0.0.1/', options: { hostname: 'api.deepseek.com' }, host: 'api.deepseek.com', blocked: true },
    { url: 'http://api.deepseek.com/', options: { hostname: '127.0.0.1' }, host: '127.0.0.1', blocked: false },
    { url: 'http://127.0.0.1/', options: { hostname: undefined, host: 'api.deepseek.com' }, host: 'api.deepseek.com', blocked: true },
  ];
  for (const item of cases) {
    // Let Node resolve the destination without opening a socket or doing DNS.
    const agent = new http.Agent();
    let nativeHost: string | null | undefined;
    agent.createConnection = options => {
      nativeHost = options.host;
      return new net.Socket();
    };
    const request = new http.ClientRequest({ ...urlToHttpOptions(new URL(item.url)), ...item.options, agent });
    request.on('error', () => {});
    request.destroy();
    agent.destroy();
    assert.equal(nativeHost, item.host);

    let forwarded = false;
    const transport = {
      request: (..._args: any[]) => { forwarded = true; return { end() {} }; },
      get: (..._args: any[]) => ({ end() {} }),
    };
    const previousExitCode = process.exitCode;
    const guard = setupNetworkGuard({ http: transport });
    try {
      if (item.blocked) {
        assert.throws(() => transport.request(item.url, item.options), /EXTERNAL_NETWORK_FORBIDDEN/);
        assert.equal(guard.unexpectedExternalCalls[0]?.host, nativeHost);
        assert.equal(process.exitCode, 1);
      } else {
        transport.request(item.url, item.options);
        assert.equal(guard.unexpectedExternalCalls.length, 0);
      }
      assert.equal(forwarded, !item.blocked);
    } finally {
      guard.restore();
      process.exitCode = previousExitCode;
    }
  }
});

test('fetch uses its Request URL and ignores HTTP-only destination options', () => {
  const initializers = [
    { hostname: '127.0.0.1', method: 'GET' },
    { host: '127.0.0.1', method: 'GET' },
    { socketPath: '/fictional/local.sock', method: 'GET' },
  ];
  let forwarded = 0;
  const transport = { fetch: (..._args: any[]) => { forwarded++; return Promise.resolve('fictional response'); } };
  const previousExitCode = process.exitCode;
  const guard = setupNetworkGuard({ globalThis: transport });
  try {
    for (const init of initializers) {
      for (const input of ['https://api.deepseek.com/canary', new Request('https://api.deepseek.com/canary')]) {
        assert.equal(new URL(new Request(input, init).url).hostname, 'api.deepseek.com');
        assert.throws(() => transport.fetch(input, init), /EXTERNAL_NETWORK_FORBIDDEN: api\.deepseek\.com/);
      }
    }
    assert.equal(forwarded, 0);
    assert.equal(guard.unexpectedExternalCalls.length, 6);
    assert.equal(process.exitCode, 1);
    transport.fetch('http://127.0.0.1/canary', { hostname: 'api.deepseek.com' });
    assert.equal(forwarded, 1);
    assert.equal(guard.unexpectedExternalCalls.length, 6);
  } finally {
    guard.restore();
    process.exitCode = previousExitCode;
  }
});

test('extractHostAndUrl supports Request objects, string URLs, and rejects unrecognized targets', () => {
  // 1. Strings
  assert.deepEqual(extractHostAndUrl(['https://api.deepseek.com/chat/completions']), {
    host: 'api.deepseek.com',
    targetUrl: 'https://api.deepseek.com/chat/completions',
    valid: true
  });
  assert.deepEqual(extractHostAndUrl(['http://127.0.0.1:9335/json/list']), {
    host: '127.0.0.1',
    targetUrl: 'http://127.0.0.1:9335/json/list',
    valid: true
  });

  // 2. URL instance
  assert.deepEqual(extractHostAndUrl([new URL('https://api.deepseek.com/v1')]), {
    host: 'api.deepseek.com',
    targetUrl: 'https://api.deepseek.com/v1',
    valid: true
  });

  // 3. WHATWG Request instance (P1 issue 3)
  const reqExternal = new Request('https://api.deepseek.com/fictional-vendor');
  const extractedExternal = extractHostAndUrl([reqExternal], 'fetch');
  assert.equal(extractedExternal.valid, true);
  assert.equal(extractedExternal.host, 'api.deepseek.com');
  assert.equal(extractedExternal.targetUrl, 'https://api.deepseek.com/fictional-vendor');

  const reqLoopback = new Request('http://127.0.0.1:9335/cdp');
  const extractedLoopback = extractHostAndUrl([reqLoopback], 'fetch');
  assert.equal(extractedLoopback.valid, true);
  assert.equal(extractedLoopback.host, '127.0.0.1');

  // 4. Arbitrary objects are not native Request inputs.
  assert.equal(extractHostAndUrl([{ url: 'https://vendor.example/api' }], 'fetch').valid, false);

  // 5. Options object for http.request
  assert.deepEqual(extractHostAndUrl([{ hostname: '127.0.0.1', port: 9335 }]), {
    host: '127.0.0.1',
    targetUrl: 'http://127.0.0.1:9335/',
    valid: true
  });
  assert.deepEqual(extractHostAndUrl([{ socketPath: '/tmp/socket.sock' }]), {
    host: '127.0.0.1',
    targetUrl: 'unix:/tmp/socket.sock',
    valid: true
  });

  // 6. Node parameter merging (URL + options 2nd arg override)
  assert.deepEqual(extractHostAndUrl(['http://127.0.0.1/', { hostname: 'api.deepseek.com' }]), {
    host: 'api.deepseek.com',
    targetUrl: 'http://api.deepseek.com/',
    valid: true
  });
  assert.deepEqual(extractHostAndUrl(['http://127.0.0.1/', { host: 'api.deepseek.com' }]), {
    host: '127.0.0.1',
    targetUrl: 'http://127.0.0.1/',
    valid: true
  });
  assert.deepEqual(extractHostAndUrl(['http://127.0.0.1/', { host: 'api.deepseek.com:8443', port: 8443 }]), {
    host: '127.0.0.1',
    targetUrl: 'http://127.0.0.1:8443/',
    valid: true
  });
  assert.deepEqual(extractHostAndUrl(['http://127.0.0.1:9335/json', { hostname: 'api.deepseek.com', port: 443, path: '/v1/chat' }]), {
    host: 'api.deepseek.com',
    targetUrl: 'http://api.deepseek.com:443/v1/chat',
    valid: true
  });
  assert.deepEqual(extractHostAndUrl([new URL('http://127.0.0.1/'), { hostname: 'api.deepseek.com' }]), {
    host: 'api.deepseek.com',
    targetUrl: 'http://api.deepseek.com/',
    valid: true
  });
  assert.deepEqual(extractHostAndUrl(['http://127.0.0.1:9335/json', { method: 'GET' }]), {
    host: '127.0.0.1',
    targetUrl: 'http://127.0.0.1:9335/json',
    valid: true
  });
  assert.deepEqual(extractHostAndUrl(['http://127.0.0.1:9335/json', () => {}]), {
    host: '127.0.0.1',
    targetUrl: 'http://127.0.0.1:9335/json',
    valid: true
  });
  assert.deepEqual(extractHostAndUrl(['http://127.0.0.1:9335/json', { socketPath: '/tmp/test.sock' }]), {
    host: '127.0.0.1',
    targetUrl: 'unix:/tmp/test.sock',
    valid: true
  });

  // 7. Unrecognized / unparseable targets (must be invalid, host null)
  assert.equal(extractHostAndUrl([{ invalidKey: 'none' }]).valid, false);
  assert.equal(extractHostAndUrl([{}]).valid, false);
  assert.equal(extractHostAndUrl([]).valid, false);
  assert.equal(extractHostAndUrl([null]).valid, false);
});

test('isLoopback strictly permits only loopback and rejects unparseable or external hosts', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('127.0.0.1:9335'), true);
  assert.equal(isLoopback('localhost'), true);
  assert.equal(isLoopback('localhost:8080'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('[::1]:9335'), true);
  assert.equal(isLoopback('0.0.0.0'), true);

  // Must reject null, undefined, empty, or external hosts
  assert.equal(isLoopback(null), false);
  assert.equal(isLoopback(undefined), false);
  assert.equal(isLoopback(''), false);
  assert.equal(isLoopback('api.deepseek.com'), false);
  assert.equal(isLoopback('example.invalid'), false);
});

test('setupNetworkGuard catches fetch(Request), unrecognized targets, and immediately flushes evidence', () => {
  const testEvidenceFile = path.join(process.cwd(), 'evidence-guard-unit-' + Date.now() + '.json');

  const passedThrough: Array<{ type: string; args: any[] }> = [];
  const mockHttp = {
    request: (...args: any[]) => { passedThrough.push({ type: 'http', args }); return { end: () => {} }; },
    get: (...args: any[]) => { passedThrough.push({ type: 'get', args }); return { end: () => {} }; }
  };
  const mockHttps = {
    request: (...args: any[]) => { passedThrough.push({ type: 'https', args }); return { end: () => {} }; },
    get: (...args: any[]) => { passedThrough.push({ type: 'https-get', args }); return { end: () => {} }; }
  };
  const mockGlobal = {
    fetch: (...args: any[]) => { passedThrough.push({ type: 'fetch', args }); return Promise.resolve('ok'); }
  };

  const origExitCode = process.exitCode;
  try {
    const violationEvents: NetworkViolationRecord[] = [];
    const guard = setupNetworkGuard({
      http: mockHttp,
      https: mockHttps,
      globalThis: mockGlobal,
      onViolation: (record: NetworkViolationRecord, list: NetworkViolationRecord[]) => {
        violationEvents.push(record);
        // Immediate synchronous flush to disk
        fs.writeFileSync(testEvidenceFile, JSON.stringify({
          unexpectedExternalCallsCount: list.length,
          unexpectedExternalCalls: list
        }, null, 2));
      }
    });

    // 1. Loopback fetch should pass through
    mockGlobal.fetch('http://127.0.0.1:9335/json');
    assert.equal(passedThrough.length, 1);
    assert.equal(guard.unexpectedExternalCalls.length, 0);

    // 2. Loopback fetch with Request should pass through
    mockGlobal.fetch(new Request('http://localhost:9335/app'));
    assert.equal(passedThrough.length, 2);
    assert.equal(guard.unexpectedExternalCalls.length, 0);

    // 3. External fetch with Request MUST be intercepted and denied (P1 issue 3)
    assert.throws(
      () => mockGlobal.fetch(new Request('https://api.deepseek.com/chat/completions')),
      /EXTERNAL_NETWORK_FORBIDDEN: api\.deepseek\.com/
    );
    assert.equal(process.exitCode, 1);
    assert.equal(guard.unexpectedExternalCalls.length, 1);
    assert.equal(violationEvents.length, 1);

    // Verify immediate persistence to disk (P1 issue 1)
    assert.ok(fs.existsSync(testEvidenceFile), 'Evidence file must be written immediately upon violation');
    const flushed1 = JSON.parse(fs.readFileSync(testEvidenceFile, 'utf8'));
    assert.equal(flushed1.unexpectedExternalCallsCount, 1);
    assert.equal(flushed1.unexpectedExternalCalls[0].host, 'api.deepseek.com');

    // 4. Unrecognized target MUST be intercepted and denied (P1 issue 3)
    assert.throws(
      () => mockGlobal.fetch({ unparseable: true }),
      /EXTERNAL_NETWORK_FORBIDDEN: UNRECOGNIZED_TARGET/
    );
    assert.equal(guard.unexpectedExternalCalls.length, 2);
    const flushed2 = JSON.parse(fs.readFileSync(testEvidenceFile, 'utf8'));
    assert.equal(flushed2.unexpectedExternalCallsCount, 2);

    // 5. External http.request MUST be intercepted and denied
    assert.throws(
      () => mockHttp.request('http://api.deepseek.com/vendor'),
      /EXTERNAL_NETWORK_FORBIDDEN: api\.deepseek\.com/
    );
    assert.equal(guard.unexpectedExternalCalls.length, 3);
    const flushed3 = JSON.parse(fs.readFileSync(testEvidenceFile, 'utf8'));
    assert.equal(flushed3.unexpectedExternalCallsCount, 3);

    guard.restore();
  } finally {
    process.exitCode = origExitCode;
    try { fs.rmSync(testEvidenceFile, { force: true }); } catch {}
  }
});

test('issue 1 repro fix: immediate evidence flush prevents killed process from hiding failure', () => {
  const testEvidenceFile = path.join(process.cwd(), 'evidence-guard-repro1-' + Date.now() + '.json');

  // Initial zero-state evidence
  fs.writeFileSync(testEvidenceFile, JSON.stringify({
    negativeControlProven: true,
    noUserCredentials: true,
    unexpectedExternalCallsCount: 0,
    unexpectedExternalCalls: []
  }, null, 2));

  const origExitCode = process.exitCode;
  try {
    const mockGlobal = { fetch: (..._args: any[]) => Promise.resolve('ok') };
    const guard = setupNetworkGuard({
      globalThis: mockGlobal,
      onViolation: (_record: NetworkViolationRecord, list: NetworkViolationRecord[]) => {
        // Immediate synchronous flush before error is thrown / process killed
        fs.writeFileSync(testEvidenceFile, JSON.stringify({
          negativeControlProven: true,
          noUserCredentials: true,
          unexpectedExternalCallsCount: list.length,
          unexpectedExternalCalls: list
        }, null, 2));
      }
    });

    let caughtError: unknown = null;
    try {
      // Simulate external vendor call
      mockGlobal.fetch(new Request('https://api.deepseek.com/chat/completions'));
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, 'External call must throw');
    assert.equal(process.exitCode, 1, 'Process exitCode must be set to 1');
    assert.equal(guard.unexpectedExternalCalls.length, 1);

    // Simulate process killed immediately afterwards without running normal cleanup:
    // Read evidence from disk: must be 1, NOT 0!
    const evidenceOnDisk = JSON.parse(fs.readFileSync(testEvidenceFile, 'utf8'));
    assert.equal(evidenceOnDisk.unexpectedExternalCallsCount, 1, 'Saved evidence must immediately reflect violation count');
    assert.equal(evidenceOnDisk.unexpectedExternalCalls.length, 1);

    // Main test process checks:
    const mainProcessCheck = (evidence: any, childExitCode: number | null) => {
      if (childExitCode !== 0) return 'FAIL_CHILD_EXIT_CODE';
      if (evidence.unexpectedExternalCallsCount !== 0) return 'FAIL_UNEXPECTED_EXTERNAL_CALLS';
      return 'PASS';
    };

    assert.equal(mainProcessCheck(evidenceOnDisk, process.exitCode ?? null), 'FAIL_CHILD_EXIT_CODE');
    assert.equal(mainProcessCheck(evidenceOnDisk, 0), 'FAIL_UNEXPECTED_EXTERNAL_CALLS');

    guard.restore();
  } finally {
    process.exitCode = origExitCode;
    try { fs.rmSync(testEvidenceFile, { force: true }); } catch {}
  }
});

test('issue 2 verification: renderer network filter permits internal schemes and catches external calls', () => {
  function isRendererUrlPermitted(reqUrl: string | null | undefined): boolean {
    if (!reqUrl) return false;
    const isInternalScheme = /^(dsh-app|file|devtools|chrome-extension|data|blob):/i.test(reqUrl);
    if (isInternalScheme) return true;
    const info = extractHostAndUrl([reqUrl], 'fetch');
    return info.valid && isLoopback(info.host);
  }

  // Internal and local schemes must be permitted
  assert.equal(isRendererUrlPermitted('dsh-app://app/index.html'), true);
  assert.equal(isRendererUrlPermitted('file:///C:/path/to/asset.js'), true);
  assert.equal(isRendererUrlPermitted('blob:dsh-app://app/12345'), true);
  assert.equal(isRendererUrlPermitted('data:image/png;base64,...'), true);
  assert.equal(isRendererUrlPermitted('http://127.0.0.1:9335/json'), true);
  assert.equal(isRendererUrlPermitted('http://localhost:9335/cdp'), true);

  // External vendor requests must NOT be permitted
  assert.equal(isRendererUrlPermitted('https://api.deepseek.com/chat/completions'), false);
  assert.equal(isRendererUrlPermitted('http://example.com/analytics'), false);
  assert.equal(isRendererUrlPermitted('https://telemetry.deepseek.com'), false);
  assert.equal(isRendererUrlPermitted(''), false);
  assert.equal(isRendererUrlPermitted(null), false);
  assert.equal(isRendererUrlPermitted(undefined), false);
});

test('Node parameter merging regression: second argument options cannot bypass network guard', () => {
  const testEvidenceFile = path.join(process.cwd(), 'evidence-guard-repro-merge-' + Date.now() + '.json');

  const passedThrough: Array<{ type: string; args: any[] }> = [];
  const mockHttp = {
    request: (...args: any[]) => { passedThrough.push({ type: 'http.request', args }); return { end: () => {} }; },
    get: (...args: any[]) => { passedThrough.push({ type: 'http.get', args }); return { end: () => {} }; }
  };
  const mockHttps = {
    request: (...args: any[]) => { passedThrough.push({ type: 'https.request', args }); return { end: () => {} }; },
    get: (...args: any[]) => { passedThrough.push({ type: 'https.get', args }); return { end: () => {} }; }
  };

  const origExitCode = process.exitCode;
  try {
    const violationEvents: NetworkViolationRecord[] = [];
    const guard = setupNetworkGuard({
      http: mockHttp,
      https: mockHttps,
      onViolation: (record: NetworkViolationRecord, list: NetworkViolationRecord[]) => {
        violationEvents.push(record);
        fs.writeFileSync(testEvidenceFile, JSON.stringify({
          unexpectedExternalCallsCount: list.length,
          unexpectedExternalCalls: list
        }, null, 2));
      }
    });

    // 1. Loopback with harmless options must pass through
    mockHttp.request('http://127.0.0.1:9335/json', { method: 'POST', headers: { 'content-type': 'application/json' } });
    assert.equal(passedThrough.length, 1);
    assert.equal(guard.unexpectedExternalCalls.length, 0);

    // 2. Loopback with callback must pass through
    mockHttp.request('http://127.0.0.1:9335/json', () => {});
    assert.equal(passedThrough.length, 2);
    assert.equal(guard.unexpectedExternalCalls.length, 0);

    // 3. Loopback with localhost override must pass through
    mockHttp.request('http://127.0.0.1:9335/json', { hostname: 'localhost' });
    assert.equal(passedThrough.length, 3);
    assert.equal(guard.unexpectedExternalCalls.length, 0);

    // 4. http.request: Loopback URL with external hostname in options MUST be intercepted and denied
    assert.throws(
      () => mockHttp.request('http://127.0.0.1/', { hostname: 'api.deepseek.com' }),
      /EXTERNAL_NETWORK_FORBIDDEN: api\.deepseek\.com/
    );
    assert.equal(process.exitCode, 1);
    assert.equal(guard.unexpectedExternalCalls.length, 1);
    assert.equal(guard.unexpectedExternalCalls[0].host, 'api.deepseek.com');
    assert.equal(guard.unexpectedExternalCalls[0].targetUrl, 'http://api.deepseek.com/');

    // Evidence file on disk must be immediately updated
    assert.ok(fs.existsSync(testEvidenceFile));
    const evidence1 = JSON.parse(fs.readFileSync(testEvidenceFile, 'utf8'));
    assert.equal(evidence1.unexpectedExternalCallsCount, 1);
    assert.equal(evidence1.unexpectedExternalCalls[0].host, 'api.deepseek.com');

    // 5. The URL hostname wins over options.host, so this remains external.
    assert.throws(
      () => mockHttp.request('http://api.deepseek.com/', { host: '127.0.0.1' }),
      /EXTERNAL_NETWORK_FORBIDDEN: api\.deepseek\.com/
    );
    assert.equal(guard.unexpectedExternalCalls.length, 2);

    // 6. http.get: Loopback URL with external hostname MUST be intercepted and denied
    assert.throws(
      () => mockHttp.get('http://127.0.0.1/', { hostname: 'api.deepseek.com' }),
      /EXTERNAL_NETWORK_FORBIDDEN: api\.deepseek\.com/
    );
    assert.equal(guard.unexpectedExternalCalls.length, 3);

    // 7. https.request: Loopback URL with external hostname MUST be intercepted and denied
    assert.throws(
      () => mockHttps.request('https://127.0.0.1/', { hostname: 'api.deepseek.com' }),
      /EXTERNAL_NETWORK_FORBIDDEN: api\.deepseek\.com/
    );
    assert.equal(guard.unexpectedExternalCalls.length, 4);

    // 8. URL object with external hostname override MUST be intercepted and denied
    assert.throws(
      () => mockHttp.request(new URL('http://127.0.0.1/'), { hostname: 'api.deepseek.com' }),
      /EXTERNAL_NETWORK_FORBIDDEN: api\.deepseek\.com/
    );
    assert.equal(guard.unexpectedExternalCalls.length, 5);

    guard.restore();
  } finally {
    process.exitCode = origExitCode;
    try { fs.rmSync(testEvidenceFile, { force: true }); } catch {}
  }
});

test('real Node http module: setupNetworkGuard blocks external options override without connecting', () => {
  const origExitCode = process.exitCode;
  const guard = setupNetworkGuard();
  try {
    let caughtRequest: any = null;
    try {
      // Real http.request with loopback URL + external hostname option
      http.request('http://127.0.0.1/', { hostname: 'api.deepseek.com' });
    } catch (err) {
      caughtRequest = err;
    }

    assert.ok(caughtRequest, 'Real http.request must throw before any socket connection');
    assert.match(caughtRequest.message, /EXTERNAL_NETWORK_FORBIDDEN: api\.deepseek\.com/);
    assert.equal(process.exitCode, 1, 'Real http.request violation must set exitCode = 1');
    assert.equal(guard.unexpectedExternalCalls.length, 1);
    assert.equal(guard.unexpectedExternalCalls[0].host, 'api.deepseek.com');
    assert.equal(guard.unexpectedExternalCalls[0].targetUrl, 'http://api.deepseek.com/');

    let caughtUrl: any = null;
    try {
      // Real http.request with URL object + external hostname option
      http.request(new URL('http://127.0.0.1/'), { hostname: 'api.deepseek.com' });
    } catch (err) {
      caughtUrl = err;
    }
    assert.ok(caughtUrl, 'Real http.request with URL object must throw before any socket connection');
    assert.match(caughtUrl.message, /EXTERNAL_NETWORK_FORBIDDEN: api\.deepseek\.com/);
    assert.equal(guard.unexpectedExternalCalls.length, 2);

    let caughtGet: any = null;
    try {
      // Real http.get with loopback URL + external hostname option
      http.get('http://127.0.0.1/', { hostname: 'api.deepseek.com' });
    } catch (err) {
      caughtGet = err;
    }
    assert.ok(caughtGet, 'Real http.get must throw before any socket connection');
    assert.match(caughtGet.message, /EXTERNAL_NETWORK_FORBIDDEN: api\.deepseek\.com/);
    assert.equal(guard.unexpectedExternalCalls.length, 3);
  } finally {
    guard.restore();
    process.exitCode = origExitCode;
  }
});
