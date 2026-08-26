// Cache acceptance measurement (v0.7): prints real wall-clock timings for
//   A. cold build            - first deploy of a revision
//   B. immediate rebuild     - same commit again (exact-image reuse path)
//   C. small source-only change
// Run: npx tsx scripts/cache-acceptance.ts   (needs Docker + Postgres up)
import 'dotenv/config';
import type { DeploymentQueue } from '@minicloud/deployment-engine';
import { startFixtureServer } from '../src/fixture-server.js';
import { createTestApp, destroyTestContext, type TestContext } from '../src/test-helpers.js';

function q(ctx: TestContext): DeploymentQueue {
  const queue = (ctx.app as unknown as { minicloudQueue?: DeploymentQueue }).minicloudQueue;
  if (!queue) throw new Error('queue not attached');
  return queue;
}

async function timedDeploy(ctx: TestContext, queue: DeploymentQueue, appId: string, sha: string): Promise<{ ms: number; status: string; cache: string | null }> {
  const started = Date.now();
  const { deploymentId } = await queue.createAndEnqueue(appId, { trigger: 'manual', desiredRef: sha, commitSha: sha });
  queue.start();
  for (;;) {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${deploymentId}` });
    const body = res.json();
    if (['RUNNING', 'FAILED', 'CANCELLED', 'STOPPED'].includes(body.status)) {
      queue.stop();
      return { ms: Date.now() - started, status: body.status as string, cache: body.buildCache ?? null };
    }
    if (Date.now() - started > 300_000) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 500));
  }
}

const fixtures = await startFixtureServer([
  { name: 'rev', revisions: ['rev-app-a', 'rev-app-b'] },
]);
const ctx = await createTestApp();
try {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apps',
    payload: { name: `cache-measure-${Date.now() % 100000}`, repositoryUrl: fixtures.url('rev') },
  });
  const appId = (res.json() as { id: string }).id;

  const cold = await timedDeploy(ctx, q(ctx), appId, fixtures.sha('rev', 0));
  console.log(`A cold build          : ${cold.ms} ms  (${cold.status}, build_cache=${cold.cache})`);

  const warm = await timedDeploy(ctx, q(ctx), appId, fixtures.sha('rev', 0));
  console.log(`B unchanged rebuild   : ${warm.ms} ms  (${warm.status}, build_cache=${warm.cache})`);
  console.log(`  -> speedup vs cold  : ${(cold.ms / Math.max(warm.ms, 1)).toFixed(2)}x`);

  const changed = await timedDeploy(ctx, q(ctx), appId, fixtures.sha('rev', 1));
  console.log(`C small source change : ${changed.ms} ms  (${changed.status}, build_cache=${changed.cache})`);

  // Correctness after restart: reuse must still work.
  const afterRestart = await timedDeploy(ctx, q(ctx), appId, fixtures.sha('rev', 0));
  console.log(`D revision 0 again    : ${afterRestart.ms} ms  (${afterRestart.status}, build_cache=${afterRestart.cache})`);
} finally {
  await destroyTestContext(ctx);
  await fixtures.close();
}
