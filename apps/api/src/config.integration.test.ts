/**
 * Configuration integration tests — env/secret injection and resource limits
 * against REAL Docker containers.
 * Requires: Docker running and PostgreSQL via `docker compose up -d postgres`.
 * Run with: npm run test:integration -w @minicloud/api
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, destroyTestContext, type TestContext } from './test-helpers.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';
import { DockerRuntime } from '@minicloud/docker-runtime';

let ctx: TestContext;
let noKeyCtx: TestContext;
let fixtures: FixtureServer;
const docker = new DockerRuntime();

beforeAll(async () => {
  ctx = await createTestApp();
  noKeyCtx = await createTestApp({ withMasterKey: false });
  fixtures = await startFixtureServer(['env-echo', 'memory-hog']);
}, 240_000);

afterAll(async () => {
  await fixtures?.close();
  await destroyTestContext(ctx);
  await destroyTestContext(noKeyCtx);
});

async function waitForStatus(
  app: TestContext['app'],
  deploymentId: string,
  statuses: string[],
  timeoutMs = 180_000,
): Promise<string> {
  // Polling real Docker/Postgres state: no deterministic clock can drive the
  // external pipeline, so a genuine interval between polls is required.
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/deployments/${deploymentId}` });
    const status = res.json().status as string;
    if (statuses.includes(status)) return status;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${statuses}; last=${status}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function createApp(name: string, fixture: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apps',
    payload: { name, repositoryUrl: fixtures.url(fixture) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

interface SnapshotView {
  env: Record<string, string>;
  secretKeys: string[];
  limits: { memoryLimitMb?: number; cpuLimit?: number } | null;
}

interface DeploymentView {
  id: string;
  status: string;
  hostPort: number | null;
  restartCount: number;
  config: SnapshotView | null;
}

// Named boundary cast: fastify's res.json() is untyped.
function readDeployment(res: { json(): unknown }): DeploymentView {
  return res.json() as DeploymentView;
}

async function deployAndWait(appId: string, terminal: string[] = ['RUNNING']): Promise<DeploymentView & { depId: string }> {
  const deploy = await ctx.app.inject({ method: 'POST', url: `/api/apps/${appId}/deploy`, payload: {} });
  expect(deploy.statusCode).toBe(202);
  const depId = deploy.json().deployment.id as string;
  await waitForStatus(ctx.app, depId, terminal);
  const dep = readDeployment(await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` }));
  return { ...dep, depId };
}

describe('configuration (real docker)', () => {
  it('injects env vars and decrypted secrets into a real container', async () => {
    const appId = await createApp('cfg-inject', 'env-echo');
    // One plain var, one secret; both must reach the container environment.
    expect(
      (await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/env/DEMO_PLAIN`, payload: { value: 'plain-value-xyz' } })).statusCode,
    ).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/env/APP_MODE`, payload: { value: 'production' } })).statusCode,
    ).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/secrets/DEMO_SECRET`, payload: { value: 'hush-hush-42' } })).statusCode,
    ).toBe(201);

    const { depId, hostPort } = await deployAndWait(appId);
    expect(hostPort).not.toBeNull();

    // The container serves the injected values.
    const res = await fetch(`http://127.0.0.1:${hostPort}/env`);
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as Record<string, string>;
    expect(echoed.DEMO_PLAIN).toBe('plain-value-xyz');
    expect(echoed.APP_MODE).toBe('production');
    expect(echoed.DEMO_SECRET).toBe('hush-hush-42'); // decrypted value reached the container

    // Snapshot: plain values recorded, secret recorded by KEY only.
    const dep = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(dep.config.env).toEqual({ APP_MODE: 'production', DEMO_PLAIN: 'plain-value-xyz' });
    expect(dep.config.secretKeys).toEqual(['DEMO_SECRET']);
    expect(JSON.stringify(dep)).not.toContain('hush-hush-42');

    // Real container inspection: env present, no limits set.
    const row = await ctx.db.query<{ container_id: string | null }>(
      'SELECT container_id FROM deployments WHERE id = $1',
      [depId],
    );
    const info = await docker.inspectContainer(row.rows[0]!.container_id!);
    expect(info).not.toBeNull();
    expect(info!.env).toContain('DEMO_SECRET=hush-hush-42');
    expect(info!.env).toContain('DEMO_PLAIN=plain-value-xyz');
    expect(info!.limits.memoryBytes).toBe(0); // docker reports unset limits as 0
    expect(info!.limits.nanoCpus).toBe(0);

    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 300_000);

  it('applies cpu and memory limits to the real container', async () => {
    const appId = await createApp('cfg-limits-live', 'env-echo');
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/limits`,
      payload: { memoryLimitMb: 128, cpuLimit: 0.5 },
    });
    expect(put.statusCode).toBe(200);

    const { depId } = await deployAndWait(appId);

    const row = await ctx.db.query<{ container_id: string | null }>(
      'SELECT container_id FROM deployments WHERE id = $1',
      [depId],
    );
    const info = await docker.inspectContainer(row.rows[0]!.container_id!);
    expect(info).not.toBeNull();
    // Exact unit conversion: MB -> bytes, CPUs -> nano-CPUs. MemorySwap equals
    // Memory so the cap is hard (no swap slack).
    expect(info!.limits.memoryBytes).toBe(128 * 1024 * 1024);
    expect(info!.limits.memorySwapBytes).toBe(128 * 1024 * 1024);
    expect(info!.limits.nanoCpus).toBe(500_000_000);

    const dep = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(dep.config.limits).toEqual({ memoryLimitMb: 128, cpuLimit: 0.5 });

    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 300_000);

  it('enforces the memory limit: an OOMing app is marked FAILED with exit code 137', async () => {
    const appId = await createApp('cfg-oom', 'memory-hog');
    expect(
      (await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/limits`, payload: { memoryLimitMb: 64 } })).statusCode,
    ).toBe(200);

    const deploy = await ctx.app.inject({ method: 'POST', url: `/api/apps/${appId}/deploy`, payload: {} });
    const depId = deploy.json().deployment.id as string;

    const status = await waitForStatus(ctx.app, depId, ['FAILED'], 150_000);
    expect(status).toBe('FAILED');
    const dep = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(String(dep.failureReason)).toMatch(/exited unexpectedly/i);
    // 137 = SIGKILL from the kernel OOM killer inside the cgroup.
    expect(dep.exitCode).toBe(137);
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 240_000);

  it('redeployment picks up changed config while old snapshots stay immutable', async () => {
    const appId = await createApp('cfg-redeploy', 'env-echo');
    await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/env/APP_MODE`, payload: { value: 'v1' } });

    const d1 = await deployAndWait(appId);
    expect(d1.config?.env.APP_MODE).toBe('v1');

    // Change config AFTER the first deployment, then redeploy.
    await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/env/APP_MODE`, payload: { value: 'v2' } });
    await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/secrets/DEMO_SECRET`, payload: { value: 'added-later' } });

    const d2 = await deployAndWait(appId);
    expect(d2.config?.env).toEqual({ APP_MODE: 'v2' }); // plain values refreshed
    expect(d2.config?.secretKeys).toEqual(['DEMO_SECRET']); // secret key appears
    expect(d1.config).not.toBeNull();
    expect(d2.config).not.toBeNull();
    // The live container actually received the new value.
    const res = await fetch(`http://127.0.0.1:${d2.hostPort}/env`);
    const echoed = (await res.json()) as Record<string, string>;
    expect(echoed.APP_MODE).toBe('v2');

    // History is immutable: the first deployment's snapshot still shows v1
    // and does not know about the later-added secret key.
    const d1After = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${d1.depId}` })).json();
    expect(d1After.config.env).toEqual({ APP_MODE: 'v1' });
    expect(d1After.config.secretKeys).toEqual([]);

    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${d1.depId}` });
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${d2.depId}` });
  }, 300_000);

  it('restart applies current config and refreshes the snapshot', async () => {
    const appId = await createApp('cfg-restart', 'env-echo');
    await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/env/APP_MODE`, payload: { value: 'before' } });
    const { depId, hostPort } = await deployAndWait(appId);

    // Change config while RUNNING, then restart (no rebuild).
    await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/env/APP_MODE`, payload: { value: 'after' } });
    const restart = await ctx.app.inject({ method: 'POST', url: `/api/deployments/${depId}/restart` });
    expect(restart.statusCode).toBe(200);
    expect(restart.json().restartCount).toBe(1);

    const status = await waitForStatus(ctx.app, depId, ['RUNNING']);
    expect(status).toBe('RUNNING');
    const restarted = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(restarted.hostPort).not.toBe(hostPort); // fresh container

    // The restarted container runs with the NEW value and the snapshot says so.
    const res = await fetch(`http://127.0.0.1:${restarted.hostPort}/env`);
    const echoed = (await res.json()) as Record<string, string>;
    expect(echoed.APP_MODE).toBe('after');
    expect(restarted.config.env).toEqual({ APP_MODE: 'after' });

    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 300_000);

  it('fails the deployment cleanly when secrets exist but the master key is missing', async () => {
    // App + secret-shaped row in the NO-KEY context's database.
    const created = await noKeyCtx.app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: { name: 'cfg-nokey-deploy', repositoryUrl: fixtures.url('env-echo') },
    });
    const appId = created.json().id as string;
    // Simulate a stored secret (e.g. written when a key WAS configured).
    await noKeyCtx.db.query(
      `INSERT INTO app_env (application_id, key, encrypted_value, is_secret)
       VALUES ($1, 'GHOST_SECRET', 'v1:AAAA:AAAA', true)`,
      [appId],
    );

    const deploy = await noKeyCtx.app.inject({ method: 'POST', url: `/api/apps/${appId}/deploy`, payload: {} });
    const depId = deploy.json().deployment.id as string;
    const status = await waitForStatus(noKeyCtx.app, depId, ['FAILED']);
    expect(status).toBe('FAILED');
    const dep = (await noKeyCtx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    // Fails at the config stage with operator guidance — not a stuck STARTING row.
    expect(String(dep.failureReason)).toMatch(/MINICLOUD_MASTER_KEY/);
    await noKeyCtx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 240_000);
});
