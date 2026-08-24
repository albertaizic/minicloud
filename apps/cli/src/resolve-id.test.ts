import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveDeploymentId,
  resolveAppId,
  assertPlausibleId,
  isFullUuid,
  AmbiguousIdError,
} from './api-client.js';

const DEP_A = '11111111-2222-4333-8444-555566667777';
const DEP_B = '11119999-2222-4333-8444-555566667777';
const DEP_C = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000';
const APP_A = '99990000-1111-4222-8333-444455556666';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  // Minimal fake API: /api/deployments and /api/apps
  const fetchMock = async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/api/deployments')) {
      return jsonResponse([
        { id: DEP_A, applicationId: APP_A, status: 'RUNNING' },
        { id: DEP_B, applicationId: APP_A, status: 'FAILED' },
        { id: DEP_C, applicationId: APP_A, status: 'STOPPED' },
      ]);
    }
    if (url.endsWith('/api/apps')) {
      return jsonResponse([
        { id: APP_A, name: 'my-app', repositoryUrl: 'https://x', createdAt: '' },
      ]);
    }
    return new Response('not found', { status: 404 });
  };
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('short-ID resolution', () => {
  it('recognizes full UUIDs', () => {
    expect(isFullUuid(DEP_A)).toBe(true);
    expect(isFullUuid(DEP_A.slice(0, 8))).toBe(false);
  });

  it('passes full UUIDs through without an API round-trip', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; throw new Error('should not be called'); });
    await expect(resolveDeploymentId(DEP_A)).resolves.toBe(DEP_A);
    expect(calls).toBe(0);
  });

  it('resolves an unambiguous short prefix to the full id', async () => {
    await expect(resolveDeploymentId('aaaa')).resolves.toBe(DEP_C);
    await expect(resolveDeploymentId(DEP_A.slice(0, 12))).resolves.toBe(DEP_A);
  });

  it('rejects ambiguous prefixes with a clear error listing matches', async () => {
    // '1111' prefixes both DEP_A and DEP_B
    const err = await resolveDeploymentId('1111').then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(AmbiguousIdError);
    expect((err as Error).message).toContain('Ambiguous deployment id');
    expect((err as Error).message).toContain(DEP_A);
    expect((err as Error).message).toContain(DEP_B);
    expect((err as Error).message).toContain('longer prefix');
  });

  it('lets unknown ids fall through so the API reports not-found', async () => {
    await expect(resolveDeploymentId('deadbeef')).resolves.toBe('deadbeef');
  });

  it('rejects implausible garbage ids fast', () => {
    expect(() => assertPlausibleId('')).toThrow(/not a valid/);
    expect(() => assertPlausibleId('../../etc/passwd')).toThrow(/not a valid/);
    expect(() => assertPlausibleId('; rm -rf /')).toThrow(/not a valid/);
    expect(() => assertPlausibleId('be3dcd6c')).not.toThrow();          // valid prefix
    expect(() => assertPlausibleId(DEP_A)).not.toThrow();               // full uuid
  });

  it('resolves app ids and app names', async () => {
    await expect(resolveAppId('my-app')).resolves.toBe(APP_A);           // by name
    await expect(resolveAppId('9999')).resolves.toBe(APP_A);            // by prefix
    await expect(resolveAppId(APP_A)).resolves.toBe(APP_A);             // full
    const err = await resolveAppId('99').then(() => null, (e) => e);
    void err; // '99' matches exactly one app here; ambiguity covered below
  });

  it('rejects ambiguous app prefixes', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).endsWith('/api/apps')) {
        return jsonResponse([
          { id: APP_A, name: 'one', repositoryUrl: '', createdAt: '' },
          { id: '9999ffff-1111-4222-8333-444455556666', name: 'two', repositoryUrl: '', createdAt: '' },
        ]);
      }
      return new Response('not found', { status: 404 });
    });
    const err = await resolveAppId('9999').then(() => null, (e) => e);
    expect(err).toBeInstanceOf(AmbiguousIdError);
    expect((err as Error).message).toContain('Ambiguous application id');
  });

  it('prefers exact app-name match over prefix matching', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      if (String(input).endsWith('/api/apps')) {
        return jsonResponse([{ id: APP_A, name: 'ab', repositoryUrl: '', createdAt: '' }]);
      }
      return new Response('not found', { status: 404 });
    });
    await expect(resolveAppId('ab')).resolves.toBe(APP_A);
  });
});
