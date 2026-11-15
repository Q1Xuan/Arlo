import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArloDaemon } from '@arlo/daemon';
import { createTempDir, removeTempDir, UNPACED_RATE_LIMIT } from './test-utils.ts';
import type { HarnessCommand, HarnessConfiguration } from './fixtures/harness-worker.ts';

function startHarness(stateDir: string, profileDir: string, configuration: HarnessConfiguration) {
  const child = spawn(process.execPath, [
    '--import', new URL('../probes/isolation.mjs', import.meta.url).href,
    fileURLToPath(new URL('./fixtures/harness-worker.ts', import.meta.url)),
  ], {
    cwd: profileDir,
    windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      HOME: profileDir, USERPROFILE: profileDir, APPDATA: profileDir, LOCALAPPDATA: profileDir,
      XDG_CONFIG_HOME: profileDir, XDG_DATA_HOME: profileDir, XDG_CACHE_HOME: profileDir,
      TEMP: profileDir, TMP: profileDir, TMPDIR: profileDir,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(profileDir, 'empty-gitconfig'),
      ARLO_STATE_DIR: stateDir, ARLO_HARNESS_CONFIG: JSON.stringify(configuration),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const ready = Promise.withResolvers<number>();
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
  let sequence = 0;
  let output = '';
  child.stdout!.on('data', chunk => { output = (output + chunk).slice(-65536); });
  child.stderr!.on('data', chunk => { output = (output + chunk).slice(-65536); });
  const fail = (error: Error) => {
    ready.reject(error);
    for (const response of pending.values()) response.reject(error);
  };
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`Harness exited with code ${code}: ${output}`)));
  child.on('message', (message: { ready?: boolean; pid: number; id: number; result?: unknown; error?: string }) => {
    if (message.ready) ready.resolve(message.pid);
    else if (message.error) pending.get(message.id)?.reject(new Error(message.error));
    else pending.get(message.id)?.resolve(message.result);
  });
  const startupTimer = setTimeout(() => ready.reject(new Error(`Harness startup timed out: ${output}`)), 20000);
  void ready.promise.then(() => clearTimeout(startupTimer), () => clearTimeout(startupTimer));

  async function request(command: HarnessCommand) {
    const id = ++sequence;
    const response = Promise.withResolvers<any>();
    pending.set(id, response);
    const timer = setTimeout(() => response.reject(new Error(`Harness ${command.action} timed out`)), 20000);
    try {
      child.send({ id, command }, error => { if (error) response.reject(error); });
      return await response.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }

  return {
    ready: ready.promise,
    request,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const timer = setTimeout(() => child.kill(), 5000);
      try {
        if (child.connected) await request({ action: 'stop' }).catch(() => {});
        else child.kill();
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

type Harness = ReturnType<typeof startHarness>;
const toolText = (message: any): string => message.content
  .filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
const list = async (worker: Harness): Promise<Array<{ endpoint_id: string }>> =>
  JSON.parse(toolText(await worker.request({ action: 'tool', name: 'arlo_list_sessions', args: {} })));
const send = async (worker: Harness, to: string, text: string) =>
  toolText(await worker.request({ action: 'tool', name: 'arlo_send_message', args: { to, text } }));

function projectFixture() {
  const owned = createTempDir('project-groups-processes');
  const mkdir = (name: string) => {
    const dir = path.join(owned, name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', `core.hooksPath=${path.join(owned, 'disabled-hooks')}`,
    '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'init.templateDir=', ...args,
  ], {
    cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
      HOME: owned, USERPROFILE: owned, XDG_CONFIG_HOME: owned,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(owned, 'empty-gitconfig'),
      GIT_AUTHOR_NAME: 'Arlo Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Arlo Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
  const repo = mkdir('repository');
  git(repo, 'init', '--quiet');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'owned acceptance fixture');
  git(repo, 'remote', 'add', 'origin', 'https://example.invalid/same-remote');
  const worktree = path.join(owned, 'worktree');
  git(repo, 'worktree', 'add', '--quiet', '--detach', worktree);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(worktree, 'src'));
  const clone = path.join(owned, 'clone');
  git(owned, 'clone', '--quiet', '--no-hardlinks', repo, clone);
  git(clone, 'remote', 'set-url', 'origin', 'https://example.invalid/same-remote');
  const nested = mkdir('repository/nested');
  git(nested, 'init', '--quiet');
  git(nested, 'remote', 'add', 'origin', 'https://example.invalid/same-remote');
  return { owned, mkdir, repo, worktree, clone, nested };
}

test('Independent Harness processes share repository and worktree defaults, frozen despite cwd and late Workspace changes', { timeout: 90000 }, async () => {
  const project = projectFixture();
  const daemon = new ArloDaemon({ stateDir: project.mkdir('state'), rateLimit: UNPACED_RATE_LIMIT });
  const workers: Harness[] = [];
  try {
    await daemon.start();
    const a = startHarness(daemon.stateDir, project.mkdir('profile-a'), { sessionCwd: path.join(project.repo, 'src') });
    const b = startHarness(daemon.stateDir, project.mkdir('profile-b'), { sessionCwd: path.join(project.worktree, 'src') });
    workers.push(a, b);
    const [pidA, pidB] = await Promise.all([a.ready, b.ready]);
    assert.notEqual(pidA, pidB);
    assert.notEqual(pidA, process.pid);
    assert.notEqual(pidB, process.pid);
    const [target] = await list(a);
    assert.ok(target, 'The worktree root must be discoverable from the main repository');
    assert.equal((await list(a)).length, 1, 'Only the other root is exposed, never its child');
    assert.equal(JSON.parse(await send(a, target.endpoint_id, 'repository-to-worktree')).status, 'accepted');
    const received = await b.request({ action: 'snapshot' });
    assert.equal(received.messages.filter((message: any) => message.content[0]?.text === 'repository-to-worktree').length, 1);
    assert.equal(received.childMessages, 0);
    await b.request({ action: 'change-context', cwd: project.clone, workspaceDir: project.clone });
    assert.deepEqual(await list(a), [target]);
    assert.equal(JSON.parse(await send(a, target.endpoint_id, 'still-frozen')).status, 'accepted');
    assert.equal((await b.request({ action: 'snapshot' })).messages.filter((message: any) => message.content[0]?.text === 'still-frozen').length, 1);
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await daemon.stop();
    removeTempDir(project.owned);
  }
});

test('Independent Harness discovery and delivery enforce clone, nested repository, filesystem alias and Workspace boundaries', { timeout: 180000 }, async t => {
  const project = projectFixture();
  const daemon = new ArloDaemon({ stateDir: project.mkdir('state'), rateLimit: UNPACED_RATE_LIMIT });
  const alias = path.join(project.owned, 'repository-alias');
  fs.symlinkSync(project.repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const scenarios: Array<{ name: string; a: HarnessConfiguration; b: HarnessConfiguration; reachable: boolean }> = [
    {
      name: 'Independent clone with the same remote stays isolated',
      a: { sessionCwd: project.repo }, b: { sessionCwd: project.clone }, reachable: false,
    },
    {
      name: 'Nested independent repository with the same remote stays isolated',
      a: { sessionCwd: project.repo }, b: { sessionCwd: project.nested }, reachable: false,
    },
    {
      name: process.platform === 'win32' ? 'Real Windows junction and case alias reaches the repository' : 'Real Linux symlink reaches the repository',
      a: { sessionCwd: project.repo },
      b: { sessionCwd: process.platform === 'win32' ? alias.toUpperCase() : alias }, reachable: true,
    },
    {
      name: 'Confirmed Workspace takes precedence over the session creation directory',
      a: { sessionCwd: project.repo },
      b: { sessionCwd: project.clone, workspaceDir: project.worktree }, reachable: true,
    },
  ];
  if (process.platform === 'linux') {
    scenarios.push({
      name: 'Distinct Linux non-Git directories differing only by case remain isolated',
      a: { sessionCwd: project.mkdir('CaseProject') },
      b: { sessionCwd: project.mkdir('caseproject') }, reachable: false,
    });
  }
  try {
    await daemon.start();
    for (const [index, scenario] of scenarios.entries()) {
      await t.test(scenario.name, async () => {
        const a = startHarness(daemon.stateDir, project.mkdir(`profile-${index}-a`), scenario.a);
        const b = startHarness(daemon.stateDir, project.mkdir(`profile-${index}-b`), scenario.b);
        try {
          const [pidA, pidB] = await Promise.all([a.ready, b.ready]);
          assert.notEqual(pidA, pidB);
          const endpointA = (await a.request({ action: 'snapshot' })).endpoint_id;
          const endpointB = (await b.request({ action: 'snapshot' })).endpoint_id;
          const [fromA, fromB] = await Promise.all([list(a), list(b)]);
          assert.deepEqual(fromA.map(session => session.endpoint_id), scenario.reachable ? [endpointB] : []);
          assert.deepEqual(fromB.map(session => session.endpoint_id), scenario.reachable ? [endpointA] : []);
          const text = `boundary-${index}-受控本地消息`;
          const outcome = await send(a, endpointB, text);
          if (scenario.reachable) assert.equal(JSON.parse(outcome).status, 'accepted');
          else assert.match(outcome, /GROUP_MISMATCH/);
          const received = await b.request({ action: 'snapshot' });
          assert.equal(received.messages.filter((message: any) => message.content[0]?.text === text).length, scenario.reachable ? 1 : 0);
          assert.equal(received.childMessages, 0);
        } finally {
          await Promise.all([a.stop(), b.stop()]);
        }
      });
    }
  } finally {
    await daemon.stop();
    removeTempDir(project.owned);
  }
});

test('Trusted group switching across independent projects revokes the old endpoint and preserves old host input without migration', { timeout: 90000 }, async () => {
  const project = projectFixture();
  const daemon = new ArloDaemon({ stateDir: project.mkdir('state'), rateLimit: UNPACED_RATE_LIMIT });
  const workers: Harness[] = [];
  try {
    await daemon.start();
    const a = startHarness(daemon.stateDir, project.mkdir('profile-a'), { sessionCwd: project.repo, groupName: 'initial-collaboration' });
    const b = startHarness(daemon.stateDir, project.mkdir('profile-b'), { sessionCwd: project.clone, groupName: 'initial-collaboration' });
    workers.push(a, b);
    await Promise.all([a.ready, b.ready]);
    const [target] = await list(a);
    assert.ok(target, 'Trusted explicit configuration permits cross-project communication');
    await b.request({ action: 'hold' });
    const original = JSON.parse(await send(a, target.endpoint_id, 'old-group-pending-message'));
    assert.equal(original.status, 'accepted');
    const before = await b.request({ action: 'snapshot' });
    assert.equal(before.pending.length, 1);

    const blocked = await b.request({ action: 'switch-group', groupName: 'next-collaboration' });
    assert.deepEqual(blocked, { switched: false, error: 'ACCOUNTING_UNAVAILABLE' });
    assert.deepEqual(await list(a), [], 'Revocation holds even when new readiness fails');
    assert.match(await send(a, target.endpoint_id, 'stale-endpoint-message'), /TARGET_UNAVAILABLE/);
    const stillPending = await b.request({ action: 'snapshot' });
    assert.equal(stillPending.pid, before.pid);
    assert.deepEqual(stillPending.pending, before.pending, 'Switching must not drop, rewrite or duplicate accepted host input');
    const oldStatus = JSON.parse(toolText(await a.request({
      action: 'tool', name: 'arlo_get_message_status', args: { message_id: original.message_id },
    })));
    assert.equal(oldStatus.status, 'accepted');
    assert.equal(oldStatus.to_endpoint, target.endpoint_id, 'Old receipt evidence retains the original endpoint');

    await b.request({ action: 'release' });
    const switched = await b.request({ action: 'switch-group', groupName: 'next-collaboration' });
    assert.equal(switched.switched, true);
    assert.notEqual(switched.endpoint_id, target.endpoint_id);
    assert.deepEqual(await list(a), []);
    assert.match(await send(a, switched.endpoint_id, 'wrong-group-message'), /GROUP_MISMATCH/);
    assert.equal((await a.request({ action: 'switch-group', groupName: 'next-collaboration' })).switched, true);
    assert.deepEqual((await list(a)).map(session => session.endpoint_id), [switched.endpoint_id]);
    assert.equal(JSON.parse(await send(a, switched.endpoint_id, 'new-group-message')).status, 'accepted');
    const after = await b.request({ action: 'snapshot' });
    assert.equal(after.pid, before.pid);
    assert.equal(after.pending.length, 0);
    for (const text of ['old-group-pending-message', 'new-group-message']) {
      assert.equal(after.messages.filter((message: any) => message.content[0]?.text === text).length, 1);
    }
    for (const text of ['stale-endpoint-message', 'wrong-group-message']) {
      assert.equal(after.messages.some((message: any) => message.content[0]?.text === text), false);
    }
    assert.equal(after.childMessages, 0);
  } finally {
    await Promise.all(workers.map(worker => worker.stop()));
    await daemon.stop();
    removeTempDir(project.owned);
  }
});
