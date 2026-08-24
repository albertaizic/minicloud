-- MiniCloud v0.3: reliability & observability
--  * deployment_events: ordered, persistent lifecycle history per deployment
--  * rollback lineage (new deployment references the revision it rolls back to)
--  * per-application automatic restart policy
--  * recovery bookkeeping on deployments (auto attempt counter, backoff due-at)
--
-- All statements are idempotent; existing v0.1/v0.2 data is preserved.
-- Ordering: BIGINT identity `id` is globally monotonic; per-deployment ordering
-- is (deployment_id, id) via the index below. Never rely on created_at alone
-- (same-millisecond events would be ambiguous).

CREATE TABLE IF NOT EXISTS deployment_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  -- Structural context only (e.g. attempt numbers, image tags, exit codes).
  -- NEVER store secret values here.
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deployment_events_dep_idx
  ON deployment_events(deployment_id, id);

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS rollback_of_deployment_id UUID
    REFERENCES deployments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auto_restart_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_auto_restart_at TIMESTAMPTZ;

-- Inline CHECK constraints are only created together with the new columns,
-- so re-running the migration cannot fail on duplicate constraint names.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS restart_policy TEXT NOT NULL DEFAULT 'disabled'
    CHECK (restart_policy IN ('disabled', 'on-failure')),
  ADD COLUMN IF NOT EXISTS max_restart_attempts INTEGER NOT NULL DEFAULT 3
    CHECK (max_restart_attempts BETWEEN 0 AND 10);
