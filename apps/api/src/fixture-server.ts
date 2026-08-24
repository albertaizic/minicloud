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
  close(): Promise<void>;
}

export async function startFixtureServer(names: string[]): Promise<FixtureServer> {
  const repoRoot = path.resolve(import.meta.dirname ?? '.', '../../../examples');
  const gitRoot = path.join(os.tmpdir(), `minicloud-it-git-${Date.now()}`);
  await fsp.mkdir(gitRoot, { recursive: true });

  for (const name of names) {
    const bare = path.join(gitRoot, `${name}.git`);
    await run('git', ['init', '--bare', '-q', bare]);
    const work = path.join(gitRoot, `work-${name}`);
    await run('git', ['clone', '-q', bare, work]);
    const files = await fsp.readdir(path.join(repoRoot, name));
    for (const f of files) {
      await fsp.copyFile(path.join(repoRoot, name, f), path.join(work, f));
    }
    await run('git', ['add', '-A'], { cwd: work });
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], { cwd: work });
    await run('git', ['push', '-q'], { cwd: work });
    await run('git', ['update-server-info'], { cwd: bare });
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
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fsp.rm(gitRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}
