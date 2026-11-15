import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ArloErrorCode, ArloError, type DaemonDiscoveryRecord } from '../protocol/index.ts';
import { verifyWindowsAcl, assertSafeStatePath } from '../security/index.ts';

export function resolveStateDir(explicitPath?: string): string {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  if (process.env.ARLO_STATE_DIR) {
    return path.resolve(process.env.ARLO_STATE_DIR);
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Arlo');
  }
  if (process.platform === 'linux') {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (!runtime || !path.isAbsolute(runtime)) throw new ArloError(ArloErrorCode.UNSAFE_LOCATION);
    assertSafeStatePath(runtime);
    const check = verifyWindowsAcl(runtime);
    if (!check.valid) throw new ArloError(check.errorCode ?? ArloErrorCode.UNSAFE_LOCATION);
    return path.join(runtime, 'Arlo');
  }
  const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(xdgState, 'Arlo');
}

export function resolveAuditDir(explicitPath?: string): string {
  if (process.platform !== 'linux' || explicitPath || process.env.ARLO_STATE_DIR) return resolveStateDir(explicitPath);
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  if (!path.isAbsolute(state)) throw new ArloError(ArloErrorCode.UNSAFE_LOCATION);
  return path.join(state, 'Arlo');
}

export function checkSafeLocation(targetPath: string): void {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      throw new ArloError(ArloErrorCode.UNSAFE_LOCATION, 'Target is an unsafe symbolic link');
    }
  } catch (error) {
    if (error instanceof ArloError) throw error;
  }
}

export function readDiscoveryRecord(stateDir: string): DaemonDiscoveryRecord {
  assertSafeStatePath(stateDir);
  const filePath = path.join(stateDir, 'discovery.json');
  if (!fs.existsSync(filePath)) {
    throw new ArloError(ArloErrorCode.DAEMON_NOT_RUNNING, 'Discovery record not found');
  }

  checkSafeLocation(filePath);

  const aclCheck = verifyWindowsAcl(filePath);
  if (!aclCheck.valid) {
    throw new ArloError(
      aclCheck.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS,
      aclCheck.detail ?? 'Discovery record failed security check'
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Failed to read discovery record');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Discovery record is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Discovery record is not an object');
  }

  const record = parsed as Record<string, unknown>;
  if (
    typeof record.daemon_id !== 'string' ||
    typeof record.pid !== 'number' ||
    !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
    typeof record.port !== 'number' ||
    !Number.isInteger(record.port) ||
    record.port <= 0 ||
    record.port > 65535 ||
    typeof record.cert_fingerprint !== 'string' ||
    typeof record.cert_pem !== 'string' ||
    record.protocol_version !== '0.1' ||
    (record.status !== 'ready' && record.status !== 'shutting_down')
  ) {
    throw new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Discovery record fields are invalid');
  }

  try {
    const certificate = new crypto.X509Certificate(record.cert_pem);
    if (crypto.createHash('sha256').update(certificate.raw).digest('hex') !== record.cert_fingerprint) throw new Error();
  } catch {
    throw new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Invalid discovery certificate');
  }

  return {
    daemon_id: record.daemon_id,
    pid: record.pid,
    port: record.port,
    cert_fingerprint: record.cert_fingerprint,
    cert_pem: record.cert_pem,
    protocol_version: record.protocol_version,
    status: record.status,
    started_at: String(record.started_at ?? ''),
  };
}

export function readBootstrapToken(stateDir: string): string {
  assertSafeStatePath(stateDir);
  const filePath = path.join(stateDir, 'bootstrap.token');
  if (!fs.existsSync(filePath)) {
    throw new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Bootstrap token not found');
  }

  checkSafeLocation(filePath);

  const aclCheck = verifyWindowsAcl(filePath);
  if (!aclCheck.valid) {
    throw new ArloError(
      aclCheck.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS,
      aclCheck.detail ?? 'Bootstrap token failed security check'
    );
  }

  try {
    const token = fs.readFileSync(filePath, 'utf8').trim();
    if (!token) {
      throw new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Bootstrap token is empty');
    }
    return token;
  } catch (error) {
    if (error instanceof ArloError) throw error;
    throw new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Failed to read bootstrap token');
  }
}
