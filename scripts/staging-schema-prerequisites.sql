-- Schema-only prerequisite for the runtime-managed wedding card module.
-- The canonical route creates this table lazily; tenant migration 0003 extends it.
-- No business or Amazing-specific rows are inserted here.
CREATE TABLE IF NOT EXISTS wedding_cards (
  id serial PRIMARY KEY
);

-- These two legacy/runtime tables are also assumed by ordered additive
-- migrations and are deliberately the same minimal prerequisites proven by
-- the Phase 2 provisioning integration test.
CREATE TABLE IF NOT EXISTS service_groups (
  id serial PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS cms_home_settings (
  id serial PRIMARY KEY
);
