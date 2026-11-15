import https from 'node:https';
import { IMPOSTER_CERT, IMPOSTER_KEY } from '../../probes/tls-fixtures.ts';

let requests = 0;
let plaintextBytes = 0;
let tlsErrors = 0;
const server = https.createServer({ key: IMPOSTER_KEY, cert: IMPOSTER_CERT }, (req, res) => {
  requests++;
  req.resume();
  req.on('end', () => res.end('{}'));
});
server.on('secureConnection', socket => socket.on('data', chunk => { plaintextBytes += chunk.length; }));
server.on('tlsClientError', () => { tlsErrors++; });
server.on('error', () => { process.exitCode = 1; process.disconnect?.(); });
process.on('message', (message: { command: string; port?: number }) => {
  if (message.command === 'listen') {
    server.listen(message.port, '127.0.0.1', () => {
      const address = server.address();
      process.send?.({ ready: true, port: typeof address === 'object' ? address?.port : undefined });
    });
  } else if (message.command === 'inspect') {
    process.send?.({ requests, plaintextBytes, tlsErrors });
  }
});
process.on('disconnect', () => {
  server.closeAllConnections();
  server.close();
});
