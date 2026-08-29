ALTER TABLE bookings ADD COLUMN IF NOT EXISTS attribution jsonb;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS attribution jsonb;

CREATE TABLE IF NOT EXISTS analytics_events (
  id serial PRIMARY KEY,
  event_key text NOT NULL,
  event_name text NOT NULL,
  event_id text NOT NULL,
  provider text NOT NULL DEFAULT 'meta_capi',
  source_type text NOT NULL,
  source_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  sent_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_event_key_uidx
  ON analytics_events(event_key);
CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_provider_name_event_id_uidx
  ON analytics_events(provider, event_name, event_id);
