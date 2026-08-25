// E2E fixture git server: serves hello-node + multi-service fixture repos over
// dumb HTTP so dashboard-driven deploys have something to clone.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const root = path.join(os.tmpdir(), `minicloud-e2e-fixtures-${Date.now()}`);
await fs.mkdir(root, { recursive: true });

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const specs = [
  { name: 'hello-node', source: path.resolve(process.cwd(), 'examples/hello-node') },
  { name: 'failing-app', source: path.resolve(process.cwd(), 'examples/failing-app') },
  { name: 'crash-once', source: path.resolve(process.cwd(), 'examples/crash-once') },
  {
    name: 'msvc',
    revisions: [
      path.resolve(process.cwd(), 'examples/msvc-a'),
      path.resolve(process.cwd(), 'examples/msvc-b'),
    ],
  },
];

for (const spec of specs) {
  const bare = path.join(root, `${spec.name}.git`);
  const work = path.join(root, `work-${spec.name}`);
  git(['init', '--bare', '-q', bare]);
  git(['clone', '-q', bare, work]);
  const revisions = spec.revisions ?? [spec.source];
  for (const [i, rev] of revisions.entries()) {
    const copyDir = async (src, dest) => {
      await fs.mkdir(dest, { recursive: true });
      for (const entry of await fs.readdir(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) await copyDir(s, d);
        else {
          await fs.copyFile(s, d);
          const now = new Date();
          await fs.utimes(d, now, now);
        }
      }
    };
    await copyDir(rev, work);
    git(['add', '-A'], work);
    git(['-c', 'user.name=e2e', '-c', 'user.email=e2e@test', 'commit', '-qm', `rev ${i}`], work);
  }
  git(['push', '-q'], work);
  git(['update-server-info'], bare);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const filePath = path.join(root, urlPath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath)
    .then((data) => res.writeHead(200).end(data))
    .catch(() => res.writeHead(404).end());
});

const port = Number(process.env.PORT ?? 4555);
server.listen(port, () => console.log(`e2e fixtures on http://127.0.0.1:${port}`));
