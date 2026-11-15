import { ArloDaemon } from '../../packages/daemon/src/server/index.ts';

const daemon = new ArloDaemon({ stateDir: process.env.ARLO_STATE_DIR });
process.on('message', async (message) => {
  if (message === 'start') {
    try { process.send?.({ ok: true, ...await daemon.start() }); }
    catch (error) { process.send?.({ ok: false, code: (error as { code?: string }).code }); }
  } else if (message === 'stop') {
    await daemon.stop();
    process.disconnect();
  } else if (message === 'crash') {
    process.exit(23);
  }
});
process.send?.('ready');
