import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { enforceWindowsAcl, getCurrentUserSid, ArloErrorCode } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

for (const mode of ['spawn-error', 'esm']) {
  test(`Windows ACL inspector ${mode === 'spawn-error' ? 'fails closed without crashing after PowerShell spawn failure' : 'survives a caller using --input-type=module'}`, { timeout: 15000 }, () => {
    const root = createTempDir(`acl-${mode}`);
    try {
      const fixture = new URL('./fixtures/windows-acl-inspector-probe.mjs', import.meta.url).href;
      const child = cp.spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(fixture)})`], {
        env: { ...process.env, ARLO_ACL_PROBE_MODE: mode, ARLO_ACL_PROBE_TARGET: root },
        encoding: 'utf8', timeout: 12000, windowsHide: true,
      });
      assert.equal(child.error, undefined, String(child.error));
      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
      assert.match(child.stdout, /INSPECTION_RESULT /);
      assert.match(child.stdout, /CALLER_ALIVE/);
    } finally { removeTempDir(root); }
  });
}

test('Windows ACL verification rejects public access despite a squatter on the previous predictable inspector pipe',
  { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
    const root = createTempDir('acl-pipe-squatter');
    const target = path.join(root, 'public.token');
    fs.writeFileSync(target, 'public-acl-canary\n');
    enforceWindowsAcl(target, false);
    cp.execFileSync('icacls.exe', [target, '/grant', '*S-1-1-0:R'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const sid = getCurrentUserSid();
    const child = cp.spawn(process.execPath, [fileURLToPath(new URL('./fixtures/windows-acl-pipe-squatter.mjs', import.meta.url))], {
      env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', chunk => { output += chunk; });
    const exited = once(child, 'exit');
    const sockets = new Set<net.Socket>();
    let requests = 0;
    const squatter = net.createServer(socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let buffered = '';
      socket.on('data', bytes => {
        buffered += bytes.toString('utf8');
        for (let end; (end = buffered.indexOf('\n')) >= 0;) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (line === 'exit') { socket.end(); return; }
          const paths = JSON.parse(line) as string[];
          requests++;
          const forged = Object.fromEntries(paths.map(filename => [filename, {
            owner: sid, rules: [`${sid}:Allow:FullControl:None:2032127`], isReparse: false, canRead: true,
          }]));
          socket.write(`${JSON.stringify(forged)}\n`);
        }
      });
    });
    const controller = new AbortController();
    const reply = (command?: object) => {
      const message = once(child, 'message', { signal: controller.signal });
      if (command) child.send(command);
      return Promise.race([
        message.then(([value]) => value),
        exited.then(() => { throw new Error(`ACL inspection child exited: ${output}`); }),
        delay(60000, undefined, { signal: controller.signal }).then(() => { throw new Error(`ACL inspection IPC deadline: ${output}`); }),
      ]);
    };
    try {
      assert.equal((await reply()).ready, true);
      // The attack owns the old first-use name before the child is allowed to
      // inspect anything. Its forged answer claims the public file is private.
      squatter.listen(`\\\\.\\pipe\\ArloAcl-${child.pid}-1`);
      await once(squatter, 'listening');
      const answer = await reply({ command: 'inspect', target });
      assert.equal(answer.result.valid, false, 'A pipe peer must not replace the target file ACL with forged private metadata');
      assert.equal(answer.result.errorCode, ArloErrorCode.INSECURE_PERMISSIONS);
      assert.ok(answer.inspection.rules.some((rule: string) => rule.startsWith('S-1-1-0:Allow:')),
        'The inspector must observe the actual public grant');
      assert.equal(requests, 0, 'The pre-created predictable pipe must receive no inspection request');
    } finally {
      controller.abort();
      if (child.connected) child.disconnect();
      const stopController = new AbortController();
      try {
        await Promise.race([
          exited,
          delay(5000, undefined, { signal: stopController.signal }).then(async () => {
            child.kill();
            await exited;
          }),
        ]);
      } finally { stopController.abort(); }
      for (const socket of sockets) socket.destroy();
      if (squatter.listening) await new Promise<void>(resolve => squatter.close(() => resolve()));
      removeTempDir(root);
    }
  });
