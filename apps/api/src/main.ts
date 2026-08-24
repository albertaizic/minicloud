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

  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });
  console.log(`minicloud api listening on http://localhost:${port}`);

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
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
