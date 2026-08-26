// DeploymentQueue (v0.7): persistent, restart-safe scheduling of deployment
// work. The queue owns WHEN a deployment pipeline runs; the engine owns HOW.
//
// Design invariants:
//  - All queue state lives in PostgreSQL (deployment_jobs). An API restart
//    loses nothing: queued jobs are picked up by the next scheduler, and
//    interrupted claims are recovered from reconciled deployment truth.
//  - Ordering is deterministic: (priority ASC, created_at ASC).
//    Priority policy: manual 10 < rollback 15 < git auto-deploy 50 < preview 90.
//  - Global concurrency bound: MINICLOUD_MAX_CONCURRENT_BUILDS simultaneous
//    running pipelines. Per-application serialization: one app runs at most
//    one job at a time (stale revisions can never race into traffic).
//  - Superseding: a newly enqueued git/preview job supersedes still-queued
//    jobs of the same trigger for the same application — newest desired state
//    wins without wasting builds. Manual jobs are never auto-superseded.
//  - Cancellation: QUEUED cancels instantly; RUNNING pipelines unwind via the
//    engine's abort path; RUNNING deployments (already serving) are refused —
//    stop/rollback are different operations.
import { randomUUID } from 'node:crypto';
import {
  AppRepository,
  Database,
  DeploymentEventRepository,
  DeploymentJobRepository,
  DeploymentRepository,
  JOB_PRIORITY,
  type DeploymentJobRow,
  type JobTrigger,
} from '@minicloud/db';
import type { DeploymentEngine, EngineLogger } from './engine.js';

export interface QueueConfig {
  maxConcurrent: number;
  /** Scheduler poll interval. A freed slot also triggers an immediate tick. */
  tickIntervalMs: number;
  heartbeatIntervalMs: number;
}

export function defaultQueueConfigFromEnv(): QueueConfig {
  const raw = Number(process.env.MINICLOUD_MAX_CONCURRENT_BUILDS ?? 2);
  return {
    maxConcurrent: Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1,
    tickIntervalMs: Number(process.env.MINICLOUD_QUEUE_TICK_MS ?? 1000),
    heartbeatIntervalMs: Number(process.env.MINICLOUD_QUEUE_HEARTBEAT_MS ?? 5000),
  };
}

export interface EnqueueOptions {
  trigger: JobTrigger;
  priority?: number;
  desiredRef?: string | null;
  commitSha?: string | null;
  healthPath?: string | null;
  containerPort?: number | null;
  previewEnvironmentId?: string | null;
  gatewayRouteKey?: string | null;
}

export interface QueueSnapshotJob {
  jobId: string;
  deploymentId: string;
  applicationId: string;
  status: string;
  trigger: string;
  priority: number;
  position: number | null;
  createdAt: string;
}

export class DeploymentQueue {
  private readonly jobs: DeploymentJobRepository;
  private readonly deployments: DeploymentRepository;
  private readonly apps: AppRepository;
  private readonly events: DeploymentEventRepository;
  private readonly workerToken = randomUUID();
  /** Locally executing deployments -> heartbeat timers. */
  private readonly local = new Map<string, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    db: Database,
    private readonly engine: DeploymentEngine,
    private readonly logger: EngineLogger,
    private readonly config: QueueConfig,
  ) {
    this.jobs = new DeploymentJobRepository(db);
    this.deployments = new DeploymentRepository(db);
    this.apps = new AppRepository(db);
    this.events = new DeploymentEventRepository(db);
  }

  // ---- enqueue ----------------------------------------------------------------

  /**
   * Create a deployment + its durable job and apply superseding rules.
   * Returns the ids plus how many obsolete queued jobs were superseded.
   */
  async createAndEnqueue(applicationId: string, opts: EnqueueOptions): Promise<{ deploymentId: string; jobId: string; superseded: number }> {
    const app = await this.apps.byId(applicationId);
    if (!app) throw new Error('Application not found');
    const dep = await this.deployments.create(applicationId, {
      ref: opts.desiredRef ?? 'HEAD',
      commitSha: opts.commitSha ?? null,
      healthPath: opts.healthPath ?? undefined,
      containerPort: opts.containerPort ?? undefined,
      previewEnvironmentId: opts.previewEnvironmentId ?? null,
      gatewayRouteKey: opts.gatewayRouteKey ?? null,
    });
    const { jobId, superseded } = await this.enqueueDeployment(dep.id, applicationId, opts);
    return { deploymentId: dep.id, jobId, superseded };
  }

  /**
   * Queue an EXISTING deployment row (rollback path). Same superseding rules.
   */
  async enqueueDeployment(
    deploymentId: string,
    applicationId: string,
    opts: Pick<EnqueueOptions, 'trigger' | 'priority' | 'desiredRef'>,
  ): Promise<{ jobId: string; superseded: number }> {
    const job = await this.jobs.create(deploymentId, applicationId, opts);
    let superseded = 0;
    // Newest-wins for automatic triggers; manual work always runs.
    if (opts.trigger === 'git' || opts.trigger === 'preview') {
      const rows = await this.jobs.supersedeQueuedForAppDetailed(applicationId, job.id, [opts.trigger]);
      superseded = rows.length;
      for (const r of rows) {
        // The superseded job's deployment must not linger in QUEUED: park it
        // in CANCELLED so every view agrees it will never run.
        await this.deployments.transitionStatus(
          r.deployment_id,
          ['QUEUED'],
          'CANCELLED',
          { failure_reason: 'superseded by a newer automatic deployment' },
          { stoppedAt: new Date() },
        );
        await this.safeAppend(r.deployment_id, 'queue.superseded', `superseded by ${job.id.slice(0, 8)}`, {
          supersededByJobId: job.id,
          trigger: opts.trigger,
        });
      }
    }
    // Snappy claiming in production; tests that never start() the scheduler
    // keep full determinism over when work is claimed.
    if (this.timer) this.kick();
    return { jobId: job.id, superseded };
  }

  // ---- scheduler ---------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), this.config.tickIntervalMs);
    this.timer.unref();
    this.kick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const t of this.local.values()) clearInterval(t);
    this.local.clear();
  }

  /** Trigger a scheduler pass (idempotent, non-reentrant). */
  kick(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (;;) {
        const running = await this.jobs.listRunning();
        if (running.length >= this.config.maxConcurrent) break;
        // Per-app serialization lives inside the claim query.
        const job = await this.jobs.claimNext(this.workerToken);
        if (!job) break;
        await this.safeAppend(job.deployment_id, 'queue.claimed', `slot ${running.length + 1}/${this.config.maxConcurrent}`, {
          jobId: job.id,
          priority: job.priority,
          trigger: job.trigger,
        });
        void this.execute(job);
      }
    } catch (err) {
      this.logger.error('queue tick failed', { error: String(err) });
    } finally {
      this.ticking = false;
    }
  }

  /** Run a claimed job to completion of its underlying deployment pipeline. */
  private async execute(job: DeploymentJobRow): Promise<void> {
    const token = job.claim_token!;
    const heartbeat = setInterval(() => {
      void this.jobs.heartbeat(job.id, token).catch(() => {});
    }, this.config.heartbeatIntervalMs);
    heartbeat.unref?.();
    this.local.set(job.deployment_id, heartbeat);
    try {
      await this.engine.runDeployment(job.deployment_id);
      const dep = await this.deployments.byId(job.deployment_id);
      switch (dep?.status) {
        case 'RUNNING': {
          await this.jobs.complete(job.id, token);
          // v0.6 gap fix: record the deployed SHA so auto-deploy stops
          // re-triggering for an already-built revision.
          if (job.trigger === 'git' && dep?.commit_sha) {
            await this.apps.setDeployedSha(job.application_id, dep.commit_sha).catch(() => {});
          }
          break;
        }
        case 'CANCELLED':
        case undefined:
          // Terminal state owned by the canceller / deleted row.
          break;
        case 'STOPPED':
          await this.jobs.fail(job.id, token, dep.failure_reason ?? 'stopped before completion');
          break;
        default:
          await this.jobs.fail(job.id, token, dep?.failure_reason ?? `finished in status ${dep?.status}`);
      }
    } catch (err) {
      const dep = await this.deployments.byId(job.deployment_id).catch(() => null);
      if (dep?.status !== 'RUNNING') {
        await this.jobs.fail(job.id, token, String(err).slice(0, 900)).catch(() => {});
      } else {
        await this.jobs.complete(job.id, token).catch(() => {});
      }
    } finally {
      clearInterval(heartbeat);
      this.local.delete(job.deployment_id);
      // A slot just freed: schedule the next eligible job immediately.
      setImmediate(() => this.kick());
    }
  }

  // ---- cancellation -------------------------------------------------------------

  /**
   * Cancel whichever job belongs to a deployment. Queued jobs die instantly;
   * running ones route through the engine's abort+cleanup path.
   */
  async cancelByDeployment(deploymentId: string, reason: string): Promise<'cancelled' | 'already_terminal'> {
    const job = await this.jobs.byDeployment(deploymentId);
    if (!job || ['completed', 'failed', 'cancelled', 'superseded'].includes(job.status)) {
      return 'already_terminal';
    }
    if (job.status === 'queued') {
      const cancelled = await this.jobs.cancelQueued(job.id);
      if (cancelled) {
        await this.engine.cancelPipeline(deploymentId, reason);
        return 'cancelled';
      }
      // Lost the race against the scheduler: fall through to the running path.
    }
    const result = await this.engine.cancelPipeline(deploymentId, reason);
    // Align the job row with reality (running -> cancelled); guarded on our
    // claim so a completed/failed write from execute() wins instead.
    await this.jobs.cancelRunning(job.id, job.claim_token ?? '').catch(() => {});
    return result;
  }

  // ---- restart recovery -----------------------------------------------------------

  /**
   * Called once at startup AFTER engine.reconcile(): deployment rows now agree
   * with Docker reality, so each orphaned claim finalizes from that truth.
   */
  async recoverAfterRestart(): Promise<{ requeued: number; finalized: number }> {
    let requeued = 0;
    let finalized = 0;
    const active = await this.jobs.listRunning();
    for (const job of active) {
      if (job.claim_token === this.workerToken) continue; // ours, somehow live
      const dep = await this.deployments.byId(job.deployment_id).catch(() => null);
      if (!dep) {
        await this.jobs.finalizeAfterRestart(job.id, 'failed', 'deployment row missing after restart');
        finalized++;
        continue;
      }
      switch (dep.status) {
        case 'QUEUED': {
          // Never actually began: put it back where it was.
          const back = await this.jobs.requeue(job.id);
          if (back) {
            requeued++;
            await this.safeAppend(dep.id, 'queue.requeued', 'recovered after API restart');
          }
          break;
        }
        case 'RUNNING':
          await this.jobs.finalizeAfterRestart(job.id, 'completed', null);
          finalized++;
          break;
        case 'CANCELLED':
        case 'STOPPED':
          await this.jobs.finalizeAfterRestart(job.id, 'cancelled', dep.failure_reason ?? 'cancelled during restart');
          finalized++;
          break;
        default:
          await this.jobs.finalizeAfterRestart(job.id, 'failed', dep.failure_reason ?? 'interrupted by API restart');
          finalized++;
      }
    }
    if (active.length > 0) {
      this.logger.info('queue recovery complete', { recovered: active.length, requeued, finalized });
    }
    return { requeued, finalized };
  }

  // ---- observability ---------------------------------------------------------------

  /** Deterministic queue view for API/UI: running first, then ordered queue. */
  async snapshot(applicationId?: string): Promise<{ limit: number; running: QueueSnapshotJob[]; queued: QueueSnapshotJob[] }> {
    const filter = (rows: DeploymentJobRow[]) =>
      applicationId ? rows.filter((r) => r.application_id === applicationId) : rows;
    const [running, queued] = await Promise.all([this.jobs.listRunning(), this.jobs.listQueued()]);
    return {
      limit: this.config.maxConcurrent,
      running: filter(running).map((j) => ({
        jobId: j.id,
        deploymentId: j.deployment_id,
        applicationId: j.application_id,
        status: j.status,
        trigger: j.trigger,
        priority: j.priority,
        position: null,
        createdAt: j.created_at.toISOString(),
      })),
      queued: filter(queued).map((j, i) => ({
        jobId: j.id,
        deploymentId: j.deployment_id,
        applicationId: j.application_id,
        status: j.status,
        trigger: j.trigger,
        priority: j.priority,
        position: i + 1,
        createdAt: j.created_at.toISOString(),
      })),
    };
  }

  get maxConcurrent(): number {
    return this.config.maxConcurrent;
  }

  /** Event persistence must never break queue mechanics. */
  private async safeAppend(deploymentId: string, type: string, message: string, metadata?: Record<string, unknown>): Promise<void> {
    try {
      await this.events.append(deploymentId, type, message, metadata);
    } catch (err) {
      this.logger.warn('queue event append failed', { deploymentId, type, error: String(err) });
    }
  }
}
