/**
 * Multi-service integration tests — minicloud.yml deployments, private
 * networking, volumes, workers, failure isolation — against REAL Docker.
 * Requires: Docker running and PostgreSQL via `docker compose up -d postgres`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createTestApp, destroyTestContext, type TestContext } from './test-helpers.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

let ctx: TestContext;
let fixtures: FixtureServer;

beforeAll(async () => {
  ctx = await createTestApp();
  fixtures = await startFixtureServer([{ name: 'msvc', revisions: ['msvc-a', 'msvc-b'] }, 'hello-node']);
}, 240_000);

afterAll(async () => {
  await fixtures?.close();
  await destroyTestContext(ctx);
});

async function depStatus(deploymentId: string): Promise<string> {
  return (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${deploymentId}` })).json().status as string;
}

function waitForStatus(deploymentId: string, statuses: string[], timeoutMs = 240_000): Promise<string> {
  const start = Date.now();
  return (async () => {
    for (;;) {
      const s = await depStatus(deploymentId);
      if (statuses.includes(s)) return s;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out for ${statuses}; last=${s}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
}

async function createApp(name: string, fixture: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/apps',
    payload: { name, repositoryUrl: fixtures.url(fixture) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function deploy(appId: string, payload: Record<string, unknown> = {}): Promise<string> {
  const res = await ctx.app.inject({ method: 'POST', url: `/api/apps/${appId}/deploy`, payload });
  expect(res.statusCode, res.body).toBe(202);
  return res.json().deployment.id as string;
}

function stableGet(slug: string, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: ctx.gatewayPort, path, headers: { host: `${slug}.localhost` } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.end();
  });
}

function serviceGet(slug: string, service: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: ctx.gatewayPort, path, headers: { host: `${service}.${slug}.localhost` } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.end();
  });
}

describe('multi-service deployments (real docker)', () => {
  let appId: string;
  let dep1: string;
  let dep2: string;
  let dep3: string;

  it('deploys web+api+worker from minicloud.yml with private networking', async () => {
    appId = await createApp('ms-app', 'msvc');
    dep1 = await deploy(appId, { ref: fixtures.sha('msvc', 0) }); // revision A
    expect(await waitForStatus(dep1, ['RUNNING'])).toBe('RUNNING');

    const detail = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${dep1}` })).json();
    expect(detail.multiService).toBe(true);
    const svcList = detail.services as Array<{ service: string; status: string; public: boolean; hostPort: number | null }>;
    const svc = Object.fromEntries(svcList.map((s) => [s.service, s])) as Record<
      string,
      { service: string; status: string; public: boolean; hostPort: number | null }
    >;
    expect(Object.keys(svc).sort()).toEqual(['api', 'web', 'worker']);
    for (const name of ['web', 'api', 'worker']) expect(svc[name]!.status).toBe('RUNNING');
    expect(svc.web!.public).toBe(true);
    expect(svc.api!.public).toBe(false);
    expect(svc.worker!.hostPort).toBeNull(); // workers get no host port

    // Stable URL routes to the primary public service (web), which reaches the
    // api through the PRIVATE network by service name.
    const home = await stableGet('ms-app');
    expect(home.status).toBe(200);
    const body = JSON.parse(home.body);
    expect(body.service).toBe('web');
    expect(body.version).toBe('msvc-A');
    expect(body.api.error).toBeUndefined();
    expect(body.api.count).toBeTypeOf('number');

    // api and worker are PRIVATE: host manipulation must not reach them.
    expect((await serviceGet('ms-app', 'api', '/count')).status).toBe(503);
    expect((await serviceGet('ms-app', 'worker', '/')).status).toBe(503);

    // Events carry service identity + network/volume records.
    const events = (
      (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${dep1}/events` })).json().events as Array<{
        type: string;
        metadata: Record<string, unknown> | null;
      }>
    );
    const buildEvents = events.filter((e) => e.type === 'service.build_completed');
    expect(buildEvents.map((e) => (e.metadata as { serviceName: string }).serviceName).sort()).toEqual(['api', 'web', 'worker']);
    expect(events.some((e) => e.type === 'network.created')).toBe(true);
    expect(events.some((e) => e.type === 'volume.attached')).toBe(true);
  }, 420_000);

  it('persists volume data across a zero-downtime replacement', async () => {
    // Increment via the web facade (which calls the api privately).
    const inc = await stableGet('ms-app', '/increment');
    expect(inc.status).toBe(200);
    expect(() => JSON.parse(inc.body)).not.toThrow();
    const before = JSON.parse(inc.body) as { count: number };
    expect(before.count).toBeGreaterThanOrEqual(1);

    dep2 = await deploy(appId, { ref: fixtures.sha('msvc', 1) });
    await waitForStatus(dep2, ['RUNNING']);

    const after = await stableGet('ms-app');
    const parsed = JSON.parse(after.body) as { version: string; api: { count: number } };
    expect(parsed.version).toBe('msvc-B');
    // The worker keeps incrementing, so the count may have grown — the
    // persistence guarantee is that it was NOT reset by the redeploy.
    expect(parsed.api.count).toBeGreaterThanOrEqual(before.count);

    await waitForStatus(dep1, ['STOPPED'], 60_000); // old revision retired
    const vols = (await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/volumes` })).json();
    expect(vols.volumes).toHaveLength(1);
    expect(vols.volumes[0].name).toBe('app-data');
  }, 420_000);

  it('rollback restores the previous revision; volume data survives', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/apps/${appId}/rollback`,
      payload: { targetDeploymentId: dep1 },
    });
    expect(res.statusCode).toBe(202);
    dep3 = res.json().deployment.id as string;
    try {
      await waitForStatus(dep3, ['RUNNING']);
    } catch (e) {
      const row = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${dep3}` })).json();
      console.error('ROLLBACK FAILED:', row.failureReason);
      throw e;
    }

    // Cutover completes right after RUNNING: poll for the version flip.
    const start = Date.now();
    let parsed: { version: string; api: { count: number } } | null = null;
    while (Date.now() - start < 20_000) {
      const home = await stableGet('ms-app');
      if (home.status === 200) {
        parsed = JSON.parse(home.body) as { version: string; api: { count: number } };
        if (parsed.version === 'msvc-A') break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(parsed?.version).toBe('msvc-A'); // version rolled back...
    expect(parsed!.api.count).toBeGreaterThanOrEqual(1); // ...data did NOT

    await waitForStatus(dep2, ['STOPPED'], 60_000);
  }, 420_000);

  it('worker crash recovers independently; web keeps serving', async () => {
    const detail = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${dep3}` })).json();
    const worker = (detail.services as Array<{ service: string; containerId: string | null }>).find(
      (s) => s.service === 'worker',
    )!;
    expect(worker.containerId).toBeTruthy();
    await ctx.docker.stop(worker.containerId!, 1);

    // Web (a different service) keeps serving through the stable URL.
    expect((await stableGet('ms-app', '/health')).status).toBe(200);

    // The worker's on-failure policy restarts it. Crash processing is driven
    // explicitly (the background monitor is disabled in tests).
    const start = Date.now();
    let recovered = false;
    while (Date.now() - start < 90_000) {
      await ctx.engine.checkCrashes();
      const d = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${dep3}` })).json();
      const w = (d.services as Array<{ service: string; status: string }>).find((s) => s.service === 'worker');
      if (w?.status === 'RUNNING') { recovered = true; break; }
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(recovered).toBe(true);
  }, 300_000);

  it('single-service backward compatibility: hello-node deploys unchanged', async () => {
    const appId = await createApp('ms-compat', 'hello-node');
    const depId = await deploy(appId);
    await waitForStatus(depId, ['RUNNING']);
    const detail = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(detail.multiService).toBe(false);
    expect(detail.services).toBeNull();
    expect((await stableGet('ms-compat', '/health')).status).toBe(200);
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}?force=true` });
    await ctx.app.inject({ method: 'DELETE', url: `/api/apps/${appId}` });
  }, 300_000);
});
