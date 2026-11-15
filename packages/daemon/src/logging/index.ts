import fs from 'node:fs';
import path from 'node:path';
import { enforceWindowsAcl, verifyWindowsAcl, assertSafeStatePath, ArloError, ArloErrorCode } from '../security/index.ts';

export const LogEventCode = {
  DAEMON_STARTED: 'DAEMON_STARTED',
  DAEMON_STOPPING: 'DAEMON_STOPPING',
  DAEMON_STOPPED: 'DAEMON_STOPPED',
  LOCK_ACQUIRED: 'LOCK_ACQUIRED',
  LOCK_RELEASED: 'LOCK_RELEASED',
  AUTH_SUCCESS: 'AUTH_SUCCESS',
  AUTH_FAILURE: 'AUTH_FAILURE',
  REQUEST_SERVED: 'REQUEST_SERVED',
  DIAGNOSTIC_RUN: 'DIAGNOSTIC_RUN',
  ACL_VERIFIED: 'ACL_VERIFIED',
  ACL_ENFORCED: 'ACL_ENFORCED',
  ERROR_OCCURRED: 'ERROR_OCCURRED',
  RUNTIME_REGISTERED: 'RUNTIME_REGISTERED',
  ROOT_REGISTERED: 'ROOT_REGISTERED',
  ROOT_CONNECTED: 'ROOT_CONNECTED',
  ROOT_REVOKED: 'ROOT_REVOKED',
  RUNTIME_REVOKED: 'RUNTIME_REVOKED',
  ROOT_READY: 'ROOT_READY',
  ROOT_CONFIGURATION_QUERIED: 'ROOT_CONFIGURATION_QUERIED',
  ROOT_SENDING_STATUS_QUERIED: 'ROOT_SENDING_STATUS_QUERIED',
  ROOT_SENDING_INITIALIZED: 'ROOT_SENDING_INITIALIZED',
  COLLABORATION_CONTINUED: 'COLLABORATION_CONTINUED',
  SENDING_RULES_RELOADED: 'SENDING_RULES_RELOADED',
  MESSAGE_DISPATCHED: 'MESSAGE_DISPATCHED',
  RECEIPT_RECORDED: 'RECEIPT_RECORDED',
  CREDIT_RELEASED: 'CREDIT_RELEASED',
  SEND_RATE_LIMITED: 'SEND_RATE_LIMITED',
  RECEIVE_RATE_LIMITED: 'RECEIVE_RATE_LIMITED',
  RATE_RECOVERED: 'RATE_RECOVERED',
} as const;

export type LogEventCode = (typeof LogEventCode)[keyof typeof LogEventCode];

export interface LogEntry {
  time: string;
  event: LogEventCode | string;
  daemon_id: string;
  request_id?: string;
  status: 'ok' | 'error' | 'rejected' | string;
  bytes: number;
  duration_ms: number;
}

export const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10 MiB
export const MAX_LOG_FILES = 3;
export const MAX_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class AuditLogger {
  private readonly stateDir: string;
  private readonly daemonId: string;
  private readonly logFilePath: string;
  private expiryTimer?: NodeJS.Timeout;

  constructor(stateDir: string, daemonId: string) {
    this.stateDir = stateDir;
    this.daemonId = daemonId;
    this.logFilePath = path.join(stateDir, 'daemon.log');
    this.assertSafeFiles();
  }

  assertSafeFiles(): void {
    if (process.platform !== 'linux') return;
    assertSafeStatePath(this.stateDir);
    for (const name of ['daemon.log', 'daemon.1.log', 'daemon.2.log']) {
      const file = path.join(this.stateDir, name);
      try { fs.lstatSync(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new ArloError(ArloErrorCode.INSECURE_PERMISSIONS);
      }
      const check = verifyWindowsAcl(file);
      if (!check.valid) throw new ArloError(check.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS);
      if (!fs.lstatSync(file).isFile()) throw new ArloError(ArloErrorCode.UNSAFE_LOCATION);
    }
  }

  log(params: {
    event: LogEventCode | string;
    status: 'ok' | 'error' | 'rejected' | string;
    request_id?: string;
    bytes?: number;
    duration_ms?: number;
  }): void {
    const entry: LogEntry = {
      time: new Date().toISOString(),
      event: params.event,
      daemon_id: this.daemonId,
      status: params.status,
      bytes: typeof params.bytes === 'number' && params.bytes >= 0 ? params.bytes : 0,
      duration_ms: typeof params.duration_ms === 'number' && params.duration_ms >= 0 ? params.duration_ms : 0,
    };
    if (params.request_id) {
      entry.request_id = params.request_id;
    }

    const line = JSON.stringify(entry) + '\n';
    try {
      this.assertSafeFiles();
      this.rotateIfNeeded(Buffer.byteLength(line));
      const fd = fs.openSync(this.logFilePath, process.platform === 'linux'
        ? fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW : 'a', 0o600);
      try { fs.writeSync(fd, line); }
      finally { fs.closeSync(fd); }
      enforceWindowsAcl(this.logFilePath, false);
      this.cleanOldLogs();
    } catch {
      // Logging failure must not crash execution
    }
  }

  rotateIfNeeded(incomingBytes: number): void {
    try {
      this.assertSafeFiles();
      this.cleanOldLogs();

      if (!fs.existsSync(this.logFilePath)) {
        return;
      }

      const stat = fs.statSync(this.logFilePath);
      if (stat.size + incomingBytes < MAX_LOG_FILE_SIZE) {
        return;
      }

      // Rotate: daemon.2.log removed, daemon.1.log -> daemon.2.log, daemon.log -> daemon.1.log
      const log2 = path.join(this.stateDir, 'daemon.2.log');
      const log1 = path.join(this.stateDir, 'daemon.1.log');

      if (fs.existsSync(log2)) {
        try {
          fs.unlinkSync(log2);
        } catch {}
      }

      if (fs.existsSync(log1)) {
        try {
          fs.renameSync(log1, log2);
          enforceWindowsAcl(log2, false);
        } catch {}
      }

      try {
        fs.renameSync(this.logFilePath, log1);
        enforceWindowsAcl(log1, false);
      } catch {}
    } catch {
      // Rotation error fallback
    }
  }

  cleanOldLogs(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    try {
      this.assertSafeFiles();
      const now = Date.now();
      let nextExpiry = Infinity;
      const files = ['daemon.log', 'daemon.1.log', 'daemon.2.log'];
      for (const f of files) {
        const fullPath = path.join(this.stateDir, f);
        if (fs.existsSync(fullPath)) {
          const stat = fs.statSync(fullPath);
          let firstEntryTime = Math.min(stat.birthtimeMs, stat.mtimeMs);
          const fd = fs.openSync(fullPath, 'r');
          try {
            const buffer = Buffer.alloc(1024);
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
            const time = Date.parse(JSON.parse(buffer.toString('utf8', 0, bytes).split('\n')[0]).time);
            if (Number.isFinite(time)) firstEntryTime = time;
          } catch {
            // Appending cannot extend retention for legacy/malformed files.
          } finally {
            fs.closeSync(fd);
          }
          const expiresAt = firstEntryTime + MAX_LOG_RETENTION_MS;
          if (now >= expiresAt) {
            try {
              fs.unlinkSync(fullPath);
            } catch {}
          } else {
            nextExpiry = Math.min(nextExpiry, expiresAt);
          }
        }
      }
      if (Number.isFinite(nextExpiry)) {
        this.expiryTimer = setTimeout(() => this.cleanOldLogs(), Math.max(1, nextExpiry - Date.now()));
        this.expiryTimer.unref();
      }
    } catch {}
  }

  close(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
  }
}
