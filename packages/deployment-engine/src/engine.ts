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
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
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
  DeploymentEventRepository,
  DeploymentServiceRepository,
  ApplicationVolumeRepository,
  BuildArtifactRepository,
  PreviewRepository,
  type ApplicationRow,
  type DeploymentRow,
  type DeploymentServiceRow,
} from '@minicloud/db';
import {
  buildConfigSnapshot,
  loadManifest,
  parseManifestSnapshot,
  type Manifest,
  type ParsedManifest,
  type ResourceLimits,
} from '@minicloud/shared';
import { DockerRuntime, DockerUnavailableError, type ContainerResourceLimits } from '@minicloud/docker-runtime';
import { cloneRepository } from './git.js';
import { allocatePort, canBind } from './ports.js';
import { waitForHealthy } from './health.js';
import { fingerprintBuildInputs } from './cache.js';

export interface EngineConfig {
  workspaceDir: string;
  portRange: { start: number; end: number };
  defaults: {
    containerPort: number;
    healthPath: string;
    healthTimeoutSeconds: number;
    healthIntervalSeconds: number;
  };
  /** Port the MiniCloud gateway listens on; 0/undefined disables routing. */
  gatewayPort?: number;
  /** Max seconds to wait for in-flight requests before retiring the old
   *  container after a cutover. */
  drainTimeoutSeconds?: number;
  /** Hard ceiling for a single image build; protects queue slots from a
   *  hung docker build. Default 900s. */
  buildTimeoutSeconds?: number;
}

/**
 * The routing surface the engine drives during cutover. Implemented by the
 * API-owned gateway; the engine never opens proxy ports itself.
 */
export interface TrafficGateway {
  setRoute(slug: string, upstream: { deploymentId: string; host: string; port: number } | null): void;
  activeRequests(slug: string): number;
  verifyRoute(slug: string, path: string): Promise<boolean>;
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

export type AppConfigResolver = (
  applicationId: string,
  opts: { previewEnvironmentId?: string | null },
) => Promise<ResolvedAppConfig>;

/** Canonical deployment event types (persisted to deployment_events). */
export const DEPLOYMENT_EVENTS = {
  created: 'deployment.created',
  cloneStarted: 'clone.started',
  cloneCompleted: 'clone.completed',
  buildStarted: 'build.started',
  buildCompleted: 'build.completed',
  buildSkipped: 'build.skipped',
  containerStarting: 'container.starting',
  containerStarted: 'container.started',
  healthCheckStarted: 'health_check.started',
  healthCheckPassed: 'health_check.passed',
  running: 'deployment.running',
  restartRequested: 'restart.requested',
  restartAttempt: 'restart.attempt',
  restartSucceeded: 'restart.succeeded',
  restartFailed: 'restart.failed',
  autoRestartScheduled: 'restart.auto_scheduled',
  autoRestartAttempt: 'restart.auto_attempt',
  autoRestartSucceeded: 'restart.auto_succeeded',
  autoRestartFailed: 'restart.auto_failed',
  containerCrashed: 'container.crashed',
  rollbackRequested: 'rollback.requested',
  rollbackCompleted: 'rollback.completed',
  stopRequested: 'stop.requested',
  stopped: 'deployment.stopped',
  failed: 'deployment.failed',
  deleted: 'deployment.deleted',
} as const;

/** Routing / traffic events (v0.4). */
export const TRAFFIC_EVENTS = {
  cutoverStarted: 'traffic.cutover_started',
  cutoverCompleted: 'traffic.cutover_completed',
  cutoverFailed: 'traffic.cutover_failed',
  drainStarted: 'traffic.drain_started',
  drainCompleted: 'traffic.drain_completed',
  routeUpdated: 'gateway.route_updated',
  upstreamUnavailable: 'gateway.upstream_unavailable',
  superseded: 'deployment.superseded',
} as const;

/** Multi-service events (v0.5) — metadata carries serviceName, never secrets. */
export const SERVICE_EVENTS = {
  buildStarted: 'service.build_started',
  buildCompleted: 'service.build_completed',
  starting: 'service.starting',
  started: 'service.started',
  healthPassed: 'service.health_passed',
  healthFailed: 'service.health_failed',
  crashed: 'service.crashed',
  restartScheduled: 'service.restart_scheduled',
  recovered: 'service.recovered',
  networkCreated: 'network.created',
  volumeAttached: 'volume.attached',
} as const;

/** Queue lifecycle events (v0.7) — persisted alongside pipeline events. */
export const QUEUE_EVENTS = {
  claimed: 'queue.claimed',
  superseded: 'queue.superseded',
  cancelled: 'deployment.cancelled',
  cancelRequested: 'cancellation.requested',
} as const;

/** Build-cache observability events (v0.7). Metadata carries tags/fingerprints, never secret values. */
export const CACHE_EVENTS = {
  cacheMiss: 'build.cache_miss',
  imageReused: 'build.image_reused',
} as const;

/** Automatic-restart backoff: attempt N (1-based) waits min(2^N * 2s, 15s). */
export function autoRestartDelayMs(attempt: number): number {
  return Math.min(2 ** attempt * 2000, 15_000);
}

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
    config: EngineConfig,
    private readonly logger: EngineLogger,
    private readonly onLog?: LogListener,
  ) {
    this.deployments = new DeploymentRepository(db);
    this.apps = new AppRepository(db);
    this.appConfig = new AppConfigRepository(db);
    this.events = new DeploymentEventRepository(db);
    this.services = new DeploymentServiceRepository(db);
    this.previews = new PreviewRepository(db);
    this.volumes = new ApplicationVolumeRepository(db);
    this.artifacts = new BuildArtifactRepository(db);
    // A relative WORKSPACE_DIR (the .env default) would otherwise be resolved
    // against git's own cwd inside cloneRepository — normalize once, here.
    this.config = { ...config, workspaceDir: path.resolve(config.workspaceDir) };
    void mkdir(this.config.workspaceDir, { recursive: true });
  }

  private readonly config: EngineConfig;

  private readonly appConfig: AppConfigRepository;
  private readonly events: DeploymentEventRepository;
  private readonly services: DeploymentServiceRepository;
  private readonly volumes: ApplicationVolumeRepository;
  private readonly artifacts: BuildArtifactRepository;
  private readonly previews: PreviewRepository;

  /**
   * Persist a lifecycle event. Event persistence must never break the
   * pipeline: failures are logged and swallowed. Metadata is structural
   * context only — callers must never pass secret values.
   */
  private async event(
    deploymentId: string,
    type: string,
    message = '',
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.append(deploymentId, type, message, metadata);
    } catch (err) {
      this.logger.warn('event persistence failed', { deploymentId, type, error: String(err) });
    }
  }

  /**
   * Resolves the effective runtime configuration (env, secrets, limits) for an
   * application at container start. Registered by the API layer because it owns
   * the master key; the engine itself never sees ciphertext or keys.
   */
  private appConfigResolver: AppConfigResolver | null = null;

  setAppConfigResolver(resolver: AppConfigResolver): void {
    this.appConfigResolver = resolver;
  }

  /** Registered by the API layer when the gateway is enabled. */
  private gateway: TrafficGateway | null = null;

  setGateway(gateway: TrafficGateway): void {
    this.gateway = gateway;
  }

  /** Serialize traffic-affecting operations per application. */
  private readonly appLocks = new Map<string, Promise<unknown>>();

  private withAppLock<T>(applicationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.appLocks.get(applicationId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.appLocks.set(applicationId, next.catch(() => {}));
    return next;
  }

  private upstreamFor(deploymentId: string, hostPort: number): { deploymentId: string; host: string; port: number } | null {
    if (!this.gateway || !hostPort) return null;
    return { deploymentId, host: '127.0.0.1', port: hostPort };
  }

  // ---- traffic cutover (v0.4) --------------------------------------------------

  /**
   * Make a freshly-healthy deployment the application's active deployment.
   * Runs under the application lock so concurrent deploys/rollbacks serialize.
   * expectedOld is the active deployment observed when this pipeline started;
   * if traffic has moved elsewhere in the meantime, this deployment was
   * superseded and retires itself instead of stealing traffic.
   */
  private async activateDeployment(
    deploymentId: string,
    appRow: ApplicationRow,
    expectedOld: string | null,
    hostPort: number,
    healthPath: string,
  ): Promise<void> {
    const gw = this.gateway;
    const slug = appRow.route_slug;
    if (!gw || !slug) return;
    await this.withAppLock(appRow.id, async () => {
      const fresh = await this.apps.byId(appRow.id);
      if (!fresh) return;
      const current = fresh.active_deployment_id;
      if (current === deploymentId) return; // already active
      if (current !== expectedOld) {
        // A newer deployment won the race while this one was building.
        await this.event(deploymentId, TRAFFIC_EVENTS.superseded, `traffic moved to ${short(current ?? '?')}`, {
          activeDeploymentId: current,
        });
        await this.retireDeployment(deploymentId, 'superseded by a newer deployment');
        return;
      }

      await this.event(deploymentId, TRAFFIC_EVENTS.cutoverStarted, `${short(current ?? 'none')} → ${short(deploymentId)}`, {
        from: current,
        to: deploymentId,
      });
      const swapped = await this.apps.setActiveDeployment(appRow.id, deploymentId, current);
      if (!swapped) {
        await this.event(deploymentId, TRAFFIC_EVENTS.superseded, 'traffic switched elsewhere during cutover');
        await this.retireDeployment(deploymentId, 'superseded during cutover');
        return;
      }
      gw.setRoute(slug, this.upstreamFor(deploymentId, hostPort));

      const verified = await gw.verifyRoute(slug, healthPath);
      if (!verified) {
        await this.event(deploymentId, TRAFFIC_EVENTS.cutoverFailed, 'gateway verification failed; reverting traffic', {
          from: current,
          to: deploymentId,
        });
        if (current) {
          const old = await this.deployments.byId(current);
          await this.apps.setActiveDeployment(appRow.id, current, deploymentId);
          const oldUpstream = old?.host_port ? this.upstreamFor(current, old.host_port) : null;
          if (oldUpstream) gw.setRoute(slug, oldUpstream);
        } else {
          await this.apps.clearActiveDeployment(appRow.id, deploymentId);
          gw.setRoute(slug, null);
        }
        await this.retireDeployment(deploymentId, 'cutover verification failed; previous version kept serving');
        return;
      }

      await this.event(deploymentId, TRAFFIC_EVENTS.cutoverCompleted, `${slug} now serves ${short(deploymentId)}`, {
        slug,
        from: current,
        to: deploymentId,
      });
      this.logger.info('traffic cutover complete', { deploymentId, slug, from: current });
      if (current) await this.drainAndRetire(current, slug);
    });
  }

  /** Wait for in-flight requests against the retired upstream, then stop it. */
  private async drainAndRetire(deploymentId: string, slug: string): Promise<void> {
    if (!this.gateway) return;
    await this.event(deploymentId, TRAFFIC_EVENTS.drainStarted);
    const budgetMs = (this.config.drainTimeoutSeconds ?? 10) * 1000;
    const start = Date.now();
    while (this.gateway.activeRequests(slug) > 0 && Date.now() - start < budgetMs) {
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.retireDeployment(deploymentId, 'retired after cutover');
    await this.event(deploymentId, TRAFFIC_EVENTS.drainCompleted);
  }

  /** Stop a deployment's container and mark it STOPPED (record preserved). */
  private async retireDeployment(deploymentId: string, reason: string): Promise<void> {
    const row = await this.deployments.byId(deploymentId);
    if (!row) return;
    if (row.container_id) {
      await this.docker.stop(row.container_id).catch(() => {});
      await this.docker.remove(row.container_id, true).catch(() => {});
      await this.deployments.updateFields(deploymentId, { container_id: null, container_name: null });
    }
    await this.deployments.transitionStatus(deploymentId, ['RUNNING', 'FAILED', 'STOPPED', 'HEALTH_CHECKING'], 'STOPPED', undefined, {
      stoppedAt: new Date(),
    });
    this.logger.info('deployment retired', { deploymentId, reason });
  }

  /** Resolve config, mapping any resolver failure to EngineError(stage='config'). */
  private async resolvedConfig(
    applicationId: string,
    opts: { previewEnvironmentId?: string | null } = {},
  ): Promise<ResolvedAppConfig> {
    if (!this.appConfigResolver) return { env: {}, secretKeys: [], limits: null };
    try {
      return await this.appConfigResolver(applicationId, opts);
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
    // The constructor's mkdir is fire-and-forget; a deployment that starts
    // immediately on a fresh workspace must not race it.
    await mkdir(this.config.workspaceDir, { recursive: true });
    const current = await this.deployments.byId(deploymentId);
    if (!current) throw new EngineError(`Deployment ${deploymentId} not found`, 'pipeline');
    const app = await this.apps.byId(current.application_id);
    if (!app) throw new EngineError(`Application ${current.application_id} not found`, 'pipeline');
    // Traffic target when this deployment started building; the cutover is
    // guarded against this value so superseded builds never steal traffic.
    const expectedOld = app.active_deployment_id;
    // Preview context (v0.7): a preview deployment swaps only its own route.
    const previewEnvId = current.preview_environment_id;
    const expectedOldPreview = previewEnvId
      ? (await this.previews.byId(previewEnvId))?.active_preview_deployment_id ?? null
      : null;

    const deploymentTag = `minicloud/app-${app.id.slice(0, 8)}:d-${deploymentId.slice(0, 12)}`;
    const containerName = `minicloud-d-${deploymentId.slice(0, 12)}`;

    const fail = async (stage: string, message: string): Promise<void> => {
      // Cancellation owns the terminal transition once it has landed: a
      // pipeline unwinding from an abort must not overwrite CANCELLED (or any
      // other terminal state an racing operator set) with FAILED.
      const fresh = await this.deployments.byId(deploymentId);
      if (!fresh || !['QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTH_CHECKING'].includes(fresh.status)) {
        return;
      }
      await this.transition(deploymentId, null, 'FAILED', {
        failure_reason: `${stage}: ${truncate(message, 1000)}`,
      });
      await this.event(deploymentId, DEPLOYMENT_EVENTS.failed, `${stage}: ${truncate(message, 300)}`);
      this.logger.error('deployment failed', { deploymentId, app: app.name, stage, error: truncate(message, 300) });
    };

    // Rollback fast path: reuse the target revision's image when it still
    // exists locally; otherwise the pipeline rebuilds from row.ref (which
    // rollbackDeployment set to the target's commit SHA).
    let cachedImageTag: string | null = null;
    const rollbackTarget = current.rollback_of_deployment_id
      ? await this.deployments.byId(current.rollback_of_deployment_id)
      : null;
    let reuseImageTag: string | null = null;
    if (rollbackTarget?.image_tag && (await this.docker.imageExists(rollbackTarget.image_tag))) {
      reuseImageTag = rollbackTarget.image_tag;
    }

    // Multi-service rollback: the manifest comes from the target's snapshot
    // and per-service images are reused when present (no clone/build at all).
    if (rollbackTarget?.manifest_snapshot) {
      const manifest = parseManifestSnapshot(rollbackTarget.manifest_snapshot);
      if (!manifest) {
        await fail('manifest', 'rollback target has an invalid manifest snapshot');
        return;
      }
      await this.pipelineMulti(deploymentId, app, expectedOld, current.commit_sha ?? '', manifest, null, rollbackTarget);
      return;
    }

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
    await this.event(deploymentId, DEPLOYMENT_EVENTS.created, rollbackTarget ? `rollback of ${short(rollbackTarget.id)}` : 'deployment queued', {
      ref: current.ref,
      rollbackOf: current.rollback_of_deployment_id ?? undefined,
      reuseImage: reuseImageTag ?? undefined,
    });

    // ---- CLONING / BUILDING ------------------------------------------------
    let row = await this.deployments.byId(deploymentId);
    if (!row || !(await transitionOrDie(row, 'CLONING'))) return;
    row = await this.deployments.transitionStatus(deploymentId, ['QUEUED'], 'CLONING');
    if (!row) return; // lost a race against cancellation/stop between read and write

    let commitSha: string;
    if (reuseImageTag && rollbackTarget) {
      // Image-reuse rollback: skip clone and build. The head above already
      // walked QUEUED->CLONING; only CLONING->BUILDING remains before the
      // STARTING section takes over, keeping guards and the audit trail
      // uniform.
      await this.event(
        deploymentId,
        DEPLOYMENT_EVENTS.buildSkipped,
        `reusing image from deployment ${short(rollbackTarget.id)}`,
        { image: reuseImageTag, rollbackOf: rollbackTarget.id },
      );
      this.logger.info('rollback reusing image', { deploymentId, image: reuseImageTag });
      row = await this.deployments.transitionStatus(deploymentId, ['CLONING'], 'BUILDING');
      if (!row) return;
      commitSha = rollbackTarget.commit_sha ?? '';
    } else {
      await this.event(deploymentId, DEPLOYMENT_EVENTS.cloneStarted, row.ref ?? 'HEAD');
      this.logger.info('clone started', { deploymentId, app: app.name });
      try {
        const cloned = await cloneRepository(
          app.repository_url,
          this.config.workspaceDir,
          row.ref ?? undefined,
          (m) => this.emitLog(deploymentId, { source: 'system', stream: 'stdout', message: m }),
          abort.signal,
        );
        repoDir = cloned.dir;
        commitSha = cloned.commitSha;
      } catch (err) {
        await fail('clone', err instanceof Error ? err.message : String(err));
        return;
      }
      await this.deployments.updateFields(deploymentId, { commit_sha: commitSha });
      await this.event(deploymentId, DEPLOYMENT_EVENTS.cloneCompleted, commitSha.slice(0, 12), { commitSha });
      this.logger.info('clone completed', { deploymentId, commitSha });

      // minicloud.yml present -> multi-service deployment.
      let parsedManifest: ParsedManifest | null = null;
      try {
        parsedManifest = await loadManifest(repoDir!);
      } catch (err) {
        await fail('manifest', err instanceof Error ? err.message : String(err));
        await repoCleanup(repoDir);
        return;
      }
      if (parsedManifest) {
        await this.deployments.transitionStatus(deploymentId, ['CLONING'], 'BUILDING');
        await this.pipelineMulti(deploymentId, app, expectedOld, commitSha, parsedManifest.manifest, repoDir, rollbackTarget);
        return;
      }

      if (!(await transitionOrDie(await this.deployments.byId(deploymentId), 'BUILDING'))) {
        await repoCleanup(repoDir);
        return;
      }
      await this.deployments.transitionStatus(deploymentId, ['CLONING'], 'BUILDING');
      await this.event(deploymentId, DEPLOYMENT_EVENTS.buildStarted, deploymentTag, { imageTag: deploymentTag });
      this.logger.info('build started', { deploymentId, tag: deploymentTag });

      const dockerfileCandidates = ['Dockerfile', 'dockerfile'];
      const hasDockerfile = dockerfileCandidates.some((f) => existsSync(path.join(repoDir!, f)));
      if (!hasDockerfile) {
        const entries = await readdir(repoDir!).catch(() => [] as string[]);
        await fail(
          'dockerfile',
          `No Dockerfile found at repository root. MiniCloud requires a Dockerfile. Repository root contains: ${
            entries.slice(0, 15).join(', ') || '(empty)'
          }`,
        );
        await repoCleanup(repoDir);
        return;
      }

      // Build-cache identity (v0.7): commit + Dockerfile + context contents.
      // An exact previously-built image for this fingerprint is reused instead
      // of rebuilding; otherwise Docker's layer cache still accelerates the
      // build and the result is recorded for future reuse.
      let imageInUse = deploymentTag;
      const fingerprint = await fingerprintBuildInputs(commitSha, repoDir!, '');
      const artifact = await this.artifacts.find(app.id, fingerprint, null);
      if (artifact && (await this.docker.imageExists(artifact.image_tag))) {
        imageInUse = artifact.image_tag;
        await this.artifacts.markUsed(artifact.id);
        await this.deployments.updateFields(deploymentId, { build_cache: 'image_reused' });
        await this.event(
          deploymentId,
          CACHE_EVENTS.imageReused,
          `exact image reused for commit ${artifact.commit_sha.slice(0, 12) || 'same inputs'}`,
          { fingerprint: fingerprint.slice(0, 16), imageTag: imageInUse, originalCommit: artifact.commit_sha },
        );
        this.logger.info('build skipped: exact image reused', { deploymentId, image: imageInUse });
      } else {
        await this.deployments.updateFields(deploymentId, { build_cache: 'miss' });
        await this.event(deploymentId, CACHE_EVENTS.cacheMiss, 'building from Dockerfile', {
          fingerprint: fingerprint.slice(0, 16),
        });
        try {
          await this.withBuildTimeout(
            this.docker.build({
              contextDir: repoDir!,
              tag: deploymentTag,
              signal: abort.signal,
              onOutput: (chunk) => {
                for (const line of chunk.split(/\r?\n/)) {
                  if (line.trim()) this.emitLog(deploymentId, { source: 'build', stream: 'stdout', message: line });
                }
              },
            }),
            abort,
          );
          await this.artifacts.record({
            applicationId: app.id,
            commitSha,
            serviceName: null,
            fingerprint,
            imageTag: deploymentTag,
          });
        } catch (err) {
          await fail('build', err instanceof Error ? err.message : String(err));
          await repoCleanup(repoDir);
          return;
        }
      }
      await this.event(deploymentId, DEPLOYMENT_EVENTS.buildCompleted, imageInUse, { imageTag: imageInUse });
      this.logger.info('build completed', { deploymentId, tag: imageInUse });
      cachedImageTag = imageInUse;
    }

    // ---- STARTING ----------------------------------------------------------
    if (!(await transitionOrDie(await this.deployments.byId(deploymentId), 'STARTING'))) {
      await repoCleanup(repoDir);
      return;
    }
    await this.deployments.transitionStatus(deploymentId, ['BUILDING'], 'STARTING');
    await this.event(deploymentId, DEPLOYMENT_EVENTS.containerStarting, cachedImageTag ?? reuseImageTag ?? deploymentTag);
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
      cfg = await this.resolvedConfig(app.id, { previewEnvironmentId: previewEnvId });
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
        image: reuseImageTag ?? cachedImageTag ?? deploymentTag,
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

    // Cancellation between port allocation and container creation lands the
    // row in CANCELLED; a container created anyway must not survive it.
    const statusNow = (await this.deployments.byId(deploymentId))?.status;
    if (statusNow === 'CANCELLED' || statusNow === 'STOPPED') {
      await this.docker.stop(containerId).catch(() => {});
      await this.docker.remove(containerId, true).catch(() => {});
      await repoCleanup(repoDir);
      return;
    }
    const effectiveImage = reuseImageTag ?? cachedImageTag ?? deploymentTag;
    await this.deployments.updateFields(deploymentId, {
      image_tag: effectiveImage,
      container_id: containerId,
      container_name: containerName,
      host_port: hostPort,
      container_port: containerPort,
      health_path: healthPath,
    });
    this.logger.info('container started', { deploymentId, containerId: short(containerId), hostPort });
    await this.event(deploymentId, DEPLOYMENT_EVENTS.containerStarted, `port ${hostPort}`, {
      containerId: short(containerId),
      hostPort,
      imageTag: effectiveImage,
    });

    // ---- HEALTH_CHECKING ---------------------------------------------------
    if (!(await transitionOrDie(await this.deployments.byId(deploymentId), 'HEALTH_CHECKING'))) {
      await repoCleanup(repoDir);
      return;
    }
    await this.deployments.transitionStatus(deploymentId, ['STARTING'], 'HEALTH_CHECKING');
    await this.event(deploymentId, DEPLOYMENT_EVENTS.healthCheckStarted, `GET ${healthPath}`, { healthPath });

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
      if ((await this.deployments.byId(deploymentId))?.status === 'CANCELLED') {
        // Cancelled mid-health-check: canceller already cleaned up.
        await repoCleanup(repoDir);
        return;
      }
      // Surface the container's last output for diagnostics, then clean up.
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
    await this.event(deploymentId, DEPLOYMENT_EVENTS.healthCheckPassed, `GET ${healthPath}`, { healthPath });

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
    await this.event(deploymentId, DEPLOYMENT_EVENTS.running, `http://localhost:${hostPort}`, {
      hostPort,
      commitSha,
    });
    this.logger.info('deployment running', { deploymentId, app: app.name, hostPort, commitSha });

    // Zero-downtime cutover: this deployment is healthy; switch traffic only
    // now. expectedOld was captured when the pipeline started, so a deployment
    // that finished after being superseded retires instead of stealing traffic.
    if (previewEnvId) {
      await this.activatePreview(
        deploymentId,
        previewEnvId,
        expectedOldPreview,
        current.gateway_route_key ?? app.route_slug!,
        [{ key: current.gateway_route_key ?? app.route_slug!, service: '', hostPort, healthPath }],
      );
    } else {
      await this.activateDeployment(deploymentId, app, expectedOld, hostPort, healthPath);
    }
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
    await this.event(deploymentId, DEPLOYMENT_EVENTS.failed, truncate(reason, 300));
    this.logger.warn('deployment failed', { deploymentId, reason });
  }

  /**
   * Stop a deployment's container and mark STOPPED. Idempotent.
   * Stopping the ACTIVE deployment takes the application offline; callers must
   * pass {force:true} to acknowledge that explicitly.
   */
  async stopDeployment(deploymentId: string, opts: { force?: boolean } = {}): Promise<DeploymentRow> {
    return this.withLock(deploymentId, async () => {
      let row = await this.deployments.byId(deploymentId);
      if (!row) throw new EngineError('Deployment not found', 'stop');
      const app = await this.apps.byId(row.application_id);
      const isActive = app?.active_deployment_id === deploymentId;
      if (isActive && opts.force !== true) {
        throw new EngineError(
          'This deployment is the ACTIVE deployment for its application. Stopping it makes the application unavailable. Repeat with force to confirm.',
          'stop',
        );
      }

      // Cancel an in-flight pipeline (queued/cloning/building/... states).
      this.activeRuns.get(deploymentId)?.abort();
      await this.event(deploymentId, DEPLOYMENT_EVENTS.stopRequested, isActive ? 'active deployment (forced)' : undefined);
      // A manual stop always cancels any pending automatic restart.
      await this.deployments.updateFields(deploymentId, { next_auto_restart_at: null });
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
      // Multi-service: stop every service container as well.
      for (const svc of await this.services.listByDeployment(deploymentId)) {
        if (svc.container_id) {
          await this.docker.stop(svc.container_id).catch(() => {});
          await this.docker.remove(svc.container_id, true).catch(() => {});
        }
        await this.services.updateFields(svc.id, { status: 'STOPPED', container_id: null, container_name: null });
      }
      this.activeRuns.delete(deploymentId);
      // A forced stop of the active deployment takes the app offline.
      if (isActive && app) {
        await this.apps.clearActiveDeployment(app.id, deploymentId);
        if (this.gateway && app.route_slug) {
          this.gateway.setRoute(app.route_slug, null);
          await this.event(deploymentId, TRAFFIC_EVENTS.upstreamUnavailable, 'active deployment stopped (forced)');
        }
      }
      await this.event(deploymentId, DEPLOYMENT_EVENTS.stopped);
      return row;
    });
  }

  /**
   * Cancel an in-flight (non-RUNNING) deployment: QUEUED/CLONING/BUILDING/
   * STARTING/HEALTH_CHECKING -> CANCELLED, unwinding any pipeline work.
   *
   * Deliberately NOT taking the deployment lock: runDeployment holds that lock
   * for the whole pipeline, so a cancelling caller must not queue behind the
   * very work it is stopping. Safety comes from the guarded SQL transition
   * (only one side wins) plus the abort signal; the unwinding pipeline's fail
   * paths no-op once CANCELLED is on the row.
   *
   * RUNNING is refused: cancelling a live deployment would masquerade as
   * stop/rollback semantics. Callers get a typed error to surface.
   */
  async cancelPipeline(deploymentId: string, reason = 'cancelled by user'): Promise<'cancelled' | 'already_terminal'> {
    const row = await this.deployments.byId(deploymentId);
    if (!row) throw new EngineError('Deployment not found', 'cancel');
    if (['FAILED', 'STOPPED', 'CANCELLED'].includes(row.status)) return 'already_terminal';
    if (row.status === 'RUNNING') {
      throw new EngineError(
        'Deployment is RUNNING and cannot be cancelled. Stop it (or roll back) instead.',
        'cancel',
      );
    }
    await this.event(deploymentId, QUEUE_EVENTS.cancelRequested, truncate(reason, 300));
    const updated = await this.deployments.transitionStatus(
      deploymentId,
      ['QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTH_CHECKING'],
      'CANCELLED',
      { failure_reason: truncate(reason, 1000) },
      { stoppedAt: new Date() },
    );
    if (!updated) return 'already_terminal'; // finished/failed concurrently
    await this.event(deploymentId, QUEUE_EVENTS.cancelled, truncate(reason, 300));

    // Unwind in-flight work: clone/build abort, health-check loop exit.
    this.activeRuns.get(deploymentId)?.abort();
    this.activeRuns.delete(deploymentId);

    // Candidate resources must never outlive a cancellation. The active
    // production deployment is untouched (we only ever held candidate rows).
    if (row.container_id) {
      await this.docker.stop(row.container_id).catch(() => {});
      await this.docker.remove(row.container_id, true).catch(() => {});
      await this.deployments.updateFields(deploymentId, { container_id: null, container_name: null });
    }
    for (const svc of await this.services.listByDeployment(deploymentId)) {
      if (svc.container_id) {
        await this.docker.stop(svc.container_id).catch(() => {});
        await this.docker.remove(svc.container_id, true).catch(() => {});
      }
      await this.services.updateFields(svc.id, { status: 'STOPPED', container_id: null, container_name: null });
    }
    this.logger.info('deployment cancelled', { deploymentId, reason: truncate(reason, 120) });
    return 'cancelled';
  }


  /**
   * Restart a RUNNING/FAILED/STOPPED deployment by re-running its container.
   * For FAILED deployments whose build succeeded we reuse the existing image.
   *
   * Manual restarts reset the automatic-recovery budget (auto_restart_count=0)
   * — a human taking action is treated as fresh supervision. Automatic
   * restarts (from the crash monitor) never reset it and additionally expose
   * MINICLOUD_RESTART_ATTEMPT to the container.
   */
  async restartDeployment(
    deploymentId: string,
    opts: { automatic?: boolean; attempt?: number } = {},
  ): Promise<DeploymentRow> {
    const automatic = opts.automatic === true;
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

      if (!automatic) {
        await this.event(deploymentId, DEPLOYMENT_EVENTS.restartRequested, 'manual restart');
      }

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

      const env = automatic
        ? { ...cfg.env, MINICLOUD_RESTART_ATTEMPT: String(opts.attempt ?? row.auto_restart_count) }
        : cfg.env;
      const started = await this.docker.startManagedContainer({
        image: row.image_tag,
        name: containerName,
        appLabel: app.id,
        deploymentLabel: deploymentId,
        containerPort: row.container_port ?? this.config.defaults.containerPort,
        hostPort,
        env,
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
        // Manual restarts reset the automatic-recovery budget; automatic
        // restarts keep it (the scheduler already incremented it) and clear
        // the pending backoff marker.
        ...(automatic ? {} : { auto_restart_count: 0 }),
        next_auto_restart_at: null,
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
        await this.event(
          deploymentId,
          automatic ? DEPLOYMENT_EVENTS.autoRestartFailed : DEPLOYMENT_EVENTS.restartFailed,
          truncate(`health check failed: ${health.lastError}`, 300),
        );
        await this.event(deploymentId, DEPLOYMENT_EVENTS.failed, truncate(`restart failed: ${health.lastError}`, 300));
        // A terminal restart failure of the ACTIVE deployment takes the app
        // offline: clear the route so the gateway answers 503 instead of
        // silently proxying into a dead upstream.
        if (app.active_deployment_id === deploymentId) {
          await this.apps.clearActiveDeployment(app.id, deploymentId);
          if (this.gateway && app.route_slug) this.gateway.setRoute(app.route_slug, null);
          await this.event(deploymentId, TRAFFIC_EVENTS.upstreamUnavailable, 'active deployment restart failed');
        }
        throw new EngineError(`Restart failed health check: ${health.lastError}`, 'restart');
      }
      const finalRow = await this.deployments.transitionStatus(
        deploymentId, ['HEALTH_CHECKING'], 'RUNNING', undefined, { startedAt: new Date() },
      );
      this.logger.info('deployment restarted', { deploymentId, hostPort, automatic });
      await this.event(
        deploymentId,
        automatic ? DEPLOYMENT_EVENTS.autoRestartSucceeded : DEPLOYMENT_EVENTS.restartSucceeded,
        `port ${hostPort}`,
        { hostPort },
      );
      // A restarted container lands on a NEW ephemeral port: if this is the
      // active deployment, the gateway must follow it.
      if (app.active_deployment_id === deploymentId && this.gateway && app.route_slug) {
        const upstream = this.upstreamFor(deploymentId, hostPort);
        if (upstream) this.gateway.setRoute(app.route_slug, upstream);
        const ok = this.gateway ? await this.gateway.verifyRoute(app.route_slug, healthPath) : false;
        await this.event(
          deploymentId,
          TRAFFIC_EVENTS.routeUpdated,
          ok ? `${app.route_slug} → port ${hostPort}` : `route update unverified for port ${hostPort}`,
          { hostPort, verified: ok },
        );
      }
      // Manual restart of an OFFLINE app (no active pointer, no other RUNNING
      // revision) brings it back online at the stable URL. Automatic recovery
      // and apps that still serve elsewhere never steal traffic here.
      const freshApp = await this.apps.byId(app.id);
      const othersRunning = freshApp?.active_deployment_id
        ? null
        : await this.db.query(
            "SELECT id FROM deployments WHERE application_id = $1 AND status = 'RUNNING' AND id <> $2 LIMIT 1",
            [app.id, deploymentId],
          );
      if (!automatic && freshApp && !freshApp.active_deployment_id && othersRunning && othersRunning.rows.length === 0) {
        const swappedBack = await this.apps.setActiveDeployment(app.id, deploymentId, null);
        if (swappedBack && this.gateway && app.route_slug) {
          const restoredUpstream = this.upstreamFor(deploymentId, hostPort);
          if (restoredUpstream) this.gateway.setRoute(app.route_slug, restoredUpstream);
          const verified = await this.gateway.verifyRoute(app.route_slug, healthPath);
          await this.event(
            deploymentId,
            TRAFFIC_EVENTS.routeUpdated,
            verified ? `${app.route_slug} restored by restart` : 'route restore unverified',
            { hostPort, verified },
          );
        }
      }
      return finalRow ?? (await this.deployments.byId(deploymentId))!;
    });
  }

  /** Delete a deployment: remove container and row (events cascade away).
   *  Deleting the ACTIVE deployment makes the application unavailable; callers
   *  must pass {force:true} to acknowledge that explicitly. */
  async deleteDeployment(deploymentId: string, opts: { force?: boolean } = {}): Promise<void> {
    return this.withLock(deploymentId, async () => {
      const row = await this.deployments.byId(deploymentId);
      if (!row) return;
      const app = await this.apps.byId(row.application_id);
      if (app?.active_deployment_id === deploymentId && opts.force !== true) {
        throw new EngineError(
          'This deployment is the ACTIVE deployment for its application. Deleting it makes the application unavailable. Repeat with force to confirm.',
          'delete',
        );
      }
      this.activeRuns.get(deploymentId)?.abort();
      if (row.container_id) {
        await this.docker.stop(row.container_id).catch(() => {});
        await this.docker.remove(row.container_id, true).catch(() => {});
      }
      if (app?.active_deployment_id === deploymentId) {
        await this.apps.clearActiveDeployment(app.id, deploymentId);
        if (this.gateway && app.route_slug) this.gateway.setRoute(app.route_slug, null);
      }
      await this.event(deploymentId, DEPLOYMENT_EVENTS.deleted);
      await this.db.query('DELETE FROM deployments WHERE id = $1', [deploymentId]);
      this.logger.info('deployment deleted', { deploymentId });
    });
  }


  // ---- multi-service deployments (v0.5) ---------------------------------------

  /** Docker network name for an application (sanitized, no user input beyond the uuid). */
  private appNetworkName(appId: string): string {
    return `minicloud-app-${appId.slice(0, 8)}`;
  }

  /** Docker volume name for an application volume (sanitized). */
  private appVolumeName(appId: string, volumeName: string): string {
    return `minicloud-${appId.slice(0, 8)}-${volumeName}`;
  }

  /**
   * Tear down the application network after app deletion. Volumes are NEVER
   * removed here — persistent data outlives the application unless the caller
   * explicitly opts in via deleteApplicationVolumes.
   */
  async removeAppNetwork(appId: string): Promise<boolean> {
    return this.docker.removeNetwork(this.appNetworkName(appId));
  }

  /** Explicit, destructive: remove all of an application's volumes. */
  async removeApplicationVolumes(appId: string): Promise<number> {
    const rows = await this.volumes.listByApplication(appId);
    let removed = 0;
    for (const v of rows) {
      if (await this.docker.removeVolume(v.docker_volume)) removed++;
    }
    return removed;
  }

  async listApplicationVolumes(appId: string) {
    return this.volumes.listByApplication(appId);
  }

  /**
   * Multi-service deployment pipeline. Preconditions: CLONING/BUILDING state,
   * repository cloned at repoDir (unless pure image-reuse rollback), manifest
   * parsed and validated.
   *
   * Health semantics (documented in docs/architecture.md):
   *  - PUBLIC services: HTTP health check against their host port.
   *  - PRIVATE services / workers: container-running state (the host cannot
   *    reach private container IPs; no agent is installed inside containers).
   *  - depends_on: startup ordering only — dependencies must have STARTED (and
   *    passed their HTTP health check when public) before dependents start.
   */
  private async pipelineMulti(
    deploymentId: string,
    app: ApplicationRow,
    expectedOld: string | null,
    commitSha: string,
    manifest: Manifest,
    repoDir: string | null,
    rollbackTarget: DeploymentRow | null,
  ): Promise<void> {
    const abort = new AbortController();
    this.activeRuns.set(deploymentId, abort);
    const deploymentTagBase = `minicloud/app-${app.id.slice(0, 8)}`;

    // Preview context (v0.7): previews deploy into an isolated network with
    // EPHEMERAL storage and their own route key; they never touch the
    // application's production volumes, active pointer or routes.
    const entryRow = await this.deployments.byId(deploymentId);
    const previewEnvId = entryRow?.preview_environment_id ?? null;
    const isPreview = previewEnvId !== null;
    const appNetwork = isPreview && previewEnvId
      ? `minicloud-prev-${previewEnvId.slice(0, 8)}`
      : this.appNetworkName(app.id);
    const routeKey = entryRow?.gateway_route_key ?? app.route_slug;
    // Preview traffic target when this deployment started building; the
    // preview cutover is guarded against this value.
    const expectedOldPreview = previewEnvId
      ? (await this.previews.byId(previewEnvId))?.active_preview_deployment_id ?? null
      : null;

    // Rollback fast path enters in QUEUED (no clone/build happened): walk the
    // state machine to BUILDING so the STARTING transition is legal.
    const entryStatus = entryRow?.status;
    if (entryStatus === 'QUEUED') {
      for (const [from, to] of [['QUEUED', 'CLONING'], ['CLONING', 'BUILDING']] as const) {
        if (!(await this.deployments.transitionStatus(deploymentId, [from], to))) return;
      }
    }

    const fail = async (stage: string, message: string): Promise<void> => {
      // Cancellation-safe: never overwrite a terminal state set concurrently.
      const freshRow = await this.deployments.byId(deploymentId);
      if (!freshRow || !['QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTH_CHECKING'].includes(freshRow.status)) {
        return;
      }
      await this.transition(deploymentId, null, 'FAILED', {
        failure_reason: `${stage}: ${truncate(message, 1000)}`,
      });
      await this.event(deploymentId, DEPLOYMENT_EVENTS.failed, `${stage}: ${truncate(message, 300)}`);
      this.logger.error('multi-service deployment failed', { deploymentId, stage });
    };

    try {
      // Manifest snapshot (immutable record of what this revision deploys).
      await this.deployments.updateFields(deploymentId, {
        manifest_snapshot: manifest as unknown as Record<string, unknown>,
      });

      // Service rows.
      for (const svc of manifest.services) {
        await this.services.create(deploymentId, {
          serviceName: svc.name,
          containerPort: svc.port ?? null,
          healthPath: svc.public ? (svc.health?.path ?? this.config.defaults.healthPath) : null,
          publicService: svc.public,
        });
      }

      // Network + volumes. Production: named volumes persist across
      // deployments. PREVIEWS: volumes are never created or mounted — PR code
      // must not read production data (v0.7 security policy).
      await this.docker.ensureNetwork(appNetwork);
      await this.event(deploymentId, SERVICE_EVENTS.networkCreated, appNetwork, { network: appNetwork });
      const volumeMountsByService: Record<string, Array<{ volume: string; target: string }>> = {};
      if (!isPreview) {
        for (const volName of Object.keys(manifest.volumes)) {
          const dockerVolume = this.appVolumeName(app.id, volName);
          await this.docker.ensureVolume(dockerVolume);
          await this.volumes.ensure(app.id, volName, dockerVolume);
          await this.event(deploymentId, SERVICE_EVENTS.volumeAttached, `${volName} → ${dockerVolume}`, {
            volume: volName,
            dockerVolume,
          });
        }
        for (const svc of manifest.services) {
          volumeMountsByService[svc.name] = svc.volumes.map((mount) => {
            const [volName, target] = mount.split(':') as [string, string];
            return { volume: this.appVolumeName(app.id, volName), target };
          });
        }
      }

      // Rollback image reuse: per-service images from the target deployment.
      let reusedImages: Record<string, string> | null = null;
      if (rollbackTarget) {
        const targetServices = await this.services.listByDeployment(rollbackTarget.id);
        const images: Record<string, string> = {};
        for (const ts of targetServices) {
          if (ts.image_tag && (await this.docker.imageExists(ts.image_tag))) {
            images[ts.service_name] = ts.image_tag;
          }
        }
        if (Object.keys(images).length === targetServices.length) {
          reusedImages = images; // full set available: skip clone/build entirely
        }
      }
      const needBuild = !reusedImages;

      // Build every service image, with exact-image reuse per service.
      let reusedCount = 0;
      let builtCount = 0;
      if (needBuild && repoDir) {
        for (const svc of manifest.startOrder) {
          const svcDef = manifest.services.find((sd) => sd.name === svc)!;
          // dockerode looks the dockerfile up INSIDE the build context.
          const dockerfileInContext = path.posix.relative(svcDef.context, svcDef.dockerfile);
          if (dockerfileInContext.startsWith('..')) {
            await fail('build', `service "${svc}": dockerfile must live inside the build context`);
            await repoCleanup(repoDir);
            return;
          }
          const tag = `${deploymentTagBase}:${svc}-d-${deploymentId.slice(0, 12)}`;
          const svcRowForBuild = (await this.services.byName(deploymentId, svc))!;
          // Per-service cache identity: same rules as single-service builds.
          let image = tag;
          if (!reusedImages?.[svc]) {
            const fp = await fingerprintBuildInputs(commitSha, path.resolve(repoDir, svcDef.context), dockerfileInContext);
            const artifact = await this.artifacts.find(app.id, fp, svc);
            if (artifact && (await this.docker.imageExists(artifact.image_tag))) {
              image = artifact.image_tag;
              await this.artifacts.markUsed(artifact.id);
              reusedCount++;
              await this.event(
                deploymentId,
                CACHE_EVENTS.imageReused,
                `${svc}: exact image reused`,
                { serviceName: svc, imageTag: image, fingerprint: fp.slice(0, 16), originalCommit: artifact.commit_sha },
              );
              await this.services.updateFields(svcRowForBuild.id, { image_tag: image });
              await this.event(deploymentId, SERVICE_EVENTS.buildCompleted, `${svc} (reused)`, { serviceName: svc, imageTag: image });
              continue;
            }
            await this.event(deploymentId, CACHE_EVENTS.cacheMiss, `${svc}: building from Dockerfile`, {
              serviceName: svc,
              fingerprint: fp.slice(0, 16),
            });
          } else {
            image = reusedImages[svc];
          }
          await this.event(deploymentId, SERVICE_EVENTS.buildStarted, `${svc}: ${tag}`, {
            serviceName: svc,
            imageTag: tag,
          });
          try {
            await this.withBuildTimeout(
              this.docker.build({
                contextDir: path.resolve(repoDir, svcDef.context),
                tag,
                dockerfile: dockerfileInContext,
                signal: abort.signal,
                onOutput: (chunk) => {
                  for (const line of chunk.split(/\r?\n/)) {
                    if (line.trim()) this.emitLog(deploymentId, { source: 'build', stream: 'stdout', message: line });
                  }
                },
              }),
              abort,
            );
            builtCount++;
            await this.artifacts.record({
              applicationId: app.id,
              commitSha,
              serviceName: svc,
              fingerprint: await fingerprintBuildInputs(commitSha, path.resolve(repoDir, svcDef.context), dockerfileInContext),
              imageTag: tag,
            });
            await this.event(deploymentId, SERVICE_EVENTS.buildCompleted, svc, { serviceName: svc, imageTag: tag });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.services.updateFields(
              (await this.services.byName(deploymentId, svc))!.id,
              { status: 'FAILED', failure_reason: truncate(`build failed: ${msg}`, 500) },
            );
            await this.event(deploymentId, SERVICE_EVENTS.healthFailed, `build failed: ${svc}`, { serviceName: svc });
            await fail('build', `service "${svc}": ${msg}`);
            await repoCleanup(repoDir);
            return;
          }
        }
      }
      if (needBuild && repoDir) {
        await this.deployments.updateFields(deploymentId, {
          build_cache: reusedCount === 0 ? 'miss' : builtCount === 0 ? 'image_reused' : 'partial',
        });
      }

      // Effective app configuration (env/secrets/limits) once for all services.
      let cfg: ResolvedAppConfig;
      try {
        cfg = await this.resolvedConfig(app.id, { previewEnvironmentId: previewEnvId });
      } catch (err) {
        await fail('config', err instanceof Error ? err.message : String(err));
        if (repoDir) await repoCleanup(repoDir);
        return;
      }

      // ---- STARTING ---------------------------------------------------------
      if (!(await this.deployments.transitionStatus(deploymentId, ['BUILDING'], 'STARTING'))) {
        if (repoDir) await repoCleanup(repoDir);
        return;
      }

      // Start services in dependency order.
      const startedContainers: Array<{ service: string; containerId: string; hostPort: number | null }> = [];
      const publicRoutes: Array<{ key: string; service: string; hostPort: number; healthPath: string }> = [];
      let firstPublicPort: number | null = null;
      let firstPublicHealth = this.config.defaults.healthPath;

      for (const svcName of manifest.startOrder) {
        const svcDef = manifest.services.find((s) => s.name === svcName)!;
        const svcRow = (await this.services.byName(deploymentId, svcName))!;
        const image =
          reusedImages?.[svcName] ??
          (await this.services.byName(deploymentId, svcName))!.image_tag ??
          `${deploymentTagBase}:${svcName}-d-${deploymentId.slice(0, 12)}`;

        const env: Record<string, string> = { ...cfg.env, ...(svcDef.env ?? {}) };
        // Service registry env: services resolve each other by name.
        for (const other of manifest.services) {
          if (other.name === svcName || !other.port) continue;
          env[`${other.name.toUpperCase().replace(/-/g, '_')}_SERVICE_HOST`] = other.name;
          env[`${other.name.toUpperCase().replace(/-/g, '_')}_SERVICE_PORT`] = String(other.port);
        }

        const isPublic = svcDef.public && !!svcDef.port;
        let hostPort = 0;
        if (isPublic) {
          try {
            hostPort = await allocatePort(this.config.portRange);
            if (!(await canBind(hostPort))) throw new EngineError('port became unavailable', 'port');
          } catch (err) {
            await this.cleanupFailedStart(deploymentId, startedContainers);
            await fail('port', `service "${svcName}": ${err instanceof Error ? err.message : String(err)}`);
            if (repoDir) await repoCleanup(repoDir);
            return;
          }
        }

        const containerName = `minicloud-d-${deploymentId.slice(0, 12)}-${svcName}`;
        await this.event(deploymentId, SERVICE_EVENTS.starting, svcName, { serviceName: svcName });
        let containerId: string;
        try {
          const started = await this.docker.startManagedContainer({
            image,
            name: containerName,
            appLabel: app.id,
            deploymentLabel: deploymentId,
            serviceLabel: svcName,
            containerPort: svcDef.port ?? 0,
            hostPort,
            env,
            limits: svcDef.resources
              ? this.dockerLimits({ memoryLimitMb: svcDef.resources.memoryLimitMb, cpuLimit: svcDef.resources.cpuLimit })
              : {},
            networks: [{ name: appNetwork, alias: svcName }],
            volumeMounts: volumeMountsByService[svcName] ?? [],
          });
          containerId = started.id;
        } catch (err) {
          await this.cleanupFailedStart(deploymentId, startedContainers);
          await fail('start', `service "${svcName}": ${err instanceof Error ? err.message : String(err)}`);
          if (repoDir) await repoCleanup(repoDir);
          return;
        }

        const healthPath = svcDef.health?.path ?? this.config.defaults.healthPath;
        await this.services.updateFields(svcRow.id, {
          status: 'HEALTH_CHECKING',
          image_tag: image,
          container_id: containerId,
          container_name: containerName,
          host_port: hostPort || null,
          container_port: svcDef.port ?? null,
        });
        startedContainers.push({ service: svcName, containerId, hostPort: hostPort || null });

        // Health: public services get an HTTP check; private ones are
        // "healthy" when the container stays up for a short grace period.
        if (isPublic) {
          const ok = await waitForHealthy({
            hostPort,
            path: healthPath,
            timeoutSeconds: svcDef.health?.timeoutSeconds ?? this.config.defaults.healthTimeoutSeconds,
            intervalSeconds: this.config.defaults.healthIntervalSeconds,
            signal: abort.signal,
          });
          if (!ok.ok) {
            await this.event(deploymentId, SERVICE_EVENTS.healthFailed, `${svcName}: ${truncate(ok.lastError ?? '', 200)}`, {
              serviceName: svcName,
            });
            await this.services.transitionStatus(svcRow.id, ['HEALTH_CHECKING'], 'FAILED', {
              failure_reason: `health check failed: ${truncate(ok.lastError ?? '', 300)}`,
            });
            await this.cleanupFailedStart(deploymentId, startedContainers);
            await fail('health', `service "${svcName}": ${ok.lastError ?? 'unhealthy'}`);
            if (repoDir) await repoCleanup(repoDir);
            return;
          }
          await this.event(deploymentId, SERVICE_EVENTS.healthPassed, svcName, { serviceName: svcName });
          publicRoutes.push({ key: publicRoutes.length === 0 ? routeKey! : `${svcName}.${routeKey}`, service: svcName, hostPort, healthPath });
          if (publicRoutes.length === 1) {
            firstPublicPort = hostPort;
            firstPublicHealth = healthPath;
          }
        } else {
          // Private/worker: brief grace period; a crash here fails the start.
          await new Promise((r) => setTimeout(r, 750));
          const state = await this.docker.getContainerState(containerId).catch(() => null);
          if (!state?.running) {
            const exit = state?.exitCode;
            await this.services.transitionStatus(svcRow.id, ['HEALTH_CHECKING'], 'FAILED', {
              failure_reason: `container exited during startup${exit !== null ? ` (exit ${exit})` : ''}`,
              exit_code: exit,
            });
            await this.cleanupFailedStart(deploymentId, startedContainers);
            await fail('start', `service "${svcName}" exited during startup`);
            if (repoDir) await repoCleanup(repoDir);
            return;
          }
        }
        await this.event(deploymentId, SERVICE_EVENTS.started, svcName, { serviceName: svcName, containerId: short(containerId) });
        await this.services.transitionStatus(svcRow.id, ['HEALTH_CHECKING'], 'RUNNING');
      }

      if (repoDir) await repoCleanup(repoDir);

      await this.deployments.updateFields(deploymentId, { image_tag: `${deploymentTagBase}:d-${deploymentId.slice(0, 12)}` });

      // ---- RUNNING ----------------------------------------------------------
      if (!(await this.deployments.transitionStatus(deploymentId, ['STARTING'], 'RUNNING', undefined, { startedAt: new Date() }))) {
        return;
      }
      this.activeRuns.delete(deploymentId);
      await this.event(deploymentId, DEPLOYMENT_EVENTS.running, `multi-service (${manifest.services.length} services)`, {
        services: manifest.services.map((s) => s.name),
      });
      this.logger.info('multi-service deployment running', { deploymentId, app: app.name });

      // Cutover: previews swap the PREVIEW pointer + route only — production
      // routing is never consulted or modified.
      if (isPreview && previewEnvId) {
        await this.activatePreview(deploymentId, previewEnvId, expectedOldPreview, routeKey!, publicRoutes);
      } else {
        await this.activateMulti(deploymentId, app, expectedOld, publicRoutes, firstPublicPort, firstPublicHealth);
      }
    } catch (err) {
      // Anything unexpected: fail loudly, previous version keeps serving.
      await fail('pipeline', err instanceof Error ? err.message : String(err));
    }
  }

  /** Remove all containers started by a failed multi-service start. */
  private async cleanupFailedStart(
    deploymentId: string,
    started: Array<{ service: string; containerId: string; hostPort: number | null }>,
  ): Promise<void> {
    for (const c of started) {
      await this.docker.stop(c.containerId).catch(() => {});
      await this.docker.remove(c.containerId, true).catch(() => {});
      const svcRow = await this.services.byName(deploymentId, c.service);
      if (svcRow) {
        await this.services.updateFields(svcRow.id, { status: 'STOPPED', container_id: null, container_name: null });
      }
    }
  }

  /**
   * Preview cutover: swap the PREVIEW environment's active pointer (guarded),
   * register/verify the preview routes, then retire the previous preview
   * deployment. Production routing state is never touched.
   */
  private async activatePreview(
    deploymentId: string,
    envId: string,
    expectedOldDep: string | null,
    routeKey: string,
    publicRoutes: Array<{ key: string; service: string; hostPort: number; healthPath: string }>,
  ): Promise<void> {
    const gw = this.gateway;
    if (!gw) return;
    // Lock key is scoped to THIS preview environment: concurrent previews of
    // one application never serialize against production deploys.
    await this.withAppLock(`preview:${envId}`, async () => {
      const env = await this.previews.byId(envId);
      if (!env || env.status === 'closed') {
        await this.retireAny(deploymentId, 'preview closed before cutover');
        return;
      }
      const current = env.active_preview_deployment_id;
      if (current === deploymentId) return;
      await this.event(deploymentId, TRAFFIC_EVENTS.cutoverStarted, `preview ${env.pr_number}: ${short(current ?? 'none')} → ${short(deploymentId)}`, {
        previewEnvironmentId: envId,
        prNumber: env.pr_number,
        from: current,
        to: deploymentId,
      });
      const swapped = await this.previews.setActiveDeployment(envId, deploymentId, expectedOldDep);
      if (!swapped) {
        await this.event(deploymentId, TRAFFIC_EVENTS.superseded, 'preview traffic switched elsewhere during cutover');
        await this.retireAny(deploymentId, 'superseded during preview cutover');
        return;
      }
      for (const r of publicRoutes) {
        gw.setRoute(r.key, { deploymentId, host: '127.0.0.1', port: r.hostPort });
      }

      let allVerified = true;
      for (const r of publicRoutes) {
        if (!(await gw.verifyRoute(r.key, r.healthPath))) {
          allVerified = false;
          break;
        }
      }
      if (!allVerified) {
        await this.event(deploymentId, TRAFFIC_EVENTS.cutoverFailed, 'gateway verification failed; reverting preview traffic', {
          previewEnvironmentId: envId,
        });
        if (current) {
          await this.previews.setActiveDeployment(envId, current, deploymentId);
          const oldRow = await this.deployments.byId(current);
          if (oldRow?.manifest_snapshot) {
            for (const os of await this.services.listByDeployment(current)) {
              if (os.public_service && os.host_port) {
                const key = os.service_name === publicRoutes[0]?.service ? routeKey : `${os.service_name}.${routeKey}`;
                gw.setRoute(key, { deploymentId: current, host: '127.0.0.1', port: os.host_port });
              }
            }
          } else if (oldRow?.host_port) {
            gw.setRoute(routeKey, { deploymentId: current, host: '127.0.0.1', port: oldRow.host_port });
          }
        } else {
          for (const r of publicRoutes) gw.setRoute(r.key, null);
          await this.previews.clearActiveDeployment(envId, deploymentId);
        }
        await this.retireAny(deploymentId, 'preview cutover verification failed; previous preview kept serving');
        return;
      }

      await this.event(deploymentId, TRAFFIC_EVENTS.cutoverCompleted, `${routeKey} now serves ${short(deploymentId)}`, {
        previewEnvironmentId: envId,
        prNumber: env.pr_number,
        routeKey,
      });
      this.logger.info('preview cutover complete', { deploymentId, envId, routeKey });
      if (current) {
        // Drain in-flight requests on the replaced preview, then stop it.
        await this.drainAndRetireMulti(current, publicRoutes[0]?.key ?? routeKey);
      }
    });
  }

  /** Retire whichever shape a deployment is: multi-service or single-service. */
  private async retireAny(deploymentId: string, reason: string): Promise<void> {
    const row = await this.deployments.byId(deploymentId);
    if (!row) return;
    if (row.manifest_snapshot) {
      await this.retireMulti(deploymentId, reason);
    } else {
      await this.retireDeployment(deploymentId, reason);
    }
  }


  /**
   * Multi-service cutover: guarded swap + gateway routes for every public
   * service + verification + drain of the previous deployment's services.
   */
  private async activateMulti(
    deploymentId: string,
    app: ApplicationRow,
    expectedOld: string | null,
    publicRoutes: Array<{ key: string; service: string; hostPort: number; healthPath: string }>,
    firstPublicPort: number | null,
    firstPublicHealth: string,
  ): Promise<void> {
    if (!this.gateway || !app.route_slug) return;
    const gw = this.gateway;
    await this.withAppLock(app.id, async () => {
      const fresh = await this.apps.byId(app.id);
      if (!fresh) return;
      const current = fresh.active_deployment_id;
      this.logger.warn('ACTIVATE-MULTI', { deploymentId: short(deploymentId), expectedOld: expectedOld ? short(expectedOld) : null, current: current ? short(current) : null });
      if (current === deploymentId) return;
      if (current !== expectedOld) {
        await this.event(deploymentId, TRAFFIC_EVENTS.superseded, `traffic moved to ${short(current ?? '?')}`);
        await this.retireMulti(deploymentId, 'superseded by a newer deployment');
        return;
      }

      await this.event(deploymentId, TRAFFIC_EVENTS.cutoverStarted, `${short(current ?? 'none')} → ${short(deploymentId)}`, {
        from: current,
        to: deploymentId,
      });
      const swapped = await this.apps.setActiveDeployment(app.id, deploymentId, current);
      if (!swapped) {
        await this.event(deploymentId, TRAFFIC_EVENTS.superseded, 'traffic switched elsewhere during cutover');
        await this.retireMulti(deploymentId, 'superseded during cutover');
        return;
      }

      // Routes: <slug> -> first public service; <service>.<slug> -> each.
      for (const r of publicRoutes) {
        gw.setRoute(r.key, this.upstreamFor(deploymentId, r.hostPort) ?? { deploymentId, host: '127.0.0.1', port: r.hostPort });
      }

      // Verify every public route through the gateway.
      let allVerified = true;
      for (const r of publicRoutes) {
        if (!(await gw.verifyRoute(r.key, r.healthPath))) {
          allVerified = false;
          break;
        }
      }
      if (!allVerified) {
        await this.event(deploymentId, TRAFFIC_EVENTS.cutoverFailed, 'gateway verification failed; reverting traffic');
        if (current) {
          await this.apps.setActiveDeployment(app.id, current, deploymentId);
          const oldServices = await this.services.listByDeployment(current);
          for (const os of oldServices) {
            if (os.public_service && os.host_port) {
              const key = os.service_name === publicRoutes[0]?.service ? app.route_slug! : `${os.service_name}.${app.route_slug}`;
              gw.setRoute(key, this.upstreamFor(current, os.host_port) ?? { deploymentId: current, host: '127.0.0.1', port: os.host_port });
            }
          }
        } else {
          for (const r of publicRoutes) gw.setRoute(r.key, null);
          await this.apps.clearActiveDeployment(app.id, deploymentId);
        }
        await this.retireMulti(deploymentId, 'cutover verification failed; previous version kept serving');
        return;
      }

      await this.event(deploymentId, TRAFFIC_EVENTS.cutoverCompleted, `${app.route_slug} cutover complete`, {
        slug: app.route_slug,
        from: current,
        to: deploymentId,
        services: publicRoutes.map((r) => r.service),
      });
      if (current) await this.drainAndRetireMulti(current, publicRoutes[0]?.key ?? app.route_slug!);
    });
  }

  /** Drain the previous multi-service deployment and retire all services. */
  private async drainAndRetireMulti(deploymentId: string, routeKey: string): Promise<void> {
    if (!this.gateway) return;
    await this.event(deploymentId, TRAFFIC_EVENTS.drainStarted);
    const budgetMs = (this.config.drainTimeoutSeconds ?? 10) * 1000;
    const start = Date.now();
    while (this.gateway.activeRequests(routeKey) > 0 && Date.now() - start < budgetMs) {
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.retireMulti(deploymentId, 'retired after cutover');
    await this.event(deploymentId, TRAFFIC_EVENTS.drainCompleted);
  }

  /** Stop all service containers of a deployment and mark everything STOPPED. */
  private async retireMulti(deploymentId: string, reason: string): Promise<void> {
    const rows = await this.services.listByDeployment(deploymentId);
    for (const svc of rows) {
      if (svc.container_id) {
        await this.docker.stop(svc.container_id).catch(() => {});
        await this.docker.remove(svc.container_id, true).catch(() => {});
        await this.services.updateFields(svc.id, { status: 'STOPPED', container_id: null, container_name: null });
      } else if (svc.status === 'QUEUED' || svc.status === 'HEALTH_CHECKING') {
        await this.services.updateFields(svc.id, { status: 'STOPPED' });
      }
    }
    await this.deployments.transitionStatus(
      deploymentId,
      ['RUNNING', 'FAILED', 'STOPPED', 'HEALTH_CHECKING', 'STARTING', 'BUILDING', 'CLONING', 'QUEUED'],
      'STOPPED',
      undefined,
      { stoppedAt: new Date() },
    );
    this.logger.info('multi-service deployment retired', { deploymentId, reason });
  }


  // ---- crash detection & automatic recovery ---------------------------------

  /**
   * One monitor tick: detect crashed RUNNING containers, then fire any
   * automatic restarts whose backoff has elapsed. Timer-free by design — all
   * scheduling state lives in the database (next_auto_restart_at), so it
   * survives API restarts and cannot leak timers for deleted deployments.
   */
  async checkCrashes(): Promise<void> {
    await this.detectCrashes();
    await this.fireDueAutoRestarts();
  }

  private async detectCrashes(): Promise<void> {
    const rows = await this.db.query<DeploymentRow>(
      "SELECT * FROM deployments WHERE status = 'RUNNING' AND container_id IS NOT NULL",
    );
    for (const row of rows.rows) {
      const state = await this.docker.getContainerState(row.container_id!).catch(() => null);
      if (state === null || !state.running) {
        await this.handleCrash(row, state, 'Container exited unexpectedly');
      }
    }
    // Multi-service: per-service crash detection (single-service deployments
    // have no service rows, so this is a no-op for them).
    const svcRows = await this.db.query<DeploymentServiceRow>(
      `SELECT s.* FROM deployment_services s
       JOIN deployments d ON d.id = s.deployment_id
       WHERE d.status = 'RUNNING' AND s.status = 'RUNNING' AND s.container_id IS NOT NULL`,
    );
    for (const svc of svcRows.rows) {
      const state = await this.docker.getContainerState(svc.container_id!).catch(() => null);
      if (state === null || !state.running) {
        await this.handleServiceCrash(svc, state);
      }
    }
  }

  /**
   * Per-service crash handling. Semantics (documented): one service crashing
   * never touches its siblings; the service restarts per ITS manifest policy
   * with its own budget; a public service of the ACTIVE deployment that dies
   * terminally takes its gateway route down (503).
   */
  private async handleServiceCrash(
    svc: DeploymentServiceRow,
    state: { running: boolean; exitCode: number | null } | null,
  ): Promise<void> {
    await this.withLock(svc.deployment_id, async () => {
      const fresh = await this.services.byName(svc.deployment_id, svc.service_name);
      if (!fresh || fresh.status !== 'RUNNING' || fresh.container_id !== svc.container_id) {
        return; // raced with a restart/cutover
      }
      const dep = await this.deployments.byId(svc.deployment_id);
      const app = dep ? await this.apps.byId(dep.application_id) : null;
      const exitCode = state?.exitCode ?? null;

      await this.event(svc.deployment_id, SERVICE_EVENTS.crashed, `${svc.service_name} exited (code ${exitCode ?? '?'})`, {
        serviceName: svc.service_name,
        exitCode,
      });
      if (svc.container_id) {
        await this.docker.stop(svc.container_id).catch(() => {});
        await this.docker.remove(svc.container_id, true).catch(() => {});
        await this.services.updateFields(fresh.id, { container_id: null, container_name: null, host_port: null });
      }

      // Policy comes from the deployment's manifest snapshot.
      const snap = dep ? parseManifestSnapshot(dep.manifest_snapshot) : null;
      const svcDef = snap?.services.find((sd) => sd.name === svc.service_name);
      const policy = svcDef?.restart ?? 'disabled';
      const maxAttempts = svcDef?.maxRestartAttempts ?? 0;

      const failed = await this.services.transitionStatus(fresh.id, ['RUNNING'], 'FAILED', {
        failure_reason: `container exited unexpectedly${exitCode !== null ? ` (exit code ${exitCode})` : ''}`,
        exit_code: exitCode,
      });
      if (!failed) return;

      if (policy === 'on-failure' && failed.auto_restart_count < maxAttempts) {
        const attempt = failed.auto_restart_count + 1;
        const delayMs = autoRestartDelayMs(attempt);
        await this.services.updateFields(fresh.id, { next_auto_restart_at: new Date(Date.now() + delayMs) });
        await this.event(
          svc.deployment_id,
          SERVICE_EVENTS.restartScheduled,
          `${svc.service_name} attempt ${attempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s`,
          { serviceName: svc.service_name, attempt, maxAttempts },
        );
      } else {
        await this.event(
          svc.deployment_id,
          SERVICE_EVENTS.crashed,
          `${svc.service_name} failed terminally (policy ${policy}, attempts ${maxAttempts})`,
          { serviceName: svc.service_name, policy },
        );
        // Public service of the active deployment: take its route down.
        const active = app?.active_deployment_id === svc.deployment_id;
        const isPublicRoute = fresh.public_service;
        if (active && this.gateway && app?.route_slug && isPublicRoute) {
          const key = (await this.publicServiceKeys(dep!, app)).find((k) => k.service === svc.service_name);
          if (key) this.gateway.setRoute(key.key, null);
          await this.event(svc.deployment_id, TRAFFIC_EVENTS.upstreamUnavailable, `${svc.service_name} unavailable`);
        }
      }
    });
  }

  /** Public route keys (key + service name) for a deployment. */
  private async publicServiceKeys(
    dep: DeploymentRow,
    app: ApplicationRow,
  ): Promise<Array<{ key: string; service: string; hostPort: number; healthPath: string }>> {
    const snap = dep.manifest_snapshot as unknown as { services: Array<{ name: string; port?: number; public: boolean; health?: { path: string } }> } | null;
    if (!snap) return [];
    const rows = await this.services.listByDeployment(dep.id);
    const keys: Array<{ key: string; service: string; hostPort: number; healthPath: string }> = [];
    let first = true;
    for (const sd of snap.services) {
      if (!sd.public || !sd.port) continue;
      const row = rows.find((r) => r.service_name === sd.name);
      if (!row?.host_port) continue;
      keys.push({
        key: first ? (dep.gateway_route_key ?? app.route_slug!) : `${sd.name}.${dep.gateway_route_key ?? app.route_slug}`,
        service: sd.name,
        hostPort: row.host_port,
        healthPath: sd.health?.path ?? this.config.defaults.healthPath,
      });
      first = false;
    }
    return keys;
  }

  /** First public service name from a deployment's manifest snapshot. */
  private firstServiceOf(dep: DeploymentRow): string | null {
    const snap = dep.manifest_snapshot as unknown as { services: Array<{ name: string; public: boolean }> } | null;
    return snap?.services.find((s) => s.public)?.name ?? null;
  }

  /**
   * Handle a crashed container: record the crash, remove the dead container
   * (retention — the exit code is already persisted), transition to FAILED
   * (guarded on RUNNING so a concurrent manual restart wins cleanly), and
   * schedule an automatic restart when the policy allows and budget remains.
   */
  private async handleCrash(
    row: DeploymentRow,
    state: { running: boolean; exitCode: number | null } | null,
    reason: string,
  ): Promise<void> {
    // Serialize with stop/restart/delete: without the lock, a manual restart
    // could replace the container between our snapshot and our cleanup, and
    // we would tear down the NEW container.
    await this.withLock(row.id, async () => {
      const fresh = await this.deployments.byId(row.id);
      if (!fresh || fresh.status !== 'RUNNING' || fresh.container_id !== row.container_id) {
        return; // raced with restart/stop/delete — they own the deployment now
      }
      await this.handleCrashLocked(fresh, state, reason);
    });
  }

  private async handleCrashLocked(
    row: DeploymentRow,
    state: { running: boolean; exitCode: number | null } | null,
    reason: string,
  ): Promise<void> {
    const exitCode = state?.exitCode ?? null;
    const app = await this.apps.byId(row.application_id);
    const fullReason = `${reason}${exitCode !== null ? ` (exit code ${exitCode})` : ''}`;

    await this.event(row.id, DEPLOYMENT_EVENTS.containerCrashed, `exit code ${exitCode ?? 'unknown'}`, {
      exitCode,
    });

    // Remove the dead container; keep nothing running behind a FAILED row.
    if (row.container_id) {
      await this.docker.stop(row.container_id).catch(() => {});
      await this.docker.remove(row.container_id, true).catch(() => {});
      await this.deployments.updateFields(row.id, { container_id: null, container_name: null });
    }

    const updated = await this.deployments.transitionStatus(
      row.id,
      ['RUNNING'],
      'FAILED',
      { failure_reason: fullReason, exit_code: exitCode },
      { stoppedAt: new Date() },
    );
    if (!updated) return;

    const policy = app?.restart_policy ?? 'disabled';
    const maxAttempts = app?.max_restart_attempts ?? 0;
    if (policy === 'on-failure' && updated.auto_restart_count < maxAttempts) {
      const attempt = updated.auto_restart_count + 1;
      const delayMs = autoRestartDelayMs(attempt);
      await this.deployments.updateFields(row.id, {
        next_auto_restart_at: new Date(Date.now() + delayMs),
      });
      await this.event(
        row.id,
        DEPLOYMENT_EVENTS.autoRestartScheduled,
        `attempt ${attempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s`,
        { attempt, maxAttempts, delayMs },
      );
      this.logger.warn('auto restart scheduled', { deploymentId: row.id, attempt, maxAttempts, delayMs });
    } else {
      const exhausted = policy === 'on-failure';
      await this.event(
        row.id,
        DEPLOYMENT_EVENTS.failed,
        exhausted ? `max restart attempts reached (${maxAttempts})` : fullReason,
        { exitCode, policy, maxAttempts },
      );
      this.logger.warn('deployment failed (crash)', { deploymentId: row.id, exitCode, policy });
      // Terminal crash of the ACTIVE deployment: nothing will recover it, so
      // take the app route down (gateway answers 503) and clear the pointer.
      if (app?.active_deployment_id === row.id) {
        await this.apps.clearActiveDeployment(app.id, row.id);
        if (this.gateway && app.route_slug) {
          this.gateway.setRoute(app.route_slug, null);
          await this.event(row.id, TRAFFIC_EVENTS.upstreamUnavailable, 'active deployment crashed terminally');
        }
      }
    }
  }

  /** Fire automatic restarts whose backoff has elapsed. */
  private async fireDueAutoRestarts(): Promise<void> {
    const rows = await this.db.query<DeploymentRow>(
      `SELECT * FROM deployments
       WHERE status = 'FAILED' AND next_auto_restart_at IS NOT NULL AND next_auto_restart_at <= now()`,
    );
    for (const row of rows.rows) {
      const app = await this.apps.byId(row.application_id);
      if (!app || app.restart_policy !== 'on-failure' || row.auto_restart_count >= app.max_restart_attempts) {
        // Policy changed or budget gone: cancel the pending restart.
        await this.deployments.updateFields(row.id, { next_auto_restart_at: null });
        continue;
      }
      // Atomic claim: a concurrent manual stop/restart/delete invalidates it.
      const claimed = await this.deployments.claimDueAutoRestart(row.id);
      if (!claimed) continue;
      const attempt = claimed.auto_restart_count;
      await this.event(row.id, DEPLOYMENT_EVENTS.autoRestartAttempt, `automatic attempt ${attempt}`, { attempt });
      try {
        await this.restartDeployment(row.id, { automatic: true, attempt });
      } catch (err) {
        // The failure is already recorded inside restartDeployment; nothing
        // schedules a retry — the deployment stays FAILED and requires manual
        // intervention. No loops.
        this.logger.warn('auto restart failed', { deploymentId: row.id, attempt, error: String(err) });
      }
    }
    await this.fireDueServiceRestarts();
  }

  /**
   * Restart one service container of a RUNNING multi-service deployment:
   * new container from the service image, same env/limits/network/volumes;
   * public services get a fresh host port and a verified route update.
   */
  private async restartService(svc: DeploymentServiceRow, attempt: number): Promise<void> {
    const dep = await this.deployments.byId(svc.deployment_id);
    if (!dep || dep.status !== 'RUNNING') return;
    const app = await this.apps.byId(dep.application_id);
    if (!app) return;
    const snap = parseManifestSnapshot(dep.manifest_snapshot);
    const svcDef = snap?.services.find((sd) => sd.name === svc.service_name);
    if (!svcDef) return;
    const cfg = await this.resolvedConfig(app.id);

    const env: Record<string, string> = { ...cfg.env, ...(svcDef.env ?? {}) };
    for (const other of snap!.services) {
      if (other.name === svc.service_name || !other.port) continue;
      env[`${other.name.toUpperCase().replace(/-/g, '_')}_SERVICE_HOST`] = other.name;
      env[`${other.name.toUpperCase().replace(/-/g, '_')}_SERVICE_PORT`] = String(other.port);
    }
    const isPublic = svcDef.public && !!svcDef.port;
    let hostPort = 0;
    if (isPublic) hostPort = await allocatePort(this.config.portRange);
    const containerName = `minicloud-d-${svc.deployment_id.slice(0, 12)}-${svc.service_name}-${randomUUID().slice(0, 4)}`;
    const image = svc.image_tag ?? `${dep.image_tag?.split(':')[0]}:${svc.service_name}-d-${svc.deployment_id.slice(0, 12)}`;

    const started = await this.docker.startManagedContainer({
      image,
      name: containerName,
      appLabel: app.id,
      deploymentLabel: svc.deployment_id,
      serviceLabel: svc.service_name,
      containerPort: svcDef.port ?? 0,
      hostPort,
      env,
      limits: svcDef.resources
        ? this.dockerLimits({ memoryLimitMb: svcDef.resources.memoryLimitMb, cpuLimit: svcDef.resources.cpuLimit })
        : {},
      networks: [{ name: this.appNetworkName(app.id), alias: svc.service_name }],
      volumeMounts: (svcDef.volumes ?? []).map((mount) => {
        const [volName, target] = mount.split(':') as [string, string];
        return { volume: this.appVolumeName(app.id, volName), target };
      }),
    });
    await this.services.updateFields(svc.id, {
      status: 'RUNNING',
      container_id: started.id,
      container_name: containerName,
      host_port: hostPort || null,
      restart_count: svc.restart_count + 1,
      failure_reason: null,
      exit_code: null,
    });
    await this.event(svc.deployment_id, SERVICE_EVENTS.recovered, `${svc.service_name} recovered (attempt ${attempt})`, {
      serviceName: svc.service_name,
      attempt,
    });

    // Public service of the active deployment: follow it with the gateway.
    if (isPublic && app.active_deployment_id === svc.deployment_id && this.gateway && app.route_slug) {
      const keys = await this.publicServiceKeys(dep, app);
      const key = keys.find((k) => k.service === svc.service_name);
      if (key) {
        this.gateway.setRoute(key.key, this.upstreamFor(svc.deployment_id, hostPort) ?? { deploymentId: svc.deployment_id, host: '127.0.0.1', port: hostPort });
        const ok = await this.gateway.verifyRoute(key.key, key.healthPath);
        await this.event(svc.deployment_id, TRAFFIC_EVENTS.routeUpdated, `${key.key} → port ${hostPort}`, {
          serviceName: svc.service_name,
          verified: ok,
        });
      }
    }
  }

  /** Fire due per-service automatic restarts. */
  private async fireDueServiceRestarts(): Promise<void> {
    const due = await this.services.listDueAutoRestarts();
    for (const svc of due) {
      const dep = await this.deployments.byId(svc.deployment_id);
      if (!dep || dep.status !== 'RUNNING') {
        await this.services.updateFields(svc.id, { next_auto_restart_at: null });
        continue;
      }
      const app = await this.apps.byId(dep.application_id);
      const snap = parseManifestSnapshot(dep.manifest_snapshot);
      const svcDef = snap?.services.find((sd) => sd.name === svc.service_name);
      if (!app || !svcDef || svcDef.restart !== 'on-failure' || svc.auto_restart_count >= svcDef.maxRestartAttempts) {
        await this.services.updateFields(svc.id, { next_auto_restart_at: null });
        continue;
      }
      const claimed = await this.services.claimDueAutoRestart(svc.id);
      if (!claimed) continue;
      const attempt = claimed.auto_restart_count;
      try {
        await this.restartService(claimed, attempt);
      } catch (err) {
        this.logger.warn('service auto restart failed', {
          deploymentId: svc.deployment_id,
          service: svc.service_name,
          attempt,
          error: String(err),
        });
      }
    }
  }

  // ---- rollback --------------------------------------------------------------

  /**
   * Roll an application back to a previous deployment by creating a NEW
   * deployment that reuses the target's code revision. Historical rows and
   * snapshots are never mutated.
   *
   * Image strategy: reuse the target's Docker image when it still exists
   * (fast path); otherwise rebuild from the recorded commit SHA.
   */
  async rollbackDeployment(applicationId: string, targetDeploymentId: string): Promise<DeploymentRow> {
    const target = await this.deployments.byId(targetDeploymentId);
    if (!target) throw new EngineError('Target deployment not found', 'rollback');
    if (target.application_id !== applicationId) {
      throw new EngineError('Target deployment belongs to a different application', 'rollback');
    }
    if (!target.image_tag) {
      throw new EngineError('Target deployment has no built image and cannot be a rollback target', 'rollback');
    }
    if (['QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTH_CHECKING'].includes(target.status)) {
      throw new EngineError(`Target deployment is still in progress (${target.status})`, 'rollback');
    }
    const app = await this.apps.byId(applicationId);
    if (!app) throw new EngineError('Application not found', 'rollback');

    const reusable = await this.docker.imageExists(target.image_tag);
    const SHA_RE = /^[0-9a-f]{40}$/i;
    const ref = reusable
      ? (target.ref ?? 'HEAD')
      : target.commit_sha && SHA_RE.test(target.commit_sha)
        ? target.commit_sha
        : null;
    if (!ref) {
      throw new EngineError(
        'Target image no longer exists and the original commit could not be determined; redeploy the revision instead',
        'rollback',
      );
    }

    const dep = await this.deployments.create(applicationId, {
      ref,
      commitSha: target.commit_sha,
      rollbackOf: target.id,
      healthPath: target.health_path ?? undefined,
      containerPort: target.container_port ?? undefined,
    });
    await this.event(dep.id, DEPLOYMENT_EVENTS.rollbackRequested, `rollback to ${short(target.id)}`, {
      targetDeploymentId: target.id,
      reuseImage: reusable,
    });
    this.logger.info('rollback queued', { deploymentId: dep.id, target: target.id, reuseImage: reusable });
    // Since v0.7 the deployment queue owns execution; callers enqueue it.
    return dep;
  }

  /**
   * Tear down one preview deployment (PR closed / explicit delete): drop its
   * route, retire its containers/network. Persistent production volumes are
   * never touched — previews have no volume mounts by policy. The row stays
   * as STOPPED history inside the preview environment.
   */
  async teardownPreviewDeployment(deploymentId: string): Promise<void> {
    const row = await this.deployments.byId(deploymentId);
    if (!row || !row.preview_environment_id) return;
    if (this.gateway && row.gateway_route_key) {
      this.gateway.setRoute(row.gateway_route_key, null);
    }
    await this.retireAny(deploymentId, 'preview environment closed');
    // Multi-service previews get their own network; remove it once empty.
    if (row.manifest_snapshot) {
      await this.docker.removeNetwork(`minicloud-prev-${row.preview_environment_id.slice(0, 8)}`).catch(() => {});
    }
    this.logger.info('preview deployment torn down', { deploymentId });
  }

  // ---- retention ---------------------------------------------------------------

  /**
   * Remove MiniCloud-owned resources nothing references anymore:
   *  - containers whose deployment row is gone or terminal
   *  - minicloud/app-* images no deployment references as image_tag
   *  - stale clone-* workspace directories older than an hour
   * Never touches containers/images without MiniCloud labels/tags.
   */
  async prune(): Promise<{ containersRemoved: number; imagesRemoved: number; workspacesRemoved: number }> {
    const ACTIVE = ['QUEUED', 'CLONING', 'BUILDING', 'STARTING', 'HEALTH_CHECKING', 'RUNNING'];
    let containersRemoved = 0;
    for (const c of await this.docker.listManagedContainers()) {
      const depId = c.labels[MINICLOUD_LABELS.deployment] ?? '';
      const row = depId ? await this.deployments.byId(depId) : null;
      const inUse = row !== null && ACTIVE.includes(row.status) && row.container_id === c.id;
      if (!inUse) {
        await this.docker.remove(c.id, true).catch(() => {});
        containersRemoved++;
      }
    }

    let imagesRemoved = 0;
    const referenced = new Set([
      ...(await this.db.query<{ image_tag: string }>('SELECT image_tag FROM deployments WHERE image_tag IS NOT NULL')).rows.map(
        (r) => r.image_tag,
      ),
      // Build-cache artifacts are rollback/reuse targets: keep their images.
      ...(await this.artifacts.allTags()),
    ]);
    for (const img of await this.docker.listMiniCloudImages()) {
      for (const tag of img.tags) {
        if (!referenced.has(tag)) {
          await this.docker.removeImage(tag).catch(() => {});
          imagesRemoved++;
        }
      }
    }

    let workspacesRemoved = 0;
    try {
      const entries = await readdir(this.config.workspaceDir).catch(() => [] as string[]);
      const staleCutoff = Date.now() - 3_600_000;
      for (const entry of entries) {
        if (!entry.startsWith('clone-')) continue;
        const full = path.join(this.config.workspaceDir, entry);
        const s = await stat(full).catch(() => null);
        if (s && s.mtimeMs < staleCutoff) {
          await rm(full, { recursive: true, force: true }).catch(() => {});
          workspacesRemoved++;
        }
      }
    } catch {
      /* workspace pruning is best-effort */
    }

    this.logger.info('prune complete', { containersRemoved, imagesRemoved, workspacesRemoved });
    return { containersRemoved, imagesRemoved, workspacesRemoved };
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
      "SELECT * FROM deployments WHERE status NOT IN ('FAILED','STOPPED','CANCELLED') OR container_id IS NOT NULL",
    );
    // QUEUED rows with a live queue job are waiting for a scheduler slot —
    // they are healthy state, not crashes to fail.
    const waitingQueued = new Set(
      (
        await this.db.query<{ deployment_id: string }>(
          "SELECT deployment_id FROM deployment_jobs WHERE status = 'queued'",
        )
      ).rows.map((r) => r.deployment_id),
    );
    for (const row of rows.rows) {
      if (row.status === 'QUEUED' && waitingQueued.has(row.id)) continue;
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
      // Non-terminal DB state whose container is gone/exited: this is a crash
      // that happened while MiniCloud was offline. Route it through the same
      // policy-aware handler as live crash detection (records the crash,
      // removes the container, schedules recovery when configured).
      if (!container || container.state !== 'running') {
        if (row.status === 'RUNNING') {
          const state = container
            ? { running: false, exitCode: container.exitCode ?? null }
            : await this.docker.getContainerState(row.container_id ?? '').catch(() => null);
          await this.handleCrash(row, state, 'Reconciled at startup: container exited');
        } else {
          // Pre-RUNNING state (e.g. API died mid-build): nothing to recover.
          await this.deployments.transitionStatus(row.id, [row.status], 'FAILED', {
            failure_reason: `Reconciled at startup: container ${container ? 'exited' : 'missing'}`,
          }, { stoppedAt: new Date() });
          if (container) await this.docker.remove(container.id, true).catch(() => {});
        }
        fixed++;
        this.logger.warn('reconciliation: handled dead container', { deploymentId: row.id, was: row.status });
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


    // Route rebuild: re-register gateway routes from persisted state and
    // clear pointers that no longer match reality.
    if (this.gateway) {
      const appRows = await this.db.query<ApplicationRow>('SELECT * FROM applications');
      for (const appRow of appRows.rows) {
        if (!appRow.route_slug) continue;
        const active = appRow.active_deployment_id
          ? await this.deployments.byId(appRow.active_deployment_id)
          : null;
        const containerUp =
          active?.container_id &&
          (await this.docker.getContainerState(active.container_id).catch(() => null))?.running === true;
        if (active && active.status === 'RUNNING' && containerUp && active.host_port) {
          const upstream = this.upstreamFor(active.id, active.host_port);
          if (upstream) this.gateway.setRoute(appRow.route_slug, upstream);
        } else {
          this.gateway.setRoute(appRow.route_slug, null);
          // Terminal (and not merely awaiting an automatic restart): the
          // pointer is stale — clear it so the app serves 503 honestly.
          const pendingRecovery = active?.status === 'FAILED' && active.next_auto_restart_at !== null;
          if (active && ['FAILED', 'STOPPED'].includes(active.status) && !pendingRecovery) {
            await this.apps.clearActiveDeployment(appRow.id, active.id);
          }
        }
      }
      // Stale RUNNING deployments that are NOT their app's active deployment:
      // leftovers from an interrupted cutover. They must not serve traffic.
      const stale = await this.db.query<DeploymentRow>(
        `SELECT d.* FROM deployments d
         JOIN applications a ON a.id = d.application_id
         WHERE d.status = 'RUNNING' AND a.active_deployment_id IS DISTINCT FROM d.id`,
      );
      for (const row of stale.rows) {
        if (row.container_id) {
          await this.docker.stop(row.container_id).catch(() => {});
          await this.docker.remove(row.container_id, true).catch(() => {});
          await this.deployments.updateFields(row.id, { container_id: null, container_name: null });
        }
        await this.deployments.transitionStatus(row.id, ['RUNNING'], 'STOPPED', undefined, { stoppedAt: new Date() });
        fixed++;
        this.logger.warn('reconciliation: retired stale non-active deployment', { deploymentId: row.id });
      }
    }

    // Multi-service reconciliation: service containers, networks and routes.
    if (this.gateway) {
      const multiRows = await this.db.query<DeploymentRow>(
        `SELECT * FROM deployments WHERE status = 'RUNNING' AND manifest_snapshot IS NOT NULL`,
      );
      for (const dep of multiRows.rows) {
        const app = await this.apps.byId(dep.application_id);
        if (!app?.route_slug) continue;
        await this.docker.ensureNetwork(this.appNetworkName(app.id));
        const svcRows = await this.services.listByDeployment(dep.id);
        const isActive = app.active_deployment_id === dep.id;
        const keys = await this.publicServiceKeys(dep, app);
        for (const svc of svcRows) {
          if (!svc.container_id) continue;
          const state = await this.docker.getContainerState(svc.container_id).catch(() => null);
          if (state === null || !state.running) {
            // Crashed while offline: same policy-aware per-service handling.
            await this.handleServiceCrash(svc, state);
          } else if (isActive) {
            const key = keys.find((k) => k.service === svc.service_name);
            if (key) {
              const upstream = this.upstreamFor(dep.id, svc.host_port ?? 0);
              if (upstream) this.gateway.setRoute(key.key, upstream);
            }
          }
        }
      }
    }

    // Preview environments: rebuild routes from the persisted active preview
    // deployment and ensure their isolated networks still exist.
    if (this.gateway) {
      for (const env of await this.previews.listOpen()) {
        const appRow = await this.apps.byId(env.application_id);
        if (!appRow) continue;
        const dep = env.active_preview_deployment_id
          ? await this.deployments.byId(env.active_preview_deployment_id)
          : null;
        const up =
          dep?.status === 'RUNNING' &&
          (dep.container_id || dep.manifest_snapshot) &&
          (dep.container_id
            ? (await this.docker.getContainerState(dep.container_id).catch(() => null))?.running === true
            : true);
        if (!up) {
          this.gateway.setRoute(env.route_slug, null);
          continue;
        }
        if (dep!.manifest_snapshot) {
          await this.docker.ensureNetwork(`minicloud-prev-${env.id.slice(0, 8)}`);
          for (const svc of await this.services.listByDeployment(dep!.id)) {
            if (svc.public_service && svc.host_port && svc.status === 'RUNNING') {
              const key = svc.service_name === this.firstServiceOf(dep!) ? env.route_slug : `${svc.service_name}.${env.route_slug}`;
              this.gateway.setRoute(key, { deploymentId: dep!.id, host: '127.0.0.1', port: svc.host_port });
            }
          }
        } else if (dep!.host_port) {
          this.gateway.setRoute(env.route_slug, { deploymentId: dep!.id, host: '127.0.0.1', port: dep!.host_port });
        }
      }
    }

    this.logger.info('reconciliation complete', { fixed, orphansRemoved });
    return { fixed, orphansRemoved };
  }

  /**
   * Bound any single image build. A hung docker build must never hold a queue
   * slot forever: on expiry the build signal aborts (tearing down the output
   * stream) and the pipeline fails with a clear reason, freeing the worker.
   */
  private withBuildTimeout(build: Promise<unknown>, abort: AbortController): Promise<unknown> {
    const seconds = this.config.buildTimeoutSeconds ?? 900;
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new EngineError(`docker build timed out after ${seconds}s`, 'build'));
      }, seconds * 1000);
    });
    return Promise.race([
      build.then(
        (v) => { clearTimeout(timer); return v; },
        (e) => { clearTimeout(timer); throw e; },
      ),
      expiry,
    ]);
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
    gatewayPort: Number(process.env.GATEWAY_PORT ?? 0),
    drainTimeoutSeconds: Number(process.env.GATEWAY_DRAIN_TIMEOUT_SECONDS ?? 10),
    buildTimeoutSeconds: Number(process.env.MINICLOUD_BUILD_TIMEOUT_SECONDS ?? 900),
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
