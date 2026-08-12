-- Add-only wedding card media + private recipient email. Existing cards and public links remain valid.
ALTER TABLE wedding_cards ADD COLUMN IF NOT EXISTS album_image_urls JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE wedding_cards ADD COLUMN IF NOT EXISTS notification_email TEXT;
