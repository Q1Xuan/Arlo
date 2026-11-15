import { ArloDaemon } from '@arlo/daemon';
import { UNPACED_RATE_LIMIT } from '../test-utils.ts';

// Keep the SDK/receiver event loop independent from native synchronous ACL
// checks. This test isolates quota concurrency; real lease clocks are covered
// by the lease-expiry and fsync revalidation integration tests.
const daemon = new ArloDaemon({ stateDir: process.argv[2], rateLimit: UNPACED_RATE_LIMIT, leaseNow: () => 1000 });
process.on('message', message => {
  if (message === 'stop') void daemon.stop().then(() => process.disconnect());
});
process.on('disconnect', () => { void daemon.stop(); });
await daemon.start();
process.send?.('ready');
