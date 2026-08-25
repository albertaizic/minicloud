-- MiniCloud v0.6: Git-driven automatic deployments
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS git_branch TEXT NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS auto_deploy BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_observed_sha TEXT,
  ADD COLUMN IF NOT EXISTS last_deployed_sha TEXT,
  ADD COLUMN IF NOT EXISTS last_git_check TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
