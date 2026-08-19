-- PLATFORM DATABASE ONLY. Additive membership-scoped session revocation.
-- Kept separate from 0001 so databases that already applied the foundation can
-- upgrade without changing the checksum of an applied migration.

ALTER TABLE tenant_memberships
  ADD COLUMN IF NOT EXISTS auth_version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE tenant_memberships
  ADD COLUMN IF NOT EXISTS sessions_revoked_at TIMESTAMPTZ;
