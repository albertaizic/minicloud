// Pre-pull every base image the fixture Dockerfiles use. After a cold daemon
// (restart, CI runner) these pulls would otherwise run INSIDE timed tests and
// blow their budgets before any MiniCloud code path is exercised.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname ?? '.', '../..');
const IMAGES = ['node:20-alpine', 'node:22-alpine'];

export default async function globalSetup() {
  // The database container must be up before anything else touches it.
  try {
    execFileSync('docker', ['inspect', 'minicloud-postgres'], { stdio: 'pipe' });
    execFileSync('docker', ['start', 'minicloud-postgres'], { stdio: 'pipe' });
  } catch {
    console.log('[e2e-setup] starting postgres via compose');
    execFileSync('docker', ['compose', 'up', '-d', 'postgres'], { cwd: repoRoot, stdio: 'pipe', timeout: 120_000 });
    execFileSync('docker', ['exec', 'minicloud-postgres', 'pg_isready', '-U', 'minicloud'], { stdio: 'pipe', timeout: 60_000 });
  }

  // Ensure the E2E database exists
  try {
    execFileSync('docker', ['exec', 'minicloud-postgres', 'psql', '-U', 'minicloud', '-c', 'DROP DATABASE IF EXISTS minicloud_e2e WITH (FORCE)'], { stdio: 'pipe' });
    execFileSync('docker', ['exec', 'minicloud-postgres', 'psql', '-U', 'minicloud', '-c', 'CREATE DATABASE minicloud_e2e'], { stdio: 'pipe' });
    console.log('[e2e-setup] database minicloud_e2e ready');
  } catch (e) {
    console.error('[e2e-setup] database setup failed:', String(e));
    throw e;
  }

  for (const image of IMAGES) {
    try {
      execFileSync('docker', ['image', 'inspect', image], { stdio: 'pipe' });
      console.log(`[e2e-setup] ${image} present`);
    } catch {
      console.log(`[e2e-setup] pulling ${image} ...`);
      execFileSync('docker', ['pull', image], { stdio: 'inherit', timeout: 600_000 });
    }
  }
}
