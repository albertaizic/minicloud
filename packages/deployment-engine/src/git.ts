// Git operations: clone public repositories into the MiniCloud workspace.
// Security: repository URLs are validated by @minicloud/shared before reaching
// this module; git is invoked via execFile with an argument array — never a
// shell string — so URLs cannot inject commands.
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class CloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloneError';
  }
}

const LOCAL_GIT_RE = /^https?:\/\/localhost(:\d+)?\/[\w~%.\-]+(\.git)?$/;

export function isValidGitUrl(url: string): boolean {
  // Public https/ssh remotes, plus http(s) on localhost for local dev servers.
  // Never file:// or raw filesystem paths.
  if (LOCAL_GIT_RE.test(url)) return !/[\r\n;&|`$<>]/.test(url);
  return /^(https:\/\/[^\s]+|git@[^\s]+:[^\s]+)$/.test(url) && !/[\r\n;&|`$<>]/.test(url);
}

const SHA_RE = /^[0-9a-f]{40}$/i;

export interface ClonedRepo {
  dir: string;
  commitSha: string;
  /** Removes the cloned directory. Safe to call multiple times. */
  cleanup: () => Promise<void>;
}

/**
 * Shallow-clone a public repository at an optional ref into
 * `<workspace>/<random tmp dir>`. The workspace must already exist.
 */
export async function cloneRepository(
  repoUrl: string,
  workspaceDir: string,
  ref?: string,
  onOutput?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<ClonedRepo> {
  if (!isValidGitUrl(repoUrl)) {
    throw new CloneError(`Unsupported repository URL: ${repoUrl.slice(0, 100)}`);
  }
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(workspaceDir, 'clone-'));
    const baseArgs = [
      'clone',
      '--quiet',
      ...(ref && ref !== 'HEAD' && !SHA_RE.test(ref) ? ['--branch', ref] : []),
      '--',
      repoUrl,
      dir,
    ];
    onOutput?.(`git ${baseArgs.slice(0, 2).join(' ')} ...`);
    const runClone = (args: string[]) =>
      execFileAsync('git', args, {
        cwd: workspaceDir,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        // Aborting SIGTERMs the git child process — no zombie clones.
        ...(signal ? { signal } : {}),
      });
    // A full 40-hex ref is a commit SHA, not a branch: clone without checkout
    // (full history so ancestor commits are present), then detached-checkout.
    if (ref && SHA_RE.test(ref)) {
      await runClone(['clone', '--quiet', '--no-checkout', ...baseArgs.slice(baseArgs.indexOf('--'))]);
      await execFileAsync('git', ['-C', dir, 'checkout', '--quiet', ref], {
        cwd: workspaceDir,
        timeout: 120_000,
        windowsHide: true,
      });
    } else {
      try {
        // Prefer a fast shallow clone; fall back for servers without support
        // (e.g. dumb http) or refs not advertised.
        await runClone([...baseArgs.slice(0, 2), '--depth', '1', ...baseArgs.slice(2)]);
      } catch (shallowErr) {
        const msg = String((shallowErr as { stderr?: string })?.stderr ?? shallowErr);
        if (/shallow|smart|dumb/i.test(msg)) {
          // The failed attempt may have left a partial directory behind.
          await cleanupDir(dir!);
          await runClone(baseArgs);
        } else {
          throw shallowErr;
        }
      }
    }
    const sha = (await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
    return { dir, commitSha: sha, cleanup: () => cleanupDir(dir!) };
  } catch (err) {
    if (dir) await cleanupDir(dir);
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    const msg = stderr.split('\n').filter(Boolean).slice(-3).join('; ');
    throw new CloneError(
      `Repository clone failed${msg ? `: ${truncate(msg, 300)}` : ''}`.replace(repoUrl, '<repository>'),
    );
  }
}

async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
