#!/usr/bin/env node
import { ArloDaemon } from '../src/server/index.ts';
import { ArloError, ArloErrorCode } from '@arlo/sdk';

const daemon = new ArloDaemon({ stateDir: process.argv[3], idleTimeoutMs: Number(process.argv[2]) });
const stop = () => { void daemon.stop().catch(() => { process.exitCode = 1; }); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await daemon.start();
  if (process.connected) process.disconnect();
} catch (error) {
  // A competing caller may already own the shared instance. The caller
  // rediscovers and authenticates the winner; no credentials leave this child.
  if (process.connected) {
    process.send({ error: error instanceof ArloError ? error.code : ArloErrorCode.CORRUPTED_STATE }, () => {
      if (process.connected) process.disconnect();
    });
  }
  process.exitCode = 1;
}
