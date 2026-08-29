// Pre-pull every base image the fixture Dockerfiles use. After a cold daemon
// (restart, CI runner) these pulls would otherwise run INSIDE timed tests and
// blow their budgets before any MiniCloud code path is exercised.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname ?? '.', '../..');
const IMAGES = ['node:20-alpine', 'node:22-alpine'];

export default async function globalSetup() {
  // The database container must be up before anything else touches it.
  // In CI, postgres is a service container on localhost:5433.
  // Locally, it's a docker compose container named minicloud-postgres.
  const isCI = process.env.CI === 'true';
  const pgHost = isCI ? 'localhost' : 'minicloud-postgres';
  const pgPort = isCI ? '5433' : '5432';
  const pgUser = 'minicloud';
  const pgPass = 'minicloud';

  if (!isCI) {
    try {
      execFileSync('docker', ['inspect', 'minicloud-postgres'], { stdio: 'pipe' });
      execFileSync('docker', ['start', 'minicloud-postgres'], { stdio: 'pipe' });
    } catch {
      console.log('[e2e-setup] starting postgres via compose');
      execFileSync('docker', ['compose', 'up', '-d', 'postgres'], { cwd: repoRoot, stdio: 'pipe', timeout: 120_000 });
      execFileSync('docker', ['exec', 'minicloud-postgres', 'pg_isready', '-U', 'minicloud'], { stdio: 'pipe', timeout: 60_000 });
    }
  } else {
    // In CI, wait for postgres service to be ready
    execFileSync('pg_isready', ['-h', 'localhost', '-p', '5433', '-U', 'minicloud'], { stdio: 'pipe', timeout: 60_000 });
  }

  // Ensure the E2E database exists
  try {
    const psqlCmd = isCI
      ? ['psql', '-h', 'localhost', '-p', '5433', '-U', 'minicloud', '-c']
      : ['exec', 'minicloud-postgres', 'psql', '-U', 'minicloud', '-c'];
    const dropCmd = isCI ? psqlCmd : ['docker', ...psqlCmd];
    const createCmd = isCI ? psqlCmd : ['docker', ...psqlCmd];

    execFileSync(isCI ? 'psql' : 'docker', dropCmd.concat(['DROP DATABASE IF EXISTS minicloud_e2e WITH (FORCE)']), { stdio: 'pipe' });
    execFileSync(isCI ? 'psql' : 'docker', createCmd.concat(['CREATE DATABASE minicloud_e2e']), { stdio: 'pipe' });
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
