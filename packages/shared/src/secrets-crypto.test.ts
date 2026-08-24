// Unit tests for secret encryption at rest. No DB, no Docker.
import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, loadMasterKeyFromEnv, MasterKeyError } from './secrets-crypto.js';

const KEY = Buffer.alloc(32, 7); // deterministic test key
const OTHER_KEY = Buffer.alloc(32, 9);

describe('secret encryption', () => {
  it('roundtrips arbitrary values', () => {
    for (const plaintext of ['', 'hunter2', 'multi\nline\nvalue', 'üñïçø∂é 💩', 'x'.repeat(8192)]) {
      const stored = encryptSecret(plaintext, KEY);
      expect(decryptSecret(stored, KEY)).toBe(plaintext);
    }
  });

  it('never stores the plaintext in the ciphertext blob', () => {
    const secret = 'super-secret-value-abc123';
    const stored = encryptSecret(secret, KEY);
    expect(stored).not.toContain(secret);
    // format: v1:<iv>:<ciphertext+tag>, all base64
    expect(stored).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  });

  it('uses a fresh IV per call so identical plaintexts differ', () => {
    const a = encryptSecret('same', KEY);
    const b = encryptSecret('same', KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe('same');
    expect(decryptSecret(b, KEY)).toBe('same');
  });

  it('fails loudly on the wrong key instead of returning garbage', () => {
    const stored = encryptSecret('topsecret', KEY);
    expect(() => decryptSecret(stored, OTHER_KEY)).toThrow(MasterKeyError);
  });

  it('detects tampering with the ciphertext', () => {
    const stored = encryptSecret('topsecret', KEY);
    const [version, iv, blob] = stored.split(':');
    const raw = Buffer.from(blob!, 'base64');
    raw[0] = raw[0]! ^ 0xff;
    const tampered = `${version}:${iv}:${raw.toString('base64')}`;
    expect(() => decryptSecret(tampered, KEY)).toThrow(MasterKeyError);
  });

  it('rejects unknown formats and truncated blobs', () => {
    expect(() => decryptSecret('v9:aGVsbG8=:aGVsbG8=', KEY)).toThrow(MasterKeyError);
    expect(() => decryptSecret('not-a-ciphertext', KEY)).toThrow(MasterKeyError);
    expect(() => decryptSecret('v1:aaaa:aaaa', KEY)).toThrow(MasterKeyError);
  });
});

describe('master key loading', () => {
  it('accepts a sufficiently long key', () => {
    const key = loadMasterKeyFromEnv({ MINICLOUD_MASTER_KEY: 'a'.repeat(16) } as NodeJS.ProcessEnv);
    expect(key).toHaveLength(32);
  });

  it('rejects missing or short keys with actionable guidance', () => {
    expect(() => loadMasterKeyFromEnv({} as NodeJS.ProcessEnv)).toThrow(/MINICLOUD_MASTER_KEY/);
    expect(() => loadMasterKeyFromEnv({ MINICLOUD_MASTER_KEY: 'short' } as NodeJS.ProcessEnv)).toThrow(
      /at least 16 characters/,
    );
  });

  it('derives the same AES key from the same master key string', () => {
    const a = loadMasterKeyFromEnv({ MINICLOUD_MASTER_KEY: 'operator-secret-key' } as NodeJS.ProcessEnv);
    const b = loadMasterKeyFromEnv({ MINICLOUD_MASTER_KEY: 'operator-secret-key' } as NodeJS.ProcessEnv);
    expect(a.equals(b)).toBe(true);
  });
});
