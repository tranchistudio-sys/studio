-- Additive CMS home schema used by the public homepage. This migration is
-- deliberately idempotent so production rollout can execute this file alone.
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_1_url TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_2_url TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_3_url TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_1_fit TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_2_fit TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_3_fit TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_1_x TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_1_y TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_1_zoom TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_2_x TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_2_y TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_2_zoom TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_3_x TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_3_y TEXT;
ALTER TABLE cms_home_settings ADD COLUMN IF NOT EXISTS wedding_intro_image_3_zoom TEXT;
