-- PLATFORM DATABASE ONLY. Additive provisioning engine state and encrypted secret store.
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS correlation_id UUID;
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS failed_step TEXT;
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS safe_retry JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS provisioning_jobs_correlation_unique
  ON provisioning_jobs(correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tenant_database_secrets (
  id UUID PRIMARY KEY,
  ciphertext BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  key_version TEXT NOT NULL,
  committed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
