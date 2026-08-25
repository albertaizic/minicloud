// MiniCloud API: Fastify application factory.
// Routes are versioned under /api/v1. Live logs stream over SSE.
import Fastify, { type FastifyInstance } from 'fastify';
import {
  Database,
  AppRepository,
  DeploymentRepository,
  AppConfigRepository,
  DeploymentEventRepository,
  DeploymentServiceRepository,
  ApplicationVolumeRepository,
  type ApplicationRow,
  type DeploymentRow,
  type DeploymentServiceRow,
} from '@minicloud/db';
import {
  DeploymentEngine,
  type EngineConfig,
  type LogListener,
} from '@minicloud/deployment-engine';
import { DockerRuntime } from '@minicloud/docker-runtime';
import { Gateway, slugFromHost } from '@minicloud/gateway';
import { registerAutoDeployRoutes } from './auto-deploy.js';
import {
  createAppSchema,
  deployAppSchema,
  setEnvVarSchema,
  setSecretSchema,
  updateLimitsSchema,
  restartPolicySchema,
  rollbackSchema,
  isValidId,
  encryptSecret,
  decryptSecret,
  loadMasterKeyFromEnv,
  MasterKeyError,
  buildConfigSnapshot,
  type DeploymentConfigSnapshot,
  type DeploymentStatus,
} from '@minicloud/shared';

export interface BuildAppOptions {
  db: Database;
  docker: DockerRuntime;
  engine: DeploymentEngine;
  engineConfig: EngineConfig;
  /** AES key derived from MINICLOUD_MASTER_KEY; required only for secret operations. */
  masterKey?: Buffer;
  /** Port for the app-traffic gateway; 0/undefined disables routing. */
  gatewayPort?: number;
}

const MAX_SSE_CLIENTS_PER_DEPLOYMENT = 50;

function serializeApp(row: ApplicationRow, gatewayPort = 0) {
  return {
    id: row.id,
    name: row.name,
    repositoryUrl: row.repository_url,
    createdAt: row.created_at,
    routeSlug: row.route_slug,
    url: row.route_slug && gatewayPort > 0 ? `http://${row.route_slug}.localhost:${gatewayPort}` : null,
    activeDeploymentId: row.active_deployment_id,
    limits: {
      memoryLimitMb: row.memory_limit_mb ?? null,
      cpuLimit: row.cpu_limit ?? null,
    },
    restartPolicy: row.restart_policy,
    maxRestartAttempts: row.max_restart_attempts,
  };
}

function serializeSnapshot(raw: Record<string, unknown> | null): DeploymentConfigSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const snap = raw as unknown as DeploymentConfigSnapshot;
  if (!snap.env || !Array.isArray(snap.secretKeys)) return null;
  return snap;
}

function serializeDeployment(row: DeploymentRow, opts: { isActive?: boolean; services?: unknown[] } = {}) {
  return {
    id: row.id,
    applicationId: row.application_id,
    ref: row.ref,
    commitSha: row.commit_sha,
    status: row.status as DeploymentStatus,
    isActive: opts.isActive === true,
    imageTag: row.image_tag,
    containerName: row.container_name,
    hostPort: row.host_port,
    containerPort: row.container_port,
    healthPath: row.health_path,
    failureReason: row.failure_reason,
    exitCode: row.exit_code,
    restartCount: row.restart_count,
    autoRestartCount: row.auto_restart_count,
    rollbackOf: row.rollback_of_deployment_id,
    multiService: row.manifest_snapshot !== null,
    services: opts.services ?? null,
    config: serializeSnapshot(row.config_snapshot),
    createdAt: row.created_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    url: row.status === 'RUNNING' && row.host_port ? `http://localhost:${row.host_port}` : null,
  };
}


function serializeServiceRow(row: DeploymentServiceRow) {
  return {
    service: row.service_name,
    status: row.status,
    isActive: undefined,
    public: row.public_service,
    containerId: row.container_id,
    containerName: row.container_name,
    hostPort: row.host_port,
    containerPort: row.container_port,
    healthPath: row.health_path,
    restartCount: row.restart_count,
    autoRestartCount: row.auto_restart_count,
    failureReason: row.failure_reason,
    exitCode: row.exit_code,
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
  const gwPort = opts.gatewayPort ?? 0;

  const apps = new AppRepository(db);
  const deployments = new DeploymentRepository(db);
  const appConfig = new AppConfigRepository(db);
  const events = new DeploymentEventRepository(db);
  const services = new DeploymentServiceRepository(db);
  const volumes = new ApplicationVolumeRepository(db);

  const servicesFor = async (deploymentId: string) =>
    (await services.listByDeployment(deploymentId)).map(serializeServiceRow);

  registerAutoDeployRoutes(app, { apps, deployments, events, engine });

  // Application-traffic gateway: stable <slug>.localhost:<gwPort> URLs routed
  // to the active deployment. Upstreams come only from deployment state.
  let gateway: Gateway | null = null;
  if (gwPort > 0) {
    gateway = new Gateway();
    await gateway.start(gwPort);
    engine.setGateway(gateway);
    // One event per consecutive upstream failure streak (never per request).
    gateway.onUpstreamError = async (slug) => {
      try {
        const appRow = await apps.bySlug(slug);
        const depId = appRow?.active_deployment_id;
        if (appRow && depId) {
          await events.append(depId, 'gateway.upstream_unavailable', `upstream for ${slug} unreachable`);
        }
      } catch { /* event persistence is best-effort */ }
    };
    app.addHook('onClose', async () => {
      await gateway?.stop();
    });
  }

  // Master key: injected by tests or loaded from MINICLOUD_MASTER_KEY. An
  // absent variable means null — secrets stay disabled until configured. A
  // present-but-invalid key fails startup loudly instead of silently
  // degrading secret handling.
  const masterKey =
    opts.masterKey ?? (process.env.MINICLOUD_MASTER_KEY ? loadMasterKeyFromEnv() : null);

  // The engine calls this at container start to get env/secrets/limits. It
  // lives in the API because the master key must never leave this process;
  // decrypted values flow straight into the container create call and are
  // neither logged nor persisted.
  engine.setAppConfigResolver(async (applicationId) => {
    const decrypt = (stored: string, key: Buffer | null): string => {
      if (!key) {
        throw new MasterKeyError(
          'Application has secrets but MINICLOUD_MASTER_KEY is not configured on the MiniCloud API process',
        );
      }
      return decryptSecret(stored, key);
    };
    const { env, secretKeys } = await appConfig.resolveRuntimeEnv(applicationId, masterKey, decrypt);
    const limits = await appConfig.getLimits(applicationId);
    return {
      env,
      secretKeys,
      limits:
        limits.memoryLimitMb != null || limits.cpuLimit != null
          ? {
              ...(limits.memoryLimitMb != null ? { memoryLimitMb: limits.memoryLimitMb } : {}),
              ...(limits.cpuLimit != null ? { cpuLimit: limits.cpuLimit } : {}),
            }
          : null,
    };
  });

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

  // ---- application configuration -------------------------------------------

  async function requireApp(id: string): Promise<ApplicationRow | null> {
    if (!isValidId(id)) return null;
    return apps.byId(id);
  }

  function noMasterKey(reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    return reply.code(503).send({
      error:
        'Secrets are not configured. Set MINICLOUD_MASTER_KEY (at least 16 characters) on the MiniCloud API and restart it.',
    });
  }

  app.get('/api/apps/:id/env', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await requireApp(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    const [vars, secretKeys] = await Promise.all([
      appConfig.listVars(row.id),
      appConfig.listSecretKeys(row.id),
    ]);
    // Secret values are never returned — keys and metadata only.
    return {
      variables: vars.map((v) => ({ key: v.key, value: v.value, updatedAt: v.updatedAt })),
      secrets: secretKeys.map((s) => ({ key: s.key, updatedAt: s.updatedAt })),
    };
  });

  app.put('/api/apps/:id/env/:key', async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string };
    const row = await requireApp(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    const parsed = setEnvVarSchema.safeParse({ key, ...(req.body as object) });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }
    // Never silently downgrade a secret to a plaintext variable.
    const existingVar = await appConfig.byKey(row.id, parsed.data.key);
    if (existingVar?.is_secret) {
      return reply.code(409).send({
        error: `"${parsed.data.key}" is stored as a secret. Delete the secret first to recreate it as a plain variable.`,
      });
    }
    const saved = await appConfig.setVar(row.id, parsed.data.key, parsed.data.value);
    req.log.info({ appId: row.id, envKey: parsed.data.key }, 'env var set');
    return { key: saved.key, value: parsed.data.value, updatedAt: saved.updated_at };
  });

  app.delete('/api/apps/:id/env/:key', async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string };
    const row = await requireApp(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    const deleted = await appConfig.deleteKey(row.id, key);
    if (!deleted) return reply.code(404).send({ error: `No environment entry "${key}" on this application` });
    req.log.info({ appId: row.id, envKey: key }, `env ${deleted} deleted`);
    return reply.code(204).send();
  });

  app.put('/api/apps/:id/secrets/:key', async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string };
    const row = await requireApp(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    if (!masterKey) return noMasterKey(reply);
    const parsed = setSecretSchema.safeParse({ key, ...(req.body as object) });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }
    // Never silently upgrade a plaintext variable to a secret.
    const existingSecret = await appConfig.byKey(row.id, parsed.data.key);
    if (existingSecret && !existingSecret.is_secret) {
      return reply.code(409).send({
        error: `"${parsed.data.key}" is stored as a plain variable. Delete the variable first to store it as a secret.`,
      });
    }
    try {
      await appConfig.setSecret(row.id, parsed.data.key, encryptSecret(parsed.data.value, masterKey));
    } catch (err) {
      req.log.error({ appId: row.id, err }, 'secret encryption failed');
      return reply.code(500).send({ error: 'Failed to store secret' });
    }
    req.log.info({ appId: row.id, envKey: parsed.data.key }, 'secret set');
    // Deliberately value-free response.
    return reply.code(201).send({ key: parsed.data.key });
  });

  app.delete('/api/apps/:id/secrets/:key', async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string };
    const row = await requireApp(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    const existing = await appConfig.byKey(row.id, key);
    if (!existing || !existing.is_secret) {
      return reply.code(404).send({ error: `No secret "${key}" on this application` });
    }
    await appConfig.deleteKey(row.id, key);
    req.log.info({ appId: row.id, envKey: key }, 'secret deleted');
    return reply.code(204).send();
  });

  app.get('/api/apps/:id/limits', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await requireApp(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    return serializeApp(row).limits;
  });

  app.put('/api/apps/:id/limits', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await requireApp(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    const parsed = updateLimitsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }
    await appConfig.setLimits(row.id, parsed.data);
    req.log.info(
      { appId: row.id, memoryLimitMb: parsed.data.memoryLimitMb ?? null, cpuLimit: parsed.data.cpuLimit ?? null },
      'resource limits updated',
    );
    return serializeApp((await apps.byId(row.id))!).limits;
  });

  app.delete('/api/apps/:id/limits', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await requireApp(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    await appConfig.clearLimits(row.id);
    req.log.info({ appId: row.id }, 'resource limits cleared');
    return serializeApp((await apps.byId(row.id))!).limits;
  });


  // ---- reliability & observability (v0.3) -----------------------------------

  app.get('/api/deployments/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid deployment id' });
    const row = await deployments.byId(id);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });
    const list = await events.listByDeployment(id);
    return {
      deploymentId: id,
      events: list.map((e) => ({
        id: e.id,
        type: e.event_type,
        message: e.message,
        metadata: e.metadata,
        createdAt: e.created_at,
      })),
    };
  });

  app.get('/api/deployments/:id/metrics', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid deployment id' });
    const row = await deployments.byId(id);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });
    if (row.status !== 'RUNNING' || !row.container_id) {
      return reply.code(409).send({
        error: `Metrics are only available for RUNNING deployments (current: ${row.status})`,
        status: row.status,
      });
    }
    const stats = await docker.stats(row.container_id).catch((err) => {
      req.log.warn({ deploymentId: id, error: String(err) }, 'stats unavailable');
      return null;
    });
    if (!stats) {
      return reply.code(409).send({ error: 'Container metrics are unavailable right now', status: row.status });
    }
    return {
      deploymentId: id,
      status: row.status,
      containerState: 'running',
      restartCount: row.restart_count,
      autoRestartCount: row.auto_restart_count,
      startedAt: row.started_at,
      cpuPercent: stats.cpuPercent,
      memoryUsedBytes: stats.memoryUsedBytes,
      memoryLimitBytes: stats.memoryLimitBytes,
      memoryPercent: stats.memoryPercent,
    };
  });

  app.post('/api/apps/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid application id' });
    const appRow = await apps.byId(id);
    if (!appRow) return reply.code(404).send({ error: 'Application not found' });
    const parsed = rollbackSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }
    const targetId = parsed.data.targetDeploymentId;
    if (!isValidId(targetId)) {
      return reply.code(400).send({ error: 'Invalid target deployment id' });
    }
    try {
      const dep = await engine.rollbackDeployment(id, targetId);
      req.log.info({ deploymentId: dep.id, appId: id, rollbackOf: targetId }, 'rollback queued');
      return reply.code(202).send({
        deployment: serializeDeployment(dep),
        message: 'Rollback queued',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Rollback failed';
      if (/not found/i.test(msg)) return reply.code(404).send({ error: msg });
      if (/different application|no built image|in progress|could not be determined/i.test(msg)) {
        return reply.code(409).send({ error: msg });
      }
      req.log.error({ err, appId: id }, 'rollback failed');
      return reply.code(500).send({ error: 'Rollback failed' });
    }
  });

  app.get('/api/apps/:id/restart-policy', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid application id' });
    const row = await apps.byId(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    return { policy: row.restart_policy, maxRestartAttempts: row.max_restart_attempts };
  });

  app.put('/api/apps/:id/restart-policy', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid application id' });
    const row = await apps.byId(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    const parsed = restartPolicySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }
    const policy = parsed.data.policy;
    const max = parsed.data.maxRestartAttempts ?? row.max_restart_attempts;
    await apps.setRestartPolicy(id, policy, max);
    req.log.info({ appId: id, policy, maxRestartAttempts: max }, 'restart policy updated');
    return { policy, maxRestartAttempts: max };
  });

  app.post('/api/prune', async (req, reply) => {
    const result = await engine.prune();
    req.log.info(result, 'prune executed via api');
    return result;
  });

  // ---- routing (v0.4) -------------------------------------------------------

  app.get('/api/routes', async () => {
    if (!gateway) return { gatewayPort: 0, routes: [] };
    const snapshot = gateway.routeSnapshot();
    const withApps = await Promise.all(
      snapshot.map(async (r) => {
        const appRow = await apps.bySlug(r.slug);
        return {
          slug: r.slug,
          url: r.url,
          appId: appRow?.id ?? null,
          appName: appRow?.name ?? null,
          deploymentId: r.deploymentId,
          upstream: { host: r.host, port: r.port },
          activeSince: r.activeSince,
          stats: r.stats,
        };
      }),
    );
    return { gatewayPort: gwPort, routes: withApps };
  });

  // ---- health -------------------------------------------------------------
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
    return reply.code(201).send(serializeApp(created, gwPort));
  });

  app.get('/api/apps', async () => {
    const rows = await apps.list();
    const result = [];
    for (const a of rows) {
      const latest = await deployments.latestForApp(a.id);
      result.push({
        ...serializeApp(a, gwPort),
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
      ...serializeApp(row, gwPort),
      deployments: await Promise.all(
        deps.map(async (d) =>
          serializeDeployment(d, {
            isActive: row.active_deployment_id === d.id,
            services: d.manifest_snapshot ? await servicesFor(d.id) : undefined,
          }),
        ),
      ),
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
    return rows.map((d) => serializeDeployment(d));
  });

  app.get('/api/deployments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid deployment id' });
    const row = await deployments.byId(id);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });
    const appRow = await apps.byId(row.application_id);
    return serializeDeployment(row, {
      isActive: appRow?.active_deployment_id === row.id,
      services: row.manifest_snapshot ? await servicesFor(id) : undefined,
    });
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
    const force = (req.query as { force?: string }).force === 'true';
    try {
      const updated = await engine.stopDeployment(id, { force });
      const appRow = await apps.byId(row.application_id);
      return serializeDeployment(updated, { isActive: appRow?.active_deployment_id === id });
    } catch (err) {
      if (err instanceof Error && /ACTIVE deployment/.test(err.message)) {
        return reply.code(409).send({
          error: err.message,
          hint: 'Pass ?force=true to stop the active deployment anyway.',
        });
      }
      throw err;
    }
  });

  app.delete('/api/deployments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid deployment id' });
    const row = await deployments.byId(id);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });
    const bodyForce =
      typeof req.body === 'object' && req.body !== null && (req.body as { force?: boolean }).force === true;
    const force = (req.query as { force?: string }).force === 'true' || bodyForce;
    try {
      await engine.deleteDeployment(id, { force });
    } catch (err) {
      if (err instanceof Error && /ACTIVE deployment/.test(err.message)) {
        return reply.code(409).send({
          error: err.message,
          hint: 'Pass ?force=true or {"force": true} to delete the active deployment anyway.',
        });
      }
      throw err;
    }
    return reply.code(204).send();
  });

  // ---- git auto-deploy (v0.6) -------------------------------------------------

  app.patch('/api/apps/:id/git', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid application id' });
    const row = await apps.byId(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    const body = req.body as { branch?: string; autoDeploy?: boolean };
    const opts: { branch?: string; autoDeploy?: boolean } = {};
    if (body.branch !== undefined) {
      if (!/^[\w.\-/]+$/.test(body.branch)) return reply.code(400).send({ error: 'Invalid branch name' });
      opts.branch = body.branch;
    }
    if (body.autoDeploy !== undefined) opts.autoDeploy = body.autoDeploy === true;
    await apps.setGitConfig(id, opts);
    const updated = await apps.byId(id);
    return { branch: updated!.git_branch, autoDeploy: updated!.auto_deploy };
  });

  // ---- volumes & services (v0.5) --------------------------------------------

  app.get('/api/apps/:id/volumes', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid application id' });
    const row = await apps.byId(id);
    if (!row) return reply.code(404).send({ error: 'Application not found' });
    const vols = await volumes.listByApplication(id);
    return {
      applicationId: id,
      volumes: vols.map((v) => ({
        name: v.volume_name,
        dockerVolume: v.docker_volume,
        createdAt: v.created_at,
      })),
      note: 'Volumes persist across deployments and rollbacks. Deleting the application does NOT delete volumes unless ?volumes=true.',
    };
  });

  app.delete('/api/apps/:id/volumes', async (req, reply) => {
    // Destructive: requires explicit confirmation via ?confirm=true.
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid application id' });
    if ((req.query as { confirm?: string }).confirm !== 'true') {
      return reply.code(409).send({
        error: 'Volume deletion is destructive and irreversible. Repeat with ?confirm=true.',
      });
    }
    const removed = await engine.removeApplicationVolumes(id);
    req.log.warn({ appId: id, removed }, 'application volumes DELETED');
    return reply.code(200).send({ removed });
  });

  app.get('/api/deployments/:id/services', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: 'Invalid deployment id' });
    const row = await deployments.byId(id);
    if (!row) return reply.code(404).send({ error: 'Deployment not found' });
    if (!row.manifest_snapshot) {
      return reply.code(409).send({ error: 'This deployment is single-service (no manifest)' });
    }
    return { deploymentId: id, services: await servicesFor(id) };
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

  // Crash monitor + automatic-recovery ticks. All logic lives in the engine
  // so the same code path serves live monitoring and startup reconciliation.
  const monitorInterval = Number(process.env.CRASH_MONITOR_INTERVAL_MS ?? 5000);
  const monitor = setInterval(() => {
    void engine.checkCrashes().catch((err) => {
      app.log.error({ err }, 'crash monitor error');
    });
  }, monitorInterval);
  monitor.unref();

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
