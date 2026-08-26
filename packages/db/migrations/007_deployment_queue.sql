-- MiniCloud v0.7: persistent deployment queue
--  * deployment_jobs: durable scheduling records decoupled from the pipeline
--    state machine on `deployments`. A queued deployment survives API restarts.
--  * deployments.status gains CANCELLED as a terminal state.
--  * build_artifacts: exact-image reuse identity (repo+commit+build inputs).
--
-- All statements are idempotent; v0.6 data is preserved.

-- The inline CHECK from 001_init.sql was auto-named `deployments_status_check`.
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_status_check;
ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS build_cache TEXT;
ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
  CHECK (status IN ('QUEUED','CLONING','BUILDING','STARTING','HEALTH_CHECKING','RUNNING','FAILED','STOPPED','CANCELLED'));

CREATE TABLE IF NOT EXISTS deployment_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL UNIQUE REFERENCES deployments(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- What requested this work: manual deploy/rollback, git auto-deploy, PR preview.
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'git', 'preview')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'running', 'completed', 'failed', 'cancelled', 'superseded')),
  -- Lower runs first. Documented policy (docs/architecture.md):
  --   10 manual production deploy, 15 rollback, 50 git auto-deploy, 90 preview.
  priority INTEGER NOT NULL DEFAULT 100,
  desired_ref TEXT,
  -- Worker identity while claimed/running; stale claims are detected by
  -- heartbeat age after an API restart.
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  -- For superseded jobs: the job that replaced it.
  superseded_by_job_id UUID REFERENCES deployment_jobs(id) ON DELETE SET NULL,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deployment_jobs_queue_idx
  ON deployment_jobs(status, priority, created_at);
CREATE INDEX IF NOT EXISTS deployment_jobs_app_idx
  ON deployment_jobs(application_id, status);

-- Exact-image reuse identity. fingerprint = sha256(commit sha + Dockerfile +
-- build-context content manifest). One row per app/service/fingerprint; the
-- referenced image tag must still exist locally to be usable.
CREATE TABLE IF NOT EXISTS build_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  -- NULL for single-service images; service name for per-service images.
  service_name TEXT,
  fingerprint TEXT NOT NULL,
  image_tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  use_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT build_artifacts_unique UNIQUE (application_id, service_name, fingerprint)
);

CREATE INDEX IF NOT EXISTS build_artifacts_lookup_idx
  ON build_artifacts(application_id, service_name, commit_sha);
