-- Add-only wedding card media + RSVP metadata. Existing cards and public links remain valid.
ALTER TABLE wedding_cards ADD COLUMN IF NOT EXISTS album_image_urls JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE wedding_cards ADD COLUMN IF NOT EXISTS notification_email TEXT;

ALTER TABLE wedding_guest_entries ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wedding_guest_entries ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE wedding_guest_entries ADD COLUMN IF NOT EXISTS spam_fingerprint TEXT;
ALTER TABLE wedding_guest_entries ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wedding_guest_entries_idempotency
  ON wedding_guest_entries(card_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
