-- MiniCloud v0.2: per-application configuration
--  * app_env: plain environment variables AND secrets (values encrypted at rest)
--  * resource limits on applications (memory MB / CPU quota)
--  * deployments carry an immutable JSONB snapshot of the effective
--    non-secret configuration used when they were created.

CREATE TABLE IF NOT EXISTS app_env (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  -- NULL for regular variables (plaintext value stored); ciphertext for secrets.
  encrypted_value TEXT,
  -- Plaintext for regular variables; never populated for secrets.
  plain_value TEXT,
  is_secret BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_env_value_shape CHECK (
    (is_secret = false AND plain_value IS NOT NULL AND encrypted_value IS NULL) OR
    (is_secret = true  AND encrypted_value IS NOT NULL AND plain_value IS NULL)
  ),
  CONSTRAINT app_env_app_key_unique UNIQUE (application_id, key)
);

CREATE INDEX IF NOT EXISTS app_env_app_idx ON app_env(application_id);

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS memory_limit_mb INTEGER,
  ADD COLUMN IF NOT EXISTS cpu_limit DOUBLE PRECISION;

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS config_snapshot JSONB;
