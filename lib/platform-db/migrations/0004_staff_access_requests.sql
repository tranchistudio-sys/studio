-- Public staff applications. Applicants never receive access until a tenant
-- manager explicitly approves the request and an invitation is created.
CREATE TABLE IF NOT EXISTS tenant_access_requests (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  requested_position TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES platform_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  tenant_staff_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_access_requests_pending_email_unique
  ON tenant_access_requests(tenant_id, lower(email))
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS tenant_access_requests_pending_phone_unique
  ON tenant_access_requests(tenant_id, phone)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS tenant_access_requests_tenant_created_idx
  ON tenant_access_requests(tenant_id, status, created_at DESC);
