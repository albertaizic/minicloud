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

/** Deterministic master key used by tests that exercise secret endpoints. */
export const TEST_MASTER_KEY = Buffer.alloc(32, 3);

export interface TestContext {
  app: FastifyInstance;
  db: Database;
  dbName: string;
  engine: DeploymentEngine;
  docker: DockerRuntime;
  /** Port the application-traffic gateway listens on for this context. */
  gatewayPort: number;
}

// Deterministic engine tests drive engine.checkCrashes()/reconcile()
// explicitly; a live 5s background monitor would race them (CI Linux flake).
process.env.CRASH_MONITOR_INTERVAL_MS = String(60 * 60 * 1000);

export async function createTestApp(
  opts: { withMasterKey?: boolean; reuseDbName?: string } = {},
): Promise<TestContext> {
  // Deterministic behavior even if the operator shell exports a real key.
  delete process.env.MINICLOUD_MASTER_KEY;
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  const dbName =
    opts.reuseDbName ?? `minicloud_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  if (!opts.reuseDbName) await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${dbName}`);
  const pool = new pg.Pool({ connectionString: url });
  const db = new Database(pool);
  await runMigrations(db);

  const docker = new DockerRuntime();
  const engineConfig = {
    workspaceDir: path.join(os.tmpdir(), `minicloud-test-ws-${Date.now()}`),
    portRange: { start: 33000, end: 33999 },
    gatewayPort: 36000 + Math.floor(Math.random() * 1000),
    drainTimeoutSeconds: 2,
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
  const app = await buildApp({
    db,
    docker,
    engine,
    engineConfig,
    gatewayPort: engineConfig.gatewayPort,
    ...(opts.withMasterKey === false ? {} : { masterKey: TEST_MASTER_KEY }),
  });
  await app.ready();
  return { app, db, dbName, engine, docker, gatewayPort: engineConfig.gatewayPort };
}

/** Close app + pool WITHOUT dropping the database (for restart scenarios). */
export async function closeTestContext(ctx: TestContext): Promise<void> {
  await ctx.app.close().catch(() => {});
  await ctx.db.close().catch(() => {});
}

/**
 * Wait until Docker actually reports the container exited. `docker stop`
 * returning does not guarantee every subsequent inspect sees 'exited' on a
 * loaded runner (exit-state visibility timing).
 */
export async function waitUntilContainerExited(
  docker: { getContainerState(id: string): Promise<{ running: boolean } | null> },
  containerId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const state = await docker.getContainerState(containerId).catch(() => null);
    if (state === null || !state.running) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`container ${containerId.slice(0, 12)} still running after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function destroyTestContext(ctx: TestContext): Promise<void> {
  // Remove this context's managed containers BEFORE the database vanishes:
  // afterwards their deployment rows are gone and they would linger as
  // orphans until an explicit prune.
  await ctx.docker
    .listManagedContainers()
    .then(async (containers) => {
      const ids = new Set(
        (
          await ctx.db
            .query<{ id: string }>('SELECT id FROM deployments')
            .catch(() => ({ rows: [] as Array<{ id: string }> }))
        ).rows.map((r) => r.id),
      );
      for (const c of containers) {
        const depId = c.labels['minicloud.deployment'] ?? '';
        if (!ids.has(depId)) continue; // not ours (foreign labels are left alone)
        await ctx.docker.stop(c.id).catch(() => {});
        await ctx.docker.remove(c.id, true).catch(() => {});
      }
    })
    .catch(() => {});
  await closeTestContext(ctx);
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
