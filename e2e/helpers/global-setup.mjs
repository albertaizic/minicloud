// Pre-pull every base image the fixture Dockerfiles use. After a cold daemon
// (restart, CI runner) these pulls would otherwise run INSIDE timed tests and
// blow their budgets before any MiniCloud code path is exercised.
import { execFileSync } from 'node:child_process';

const IMAGES = ['node:20-alpine', 'node:22-alpine'];

export default async function globalSetup() {
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
