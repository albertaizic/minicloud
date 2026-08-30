// E2E test database bootstrap: ensures minicloud_e2e exists before Playwright
// webServer starts. Must run BEFORE Playwright config.webServer launches the API
// server, because the API immediately runs migrations against that database.
//
// Usage: node e2e/helpers/ensure-test-db.mjs
// Idempotent: safe to run multiple times.
//
// Environment:
//   MINICLOUD_E2E_DATABASE_URL  — override default postgres://minicloud:minicloud@localhost:5433/minicloud_e2e
//   GITHUB_ACTIONS=true        — detected automatically in CI; skips docker compose

import pg from 'pg';
import { isGitHubActions } from './postgres.mjs';

const E2E_DATABASE = 'minicloud_e2e';
const DEFAULT_E2E_URL = `postgres://minicloud:minicloud@localhost:5433/${E2E_DATABASE}`;

function databaseUrls(env = process.env) {
  const e2e = new URL(env.MINICLOUD_E2E_DATABASE_URL ?? DEFAULT_E2E_URL);
  if (e2e.protocol !== 'postgres:' && e2e.protocol !== 'postgresql:') {
    throw new Error('MINICLOUD_E2E_DATABASE_URL must use postgres:// or postgresql://');
  }
  if (decodeURIComponent(e2e.pathname.slice(1)) !== E2E_DATABASE) {
    throw new Error(`MINICLOUD_E2E_DATABASE_URL must target ${E2E_DATABASE}`);
  }
  const admin = new URL(e2e);
  admin.pathname = '/postgres';
  admin.search = '';
  admin.hash = '';
  return { e2eUrl: e2e.toString(), adminUrl: admin.toString() };
}

async function connectAdmin(adminUrl, attempts = 60, delayMs = 500) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = new pg.Client({ connectionString: adminUrl });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function ensureTestDatabase(env = process.env) {
  if (!isGitHubActions(env)) {
    console.log('[e2e-db] ensuring postgres compose service is running');
    const { execFileSync } = await import('node:child_process');
    const path = await import('node:path');
    const repoRoot = path.resolve(import.meta.dirname ?? '.', '../..');
    execFileSync('docker', ['compose', 'up', '-d', 'postgres'], {
      cwd: repoRoot,
      stdio: 'pipe',
      timeout: 120_000,
    });
  }

  const { adminUrl } = databaseUrls(env);
  console.log('[e2e-db] connecting to admin database...');
  const client = await connectAdmin(adminUrl);
  try {
    console.log('[e2e-db] creating database minicloud_e2e if not exists...');
    await client.query(`DROP DATABASE IF EXISTS ${E2E_DATABASE} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${E2E_DATABASE}`);
    console.log('[e2e-db] database minicloud_e2e ready');
  } finally {
    await client.end();
  }
}

await ensureTestDatabase();