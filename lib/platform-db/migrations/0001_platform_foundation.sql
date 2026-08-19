-- PLATFORM DATABASE ONLY. Never run this file against a tenant/business database.
-- Additive foundation: no DROP, TRUNCATE, destructive ALTER, or business data.

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  billing_period TEXT NOT NULL DEFAULT 'manual'
    CHECK (billing_period IN ('manual', 'month', 'year')),
  employee_limit INTEGER,
  storage_limit_bytes BIGINT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO plans (id, name, billing_period)
VALUES ('legacy', 'Amazing Studio Legacy', 'manual')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_users (
  id UUID PRIMARY KEY,
  canonical_email TEXT,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted')),
  platform_role TEXT
    CHECK (platform_role IS NULL OR platform_role IN ('PLATFORM_OWNER', 'PLATFORM_ADMIN')),
  email_verified_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  auth_version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_users_email_idx
  ON platform_users (lower(canonical_email));

CREATE TABLE IF NOT EXISTS auth_identities (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'local')),
  provider_subject TEXT NOT NULL,
  email_at_provider TEXT,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS auth_identities_user_idx ON auth_identities(user_id);

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'trial', 'active', 'suspended', 'cancelled', 'provisioning_failed')),
  plan_id TEXT REFERENCES plans(id),
  trial_ends_at TIMESTAMPTZ,
  bootstrap_completed_at TIMESTAMPTZ,
  bootstrap_owner_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_memberships (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  tenant_role TEXT NOT NULL CHECK (tenant_role IN ('OWNER', 'ADMIN', 'STAFF')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked')),
  tenant_staff_id BIGINT,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  invited_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_memberships_staff_unique
  ON tenant_memberships(tenant_id, tenant_staff_id)
  WHERE tenant_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tenant_memberships_user_idx
  ON tenant_memberships(user_id, status);

CREATE TABLE IF NOT EXISTS tenant_invitations (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  invited_role TEXT NOT NULL CHECK (invited_role IN ('OWNER', 'ADMIN', 'STAFF')),
  tenant_staff_id BIGINT,
  target_user_id UUID REFERENCES platform_users(id) ON DELETE CASCADE,
  token_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  invited_by UUID NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_invitations_pending_email_unique
  ON tenant_invitations(tenant_id, lower(invited_email))
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS tenant_invitations_pending_staff_unique
  ON tenant_invitations(tenant_id, tenant_staff_id)
  WHERE status = 'pending' AND tenant_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tenant_invitations_lookup_idx
  ON tenant_invitations(lower(invited_email), status, expires_at);

CREATE TABLE IF NOT EXISTS tenant_database_registry (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  database_ref TEXT NOT NULL UNIQUE,
  host_ref TEXT NOT NULL,
  database_name TEXT NOT NULL,
  role_name TEXT NOT NULL,
  secret_ref TEXT,
  encrypted_secret BYTEA,
  health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'healthy', 'unhealthy')),
  last_health_check_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (secret_ref IS NOT NULL OR encrypted_secret IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  active_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  tenant_membership_id UUID REFERENCES tenant_memberships(id) ON DELETE SET NULL,
  legacy_staff_id BIGINT,
  user_agent TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_active_idx
  ON sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_membership_active_idx
  ON sessions(tenant_membership_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id UUID PRIMARY KEY,
  actor_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_audit_logs_tenant_created_idx
  ON platform_audit_logs(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'trial'
    CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled')),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_ends_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_tenant_idx ON subscriptions(tenant_id, status);

CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cleanup_required')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  step TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_after TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provisioning_jobs_retry_idx
  ON provisioning_jobs(status, retry_after);
