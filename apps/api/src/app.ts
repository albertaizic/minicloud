// MiniCloud API: Fastify application factory.
// Routes are versioned under /api/v1. Live logs stream over SSE.
import Fastify, { type FastifyInstance } from 'fastify';
import {
  Database,
  AppRepository,
  DeploymentRepository,
  type ApplicationRow,
  type DeploymentRow,
} from '@minicloud/db';
import { DockerRuntime } from '@minicloud/docker-runtime';
import {
  DeploymentEngine,
  type EngineConfig,
  type LogListener,
} from '@minicloud/deployment-engine';
import { createAppSchema, deployAppSchema, isValidId, type DeploymentStatus } from '@minicloud/shared';

export interface BuildAppOptions {
  db: Database;
  docker: DockerRuntime;
  engine: DeploymentEngine;
  engineConfig: EngineConfig;
}

const MAX_SSE_CLIENTS_PER_DEPLOYMENT = 50;

function serializeApp(row: ApplicationRow) {
  return { id: row.id, name: row.name, repositoryUrl: row.repository_url, createdAt: row.created_at };
}

function serializeDeployment(row: DeploymentRow) {
  return {
    id: row.id,
    applicationId: row.application_id,
    ref: row.ref,
    commitSha: row.commit_sha,
    status: row.status as DeploymentStatus,
    imageTag: row.image_tag,
    containerName: row.container_name,
    hostPort: row.host_port,
    containerPort: row.container_port,
    healthPath: row.health_path,
    failureReason: row.failure_reason,
    exitCode: row.exit_code,
    restartCount: row.restart_count,
    createdAt: row.created_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    url: row.status === 'RUNNING' && row.host_port ? `http://localhost:${row.host_port}` : null,
  };
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino/file', options: { destination: 1 } }
          : undefined,
    },
    bodyLimit: 64 * 1024,
  });
  const { db, docker, engine } = opts;

  const apps = new AppRepository(db);
  const deployments = new DeploymentRepository(db);

  // ---- SSE fan-out registry -----------------------------------------------
  const logListeners = new Map<string, Set<LogListener>>();
  const clientCounts = new Map<string, number>();

  const engineListener: LogListener = (deploymentId, entry) => {
    const set = logListeners.get(deploymentId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(deploymentId, entry);
      } catch {
        /* never let one bad subscriber break the rest */
      }
    }
  };
  // Register our fan-out with the engine via a permanent listener.
  attachEngineLogForwarding(engine, engineListener);

  function subscribeLogs(deploymentId: string, listener: LogListener): () => void {
    let set = logListeners.get(deploymentId);
    if (!set) {
      set = new Set();
      logListeners.set(deploymentId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) logListeners.delete(deploymentId);
    };
  }

  // ---- health -------------------------------------------------------------
  app.get('/api/health', async (_req, reply) => {
    let dockerOk = true;
    try {
      await docker.ping();
    } catch {
      dockerOk = false;
    }
    await db.query('SELECT 1');
    return reply.code(dockerOk ? 200 : 503).send({
      status: dockerOk ? 'ok' : 'degraded',
      docker: dockerOk ? 'up' : 'unavailable',
      time: new Date().toISOString(),
    });
  });

  // ---- apps ---------------------------------------------------------------
  app.post('/api/apps', async (req, reply) => {
    const parsed = createAppSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }
    const { name, repositoryUrl } = parsed.data;
    if (await apps.byName(name)) {
      return reply.code(409).send({ error: `Application "${name}" already exists` });
    }
    const created = await apps.create(name, repositoryUrl);
    req.log.info({ appId: created.id, name }, 'application created');
    return reply.code(201).send(serializeApp(created));
  });

  app.get('/api/apps', async () => {
    const rows = await apps.list();
    const result = [];
    for (const a of rows) {
      const latest = await deployments.latestForApp(a.id);
      result.push({
        ...serializeApp(a),
        latestDeployment: latest
          ? { id: latest.id, status: latest.status, hostPort: latest.host_port, commitSha: latest.commit_sha, createdAt: latest.created_at }
          : null,
      });
    }
    return result;
  });

  app.get('/api/apps/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid application id' });
    const row = await apps.byId(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    const deps = await deployments.listByApp(id);
    return {
      ...serializeApp(row),
      deployments: deps.map(serializeDeployment),
    };
  });

  app.post('/api/apps/:id/deploy', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid application id' });
    const appRow = await apps.byId(id);
    if (!appRow) return reply.code(404).send({ error: 'Application not found' });
    const parsed = deployAppSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }
    const dep = await deployments.create(id, {
      ref: parsed.data.ref,
      healthPath: parsed.data.healthPath,
      containerPort: parsed.data.containerPort,
    });
    req.log.info({ deploymentId: dep.id, appId: id }, 'deployment created');
    // Fire-and-forget; progress is observable through GET /api/deployments/:id.
    void engine.runDeployment(dep.id).catch((err) => {
      req.log.error({ deploymentId: dep.id, error: String(err) }, 'pipeline crashed unexpectedly');
    });
    return reply.code(202).send({ deployment: serializeDeployment(dep), message: 'Deployment queued' });
  });

  // ---- deployments --------------------------------------------------------
  app.get('/api/deployments', async () => {
    const rows = await deployments.listAll();
    return rows.map(serializeDeployment);
  });

  app.get('/api/deployments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid deployment id' });
    const row = await deployments.byId(id);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });
    return serializeDeployment(row);
  });

  app.post('/api/deployments/:id/restart', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid deployment id' });
    const row = await deployments.byId(id);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });
    if (!['RUNNING', 'FAILED', 'STOPPED'].includes(row.status)) {
      return reply.code(409).send({ error: `Cannot restart deployment in state ${row.status}` });
    }
    try {
      const updated = await engine.restartDeployment(id);
      return serializeDeployment(updated);
    } catch (err) {
      req.log.warn({ deploymentId: id, error: String(err) }, 'restart failed');
      return reply.code(500).send({
        error: err instanceof Error ? err.message : 'Restart failed',
        deploymentStatus: (await deployments.byId(id))?.status,
      });
    }
  });

  app.post('/api/deployments/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid deployment id' });
    const row = await deployments.byId(id);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });
    const stoppable = ['QUEUED','CLONING','BUILDING','STARTING','HEALTH_CHECKING','RUNNING'];
    if (!stoppable.includes(row.status)) {
      return reply.code(409).send({ error: `Cannot stop deployment in state ${row.status}` });
    }
    const updated = await engine.stopDeployment(id);
    return serializeDeployment(updated);
  });

  app.delete('/api/deployments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid deployment id' });
    const row = await deployments.byId(id);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });
    await engine.deleteDeployment(id);
    return reply.code(204).send();
  });

  app.get('/api/deployments/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid deployment id' });
    const row = await deployments.byId(id);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });

    if (req.headers.accept?.includes('text/event-stream')) {
      // SSE live log streaming.
      const count = clientCounts.get(id) ?? 0;
      if (count >= MAX_SSE_CLIENTS_PER_DEPLOYMENT) {
        return reply.code(429).send({ error: 'Too many log streams for this deployment' });
      }
      clientCounts.set(id, count + 1);
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (source: string, stream: string, message: string) => {
        reply.raw.write(
          `data: ${JSON.stringify({ source, stream, message, timestamp: new Date().toISOString() })}\n\n`,
        );
      };
      // Replay recent container logs first when available.
      if (row.container_id) {
        const tail = await docker.recentLogs(row.container_id, 200).catch(() => '');
        for (const line of tail.split(/\r?\n/)) {
          if (line.trim()) send('container', 'stdout', line);
        }
      }
      const unsubscribe = subscribeLogs(id, (_depId, entry) => send(entry.source, entry.stream, entry.message));
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        clientCounts.set(id, Math.max(0, (clientCounts.get(id) ?? 1) - 1));
        reply.raw.end();
      };
      req.raw.on('close', cleanup);
      req.raw.on('error', cleanup);
      return reply;
    }

    // Plain recent-logs endpoint.
    if (!row.container_id) {
      return { deploymentId: id, logs: [], message: 'No container is associated with this deployment yet' };
    }
    const text = await docker.recentLogs(row.container_id, 500).catch(() => '');
    const logs = text.split(/\r?\n/).filter(Boolean).map((message) => ({ source: 'container', message }));
    return { deploymentId: id, logs };
  });

  // ---- apps delete ---------------------------------------------------------
  app.delete('/api/apps/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid application id' });
    const row = await apps.byId(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    const deps = await deployments.listByApp(id);
    for (const d of deps) {
      await engine.deleteDeployment(d.id).catch(() => {});
    }
    const deleted = await apps.delete(id);
    if (!deleted) return reply.code(500).send({ error: 'Failed to delete application' });
    return reply.code(204).send();
  });

  // Central error handler: avoid leaking internals.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const statusCode = err.statusCode ?? 500;
    req.log.error({ err }, 'request error');
    reply.code(statusCode >= 500 ? 500 : statusCode).send({
      error: statusCode >= 500 ? 'Internal server error' : err.message,
    });
  });

  // Crash monitor: detect RUNNING containers that exit unexpectedly.
  const monitorInterval = Number(process.env.CRASH_MONITOR_INTERVAL_MS ?? 5000);
  const monitor = setInterval(() => {
    void checkCrashes().catch((err) => {
      app.log.error({ err }, 'crash monitor error');
    });
  }, monitorInterval);
  monitor.unref();

  async function checkCrashes(): Promise<void> {
    const rows = await db.query<{ id: string; container_id: string | null; status: string }>(
      `SELECT d.id, d.container_id, d.status
       FROM deployments d
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
            state === null ? 'Container disappeared unexpectedly' : 'Container exited unexpectedly',
            state?.exitCode ?? null,
          ],
        );
        app.log.warn({ deploymentId: row.id, exitCode: state?.exitCode }, 'container crashed');
      }
    }
  }

  app.addHook('onClose', async () => {
    clearInterval(monitor);
    logListeners.clear();
  });

  return app;
}

/** Wire engine log emission into the SSE fan-out registry. */
function attachEngineLogForwarding(engine: DeploymentEngine, listener: LogListener): void {
  // The engine exposes emitLog publicly; wrap it once so every emission also
  // reaches our subscriber set.
  const anyEngine = engine as unknown as {
    emitLog: (...args: Parameters<LogListener>) => void;
  };
  const original = anyEngine.emitLog.bind(engine);
  anyEngine.emitLog = (deploymentId, entry) => {
    listener(deploymentId, entry);
    original(deploymentId, entry);
  };
}
