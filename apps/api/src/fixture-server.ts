/**
 * Shared Docker-integration harness: publishes the example fixtures as local
 * bare git repos served over dumb HTTP, so deployment tests can clone them
 * through the normal pipeline path.
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export interface FixtureServer {
  /** Base URL like http://127.0.0.1:<port>/<name>.git */
  url(name: string): string;
  /** Commit SHA of revision N (0-based) for multi-revision fixtures. */
  sha(name: string, revision: number): string;
  close(): Promise<void>;
}

export type FixtureSpec = string | { name: string; revisions: string[] };

export async function startFixtureServer(specs: FixtureSpec[]): Promise<FixtureServer> {
  const repoRoot = path.resolve(import.meta.dirname ?? '.', '../../../examples');
  const gitRoot = path.join(os.tmpdir(), `minicloud-it-git-${Date.now()}`);
  await fsp.mkdir(gitRoot, { recursive: true });

  const shas = new Map<string, string[]>();
  for (const spec of specs) {
    const [name, revisions] =
      typeof spec === 'string' ? [spec, [spec]] : [spec.name, spec.revisions];
    const bare = path.join(gitRoot, `${name}.git`);
    await run('git', ['init', '--bare', '-q', bare]);
    const work = path.join(gitRoot, `work-${name}`);
    await run('git', ['clone', '-q', bare, work]);
    const commitShas: string[] = [];
    for (const revision of revisions) {
      // Recursive copy: fixtures may contain subdirectories (multi-service).
      const copyDir = async (src: string, dest: string): Promise<void> => {
        await fsp.mkdir(dest, { recursive: true });
        for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) await copyDir(srcPath, destPath);
          else await fsp.copyFile(srcPath, destPath);
          // Windows CopyFileW preserves the source mtime; an older mtime than
          // the git index makes `git add` skip re-hashing (racy-git
          // heuristic), so identical-size changes are missed. Normalize now.
          const now = new Date();
          await fsp.utimes(destPath, now, now);
        }
      };
      await copyDir(path.join(repoRoot, revision), work);
      await run('git', ['add', '-A'], { cwd: work });
      await run(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', `fixture ${revision}`],
        { cwd: work },
      );
      commitShas.push((await run('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim());
    }
    await run('git', ['push', '-q'], { cwd: work });
    await run('git', ['update-server-info'], { cwd: bare });
    shas.set(name, commitShas);
  }


  const rootHandler: http.RequestListener = (req, res) => {
    // Minimal static file serving of the git dir tree.
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const filePath = path.join(gitRoot, urlPath);
    if (!filePath.startsWith(gitRoot)) {
      res.writeHead(403);
      res.end();
      return;
    }
    void fsp.readFile(filePath)
      .then((data) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(data);
      })
      .catch(() => {
        res.writeHead(404);
        res.end();
      });
  };
  // Executor form required: listen() reports the port via callback argument,
  // and the ES2022 lib target has no Promise.withResolvers.
  let server: http.Server;
  const port = await new Promise<number>((resolve) => {
    server = http.createServer(rootHandler);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });


  return {
    url: (name: string) => `http://localhost:${port}/${name}.git`,
    sha: (name: string, revision: number) => {
      const list = shas.get(name);
      if (!list || !list[revision]) throw new Error(`no revision ${revision} for fixture ${name}`);
      return list[revision]!;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fsp.rm(gitRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}
