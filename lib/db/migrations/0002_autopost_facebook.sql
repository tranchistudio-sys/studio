CREATE TABLE IF NOT EXISTS autopost_content_pool (
  id serial PRIMARY KEY,
  source_type text NOT NULL,
  source_table text,
  source_item_id text,
  content_type text NOT NULL,
  title text NOT NULL,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  price numeric(12,2),
  sale_price numeric(12,2),
  golden_hour_percent numeric(5,2),
  golden_hour_name text,
  category text,
  badge text,
  public_link text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  image_hash text,
  is_eligible boolean NOT NULL DEFAULT true,
  ineligible_reason text,
  last_posted_at timestamptz,
  times_posted integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_autopost_pool_source
  ON autopost_content_pool(source_table, source_item_id)
  WHERE source_table IS NOT NULL AND source_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS autopost_schedules (
  id serial PRIMARY KEY,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  page_id text,
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS autopost_schedule_slots (
  id serial PRIMARY KEY,
  schedule_id integer NOT NULL REFERENCES autopost_schedules(id) ON DELETE CASCADE,
  post_time text NOT NULL,
  content_type text NOT NULL,
  image_count integer NOT NULL DEFAULT 1,
  source_priority text NOT NULL DEFAULT 'app_web',
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS autopost_posts (
  id serial PRIMARY KEY,
  schedule_id integer REFERENCES autopost_schedules(id) ON DELETE SET NULL,
  slot_id integer REFERENCES autopost_schedule_slots(id) ON DELETE SET NULL,
  content_pool_id integer REFERENCES autopost_content_pool(id) ON DELETE SET NULL,
  page_id text,
  content_type text,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  caption_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  caption_recommended_index integer,
  caption_final text,
  status text NOT NULL DEFAULT 'draft_ai',
  scheduled_at timestamptz,
  approved_by integer,
  approved_at timestamptz,
  posted_at timestamptz,
  facebook_post_id text,
  facebook_post_link text,
  error_message text,
  retry_count integer NOT NULL DEFAULT 0,
  caption_hash text,
  image_hash text,
  source_type text,
  source_item_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_autopost_posts_status_sched ON autopost_posts(status, scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_autopost_posts_img  ON autopost_posts(page_id, image_hash)   WHERE status = 'posted' AND image_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_autopost_posts_cap  ON autopost_posts(page_id, caption_hash) WHERE status = 'posted' AND caption_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS autopost_settings (
  id integer PRIMARY KEY DEFAULT 1,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer,
  CONSTRAINT autopost_settings_singleton CHECK (id = 1)
);
INSERT INTO autopost_settings (id, config) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;
