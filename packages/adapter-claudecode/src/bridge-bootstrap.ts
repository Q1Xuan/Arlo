import fs from 'node:fs';
import path from 'node:path';
import { writePrivateStateFile } from '@arlo/daemon/storage';
import { enforceWindowsAcl, verifyWindowsAcl } from '@arlo/sdk';

/** Env var holding the stable private-file path. It never carries a port or token. */
export const BRIDGE_BOOTSTRAP_ENV = 'ARLO_CLAUDECODE_BRIDGE_BOOTSTRAP';

/**
 * One Sidecar death may spawn at most this many replacements.
 * Each wait doubles from {@link SIDECAR_RECOVERY_INITIAL_BACKOFF_MS}
 * and is capped at {@link SIDECAR_RECOVERY_MAX_BACKOFF_MS}.
 * The incident also ends at {@link SIDECAR_RECOVERY_BUDGET_MS}
 * measured from the first unexpected exit. Whichever bound is reached
 * first stops further launches. A successful reattachment clears the incident.
 */
export const SIDECAR_RECOVERY_ATTEMPTS = 5;
export const SIDECAR_RECOVERY_INITIAL_BACKOFF_MS = 250;
export const SIDECAR_RECOVERY_MAX_BACKOFF_MS = 4_000;
export const SIDECAR_RECOVERY_BUDGET_MS = 30_000;
export const SIDECAR_RECOVERY_DIAGNOSTIC =
  'Arlo Sidecar recovery stopped after its attempt and time limit. The Claude session and durable ledger were kept.';

const SESSION_ID = /^[^\u0000-\u001F\u007F/\\]{1,200}$/;
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActiveBridgeBootstrap {
  status: 'active';
  sessionId: string;
  url: string;
  token: string;
  instanceId: string;
}

export interface ExhaustedBridgeBootstrap {
  status: 'exhausted';
  sessionId: string;
  diagnostic: string;
}

export type BridgeBootstrap = ActiveBridgeBootstrap | ExhaustedBridgeBootstrap;

export function bridgeBootstrapPath(stateDir: string, launchSessionId: string): string {
  return path.join(stateDir, 'claudecode', launchSessionId, 'bridge-bootstrap.json');
}

export function liveSessionPath(stateDir: string, launchSessionId: string): string {
  return path.join(stateDir, 'claudecode', launchSessionId, 'live-session.json');
}

function assertPrivate(file: string): void {
  const check = verifyWindowsAcl(file);
  if (!check.valid) throw new Error(check.detail ?? 'Bridge private state failed its ownership check');
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  enforceWindowsAcl(directory, true);
  assertPrivate(directory);
}

function sameKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function loopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' &&
      !url.username && !url.password && url.pathname === '/' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

export function parseBridgeBootstrap(text: string): BridgeBootstrap {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Bridge bootstrap is invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Bridge bootstrap is invalid');
  const record = value as Record<string, unknown>;
  if (record.status === 'exhausted') {
    if (!sameKeys(record, ['diagnostic', 'sessionId', 'status'])) throw new Error('Bridge bootstrap is invalid');
    if (typeof record.sessionId !== 'string' || !SESSION_ID.test(record.sessionId)) throw new Error('Bridge bootstrap is invalid');
    if (typeof record.diagnostic !== 'string' || record.diagnostic.length === 0 || record.diagnostic.length > 500) {
      throw new Error('Bridge bootstrap is invalid');
    }
    if (/[0-9a-f]{32,}/i.test(record.diagnostic)) throw new Error('Bridge bootstrap is invalid');
    return { status: 'exhausted', sessionId: record.sessionId, diagnostic: record.diagnostic };
  }
  if (record.status !== 'active' || !sameKeys(record, ['instanceId', 'sessionId', 'status', 'token', 'url'])) {
    throw new Error('Bridge bootstrap is invalid');
  }
  if (typeof record.sessionId !== 'string' || !SESSION_ID.test(record.sessionId)) throw new Error('Bridge bootstrap is invalid');
  if (typeof record.instanceId !== 'string' || !INSTANCE_ID.test(record.instanceId)) throw new Error('Bridge bootstrap is invalid');
  if (typeof record.token !== 'string' || !/^[0-9a-f]{64}$/.test(record.token)) throw new Error('Bridge bootstrap is invalid');
  if (typeof record.url !== 'string' || !loopbackUrl(record.url)) throw new Error('Bridge bootstrap is invalid');
  return {
    status: 'active', sessionId: record.sessionId, url: record.url, token: record.token, instanceId: record.instanceId,
  };
}

function publish(file: string, body: string): void {
  ensurePrivateDirectory(path.dirname(file));
  writePrivateStateFile(path.dirname(file), path.basename(file), body, true);
  assertPrivate(file);
}

export function publishActiveBridgeBootstrap(file: string, material: Omit<ActiveBridgeBootstrap, 'status'>): void {
  const body = `${JSON.stringify({
    status: 'active', sessionId: material.sessionId, url: material.url, token: material.token, instanceId: material.instanceId,
  })}\n`;
  parseBridgeBootstrap(body);
  publish(file, body);
}

export function publishExhaustedBridgeBootstrap(file: string, sessionId: string, diagnostic = SIDECAR_RECOVERY_DIAGNOSTIC): void {
  const body = `${JSON.stringify({ status: 'exhausted', sessionId, diagnostic })}\n`;
  parseBridgeBootstrap(body);
  publish(file, body);
}

export function readBridgeBootstrap(file: string): BridgeBootstrap {
  assertPrivate(file);
  return parseBridgeBootstrap(fs.readFileSync(file, 'utf8'));
}

export function publishLiveSession(file: string, sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error('Live session is invalid');
  publish(file, `${JSON.stringify({ sessionId })}\n`);
}

export function readLiveSessionId(stateDir: string, launchSessionId: string): string {
  if (!SESSION_ID.test(launchSessionId)) throw new Error('Launch session is invalid');
  const file = liveSessionPath(stateDir, launchSessionId);
  if (!fs.existsSync(file)) return launchSessionId;
  assertPrivate(file);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Live session record is invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Live session record is invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== 'sessionId' || typeof record.sessionId !== 'string' || !SESSION_ID.test(record.sessionId)) {
    throw new Error('Live session record is invalid');
  }
  return record.sessionId;
}

export function removeBridgeBootstrap(file: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error('Bridge bootstrap file is not private');
  fs.unlinkSync(file);
}
