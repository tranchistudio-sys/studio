-- TENANT BUSINESS DATABASE ONLY. Provisioning inserts exactly one row after
-- creating a new tenant database. Amazing Studio may remain empty during the
-- legacy transition and is verified by its existing registry fingerprint.
CREATE TABLE IF NOT EXISTS tenant_metadata (
  tenant_id UUID PRIMARY KEY,
  schema_version TEXT NOT NULL,
  provisioned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
