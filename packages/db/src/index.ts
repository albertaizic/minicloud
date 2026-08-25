// Database access layer: pool management, migrations, repositories.
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>;
}

export class Database {
  constructor(public readonly pool: pg.Pool) {}

  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(text, values as unknown[]);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        query: (t: string, v?: unknown[]) => client.query({ text: t, values: v ?? [] }),
      });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function databaseFromEnv(): Database {
  const url = process.env.DATABASE_URL ?? 'postgres://minicloud:minicloud@localhost:5433/minicloud';
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return new Database(pool);
}

export function databaseFromPool(pool: pg.Pool): Database {
  return new Database(pool);
}

/** Apply pending SQL migrations from the migrations directory, in filename order. */
export async function runMigrations(db: Database): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const dir = path.resolve(__dirname, '../migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    const already = await db.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
    if (already.rowCount && already.rowCount > 0) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await db.tx(async (q) => {
      await q.query(sql);
      await q.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}

export interface ApplicationRow {
  id: string;
  name: string;
  repository_url: string;
  created_at: Date;
  memory_limit_mb?: number | null;
  cpu_limit?: number | null;
  restart_policy: string;
  max_restart_attempts: number;
  route_slug: string | null;
  active_deployment_id: string | null;
}

export interface DeploymentRow {
  id: string;
  application_id: string;
  ref: string | null;
  commit_sha: string | null;
  status: string;
  image_tag: string | null;
  container_id: string | null;
  container_name: string | null;
  host_port: number | null;
  container_port: number | null;
  health_path: string | null;
  failure_reason: string | null;
  exit_code: number | null;
  restart_count: number;
  config_snapshot: Record<string, unknown> | null;
  rollback_of_deployment_id: string | null;
  manifest_snapshot: Record<string, unknown> | null;
  auto_restart_count: number;
  next_auto_restart_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  stopped_at: Date | null;
}

export class AppRepository {
  constructor(private readonly db: Database) {}

  async create(name: string, repositoryUrl: string): Promise<ApplicationRow> {
    const res = await this.db.query<ApplicationRow>(
      'INSERT INTO applications (name, repository_url, route_slug) VALUES ($1, $2, lower($1)) RETURNING *',
      [name, repositoryUrl],
    );
    return res.rows[0]!;
  }


  async list(): Promise<ApplicationRow[]> {
    const res = await this.db.query<ApplicationRow>('SELECT * FROM applications ORDER BY created_at DESC');
    return res.rows;
  }

  /** Gateway slug lookup (slugs are lowercase; names may not be). */
  async bySlug(slug: string): Promise<ApplicationRow | null> {
    const res = await this.db.query<ApplicationRow>(
      'SELECT * FROM applications WHERE route_slug = $1',
      [slug],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Point the application's traffic at a deployment. The swap is guarded on
   * the previously-active deployment: when another operation already switched
   * traffic (supersede), the update matches nothing and null is returned —
   * the caller must retire itself instead of stealing traffic.
   * expectedOld=null means "become active only when nothing is active".
   */
  async setActiveDeployment(
    applicationId: string,
    deploymentId: string,
    expectedOld: string | null,
  ): Promise<ApplicationRow | null> {
    const res = await this.db.query<ApplicationRow>(
      `UPDATE applications
       SET active_deployment_id = $2
       WHERE id = $1 AND active_deployment_id IS NOT DISTINCT FROM $3
       RETURNING *`,
      [applicationId, deploymentId, expectedOld],
    );
    return res.rows[0] ?? null;
  }

  /** Clear the active pointer when it references the given deployment. */
  async clearActiveDeployment(applicationId: string, deploymentId: string): Promise<void> {
    await this.db.query(
      'UPDATE applications SET active_deployment_id = NULL WHERE id = $1 AND active_deployment_id = $2',
      [applicationId, deploymentId],
    );
  }

  /** Update only the restart-policy columns; limits are managed separately. */
  async setRestartPolicy(
    applicationId: string,
    policy: string,
    maxRestartAttempts: number,
  ): Promise<void> {
    await this.db.query(
      'UPDATE applications SET restart_policy = $2, max_restart_attempts = $3 WHERE id = $1',
      [applicationId, policy, maxRestartAttempts],
    );
  }
  async byId(id: string): Promise<ApplicationRow | null> {
    const res = await this.db.query<ApplicationRow>('SELECT * FROM applications WHERE id = $1', [id]);
    return res.rows[0] ?? null;
  }

  async byName(name: string): Promise<ApplicationRow | null> {
    const res = await this.db.query<ApplicationRow>('SELECT * FROM applications WHERE name = $1', [name]);
    return res.rows[0] ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM applications WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}

export class DeploymentRepository {
  constructor(private readonly db: Database) {}

  async create(
    applicationId: string,
    opts: {
      ref?: string;
      healthPath?: string;
      containerPort?: number;
      commitSha?: string | null;
      rollbackOf?: string | null;
    } = {},
  ): Promise<DeploymentRow> {
    const res = await this.db.query<DeploymentRow>(
      `INSERT INTO deployments (application_id, ref, health_path, container_port, commit_sha, rollback_of_deployment_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED') RETURNING *`,
      [
        applicationId,
        opts.ref ?? 'HEAD',
        opts.healthPath ?? null,
        opts.containerPort ?? null,
        opts.commitSha ?? null,
        opts.rollbackOf ?? null,
      ],
    );
    return res.rows[0]!;
  }

  async byId(id: string): Promise<DeploymentRow | null> {
    const res = await this.db.query<DeploymentRow>('SELECT * FROM deployments WHERE id = $1', [id]);
    return res.rows[0] ?? null;
  }

  async listByApp(applicationId: string): Promise<DeploymentRow[]> {
    const res = await this.db.query<DeploymentRow>(
      'SELECT * FROM deployments WHERE application_id = $1 ORDER BY created_at DESC',
      [applicationId],
    );
    return res.rows;
  }

  async listAll(limit = 200): Promise<DeploymentRow[]> {
    const res = await this.db.query<DeploymentRow>(
      'SELECT * FROM deployments ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return res.rows;
  }

  /**
   * Guarded status update: only applies if the current status allows the
   * transition. Returns the updated row or null if the transition was rejected.
   * The allowed-transition matrix is enforced here in SQL so concurrent workers
   * can never drive a deployment into an impossible state.
   */
  async transitionStatus(
    id: string,
    from: string[],
    to: string,
    extra?: Partial<Record<'failure_reason' | 'exit_code', unknown>>,
    timestamps?: { startedAt?: Date | null; stoppedAt?: Date | null },
  ): Promise<DeploymentRow | null> {
    const values: unknown[] = [id, from, to];
    const sets: string[] = ['status = $3'];
    const add = (col: string, val: unknown) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };
    if (extra?.failure_reason !== undefined) add('failure_reason', extra.failure_reason);
    if (extra?.exit_code !== undefined) add('exit_code', extra.exit_code);
    if (timestamps?.startedAt !== undefined) add('started_at', timestamps.startedAt);
    if (timestamps?.stoppedAt !== undefined) add('stopped_at', timestamps.stoppedAt);
    const res = await this.db.query<DeploymentRow>(
      `UPDATE deployments SET ${sets.join(', ')}
       WHERE id = $1 AND status = ANY($2::text[])
       RETURNING *`,
      values,
    );
    return res.rows[0] ?? null;
  }

  /** Optimistically claim a deployment for an exclusive operation (stop/restart). */
  async claimForOperation(id: string, expectedStatuses: string[]): Promise<DeploymentRow | null> {
    const res = await this.db.query<DeploymentRow>(
      `UPDATE deployments SET stopped_at = now()
       WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
      [id, expectedStatuses],
    );
    return res.rows[0] ?? null;
  }

  async updateFields(
    id: string,
    fields: Partial<{
      commit_sha: string | null;
      image_tag: string | null;
      container_id: string | null;
      container_name: string | null;
      host_port: number | null;
      container_port: number | null;
      health_path: string | null;

      failure_reason: string | null;
      exit_code: number | null;
      restart_count: number;
      auto_restart_count: number;
      next_auto_restart_at: Date | null;
      config_snapshot: Record<string, unknown> | null;
      manifest_snapshot: Record<string, unknown> | null;
      started_at: Date | null;
      stopped_at: Date | null;
    }>,
  ): Promise<void> {
    const keys = Object.keys(fields).filter((k) => fields[k as keyof typeof fields] !== undefined);
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const values = keys.map((k) => fields[k as keyof typeof fields]);
    await this.db.query(`UPDATE deployments SET ${sets.join(', ')} WHERE id = $1`, [id, ...values]);
  }

  /**
   * Atomically claim a due automatic restart: increments the attempt counter
   * and clears the marker only if the deployment is still FAILED with a due
   * marker. Returns the updated row, or null when a concurrent operation
   * (manual stop/restart/delete) won the race.
   */
  async claimDueAutoRestart(id: string): Promise<DeploymentRow | null> {
    const res = await this.db.query<DeploymentRow>(
      `UPDATE deployments
       SET auto_restart_count = auto_restart_count + 1, next_auto_restart_at = NULL
       WHERE id = $1 AND status = 'FAILED'
         AND next_auto_restart_at IS NOT NULL AND next_auto_restart_at <= now()
       RETURNING *`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async latestForApp(applicationId: string): Promise<DeploymentRow | null> {
    const res = await this.db.query<DeploymentRow>(
      'SELECT * FROM deployments WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1',
      [applicationId],
    );
    return res.rows[0] ?? null;
  }
}

export interface AppEnvRow {
  id: string;
  application_id: string;
  key: string;
  encrypted_value: string | null;
  plain_value: string | null;
  is_secret: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Per-application environment variables and secrets.
 *
 * Secrets are written and read only through this repository, which requires a
 * master key; plaintext secret values never leave `resolveRuntimeEnv` /
 * `setSecret`. Listing methods deliberately do not return secret values.
 */
export class AppConfigRepository {
  constructor(private readonly db: Database) {}

  // ---- plain variables -----------------------------------------------------

  async setVar(applicationId: string, key: string, value: string): Promise<AppEnvRow> {
    const res = await this.db.query<AppEnvRow>(
      `INSERT INTO app_env (application_id, key, plain_value, is_secret)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (application_id, key)
       DO UPDATE SET plain_value = EXCLUDED.plain_value,
                    encrypted_value = NULL, is_secret = false, updated_at = now()
       RETURNING *`,
      [applicationId, key, value],
    );
    return res.rows[0]!;
  }

  /** Delete by key. Returns 'var' | 'secret' | null (not found). */
  async deleteKey(applicationId: string, key: string): Promise<'var' | 'secret' | null> {
    const existing = await this.byKey(applicationId, key);
    if (!existing) return null;
    const kind = existing.is_secret ? ('secret' as const) : ('var' as const);
    await this.db.query('DELETE FROM app_env WHERE application_id = $1 AND key = $2', [
      applicationId,
      key,
    ]);
    return kind;
  }

  async listVars(applicationId: string): Promise<{ key: string; value: string; updatedAt: Date }[]> {
    const res = await this.db.query<AppEnvRow>(
      `SELECT * FROM app_env WHERE application_id = $1 AND is_secret = false ORDER BY key`,
      [applicationId],
    );
    return res.rows.map((r) => ({ key: r.key, value: r.plain_value ?? '', updatedAt: r.updated_at }));
  }

  // ---- secrets (encrypted at rest) ------------------------------------------

  async setSecret(applicationId: string, key: string, ciphertext: string): Promise<void> {
    await this.db.query(
      `INSERT INTO app_env (application_id, key, encrypted_value, is_secret)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (application_id, key)
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
                    plain_value = NULL, is_secret = true, updated_at = now()`,
      [applicationId, key, ciphertext],
    );
  }

  /** Secret keys only — never values. */
  async listSecretKeys(applicationId: string): Promise<{ key: string; updatedAt: Date }[]> {
    const res = await this.db.query<AppEnvRow>(
      `SELECT * FROM app_env WHERE application_id = $1 AND is_secret = true ORDER BY key`,
      [applicationId],
    );
    return res.rows.map((r) => ({ key: r.key, updatedAt: r.updated_at }));
  }

  async byKey(applicationId: string, key: string): Promise<AppEnvRow | null> {
    const res = await this.db.query<AppEnvRow>(
      'SELECT * FROM app_env WHERE application_id = $1 AND key = $2',
      [applicationId, key],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Resolve the full runtime environment for a deployment start:
   * plain vars decrypted-free plus secrets decrypted via the master key.
   * This is the ONLY path that turns stored secrets into plaintext values.
   */
  async resolveRuntimeEnv(
    applicationId: string,
    masterKey: Buffer | null,
    decrypt: (stored: string, key: Buffer | null) => string,
  ): Promise<{ env: Record<string, string>; secretKeys: string[] }> {
    const rows = await this.db.query<AppEnvRow>(
      'SELECT * FROM app_env WHERE application_id = $1 ORDER BY key',
      [applicationId],
    );
    const env: Record<string, string> = {};
    const secretKeys: string[] = [];
    for (const r of rows.rows) {
      if (r.is_secret) {
        if (!r.encrypted_value) continue;
        env[r.key] = decrypt(r.encrypted_value, masterKey);
        secretKeys.push(r.key);
      } else {
        env[r.key] = r.plain_value ?? '';
      }
    }
    return { env, secretKeys };
  }

  // ---- resource limits -------------------------------------------------------

  async getLimits(
    applicationId: string,
  ): Promise<{ memoryLimitMb: number | null; cpuLimit: number | null }> {
    const res = await this.db.query<{ memory_limit_mb: number | null; cpu_limit: number | null }>(
      'SELECT memory_limit_mb, cpu_limit FROM applications WHERE id = $1',
      [applicationId],
    );
    const row = res.rows[0];
    return { memoryLimitMb: row?.memory_limit_mb ?? null, cpuLimit: row?.cpu_limit ?? null };
  }

  async setLimits(
    applicationId: string,
    limits: { memoryLimitMb?: number; cpuLimit?: number },
  ): Promise<void> {
    await this.db.query(
      `UPDATE applications SET
         memory_limit_mb = COALESCE($2, memory_limit_mb),
         cpu_limit = COALESCE($3, cpu_limit)
       WHERE id = $1`,
      [applicationId, limits.memoryLimitMb ?? null, limits.cpuLimit ?? null],
    );
  }

  async clearLimits(applicationId: string): Promise<void> {
    await this.db.query(
      'UPDATE applications SET memory_limit_mb = NULL, cpu_limit = NULL WHERE id = $1',
      [applicationId],
    );
  }
}

export interface DeploymentEventRow {
  id: string;
  deployment_id: string;
  event_type: string;
  message: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

/**
 * Persistent, ordered lifecycle event history for deployments. Ordering is the
 * monotonic BIGINT `id` (see migration 003) — never timestamps. Metadata is for
 * structural context only (attempt numbers, image tags, exit codes); secret
 * values must never be passed here.
 */
export class DeploymentEventRepository {
  constructor(private readonly db: Database) {}

  async append(
    deploymentId: string,
    eventType: string,
    message = '',
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO deployment_events (deployment_id, event_type, message, metadata)
       VALUES ($1, $2, $3, $4)`,
      [deploymentId, eventType, message, metadata ?? null],
    );
  }

  async appendMany(
    deploymentId: string,
    events: Array<{ type: string; message?: string; metadata?: Record<string, unknown> }>,
  ): Promise<void> {
    if (events.length === 0) return;
    await this.db.tx(async (q) => {
      for (const e of events) {
        await q.query(
          `INSERT INTO deployment_events (deployment_id, event_type, message, metadata)
           VALUES ($1, $2, $3, $4)`,
          [deploymentId, e.type, e.message ?? '', e.metadata ?? null],
        );
      }
    });
  }

  /** Chronological history for one deployment (oldest first). */
  async listByDeployment(deploymentId: string, limit = 500): Promise<DeploymentEventRow[]> {
    const res = await this.db.query<DeploymentEventRow>(
      `SELECT * FROM deployment_events WHERE deployment_id = $1 ORDER BY id ASC LIMIT $2`,
      [deploymentId, limit],
    );
    return res.rows;
  }

  /** Count of events per deployment — used by retention checks in tests. */
  async countForDeployment(deploymentId: string): Promise<number> {
    const res = await this.db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM deployment_events WHERE deployment_id = $1',
      [deploymentId],
    );
    return Number(res.rows[0]?.count ?? 0);
  }
}

export * from './service-repos.js';
