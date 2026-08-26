// v0.7 repositories: persistent deployment queue, build cache identity,
// preview environments and webhook delivery deduplication.
//
// Queue invariants enforced here (SQL-level, race-safe):
//  - exactly one job per deployment (UNIQUE deployment_id)
//  - claiming is a guarded UPDATE: two schedulers can never claim one job
//  - queue order is deterministic: (priority ASC, created_at ASC, id)
import type { Database } from './index.js';

export type JobTrigger = 'manual' | 'git' | 'preview';
export type JobStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'superseded';

/** Priority policy (lower = scheduled earlier). Documented in docs/architecture.md. */
export const JOB_PRIORITY = {
  manual: 10,
  rollback: 15,
  git: 50,
  preview: 90,
} as const;

export interface DeploymentJobRow {
  id: string;
  deployment_id: string;
  application_id: string;
  trigger: JobTrigger;
  status: JobStatus;
  priority: number;
  desired_ref: string | null;
  claim_token: string | null;
  claimed_at: Date | null;
  heartbeat_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  superseded_by_job_id: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const TERMINAL_JOB: readonly JobStatus[] = ['completed', 'failed', 'cancelled', 'superseded'];

export function jobIsTerminal(status: JobStatus): boolean {
  return TERMINAL_JOB.includes(status);
}

export class DeploymentJobRepository {
  constructor(private readonly db: Database) {}

  /** Create the scheduling record for a deployment. One per deployment. */
  async create(
    deploymentId: string,
    applicationId: string,
    opts: { trigger: JobTrigger; priority?: number; desiredRef?: string | null },
  ): Promise<DeploymentJobRow> {
    const res = await this.db.query<DeploymentJobRow>(
      `INSERT INTO deployment_jobs (deployment_id, application_id, trigger, priority, desired_ref)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [deploymentId, applicationId, opts.trigger, opts.priority ?? JOB_PRIORITY[opts.trigger], opts.desiredRef ?? null],
    );
    return res.rows[0]!;
  }

  async byId(id: string): Promise<DeploymentJobRow | null> {
    const res = await this.db.query<DeploymentJobRow>(
      'SELECT * FROM deployment_jobs WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? null;
  }

  async byDeployment(deploymentId: string): Promise<DeploymentJobRow | null> {
    const res = await this.db.query<DeploymentJobRow>(
      'SELECT * FROM deployment_jobs WHERE deployment_id = $1',
      [deploymentId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Deterministic queue snapshot: queued jobs in scheduling order.
   * position within an app is derivable from this ordering.
   */
  async listQueued(limit = 100): Promise<DeploymentJobRow[]> {
    const res = await this.db.query<DeploymentJobRow>(
      `SELECT * FROM deployment_jobs WHERE status = 'queued'
       ORDER BY priority ASC, created_at ASC LIMIT $1`,
      [limit],
    );
    return res.rows;
  }

  async listRunning(): Promise<DeploymentJobRow[]> {
    const res = await this.db.query<DeploymentJobRow>(
      `SELECT * FROM deployment_jobs WHERE status IN ('claimed','running')
       ORDER BY started_at ASC`,
    );
    return res.rows;
  }

  /**
   * Atomically claim the next eligible job:
   *  - global concurrency limit enforced by the caller (running count check)
   *  - per-application serialization: skip apps with a claimed/running job
   * SKIP LOCKED keeps concurrent schedulers honest; the subquery + guarded
   * UPDATE makes the claim atomic even across processes.
   */
  async claimNext(workerToken: string, maxPriorityExclusive?: number): Promise<DeploymentJobRow | null> {
    const res = await this.db.query<DeploymentJobRow>(
      `UPDATE deployment_jobs SET
         status = 'running',
         claim_token = $1,
         claimed_at = now(),
         heartbeat_at = now(),
         started_at = now(),
         updated_at = now()
       WHERE id = (
         SELECT j.id FROM deployment_jobs j
         WHERE j.status = 'queued'
           AND ($2::int IS NULL OR j.priority < $2)
          AND NOT EXISTS (
             SELECT 1 FROM deployment_jobs b
             WHERE b.application_id = j.application_id
               AND b.id <> j.id
               AND b.status IN ('claimed', 'running')
           )
         ORDER BY j.priority ASC, j.created_at ASC
         FOR UPDATE OF j SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [workerToken, maxPriorityExclusive ?? null],
    );
    return res.rows[0] ?? null;
  }

  /** Heartbeat for a running job (stale-claim detection after restart). */
  async heartbeat(id: string, token: string): Promise<void> {
    await this.db.query(
      `UPDATE deployment_jobs SET heartbeat_at = now(), updated_at = now()
       WHERE id = $1 AND claim_token = $2 AND status = 'running'`,
      [id, token],
    );
  }

  /**
   * Restart recovery: a job that was claimed but whose deployment never left
   * QUEUED goes straight back into the queue with its original priority.
   */
  async requeue(jobId: string): Promise<DeploymentJobRow | null> {
    const res = await this.db.query<DeploymentJobRow>(
      `UPDATE deployment_jobs SET status = 'queued', claim_token = NULL, claimed_at = NULL,
         heartbeat_at = NULL, started_at = NULL, updated_at = now()
       WHERE id = $1 AND status IN ('claimed','running') RETURNING *`,
      [jobId],
    );
    return res.rows[0] ?? null;
  }

  /** Mark a running job finished. Guarded on token so a stale worker cannot. */
  async complete(id: string, token: string): Promise<DeploymentJobRow | null> {
    const res = await this.db.query<DeploymentJobRow>(
      `UPDATE deployment_jobs SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE id = $1 AND claim_token = $2 AND status = 'running' RETURNING *`,
      [id, token],
    );
    return res.rows[0] ?? null;
  }

  async fail(id: string, token: string | null, reason: string): Promise<DeploymentJobRow | null> {
    const res = await this.db.query<DeploymentJobRow>(
      `UPDATE deployment_jobs SET status = 'failed', failure_reason = $3, completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'running' AND ($2::uuid IS NULL OR claim_token = $2) RETURNING *`,
      [id, token, reason.slice(0, 1000)],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Cancel a QUEUED job immediately. Returns the row or null when it already
   * left the queue (someone claimed it / it was cancelled concurrently).
   */
  async cancelQueued(id: string): Promise<DeploymentJobRow | null> {
    const res = await this.db.query<DeploymentJobRow>(
      `UPDATE deployment_jobs SET status = 'cancelled', cancelled_at = now(),
         failure_reason = COALESCE(failure_reason, 'cancelled while queued'), updated_at = now()
       WHERE id = $1 AND status = 'queued' RETURNING *`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  /** Cancel a running job's row (the engine drives resource cleanup). */
  async cancelRunning(id: string, token: string): Promise<DeploymentJobRow | null> {
    const res = await this.db.query<DeploymentJobRow>(
      `UPDATE deployment_jobs SET status = 'cancelled', cancelled_at = now(), updated_at = now()
       WHERE id = $1 AND claim_token = $2 AND status = 'running' RETURNING *`,
      [id, token],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Supersede every queued auto-deploy/preview job of an application with a
   * newer job. Manual jobs are never touched. Returns the superseded rows so
   * callers can emit events per affected deployment.
   */
  async supersedeQueuedForAppDetailed(
    applicationId: string,
    newJobId: string,
    triggers: JobTrigger[],
  ): Promise<Array<{ id: string; deployment_id: string }>> {
    const res = await this.db.query<{ id: string; deployment_id: string }>(
      `UPDATE deployment_jobs SET status = 'superseded',
         superseded_by_job_id = $2, completed_at = now(), updated_at = now()
       WHERE application_id = $1 AND status = 'queued'
         AND trigger = ANY($3::text[])
         AND id <> $2
       RETURNING id, deployment_id`,
      [applicationId, newJobId, triggers],
    );
    return res.rows;
  }

  /** Jobs waiting ahead of a given queued job (deterministic position). */
  async positionOf(jobId: string): Promise<number | null> {
    const row = await this.byId(jobId);
    if (!row || row.status !== 'queued') return null;
    const res = await this.db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM deployment_jobs
       WHERE status = 'queued'
         AND (priority < $2 OR (priority = $2 AND created_at < $3))`,
      [jobId, row.priority, row.created_at],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Stale claims: running jobs whose worker died mid-flight (old heartbeat). */
  async listStale(maxAgeSeconds: number): Promise<DeploymentJobRow[]> {
    const res = await this.db.query<DeploymentJobRow>(
      `SELECT * FROM deployment_jobs
       WHERE status IN ('claimed','running')
         AND COALESCE(heartbeat_at, started_at, claimed_at) < now() - ($1::text || ' seconds')::interval`,
      [String(maxAgeSeconds)],
    );
    return res.rows;
  }

  /**
   * Startup recovery for jobs that were claimed/running when the process died.
   * The caller has already reconciled deployments against Docker reality, so
   * the deployment row reflects the truth; derive the terminal job state from it.
   */
  async finalizeAfterRestart(jobId: string, outcome: 'completed' | 'failed' | 'cancelled', reason: string | null): Promise<void> {
    const col = outcome === 'cancelled' ? 'cancelled_at' : 'completed_at';
    await this.db.query(
      `UPDATE deployment_jobs SET status = $2, failure_reason = $3, ${col} = now(), updated_at = now()
       WHERE id = $1 AND status IN ('claimed','running')`,
      [jobId, outcome, reason?.slice(0, 1000) ?? null],
    );
  }
}

export interface BuildArtifactRow {
  id: string;
  application_id: string;
  commit_sha: string;
  service_name: string | null;
  fingerprint: string;
  image_tag: string;
  created_at: Date;
  last_used_at: Date;
  use_count: number;
}

/** Exact-image reuse registry keyed by (app, service, fingerprint). */
export class BuildArtifactRepository {
  constructor(private readonly db: Database) {}

  async find(
    applicationId: string,
    fingerprint: string,
    serviceName: string | null,
  ): Promise<BuildArtifactRow | null> {
    const res = await this.db.query<BuildArtifactRow>(
      `SELECT * FROM build_artifacts
       WHERE application_id = $1 AND fingerprint = $2 AND service_name IS NOT DISTINCT FROM $3`,
      [applicationId, fingerprint, serviceName],
    );
    return res.rows[0] ?? null;
  }

  async record(row: {
    applicationId: string;
    commitSha: string;
    serviceName: string | null;
    fingerprint: string;
    imageTag: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO build_artifacts (application_id, commit_sha, service_name, fingerprint, image_tag)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (application_id, service_name, fingerprint)
       DO UPDATE SET image_tag = EXCLUDED.image_tag, commit_sha = EXCLUDED.commit_sha,
                     last_used_at = now()`,
      [row.applicationId, row.commitSha, row.serviceName, row.fingerprint, row.imageTag],
    );
  }

  async markUsed(id: string): Promise<void> {
    await this.db.query(
      'UPDATE build_artifacts SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1',
      [id],
    );
  }

  /** All artifact tags referenced (prune must keep these images). */
  async allTags(): Promise<string[]> {
    const res = await this.db.query<{ image_tag: string }>('SELECT image_tag FROM build_artifacts');
    return res.rows.map((r) => r.image_tag);
  }
}

export interface PreviewEnvironmentRow {
  id: string;
  application_id: string;
  pr_number: number;
  head_sha: string | null;
  branch: string | null;
  route_slug: string;
  status: 'creating' | 'active' | 'closed';
  active_preview_deployment_id: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

export class PreviewRepository {
  constructor(private readonly db: Database) {}

  async byAppAndPr(applicationId: string, prNumber: number): Promise<PreviewEnvironmentRow | null> {
    const res = await this.db.query<PreviewEnvironmentRow>(
      'SELECT * FROM preview_environments WHERE application_id = $1 AND pr_number = $2',
      [applicationId, prNumber],
    );
    return res.rows[0] ?? null;
  }

  async byId(id: string): Promise<PreviewEnvironmentRow | null> {
    const res = await this.db.query<PreviewEnvironmentRow>(
      'SELECT * FROM preview_environments WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? null;
  }

  async listByApp(applicationId: string, includeClosed = true): Promise<PreviewEnvironmentRow[]> {
    const sql = includeClosed
      ? 'SELECT * FROM preview_environments WHERE application_id = $1 ORDER BY pr_number ASC'
      : "SELECT * FROM preview_environments WHERE application_id = $1 AND status <> 'closed' ORDER BY pr_number ASC";
    const res = await this.db.query<PreviewEnvironmentRow>(sql, [applicationId]);
    return res.rows;
  }

  async listOpen(): Promise<PreviewEnvironmentRow[]> {
    const res = await this.db.query<PreviewEnvironmentRow>(
      "SELECT * FROM preview_environments WHERE status <> 'closed'",
    );
    return res.rows;
  }
  async upsert(
    applicationId: string,
    prNumber: number,
    fields: { headSha: string | null; branch: string | null; routeSlug: string },
  ): Promise<PreviewEnvironmentRow> {
    const res = await this.db.query<PreviewEnvironmentRow>(
      `INSERT INTO preview_environments (application_id, pr_number, head_sha, branch, route_slug, status)
       VALUES ($1, $2, $3, $4, $5, 'creating')
       ON CONFLICT (application_id, pr_number) DO UPDATE
         SET head_sha = EXCLUDED.head_sha, branch = EXCLUDED.branch,
             status = CASE WHEN preview_environments.status = 'closed' THEN 'creating' ELSE preview_environments.status END,
             closed_at = NULL, updated_at = now()
       RETURNING *`,
      [applicationId, prNumber, fields.headSha, fields.branch, fields.routeSlug],
    );
    return res.rows[0]!;
  }

  async setHead(id: string, sha: string | null, branch: string | null): Promise<void> {
    await this.db.query(
      'UPDATE preview_environments SET head_sha = $2, branch = $3, updated_at = now() WHERE id = $1',
      [id, sha, branch],
    );
  }

  /** Point the preview at its newly healthy deployment (guarded swap). */
  async setActiveDeployment(id: string, deploymentId: string, expectedOld: string | null): Promise<boolean> {
    const res = await this.db.query<PreviewEnvironmentRow>(
      `UPDATE preview_environments SET active_preview_deployment_id = $2, status = 'active', updated_at = now()
       WHERE id = $1 AND active_preview_deployment_id IS NOT DISTINCT FROM $3
       RETURNING *`,
      [id, deploymentId, expectedOld],
    );
    return res.rows.length > 0;
  }

  /** Clear the active pointer when it references the given deployment. */
  async clearActiveDeployment(id: string, deploymentId: string): Promise<void> {
    await this.db.query(
      'UPDATE preview_environments SET active_preview_deployment_id = NULL, updated_at = now() WHERE id = $1 AND active_preview_deployment_id = $2',
      [id, deploymentId],
    );
  }

  async setStatus(id: string, status: PreviewEnvironmentRow['status']): Promise<void> {
    await this.db.query(
      `UPDATE preview_environments SET status = $2,
         closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE closed_at END,
         updated_at = now()
       WHERE id = $1`,
      [id, status],
    );
  }

  /** Close only when pointing at the given deployment (guards stale closes). */
  async closeIfActive(id: string, deploymentId: string): Promise<void> {
    await this.db.query(
      `UPDATE preview_environments SET active_preview_deployment_id = NULL,
         status = 'closed', closed_at = now(), updated_at = now()
       WHERE id = $1 AND active_preview_deployment_id IS NOT DISTINCT FROM $2`,
      [id, deploymentId],
    );
  }
}

export class WebhookDeliveryRepository {
  constructor(private readonly db: Database) {}

  /** Insert-once dedup. Returns false when the delivery was seen before. */
  async beginOnce(id: string, eventType: string | null): Promise<boolean> {
    const res = await this.db.query(
      'INSERT INTO webhook_deliveries (id, event_type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [id, eventType],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
