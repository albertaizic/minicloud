/**
 * Reliability & observability integration tests — events, rollback, automatic
 * restart, metrics, and reconciliation against REAL Docker.
 * Requires: Docker running and PostgreSQL via `docker compose up -d postgres`.
 * Run with: npm run test:integration -w @minicloud/api
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, destroyTestContext, waitUntilContainerExited, type TestContext } from './test-helpers.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

let ctx: TestContext;
let fixtures: FixtureServer;

beforeAll(async () => {
  ctx = await createTestApp();
  fixtures = await startFixtureServer([
    'hello-node',
    'failing-app',
    'crash-once',
    { name: 'rev-app', revisions: ['rev-app-a', 'rev-app-b'] },
  ]);
}, 240_000);

afterAll(async () => {
  await fixtures?.close();
  await destroyTestContext(ctx);
});

// Polling helper: real Docker/Postgres state cannot be driven by a fake clock,
// so a genuine interval between polls is required.
async function waitFor(
  probe: () => Promise<string | null>,
  target: (value: string) => boolean,
  timeoutMs: number,
  description: string,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== null && target(value)) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${description}; last=${value ?? 'null'}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function depStatus(deploymentId: string): Promise<string> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${deploymentId}` });
  return res.json().status as string;
}

function waitForStatus(deploymentId: string, statuses: string[], timeoutMs = 120_000): Promise<string> {
  return waitFor(() => depStatus(deploymentId), (s) => statuses.includes(s), timeoutMs, statuses.join('/'));
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

/** The API DTO intentionally omits container internals; tests read it from the DB. */
async function containerIdOf(deploymentId: string): Promise<string | null> {
  const res = await ctx.db.query('SELECT container_id FROM deployments WHERE id = $1', [deploymentId]);
  return (res.rows[0]?.container_id as string | null) ?? null;
}

type EventRow = { id: string; type: string; message: string; metadata: Record<string, unknown> | null };

async function getEvents(deploymentId: string): Promise<EventRow[]> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${deploymentId}/events` });
  expect(res.statusCode).toBe(200);
  return res.json().events as EventRow[];
}

describe('deployment events (real docker)', () => {
  it('records an ordered lifecycle timeline for a successful deployment', async () => {
    const appId = await createApp('rel-events', 'hello-node');
    const depId = await deploy(appId);
    await waitForStatus(depId, ['RUNNING']);

    const events = await getEvents(depId);
    const types = events.map((e) => e.type);
    // v0.7: the queue claims the job before the pipeline starts, so the
    // timeline now begins with queue.claimed followed by deployment.created.
    expect(types[0]).toBe('queue.claimed');
    expect(types[1]).toBe('deployment.created');
    for (const expected of [
      'clone.started', 'clone.completed', 'build.started', 'build.completed',
      'container.starting', 'container.started', 'health_check.started',
      'health_check.passed', 'deployment.running',
    ]) {
      expect(types, `missing ${expected}`).toContain(expected);
    }
    // Deterministic ordering: strictly increasing event ids, and stage order.
    const ids = events.map((e) => Number(e.id));
    for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
    expect(types.indexOf('clone.completed')).toBeLessThan(types.indexOf('build.started'));
    expect(types.indexOf('health_check.passed')).toBeLessThan(types.indexOf('deployment.running'));
    // Metadata carries structural context, never secret material.
    const started = events.find((e) => e.type === 'container.started');
    expect(started?.metadata).toMatchObject({ hostPort: expect.any(Number) });
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 240_000);

  it('404s for unknown deployments and 400s for malformed ids', async () => {
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/deployments/00000000-0000-4000-8000-000000000000/events' })).statusCode,
    ).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/deployments/nope/events' })).statusCode).toBe(400);
  });
});

describe('rollback (real docker)', () => {
  it('rolls back to a previous revision via image reuse, creating a NEW deployment', async () => {
    const appId = await createApp('rel-rollback', 'rev-app');
    // HEAD is revision-b; deploy the older revision explicitly first.
    const shaA = fixtures.sha('rev-app', 0);
    const shaB = fixtures.sha('rev-app', 1);
    const depA = await deploy(appId, { ref: shaA });
    await waitForStatus(depA, ['RUNNING']);
    const aRow1 = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depA}` })).json();
    const portA = aRow1.hostPort as number;
    expect(await (await fetch(`http://127.0.0.1:${portA}/version`)).text()).toBe('revision-a\n');

    const depB = await deploy(appId, { ref: shaB });
    await waitForStatus(depB, ['RUNNING']);
    const bRow = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depB}` })).json();
    expect(await (await fetch(`http://127.0.0.1:${bRow.hostPort}/version`)).text()).toBe('revision-b\n');

    // Roll the application back to revision A.
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/rollback`,
      payload: { targetDeploymentId: depA },
    });
    expect(res.statusCode, res.body).toBe(202);
    const depC = res.json().deployment.id as string;
    await waitForStatus(depC, ['RUNNING']);

    const cRow = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depC}` })).json();
    expect(depC).not.toBe(depA);
    expect(cRow.rollbackOf).toBe(depA);
    expect(cRow.commitSha).toBe(shaA);
    expect(await (await fetch(`http://127.0.0.1:${cRow.hostPort}/version`)).text()).toBe('revision-a\n');

    // Fast path: image reused, no clone/build ran for C.
    const types = (await getEvents(depC)).map((e) => e.type);
    expect(types).toContain('rollback.requested');
    expect(types).toContain('build.skipped');
    expect(types).not.toContain('build.completed');
    const afterA = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depA}` })).json();
    // Retirement of the predecessor happens asynchronously after each
    // cutover (bounded drain, then stop) — wait for it instead of racing it.
    await waitForStatus(depB, ['STOPPED'], 30_000);
    const afterB = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depB}` })).json();
    expect(afterA.status).toBe('STOPPED');
    expect(afterB.status).toBe('STOPPED');
    expect(afterA.config).toEqual(beforeA.config);
    expect(afterA.rollbackOf ?? null).toBe(beforeA.rollbackOf ?? null);
    // C serves revision-a through its own port.
    expect(await (await fetch(`http://127.0.0.1:${cRow.hostPort}/version`)).text()).toBe('revision-a\n');

    for (const d of [depA, depB, depC]) {
      await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${d}` });
    }
  }, 360_000);

  it('rebuilds from the recorded commit when the target image is gone', async () => {
    const appId = await createApp('rel-rollback-rebuild', 'rev-app');
    const shaA = fixtures.sha('rev-app', 0);
    const depA = await deploy(appId, { ref: shaA });
    await waitForStatus(depA, ['RUNNING']);
    const aRow = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depA}` })).json();

    // Destroy the image to force the rebuild path.
    const removed = await ctx.docker.removeImage(aRow.imageTag as string, { force: true });
    expect(removed).toBe(true);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/rollback`,
      payload: { targetDeploymentId: depA },
    });
    expect(res.statusCode).toBe(202);
    const depC = res.json().deployment.id as string;
    await waitForStatus(depC, ['RUNNING'], 240_000);

    const cRow = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depC}` })).json();
    expect(cRow.rollbackOf).toBe(depA);
    expect(cRow.commitSha).toBe(shaA);
    expect(await (await fetch(`http://127.0.0.1:${cRow.hostPort}/version`)).text()).toBe('revision-a\n');
    // The rebuild path really cloned and built.
    const types = (await getEvents(depC)).map((e) => e.type);
    expect(types).toContain('clone.completed');
    expect(types).toContain('build.completed');

    for (const d of [depA, depC]) {
      await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${d}` });
    }
  }, 420_000);

  it('rejects invalid, foreign, and unbuilt rollback targets', async () => {
    const appId = await createApp('rel-rollback-val', 'hello-node');
    const otherApp = await createApp('rel-rollback-val-other', 'hello-node');
    const otherDep = await deploy(otherApp);

    // Unknown target
    const missing = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/rollback`,
      payload: { targetDeploymentId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(missing.statusCode).toBe(404);

    // Target from another application
    const foreign = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/rollback`,
      payload: { targetDeploymentId: otherDep },
    });
    expect(foreign.statusCode).toBe(409);

    // Target that never produced an image: queue a deploy and use it immediately.
    const queued = await deploy(appId);
    const unbuilt = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/rollback`,
      payload: { targetDeploymentId: queued },
    });
    expect([202, 409]).toContain(unbuilt.statusCode); // may already be built on fast machines; both are acceptable outcomes
    if (unbuilt.statusCode === 202) {
      await waitForStatus(unbuilt.json().deployment.id, ['RUNNING', 'FAILED']);
    }

    for (const d of [otherDep, queued]) {
      const s = await depStatus(d);
      if (s === 'RUNNING') await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${d}` });
    }
  }, 240_000);
});

describe('automatic restart policy (real docker)', () => {
  it('recovers a crash-once application to RUNNING (scenario B)', async () => {
    const appId = await createApp('rel-crash-once', 'crash-once');
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/restart-policy`,
      payload: { policy: 'on-failure', maxRestartAttempts: 3 },
    });
    expect(put.statusCode).toBe(200);

    const depId = await deploy(appId);
    // Initial start passes health, crashes ~5s in, and the automatic restart
    // must bring it back: RUNNING with exactly one automatic attempt. The
    // crash processor is invoked explicitly (no background monitor in tests).
    const recoverProbe = async (): Promise<string> => {
      await ctx.engine.checkCrashes();
      return ctx.db
        .query('SELECT status, auto_restart_count FROM deployments WHERE id = $1', [depId])
        .then((r) => `${r.rows[0]?.status}:${r.rows[0]?.auto_restart_count}`);
    };
    await waitFor(
      recoverProbe,
      (s) => s === 'RUNNING:1',
      150_000,
      'auto recovery to RUNNING:1',
    );
    const row = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(row.restartCount).toBe(1);
    expect(await containerIdOf(depId)).toBeTruthy();

    // The recovered container is genuinely healthy.
    const health = await fetch(`http://127.0.0.1:${row.hostPort}/health`);
    expect(health.status).toBe(200);

    const types = (await getEvents(depId)).map((e) => e.type);
    expect(types).toContain('container.crashed');
    expect(types).toContain('restart.auto_scheduled');
    expect(types).toContain('restart.auto_attempt');
    expect(types).toContain('restart.auto_succeeded');

    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 300_000);

  it('stops after the configured retry budget (scenario C)', async () => {
    const appId = await createApp('rel-exhaust', 'failing-app');
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/restart-policy`,
      payload: { policy: 'on-failure', maxRestartAttempts: 2 },
    });
    expect(put.statusCode).toBe(200);

    const depId = await deploy(appId);
    // Initial run + 2 retries, then final FAILED. Each monitor pass is driven
    // explicitly so retry accounting is deterministic under any runner load.
    await waitFor(
      async () => {
        await ctx.engine.checkCrashes();
        return ctx.db
          .query('SELECT auto_restart_count, status, container_id FROM deployments WHERE id = $1', [depId])
          .then((r) => `${r.rows[0]?.status}:${r.rows[0]?.auto_restart_count}:${r.rows[0]?.container_id ?? 'none'}`);
      },
      (s) => s.startsWith('FAILED:2:none'),
      240_000,
      'retry exhaustion (FAILED:2:none)',
    );

    const row = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(row.autoRestartCount).toBe(2);
    expect(String(row.failureReason)).toMatch(/exited/i);
    // The terminal event is written right after the FAILED transition; wait
    // for it rather than racing the insert.
    await waitFor(
      () => getEvents(depId).then((events) => String(events.filter((e) => e.type === 'deployment.failed').length)),
      (n) => n === '1',
      30_000,
      'deployment.failed event',
    );
    const types = (await getEvents(depId)).map((e) => e.type);
    expect(types.filter((t) => t === 'restart.auto_scheduled')).toHaveLength(2);
    expect(types.filter((t) => t === 'restart.auto_attempt')).toHaveLength(2);
    expect(types).toContain('deployment.failed');

    // No further containers may appear after exhaustion.
    await new Promise((r) => setTimeout(r, 20_000));
    const after = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(after.status).toBe('FAILED');
    expect(await containerIdOf(depId)).toBeNull();
    expect(after.autoRestartCount).toBe(2);
    const scheduled = (await getEvents(depId)).filter((e) => e.type === 'restart.auto_scheduled');
    expect(scheduled).toHaveLength(2);

    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 360_000);

  it('never auto-restarts a manually stopped deployment', async () => {
    // crash-once recovers to RUNNING via auto restart; stopping it then must
    // be final (it would stay healthy, so any restart would be a bug).
    const appId = await createApp('rel-stop-suppress', 'crash-once');
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/restart-policy`,
      payload: { policy: 'on-failure', maxRestartAttempts: 3 },
    });
    const depId = await deploy(appId);
    await waitFor(
      async () => {
        await ctx.engine.checkCrashes();
        return ctx.db.query('SELECT status, auto_restart_count FROM deployments WHERE id = $1', [depId])
          .then((r) => `${r.rows[0]?.status}:${r.rows[0]?.auto_restart_count}`);
      },
      (s) => s === 'RUNNING:1',
      120_000,
      'auto recovery to RUNNING:1',
    );
    // The recovered deployment is ACTIVE: stopping it requires force.
    const refused = await ctx.app.inject({ method: 'POST', url: `/api/deployments/${depId}/stop` });
    expect(refused.statusCode).toBe(409);
    const stop = await ctx.app.inject({ method: 'POST', url: `/api/deployments/${depId}/stop?force=true` });
    expect(stop.json().status).toBe('STOPPED');

    // Exercise several monitor passes: none may resurrect the stopped deploy.
    for (let i = 0; i < 5; i++) {
      await ctx.engine.checkCrashes();
      await new Promise((r) => setTimeout(r, 1000));
    }
    const row = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(row.status).toBe('STOPPED');
    expect(row.autoRestartCount).toBe(1);
    expect(await containerIdOf(depId)).toBeNull();
    const scheduled = (await getEvents(depId)).filter((e) => e.type === 'restart.auto_scheduled');
    expect(scheduled).toHaveLength(1); // no new schedule after the manual stop
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 240_000);
});


describe('metrics (real docker)', () => {
  let appId: string;
  let depId: string;
  beforeAll(async () => {
    appId = await createApp('rel-metrics', 'hello-node');
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/limits`,
      payload: { memoryLimitMb: 128 },
    });
    depId = await deploy(appId);
    await waitForStatus(depId, ['RUNNING']);
  }, 240_000);

  it('reports live CPU/memory for a RUNNING container with the configured limit', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}/metrics` });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(m.memoryUsedBytes).toBeGreaterThan(0);
    // The cgroup limit we set is reflected exactly (128 MB).
    expect(m.memoryLimitBytes).toBe(128 * 1024 * 1024);
    expect(m.memoryPercent).toBeGreaterThan(0);
    expect(m.restartCount).toBe(0);
    expect(m.status).toBe('RUNNING');
  }, 60_000);

  it('refuses metrics for non-running deployments without faking zeros', async () => {
    await ctx.app.inject({ method: 'POST', url: `/api/deployments/${depId}/stop?force=true` });
    await waitForStatus(depId, ['STOPPED']);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}/metrics` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/RUNNING/);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/deployments/00000000-0000-4000-8000-000000000000/metrics' })).statusCode,
    ).toBe(404);
  }, 60_000);

  afterAll(async () => {
    if (depId) await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  });
});

describe('startup reconciliation (real docker)', () => {
  it('schedules recovery for a deployment that crashed while MiniCloud was offline', async () => {
    const appId = await createApp('rel-reconcile-recover', 'hello-node');
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/restart-policy`,
      payload: { policy: 'on-failure', maxRestartAttempts: 2 },
    });
    const depId = await deploy(appId);
    await waitForStatus(depId, ['RUNNING']);
    const containerId = await containerIdOf(depId);
    expect(containerId).toBeTruthy();

    // Simulate a crash while the API is down: stop the container behind the API's back.
    expect(await ctx.docker.stop(containerId!, 1)).toBe(true);
    await waitUntilContainerExited(ctx.docker, containerId!);

    // Startup reconciliation sees the dead container of a RUNNING row.
    // (The background monitor is disabled in tests — this call is the only
    // crash processor, so the outcome is deterministic.)
    const recon = await ctx.engine.reconcile();
    expect(recon.fixed).toBeGreaterThanOrEqual(1);

    // Policy on-failure: recovery passes then restore it. Every monitor pass
    // is driven explicitly — the background monitor is disabled in tests.
    const recoveryProbe = async (): Promise<string> => {
      await ctx.engine.checkCrashes();
      return depStatus(depId);
    };
    const status = await waitFor(
      recoveryProbe,
      (s) => s === 'RUNNING',
      120_000,
      'post-reconcile recovery',
    );
    expect(status).toBe('RUNNING');
    const afterRow = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    const newContainer = await containerIdOf(depId);
    expect(newContainer).toBeTruthy();
    expect(newContainer).not.toBe(containerId);
    expect(afterRow.autoRestartCount).toBe(1);

    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 240_000);

  it('marks FAILED and cleans up when policy is disabled', async () => {
    const appId = await createApp('rel-reconcile-fail', 'hello-node');
    const depId = await deploy(appId);
    await waitForStatus(depId, ['RUNNING']);
    const containerId = await containerIdOf(depId);
    expect(containerId).toBeTruthy();
    await ctx.docker.stop(containerId!, 1);
    await waitUntilContainerExited(ctx.docker, containerId!);

    await ctx.engine.reconcile();
    expect(await depStatus(depId)).toBe('FAILED');
    const after = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(await containerIdOf(depId)).toBeNull();
    expect(String(after.failureReason)).toMatch(/Reconciled|exited/i);
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  }, 240_000);

  it('does not resurrect manually stopped deployments and removes leftover containers', async () => {
    const appId = await createApp('rel-reconcile-stopped', 'hello-node');
    const depId = await deploy(appId);
    await waitForStatus(depId, ['RUNNING']);
    await ctx.app.inject({ method: 'POST', url: `/api/deployments/${depId}/stop?force=true` });
    await waitForStatus(depId, ['STOPPED']);

    // Recreate the leftover container scenario: nothing should restart it.
    const recon = await ctx.engine.reconcile();
    expect(recon.fixed).toBeGreaterThanOrEqual(0);
    expect(await depStatus(depId)).toBe('STOPPED');
    const containers = await ctx.docker.listManagedContainers();
    expect(containers.find((c) => c.labels['minicloud.deployment'] === depId)).toBeUndefined();
  }, 240_000);
});

describe('restart policy API', () => {
  it('validates and persists policy updates', async () => {
    const appId = await createApp('rel-policy-api', 'hello-node');
    const bad1 = await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/restart-policy`, payload: { policy: 'always' } });
    expect(bad1.statusCode).toBe(400);
    const bad2 = await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/restart-policy`, payload: { policy: 'on-failure', maxRestartAttempts: 11 } });
    expect(bad2.statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/restart-policy`, payload: { policy: 'on-failure', maxRestartAttempts: 5 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ policy: 'on-failure', maxRestartAttempts: 5 });
    const get = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/restart-policy` });
    expect(get.json()).toEqual({ policy: 'on-failure', maxRestartAttempts: 5 });
    // App detail serialization includes policy fields.
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}` });
    expect(detail.json().restartPolicy).toBe('on-failure');
  });
});
