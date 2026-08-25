import { it, expect } from 'vitest';
import { createTestApp, destroyTestContext, type TestContext } from './test-helpers.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

let ctx: TestContext;
let fixtures: FixtureServer;

it('debug msvc', async () => {
  ctx = await createTestApp();
  fixtures = await startFixtureServer([{ name: 'msvc', revisions: ['msvc-a', 'msvc-b'] }]);
  const create = await ctx.app.inject({
    method: 'POST', url: '/api/apps',
    payload: { name: 'dbg-ms', repositoryUrl: fixtures.url('msvc') },
  });
  const appId = create.json().id;
  const dep = await ctx.app.inject({ method: 'POST', url: `/api/apps/${appId}/deploy`, payload: {} });
  const depId = dep.json().deployment.id;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const row = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    if (['RUNNING', 'FAILED', 'STOPPED'].includes(row.status)) {
      console.log('FINAL:', row.status, '|', row.failureReason);
      console.log('multiService:', row.multiService, 'services:', JSON.stringify(row.services?.map((s: { service: string; status: string; failureReason: string }) => `${s.service}:${s.status}:${s.failureReason ?? '-'}`)));
      break;
    }
  }
  const events = await ctx.db.query('SELECT event_type, message FROM deployment_events WHERE deployment_id = $1 ORDER BY id', [depId]);
  console.log('EVENTS:', events.rows.map((r) => `${r.event_type}(${r.message.slice(0, 70)})`).join(' | '));
  expect(true).toBe(true);
  await fixtures.close();
  await destroyTestContext(ctx);
}, 240_000);
