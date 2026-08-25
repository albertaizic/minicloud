import path from 'node:path';
import { defineConfig } from '@playwright/test';

const API_PORT = 4100;
const GW_PORT = 8080;
const DASH_PORT = 5173;
// Config lives in <root>/e2e/; repo root is one level up.
const ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

export default defineConfig({
  testDir: './tests',
  timeout: 600_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
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
      command: `node -e "const{execFileSync}=require('child_process');try{execFileSync('docker',['exec','minicloud-postgres','psql','-U','minicloud','-c','DROP DATABASE IF EXISTS minicloud_e2e'],{stdio:'pipe'})}catch{}try{execFileSync('docker',['exec','minicloud-postgres','psql','-U','minicloud','-c','CREATE DATABASE minicloud_e2e'],{stdio:'pipe'})}catch(e){console.error(e.message)}" && node "${TSX}" apps/api/src/main.ts`,
      port: API_PORT,
      reuseExistingServer: false,
      cwd: ROOT,
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        HOST: '0.0.0.0',
        DATABASE_URL: 'postgres://minicloud:minicloud@localhost:5433/minicloud_e2e',
        MINICLOUD_MASTER_KEY: 'e2e-master-key-0123456789abcdef',
        GATEWAY_PORT: String(GW_PORT),
        WORKSPACE_DIR: path.join(ROOT, '.minicloud', 'e2e-workspace'),
        PORT_RANGE_START: '34000',
        PORT_RANGE_END: '34999',
        LOG_LEVEL: 'warn',
        CRASH_MONITOR_INTERVAL_MS: '3000',
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
