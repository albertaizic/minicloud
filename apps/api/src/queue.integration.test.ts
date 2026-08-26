// Queue integration tests (v0.7): persistent scheduling, concurrency bounds,
// superseding, cancellation and restart recovery — against real Docker.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DeploymentQueue } from '@minicloud/deployment-engine';
import {
  closeTestContext,
  createTestApp,
  destroyTestContext,
  type TestContext,
} from './test-helpers.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

function queueOf(app: FastifyInstance): DeploymentQueue {
  const q = (app as FastifyInstance & { minicloudQueue?: DeploymentQueue }).minicloudQueue;
  if (!q) throw new Error('queue not attached to test app');
  return q;
}

async function waitForDeploymentStatus(
  ctx: TestContext,
  deploymentId: string,
  statuses: string[],
  timeoutMs = 180_000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${deploymentId}` });
    const body = res.json();
    if (statuses.includes(body.status)) return body.status as string;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`deployment ${deploymentId} stuck at ${body.status}: ${body.failureReason ?? ''}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function createApp(ctx: TestContext, name: string, repoUrl: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apps',
    payload: { name, repositoryUrl: repoUrl },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

describe('persistent deployment queue (real docker)', () => {
  let ctx: TestContext;
  let fixtures: FixtureServer;

  beforeAll(async () => {
    fixtures = await startFixtureServer(['hello-node', 'failing-app', 'slow-build']);
    ctx = await createTestApp();
  });

  afterAll(async () => {
    queueOf(ctx.app).stop();
    await destroyTestContext(ctx);
    await fixtures.close();
  });

  it('manual deploys run through the queue to RUNNING with a completed job', async () => {
    const q = queueOf(ctx.app);
    // Harness auto-starts the scheduler (production parity); this test needs
    // to observe the QUEUED phase, so stop claiming first.
    q.stop();
    const appId = await createApp(ctx, `q-basic-${Date.now() % 100000}`, fixtures.url('hello-node'));
    const { deploymentId, jobId } = await q.createAndEnqueue(appId, { trigger: 'manual', desiredRef: 'HEAD' });
    // Scheduler is not started yet in tests; drive one claim explicitly.
    expect((await ctx.app.inject({ method: 'GET', url: `/api/queue` })).json().queued.length).toBeGreaterThan(0);
    q.start();
    await waitForDeploymentStatus(ctx, deploymentId, ['RUNNING']);
    // Job completes right after the pipeline settles; poll until terminal.
    let jobStatus = '';
    for (let i = 0; i < 40; i++) {
      const row = await ctx.db.query<{ status: string }>('SELECT status FROM deployment_jobs WHERE id = $1', [jobId]);
      jobStatus = row.rows[0]?.status ?? '';
      if (['completed', 'failed'].includes(jobStatus)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(jobStatus).toBe('completed');
    q.stop();
  }, 240_000);

  it('superseding: newest queued git job wins; manual jobs are untouched', async () => {
    // Deterministic: ensure no inherited scheduler is claiming work.
    const q = queueOf(ctx.app);
    q.stop();
    const appId = await createApp(ctx, `q-supersede-${Date.now() % 100000}`, fixtures.url('hello-node'));
    const a = await q.createAndEnqueue(appId, { trigger: 'git', desiredRef: 'HEAD' });
    const b = await q.createAndEnqueue(appId, { trigger: 'git', desiredRef: 'HEAD' });
    const c = await q.createAndEnqueue(appId, { trigger: 'git', desiredRef: 'HEAD' });
    const m = await q.createAndEnqueue(appId, { trigger: 'manual', desiredRef: 'HEAD' });
    expect(a.superseded).toBe(0);
    expect(b.superseded).toBe(1); // A
    expect(c.superseded).toBe(1); // B
    expect(m.superseded).toBe(0); // manual survives

    const snap = await q.snapshot(appId);
    // Superseded jobs are not in the live queue view; verify from the store.
    const dbJobs = await ctx.db.query<{ id: string; status: string }>(
      'SELECT id, status FROM deployment_jobs WHERE application_id = $1',
      [appId],
    );
    const statuses = new Map(dbJobs.rows.map((j) => [j.id, j.status]));
    expect(statuses.get(a.jobId)).toBe('superseded');
    expect(statuses.get(b.jobId)).toBe('superseded');
    expect(statuses.get(c.jobId)).toBe('queued');
    expect(statuses.get(m.jobId)).toBe('queued');

    // Superseded deployments must be parked in CANCELLED, never linger QUEUED.
    for (const depId of [a.deploymentId, b.deploymentId]) {
      const d = await ctx.db.query<{ status: string }>('SELECT status FROM deployments WHERE id = $1', [depId]);
      expect(d.rows[0]?.status).toBe('CANCELLED');
    }

    // Deterministic order: manual first, then the newest git job.
    const order = snap.queued.filter((j) => j.status === 'queued').map((j) => j.jobId);
    expect(order).toEqual([m.jobId, c.jobId]);

    // Cleanup without running builds.
    for (const j of snap.queued) {
      if (j.status === 'queued') await q.cancelByDeployment(j.deploymentId, 'test cleanup');
    }
  }, 60_000);

  it('cancel QUEUED is immediate', async () => {
    const q = queueOf(ctx.app);
    q.stop();
    const appId = await createApp(ctx, `q-cancel-${Date.now() % 100000}`, fixtures.url('hello-node'));
    const { deploymentId } = await q.createAndEnqueue(appId, { trigger: 'manual', desiredRef: 'HEAD' });
    const res = await ctx.app.inject({ method: 'POST', url: `/api/deployments/${deploymentId}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
    await waitForDeploymentStatus(ctx, deploymentId, ['CANCELLED'], 10_000);
  }, 60_000);

  it('cancel during BUILDING stops candidate work and unwinds cleanly', async () => {
    const q = queueOf(ctx.app);
    const appId = await createApp(ctx, `q-slow-${Date.now() % 100000}`, fixtures.url('slow-build'));
    const { deploymentId } = await q.createAndEnqueue(appId, { trigger: 'manual', desiredRef: 'HEAD' });
    q.start();
    // Wait until Docker-side building actually started (status flips fast).
    let seenBuilding = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const status = await waitForDeploymentStatus(ctx, deploymentId, ['CLONING', 'BUILDING', 'STARTING', 'HEALTH_CHECKING', 'RUNNING', 'FAILED'], 100_000)
        .catch(() => null);
      if (status === 'BUILDING' || status === 'STARTING') { seenBuilding = true; break; }
      if (status === 'RUNNING' || status === 'FAILED') break;
    }
    expect(seenBuilding, 'pipeline should be observable mid-build').toBe(true);

    const res = await ctx.app.inject({ method: 'POST', url: `/api/deployments/${deploymentId}/cancel` });
    expect(res.statusCode).toBe(200);
    await waitForDeploymentStatus(ctx, deploymentId, ['CANCELLED'], 60_000);
    q.stop();

    // No managed container may survive the cancellation.
    const containers = await ctx.docker.listManagedContainers();
    expect(containers.find((c) => c.labels['minicloud.deployment'] === deploymentId)).toBeUndefined();
  }, 300_000);

  it('clone failure produces FAILED + failed job; the scheduler keeps working', async () => {
    const q = queueOf(ctx.app);
    const appId = await createApp(ctx, `q-badclone-${Date.now() % 100000}`, 'http://localhost:4555/does-not-exist.git');
    const { deploymentId } = await q.createAndEnqueue(appId, { trigger: 'manual', desiredRef: 'HEAD' });
    const okApp = await createApp(ctx, `q-after-${Date.now() % 100000}`, fixtures.url('hello-node'));
    const ok = await q.createAndEnqueue(okApp, { trigger: 'manual', desiredRef: 'HEAD' });
    q.start();
    await waitForDeploymentStatus(ctx, deploymentId, ['FAILED']);
    await waitForDeploymentStatus(ctx, ok.deploymentId, ['RUNNING']);
    q.stop();
  }, 300_000);

  it('cache: unchanged rebuild reuses the exact image instead of rebuilding', async () => {
    const q = queueOf(ctx.app);
    const sha = fixtures.sha('hello-node', 0);
    const appId = await createApp(ctx, `q-cache-${Date.now() % 100000}`, fixtures.url('hello-node'));
    const first = await q.createAndEnqueue(appId, { trigger: 'manual', desiredRef: sha, commitSha: sha });
    q.start();
    await waitForDeploymentStatus(ctx, first.deploymentId, ['RUNNING']);
    q.stop();

    const second = await q.createAndEnqueue(appId, { trigger: 'manual', desiredRef: sha, commitSha: sha });
    q.start();
    await waitForDeploymentStatus(ctx, second.deploymentId, ['RUNNING']);
    q.stop();

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${second.deploymentId}` });
    expect(detail.json().buildCache).toBe('image_reused');
    const events = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${second.deploymentId}/events` });
    const types = (events.json().events as Array<{ type?: string }>).map((e) => e.type);
    expect(types).toContain('build.image_reused');
    // First build must have been a real build.
    const firstEvents = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${first.deploymentId}/events` });
    const firstTypes = (firstEvents.json().events as Array<{ type?: string }>).map((e) => e.type);
    expect(firstTypes).not.toContain('build.image_reused');
  }, 400_000);
});

describe('queue restart recovery (real docker)', () => {
  it('queued jobs survive an API restart; orphaned claims finalize from truth', async () => {
    const fixtures = await startFixtureServer(['hello-node']);
    const name = `q-restart-${Date.now() % 100000}`;
    // autostartQueue=false: the scenario is "process died before any work ran".
    let ctx = await createTestApp({ autostartQueue: false });
    const q1 = queueOf(ctx.app);
    const appId = await createApp(ctx, name, fixtures.url('hello-node'));
    const first = await q1.createAndEnqueue(appId, { trigger: 'manual', desiredRef: 'HEAD' });
    const second = await q1.createAndEnqueue(appId, { trigger: 'manual', desiredRef: 'HEAD' });
    // Simulate crash BEFORE any work ran (scheduler never started).
    await closeTestContext(ctx);

    // New process over the same database: reconcile -> recover -> schedule.
    ctx = await createTestApp({ reuseDbName: ctx.dbName, autostartQueue: false });
    const q2 = queueOf(ctx.app);
    const recovered = await q2.recoverAfterRestart();
    expect(recovered.finalized).toBe(0);
    q2.start();
    await waitForDeploymentStatus(ctx, first.deploymentId, ['RUNNING']);
    // Per-app serialization: second waits, then runs.
    await waitForDeploymentStatus(ctx, second.deploymentId, ['RUNNING']);
    q2.stop();
    await destroyTestContext(ctx);
    await fixtures.close();
  }, 500_000);
});
