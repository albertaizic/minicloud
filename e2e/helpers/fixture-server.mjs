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
  {
    // Two content revisions so PR synchronize can flip the served version.
    name: 'rev',
    revisions: [
      path.resolve(process.cwd(), 'examples/rev-app-a'),
      path.resolve(process.cwd(), 'examples/rev-app-b'),
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

// Machine-readable revision index so tests can address every revision without
// parsing the git wire protocol (info/refs only advertises the tip).
const shas = {};
for (const spec of specs) {
  const count = spec.revisions ? spec.revisions.length : 1;
  const out = execFileSync(
    'git',
    ['log', '--format=%H', `-n${count}`, '--reverse', 'HEAD'],
    { cwd: path.join(root, `work-${spec.name}`) },
  );
  shas[spec.name] = out.toString().trim().split('\n').filter(Boolean);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (urlPath === '/shas.json') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(shas));
    return;
  }
  const filePath = path.join(root, urlPath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath)
    .then((data) => res.writeHead(200).end(data))
    .catch(() => res.writeHead(404).end());
});

const port = 4555;
server.listen(port, () => console.log(`e2e fixtures on http://127.0.0.1:${port}`));
