// Build-cache identity (v0.7): a deterministic fingerprint of everything that
// determines a Docker image's content for one build:
//   commit SHA + Dockerfile bytes + sorted content manifest of the context.
//
// Correctness rule: an image may be reused only when this fingerprint matches
// exactly. Content hashing (not timestamps) makes fingerprints stable across
// fresh clones; excluding .git keeps shallow/full clones equal. `node_modules`
// is excluded too: committing it is an anti-pattern MiniCloud's examples never
// follow, and hashing it would dominate fingerprint cost — a repo that DOES
// commit dependencies changes its lockfile/manifests instead, which are hashed.
//
// Bounds keep pathological repositories safe: >5000 files or >64MB of hashed
// content degrade to size-only entries for the remainder — still deterministic,
// still order-stable, just coarser. MiniCloud targets small single-node apps.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILES = 5000;
const MAX_HASHED_BYTES = 64 * 1024 * 1024;
const MAX_SINGLE_FILE = 8 * 1024 * 1024;

async function walk(dir: string, base: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    const rel = path.posix.join(base, e.name);
    if (e.isDirectory()) {
      await walk(full, rel, out);
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
}

/**
 * Fingerprint one image build. `contextDir` is the absolute build context,
 * `dockerfileRel` the dockerfile path relative to it ('.' contexts pass '').
 */
export async function fingerprintBuildInputs(
  commitSha: string | null,
  contextDir: string,
  dockerfileRel: string,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update('minicloud-build-v1\0');
  hash.update(`${commitSha ?? ''}\0`);
  hash.update(`${dockerfileRel.replace(/\\/g, '/')}\0`);

  const dfPath = dockerfileRel ? path.join(contextDir, dockerfileRel) : path.join(contextDir, 'Dockerfile');
  const dfBytes = await readFile(dfPath).catch(() => Buffer.alloc(0));
  hash.update(`${dfBytes.length}\0`);
  hash.update(dfBytes);

  const files: string[] = [];
  await walk(contextDir, '', files);
  hash.update(`${files.length}\0`);

  let hashedTotal = 0;
  for (const rel of files) {
    const s = await stat(path.join(contextDir, rel)).catch(() => null);
    const size = s?.size ?? -1;
    const withinBudget =
      size >= 0 && size <= MAX_SINGLE_FILE && hashedTotal + size <= MAX_HASHED_BYTES;
    let content: Buffer | null = null;
    if (withinBudget && size > 0) {
      content = await readFile(path.join(contextDir, rel)).catch(() => null);
    }
    if (content && content.length === size) {
      hashedTotal += size;
      hash.update(`F\0${rel}\0${size}\0`);
      hash.update(content);
    } else {
      // Oversized/unreadable/beyond-budget: size-only entry (deterministic).
      hash.update(`S\0${rel}\0${size}\0`);
    }
  }
  return hash.digest('hex');
}
