import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ReceptionDispatch } from '@arlo/adapter-sdk';

export interface DurableMessageRecord {
  nativeMessageId: string;
  messageId: string;
  text: string;
  textBytes: number;
  fromEndpoint?: string;
  /**
   * This message's own correlation marker. Records written before claim
   * evidence existed have none; recovery assigns one before any host call.
   */
  correlationId?: string;
  dispatch: ReceptionDispatch;
  status: 'enqueued' | 'dispatching' | 'submitting' | 'claimed' | 'discarded' | 'unknown';
  enqueuedAt: string;
  settledAt?: string;
}

export interface ClaudeCodeStorageOptions {
  sessionId: string;
  storageDir: string;
  faultInjection?: {
    failWrites?: boolean;
  };
}

export class QueueWriteError extends Error {
  readonly published: boolean;

  constructor(published: boolean, cause: unknown) {
    super(published ? 'Queue publication could not be confirmed durable' : 'Queue write failed before publication', { cause });
    this.published = published;
  }
}

function syncDirectory(directory: string): void {
  // Node cannot open directory descriptors for fsync on Windows. File fsync
  // and atomic replacement still protect recovery after a process crash.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeAll(fd: number, data: Buffer, position?: number): void {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(fd, data, offset, data.length - offset, position === undefined ? null : position + offset);
    if (written <= 0) throw new Error('Queue write made no progress');
    offset += written;
  }
}

function isRecord(value: unknown): value is DurableMessageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const dispatch = record.dispatch as Record<string, unknown> | undefined;
  return typeof record.nativeMessageId === 'string' && record.nativeMessageId.length > 0 &&
    typeof record.messageId === 'string' && record.messageId.length > 0 &&
    typeof record.text === 'string' && record.textBytes === Buffer.byteLength(record.text, 'utf8') &&
    (record.fromEndpoint === undefined || typeof record.fromEndpoint === 'string') &&
    (record.correlationId === undefined || (typeof record.correlationId === 'string' && record.correlationId.length > 0)) &&
    typeof record.status === 'string' && ['enqueued', 'dispatching', 'submitting', 'claimed', 'discarded', 'unknown'].includes(record.status) &&
    typeof record.enqueuedAt === 'string' && Number.isFinite(Date.parse(record.enqueuedAt)) &&
    (record.settledAt === undefined || (typeof record.settledAt === 'string' && Number.isFinite(Date.parse(record.settledAt)))) &&
    !!dispatch && typeof dispatch === 'object' && !Array.isArray(dispatch) &&
    ['daemon_id', 'endpoint_id', 'message_id', 'delivery_id'].every((key) => typeof dispatch[key] === 'string' && dispatch[key].length > 0) &&
    dispatch.message_id === record.messageId && Number.isSafeInteger(dispatch.generation) && Number(dispatch.generation) >= 1;
}

export class ClaudeCodeQueueStorage {
  readonly sessionDir: string;
  readonly queueFile: string;
  private readonly faultInjection?: ClaudeCodeStorageOptions['faultInjection'];

  constructor(options: ClaudeCodeStorageOptions) {
    this.sessionDir = path.join(options.storageDir, options.sessionId);
    this.queueFile = path.join(this.sessionDir, 'queue.jsonl');
    this.faultInjection = options.faultInjection;
  }

  ensureDir(): void {
    if (!fs.existsSync(this.sessionDir)) {
      const firstCreated = fs.mkdirSync(this.sessionDir, { recursive: true });
      if (firstCreated && process.platform !== 'win32') {
        const existingParent = path.dirname(path.resolve(firstCreated));
        let directory = path.resolve(this.sessionDir);
        while (directory !== existingParent) {
          directory = path.dirname(directory);
          syncDirectory(directory);
        }
      }
    }
  }

  append(record: DurableMessageRecord): void {
    // Unconfirmed writes stay in a staging file, never in the recoverable queue.
    // Prepublication failures prove absence. A directory-sync error after
    // rename instead leaves an inserted input whose durability is unresolved.
    this.rewriteAll([...this.loadAll(), record]);
  }

  rewriteAll(records: DurableMessageRecord[]): void {
    if (this.faultInjection?.failWrites) {
      throw new Error('Injected storage failure');
    }
    this.ensureDir();
    const tempFile = `${this.queueFile}.${crypto.randomUUID()}.tmp`;
    let fd: number | undefined;
    let published = false;
    try {
      fd = fs.openSync(tempFile, 'wx', 0o600);
      for (const record of records) {
        const data = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
        writeAll(fd, data);
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      // Every earlier failure leaves the old queue intact, including fsync
      // failures after a complete write to the staging file.
      fs.renameSync(tempFile, this.queueFile);
      published = true;
      syncDirectory(this.sessionDir);
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* Preserve the storage failure. */ }
      }
      try { fs.rmSync(tempFile, { force: true }); } catch { /* Staging files are never recovered. */ }
      throw new QueueWriteError(published, error);
    }
  }

  loadAll(): DurableMessageRecord[] {
    if (!fs.existsSync(this.queueFile)) {
      return [];
    }
    const content = fs.readFileSync(this.queueFile);
    const records: DurableMessageRecord[] = [];
    const completeLength = content.lastIndexOf(0x0a) + 1;
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, completeLength)).split('\n');
    const nativeIds = new Set<string>();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record: unknown = JSON.parse(trimmed);
        if (!isRecord(record) || nativeIds.has(record.nativeMessageId)) throw new Error('Invalid queue record');
        nativeIds.add(record.nativeMessageId);
        records.push(record);
      } catch {
        throw new Error('Corrupt queue record; recovery requires repair');
      }
    }
    if (completeLength !== content.length) {
      // Only an unterminated final record can be a torn append. Validate all
      // complete records first so corruption never becomes proof of absence.
      let finalRecord: unknown;
      try {
        finalRecord = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(completeLength)));
      } catch {
        // An incomplete final JSON/UTF-8 value is a torn append.
      }
      if (finalRecord !== undefined) {
        if (!isRecord(finalRecord) || nativeIds.has(finalRecord.nativeMessageId)) {
          throw new Error('Corrupt final queue record; recovery requires repair');
        }
        records.push(finalRecord);
      }
      const fd = fs.openSync(this.queueFile, 'r+');
      try {
        if (finalRecord === undefined) fs.ftruncateSync(fd, completeLength);
        else writeAll(fd, Buffer.from('\n'), content.length);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    return records;
  }
}
