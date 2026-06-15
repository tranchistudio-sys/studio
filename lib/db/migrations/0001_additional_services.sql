ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS additional_services jsonb NOT NULL DEFAULT '[]'::jsonb;
