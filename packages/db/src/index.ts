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
  const url = process.env.DATABASE_URL ?? 'postgres://minicloud:minicloud@localhost:5432/minicloud';
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
  const dir = path.resolve(__dirname, '../../migrations');
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
  created_at: Date;
  started_at: Date | null;
  stopped_at: Date | null;
}

export class AppRepository {
  constructor(private readonly db: Database) {}

  async create(name: string, repositoryUrl: string): Promise<ApplicationRow> {
    const res = await this.db.query<ApplicationRow>(
      'INSERT INTO applications (name, repository_url) VALUES ($1, $2) RETURNING *',
      [name, repositoryUrl],
    );
    return res.rows[0]!;
  }

  async list(): Promise<ApplicationRow[]> {
    const res = await this.db.query<ApplicationRow>('SELECT * FROM applications ORDER BY created_at DESC');
    return res.rows;
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

  async create(applicationId: string, opts: { ref?: string; healthPath?: string; containerPort?: number }): Promise<DeploymentRow> {
    const res = await this.db.query<DeploymentRow>(
      `INSERT INTO deployments (application_id, ref, health_path, container_port, status)
       VALUES ($1, $2, $3, $4, 'QUEUED') RETURNING *`,
      [applicationId, opts.ref ?? 'HEAD', opts.healthPath ?? null, opts.containerPort ?? null],
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

  async latestForApp(applicationId: string): Promise<DeploymentRow | null> {
    const res = await this.db.query<DeploymentRow>(
      'SELECT * FROM deployments WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1',
      [applicationId],
    );
    return res.rows[0] ?? null;
  }
}
