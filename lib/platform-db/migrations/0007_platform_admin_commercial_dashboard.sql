-- PLATFORM DATABASE ONLY. Additive commercial controls for Platform Admin.
-- Never run against a tenant/business database.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS base_price_amount BIGINT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS custom_price_amount BIGINT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS commercial_class TEXT NOT NULL DEFAULT 'TRIAL';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_starts_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS setup_fee_override_amount BIGINT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS commercial_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='subscriptions_base_price_nonnegative' AND conrelid='subscriptions'::regclass) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_base_price_nonnegative CHECK (base_price_amount IS NULL OR base_price_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='subscriptions_custom_price_nonnegative' AND conrelid='subscriptions'::regclass) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_custom_price_nonnegative CHECK (custom_price_amount IS NULL OR custom_price_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='subscriptions_setup_override_nonnegative' AND conrelid='subscriptions'::regclass) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_setup_override_nonnegative CHECK (setup_fee_override_amount IS NULL OR setup_fee_override_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='subscriptions_commercial_class_valid' AND conrelid='subscriptions'::regclass) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_commercial_class_valid
      CHECK (commercial_class IN ('TRIAL','STANDARD','PRO','CUSTOM','VIP','PARTNER','FREE'));
  END IF;
END $$;

UPDATE subscriptions s SET
  base_price_amount = COALESCE(s.base_price_amount,p.monthly_price_amount),
  commercial_class = CASE
    WHEN s.commercial_class <> 'TRIAL' THEN s.commercial_class
    WHEN s.status='trial' THEN 'TRIAL'
    WHEN upper(COALESCE(p.code,''))='STANDARD' THEN 'STANDARD'
    WHEN upper(COALESCE(p.code,''))='PRO' THEN 'PRO'
    ELSE 'CUSTOM'
  END,
  trial_starts_at = CASE WHEN s.status='trial' THEN COALESCE(s.trial_starts_at,s.current_period_start,s.starts_at) ELSE s.trial_starts_at END,
  trial_ends_at = CASE WHEN s.status='trial' THEN COALESCE(s.trial_ends_at,s.current_period_ends_at) ELSE s.trial_ends_at END
FROM plans p WHERE p.id=s.plan_id
  AND EXISTS (SELECT 1 FROM studio_signup_requests signup WHERE signup.tenant_id=s.tenant_id);

ALTER TABLE platform_payments ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE platform_payments ADD COLUMN IF NOT EXISTS period_start TIMESTAMPTZ;
ALTER TABLE platform_payments ADD COLUMN IF NOT EXISTS period_end TIMESTAMPTZ;
ALTER TABLE platform_payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS tenant_commercial_notes (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  note TEXT NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 2000),
  created_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_commercial_notes_tenant_created_idx
  ON tenant_commercial_notes (tenant_id, created_at DESC);
