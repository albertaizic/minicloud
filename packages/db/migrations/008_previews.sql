-- MiniCloud v0.7: GitHub pull-request preview environments
--  * preview_environments: one logical preview per (application, PR number).
--  * deployments gain preview linkage + explicit gateway route key so preview
--    traffic never touches the production routing concept.
--  * webhook_deliveries: GitHub delivery-id deduplication (safe retries).
--  * applications.secrets_in_previews: opt-in flag; production secrets are NOT
--    injected into preview containers unless explicitly enabled.

CREATE TABLE IF NOT EXISTS preview_environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL CHECK (pr_number > 0),
  head_sha TEXT,
  branch TEXT,
  -- Deterministic safe local hostname label: pr-<number>-<app-slug>.
  route_slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'active', 'closed')),
  -- Currently serving preview deployment (plain UUID, not FK: the deployment
  -- row references back via preview_environment_id).
  active_preview_deployment_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  CONSTRAINT preview_environments_app_pr_unique UNIQUE (application_id, pr_number)
);

CREATE INDEX IF NOT EXISTS preview_environments_app_idx
  ON preview_environments(application_id, status);

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS preview_environment_id UUID
    REFERENCES preview_environments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gateway_route_key TEXT;

CREATE INDEX IF NOT EXISTS deployments_preview_idx
  ON deployments(preview_environment_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  -- GitHub's X-GitHub-Delivery GUID. Primary key = natural dedup key.
  id TEXT PRIMARY KEY,
  event_type TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS secrets_in_previews BOOLEAN NOT NULL DEFAULT false;
