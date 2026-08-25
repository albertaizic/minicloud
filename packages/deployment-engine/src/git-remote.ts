// Git remote operations for auto-deployment. Uses `git ls-remote` to detect
// new commits without cloning — fast and safe for polling.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Extract the branch SHA from `git ls-remote` output for a given ref. */
export async function lsRemoteSha(
  repoUrl: string,
  branch: string,
): Promise<{ sha: string | null; error?: string }> {
  if (!isValidGitUrl(repoUrl)) return { sha: null, error: 'invalid repository URL' };
  if (!/^[\w.\-/]+$/.test(branch)) return { sha: null, error: 'invalid branch name' };
  try {
    const { stdout } = await exec('git', ['ls-remote', '--heads', '--', repoUrl, `refs/heads/${branch}`], {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    // Output: "<sha>\trefs/heads/<branch>\n"
    const line = stdout.split('\n').find((l) => l.includes(`refs/heads/${branch}`));
    if (!line) return { sha: null, error: `branch "${branch}" not found on remote` };
    const sha = line.split('\t')[0]?.trim() ?? null;
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return { sha: null, error: 'unexpected ls-remote output' };
    return { sha };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { sha: null, error: truncate(msg.replace(repoUrl, '<repository>'), 300) };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function isValidGitUrl(url: string): boolean {
  if (/^https?:\/\/localhost(:\d+)?\/[\w~%.\-]+(\.git)?$/.test(url)) return !/[\r\n;&|`$<>]/.test(url);
  return /^(https:\/\/[^\s]+|git@[^\s]+:[^\s]+)$/.test(url) && !/[\r\n;&|`$<>]/.test(url);
}
