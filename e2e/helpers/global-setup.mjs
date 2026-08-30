// Pre-pull every base image the fixture Dockerfiles use. After a cold daemon
// (restart, CI runner) these pulls would otherwise run INSIDE timed tests and
// blow their budgets before any MiniCloud code path is exercised.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isGitHubActions, recreateE2eDatabase } from './postgres.mjs';

const repoRoot = path.resolve(import.meta.dirname ?? '.', '../..');
const IMAGES = ['node:20-alpine', 'node:22-alpine'];

export default async function globalSetup() {
  // GitHub Actions supplies Postgres as a service container. Every other
  // environment — including local harnesses that export CI=true — uses the
  // compose service. The Node pg client below handles readiness uniformly.
  if (!isGitHubActions()) {
    console.log('[e2e-setup] ensuring postgres compose service is running');
    execFileSync('docker', ['compose', 'up', '-d', 'postgres'], {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 120_000,
    });
  }

  try {
    await recreateE2eDatabase();
    console.log('[e2e-setup] database minicloud_e2e ready');
  } catch (error) {
    console.error('[e2e-setup] database setup failed:', String(error));
    throw error;
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
