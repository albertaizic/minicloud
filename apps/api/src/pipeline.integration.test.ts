/**
 * Docker integration tests — the real pipeline against example fixtures.
 * Requires: Docker running and PostgreSQL via `docker compose up -d postgres`.
 * Run with: npm run test:integration -w @minicloud/api
 *
 * These tests clone from a local git URL. To make the examples clonable, the
 * test bootstraps bare repos from ../examples into a temp dir served over
 * dumb-HTTP by Node's http server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import { createTestApp, destroyTestContext, type TestContext } from './test-helpers.js';

const run = promisify(execFile);

let ctx: TestContext;
let server: http.Server;
let port = 0;
const gitRoot = path.join(os.tmpdir(), `minicloud-it-git-${Date.now()}`);

async function sh(cmd: string, args: string[], cwd?: string): Promise<void> {
  await run(cmd, args, cwd ? { cwd } : undefined);
}

beforeAll(async () => {
  ctx = await createTestApp();

  // Build bare repos for the fixtures and serve them statically (dumb HTTP).
  const repoRoot = path.resolve(import.meta.dirname ?? '.', '../../../examples');
  await fsp.mkdir(gitRoot, { recursive: true });
  for (const name of ['hello-node', 'failing-app']) {
    const bare = path.join(gitRoot, `${name}.git`);
    await sh('git', ['init', '--bare', '-q', bare]);
    const work = path.join(gitRoot, `work-${name}`);
    await sh('git', ['clone', '-q', bare, work]);
    // copy fixture files
    const files = await fsp.readdir(path.join(repoRoot, name));
    for (const f of files) {
      await fsp.copyFile(path.join(repoRoot, name, f), path.join(work, f));
    }
    await sh('git', ['add', '-A'], work);
    await sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], work);
    await sh('git', ['push', '-q'], work);
    await sh('git', ['update-server-info'], bare);
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
  await new Promise<void>((resolve) => {
    server = http.createServer(rootHandler);
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
}, 180_000);

afterAll(async () => {
  server?.close();
  await destroyTestContext(ctx);
  await fsp.rm(gitRoot, { recursive: true, force: true }).catch(() => {});
});

async function waitForStatus(
  deploymentId: string,
  statuses: string[],
  timeoutMs = 240_000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${deploymentId}` });
    const status = res.json().status as string;
    if (statuses.includes(status)) return status;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${statuses}; last=${status}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

describe('deployment pipeline (docker)', () => {
  it('deploys hello-node to RUNNING, serves logs, stops cleanly', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: { name: 'it-hello', repositoryUrl: `http://localhost:${port}/hello-node.git` },
    });
    expect(create.statusCode).toBe(201);
    const appId = create.json().id;

    const deploy = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/deploy`,
      payload: {},
    });
    expect(deploy.statusCode).toBe(202);
    const depId = deploy.json().deployment.id;

    const status = await waitForStatus(depId, ['RUNNING', 'FAILED']);
    expect(status).toBe('RUNNING');

    const dep = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(dep.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(dep.hostPort).toBeGreaterThanOrEqual(33000);

    const healthRes = await fetch(`http://127.0.0.1:${dep.hostPort}/health`);
    expect(healthRes.status).toBe(200);
    await healthRes.body?.cancel();

    const logs = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}/logs` });
    expect(logs.statusCode).toBe(200);
    expect(logs.json().logs.some((l: { message: string }) => /listening/.test(l.message))).toBe(true);

    const stop = await ctx.app.inject({ method: 'POST', url: `/api/deployments/${depId}/stop` });
    expect(stop.json().status).toBe('STOPPED');

    // Restart brings it back to RUNNING on a fresh port.
    const restart = await ctx.app.inject({ method: 'POST', url: `/api/deployments/${depId}/restart` });
    expect(restart.statusCode).toBe(200);
    expect(restart.json().status).toBe('RUNNING');
    expect(restart.json().restartCount).toBe(1);

    // Cleanup
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 300_000);

  it('marks a crashing app as FAILED with exit code', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: { name: 'it-crashy', repositoryUrl: `http://localhost:${port}/failing-app.git` },
    });
    const appId = create.json().id;
    const deploy = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/deploy`,
      payload: {},
    });
    const depId = deploy.json().deployment.id;

    // App passes health check then crashes ~3s later; crash monitor marks FAILED.
    const status = await waitForStatus(depId, ['FAILED'], 120_000);
    expect(status).toBe('FAILED');
    const dep = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(dep.failureReason).toMatch(/exited unexpectedly/);
    expect(dep.exitCode).toBe(1);
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 180_000);

  it('fails clearly when the repository has no Dockerfile or does not exist', async () => {
    // Nonexistent repo -> clone failure
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: { name: 'it-missing', repositoryUrl: `http://localhost:${port}/does-not-exist.git` },
    });
    const appId = create.json().id;
    const deploy = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/deploy`,
      payload: {},
    });
    const depId = deploy.json().deployment.id;
    const status = await waitForStatus(depId, ['FAILED'], 120_000);
    expect(status).toBe('FAILED');
    const dep = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(dep.failureReason).toMatch(/clone/i);
  }, 180_000);
});
