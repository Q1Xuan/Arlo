import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { IMPOSTER_CERT, IMPOSTER_KEY } from './tls-fixtures.ts';

interface ImposterStats { connections: number; requests: number; bodyBytes: number; pid: number }

// Only the installed-host scenario starts this owned helper process. Package
// fixtures retain their no-subprocess permission boundary.
export async function startImposterProcess(port: number) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', String(port)], {
    env: { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1',
      HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TEMP: process.env.TEMP },
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const ready = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<ImposterStats>();
  let stats: ImposterStats | undefined;
  const deadline = setTimeout(() => child.kill(), 10000);
  child.on('error', error => { ready.reject(error); stopped.reject(error); });
  child.on('message', (message: { type: string; stats?: ImposterStats }) => {
    if (message.type === 'ready') ready.resolve();
    if (message.type === 'stats') stats = message.stats;
  });
  child.on('close', code => {
    clearTimeout(deadline);
    const error = new Error(`IMPOSTER_PROCESS_EXIT:${code}`);
    if (code !== 0 || !stats) { ready.reject(error); stopped.reject(error); }
    else stopped.resolve(stats);
  });
  // Register the failure handler before awaiting startup.
  void stopped.promise.catch(() => {});
  await ready.promise;
  return { stop: async () => {
    if (child.connected) child.send({ type: 'stop' });
    return stopped.promise;
  } };
}

if (process.argv[2] === '--serve') {
  const stats: ImposterStats = { connections: 0, requests: 0, bodyBytes: 0, pid: process.pid };
  const server = https.createServer({ key: IMPOSTER_KEY, cert: IMPOSTER_CERT }, (req, res) => {
    stats.requests++;
    req.on('data', chunk => { stats.bodyBytes += chunk.length; });
    req.on('end', () => res.end('{}'));
  });
  server.on('connection', () => stats.connections++);
  server.listen(Number(process.argv[3]), '127.0.0.1', () => process.send!({ type: 'ready' }));
  process.once('message', () => {
    server.close(() => {
      process.send!({ type: 'stats', stats }, undefined, undefined, () => process.disconnect!());
    });
    server.closeAllConnections();
  });
}
