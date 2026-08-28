-- PLATFORM DATABASE ONLY. Carries the intended tenant permission preset through
-- the existing invitation -> acceptance -> membership lifecycle.
ALTER TABLE tenant_invitations
  ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
