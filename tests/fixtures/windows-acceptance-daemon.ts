import { ArloDaemon } from '@arlo/daemon';

const daemon = new ArloDaemon({
  stateDir: process.env.ARLO_STATE_DIR,
  idleTimeoutMs: process.env.ARLO_TEST_IDLE_MS ? Number(process.env.ARLO_TEST_IDLE_MS) : undefined,
  onIdleStopped: () => process.disconnect?.(),
});

process.on('message', async (message: { command: string }) => {
  if (message.command === 'stop') {
    await daemon.stop();
    process.disconnect?.();
  }
});
process.on('disconnect', () => { void daemon.stop(); });

try {
  process.send?.({ ready: true, ...await daemon.start() });
} catch (error) {
  process.send?.({ ready: false, code: (error as { code?: string }).code });
  await daemon.stop();
  process.exitCode = 1;
  process.disconnect?.();
}
