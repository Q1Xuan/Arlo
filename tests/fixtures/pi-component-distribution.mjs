import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

// Equivalent compiled artifacts, served through ordinary npm registry config.
// This fixture never intercepts the CLI's package-tool or host operations.
export async function componentDistribution(bundle, adapter = 'adapter-pi') {
  const packages = new Map();
  for (const name of ['sdk', 'adapter-sdk', 'daemon', adapter]) {
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

export async function commandProcess(executable, args, context, extra = {}, timeout = 120_000) {
  const env = { ...context.env, ...extra };
  // Public dependency/tool fixtures may be reused without caching the Arlo
  // archives served by this test's registry. Every case keeps its own cache.
  if (process.env.ARLO_CLI_PUBLIC_NPM_CACHE) {
    const cache = env.npm_config_cache ?? path.join(context.directory, '.npm');
    if (!fs.existsSync(cache)) fs.cpSync(process.env.ARLO_CLI_PUBLIC_NPM_CACHE, cache, { recursive: true });
    env.npm_config_cache = cache;
  }
  if (process.env.ARLO_CLI_PUBLIC_PNPM_CACHE) {
    const cache = path.join(env.XDG_CACHE_HOME ?? context.directory, 'pnpm');
    if (!fs.existsSync(cache)) fs.cpSync(process.env.ARLO_CLI_PUBLIC_PNPM_CACHE, cache, { recursive: true });
  }
  if (process.env.ARLO_CLI_PUBLIC_PNPM_STORE) {
    const store = path.join(env.XDG_DATA_HOME ?? context.directory, 'pnpm/store');
    if (!fs.existsSync(store)) fs.cpSync(process.env.ARLO_CLI_PUBLIC_PNPM_STORE, store, { recursive: true });
    env.npm_config_store_dir ??= store;
  }
  const child = spawn(executable, args, { cwd: context.directory, env });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const [status, signal] = await once(child, 'exit');
  clearTimeout(timer);
  return { status, signal, stdout, stderr };
}
export const cliProcess = (cli, args, context, extra, timeout) => commandProcess(process.execPath, [cli, ...args], context, extra, timeout);
