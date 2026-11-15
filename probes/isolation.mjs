import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { isLoopback, setupNetworkGuard } from './gui-network-guard.mjs';

let deniedConnections = 0;
const persistDenials = () => {
  if (process.env.ARLO_LOW_LEVEL_NETWORK_FILE) {
    writeFileSync(process.env.ARLO_LOW_LEVEL_NETWORK_FILE, JSON.stringify({ deniedConnections }));
  }
};
persistDenials();

const deny = (target) => {
  deniedConnections++;
  persistDenials();
  process.exitCode = 1;
  throw new Error(`EXTERNAL_NETWORK_FORBIDDEN: ${target || 'external request'}`);
};

const origSocketConnect = net.Socket.prototype.connect;
function checkSocketArgs(args) {
  let first = args[0];
  if (Array.isArray(first)) {
    first = first[0];
  }
  let host = '127.0.0.1';
  if (typeof first === 'object' && first !== null) {
    if (first.path) return; // local IPC
    host = first.host || first.hostname || (first.port != null ? 'localhost' : null);
  } else if (typeof first === 'string' && (first.startsWith('/') || first.startsWith('\\\\') || first.includes('\\') || first.includes('/'))) {
    return; // local IPC path
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    if (typeof args[1] === 'string') {
      host = args[1];
    } else if (typeof args[1] === 'object' && args[1] !== null) {
      host = args[1].host || args[1].hostname || 'localhost';
    } else if (args[1] === undefined || typeof args[1] === 'function') {
      host = 'localhost';
    } else {
      return deny('unknown net connect argument');
    }
  } else {
    return deny('unknown net connect argument');
  }
  if (!host || !isLoopback(host)) {
    return deny(host);
  }
}

net.Socket.prototype.connect = function(...args) {
  checkSocketArgs(args);
  return origSocketConnect.apply(this, args);
};

const origNetConnect = net.connect;
net.connect = net.createConnection = function(...args) {
  checkSocketArgs(args);
  return origNetConnect.apply(this, args);
};

const origTlsConnect = tls.connect;
function checkTlsArgs(args) {
  let first = args[0];
  if (Array.isArray(first)) {
    first = first[0];
  }
  let host = '127.0.0.1';
  if (typeof first === 'object' && first !== null) {
    if (first.path || first.socket) return;
    host = first.host || first.servername || first.hostname || (first.port != null ? 'localhost' : null);
  } else if (typeof first === 'string' && (first.startsWith('/') || first.startsWith('\\\\') || first.includes('\\') || first.includes('/'))) {
    return; // local IPC path
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    if (typeof args[1] === 'string') {
      host = args[1];
      if (typeof args[2] === 'object' && args[2] !== null) {
        if (args[2].host && !isLoopback(args[2].host)) return deny(args[2].host);
        if (args[2].servername && !isLoopback(args[2].servername)) return deny(args[2].servername);
      }
    } else if (typeof args[1] === 'object' && args[1] !== null) {
      host = args[1].host || args[1].servername || args[1].hostname || 'localhost';
    } else if (args[1] === undefined || typeof args[1] === 'function') {
      host = 'localhost';
    } else {
      return deny('unknown tls connect argument');
    }
  } else {
    return deny('unknown tls connect argument');
  }
  if (!host || !isLoopback(host)) {
    return deny(host);
  }
}

tls.connect = function(...args) {
  checkTlsArgs(args);
  return origTlsConnect.apply(this, args);
};

setupNetworkGuard({ http, https, globalThis, onViolation: () => { deniedConnections++; persistDenials(); } });

dgram.createSocket = () => deny('dgram');

const origDnsLookup = dns.lookup;
dns.lookup = function(hostname, ...rest) {
  if (isLoopback(hostname)) {
    return origDnsLookup.call(this, hostname, ...rest);
  }
  return deny(hostname);
};
dns.lookupService = () => deny('dns.lookupService');

const dnsResolveMethods = [
  'resolve', 'resolve4', 'resolve6', 'resolveCname', 'resolveMx',
  'resolveTxt', 'resolveSrv', 'resolveNs', 'resolvePtr', 'resolveSoa',
  'resolveNaptr', 'resolveCaa', 'reverse'
];
for (const method of dnsResolveMethods) {
  if (typeof dns[method] === 'function') {
    dns[method] = (hostname) => deny(`dns.${method}: ${hostname}`);
  }
}

if (dns.promises) {
  const origPromisesLookup = dns.promises.lookup;
  dns.promises.lookup = function(hostname, ...rest) {
    if (isLoopback(hostname)) {
      return origPromisesLookup.call(this, hostname, ...rest);
    }
    return Promise.reject(deny(hostname));
  };
  for (const method of dnsResolveMethods) {
    if (typeof dns.promises[method] === 'function') {
      dns.promises[method] = (hostname) => Promise.reject(deny(`dns.promises.${method}: ${hostname}`));
    }
  }
  dns.promises.lookupService = () => Promise.reject(deny('dns.promises.lookupService'));
}

dns.Resolver = class {
  constructor() { deny('dns.Resolver'); }
};
dns.setServers = () => deny('dns.setServers');

globalThis.WebSocket = class {
  constructor(url) {
    try {
      const u = new URL(url);
      if (!isLoopback(u.hostname)) deny(u.hostname);
    } catch {
      deny(url);
    }
  }
};

syncBuiltinESMExports();
