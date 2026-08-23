-- MiniCloud initial schema

CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  repository_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  ref TEXT,
  commit_sha TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','CLONING','BUILDING','STARTING','HEALTH_CHECKING','RUNNING','FAILED','STOPPED')),
  image_tag TEXT,
  container_id TEXT,
  container_name TEXT,
  host_port INTEGER,
  container_port INTEGER,
  health_path TEXT,
  failure_reason TEXT,
  exit_code INTEGER,
  restart_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS deployments_app_idx ON deployments(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deployments_status_idx ON deployments(status);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
