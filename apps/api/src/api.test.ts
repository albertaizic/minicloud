// API tests. These need PostgreSQL (docker compose up -d postgres).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, destroyTestContext, type TestContext } from './test-helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
}, 120_000);

afterAll(async () => {
  await destroyTestContext(ctx);
});

describe('API', () => {
  it('reports health', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect([200, 503]).toContain(res.statusCode);
    const body = res.json();
    expect(body.status).toBeDefined();
    expect(body.docker).toBe('up');
  });

  it('rejects invalid payloads with 400 and field details', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: { name: '-bad name!', repositoryUrl: 'file:///etc/passwd' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.repositoryUrl).toBeDefined();
  });

  it('rejects command-injection URLs', async () => {
    for (const url of ['https://github.com/a/b; rm -rf /', '$(curl evil)', 'http://x.com/a?`id`']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/apps',
        payload: { name: 'ok-app', repositoryUrl: url },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('creates an application and prevents duplicate names', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: { name: 'dup-test', repositoryUrl: 'https://github.com/example/repo' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ name: 'dup-test', repositoryUrl: 'https://github.com/example/repo' });

    const dup = await ctx.app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: { name: 'dup-test', repositoryUrl: 'https://github.com/example/other' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('404s on unknown ids and rejects malformed ids', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/apps/not-a-uuid' })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/apps/${crypto.randomUUID()}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/deployments/nope' })).statusCode).toBe(400);
  });

  it('lists apps with latest deployment null initially', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/apps' });
    expect(res.statusCode).toBe(200);
    const apps = res.json();
    const found = apps.find((a: { name: string }) => a.name === 'dup-test');
    expect(found).toBeDefined();
    expect(found.latestDeployment).toBeNull();
  });

  it('queues a deployment and returns 202', async () => {
    const apps = (await ctx.app.inject({ method: 'GET', url: '/api/apps' })).json();
    const app = apps.find((a: { name: string }) => a.name === 'dup-test');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${app.id}/deploy`,
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().deployment.status).toBe('QUEUED');
  }, 60_000);

  it('rejects deploy options that fail validation', async () => {
    const apps = (await ctx.app.inject({ method: 'GET', url: '/api/apps' })).json();
    const app = apps.find((a: { name: string }) => a.name === 'dup-test');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${app.id}/deploy`,
      payload: { ref: 'main; echo pwned' },
    });
    expect(res.statusCode).toBe(400);
  });
});
