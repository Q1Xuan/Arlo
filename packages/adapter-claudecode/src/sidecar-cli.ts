import { resolveStateDir } from '@arlo/sdk';
import { readLiveSessionId } from './bridge-bootstrap.ts';
import { ClaudeCodeSidecar } from './sidecar.ts';

async function main() {
  const launchSessionId = process.env.ARLO_CLAUDECODE_SESSION_ID;
  if (!launchSessionId) {
    console.error('ARLO_CLAUDECODE_SESSION_ID is required');
    process.exit(1);
  }

  const stateDir = process.env.ARLO_CLAUDECODE_STATE_DIR || undefined;
  const groupName = process.env.ARLO_CLAUDECODE_GROUP_NAME || undefined;
  const sessionId = readLiveSessionId(resolveStateDir(stateDir), launchSessionId);

  const sidecar = new ClaudeCodeSidecar({
    sessionId,
    launchSessionId,
    stateDir,
    groupName,
    cwd: process.env.ARLO_CLAUDECODE_CWD || process.cwd(),
    crossHostEnabled: process.env.ARLO_CLAUDECODE_CROSS_HOST_ENABLED === '1',
    autoStart: true,
  });

  const { port, url, token } = await sidecar.start();

  // The runner reads this pipe. The token is not written to stderr or a log file.
  console.log(JSON.stringify({ type: 'ready', port, url, token, bootstrapPath: sidecar.bootstrapPath }));

  let stopping = false;
  const shutdown = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    await sidecar.stop();
    process.exit(exitCode);
  };

  // An external kill must leave the durable queue untouched. Graceful retirement
  // remains the IPC shutdown path used when the host itself is exiting.
  process.on('SIGTERM', () => { process.exit(1); });
  process.on('SIGINT', () => { process.exit(1); });
  // IPC is the graceful Windows path: ChildProcess.kill() does not deliver a
  // catchable SIGTERM there. A runner crash also closes this channel.
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') void shutdown();
  });
  process.on('disconnect', () => { void shutdown(); });
  const configuredTimeout = Number(process.env.ARLO_CLAUDECODE_STARTUP_TIMEOUT_MS ?? 30000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30000;
  try {
    // A listening bridge alone is not an attached Mod or a ready endpoint.
    await sidecar.waitForReady(timeoutMs);
    if (!stopping) console.log(JSON.stringify({ type: 'attached', sessionId: sidecar.sessionId, launchSessionId }));
  } catch (error) {
    console.error('Sidecar could not attach its root:', error);
    await shutdown(1);
  }
}

void main().catch((err) => {
  console.error('Sidecar failed to start:', err);
  process.exit(1);
});
