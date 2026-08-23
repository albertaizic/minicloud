// MiniCloud API entrypoint: loads env, runs migrations, reconciles state,
// starts the crash monitor and serves HTTP.
import 'dotenv/config';
import { databaseFromEnv, runMigrations } from '@minicloud/db';
import { DockerRuntime } from '@minicloud/docker-runtime';
import {
  DeploymentEngine,
  defaultEngineConfigFromEnv,
} from '@minicloud/deployment-engine';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const db = databaseFromEnv();
  await runMigrations(db);
  console.log('migrations: ok');

  const docker = new DockerRuntime();
  const engineConfig = defaultEngineConfigFromEnv();
  const logger = {
    info: (msg: string, obj?: Record<string, unknown>) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
    warn: (msg: string, obj?: Record<string, unknown>) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
    error: (msg: string, obj?: Record<string, unknown>) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
  };
  const engine = new DeploymentEngine(db, docker, engineConfig, logger);

  const app = await buildApp({ db, docker, engine, engineConfig });

  // Startup reconciliation: DB vs Docker truth sync.
  try {
    await engine.reconcile();
  } catch (err) {
    logger.error('startup reconciliation failed', { error: String(err) });
  }

  // Crash monitor: detect RUNNING containers that exit unexpectedly.
  const monitorInterval = Number(process.env.CRASH_MONITOR_INTERVAL_MS ?? 5000);
  const monitor = setInterval(() => {
    void checkCrashes().catch((err) => logger.error('crash monitor error', { error: String(err) }));
  }, monitorInterval);
  monitor.unref();

  async function checkCrashes(): Promise<void> {
    const rows = await db.query<{ id: string; container_id: string | null; host_port: number | null; status: string; name: string }>(
      `SELECT d.id, d.container_id, d.host_port, d.status, a.name
       FROM deployments d JOIN applications a ON a.id = d.application_id
       WHERE d.status IN ('RUNNING')`,
    );
    for (const row of rows.rows) {
      if (!row.container_id) continue;
      const state = await docker.getContainerState(row.container_id).catch(() => null);
      if (state === null || !state.running) {
        await db.query(
          `UPDATE deployments SET status='FAILED', failure_reason=$2, exit_code=$3, stopped_at=now()
           WHERE id=$1 AND status='RUNNING'`,
          [
            row.id,
            state === null
              ? `Container disappeared unexpectedly`
              : `Container exited unexpectedly`,
            state?.exitCode ?? null,
          ],
        );
        logger.error('container crashed', { deploymentId: row.id, app: row.name, exitCode: state?.exitCode });
      }
    }
  }

  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });
  console.log(`minicloud api listening on http://localhost:${port}`);

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    clearInterval(monitor);
    await app.close().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
