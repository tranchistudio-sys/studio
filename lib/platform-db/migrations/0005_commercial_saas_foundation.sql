-- PLATFORM DATABASE ONLY. Additive commercial SaaS foundation.
-- Never run against a tenant/business database.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS setup_fee_amount BIGINT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS monthly_price_amount BIGINT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'VND';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM plans WHERE code IS NOT NULL
    GROUP BY upper(code) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'commercial preflight: duplicate plan codes must be resolved before migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM plans
    WHERE upper(code) IN ('STANDARD', 'PRO') AND id <> lower(code)
  ) THEN
    RAISE EXCEPTION 'commercial preflight: canonical STANDARD/PRO code belongs to a non-canonical plan id';
  END IF;
  IF EXISTS (
    SELECT 1 FROM plans
    WHERE id IN ('standard', 'pro') AND code IS NOT NULL AND upper(code) <> upper(id)
  ) THEN
    RAISE EXCEPTION 'commercial preflight: canonical plan id has a conflicting code';
  END IF;
  IF EXISTS (
    SELECT 1 FROM subscriptions
    WHERE status IN ('trial', 'active', 'past_due', 'suspended')
    GROUP BY tenant_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'commercial preflight: tenant has multiple current subscriptions';
  END IF;
  IF EXISTS (
    SELECT 1 FROM provisioning_jobs
    WHERE status IN ('pending', 'running', 'cleanup_required')
    GROUP BY tenant_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'commercial preflight: tenant has multiple open provisioning jobs';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS plans_code_unique
  ON plans (upper(code)) WHERE code IS NOT NULL;

INSERT INTO plans
  (id, code, name, billing_period, setup_fee_amount, monthly_price_amount, currency, features)
VALUES
  ('standard', 'STANDARD', 'Standard', 'month', 900000, 500000, 'VND',
   '{"core_management":true}'::jsonb),
  ('pro', 'PRO', 'Pro', 'month', 900000, 1000000, 'VND',
   '{"core_management":true,"website":true,"ai_lulu":true,"copilot":true,"advanced_reports":true,"custom_branding":true,"custom_domain":true}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  code = COALESCE(plans.code, EXCLUDED.code),
  setup_fee_amount = COALESCE(plans.setup_fee_amount, EXCLUDED.setup_fee_amount),
  monthly_price_amount = COALESCE(plans.monthly_price_amount, EXCLUDED.monthly_price_amount),
  currency = COALESCE(plans.currency, EXCLUDED.currency),
  features = CASE WHEN plans.features = '{}'::jsonb THEN EXCLUDED.features ELSE plans.features END;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'DIRECT';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_until TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_current_per_tenant
  ON subscriptions (tenant_id)
  WHERE status IN ('trial', 'active', 'past_due', 'suspended');

CREATE TABLE IF NOT EXISTS studio_signup_requests (
  id UUID PRIMARY KEY,
  owner_name TEXT NOT NULL,
  studio_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT,
  requested_slug TEXT NOT NULL,
  requested_plan_code TEXT NOT NULL CHECK (requested_plan_code IN ('STANDARD', 'PRO')),
  source TEXT NOT NULL DEFAULT 'DIRECT' CHECK (source = 'DIRECT'),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'CONTACTED', 'APPROVED', 'REJECTED', 'PROVISIONING', 'ACTIVE', 'FAILED')),
  notes TEXT,
  tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS studio_signup_requests_open_slug_unique
  ON studio_signup_requests (lower(requested_slug))
  WHERE status NOT IN ('REJECTED', 'FAILED');
CREATE INDEX IF NOT EXISTS studio_signup_requests_status_created_idx
  ON studio_signup_requests (status, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_payments (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT,
  signup_request_id UUID REFERENCES studio_signup_requests(id) ON DELETE RESTRICT,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE RESTRICT,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('SETUP_FEE', 'SUBSCRIPTION')),
  amount BIGINT NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'VND',
  source TEXT NOT NULL DEFAULT 'DIRECT' CHECK (source IN ('DIRECT', 'APPLE', 'GOOGLE', 'WEB')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'VOID', 'WAIVED')),
  paid_at TIMESTAMPTZ,
  note TEXT,
  created_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (tenant_id IS NOT NULL OR signup_request_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_payments_setup_fee_signup_unique
  ON platform_payments (signup_request_id, payment_type)
  WHERE signup_request_id IS NOT NULL AND payment_type = 'SETUP_FEE' AND status <> 'VOID';
CREATE UNIQUE INDEX IF NOT EXISTS platform_payments_setup_fee_tenant_unique
  ON platform_payments (tenant_id, payment_type)
  WHERE tenant_id IS NOT NULL AND payment_type = 'SETUP_FEE' AND status <> 'VOID';
CREATE INDEX IF NOT EXISTS platform_payments_tenant_created_idx
  ON platform_payments (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_domains (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  hostname TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('PLATFORM', 'CUSTOM')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'failed')),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_branding (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  public_name TEXT NOT NULL,
  logo_url TEXT,
  phone TEXT,
  address TEXT,
  primary_color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provisioning_jobs_one_open_per_tenant
  ON provisioning_jobs (tenant_id)
  WHERE status IN ('pending', 'running', 'cleanup_required');
