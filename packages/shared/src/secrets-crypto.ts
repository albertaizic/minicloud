// Secret encryption at rest: AES-256-GCM keyed from MINICLOUD_MASTER_KEY.
//
// The master key is supplied by the operator through the environment (see
// .env.example). It is never committed to git and never logged. Ciphertext
// format: v1:<base64(iv)>:<base64(ciphertext|authTag)>. Authenticated
// encryption means tampering or wrong-key decryption fails loudly instead of
// returning garbage that could leak into a container environment.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const VERSION = 'v1';
const IV_LEN = 12; // 96-bit IV, recommended for GCM
const KEY_LEN = 32;

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

/** Derive a 32-byte AES key from an operator-provided master key string. */
function deriveKey(masterKey: string): Buffer {
  // scrypt stretches a human-typed key; salt is fixed because the master key
  // itself is secret — this only needs to be deterministic across restarts.
  return scryptSync(masterKey, 'minicloud-secret-encryption', KEY_LEN);
}

export function loadMasterKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.MINICLOUD_MASTER_KEY;
  if (!raw || raw.length < 16) {
    throw new MasterKeyError(
      'MINICLOUD_MASTER_KEY must be set to at least 16 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return deriveKey(raw);
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    Buffer.concat([enc, tag]).toString('base64'),
  ].join(':');
}

/** Decrypt a stored secret. Throws when the ciphertext was tampered with or the key differs. */
export function decryptSecret(stored: string, key: Buffer): string {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new MasterKeyError('Unknown secret ciphertext format');
  }
  const iv = Buffer.from(parts[1]!, 'base64');
  const blob = Buffer.from(parts[2]!, 'base64');
  if (blob.length < 16) throw new MasterKeyError('Corrupt secret ciphertext'); // tag alone = empty plaintext
  const enc = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    throw new MasterKeyError(
      'Secret decryption failed: wrong MINICLOUD_MASTER_KEY or corrupted data',
    );
  }
}
