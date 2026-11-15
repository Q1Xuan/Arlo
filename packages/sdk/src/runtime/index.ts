import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { ArloError, ArloErrorCode } from '../protocol/index.ts';

/** Required by the delivered communication path. Toolchain pins and tested
 * version lists are separate from the capabilities available in this process. */
export function assertNodeRuntime(): void {
  const capabilities = {
    'Promise.withResolvers': globalThis.Promise?.withResolvers,
    AbortController: globalThis.AbortController,
    'AbortSignal.any': globalThis.AbortSignal?.any,
    'AbortSignal.throwIfAborted': globalThis.AbortSignal?.prototype.throwIfAborted,
    Headers: globalThis.Headers,
    Response: globalThis.Response,
    'Readable.toWeb': Readable.toWeb,
    'crypto.randomUUID': crypto.randomUUID,
  };
  const missing = Object.entries(capabilities).filter(([, capability]) => typeof capability !== 'function')
    .map(([name]) => name);
  if (missing.length) throw new ArloError(ArloErrorCode.UNSUPPORTED_PROFILE,
    `UNSUPPORTED_PROFILE: Node ${process.version} lacks required runtime capabilities: ${missing.join(', ')}`);
}
