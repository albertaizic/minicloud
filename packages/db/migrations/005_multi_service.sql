-- MiniCloud v0.5: multi-service applications, private networking, volumes
--  * deployments.manifest_snapshot: immutable parsed manifest for the revision
--  * deployment_services: one row per service container of a deployment
--  * application_volumes: MiniCloud-managed named volumes per application
-- Backward compatible: single-service (manifest-less) deployments keep working
-- and simply have no service rows (their container stays on `deployments`).

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS manifest_snapshot JSONB;

CREATE TABLE IF NOT EXISTS deployment_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  service_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  image_tag TEXT,
  container_id TEXT,
  container_name TEXT,
  host_port INTEGER,
  container_port INTEGER,
  health_path TEXT,
  public_service BOOLEAN NOT NULL DEFAULT false,
  restart_count INTEGER NOT NULL DEFAULT 0,
  auto_restart_count INTEGER NOT NULL DEFAULT 0,
  next_auto_restart_at TIMESTAMPTZ,
  failure_reason TEXT,
  exit_code INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deployment_services_unique UNIQUE (deployment_id, service_name)
);

CREATE INDEX IF NOT EXISTS deployment_services_dep_idx
  ON deployment_services(deployment_id);

CREATE TABLE IF NOT EXISTS application_volumes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  volume_name TEXT NOT NULL,
  docker_volume TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT application_volumes_unique UNIQUE (application_id, volume_name)
);
