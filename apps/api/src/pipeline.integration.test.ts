/**
 * Docker integration tests — the real pipeline against example fixtures.
 * Requires: Docker running and PostgreSQL via `docker compose up -d postgres`.
 * Run with: npm run test:integration -w @minicloud/api
 *
 * These tests clone from a local git URL. The shared fixture server publishes
 * the example fixtures as bare repos over dumb HTTP (see fixture-server.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, destroyTestContext, type TestContext } from './test-helpers.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

let ctx: TestContext;
let fixtures: FixtureServer;

beforeAll(async () => {
  ctx = await createTestApp();
  fixtures = await startFixtureServer(['hello-node', 'failing-app']);
}, 180_000);

afterAll(async () => {
  await fixtures?.close();
  await destroyTestContext(ctx);
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
      payload: { name: 'it-hello', repositoryUrl: fixtures.url('hello-node') },
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

    // The first deployment is automatically ACTIVE (v0.4): force the stop.
    const stop = await ctx.app.inject({ method: 'POST', url: `/api/deployments/${depId}/stop?force=true` });
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
      payload: { name: 'it-crashy', repositoryUrl: fixtures.url('failing-app') },
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
      payload: { name: 'it-missing', repositoryUrl: fixtures.url('does-not-exist') },
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
