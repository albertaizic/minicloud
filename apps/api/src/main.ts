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

  const app = await buildApp({
    db,
    docker,
    engine,
    engineConfig,
    gatewayPort: Number(process.env.GATEWAY_PORT ?? 8080),
  });

  // Startup reconciliation first: DB rows agree with Docker reality. Queue
  // recovery then finalizes/requeues jobs orphaned by the restart, and only
  // then does the scheduler start claiming new work.
  try {
    await engine.reconcile();
  } catch (err) {
    logger.error('startup reconciliation failed', { error: String(err) });
  }

  const queue = (app as import('fastify').FastifyInstance & { minicloudQueue?: import('@minicloud/deployment-engine').DeploymentQueue }).minicloudQueue;
  if (queue) {
    await queue.recoverAfterRestart();
    queue.start();
  } else {
    logger.warn('deployment queue not attached; skipping scheduler startup');
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
