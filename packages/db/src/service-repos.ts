import type { Database } from './index.js';

export interface DeploymentServiceRow {
  id: string;
  deployment_id: string;
  service_name: string;
  status: string;
  image_tag: string | null;
  container_id: string | null;
  container_name: string | null;
  host_port: number | null;
  container_port: number | null;
  health_path: string | null;
  public_service: boolean;
  restart_count: number;
  auto_restart_count: number;
  next_auto_restart_at: Date | null;
  failure_reason: string | null;
  exit_code: number | null;
  created_at: Date;
}

export interface ApplicationVolumeRow {
  id: string;
  application_id: string;
  volume_name: string;
  docker_volume: string;
  created_at: Date;
}

/** Per-service containers of a multi-service deployment. */
export class DeploymentServiceRepository {
  constructor(private readonly db: Database) {}

  async create(
    deploymentId: string,
    svc: {
      serviceName: string;
      imageTag?: string | null;
      containerPort?: number | null;
      healthPath?: string | null;
      publicService: boolean;
    },
  ): Promise<DeploymentServiceRow> {
    const res = await this.db.query<DeploymentServiceRow>(
      `INSERT INTO deployment_services
         (deployment_id, service_name, status, image_tag, container_port, health_path, public_service)
       VALUES ($1, $2, 'QUEUED', $3, $4, $5, $6) RETURNING *`,
      [deploymentId, svc.serviceName, svc.imageTag ?? null, svc.containerPort ?? null, svc.healthPath ?? null, svc.publicService],
    );
    return res.rows[0]!;
  }

  async listByDeployment(deploymentId: string): Promise<DeploymentServiceRow[]> {
    const res = await this.db.query<DeploymentServiceRow>(
      'SELECT * FROM deployment_services WHERE deployment_id = $1 ORDER BY service_name',
      [deploymentId],
    );
    return res.rows;
  }

  async byName(deploymentId: string, serviceName: string): Promise<DeploymentServiceRow | null> {
    const res = await this.db.query<DeploymentServiceRow>(
      'SELECT * FROM deployment_services WHERE deployment_id = $1 AND service_name = $2',
      [deploymentId, serviceName],
    );
    return res.rows[0] ?? null;
  }

  async updateFields(
    id: string,
    fields: Partial<{
      status: string | null;
      image_tag: string | null;
      container_id: string | null;
      container_name: string | null;
      host_port: number | null;
      container_port: number | null;
      restart_count: number;
      auto_restart_count: number;
      next_auto_restart_at: Date | null;
      failure_reason: string | null;
      exit_code: number | null;
    }>,
  ): Promise<void> {
    const keys = Object.keys(fields).filter((k) => fields[k as keyof typeof fields] !== undefined);
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const values = keys.map((k) => fields[k as keyof typeof fields]);
    await this.db.query(`UPDATE deployment_services SET ${sets.join(', ')} WHERE id = $1`, [id, ...values]);
  }

  /** Guarded status transition for one service container. */
  async transitionStatus(
    id: string,
    from: string[],
    to: string,
    extra?: Partial<{ failure_reason: string | null; exit_code: number | null }>,
  ): Promise<DeploymentServiceRow | null> {
    const values: unknown[] = [id, from, to];
    const sets: string[] = ['status = $3', 'updated_at = now()'];
    if (extra?.failure_reason !== undefined) {
      values.push(extra.failure_reason);
      sets.push(`failure_reason = $${values.length}`);
    }
    if (extra?.exit_code !== undefined) {
      values.push(extra.exit_code);
      sets.push(`exit_code = $${values.length}`);
    }
    const res = await this.db.query<DeploymentServiceRow>(
      `UPDATE deployment_services SET ${sets.join(', ')}
       WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
      values,
    );
    return res.rows[0] ?? null;
  }

  /** Atomically claim a due automatic service restart. */
  async claimDueAutoRestart(id: string): Promise<DeploymentServiceRow | null> {
    const res = await this.db.query<DeploymentServiceRow>(
      `UPDATE deployment_services
       SET auto_restart_count = auto_restart_count + 1, next_auto_restart_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'FAILED'
         AND next_auto_restart_at IS NOT NULL AND next_auto_restart_at <= now()
       RETURNING *`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  /** All service rows that are candidates for automatic recovery. */
  async listDueAutoRestarts(): Promise<DeploymentServiceRow[]> {
    const res = await this.db.query<DeploymentServiceRow>(
      `SELECT * FROM deployment_services
       WHERE status = 'FAILED' AND next_auto_restart_at IS NOT NULL AND next_auto_restart_at <= now()`,
    );
    return res.rows;
  }
}

/** MiniCloud-managed named volumes, scoped per application. */
export class ApplicationVolumeRepository {
  constructor(private readonly db: Database) {}

  async ensure(applicationId: string, volumeName: string, dockerVolume: string): Promise<ApplicationVolumeRow> {
    const res = await this.db.query<ApplicationVolumeRow>(
      `INSERT INTO application_volumes (application_id, volume_name, docker_volume)
       VALUES ($1, $2, $3)
       ON CONFLICT (application_id, volume_name) DO UPDATE SET docker_volume = EXCLUDED.docker_volume
       RETURNING *`,
      [applicationId, volumeName, dockerVolume],
    );
    return res.rows[0]!;
  }

  async listByApplication(applicationId: string): Promise<ApplicationVolumeRow[]> {
    const res = await this.db.query<ApplicationVolumeRow>(
      'SELECT * FROM application_volumes WHERE application_id = $1 ORDER BY volume_name',
      [applicationId],
    );
    return res.rows;
  }

  async listAll(): Promise<ApplicationVolumeRow[]> {
    const res = await this.db.query<ApplicationVolumeRow>(
      'SELECT * FROM application_volumes ORDER BY created_at DESC',
    );
    return res.rows;
  }
}
