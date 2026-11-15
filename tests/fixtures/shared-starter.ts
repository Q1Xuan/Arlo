import { ensureSharedDaemon } from '../../packages/daemon/src/shared/index.ts';

try {
  const startTimeoutMs = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
  const daemonId = await ensureSharedDaemon({ stateDir: process.argv[2], startTimeoutMs });
  process.stdout.write(JSON.stringify({ daemonId }));
} catch (error) {
  process.stderr.write(JSON.stringify({ code: (error as { code?: string }).code }));
  process.exitCode = 1;
}
