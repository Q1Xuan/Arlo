import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArloError, ArloErrorCode, type RootConfigurationEvidence } from '../protocol/index.ts';

/** Capture evidence from the artifact the public host persistence API
 * validated. Supplying its still-open descriptor pins that observation even
 * if the path is concurrently replaced. The optional origin is the host's
 * canonical serialization of immutable public header fields; only its digest
 * enters wire evidence. No session contents are inspected by this helper. */
export function captureRootConfigurationEvidence(sessionFile: string, descriptor?: number, hostOrigin?: string): RootConfigurationEvidence {
  if (typeof sessionFile !== 'string' || !path.isAbsolute(sessionFile) ||
      descriptor !== undefined && (!Number.isSafeInteger(descriptor) || descriptor < 0) ||
      hostOrigin !== undefined && typeof hostOrigin !== 'string') {
    throw new ArloError(ArloErrorCode.INVALID_ARGUMENT);
  }
  try {
    const stat = descriptor === undefined
      ? fs.statSync(sessionFile, { bigint: true })
      : fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.ino === 0n || stat.birthtimeNs <= 0n) {
      throw new ArloError(ArloErrorCode.CORRUPTED_STATE);
    }
    const fileIdentity = crypto.createHash('sha256')
      .update(JSON.stringify([String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]))
      .digest('hex');
    const fileRevision = crypto.createHash('sha256')
      .update(JSON.stringify([String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]))
      .digest('hex');
    return { kind: 'session-file', session_file: sessionFile, file_identity: fileIdentity, file_revision: fileRevision,
      ...(hostOrigin === undefined ? {} : { host_origin: crypto.createHash('sha256').update(hostOrigin).digest('hex') }) };
  } catch {
    throw new ArloError(ArloErrorCode.CORRUPTED_STATE, 'Public session artifact has no reliable physical identity');
  }
}
