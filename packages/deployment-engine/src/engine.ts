// MiniCloud deployment engine: the pipeline that turns a git repository into
// a running, health-checked container.
//
// Pipeline: QUEUED -> CLONING -> BUILDING -> STARTING -> HEALTH_CHECKING -> RUNNING
// Any stage failure -> FAILED (with failure reason). User stop -> STOPPED.
//
// Concurrency: one in-flight operation per deployment, enforced with an
// in-process lock map. The DB status guard (transitionStatus) is the second
// line of defense against duplicate operations.
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type DeploymentStatus,
  assertTransition,
  MINICLOUD_LABELS,
} from '@minicloud/shared';
import {
  Database,
  DeploymentRepository,
  AppRepository,
  AppConfigRepository,
  type DeploymentRow,
} from '@minicloud/db';
import { buildConfigSnapshot, type ResourceLimits } from '@minicloud/shared';
import { DockerRuntime, DockerUnavailableError, type ContainerResourceLimits } from '@minicloud/docker-runtime';
import { cloneRepository } from './git.js';
import { allocatePort, canBind } from './ports.js';
import { waitForHealthy } from './health.js';

export interface EngineConfig {
  workspaceDir: string;
  portRange: { start: number; end: number };
  defaults: {
    containerPort: number;
    healthPath: string;
    healthTimeoutSeconds: number;
    healthIntervalSeconds: number;
  };
}

export interface EngineLogger {
  info: (msg: string, obj?: Record<string, unknown>) => void;
  warn: (msg: string, obj?: Record<string, unknown>) => void;
  error: (msg: string, obj?: Record<string, unknown>) => void;
}

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly stage: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

/** Emitted for every log line produced by a deployment (for SSE fan-out). */
export type LogListener = (
  deploymentId: string,
  entry: { source: 'build' | 'container' | 'system'; stream: 'stdout' | 'stderr'; message: string },
) => void;

/** Effective per-application runtime configuration, resolved at container start. */
export interface ResolvedAppConfig {
  /**
   * Plain vars plus DECRYPTED secret values. This map goes straight into the
   * container; the engine never logs it and persists only the non-secret part.
   */
  env: Record<string, string>;
  /** Secret KEY names only — never values. Used for the config snapshot. */
  secretKeys: string[];
  limits: ResourceLimits | null;
}

export type AppConfigResolver = (applicationId: string) => Promise<ResolvedAppConfig>;

const MAX_LOCK_MAP_SIZE = 500;

export class DeploymentEngine {
  private readonly deployments: DeploymentRepository;
  private readonly apps: AppRepository;
  /** Per-deployment mutexes so stop/restart/deploy cannot interleave. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** AbortControllers for in-flight pipelines; used when stopping during startup. */
  private readonly activeRuns = new Map<string, AbortController>();
  constructor(
    private readonly db: Database,
    private readonly docker: DockerRuntime,
    private readonly config: EngineConfig,
    private readonly logger: EngineLogger,
    private readonly onLog?: LogListener,
  ) {
    this.deployments = new DeploymentRepository(db);
    this.apps = new AppRepository(db);
    this.appConfig = new AppConfigRepository(db);
    void mkdir(config.workspaceDir, { recursive: true });
  }

  private readonly appConfig: AppConfigRepository;

  /**
   * Resolves the effective runtime configuration (env, secrets, limits) for an
   * application at container start. Registered by the API layer because it owns
   * the master key; the engine itself never sees ciphertext or keys.
   */
  private appConfigResolver: AppConfigResolver | null = null;

  setAppConfigResolver(resolver: AppConfigResolver): void {
    this.appConfigResolver = resolver;
  }

  /** Resolve config, mapping any resolver failure to EngineError(stage='config'). */
  private async resolvedConfig(applicationId: string): Promise<ResolvedAppConfig> {
    if (!this.appConfigResolver) return { env: {}, secretKeys: [], limits: null };
    try {
      return await this.appConfigResolver(applicationId);
    } catch (err) {
      throw new EngineError(err instanceof Error ? err.message : String(err), 'config');
    }
  }

  /** Non-secret snapshot for a resolved config: plain values + secret key names. */
  private snapshotFor(cfg: ResolvedAppConfig): Record<string, unknown> {
    return buildConfigSnapshot(
      Object.fromEntries(Object.entries(cfg.env).filter(([k]) => !cfg.secretKeys.includes(k))),
      cfg.secretKeys,
      cfg.limits,
    ) as unknown as Record<string, unknown>;
  }

  /** MB→bytes and CPUs→nano-CPUs; the only place Docker limit units are computed.
   *  Null-checked rather than truthiness: a literal 0 must fail loudly upstream
   *  (validation), never silently disappear here. */
  private dockerLimits(limits: ResourceLimits | null): ContainerResourceLimits {
    const out: ContainerResourceLimits = {};
    if (limits?.memoryLimitMb != null) out.memoryBytes = limits.memoryLimitMb * 1024 * 1024;
    if (limits?.cpuLimit != null) out.cpus = limits.cpuLimit;
    return out;
  }

  get workspaceDir(): string {
    return this.config.workspaceDir;
  }

  /** Serialize operations per deployment id. */
  private withLock<T>(deploymentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(deploymentId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(
      deploymentId,
      next.catch(() => {}),
    );
    // Opportunistic cleanup to avoid unbounded map growth.
    if (this.locks.size > MAX_LOCK_MAP_SIZE) {
      for (const [k, p] of this.locks) {
        if (p === prev) this.locks.delete(k);
      }
    }
    return next;
  }

  emitLog(
    deploymentId: string,
    entry: { source: 'build' | 'container' | 'system'; stream: 'stdout' | 'stderr'; message: string },
  ): void {
    try {
      this.onLog?.(deploymentId, entry);
    } catch {
      /* listener errors must never break the pipeline */
    }
  }

  /**
   * Run the full deployment pipeline asynchronously. Resolves once the
   * deployment reaches a terminal or RUNNING state; callers typically do not
   * await it — progress is observable via the database / API.
   */
  async runDeployment(deploymentId: string): Promise<void> {
    return this.withLock(deploymentId, () => this.pipeline(deploymentId));
  }

  private async pipeline(deploymentId: string): Promise<void> {
    const abort = new AbortController();
    this.activeRuns.set(deploymentId, abort);
    let repoDir: string | null = null;

    const current = await this.deployments.byId(deploymentId);
    if (!current) throw new EngineError(`Deployment ${deploymentId} not found`, 'pipeline');
    const app = await this.apps.byId(current.application_id);
    if (!app) throw new EngineError(`Application ${current.application_id} not found`, 'pipeline');

    const deploymentTag = `minicloud/app-${app.id.slice(0, 8)}:d-${deploymentId.slice(0, 12)}`;
    const containerName = `minicloud-d-${deploymentId.slice(0, 12)}`;

    const fail = async (stage: string, message: string): Promise<void> => {
      await this.transition(deploymentId, null, 'FAILED', {
        failure_reason: `${stage}: ${truncate(message, 1000)}`,
      });
      this.logger.error('deployment failed', { deploymentId, app: app.name, stage, error: truncate(message, 300) });
    };

    const transitionOrDie = async (
      row: DeploymentRow | null,
      to: DeploymentStatus,
    ): Promise<boolean> => {
      if (!row) return false;
      try {
        assertTransition(row.status as DeploymentStatus, to);
      } catch {
        return false;
      }
      return true;
    };

    try {
      await this.docker.ping();
    } catch (err) {
      if (err instanceof DockerUnavailableError) {
        await fail('docker', err.message);
        return;
      }
      throw err;
    }

    // ---- CLONING -----------------------------------------------------------
    let row = await this.deployments.byId(deploymentId);
    if (!row || !(await transitionOrDie(row, 'CLONING'))) return;
    row = (await this.deployments.transitionStatus(deploymentId, ['QUEUED'], 'CLONING'))!;
    this.logger.info('clone started', { deploymentId, app: app.name });

    let commitSha: string;
    try {
      const cloned = await cloneRepository(app.repository_url, this.config.workspaceDir, row.ref ?? undefined, (m) =>
        this.emitLog(deploymentId, { source: 'system', stream: 'stdout', message: m }),
      );
      repoDir = cloned.dir;
      commitSha = cloned.commitSha;
    } catch (err) {
      await fail('clone', err instanceof Error ? err.message : String(err));
      return;
    }
    await this.deployments.updateFields(deploymentId, { commit_sha: commitSha });
    this.logger.info('clone completed', { deploymentId, commitSha });

    // ---- BUILDING ----------------------------------------------------------
    if (!(await transitionOrDie(await this.deployments.byId(deploymentId), 'BUILDING'))) {
      await repoCleanup(repoDir);
      return;
    }
    await this.deployments.transitionStatus(deploymentId, ['CLONING'], 'BUILDING');
    this.logger.info('build started', { deploymentId, tag: deploymentTag });

    const dockerfileCandidates = ['Dockerfile', 'dockerfile'];
    const hasDockerfile = dockerfileCandidates.some((f) => existsSync(path.join(repoDir!, f)));
    if (!hasDockerfile) {
      const entries = await readdir(repoDir!).catch(() => [] as string[]);
      await fail(
        'dockerfile',
        `No Dockerfile found at repository root. MiniCloud v0.1 requires a Dockerfile. Repository root contains: ${
          entries.slice(0, 15).join(', ') || '(empty)'
        }`,
      );
      await repoCleanup(repoDir);
      return;
    }

    try {
      await this.docker.build({
        contextDir: repoDir!,
        tag: deploymentTag,
        onOutput: (chunk) => {
          for (const line of chunk.split(/\r?\n/)) {
            if (line.trim()) this.emitLog(deploymentId, { source: 'build', stream: 'stdout', message: line });
          }
        },
      });
    } catch (err) {
      await fail('build', err instanceof Error ? err.message : String(err));
      await repoCleanup(repoDir);
      return;
    }
    this.logger.info('build completed', { deploymentId, tag: deploymentTag });

    // ---- STARTING ----------------------------------------------------------
    if (!(await transitionOrDie(await this.deployments.byId(deploymentId), 'STARTING'))) {
      await repoCleanup(repoDir);
      return;
    }
    await this.deployments.transitionStatus(deploymentId, ['BUILDING'], 'STARTING');
    this.logger.info('starting container', { deploymentId });

    const containerPort = row.container_port ?? this.config.defaults.containerPort;
    let hostPort: number;
    try {
      hostPort = await allocatePort(this.config.portRange);
      // Re-verify our chosen port right before binding to shrink the race window.
      if (!(await canBind(hostPort))) throw new EngineError('port became unavailable', 'port');
    } catch (err) {
      await fail('port', `Port allocation failed: ${err instanceof Error ? err.message : String(err)}`);
      await repoCleanup(repoDir);
      return;
    }

    const healthPath = row.health_path ?? this.config.defaults.healthPath;

    // Resolve effective app configuration (env vars, secrets, resource limits)
    // at container start. Secret VALUES live only in runtimeEnv — they go
    // straight into the container and are never logged or persisted; the
    // snapshot records plain values and secret KEY NAMES only.
    let cfg: ResolvedAppConfig;
    try {
      cfg = await this.resolvedConfig(app.id);
    } catch (err) {
      await fail('config', err instanceof Error ? err.message : String(err));
      await repoCleanup(repoDir);
      return;
    }
    this.logger.info('app config resolved', {
      deploymentId,
      varCount: Object.keys(cfg.env).length - cfg.secretKeys.length,
      secretCount: cfg.secretKeys.length,
      memoryLimitMb: cfg.limits?.memoryLimitMb ?? null,
      cpuLimit: cfg.limits?.cpuLimit ?? null,
    });
    await this.deployments.updateFields(deploymentId, {
      config_snapshot: this.snapshotFor(cfg),
    });

    let containerId: string;
    try {
      const started = await this.docker.startManagedContainer({
        image: deploymentTag,
        name: containerName,
        appLabel: app.id,
        deploymentLabel: deploymentId,
        containerPort,
        hostPort,
        env: cfg.env,
        limits: this.dockerLimits(cfg.limits),
      });
      containerId = started.id;
    } catch (err) {
      await fail('start', err instanceof Error ? err.message : String(err));
      await repoCleanup(repoDir);
      return;
    }

    await this.deployments.updateFields(deploymentId, {
      image_tag: deploymentTag,
      container_id: containerId,
      container_name: containerName,
      host_port: hostPort,
      container_port: containerPort,
      health_path: healthPath,
    });
    this.logger.info('container started', { deploymentId, containerId: short(containerId), hostPort });

    // ---- HEALTH_CHECKING ---------------------------------------------------
    if (!(await transitionOrDie(await this.deployments.byId(deploymentId), 'HEALTH_CHECKING'))) {
      await repoCleanup(repoDir);
      return;
    }
    await this.deployments.transitionStatus(deploymentId, ['STARTING'], 'HEALTH_CHECKING');

    const health = await waitForHealthy({
      hostPort,
      path: healthPath,
      timeoutSeconds: this.config.defaults.healthTimeoutSeconds,
      intervalSeconds: this.config.defaults.healthIntervalSeconds,
      signal: abort.signal,
      onAttempt: (attempt, error) => {
        if (attempt % 5 === 1) {
          this.emitLog(deploymentId, { source: 'system', stream: 'stderr', message: `health check attempt ${attempt}: ${error}` });
        }
      },
    });

    await repoCleanup(repoDir);

    if (!health.ok) {
      const logsTail = await this.docker.recentLogs(containerId, 200).catch(() => '');
      if (logsTail) {
        for (const line of logsTail.split(/\r?\n/).slice(-50)) {
          if (line.trim()) this.emitLog(deploymentId, { source: 'container', stream: 'stdout', message: line });
        }
      }
      await this.docker.stop(containerId).catch(() => {});
      await this.docker.remove(containerId, true).catch(() => {});
      await this.deployments.updateFields(deploymentId, { container_id: null, container_name: null });
      await this.failWithExitCode(deploymentId, `Health check failed after ${this.config.defaults.healthTimeoutSeconds}s: ${health.lastError}`);
      return;
    }

    // ---- RUNNING -----------------------------------------------------------
    const runningRow = await this.deployments.byId(deploymentId);
    if (!runningRow || !(await transitionOrDie(runningRow, 'RUNNING'))) return;
    await this.deployments.transitionStatus(
      deploymentId,
      ['HEALTH_CHECKING'],
      'RUNNING',
      undefined,
      { startedAt: new Date() },
    );
    this.activeRuns.delete(deploymentId);
    this.logger.info('deployment running', { deploymentId, app: app.name, hostPort, commitSha });
  }

  async failWithExitCode(deploymentId: string, reason: string): Promise<void> {
    const row = await this.deployments.byId(deploymentId);
    let exitCode: number | null = null;
    if (row?.container_id) {
      exitCode = (await this.docker.getContainerState(row.container_id))?.exitCode ?? null;
    }
    await this.deployments.transitionStatus(deploymentId, ['HEALTH_CHECKING'], 'FAILED', {
      failure_reason: reason,
      exit_code: exitCode,
    }, { stoppedAt: new Date() });
    this.logger.warn('deployment failed', { deploymentId, reason });
  }

  /** Stop a deployment's container and mark STOPPED. Idempotent. */
  async stopDeployment(deploymentId: string): Promise<DeploymentRow> {
    return this.withLock(deploymentId, async () => {
      let row = await this.deployments.byId(deploymentId);
      if (!row) throw new EngineError('Deployment not found', 'stop');

      // Cancel an in-flight pipeline (queued/cloning/building/... states).
      this.activeRuns.get(deploymentId)?.abort();

      const allowed: DeploymentStatus[] = [
        'QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTH_CHECKING', 'RUNNING',
      ];
      const updated = await this.deployments.transitionStatus(
        deploymentId,
        allowed as string[],
        'STOPPED',
        undefined,
        { stoppedAt: new Date() },
      );
      if (!updated) {
        row = await this.deployments.byId(deploymentId);
        if (row && (row.status === 'STOPPED' || row.status === 'FAILED')) return row;
        throw new EngineError(`Cannot stop deployment in state ${row!.status}`, 'stop');
      }
      row = updated;

      if (row.container_id) {
        await this.docker.stop(row.container_id).catch((err) => {
          this.logger.warn('container stop error (ignored)', { deploymentId, error: String(err) });
        });
        await this.docker.remove(row.container_id, true).catch(() => {});
        await this.deployments.updateFields(deploymentId, { container_id: null, container_name: null });
      }
      this.activeRuns.delete(deploymentId);
      this.logger.info('deployment stopped', { deploymentId });
      return row;
    });
  }

  /**
   * Restart a RUNNING/FAILED/STOPPED deployment by re-running its container.
   * For FAILED deployments whose build succeeded we reuse the existing image.
   * Returns the updated row.
   */
  async restartDeployment(deploymentId: string): Promise<DeploymentRow> {
    return this.withLock(deploymentId, async () => {
      const row = await this.deployments.byId(deploymentId);
      if (!row) throw new EngineError('Deployment not found', 'restart');
      if (!row.image_tag) {
        throw new EngineError('Deployment has no built image; redeploy instead of restarting', 'restart');
      }
      if (!['RUNNING', 'FAILED', 'STOPPED'].includes(row.status)) {
        throw new EngineError(`Cannot restart deployment in state ${row.status}`, 'restart');
      }
      const app = await this.apps.byId(row.application_id);
      if (!app) throw new EngineError('Application not found', 'restart');

      // Resolve CURRENT application configuration BEFORE tearing anything
      // down: a config failure (e.g. missing MINICLOUD_MASTER_KEY for secret
      // decryption) must leave the existing container untouched.
      const cfg = await this.resolvedConfig(app.id);

      // Tear down any previous container.
      if (row.container_id) {
        await this.docker.stop(row.container_id).catch(() => {});
        await this.docker.remove(row.container_id, true).catch(() => {});
      }

      const hostPort = await allocatePort(this.config.portRange);
      const containerName = `minicloud-d-${randomUUID().slice(0, 12)}`;

      const started = await this.docker.startManagedContainer({
        image: row.image_tag,
        name: containerName,
        appLabel: app.id,
        deploymentLabel: deploymentId,
        containerPort: row.container_port ?? this.config.defaults.containerPort,
        hostPort,
        env: cfg.env,
        limits: this.dockerLimits(cfg.limits),
      });
      await this.deployments.updateFields(deploymentId, {
        container_id: started.id,
        container_name: containerName,
        host_port: hostPort,
        restart_count: row.restart_count + 1,
        failure_reason: null,
        exit_code: null,
        stopped_at: null,
        // Refresh so the snapshot always describes what this deployment's
        // container was last started with (restart applies current config).
        config_snapshot: this.snapshotFor(cfg),
      });

      const healthPath = row.health_path ?? this.config.defaults.healthPath;
      await this.deployments.transitionStatus(deploymentId, ['RUNNING', 'FAILED', 'STOPPED'], 'HEALTH_CHECKING');
      const health = await waitForHealthy({
        hostPort,
        path: healthPath,
        timeoutSeconds: this.config.defaults.healthTimeoutSeconds,
        intervalSeconds: this.config.defaults.healthIntervalSeconds,
      });
      if (!health.ok) {
        await this.docker.stop(started.id).catch(() => {});
        await this.docker.remove(started.id, true).catch(() => {});
        await this.deployments.updateFields(deploymentId, { container_id: null, container_name: null });
        await this.deployments.transitionStatus(deploymentId, ['HEALTH_CHECKING'], 'FAILED', {
          failure_reason: `Restart health check failed: ${health.lastError}`,
        }, { stoppedAt: new Date() });
        throw new EngineError(`Restart failed health check: ${health.lastError}`, 'restart');
      }
      const finalRow = await this.deployments.transitionStatus(
        deploymentId, ['HEALTH_CHECKING'], 'RUNNING', undefined, { startedAt: new Date() },
      );
      this.logger.info('deployment restarted', { deploymentId, hostPort });
      return finalRow ?? (await this.deployments.byId(deploymentId))!;
    });
  }

  /** Delete a deployment: remove container, keep history row? No — remove row entirely. */
  async deleteDeployment(deploymentId: string): Promise<void> {
    return this.withLock(deploymentId, async () => {
      const row = await this.deployments.byId(deploymentId);
      if (!row) return;
      this.activeRuns.get(deploymentId)?.abort();
      if (row.container_id) {
        await this.docker.stop(row.container_id).catch(() => {});
        await this.docker.remove(row.container_id, true).catch(() => {});
      }
      // Images are left in place: they are content-addressed by deployment id
      // and pruned manually if disk space matters.
      await this.db.query('DELETE FROM deployments WHERE id = $1', [deploymentId]);
      this.logger.info('deployment deleted', { deploymentId });
    });
  }

  /**
   * Startup reconciliation: make the database agree with reality in Docker.
   *
   * Strategy:
   *  1. List all containers labeled minicloud.managed=true.
   *  2. For every DB row in a non-terminal state whose container is missing or
   *     exited: mark FAILED (with exit code / reason).
   *  3. For DB rows marked RUNNING whose container exited: mark FAILED with the
   *     captured exit code (crash detection at startup counts too).
   *  4. For containers that exist but have no DB row: remove them (orphans from
   *     a crashed previous run).
   *  5. Rows in terminal states with leftover containers: clean the container up.
   *
   * We deliberately never trust DB RUNNING without verifying the container.
   */
  async reconcile(): Promise<{ fixed: number; orphansRemoved: number }> {
    let fixed = 0;
    let orphansRemoved = 0;
    let containers: Awaited<ReturnType<DockerRuntime['listManagedContainers']>> = [];
    try {
      containers = await this.docker.listManagedContainers();
    } catch (err) {
      if (err instanceof DockerUnavailableError) {
        this.logger.error('reconciliation skipped: docker unavailable', {});
        return { fixed: 0, orphansRemoved: 0 };
      }
      throw err;
    }
    const byDeploymentLabel = new Map<string, (typeof containers)[number]>();
    for (const c of containers) {
      const depId = c.labels[MINICLOUD_LABELS.deployment];
      if (depId) byDeploymentLabel.set(depId, c);
    }

    const rows = await this.db.query<DeploymentRow>(
      "SELECT * FROM deployments WHERE status NOT IN ('FAILED','STOPPED') OR container_id IS NOT NULL",
    );
    for (const row of rows.rows) {
      const container = row.container_id
        ? containers.find((c) => c.id === row.container_id) ??
          byDeploymentLabel.get(row.id)
        : byDeploymentLabel.get(row.id);

      if (['FAILED', 'STOPPED'].includes(row.status)) {
        if (container) {
          await this.docker.remove(container.id, true).catch(() => {});
          fixed++;
        }
        continue;
      }
      // Non-terminal DB state: verify the container actually runs.
      if (!container || container.state !== 'running') {
        const exitCode =
          (row.container_id &&
            (await this.docker.getContainerState(row.container_id))?.exitCode) ??
          container?.exitCode ??
          null;
        await this.deployments.transitionStatus(row.id, [row.status], 'FAILED', {
          failure_reason: `Reconciled at startup: container ${container ? 'exited' : 'missing'}${exitCode !== null ? ` (exit code ${exitCode})` : ''}`,
          exit_code: exitCode,
        }, { stoppedAt: new Date() });
        if (container) await this.docker.remove(container.id, true).catch(() => {});
        fixed++;
        this.logger.warn('reconciliation: marked failed', { deploymentId: row.id, was: row.status });
        continue;
      }
      // Container claims to run but DB says non-terminal pre-running state
      // (e.g. API died mid-health-check). Trust the healthy container.
      if (row.status !== 'RUNNING') {
        await this.deployments.transitionStatus(row.id, [row.status], 'RUNNING', undefined, {
          startedAt: row.started_at ? new Date(row.started_at) : new Date(),
        });
        fixed++;
        this.logger.info('reconciliation: restored RUNNING', { deploymentId: row.id });
      }
    }

    // Orphaned managed containers without a DB row: remove them.
    const knownIds = new Set(rows.rows.map((r) => r.id));
    for (const c of containers) {
      const depId = c.labels[MINICLOUD_LABELS.deployment] ?? '';
      if (!knownIds.has(depId)) {
        await this.docker.remove(c.id, true).catch(() => {});
        orphansRemoved++;
        this.logger.warn('reconciliation: removed orphan container', { container: short(c.id) });
      }
    }

    this.logger.info('reconciliation complete', { fixed, orphansRemoved });
    return { fixed, orphansRemoved };
  }

  private async transition(
    deploymentId: string,
    _from: DeploymentStatus | null,
    to: DeploymentStatus,
    extra?: { failure_reason?: string },
  ): Promise<void> {
    const row = await this.deployments.byId(deploymentId);
    if (!row) return;
    await this.deployments.transitionStatus(
      deploymentId,
      [row.status],
      to,
      extra ? { failure_reason: extra.failure_reason } : undefined,
      to === 'FAILED' ? { stoppedAt: new Date() } : undefined,
    );
    this.activeRuns.delete(deploymentId);
  }
}

export function defaultEngineConfigFromEnv(): EngineConfig {
  return {
    workspaceDir: process.env.WORKSPACE_DIR ?? path.resolve('.minicloud/workspace'),
    portRange: {
      start: Number(process.env.PORT_RANGE_START ?? 31000),
      end: Number(process.env.PORT_RANGE_END ?? 31999),
    },
    defaults: {
      containerPort: Number(process.env.CONTAINER_PORT_DEFAULT ?? 3000),
      healthPath: process.env.HEALTH_PATH_DEFAULT ?? '/health',
      healthTimeoutSeconds: Number(process.env.HEALTH_TIMEOUT_SECONDS ?? 60),
      healthIntervalSeconds: Number(process.env.HEALTH_INTERVAL_SECONDS ?? 2),
    },
  };
}

async function repoCleanup(dir: string | null): Promise<void> {
  if (!dir) return;
  await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
}

function short(id: string): string {
  return id.slice(0, 12);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
}
