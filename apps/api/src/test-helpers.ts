// Test harness: spins up Postgres via docker compose (must be running),
// applies migrations into a throwaway database, and builds the app.
import pg from 'pg';
import { Database, runMigrations } from '@minicloud/db';
import { DockerRuntime } from '@minicloud/docker-runtime';
import { DeploymentEngine } from '@minicloud/deployment-engine';
import { buildApp } from './app.js';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://minicloud:minicloud@localhost:5433/postgres';

export interface TestContext {
  app: FastifyInstance;
  db: Database;
  dbName: string;
}

export async function createTestApp(): Promise<TestContext> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  const dbName = `minicloud_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${dbName}`);
  const pool = new pg.Pool({ connectionString: url });
  const db = new Database(pool);
  await runMigrations(db);

  const docker = new DockerRuntime();
  const engineConfig = {
    workspaceDir: path.join(os.tmpdir(), `minicloud-test-ws-${Date.now()}`),
    portRange: { start: 33000, end: 33999 },
    defaults: {
      containerPort: 3000,
      healthPath: '/health',
      healthTimeoutSeconds: 30,
      healthIntervalSeconds: 1,
    },
  };
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const engine = new DeploymentEngine(db, docker, engineConfig, logger);
  const app = await buildApp({ db, docker, engine, engineConfig });
  await app.ready();
  return { app, db, dbName };
}

export async function destroyTestContext(ctx: TestContext): Promise<void> {
  await ctx.app.close().catch(() => {});
  await ctx.db.close().catch(() => {});
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  // Terminate remaining connections before dropping.
  await admin
    .query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [ctx.dbName],
    )
    .catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${ctx.dbName}`).catch(() => {});
  await admin.end().catch(() => {});
}
