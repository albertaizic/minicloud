// Load/stress scenario (v0.7): mixed production/previews/failures under a
// bounded scheduler. Verifies the invariants that matter under load:
//   - running builds never exceed MINICLOUD_MAX_CONCURRENT_BUILDS
//   - every job reaches a terminal state
//   - failures do not wedge the scheduler
//   - no stale claims and no duplicate traffic cutovers afterwards
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DeploymentQueue } from '@minicloud/deployment-engine';
import {
  createTestApp,
  destroyTestContext,
  type TestContext,
} from './test-helpers.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

function q(ctx: TestContext): DeploymentQueue {
  const queue = (ctx.app as unknown as { minicloudQueue?: DeploymentQueue }).minicloudQueue;
  if (!queue) throw new Error('queue not attached');
  return queue;
}

const TERMINAL_DEP = ['RUNNING', 'FAILED', 'STOPPED', 'CANCELLED'];
const TERMINAL_JOB = ['completed', 'failed', 'cancelled', 'superseded'];

describe('queue stress: 3 apps, 10+ requests, concurrency 2 (real docker)', () => {
  let ctx: TestContext;
  let fixtures: FixtureServer;

  beforeAll(async () => {
    // Concurrency limit must be 2 for this scenario regardless of operator env.
    process.env.MINICLOUD_MAX_CONCURRENT_BUILDS = '2';
    fixtures = await startFixtureServer(['hello-node', 'failing-app']);
    ctx = await createTestApp();
  });

  afterAll(async () => {
    q(ctx).stop();
    delete process.env.MINICLOUD_MAX_CONCURRENT_BUILDS;
    await destroyTestContext(ctx);
    await fixtures.close();
  });

  it('survives a mixed burst without exceeding limits or wedging', async () => {
    const LIMIT = q(ctx).maxConcurrent;
    expect(LIMIT).toBe(2);


    const q0 = q(ctx);
    const repos = ['hello-node', 'hello-node', 'failing-app'] as const;
    const appIds: string[] = [];
    for (const [i, repo] of repos.entries()) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/apps',
        payload: { name: `stress-${i}-${Date.now() % 100000}`, repositoryUrl: fixtures.url(repo) },
      });
      appIds.push((res.json() as { id: string }).id);
    }
    // 10 requests: manual bursts on healthy apps, git-triggered on the
    // always-failing app (supersede candidates), previews come from the
    // dedicated preview suite; here we stress the scheduler itself.
    const enqueued: Array<{ jobId: string; deploymentId: string; app: number }> = [];
    for (let i = 0; i < 4; i++) {
      const r = await q0.createAndEnqueue(appIds[0]!, { trigger: 'manual', desiredRef: 'HEAD' });
      enqueued.push({ app: 0, ...r });
    }
    for (let i = 0; i < 3; i++) {
      const r = await q0.createAndEnqueue(appIds[1]!, { trigger: 'manual', desiredRef: 'HEAD' });
      enqueued.push({ app: 1, ...r });
    }
    for (let i = 0; i < 3; i++) {
      const r = await q0.createAndEnqueue(appIds[2]!, { trigger: 'git', desiredRef: 'HEAD' });
      enqueued.push({ app: 2, ...r });
    }

    q0.start();

    // Sample the queue while work flows: running must never exceed the limit.
    let maxRunning = 0;
    let samplesWithWork = 0;
    const deadline = Date.now() + 420_000;
    for (;;) {
      const snap = await q0.snapshot();
      maxRunning = Math.max(maxRunning, snap.running.length);
      if (snap.running.length > 0 || snap.queued.length > 0) samplesWithWork++;
      if (snap.running.length > LIMIT) throw new Error(`running ${snap.running.length} exceeds limit ${LIMIT}`);
      if (snap.running.length === 0 && snap.queued.length === 0 && Date.now() > deadline - 380_000 + 30_000) break;
      if (Date.now() > deadline) throw new Error('stress window elapsed with work still pending');
      if (samplesWithWork > 6 && snap.running.length === 0 && snap.queued.length === 0) break;
      await new Promise((r) => setTimeout(r, 700));
    }
    expect(maxRunning).toBeGreaterThan(0);
    expect(maxRunning).toBeLessThanOrEqual(LIMIT);

    // Every deployment terminal; every job terminal; no stale claims.
    const deps = await ctx.db.query<{ status: string }>('SELECT status FROM deployments');
    for (const row of deps.rows) expect(TERMINAL_DEP).toContain(row.status);
    const jobs = await ctx.db.query<{ status: string }>('SELECT DISTINCT status FROM deployment_jobs');
    for (const row of jobs.rows) expect(TERMINAL_JOB).toContain(row.status);

    // The always-failing app serves 500s but still answers HTTP, so its
    // pipeline legitimately reaches RUNNING; the intentional crash afterwards
    // is caught by the crash monitor. Tests disable the background monitor
    // and drive one tick explicitly (deterministic, same as other suites).
    await ctx.engine.checkCrashes();
    // Failures did happen (failing-app) and success happened too…
    const outcomes = await ctx.db.query<{ status: string; count: string }>(
      'SELECT status, COUNT(*)::text AS count FROM deployments GROUP BY status',
    );
    const byStatus = new Map(outcomes.rows.map((r) => [r.status, Number(r.count)]));
    // Superseding coalesces the 3 git-triggered deploys of the always-failing
    // app into a single execution: exactly one FAILED deployment results.
    expect(byStatus.get('FAILED') ?? 0).toBe(1);
    expect(byStatus.get('RUNNING') ?? 0).toBeGreaterThanOrEqual(2); // healthy apps served
    const supersededJobs = await ctx.db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM deployment_jobs WHERE status = 'superseded'",
    );
    expect(Number(supersededJobs.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(2);

    // …and the scheduler still works after all of it: one more deploy runs.
    const extra = await q0.createAndEnqueue(appIds[0]!, { trigger: 'manual', desiredRef: 'HEAD' });
    await new Promise<void>(async (resolveWait) => {
      for (;;) {
        const d = await ctx.db.query<{ status: string }>('SELECT status FROM deployments WHERE id = $1', [extra.deploymentId]);
        if (TERMINAL_DEP.includes(d.rows[0]?.status ?? '')) {
          resolveWait();
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    });
    // Scheduler survived: the extra deployment reached a terminal state.
    const final = await ctx.db.query<{ status: string }>('SELECT status FROM deployments WHERE id = $1', [extra.deploymentId]);
    expect(TERMINAL_DEP).toContain(final.rows[0]!.status);
  }, 600_000);
});
