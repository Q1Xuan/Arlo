import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveCommunicationGroup, validateExplicitGroupName, validateProjectGroupId, ArloErrorCode, getCurrentUserSid } from '@arlo/sdk';
import { createTempDir, removeTempDir } from './test-utils.ts';

const originalEnvironment = { ...process.env };
let isolatedHome: string;

before(() => {
  isolatedHome = createTempDir('project-test-home');
  // Resolver Git processes must not read the user's global config or includes.
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.XDG_CONFIG_HOME = isolatedHome;
});

after(() => {
  for (const name of Object.keys(process.env)) if (!(name in originalEnvironment)) delete process.env[name];
  Object.assign(process.env, originalEnvironment);
  removeTempDir(isolatedHome);
});

function git(fixture: string, args: string[]): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  execFileSync('git', [
    '-c', `core.hooksPath=${path.join(fixture, 'disabled-hooks')}`,
    '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'init.templateDir=', ...args,
  ], {
    windowsHide: true,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  });
}

test('Communication Group uses explicit configuration without needing a reliable project directory', async () => {
  const selected = await resolveCommunicationGroup({ groupName: '  cafe\u0301  ', sessionCwd: 'not-absolute' });
  assert.equal(selected.source, 'explicit');
  assert.equal(selected.groupName, 'caf\u00e9');
  assert.equal(selected.groupId, validateExplicitGroupName('caf\u00e9').groupId);
  await assert.rejects(resolveCommunicationGroup({ groupName: '', sessionCwd: process.cwd() }), {
    code: ArloErrorCode.INVALID_ARGUMENT,
  });
});

test('Communication Group requires an absolute trusted directory instead of using process cwd', async () => {
  await assert.rejects(resolveCommunicationGroup(), { code: 'GROUP_CONTEXT_REQUIRED' });
  await assert.rejects(resolveCommunicationGroup({ sessionCwd: '.' }), { code: 'GROUP_DIRECTORY_UNAVAILABLE' });
  await assert.rejects(resolveCommunicationGroup({ workspaceDir: '', sessionCwd: process.cwd() }), {
    code: 'GROUP_DIRECTORY_UNAVAILABLE',
  });
});

test('Communication Group shares Git common-dir across main and worktree but separates clones and nested repositories', async () => {
  const fixture = createTempDir('project-git');
  try {
    const main = path.join(fixture, 'main');
    const worktree = path.join(fixture, 'worktree');
    const clone = path.join(fixture, 'clone');
    const nested = path.join(main, 'nested');
    git(fixture, ['init', '-q', main]);
    git(fixture, ['-C', main, '-c', 'user.name=Arlo Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
    git(fixture, ['-C', main, 'worktree', 'add', '-qb', 'test-worktree', worktree]);
    git(fixture, ['clone', '-q', main, clone]);
    git(fixture, ['-C', main, 'remote', 'add', 'origin', 'https://example.invalid/same.git']);
    git(fixture, ['-C', clone, 'remote', 'set-url', 'origin', 'https://example.invalid/same.git']);
    git(fixture, ['init', '-q', nested]);
    const mainGroup = await resolveCommunicationGroup({ sessionCwd: main });
    const worktreeGroup = await resolveCommunicationGroup({ sessionCwd: worktree });
    const cloneGroup = await resolveCommunicationGroup({ sessionCwd: clone });
    const nestedGroup = await resolveCommunicationGroup({ sessionCwd: nested });
    assert.equal(mainGroup.source, 'git');
    assert.match(mainGroup.groupId, /^grp_v1_git_[a-f0-9]{64}$/);
    assert.equal(mainGroup.groupId, worktreeGroup.groupId);
    assert.notEqual(mainGroup.groupId, cloneGroup.groupId);
    assert.notEqual(mainGroup.groupId, nestedGroup.groupId);
  } finally {
    removeTempDir(fixture);
  }
});

test('Communication Group uses confirmed non-Git Workspace before session creation directory and resolves directory aliases', async () => {
  const fixture = createTempDir('project-directory');
  try {
    const workspace = path.join(fixture, 'Workspace');
    const session = path.join(fixture, 'Session');
    const alias = path.join(fixture, 'alias');
    fs.mkdirSync(workspace);
    fs.mkdirSync(session);
    fs.symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const workspaceGroup = await resolveCommunicationGroup({ workspaceDir: workspace, sessionCwd: session });
    const sessionGroup = await resolveCommunicationGroup({ sessionCwd: session });
    const aliasGroup = await resolveCommunicationGroup({ sessionCwd: alias });
    assert.equal(workspaceGroup.source, 'directory');
    assert.match(workspaceGroup.groupId, /^grp_v1_dir_[a-f0-9]{64}$/);
    assert.equal(workspaceGroup.groupId, aliasGroup.groupId);
    assert.notEqual(workspaceGroup.groupId, sessionGroup.groupId);
    if (process.platform === 'win32') {
      assert.equal((await resolveCommunicationGroup({ sessionCwd: workspace.toUpperCase() })).groupId, workspaceGroup.groupId);
    }
    await assert.rejects(resolveCommunicationGroup({ workspaceDir: path.join(fixture, 'absent'), sessionCwd: session }), {
      code: 'GROUP_DIRECTORY_UNAVAILABLE',
    });
    await assert.rejects(resolveCommunicationGroup({ sessionCwd: path.join(fixture, '.test-owner.json') }), {
      code: 'GROUP_DIRECTORY_UNAVAILABLE',
    });
  } finally {
    removeTempDir(fixture);
  }
});

test('Communication Group rejects damaged Git metadata even inside a valid parent repository', async () => {
  const fixture = createTempDir('project-damaged');
  try {
    git(fixture, ['init', '-q', fixture]);
    const nested = path.join(fixture, 'nested');
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    await assert.rejects(resolveCommunicationGroup({ sessionCwd: nested }), { code: 'GIT_METADATA_INVALID' });
    const worktree = path.join(fixture, 'bad-worktree');
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: no-longer-exists\n');
    await assert.rejects(resolveCommunicationGroup({ sessionCwd: worktree }), { code: 'GIT_METADATA_INVALID' });
  } finally {
    removeTempDir(fixture);
  }
});

test('Communication Group ignores inherited Git repository and discovery overrides', async () => {
  const fixture = createTempDir('project-environment');
  const previous = { ...process.env };
  try {
    const selected = path.join(fixture, 'selected');
    const unrelated = path.join(fixture, 'unrelated');
    const plain = path.join(fixture, 'plain');
    git(fixture, ['init', '-q', selected]);
    git(fixture, ['init', '-q', unrelated]);
    fs.mkdirSync(plain);
    const expected = await resolveCommunicationGroup({ sessionCwd: selected });
    process.env.GIT_DIR = path.join(unrelated, '.git');
    process.env.GIT_COMMON_DIR = path.join(unrelated, '.git');
    process.env.GIT_WORK_TREE = unrelated;
    process.env.GIT_CEILING_DIRECTORIES = fixture;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.repositoryFormatVersion';
    process.env.GIT_CONFIG_VALUE_0 = '999';
    assert.equal((await resolveCommunicationGroup({ sessionCwd: selected })).groupId, expected.groupId);
    assert.equal((await resolveCommunicationGroup({ sessionCwd: plain })).source, 'directory');
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    removeTempDir(fixture);
  }
});

test('Communication Group validates opaque project categories without accepting explicit names or unsupported encodings', async () => {
  const fixture = createTempDir('project-encoding');
  try {
    const directory = await resolveCommunicationGroup({ sessionCwd: fixture });
    git(fixture, ['init', '-q', fixture]);
    const gitGroup = await resolveCommunicationGroup({ sessionCwd: fixture });
    assert.notEqual(directory.groupId, gitGroup.groupId);
    assert.equal(validateProjectGroupId(directory.groupId), directory.groupId);
    assert.equal(validateProjectGroupId(gitGroup.groupId), gitGroup.groupId);
    for (const invalid of [validateExplicitGroupName('team').groupId, directory.groupId.replace('v1', 'v2'), 'team', '', null, {}, ` ${gitGroup.groupId}`, `${gitGroup.groupId}\n`]) {
      assert.throws(() => validateProjectGroupId(invalid), { code: ArloErrorCode.INVALID_ARGUMENT });
    }
    // Even a name resembling a project namespace remains an explicit group.
    assert.match(validateExplicitGroupName('grp_v1_git_project').groupId, /^grp_v1_exp_/);
  } finally {
    removeTempDir(fixture);
  }
});

test('Communication Group reports a missing Git executable as resolution failure, never non-Git success', async () => {
  const fixture = createTempDir('project-missing-git');
  const previous = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) if (name.toLowerCase() === 'path') process.env[name] = fixture;
    await assert.rejects(resolveCommunicationGroup({ sessionCwd: fixture }), { code: 'GIT_RESOLUTION_FAILED' });
    assert.equal((await resolveCommunicationGroup({ groupName: 'explicit-still-works' })).source, 'explicit');
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    removeTempDir(fixture);
  }
});

test('Communication Group rejects Windows Git config permission errors without directory fallback', { skip: process.platform !== 'win32' }, async () => {
  const fixture = createTempDir('project-permissions');
  const config = path.join(fixture, '.git', 'config');
  const sid = getCurrentUserSid();
  try {
    git(fixture, ['init', '-q', fixture]);
    // Deny only read data: a full R denial also blocks the permission guard's
    // native realpath (GENERIC_READ) on non-admin accounts, so restore would
    // fail before icacls could run. Read data alone still makes Git fail closed.
    execFileSync('icacls.exe', [config, '/deny', `*${sid}:(RD)`], { windowsHide: true, stdio: 'pipe' });
    await assert.rejects(resolveCommunicationGroup({ sessionCwd: fixture }), { code: 'GIT_RESOLUTION_FAILED' });
  } finally {
    if (fs.existsSync(config)) execFileSync('icacls.exe', [config, '/remove:d', `*${sid}`], { windowsHide: true, stdio: 'pipe' });
    removeTempDir(fixture);
  }
});

test('Communication Group preserves Git dubious-ownership rejection on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = createTempDir('project-owner');
  const metadata = path.join(fixture, '.git');
  const sid = getCurrentUserSid();
  let changedOwner = false;
  try {
    git(fixture, ['init', '-q', fixture]);
    try {
      execFileSync('icacls.exe', [metadata, '/setowner', '*S-1-5-18'], { windowsHide: true, stdio: 'pipe' });
      changedOwner = true;
    } catch {
      t.skip('Changing the owned fixture metadata owner requires Windows administrator capability');
      return;
    }
    await assert.rejects(resolveCommunicationGroup({ sessionCwd: fixture }), { code: 'GIT_RESOLUTION_FAILED' });
  } finally {
    if (changedOwner) execFileSync('icacls.exe', [metadata, '/setowner', `*${sid}`], { windowsHide: true, stdio: 'pipe' });
    removeTempDir(fixture);
  }
});

test('Communication Group does not load ambient global Git configuration', async () => {
  const fixture = createTempDir('project-global-config');
  const config = path.join(isolatedHome, '.gitconfig');
  try {
    fs.writeFileSync(config, 'this is deliberately invalid global config\n');
    assert.equal((await resolveCommunicationGroup({ sessionCwd: fixture })).source, 'directory');
  } finally {
    fs.unlinkSync(config);
    removeTempDir(fixture);
  }
});

test('Communication Group preserves distinct Linux path case and symbolic-link identity', { skip: process.platform !== 'linux' }, async () => {
  const fixture = createTempDir('project-linux-paths');
  try {
    const upper = path.join(fixture, 'Project');
    const lower = path.join(fixture, 'project');
    const alias = path.join(fixture, 'project-alias');
    fs.mkdirSync(upper);
    fs.mkdirSync(lower);
    fs.symlinkSync(upper, alias, 'dir');
    const upperGroup = await resolveCommunicationGroup({ sessionCwd: upper });
    assert.notEqual(upperGroup.groupId, (await resolveCommunicationGroup({ sessionCwd: lower })).groupId);
    assert.equal(upperGroup.groupId, (await resolveCommunicationGroup({ sessionCwd: alias })).groupId);
  } finally {
    removeTempDir(fixture);
  }
});

test('Communication Group rejects actual Linux Git metadata permission errors', { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, async () => {
  const fixture = createTempDir('project-linux-permissions');
  const config = path.join(fixture, '.git', 'config');
  try {
    git(fixture, ['init', '-q', fixture]);
    fs.chmodSync(config, 0);
    await assert.rejects(resolveCommunicationGroup({ sessionCwd: fixture }), { code: 'GIT_RESOLUTION_FAILED' });
  } finally {
    if (fs.existsSync(config)) fs.chmodSync(config, 0o600);
    removeTempDir(fixture);
  }
});
