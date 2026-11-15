import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

// Equivalent compiled artifacts, served through ordinary npm registry config.
// This fixture never intercepts the CLI's package-tool or host operations.
export async function componentDistribution(bundle) {
  const packages = new Map();
  for (const name of ['sdk', 'adapter-sdk', 'daemon', 'adapter-pi']) {
    const file = path.join(bundle, `arlo-${name}-0.1.0.tgz`);
    const manifest = spawnSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' });
    assert.equal(manifest.status, 0, manifest.stderr);
    packages.set(`@arlo/${name}`, { manifest: JSON.parse(manifest.stdout), bytes: fs.readFileSync(file), name });
  }
  const server = http.createServer((request, response) => {
    const route = decodeURIComponent(request.url).split('?')[0];
    const entry = packages.get(route.slice(1));
    if (entry) {
      const { manifest, bytes, name } = entry;
      const version = { ...manifest, dist: { tarball: `${url}/tarballs/${name}.tgz`,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: version } }));
    } else {
      const tarball = [...packages.values()].find(value => route === `/tarballs/${value.name}.tgz`);
      response.statusCode = tarball?.unavailable ? 503 : tarball ? 200 : 404;
      response.end(tarball?.unavailable ? 'component temporarily unavailable' : tarball?.bytes ?? JSON.stringify({ error: 'package not in equivalent distribution' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, packages, close: () => new Promise(resolve => server.close(resolve)) };
}

export async function commandProcess(executable, args, context, extra = {}) {
  const child = spawn(executable, args, { cwd: context.directory, env: { ...context.env, ...extra } });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  const [status, signal] = await once(child, 'exit');
  clearTimeout(timer);
  return { status, signal, stdout, stderr };
}
export const cliProcess = (cli, args, context, extra) => commandProcess(process.execPath, [cli, ...args], context, extra);
