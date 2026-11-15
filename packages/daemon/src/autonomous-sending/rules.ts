import fs from 'node:fs';
import path from 'node:path';
import {
  assertSafeStatePath, inspectWindowsAclBatch, verifyWindowsAcl,
  ArloError, ArloErrorCode,
} from '@arlo/sdk';

export interface SendingRule {
  readonly mode: 'bounded' | 'continuous';
  readonly grant: number;
}

export const DEFAULT_SENDING_RULE: SendingRule = Object.freeze({ mode: 'bounded', grant: 20 });
const RULES_NAME = 'autonomous-communication.json';
const MAX_RULES_BYTES = 2 * 1024 * 1024;
const MAX_ROOT_RULES = 10_000;
const CONFIG_ID = /^rc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(detail: string): never {
  throw new ArloError(ArloErrorCode.SENDING_RULES_INVALID, detail);
}

function sameIdentity(first: fs.BigIntStats, second: fs.BigIntStats): boolean {
  return first.dev === second.dev && first.ino !== 0n && first.ino === second.ino &&
    first.birthtimeNs > 0n && first.birthtimeNs === second.birthtimeNs;
}

function sameRevision(first: fs.BigIntStats, second: fs.BigIntStats): boolean {
  return sameIdentity(first, second) && first.size === second.size &&
    first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

function verifyPrivatePaths(stateDir: string, file?: string): void {
  assertSafeStatePath(stateDir);
  const paths = file === undefined ? [stateDir] : [stateDir, file];
  const inspections = inspectWindowsAclBatch(paths);
  for (const target of paths) {
    const check = verifyWindowsAcl(target, inspections[target]);
    if (!check.valid) invalid(`Sending rules require verified private storage: ${check.errorCode ?? ArloErrorCode.INSECURE_PERMISSIONS}`);
  }
}

/** Read only user-private rules, through a pinned and bounded descriptor. A
 * replacement or in-place edit during inspection invalidates the entire read. */
function readRules(stateDir: string): string | undefined {
  const directory = fs.lstatSync(stateDir, { bigint: true });
  const directoryPath = fs.realpathSync.native(stateDir);
  const file = path.join(stateDir, RULES_NAME);
  let before: fs.BigIntStats;
  try { before = fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A missing file intentionally means the complete default snapshot.
    verifyPrivatePaths(stateDir);
    if (!sameIdentity(directory, fs.lstatSync(stateDir, { bigint: true })) ||
        fs.realpathSync.native(stateDir) !== directoryPath) invalid('Sending rules storage changed during reading; retry');
    try { fs.lstatSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    invalid('Sending rules file appeared during reading; retry');
  }
  if (!before.isFile() || before.isSymbolicLink()) invalid('Sending rules must be a regular private file');
  if (before.size > BigInt(MAX_RULES_BYTES)) invalid('Sending rules file exceeds the 2 MiB limit');
  verifyPrivatePaths(stateDir, file);

  const descriptor = fs.openSync(file, process.platform === 'linux'
    ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW : fs.constants.O_RDONLY);
  try {
    if (!sameRevision(before, fs.fstatSync(descriptor, { bigint: true }))) {
      invalid('Sending rules file changed before reading; retry');
    }
    // Never read an unbounded file even if an editor grows it after lstat.
    const bytes = Buffer.alloc(MAX_RULES_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(descriptor, bytes, length, bytes.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_RULES_BYTES) invalid('Sending rules file exceeds the 2 MiB limit');
    verifyPrivatePaths(stateDir, file);
    if (!sameRevision(before, fs.fstatSync(descriptor, { bigint: true })) ||
        !sameRevision(before, fs.lstatSync(file, { bigint: true })) ||
        BigInt(length) !== before.size ||
        !sameIdentity(directory, fs.lstatSync(stateDir, { bigint: true })) ||
        fs.realpathSync.native(stateDir) !== directoryPath) {
      invalid('Sending rules file or storage changed during reading; retry');
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { invalid('Sending rules must contain valid UTF-8 JSON'); }
  } finally { fs.closeSync(descriptor); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

/** JSON.parse validates grammar first. Then inspect only object keys, including
 * escaped aliases, so last-key-wins cannot hide an invalid authorization. */
function rejectDuplicateKeys(raw: string): void {
  const objects: Set<string>[] = [];
  for (const token of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}]/g)) {
    const value = token[0];
    if (value === '{') objects.push(new Set());
    else if (value === '}') objects.pop();
    else {
      let next = token.index! + value.length;
      while (/\s/.test(raw[next] ?? '')) next++;
      if (raw[next] !== ':') continue;
      const key = JSON.parse(value) as string;
      const keys = objects.at(-1)!;
      if (keys.has(key)) invalid('Sending rules must not contain duplicate JSON fields');
      keys.add(key);
    }
  }
}

/** Returns a complete candidate snapshot. The caller publishes it once only
 * after revalidating its authenticated request; failed reads never mutate the
 * last published snapshot, allowance periods, or control history. */
export function loadSendingRules(stateDir: string): ReadonlyMap<string, SendingRule> {
  try {
    const raw = readRules(stateDir);
    const rules = new Map<string, SendingRule>();
    if (raw === undefined) return rules;
    let document: unknown;
    try { document = JSON.parse(raw); }
    catch { invalid('Sending rules file must contain complete valid JSON'); }
    rejectDuplicateKeys(raw);
    if (!object(document) || !exactFields(document, ['version', 'roots'])) {
      invalid('Sending rules must contain exactly version and roots');
    }
    if (document.version !== 1) invalid('Sending rules version must be 1');
    if (!object(document.roots)) invalid('Sending rules roots must be an object');
    const entries = Object.entries(document.roots);
    if (entries.length > MAX_ROOT_RULES) invalid('Sending rules exceed the 10,000-root limit');
    for (const [configId, value] of entries) {
      if (!CONFIG_ID.test(configId)) invalid('Sending rules roots keys must be rc-UUID configuration identifiers');
      if (!object(value) || !exactFields(value, ['mode', 'grant'])) {
        invalid('Each sending rule must contain exactly mode and grant');
      }
      if (value.mode !== 'bounded' && value.mode !== 'continuous') {
        invalid('Sending rule mode must be bounded or continuous');
      }
      if (typeof value.grant !== 'number' || !Number.isSafeInteger(value.grant) || value.grant < 1) {
        invalid('Sending rule grant must be a positive safe integer (1..9007199254740991)');
      }
      rules.set(configId, Object.freeze({ mode: value.mode, grant: value.grant }));
    }
    return rules;
  } catch (error) {
    if (error instanceof ArloError && error.code === ArloErrorCode.SENDING_RULES_INVALID) throw error;
    if (error instanceof ArloError) invalid(`Sending rules private storage could not be verified: ${error.code}`);
    invalid('Sending rules file could not be read safely; check private storage and save a complete file');
  }
}
