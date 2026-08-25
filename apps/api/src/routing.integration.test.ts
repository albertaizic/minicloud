/**
 * Routing & zero-downtime integration tests — stable URLs, cutover, rollback
 * routing, crash recovery, concurrency — against REAL Docker + the gateway.
 * Requires: Docker running and PostgreSQL via `docker compose up -d postgres`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { closeTestContext, createTestApp, destroyTestContext, type TestContext } from './test-helpers.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

let ctx: TestContext;
let fixtures: FixtureServer;

beforeAll(async () => {
  ctx = await createTestApp();
  fixtures = await startFixtureServer([
    { name: 'rev-app', revisions: ['rev-app-a', 'rev-app-b'] },
    'failing-app',
    'crash-once',
  ]);
}, 240_000);

afterAll(async () => {
  await fixtures?.close();
  await destroyTestContext(ctx);
});

// ---- helpers -----------------------------------------------------------------

async function depStatus(deploymentId: string): Promise<string> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${deploymentId}` });
  return res.json().status as string;
}

function waitForStatus(deploymentId: string, statuses: string[], timeoutMs = 180_000): Promise<string> {
  const start = Date.now();
  return (async () => {
    for (;;) {
      const s = await depStatus(deploymentId);
      if (statuses.includes(s)) return s;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${statuses}; last=${s}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
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

async function deploy(appId: string, payload: Record<string, unknown> = {}): Promise<string> {
  const res = await ctx.app.inject({ method: 'POST', url: `/api/apps/${appId}/deploy`, payload });
  expect(res.statusCode, res.body).toBe(202);
  return res.json().deployment.id as string;
}

/** HTTP GET to the stable URL (Host-header routing through the gateway). */
function stableGet(slug: string, path = '/version'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
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

async function appDetail(appId: string) {
  return (await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}` })).json();
}

/** The cutover completes right after RUNNING; poll instead of a single read. */
async function waitForVersion(slug: string, expected: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const r = await stableGet(slug);
    if (r.status === 200 && r.body === expected) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`stable URL never served ${expected}; last=${r.status} ${r.body.slice(0, 60)}`);
    }
    await new Promise((res) => setTimeout(res, 400));
  }
}

const shaA = () => fixtures.sha('rev-app', 0);
const shaB = () => fixtures.sha('rev-app', 1);

// ---- scenarios -----------------------------------------------------------------

describe('routing (real docker)', () => {
  it('A: stable URL serves the active deployment and is exposed everywhere', async () => {
    const appId = await createApp('rt-stable', 'rev-app');
    const depA = await deploy(appId, { ref: shaA() });
    await waitForStatus(depA, ['RUNNING']);

    // Stable URL serves revision A.
    await waitForVersion('rt-stable', 'revision-a\n');
    const res = await stableGet('rt-stable');
    expect(res.status).toBe(200);

    // API surfaces: app URL + active pointer, deployment isActive.
    const detail = await appDetail(appId);
    expect(detail.url).toBe(`http://rt-stable.localhost:${ctx.gatewayPort}`);
    expect(detail.activeDeploymentId).toBe(depA);
    expect(detail.deployments.find((d: { id: string }) => d.id === depA).isActive).toBe(true);

    // CLI-visible shape: /api/routes contains the slug.
    const routes = (await ctx.app.inject({ method: 'GET', url: '/api/routes' })).json();
    const route = routes.routes.find((r: { slug: string }) => r.slug === 'rt-stable');
    expect(route).toBeTruthy();
    expect(route.deploymentId).toBe(depA);

    // Deleting the ACTIVE deployment requires force (explicit semantics).
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depA}` });
    expect(del.statusCode).toBe(409);
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depA}?force=true` });
    expect((await appDetail(appId)).activeDeploymentId).toBeNull();
    expect((await stableGet('rt-stable')).status).toBe(503);
  }, 300_000);

  it('B: zero-downtime replacement (continuous-request acceptance test)', async () => {
    const appId = await createApp('rt-zdt', 'rev-app');
    const depA = await deploy(appId, { ref: shaA() });
    await waitForStatus(depA, ['RUNNING']);
    await waitForVersion('rt-zdt', 'revision-a\n');

    // Continuous requests throughout B's entire lifecycle.
    const observations: Array<{ ok: boolean; status: number; version: string | null }> = [];
    let hammering = true;
    const hammer = (async () => {
      while (hammering) {
        const r = await stableGet('rt-zdt');
        observations.push({
          ok: r.status === 200,
          status: r.status,
          version: r.status === 200 ? r.body.trim() : null,
        });
        await new Promise((r) => setTimeout(r, 40));
      }
    })();

    const depB = await deploy(appId, { ref: shaB() });
    await waitForStatus(depB, ['RUNNING']);
    await new Promise((r) => setTimeout(r, 2500)); // keep hammering past cutover
    hammering = false;
    await hammer;

    // Acceptance criteria.
    expect(observations.length).toBeGreaterThan(20);
    const failures = observations.filter((o) => !o.ok);
    expect(failures, `failures during cutover: ${JSON.stringify(failures.slice(0, 5))}`).toHaveLength(0);
    const versions = new Set(observations.map((o) => o.version));
    expect(versions.has('revision-a')).toBe(true);
    expect(versions.has('revision-b')).toBe(true);
    const firstB = observations.findIndex((o) => o.version === 'revision-b');
    for (const o of observations.slice(firstB)) {
      expect(o.version).toBe('revision-b'); // never flips back
    }
    expect((await appDetail(appId)).activeDeploymentId).toBe(depB);
    // Old deployment retired (container gone) but record preserved.
    await waitForStatus(depA, ['STOPPED'], 60_000);
    const aRow = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depA}` })).json();
    expect(aRow.containerName).toBeNull();
    expect(aRow.commitSha).toBe(shaA());

    const eventsB = (
      (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depB}/events` })).json().events as Array<{ type: string }>
    ).map((e) => e.type);
    expect(eventsB).toContain('traffic.cutover_started');
    expect(eventsB).toContain('traffic.cutover_completed');
    // Drain events belong to the retired deployment.
    const eventsA = (
      (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depA}/events` })).json().events as Array<{ type: string }>
    ).map((e) => e.type);
    expect(eventsA).toContain('traffic.drain_started');
    expect(eventsA).toContain('traffic.drain_completed');

    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depB}` });
  }, 420_000);

  it('C: failed replacement leaves the old version serving', async () => {
    const appId = await createApp('rt-faildep', 'rev-app');
    const depA = await deploy(appId, { ref: shaA() });
    await waitForStatus(depA, ['RUNNING']);

    // A deployment that fails before it can ever become active.
    const depBad = await deploy(appId, { ref: 'does-not-exist-branch' });
    const status = await waitForStatus(depBad, ['FAILED']);
    expect(status).toBe('FAILED');

    const detail = await appDetail(appId);
    expect(detail.activeDeploymentId).toBe(depA); // A untouched
    expect((await stableGet('rt-faildep')).body).toBe('revision-a\n'); // still serving
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depA}` });
  }, 300_000);

  it('D: rollback keeps the stable URL and flips the version back', async () => {
    const appId = await createApp('rt-rollback', 'rev-app');
    const depA = await deploy(appId, { ref: shaA() });
    await waitForStatus(depA, ['RUNNING']);
    const depB = await deploy(appId, { ref: shaB() });
    await waitForStatus(depB, ['RUNNING']);
    await waitForVersion('rt-rollback', 'revision-b\n');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/rollback`,
      payload: { targetDeploymentId: depA },
    });
    expect(res.statusCode).toBe(202);
    const depC = res.json().deployment.id as string;
    await waitForStatus(depC, ['RUNNING']);

    await waitForVersion('rt-rollback', 'revision-a\n'); // same URL, old version
    expect((await appDetail(appId)).activeDeploymentId).toBe(depC);
    await waitForStatus(depB, ['STOPPED'], 60_000); // B drained
    const types = (
      (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depC}/events` })).json().events as Array<{ type: string }>
    ).map((e) => e.type);
    expect(types).toContain('rollback.requested');
    expect(types).toContain('traffic.cutover_completed');

    for (const d of [depB, depC]) await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${d}` });
  }, 360_000);

  it('E: gateway rebuilds routes after an API restart', async () => {
    const appId = await createApp('rt-restart', 'rev-app');
    const depA = await deploy(appId, { ref: shaA() });
    await waitForStatus(depA, ['RUNNING']);
    const containersForDep = () =>
    ctx.docker.listManagedContainers().then((cs) => cs.filter((c) => c.labels['minicloud.deployment'] === depA).length);
    const containersBefore = await containersForDep();

    // Simulate an API/gateway restart on the SAME database.
    const dbName = ctx.dbName;
    await closeTestContext(ctx);
    ctx = await createTestApp({ reuseDbName: dbName });
    // Startup path: the API reconciles state (incl. gateway routes) on boot.
    await ctx.engine.reconcile();

    expect((await stableGet('rt-restart')).body).toBe('revision-a\n'); // route recovered
    expect((await appDetail(appId)).activeDeploymentId).toBe(depA);
    const containersAfter = await containersForDep();
    expect(containersAfter).toBe(containersBefore); // no duplicates of this deployment
    expect(containersAfter).toBe(1);
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depA}` });
  }, 360_000);

  it('F: crash recovery restores routing on the same stable URL', async () => {
    const appId = await createApp('rt-crashrec', 'crash-once');
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/restart-policy`,
      payload: { policy: 'on-failure', maxRestartAttempts: 3 },
    });
    const depId = await deploy(appId);

    // Initial start is healthy briefly, then crashes: wait for the outage,
    // then for the RECOVERED container (attempt=1) through the stable URL.
    let sawUnavailable = false;
    const start = Date.now();
    let recovered = false;
    while (Date.now() - start < 150_000) {
      const r = await stableGet('rt-crashrec', '/health');
      if (r.status === 503 || r.status === 502) sawUnavailable = true;
      if (r.status === 200) {
        const body = JSON.parse(r.body) as { attempt: string | null };
        if (body.attempt === '1') {
          recovered = true;
          break;
        }
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    expect(recovered).toBe(true);
    expect(sawUnavailable).toBe(true); // sane temporary unavailability was observed

    const detail = await appDetail(appId);
    expect(detail.activeDeploymentId).toBe(depId); // still the same deployment
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 300_000);

  it('G: concurrent deployments cannot both become active', async () => {
    const appId = await createApp('rt-concurrent', 'rev-app');
    const depA = await deploy(appId, { ref: shaA() });
    await waitForStatus(depA, ['RUNNING']);

    // Fire B and C nearly simultaneously.
    const depB = await deploy(appId, { ref: shaB() });
    const depC = await deploy(appId, { ref: shaA() });
    await waitForStatus(depB, ['RUNNING', 'STOPPED', 'FAILED'], 240_000);
    await waitForStatus(depC, ['RUNNING', 'STOPPED', 'FAILED'], 240_000);
    // Allow drain/retire to settle: poll until every non-active deployment
    // has left RUNNING (winner's drain + loser's supersede retire).
    const settleStart = Date.now();
    for (;;) {
      const d2 = await appDetail(appId);
      const others = (d2.deployments as Array<{ id: string; status: string }>).filter(
        (d) => d.id !== d2.activeDeploymentId,
      );
      if (others.every((d) => ['STOPPED', 'FAILED'].includes(d.status))) break;
      if (Date.now() - settleStart > 60_000) {
        throw new Error(`non-active deployments never retired: ${JSON.stringify(others)}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const detail = await appDetail(appId);
    const statuses = Object.fromEntries(
      detail.deployments.map((d: { id: string; status: string }) => [d.id, d.status]),
    ) as Record<string, string>;
    const activeId = detail.activeDeploymentId as string;

    // Exactly one winner; it is RUNNING and serves through the gateway.
    expect(activeId).toBeTruthy();
    expect(['RUNNING']).toContain(statuses[activeId]);
    const winner = detail.deployments.find((d: { id: string }) => d.id === activeId);
    const body = await stableGet('rt-concurrent');
    expect(body.status).toBe(200);
    const expectedVersion = winner.commitSha === shaB() ? 'revision-b' : 'revision-a';
    expect(body.body.trim()).toBe(expectedVersion);

    // Every other deployment is retired (STOPPED), none still RUNNING.
    for (const d of detail.deployments as Array<{ id: string; status: string }>) {
      if (d.id !== activeId) {
        expect(['STOPPED', 'FAILED']).toContain(statuses[d.id]);
      }
    }
    // The loser must not be serving through the gateway.
    const routes = (await ctx.app.inject({ method: 'GET', url: '/api/routes' })).json();
    const route = routes.routes.find((r: { slug: string }) => r.slug === 'rt-concurrent');
    expect(route.deploymentId).toBe(activeId);

    await ctx.app.inject({ method: 'DELETE', url: `/api/apps/${appId}` });
  }, 420_000);

  it('stop/delete of the active deployment requires force', async () => {
    const appId = await createApp('rt-force', 'rev-app');
    const depA = await deploy(appId, { ref: shaA() });
    await waitForStatus(depA, ['RUNNING']);

    const stop = await ctx.app.inject({ method: 'POST', url: `/api/deployments/${depA}/stop` });
    expect(stop.statusCode).toBe(409);
    expect(stop.json().error).toMatch(/ACTIVE/i);
    expect((await stableGet('rt-force')).status).toBe(200); // untouched

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depA}` });
    expect(del.statusCode).toBe(409);

    const forced = await ctx.app.inject({ method: 'POST', url: `/api/deployments/${depA}/stop?force=true` });
    expect(forced.json().status).toBe('STOPPED');
    expect((await appDetail(appId)).activeDeploymentId).toBeNull();
    expect((await stableGet('rt-force')).status).toBe(503); // honest unavailability
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depA}?force=true` });
  }, 300_000);
});
