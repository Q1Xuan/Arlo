import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ArloError, ArloErrorCode, validateExplicitGroupName } from '../protocol/index.ts';
import { encodeCommunicationGroup } from './encoding.ts';

const runFile = promisify(execFile);

function gitEnvironment(): NodeJS.ProcessEnv {
  // Shell Git state is not the root session's project context. This also
  // excludes injected config and trace destinations inherited by the host.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  // Git for Windows does not accept Node's extended \\.\nul spelling.
  const emptyConfig = process.platform === 'win32' ? 'NUL' : os.devNull;
  return {
    ...env, LC_ALL: 'C', LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
    // Project identity is local metadata, independent of global includes,
    // aliases and safe.directory exceptions. Git's default ownership check
    // remains enabled; project resolution never adds an ownership exception.
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_GLOBAL: emptyConfig,
    // Git 2.30 predates GIT_CONFIG_GLOBAL. A null device cannot contain
    // .gitconfig or git/config, so older Git also avoids ambient config.
    // These values apply only to this child, never the host environment.
    HOME: emptyConfig, XDG_CONFIG_HOME: emptyConfig,
  };
}

// An unreadable marker is not evidence that the directory is outside Git.
function hasEntry(filename: string): boolean {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new ArloError(ArloErrorCode.GIT_RESOLUTION_FAILED, 'Git metadata could not be inspected');
  }
}

function findGitMarker(directory: string): string | undefined {
  for (let current = directory; ; current = path.dirname(current)) {
    const marker = path.join(current, '.git');
    if (hasEntry(marker)) return marker;
    // Bare repositories have no .git entry. Two surviving structural entries
    // also prevent a damaged bare repository from becoming a directory group.
    const bareEntries = ['HEAD', 'objects', 'refs'].filter((name) => hasEntry(path.join(current, name)));
    if (bareEntries.length >= 2) return current;
    if (path.dirname(current) === current) return undefined;
  }
}

/** Directory values must come from trusted host state, never the process cwd. */
export interface ProjectGroupContext {
  groupName?: string;
  /** A Workspace directory whose binding to this root has been confirmed. */
  workspaceDir?: string;
  /** The directory recorded when this session was created. */
  sessionCwd?: string;
}

export interface ResolvedCommunicationGroup {
  groupId: string;
  groupName?: string;
  source: 'explicit' | 'git' | 'directory';
}

/** Validate the opaque project selection accepted only on the trusted control plane. */
export function validateProjectGroupId(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 75 || !/^grp_v1_(?:git|dir)_[0-9a-f]{64}$/.test(value)) {
    throw new ArloError(ArloErrorCode.INVALID_ARGUMENT, 'Unsupported project communication group encoding');
  }
  return value;
}

/** Resolve once at root registration; retain the result for that binding. */
export async function resolveCommunicationGroup(context: ProjectGroupContext = {}): Promise<ResolvedCommunicationGroup> {
  if (context.groupName !== undefined) {
    return { ...validateExplicitGroupName(context.groupName), source: 'explicit' };
  }
  const directory = context.workspaceDir !== undefined ? context.workspaceDir : context.sessionCwd;
  if (directory === undefined) {
    throw new ArloError(ArloErrorCode.GROUP_CONTEXT_REQUIRED, 'A trusted directory or an explicit communication group is required');
  }
  if (typeof directory !== 'string' || !directory || !path.isAbsolute(directory)) {
    throw new ArloError(ArloErrorCode.GROUP_DIRECTORY_UNAVAILABLE, 'The trusted directory must be an absolute path');
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(directory);
    if (!fs.statSync(canonical).isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new ArloError(ArloErrorCode.GROUP_DIRECTORY_UNAVAILABLE, 'The trusted directory is unavailable');
  }
  const marker = findGitMarker(canonical);
  let commonDir: string;
  try {
    const options = {
      encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, env: gitEnvironment(),
    } as const;
    // Automatic discovery preserves Git's ownership and repository checks.
    const { stdout } = await runFile('git', ['-C', canonical, 'rev-parse', '--git-common-dir'], options);
    // Older supported Git versions emit paths relative to -C. Anchor to that
    // trusted directory explicitly, never to the host process's current cwd.
    commonDir = fs.realpathSync.native(path.resolve(canonical, stdout.replace(/\n$/, '')));
    if (marker) {
      // Git can ignore an invalid nested .git directory and find a parent.
      // Require the nearest marker to independently resolve to that same repo.
      const exact = await runFile('git', ['-C', canonical, `--git-dir=${marker}`, 'rev-parse', '--git-common-dir'], options);
      if (fs.realpathSync.native(path.resolve(canonical, exact.stdout.replace(/\n$/, ''))) !== commonDir) {
        throw new ArloError(ArloErrorCode.GIT_METADATA_INVALID, 'Git project metadata is inconsistent');
      }
    }
  } catch (error) {
    if (error instanceof ArloError) throw error;
    const failure = error as { code?: string | number; stderr?: string };
    if (!marker && failure.code === 128 && /^fatal: not a git repository \(or any of the parent directories\): \.git\r?\n?$/.test(failure.stderr ?? '')) {
      return { groupId: encodeCommunicationGroup('dir', canonical), source: 'directory' };
    }
    if (marker && failure.code === 128 && /not a git repository|does not point to a valid repository|invalid gitfile format|bad config|invalid config/i.test(failure.stderr ?? '') &&
        !/permission denied|operation not permitted|access is denied|dubious ownership/i.test(failure.stderr ?? '')) {
      throw new ArloError(ArloErrorCode.GIT_METADATA_INVALID, 'Git project metadata is invalid');
    }
    throw new ArloError(ArloErrorCode.GIT_RESOLUTION_FAILED, 'Git project resolution failed');
  }
  return { groupId: encodeCommunicationGroup('git', commonDir), source: 'git' };
}
