-- MiniCloud v0.4: routing, zero-downtime deployments, traffic management
--  * applications.route_slug: stable hostname label (<slug>.localhost)
--  * applications.active_deployment_id: the deployment receiving app traffic
--  * Backward compatible: existing v0.3 data is preserved and backfilled.
--
-- Slug backfill: application names have been validated against
-- [A-Za-z0-9][A-Za-z0-9-]* since v0.1, so lower(name) is always a safe slug.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS route_slug TEXT,
  ADD COLUMN IF NOT EXISTS active_deployment_id UUID
    REFERENCES deployments(id) ON DELETE SET NULL;

UPDATE applications SET route_slug = lower(name) WHERE route_slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS applications_route_slug_idx
  ON applications(route_slug);
