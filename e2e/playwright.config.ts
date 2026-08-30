import path from 'node:path';
import { defineConfig } from '@playwright/test';

const API_PORT = 4100;
const GW_PORT = 8081;
const DASH_PORT = 5173;
// Config lives in <root>/e2e/; repo root is one level up.
const ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

export default defineConfig({
  globalSetup: './helpers/global-setup.mjs',
  globalTeardown: './helpers/global-teardown.mjs',
  timeout: 600_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // No retries: a rerun deploys over the previous attempt's state (same app
  // fixtures) and stomps it mid-assertions. Gates must pass first-try.
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: path.join(ROOT, 'e2e-artifacts', 'report'), open: 'never' }]],
  use: {
    baseURL: `http://localhost:${DASH_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  outputDir: path.join(ROOT, 'e2e-artifacts', 'results'),
  webServer: [
    {
      command: `node "${TSX}" e2e/helpers/fixture-server.mjs`,
      port: 4555,
      reuseExistingServer: false,
      cwd: ROOT,
      env: { PORT: '4555' },
    },
    {
      // The API server. Global setup already bootstraps the database.
      command: `node "${TSX}" apps/api/src/main.ts`,
      port: 4100,
      reuseExistingServer: false,
      cwd: ROOT,
      timeout: 180_000,
      env: {
        PORT: String(4100),
        HOST: '0.0.0.0',
        PORT_RANGE_END: String(34999),
        MINICLOUD_MAX_CONCURRENT_BUILDS: '1',
        MINICLOUD_MASTER_KEY: 'e2e-master-key-0123456789abcdef',
        GATEWAY_PORT: String(8081),
        WORKSPACE_DIR: path.join(ROOT, '.minicloud', 'e2e-workspace'),
        PORT_RANGE_START: '34000',
        PORT_RANGE_END: '34999',
        LOG_LEVEL: 'warn',
        CRASH_MONITOR_INTERVAL_MS: '3000',
        // CRITICAL: Point the API at the E2E database, not the dev database
        DATABASE_URL: 'postgres://minicloud:minicloud@localhost:5433/minicloud_e2e',
      },
    },
    {
      command: `node "${VITE}" --port ${DASH_PORT} --strictPort`,
      port: DASH_PORT,
      reuseExistingServer: false,
      cwd: path.join(ROOT, 'apps', 'dashboard'),
      timeout: 60_000,
      env: { MINICLOUD_API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});