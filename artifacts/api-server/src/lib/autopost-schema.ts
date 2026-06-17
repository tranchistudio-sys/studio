import { pool } from "@workspace/db";

export async function ensureAutoPostSchema(): Promise<void> {
  try {
    await pool.query(`
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
)
    `);

    await pool.query(`
CREATE UNIQUE INDEX IF NOT EXISTS uq_autopost_pool_source
  ON autopost_content_pool(source_table, source_item_id)
  WHERE source_table IS NOT NULL AND source_item_id IS NOT NULL
    `);

    await pool.query(`
CREATE TABLE IF NOT EXISTS autopost_schedules (
  id serial PRIMARY KEY,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  page_id text,
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)
    `);

    await pool.query(`
CREATE TABLE IF NOT EXISTS autopost_schedule_slots (
  id serial PRIMARY KEY,
  schedule_id integer NOT NULL REFERENCES autopost_schedules(id) ON DELETE CASCADE,
  post_time text NOT NULL,
  content_type text NOT NULL,
  image_count integer NOT NULL DEFAULT 1,
  source_priority text NOT NULL DEFAULT 'app_web',
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
)
    `);

    await pool.query(`
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
)
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS ix_autopost_posts_status_sched ON autopost_posts(status, scheduled_at)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_autopost_posts_img ON autopost_posts(page_id, image_hash) WHERE status = 'posted' AND image_hash IS NOT NULL`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_autopost_posts_cap ON autopost_posts(page_id, caption_hash) WHERE status = 'posted' AND caption_hash IS NOT NULL`);

    await pool.query(`
CREATE TABLE IF NOT EXISTS autopost_settings (
  id integer PRIMARY KEY DEFAULT 1,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer,
  CONSTRAINT autopost_settings_singleton CHECK (id = 1)
)
    `);

    await pool.query(`INSERT INTO autopost_settings (id, config) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);

    // ─── NÂNG CẤP (cộng-thêm, an toàn dữ liệu cũ) ──────────────────────────────
    // Bảng chiến dịch / batch: mỗi nhóm nội dung có cấu hình riêng (giọng văn,
    // số bài/ngày, khung giờ, chế độ duyệt…). enabled mặc định false (an toàn).
    await pool.query(`
CREATE TABLE IF NOT EXISTS autopost_batches (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  page_id text,
  source_priority text NOT NULL DEFAULT 'app_web',
  content_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  tone text,
  mode text NOT NULL DEFAULT 'manual',
  posts_per_day integer NOT NULL DEFAULT 3,
  caption_options_per_post integer NOT NULL DEFAULT 3,
  slots jsonb NOT NULL DEFAULT '[]'::jsonb,
  dry_run boolean,
  auto_approve_enabled boolean NOT NULL DEFAULT false,
  auto_approve_after_minutes integer NOT NULL DEFAULT 30,
  require_manual_approval boolean NOT NULL DEFAULT true,
  auto_publish_after_approved boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)
    `);

    // Cột mới cho autopost_posts (idempotent). batch_id KHÔNG ràng buộc FK để an
    // toàn khi xoá batch (mồ côi vô hại); dùng index để lọc nhanh.
    for (const col of [
      `batch_id integer`,
      `ai_model text`,
      `used_sample_ids jsonb NOT NULL DEFAULT '[]'::jsonb`,
      `vision_image_count integer`,
      `auto_approve_at timestamptz`,
      `hold_reason text`,
      `quality_score integer`,
      `generated_by integer`,
      `footer_enabled boolean`,
    ]) {
      await pool.query(`ALTER TABLE autopost_posts ADD COLUMN IF NOT EXISTS ${col}`);
    }
    await pool.query(`CREATE INDEX IF NOT EXISTS ix_autopost_posts_batch ON autopost_posts(batch_id)`);
    // Cho sweep auto-approve quét nhanh các bài chờ tới hạn.
    await pool.query(`CREATE INDEX IF NOT EXISTS ix_autopost_posts_autoapprove ON autopost_posts(status, auto_approve_at)`);

    // Nhật ký theo từng bài (ai tạo, model nào, sample nào, lúc duyệt/đăng, lỗi…).
    await pool.query(`
CREATE TABLE IF NOT EXISTS autopost_post_log (
  id serial PRIMARY KEY,
  post_id integer NOT NULL,
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now()
)
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS ix_autopost_post_log_post ON autopost_post_log(post_id, created_at)`);

    // Kho VĂN PHONG MẪU (RAG nhẹ): admin dán bài hay → AI học giọng (không chép).
    await pool.query(`
CREATE TABLE IF NOT EXISTS autopost_style_samples (
  id serial PRIMARY KEY,
  title text NOT NULL,
  content text NOT NULL,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_type text,
  tone text,
  is_active boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS ix_autopost_style_active ON autopost_style_samples(is_active, content_type, priority)`);
    // Ảnh gốc kèm bài mẫu (screenshot đã OCR) — chỉ để admin xem lại; generate KHÔNG dùng.
    await pool.query(`ALTER TABLE autopost_style_samples ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]'::jsonb`);

    console.log("[AutoPost] schema ensured");
  } catch (err) {
    console.error("[AutoPost] ensureAutoPostSchema error:", err);
  }
}
