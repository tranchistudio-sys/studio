CREATE TABLE IF NOT EXISTS wedding_gift_programs (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  enabled boolean NOT NULL DEFAULT false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wedding_gift_eligible_groups (
  id serial PRIMARY KEY,
  program_id integer NOT NULL REFERENCES wedding_gift_programs(id) ON DELETE CASCADE,
  group_id integer NOT NULL REFERENCES service_groups(id),
  service_key text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (program_id, group_id),
  UNIQUE (program_id, service_key)
);

CREATE TABLE IF NOT EXISTS wedding_gift_tiers (
  id serial PRIMARY KEY,
  program_id integer NOT NULL REFERENCES wedding_gift_programs(id) ON DELETE CASCADE,
  minimum_service_count integer NOT NULL CHECK (minimum_service_count > 0),
  name text NOT NULL,
  choose_count integer NOT NULL DEFAULT 1 CHECK (choose_count > 0),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (program_id, minimum_service_count)
);

CREATE TABLE IF NOT EXISTS wedding_gift_options (
  id serial PRIMARY KEY,
  tier_id integer NOT NULL REFERENCES wedding_gift_tiers(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);

-- Intentionally no seed and no enabled program. Configure explicit eligible group IDs,
-- date window, tiers, and options in an admin workflow before enabling this program.
