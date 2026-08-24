/**
 * API tests for application configuration (v0.2): env vars, secrets, limits.
 * Needs PostgreSQL (docker compose up -d postgres) but NOT Docker-in-pipeline:
 * deployment pipeline behavior is covered by pipeline.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, destroyTestContext, TEST_MASTER_KEY, type TestContext } from './test-helpers.js';
import { encryptSecret } from '@minicloud/shared';

let ctx: TestContext;
let noKeyCtx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
  noKeyCtx = await createTestApp({ withMasterKey: false });
}, 120_000);

afterAll(async () => {
  await destroyTestContext(ctx);
  await destroyTestContext(noKeyCtx);
});

async function createApp(name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apps',
    payload: { name, repositoryUrl: 'https://github.com/example/repo.git' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

// ---- plain environment variables -------------------------------------------

describe('env var CRUD', () => {
  let appId: string;
  beforeAll(async () => {
    appId = await createApp('cfg-env-app');
  });

  it('sets and lists a variable', async () => {
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/env/LOG_LEVEL`,
      payload: { value: 'debug' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ key: 'LOG_LEVEL', value: 'debug' });

    const list = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/env` });
    expect(list.statusCode).toBe(200);
    expect(list.json().variables).toEqual([
      { key: 'LOG_LEVEL', value: 'debug', updatedAt: expect.any(String) },
    ]);
    expect(list.json().secrets).toEqual([]);
  });

  it('replaces the value on update', async () => {
    await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/env/LOG_LEVEL`, payload: { value: 'warn' } });
    const list = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/env` });
    const vars = list.json().variables as { key: string; value: string }[];
    expect(vars.filter((v) => v.key === 'LOG_LEVEL')).toHaveLength(1);
    expect(vars.find((v) => v.key === 'LOG_LEVEL')!.value).toBe('warn');
  });

  it('deletes a variable and then 404s', async () => {
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/apps/${appId}/env/LOG_LEVEL` });
    expect(del.statusCode).toBe(204);
    const second = await ctx.app.inject({ method: 'DELETE', url: `/api/apps/${appId}/env/LOG_LEVEL` });
    expect(second.statusCode).toBe(404);
  });

  it('rejects invalid keys and values with field details', async () => {
    for (const key of ['A=B', '1BAD', 'HAS SPACE', '$(id)', 'a;id']) {
      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/api/apps/${appId}/env/${encodeURIComponent(key)}`,
        payload: { value: 'x' },
      });
      expect(res.statusCode, key).toBe(400);
      expect(res.json().details.key).toBeDefined();
    }
    const tooLong = await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/env/BIG`,
      payload: { value: 'v'.repeat(8193) },
    });
    expect(tooLong.statusCode).toBe(400);
    // unknown fields rejected
    const extra = await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/env/OK_KEY`,
      payload: { value: 'x', isSecret: true },
    });
    expect(extra.statusCode).toBe(400);
  });
});

// ---- secrets -----------------------------------------------------------------

describe('secrets', () => {
  let appId: string;
  beforeAll(async () => {
    appId = await createApp('cfg-secret-app');
  });

  it('stores a secret without ever echoing its value', async () => {
    const secretValue = 'swordfish-12345';
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/secrets/API_TOKEN`,
      payload: { value: secretValue },
    });
    expect(put.statusCode).toBe(201);
    expect(JSON.stringify(put.json())).not.toContain(secretValue);

    // Listing shows the key only.
    const list = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/env` });
    expect(list.json().secrets).toEqual([{ key: 'API_TOKEN', updatedAt: expect.any(String) }]);
    expect(JSON.stringify(list.json())).not.toContain(secretValue);

    // The app detail payload (deployments included) must not leak it either.
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}` });
    expect(JSON.stringify(detail.json())).not.toContain(secretValue);
  });

  it('replaces a secret value; still only one entry, no value exposure', async () => {
    await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/secrets/API_TOKEN`, payload: { value: 'v2-rotated' } });
    await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/secrets/API_TOKEN`, payload: { value: 'v3-rotated' } });
    const list = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/env` });
    expect(list.json().secrets).toHaveLength(1);
    const raw = await ctx.db.query(
      `SELECT encrypted_value FROM app_env WHERE application_id = $1 AND key = 'API_TOKEN'`,
      [appId],
    );
    // Encrypted at rest: neither version appears in the stored ciphertext.
    const stored = raw.rows[0]!.encrypted_value as string;
    expect(stored).not.toContain('v2-rotated');
    expect(stored).not.toContain('v3-rotated');
    // And it decrypts with OUR master key to the latest value.
    const { decryptSecret } = await import('@minicloud/shared');
    expect(decryptSecret(stored, TEST_MASTER_KEY)).toBe('v3-rotated');
  });

  it('deletes via the secrets route and 404s on repeat / wrong kind', async () => {
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/apps/${appId}/secrets/API_TOKEN` })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/apps/${appId}/secrets/API_TOKEN` })).statusCode).toBe(404);
    // Plain vars are not secrets.
    await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/env/PLAIN`, payload: { value: 'x' } });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/apps/${appId}/secrets/PLAIN` })).statusCode).toBe(404);
  });

  it('refuses cross-kind overwrites instead of silently converting', async () => {
    await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/env/KIND_VAR`, payload: { value: 'plain' } });
    await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/secrets/KIND_SECRET`, payload: { value: 'sec' } });

    const upgrade = await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/secrets/KIND_VAR`,
      payload: { value: 'now-secret' },
    });
    expect(upgrade.statusCode).toBe(409);
    const downgrade = await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/env/KIND_SECRET`,
      payload: { value: 'now-plain' },
    });
    expect(downgrade.statusCode).toBe(409);

    const list = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/env` });
    const kinds = Object.fromEntries([
      ...list.json().variables.map((v: { key: string }) => [v.key, 'var']),
      ...list.json().secrets.map((v: { key: string }) => [v.key, 'secret']),
    ]) as Record<string, string>;
    expect(kinds.KIND_VAR).toBe('var');
    expect(kinds.KIND_SECRET).toBe('secret');
  });

  it('returns 503 with guidance when the master key is not configured', async () => {
    // Each context owns an isolated database, so create the app there.
    const created = await noKeyCtx.app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: { name: 'cfg-nokey-app', repositoryUrl: 'https://github.com/example/repo.git' },
    });
    expect(created.statusCode).toBe(201);
    const appId = created.json().id as string;

    // Plain vars still work without a master key...
    expect(
      (
        await noKeyCtx.app.inject({
          method: 'PUT',
          url: `/api/apps/${appId}/env/PLAIN`,
          payload: { value: 'v' },
        })
      ).statusCode,
    ).toBe(200);

    // ...but secrets are refused with operator guidance.
    const ok = await noKeyCtx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/secrets/TOKEN`,
      payload: { value: 'v' },
    });
    expect(ok.statusCode).toBe(503);
    expect(ok.json().error).toMatch(/MINICLOUD_MASTER_KEY/);
  });

  it('rejects invalid secret keys', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/secrets/BAD%20KEY`,
      payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---- resource limits -----------------------------------------------------------

describe('resource limits', () => {
  let appId: string;
  beforeAll(async () => {
    appId = await createApp('cfg-limits-app');
  });

  it('returns null limits initially', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/limits` });
    expect(res.json()).toEqual({ memoryLimitMb: null, cpuLimit: null });
  });

  it('sets both limits and reflects them in app serialization', async () => {
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/limits`,
      payload: { memoryLimitMb: 256, cpuLimit: 1.5 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ memoryLimitMb: 256, cpuLimit: 1.5 });
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}` });
    expect(detail.json().limits).toEqual({ memoryLimitMb: 256, cpuLimit: 1.5 });
  });

  it('partially updates without clearing the other limit', async () => {
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/apps/${appId}/limits`,
      payload: { cpuLimit: 0.5 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ memoryLimitMb: 256, cpuLimit: 0.5 });
  });

  it('clears both limits', async () => {
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/apps/${appId}/limits` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ memoryLimitMb: null, cpuLimit: null });
  });

  it('validates bounds, integer-ness, types, and strictness', async () => {
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ memoryLimitMb: 8 }, 400], // below min
      [{ memoryLimitMb: 65537 }, 400], // above max
      [{ memoryLimitMb: 12.5 }, 400], // non-integer
      [{ cpuLimit: 0.05 }, 400],
      [{ cpuLimit: 65 }, 400],
      [{ memoryLimitMb: '256' }, 400],
      [{}, 400], // at least one required
      [{ hostPort: 1 }, 400], // unknown field
    ];
    for (const [payload, expected] of cases) {
      const res = await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/limits`, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(expected);
    }
  });

  it('404s unknown or malformed app ids on all config routes', async () => {
    const routes: Array<{ m: 'GET' | 'PUT' | 'DELETE'; u: string; p?: object }> = [
      { m: 'GET', u: '/api/apps/not-a-uuid/env' },
      { m: 'PUT', u: '/api/apps/not-a-uuid/env/A', p: { value: 'v' } },
      { m: 'DELETE', u: '/api/apps/not-a-uuid/env/A' },
      { m: 'PUT', u: '/api/apps/not-a-uuid/secrets/A', p: { value: 'v' } },
      { m: 'DELETE', u: '/api/apps/not-a-uuid/secrets/A' },
      { m: 'GET', u: '/api/apps/not-a-uuid/limits' },
      { m: 'PUT', u: '/api/apps/not-a-uuid/limits', p: { cpuLimit: 1 } },
      { m: 'DELETE', u: '/api/apps/not-a-uuid/limits' },
    ];
    for (const r of routes) {
      const res = await ctx.app.inject({ method: r.m, url: r.u, ...(r.p ? { payload: r.p } : {}) });
      expect([404]).toContain(res.statusCode);
    }
    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/apps/00000000-0000-4000-8000-000000000000/env',
    });
    expect(missing.statusCode).toBe(404);
  });
});

// ---- deployment serialization ---------------------------------------------------

describe('deployment config serialization', () => {
  it('serializes queued deployments with a null snapshot and never leaks ciphertext', async () => {
    const appId = await createApp('cfg-deploy-app');
    const deploy = await ctx.app.inject({ method: 'POST', url: `/api/apps/${appId}/deploy`, payload: {} });
    expect(deploy.statusCode).toBe(202);
    const depId = deploy.json().deployment.id as string;

    // Store a secret so we can assert nothing ciphertext-shaped leaks out.
    await ctx.app.inject({ method: 'PUT', url: `/api/apps/${appId}/secrets/SOME_SECRET`, payload: { value: 'leak-check' } });

    const dep = await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` });
    expect(dep.statusCode).toBe(200);
    const body = dep.json();
    expect(body.config).toBeNull(); // not started yet -> no snapshot
    expect(JSON.stringify(body)).not.toContain('leak-check');

    // A pre-existing snapshot (as the engine writes it) serializes verbatim,
    // including secret KEY names but no values.
    await ctx.db.query(`UPDATE deployments SET config_snapshot = $2 WHERE id = $1`, [
      depId,
      JSON.stringify({
        env: { PLAIN: 'visible' },
        secretKeys: ['SOME_SECRET'],
        limits: { cpuLimit: 2 },
      }),
    ]);
    const updated = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
    expect(updated.config).toEqual({
      env: { PLAIN: 'visible' },
      secretKeys: ['SOME_SECRET'],
      limits: { cpuLimit: 2 },
    });
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
  });

  it('encrypts with scrypt-derived keys so equal plaintexts differ across rows', async () => {
    // Guards against regressions toward deterministic encryption.
    const a = encryptSecret('same-value', TEST_MASTER_KEY);
    const b = encryptSecret('same-value', TEST_MASTER_KEY);
    expect(a).not.toBe(b);
  });
});
