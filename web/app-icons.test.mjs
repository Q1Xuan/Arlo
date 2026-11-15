import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const consumer = path.resolve(process.argv[2] ?? '.artifacts/private-web/consumer');
const require = createRequire(path.join(consumer, 'package.json'));
const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const { apply } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-host-open-in-app')).href);
// A known PNG, independent of the Host's icon implementation.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64');

test('installed application icon HTTP route preserves real icons and serves a generic fallback for detected applications',
  { skip: process.platform !== 'linux' }, async t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-app-icons-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const previous = Object.fromEntries(['HOME', 'XDG_DATA_HOME', 'XDG_DATA_DIRS'].map(key => [key, process.env[key]]));
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    process.env.HOME = temporary;
    process.env.XDG_DATA_HOME = temporary;
    process.env.XDG_DATA_DIRS = temporary;
    fs.mkdirSync(path.join(temporary, 'applications'));
    const image = path.join(temporary, 'cursor.png');
    fs.writeFileSync(image, png);
    const desktop = path.join(temporary, 'applications/cursor.desktop');
    for (const hasIcon of [true, false]) {
      await t.test(hasIcon ? 'extractable desktop icon' : 'detected Cursor without extractable icon', async () => {
        fs.writeFileSync(desktop, `[Desktop Entry]\nType=Application\nName=Cursor\nExec=cursor\nIcon=${hasIcon ? image : 'arlo-missing-icon'}\n`);
        const routes = [];
        const disposals = [];
        // The carrier supplies only HTTP registration, authentication and PATH
        // discovery. The installed plugin owns catalog, extraction and responses.
        apply({
          get: () => undefined,
          effect: start => { disposals.push(start()); },
          webServer: { register: route => { routes.push(route); return () => {}; } },
          connection: { requestRejection: request => request.headers.authorization === 'Bearer icon-test' ? undefined : 401 },
          subprocess: { resolveExecutable: async name => name === 'cursor' ? process.execPath : null },
        }, { probeTimeoutMs: 1000, iconTimeoutMs: 1000, launchWatchMs: 100 });
        const server = http.createServer((request, response) => {
          const route = routes.find(route => route.kind === 'exact' ? request.url === route.path : request.url.startsWith(route.path + '/'));
          if (!route) return response.writeHead(404).end();
          void route.handler(request, response).catch(error => response.writeHead(500).end(String(error)));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
          const origin = `http://127.0.0.1:${server.address().port}`;
          const headers = { authorization: 'Bearer icon-test' };
          const apps = await fetch(`${origin}/open-in-app/apps`, { headers });
          assert.ok((await apps.json()).apps.includes('cursor'), 'Icon failure must not remove the detected application');
          const response = await fetch(`${origin}/open-in-app/icon/cursor`, { headers });
          assert.equal(response.status, 200, 'A detected application must have a usable icon or fallback');
          const bytes = Buffer.from(await response.arrayBuffer());
          if (hasIcon) {
            assert.match(response.headers.get('content-type'), /^image\/png/);
            assert.deepEqual(bytes, png);
          } else {
            assert.match(response.headers.get('content-type'), /^image\/svg\+xml/);
            assert.match(bytes.toString(), /<svg\b/);
            assert.match(bytes.toString(), /<title>Open application<\/title>/);
            assert.equal(response.headers.get('cache-control'), 'no-store');
          }
          assert.equal((await fetch(`${origin}/open-in-app/icon/cursor`)).status, 401);
          assert.equal((await fetch(`${origin}/open-in-app/icon/cursor`, { headers, method: 'POST' })).status, 405);
          assert.equal((await fetch(`${origin}/open-in-app/icon/unknown`, { headers })).status, 404);
          assert.equal((await fetch(`${origin}/open-in-app/icon/vscode`, { headers })).status, 404);
        } finally {
          await new Promise(resolve => server.close(resolve));
          for (const dispose of disposals.reverse()) dispose?.();
        }
      });
    }
  });
