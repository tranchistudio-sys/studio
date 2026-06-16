# AutoPost Facebook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hệ thống tự động đăng bài Facebook Page theo lịch cho Amazing Studio Manager — Claude viết caption (đọc hình + metadata), admin duyệt trước khi đăng, scheduler tự đăng đến giờ.

**Architecture:** Module tách biệt `autopost_*` (5 bảng mới), **không đụng bảng/route nghiệp vụ gốc**. Tái dùng `callChat()` (AI fallback), pattern scheduler `setInterval`+atomic-claim của `follow-up-scheduler.ts`, object storage, `settings`, `emitNotification`, frontend `wouter + AdminRoute + TanStack Query + shadcn`. Phần đăng Page xây mới (codebase hiện chỉ có Messenger). Mọi lần đăng đi qua cờ `AUTOPOST_DRY_RUN`.

**Tech Stack:** Node/Express + Postgres (raw `pool.query` từ `@workspace/db`) · Drizzle (typing) · `@anthropic-ai/sdk` · React 19 + Vite + wouter + TanStack Query + shadcn/ui · vitest.

**Đường dẫn gốc dự án:** `D:\CAC PHIEN BAN CODE\CODE SUSU 14-6\BACKUP_FULL_TRANCHISTUDIO_20260614_092037\BACKUP_FULL_TRANCHISTUDIO\code`
(các path dưới đây tương đối từ thư mục `code/`)

---

## Quy ước & nguyên tắc (đọc trước khi code)

- **DB access:** routes dùng **raw `pool.query`** + alias snake_case→camelCase, upsert `ON CONFLICT … DO UPDATE`, `RETURNING` — theo `artifacts/api-server/src/routes/golden-hour.ts`. KHÔNG bắt buộc dùng Drizzle query builder (Drizzle chỉ để typing + drizzle-kit).
- **Schema thật vs Drizzle:** một số cột của `dresses` (`is_public`, `cms_status`, `sale_price`, `cover_image_url`, `public_image_url`, `extra_images`, `slug`) được thêm **runtime bằng `ALTER TABLE … ADD COLUMN IF NOT EXISTS`** trong `routes/cms.ts` (không có trong file Drizzle `schema/dresses.ts`). → Pool sync phải dùng **raw SQL** và đọc đúng cột runtime; không tin vào Drizzle type cho các cột này.
- **Auth:** `verifyToken(req.headers.authorization)` → id; `getCallerRole(...)` → `"admin"|"staff"|null`. Ghi/duyệt = admin (xem `requireAdmin` trong golden-hour.ts).
- **Ensure-schema runtime:** codebase tạo cột/bảng idempotent lúc khởi động (xem `routes/auth.ts` `ensureAuthColumns()` và `routes/photo-ideas.ts`). Ta theo pattern này: `ensureAutoPostSchema()` chạy 1 lần khi import router.
- **Token FB / page:** đọc theo thứ tự `settings.fb_page_access_token` → `process.env.FB_PAGE_ACCESS_TOKEN`; page mặc định `settings.fb_active_page_id` (xem `follow-up-scheduler.ts:8-17`, `fb-inbox.ts`).
- **Frontend token key:** `localStorage["amazingStudioToken_v2"]`; base API `getApiBase()`; `authFetch` mẫu ở `components/layout.tsx:115-118`.
- **Graph API version:** chuẩn hoá **v22.0**.
- **An toàn (mục 8 spec):** không tự đăng khi chưa duyệt; không sửa/xoá bảng gốc; token chỉ ở env/settings; không commit `.env`/file khách; module không ghi vào bảng booking/doanh thu/chấm công.

## File Structure (tạo / sửa)

**Backend — tạo mới**
- `lib/db/src/schema/autopost.ts` — Drizzle schema 5 bảng (typing + drizzle-kit).
- `lib/db/migrations/0002_autopost_facebook.sql` — migration SQL (bản ghi chính thức).
- `artifacts/api-server/src/lib/autopost-schema.ts` — `ensureAutoPostSchema()` (idempotent CREATE TABLE IF NOT EXISTS + indexes).
- `artifacts/api-server/src/lib/autopost-pool.ts` — sync nguồn app/web → content pool + upload thủ công + image hash.
- `artifacts/api-server/src/lib/autopost-caption.ts` — build prompt + gọi Claude (vision) → 3 caption + price-guard + từ cấm FB.
- `artifacts/api-server/src/lib/facebook-page-publish.ts` — đăng Page (photos/feed) + DRY_RUN.
- `artifacts/api-server/src/lib/autopost-images.ts` — lấy bytes ảnh từ public URL/local → base64 cho vision; resize-guard kích thước.
- `artifacts/api-server/src/autopost-scheduler.ts` — `startAutoPostScheduler()`.
- `artifacts/api-server/src/routes/auto-post-facebook.ts` — router `/autopost/*`.

**Backend — sửa**
- `artifacts/api-server/src/lib/ai-orchestrator.ts` — mở rộng `ChatMessage` + `callClaude`/`callOpenAI` hỗ trợ ảnh.
- `artifacts/api-server/src/routes/index.ts` — đăng ký `autoPostFacebookRouter`.
- `artifacts/api-server/src/app.ts` — gọi `startAutoPostScheduler()`.
- `lib/db/src/schema/index.ts` — `export * from "./autopost"`.
- `.env.example` — thêm biến cấu hình AutoPost.

**Frontend — tạo mới**
- `artifacts/amazing-studio/src/pages/auto-post-facebook.tsx` — trang admin 7 tab.
- `artifacts/amazing-studio/src/lib/autopost-api.ts` — fetch helper + TanStack hooks.

**Frontend — sửa**
- `artifacts/amazing-studio/src/App.tsx` — import + route `/auto-post-facebook` (AdminRoute) + thêm prefix `/auto-post-facebook` vào `INTERNAL_PREFIXES`.
- `artifacts/amazing-studio/src/components/layout.tsx` — thêm mục `ALL_NAV_ITEMS`.

**Tests — tạo mới**
- `artifacts/api-server/src/lib/autopost-caption.test.ts`
- `artifacts/api-server/src/lib/autopost-pool.test.ts`
- `artifacts/api-server/src/lib/facebook-page-publish.test.ts`
- `artifacts/api-server/src/autopost-scheduler.test.ts`

---

## Bảng trạng thái bài viết (dùng xuyên suốt)

`unused → draft_ai → pending_review → approved → scheduled → (posting) → posted | failed | skipped`

- `draft_ai`: Claude vừa sinh caption, chưa đưa duyệt.
- `pending_review`: chờ admin duyệt (hiện 3 caption).
- `approved`/`scheduled`: admin đã duyệt, có `approved_by` + `scheduled_at`.
- `posting`: trạng thái khoá tạm khi scheduler đang đăng (chống đua).
- `posted`/`failed`/`skipped`: kết thúc.

---

# PHẦN 1 — MIGRATION SCHEMA

### Task 1.1: Drizzle schema `autopost.ts`

**Files:**
- Create: `lib/db/src/schema/autopost.ts`
- Modify: `lib/db/src/schema/index.ts`

- [ ] **Step 1: Viết schema** theo style `schema/dresses.ts` (pgTable, snake_case columns).

```ts
import { pgTable, serial, text, timestamp, numeric, boolean, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

export const autopostContentPool = pgTable("autopost_content_pool", {
  id: serial("id").primaryKey(),
  sourceType: text("source_type").notNull(),              // app_web | google_drive | upload
  sourceTable: text("source_table"),                      // dresses | gallery_albums | photo_ideas | service_packages | manual
  sourceItemId: text("source_item_id"),
  contentType: text("content_type").notNull(),            // vay_cuoi | ao_dai_cuoi | viet_phuc | beauty | makeup | hau_truong | feedback | album_cuoi | photo_idea | bill | reels | service | other
  title: text("title").notNull(),
  images: jsonb("images").notNull().default([]),
  price: numeric("price", { precision: 12, scale: 2 }),
  salePrice: numeric("sale_price", { precision: 12, scale: 2 }),
  goldenHourPercent: numeric("golden_hour_percent", { precision: 5, scale: 2 }),
  goldenHourName: text("golden_hour_name"),
  category: text("category"),
  badge: text("badge"),
  publicLink: text("public_link"),
  meta: jsonb("meta").notNull().default({}),
  imageHash: text("image_hash"),
  isEligible: boolean("is_eligible").notNull().default(true),
  ineligibleReason: text("ineligible_reason"),
  lastPostedAt: timestamp("last_posted_at", { withTimezone: true }),
  timesPosted: integer("times_posted").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uqSource: uniqueIndex("uq_autopost_pool_source").on(t.sourceTable, t.sourceItemId) }));

export const autopostSchedules = pgTable("autopost_schedules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  pageId: text("page_id"),
  timezone: text("timezone").notNull().default("Asia/Ho_Chi_Minh"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const autopostScheduleSlots = pgTable("autopost_schedule_slots", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id").notNull(),
  postTime: text("post_time").notNull(),                  // 'HH:MM' (giờ VN)
  contentType: text("content_type").notNull(),
  imageCount: integer("image_count").notNull().default(1),
  sourcePriority: text("source_priority").notNull().default("app_web"),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const autopostPosts = pgTable("autopost_posts", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id"),
  slotId: integer("slot_id"),
  contentPoolId: integer("content_pool_id"),
  pageId: text("page_id"),
  contentType: text("content_type"),
  images: jsonb("images").notNull().default([]),
  captionOptions: jsonb("caption_options").notNull().default([]),
  captionRecommendedIndex: integer("caption_recommended_index"),
  captionFinal: text("caption_final"),
  status: text("status").notNull().default("draft_ai"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  approvedBy: integer("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  facebookPostId: text("facebook_post_id"),
  facebookPostLink: text("facebook_post_link"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  captionHash: text("caption_hash"),
  imageHash: text("image_hash"),
  sourceType: text("source_type"),
  sourceItemId: text("source_item_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byStatus: index("ix_autopost_posts_status_sched").on(t.status, t.scheduledAt),
}));

export const autopostSettings = pgTable("autopost_settings", {
  id: integer("id").primaryKey().default(1),
  config: jsonb("config").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: integer("updated_by"),
});
```

- [ ] **Step 2:** Thêm vào `lib/db/src/schema/index.ts` dòng `export * from "./autopost";`
- [ ] **Step 3: Commit** — `git add lib/db/src/schema && git commit -m "feat(autopost): drizzle schema for autopost tables"`

### Task 1.2: Migration SQL chính thức

**Files:** Create `lib/db/migrations/0002_autopost_facebook.sql`

- [ ] **Step 1: Viết SQL idempotent** (chạy được nhiều lần):

```sql
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
```

- [ ] **Step 2: Commit** — `git add lib/db/migrations && git commit -m "feat(autopost): migration sql 0002"`

### Task 1.3: `ensureAutoPostSchema()` runtime + đăng ký router

**Files:**
- Create: `artifacts/api-server/src/lib/autopost-schema.ts`
- Modify: `artifacts/api-server/src/routes/index.ts`

- [ ] **Step 1:** `autopost-schema.ts` export `async function ensureAutoPostSchema()` chạy chính khối SQL ở Task 1.2 qua `pool.query` (bọc try/catch như `auth.ts:ensureAuthColumns`). Gọi 1 lần ở cuối `routes/auto-post-facebook.ts` khi import.
- [ ] **Step 2:** Trong `routes/index.ts`: `import autoPostFacebookRouter from "./auto-post-facebook";` và `router.use(autoPostFacebookRouter);` (cuối danh sách, sau `goldenHourRouter`).
- [ ] **Step 3: Verify (thủ công):** chạy API server dev → log `[AutoPost] schema ensured`; kiểm tra `\dt autopost_*` trong psql có 5 bảng.
- [ ] **Step 4: Commit** — `git commit -m "feat(autopost): ensureAutoPostSchema + register router"`

---

# PHẦN 2 — AI VISION (mở rộng để Claude đọc hình)

### Task 2.1: Mở rộng `ChatMessage` hỗ trợ ảnh

**Files:** Modify `artifacts/api-server/src/lib/ai-orchestrator.ts:24` (type) và `:126-146` (callClaude), `:148-186` (callOpenAI)

- [ ] **Step 1: Đổi type** (`ai-orchestrator.ts:24`):

```ts
export type ChatImage = { mediaType: string; dataBase64: string }; // media_type: image/jpeg|png|webp
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  /** Ảnh đính kèm (chỉ provider có vision dùng — Claude/gpt-4o). */
  images?: ChatImage[];
};
```

- [ ] **Step 2: callClaude** — build content blocks khi có ảnh (sửa `messages:` trong `client.messages.create`):

```ts
messages: req.messages.map((m) => {
  if (m.images?.length) {
    return {
      role: m.role,
      content: [
        ...m.images.map((img) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: img.mediaType as "image/jpeg", data: img.dataBase64 },
        })),
        { type: "text" as const, text: m.content },
      ],
    };
  }
  return { role: m.role, content: m.content };
}),
```

- [ ] **Step 3: callOpenAI** — map ảnh sang `image_url` data URL (gpt-4o vision) khi có ảnh:

```ts
...req.messages.map((m) => m.images?.length ? ({
  role: m.role,
  content: [
    { type: "text", text: m.content },
    ...m.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` } })),
  ],
}) : ({ role: m.role, content: m.content })),
```

- [ ] **Step 4: Degrade an toàn (Gemini/khác):** Gemini adapter chưa có (ném `no_key`) → orchestrator tự bỏ qua. Tài liệu hoá: nếu chuỗi provider rơi tới provider không vision, caption service (Task 4) sẽ **retry không kèm ảnh**. Không sửa thêm ở đây.
- [ ] **Step 5: Test** — `artifacts/api-server/src/lib/ai-orchestrator.vision.test.ts`:

```ts
import { describe, it, expect } from "vitest";
// Test thuần build-shape: tách hàm buildClaudeMessages(req) nếu cần để test không gọi mạng.
// Hoặc kiểm tra type-compile: message có images → content là mảng có block 'image'.
```

> Khuyến nghị: refactor đoạn map thành hàm thuần `buildClaudeMessages(messages)` export riêng để test không cần gọi API.

- [ ] **Step 6: Commit** — `git commit -m "feat(ai): vision (image blocks) support in callChat for claude + openai"`

### Task 2.2: Lấy bytes ảnh → base64 (`autopost-images.ts`)

**Files:** Create `artifacts/api-server/src/lib/autopost-images.ts`

- [ ] **Step 1:** Hàm `fetchImageAsBase64(url: string): Promise<ChatImage | null>` — `fetch(url)` (URL public từ object storage / web), giới hạn ≤ 5MB, suy ra `mediaType` từ `content-type`; trả `null` nếu lỗi/ảnh hỏng (phục vụ rule "không lấy ảnh lỗi"). Chỉ gửi **1 ảnh đại diện** cho vision (kiểm soát token).
- [ ] **Step 2:** Hàm `hashImageUrl(url): string` = `crypto.createHash('sha1').update(url).digest('hex')` (dùng cho dedupe + image_hash; ảnh nội bộ URL ổn định).
- [ ] **Step 3: Test** `autopost-images.test.ts` — mock `fetch` trả buffer nhỏ → `mediaType` đúng; trả 404 → `null`.
- [ ] **Step 4: Commit** — `git commit -m "feat(autopost): image fetch->base64 + hashing"`

---

# PHẦN 3 — CONTENT POOL SYNC

### Task 3.1: Sync nguồn app/web → pool (`autopost-pool.ts`)

**Files:** Create `artifacts/api-server/src/lib/autopost-pool.ts`

Tham chiếu cột public thật (mục Quy ước). Public link base = `process.env.PUBLIC_APP_URL` (vd `https://tranchistudio.com`).

- [ ] **Step 1: Sync dresses (cho thuê đồ + beauty/áo dài/việt phục)** — chỉ item public, đủ ảnh:

```ts
// SELECT phòng thủ: cột is_public/cms_status/sale_price/slug/cover_image_url... được cms.ts thêm runtime.
const r = await pool.query(`
  SELECT id, name, category,
         rental_price          AS price,
         sale_price            AS sale_price,
         COALESCE(cover_image_url, public_image_url, image_url) AS main_image,
         extra_images, outfit_tag, slug
    FROM dresses
   WHERE COALESCE(is_public, 0) = 1
     AND COALESCE(cms_status, 'visible') = 'visible'
     AND COALESCE(cover_image_url, public_image_url, image_url) IS NOT NULL
`);
```

Map mỗi row → upsert vào `autopost_content_pool` (`source_type='app_web'`, `source_table='dresses'`, `source_item_id=id::text`, `content_type` suy từ category: chứa "áo dài cưới"→`ao_dai_cuoi`, "việt phục"→`viet_phuc`, "beauty"→`beauty`, mặc định `vay_cuoi`), `images` = [main_image, ...extra_images], `public_link = PUBLIC_APP_URL + '/san-pham/' + slug`, `badge = outfit_tag`. Gắn `golden_hour_percent/name` bằng query `golden_hour_campaigns` (scope='dress' ref_id=id, hoặc scope='category' ref_id=category_id, `is_active` + trong khoảng thời gian) — đọc lại logic `attachGoldenHour` trong `routes/cms.ts` để khớp.

Upsert:
```ts
await pool.query(`
  INSERT INTO autopost_content_pool
    (source_type, source_table, source_item_id, content_type, title, images, price, sale_price,
     golden_hour_percent, golden_hour_name, category, badge, public_link, image_hash, is_eligible, updated_at)
  VALUES ('app_web','dresses',$1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,true, now())
  ON CONFLICT (source_table, source_item_id) DO UPDATE SET
    content_type=EXCLUDED.content_type, title=EXCLUDED.title, images=EXCLUDED.images,
    price=EXCLUDED.price, sale_price=EXCLUDED.sale_price,
    golden_hour_percent=EXCLUDED.golden_hour_percent, golden_hour_name=EXCLUDED.golden_hour_name,
    category=EXCLUDED.category, badge=EXCLUDED.badge, public_link=EXCLUDED.public_link,
    image_hash=EXCLUDED.image_hash, is_eligible=true, ineligible_reason=NULL, updated_at=now()
`, [...]);
```

- [ ] **Step 2: Sync gallery_albums (album cưới)** — `WHERE status='visible' AND cover_image_url IS NOT NULL`; lấy thêm tối đa N ảnh con từ `gallery_photos WHERE album_id=? AND status='visible'`. `content_type='album_cuoi'`, `public_link = PUBLIC_APP_URL + '/bo-anh/' + slug`.
- [ ] **Step 3: Sync photo_ideas (ý tưởng chụp ảnh)** — `WHERE visibility_status='public' AND deleted_at IS NULL`. `content_type='photo_idea'`, `public_link = PUBLIC_APP_URL + '/y-tuong-chup-anh'`.
- [ ] **Step 4: Đánh dấu hết hạn:** item đã có trong pool (`source_type='app_web'`) mà query trên KHÔNG còn trả về → `UPDATE … SET is_eligible=false, ineligible_reason='unpublished_or_no_image'`. (Không xoá để giữ lịch sử; loại khỏi việc chọn đăng.)
- [ ] **Step 5: Export** `async function syncAppWebPool(): Promise<{dresses:number; albums:number; ideas:number}>`.
- [ ] **Step 6: Test** `autopost-pool.test.ts` — seed `dresses` (1 public + 1 ẩn + 1 hết ảnh), chạy sync, assert pool chỉ chứa item public-có-ảnh; chạy sync lần 2 → không nhân đôi (unique source).
- [ ] **Step 7: Commit** — `git commit -m "feat(autopost): content pool sync from app/web sources"`

### Task 3.2: Upload thủ công vào pool

**Files:** Modify `artifacts/api-server/src/lib/autopost-pool.ts` (thêm `addManualPoolItem`)

- [ ] **Step 1:** `addManualPoolItem({contentType, title, images, price?, category?, badge?, publicLink?})` → INSERT `source_type='upload'`, `source_table='manual'`, `source_item_id=NULL`. Ảnh dùng URL trả về từ `POST /storage/uploads/request-url` (client upload trước, gửi objectPath).
- [ ] **Step 2: Test** — gọi `addManualPoolItem` → row tồn tại, `is_eligible=true`.
- [ ] **Step 3: Commit** — `git commit -m "feat(autopost): manual upload pool item"`

---

# PHẦN 4 — CLAUDE CAPTION 3 MẪU

### Task 4.1: Caption service + price-guard (`autopost-caption.ts`)

**Files:** Create `artifacts/api-server/src/lib/autopost-caption.ts`

- [ ] **Step 1: System prompt** (giọng Amazing Studio, ràng buộc spec mục 3):

```ts
function buildSystem(item: PoolItem, tone: string, bannedWords: string[]): string {
  return [
    `Bạn là người viết caption Facebook cho Amazing Studio (studio chụp ảnh cưới & beauty).`,
    `Giọng: ${tone || "ấm áp, tự nhiên, sang trọng, KHÔNG sáo rỗng, KHÔNG như robot"}.`,
    `QUY TẮC BẮT BUỘC:`,
    `- Chỉ dùng số tiền/khuyến mãi ĐÚNG theo dữ liệu được cung cấp. TUYỆT ĐỐI không bịa giá.`,
    `- Đúng loại dịch vụ: ${item.contentType}. Không nói sai sang dịch vụ khác.`,
    `- Không dùng từ nhạy cảm/cấm của Facebook${bannedWords.length ? `: ${bannedWords.join(", ")}` : ""}.`,
    `- Caption ngắn gọn 2-4 câu, có thể thêm 2-4 hashtag thuần Việt.`,
    item.publicLink ? `- Cuối caption chèn link: ${item.publicLink}` : ``,
    `TRẢ JSON: {"captions":["...","...","..."],"recommendedIndex":0}`,
  ].filter(Boolean).join("\n");
}
```

- [ ] **Step 2: User message + metadata + ảnh:**

```ts
const userText = [
  `Tên: ${item.title}`,
  item.price ? `Giá thuê: ${formatVnd(item.price)}` : ``,
  item.salePrice ? `Giá sale: ${formatVnd(item.salePrice)}` : ``,
  item.goldenHourPercent ? `Giờ vàng: giảm ${item.goldenHourPercent}% (${item.goldenHourName ?? "Giờ vàng"})` : ``,
  item.category ? `Danh mục: ${item.category}` : ``,
  item.badge ? `Nhãn: ${item.badge}` : ``,
].filter(Boolean).join("\n");
const image = item.images[0] ? await fetchImageAsBase64(resolvePublicUrl(item.images[0])) : null;
```

- [ ] **Step 3: Gọi orchestrator (vision + jsonMode) + degrade:**

```ts
export async function generateCaptions(item: PoolItem, opts: {tone:string; banned:string[]}) {
  const image = item.images[0] ? await fetchImageAsBase64(resolvePublicUrl(item.images[0])) : null;
  const baseMsg = { role: "user" as const, content: buildUser(item) };
  const res = await callChat({
    system: buildSystem(item, opts.tone, opts.banned),
    messages: [ image ? { ...baseMsg, images: [image] } : baseMsg ],
    jsonMode: true, maxTokens: 700, label: "autopost-caption",
  });
  if (!res.ok && image) {
    // provider rơi sang loại không vision → thử lại metadata-only
    return retryNoImage(item, opts);
  }
  if (!res.ok) throw new Error(res.adminAlert);
  const parsed = JSON.parse(res.text) as { captions: string[]; recommendedIndex: number };
  const captions = parsed.captions.map((c) => priceGuard(c, item)).slice(0, 3);
  return { captions, recommendedIndex: Math.min(parsed.recommendedIndex ?? 0, captions.length - 1), provider: res.providerUsed };
}
```

- [ ] **Step 4: price-guard** (chống bịa giá — mục 8):

```ts
// Trích mọi cụm số tiền trong caption; nếu có số tiền KHÔNG khớp price/salePrice của item → đánh dấu nghi vấn.
export function priceGuard(caption: string, item: PoolItem): string {
  const allowed = new Set([item.price, item.salePrice].filter(Boolean).map((n) => Math.round(Number(n))));
  const found = [...caption.matchAll(/(\d[\d.,]{2,})\s*(k|đ|vnd|nghìn|triệu)?/gi)].map((m) => normalizeMoney(m));
  const bad = found.filter((n) => n != null && !allowed.has(n));
  if (bad.length) {
    // Không tự sửa số — gắn cờ để admin thấy & buộc duyệt tay (an toàn hơn auto-strip).
    return `⚠️[KIỂM TRA GIÁ] ` + caption;
  }
  return caption;
}
```

- [ ] **Step 5: Test** `autopost-caption.test.ts`:
  - `priceGuard` giữ nguyên caption đúng giá; gắn `⚠️` khi caption chứa giá lạ.
  - `generateCaptions` với `callChat` mock (vi.mock) trả JSON 3 caption → trả đúng 3, recommendedIndex hợp lệ.
  - Mock `callChat` trả `{ok:false}` + có ảnh → gọi nhánh retry metadata-only.
- [ ] **Step 6: Commit** — `git commit -m "feat(autopost): claude caption generation (vision) + price-guard"`

---

# PHẦN 5 — ADMIN DUYỆT BÀI

### Task 5.1: Router CRUD pool/lịch/bài (`auto-post-facebook.ts`)

**Files:** Create `artifacts/api-server/src/routes/auto-post-facebook.ts` (theo y khuôn `routes/golden-hour.ts`: `requireAdmin`, raw `pool.query`, alias camelCase)

- [ ] **Step 1: Khung router + ensure schema:**

```ts
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getCallerRole, verifyToken } from "./auth";
import { ensureAutoPostSchema } from "../lib/autopost-schema";
import { syncAppWebPool, addManualPoolItem } from "../lib/autopost-pool";
import { generateCaptions } from "../lib/autopost-caption";

const router: IRouter = Router();
void ensureAutoPostSchema();
async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  if ((await getCallerRole(req.headers.authorization)) !== "admin") { res.status(403).json({ error: "Chỉ admin được phép" }); return false; }
  return true;
}
```

- [ ] **Step 2: Pool endpoints:**
  - `POST /autopost/pool/sync` → `await syncAppWebPool()` → trả counts.
  - `GET  /autopost/pool?contentType=&sourceType=&eligible=` → list (LIMIT/OFFSET).
  - `POST /autopost/pool/upload` → `addManualPoolItem(req.body)`.
  - `PATCH /autopost/pool/:id` → cập nhật `is_eligible`/title/badge.
  - `DELETE /autopost/pool/:id`.
- [ ] **Step 3: Schedule endpoints:** `GET/POST/PUT/DELETE /autopost/schedules` (+ slots con: lưu/đọc cùng schedule), `POST /autopost/schedules/:id/toggle`.
- [ ] **Step 4: Post review endpoints:**
  - `GET /autopost/posts?status=` → list + join pool (title, images).
  - `GET /autopost/posts/:id`.
  - `POST /autopost/posts/generate` body `{poolId, scheduleId?, slotId?, imageCount?}` → chọn ảnh, `generateCaptions`, INSERT post `status='pending_review'`, lưu `caption_options`, `image_hash`, `source_type/source_item_id` (denormalize), `emitNotification({staffId:null, type:'autopost_pending', title, message})`.
  - `PATCH /autopost/posts/:id` → admin sửa/chọn caption: set `caption_final`, `caption_recommended_index`.
  - `POST /autopost/posts/:id/approve` body `{captionFinal, scheduledAt}` → validate có `caption_final`; set `status='approved'`, `approved_by=verifyToken(...)`, `approved_at=now()`, `scheduled_at=$`, `caption_hash=sha1(caption_final)`.
  - `POST /autopost/posts/:id/skip` → `status='skipped'`.
  - `POST /autopost/posts/:id/retry` → chỉ khi `status='failed'`: reset `status='approved'`, `error_message=NULL`.
- [ ] **Step 5: Settings + FB test:**
  - `GET/PUT /autopost/settings` → đọc/ghi `autopost_settings.config` (tone, bannedWords, defaultPageId, driveConfig).
  - `POST /autopost/facebook/test` → gọi `verifyPageToken()` (Task 7) → trả page name + quyền.
- [ ] **Step 6: Test** — supertest/vitest: `POST /autopost/posts/:id/approve` không có token admin → 403; có caption_final + scheduledAt → 200 và row `status='approved'`, `approved_by` đúng.
- [ ] **Step 7: Commit** — `git commit -m "feat(autopost): admin router (pool/schedules/posts/approve/settings)"`

---

# PHẦN 6 — SCHEDULER THEO GIỜ

### Task 6.1: `autopost-scheduler.ts`

**Files:** Create `artifacts/api-server/src/autopost-scheduler.ts`; Modify `artifacts/api-server/src/app.ts`

Theo khuôn `follow-up-scheduler.ts` (env gate, setTimeout→setInterval, atomic claim).

- [ ] **Step 1: Boot:**

```ts
export function startAutoPostScheduler(): void {
  const on = (process.env.ENABLE_AUTO_POST_FACEBOOK ?? "").toLowerCase();
  if (!["true","1","yes"].includes(on)) { console.log("[AutoPost] scheduler tắt (ENABLE_AUTO_POST_FACEBOOK)"); return; }
  const sec = Math.max(60, parseInt(process.env.AUTO_POST_CHECK_INTERVAL_SEC ?? "120", 10) || 120);
  const run = () => runAutoPostTick().catch((e) => console.error("[AutoPost] tick lỗi:", e));
  setTimeout(() => { run(); setInterval(run, sec * 1000); }, 30_000);
  console.log(`[AutoPost] scheduler khởi động — poll mỗi ${sec}s`);
}
```

- [ ] **Step 2: Tick** = `generatePendingPosts()` (sinh sẵn bài chờ duyệt theo slot, lookahead 24h, chỉ khi thiếu) + `publishDuePosts()`.
- [ ] **Step 3: `publishDuePosts()` — atomic claim chống đua** (theo `follow-up-scheduler.ts:213-265`):

```ts
const due = await pool.query(`
  SELECT id, page_id, images, caption_final, content_pool_id, image_hash, caption_hash
    FROM autopost_posts
   WHERE status IN ('approved','scheduled') AND approved_by IS NOT NULL
     AND scheduled_at IS NOT NULL AND scheduled_at <= now()
   ORDER BY scheduled_at ASC LIMIT 10`);
for (const post of due.rows) {
  // claim: chỉ 1 worker chiếm được
  const claim = await pool.query(
    `UPDATE autopost_posts SET status='posting', updated_at=now()
      WHERE id=$1 AND status IN ('approved','scheduled') RETURNING id`, [post.id]);
  if (claim.rowCount === 0) continue;
  try {
    const { postId, permalink } = await publishToPage({ pageId: post.page_id, message: post.caption_final, imageUrls: post.images });
    await pool.query(`UPDATE autopost_posts SET status='posted', facebook_post_id=$2, facebook_post_link=$3, posted_at=now(), updated_at=now() WHERE id=$1`, [post.id, postId, permalink]);
    await pool.query(`UPDATE autopost_content_pool SET times_posted=times_posted+1, last_posted_at=now() WHERE id=$1`, [post.content_pool_id]);
  } catch (e) {
    await pool.query(`UPDATE autopost_posts SET status='failed', error_message=$2, retry_count=retry_count+1, updated_at=now() WHERE id=$1`, [post.id, String((e as Error).message).slice(0,300)]);
    emitNotification({ staffId: null, type: "autopost_failed", priority: "urgent", title: "AutoPost lỗi", message: `Bài #${post.id}: ${String((e as Error).message).slice(0,120)}` });
  }
}
```

- [ ] **Step 4: Timezone VN** — `generatePendingPosts` tính `scheduled_at` cho slot `post_time='HH:MM'` theo `Asia/Ho_Chi_Minh` rồi đổi sang UTC khi lưu (`timestamptz`). Dùng `Intl.DateTimeFormat('en-US',{timeZone:'Asia/Ho_Chi_Minh'})` hoặc offset +07:00 cố định (VN không DST) → đơn giản: `new Date(\`${ymd}T${time}:00+07:00\`)`.
- [ ] **Step 5: Dedupe** — trước khi tạo/đăng, bỏ qua nếu đã có `posted` cùng `page_id`+`image_hash` hoặc `caption_hash` (unique index sẽ chặn cứng; code chủ động skip để không tạo `failed` rác).
- [ ] **Step 6: app.ts** — thêm `import { startAutoPostScheduler } from "./autopost-scheduler";` và gọi `startAutoPostScheduler();` cạnh các scheduler khác (`app.ts:51-54`).
- [ ] **Step 7: Test** `autopost-scheduler.test.ts` — mock `publishToPage`: (a) due post → `posted` + lưu id/link + pool.times_posted++; (b) publish ném lỗi → `failed` + emitNotification gọi; (c) post `pending_review` KHÔNG bị đăng; (d) claim chạy 2 lần liên tiếp chỉ đăng 1 lần.
- [ ] **Step 8: Commit** — `git commit -m "feat(autopost): scheduler tick (generate + publish due) with atomic claim + VN tz"`

---

# PHẦN 7 — FACEBOOK PUBLISH + DRY_RUN

### Task 7.1: `facebook-page-publish.ts`

**Files:** Create `artifacts/api-server/src/lib/facebook-page-publish.ts`

- [ ] **Step 1: Token + page resolve** (theo `follow-up-scheduler.ts:8-17`):

```ts
const GRAPH = "https://graph.facebook.com/v22.0";
async function getPageToken(): Promise<string | null> {
  const r = await pool.query(`SELECT value FROM settings WHERE key='fb_page_access_token' LIMIT 1`);
  return r.rows[0]?.value ?? process.env.FB_PAGE_ACCESS_TOKEN ?? null;
}
async function resolvePageId(pageId?: string): Promise<string | null> {
  if (pageId) return pageId;
  const r = await pool.query(`SELECT value FROM settings WHERE key='fb_active_page_id' LIMIT 1`);
  return r.rows[0]?.value ?? process.env.FB_PAGE_ID ?? null;
}
function isDryRun(): boolean { return (process.env.AUTOPOST_DRY_RUN ?? "true").toLowerCase() !== "false"; }
```

- [ ] **Step 2: publishToPage** — 1 ảnh dùng `/{page}/photos`; nhiều ảnh upload `published=false` rồi `/{page}/feed` + `attached_media`:

```ts
export async function publishToPage(p: { pageId?: string; message: string; imageUrls: string[] }):
  Promise<{ postId: string; permalink: string | null }> {
  const token = await getPageToken();
  const pageId = await resolvePageId(p.pageId);
  if (!token || !pageId) throw new Error("Thiếu fb_page_access_token hoặc page_id");
  const urls = (p.imageUrls ?? []).map(resolvePublicUrl).filter(Boolean);

  if (isDryRun()) {
    console.log(`[AutoPost][DRY_RUN] page=${pageId} imgs=${urls.length} caption="${p.message.slice(0,60)}…"`);
    return { postId: `dryrun_${Date.now()}`, permalink: null };
  }

  if (urls.length <= 1) {
    const body = new URLSearchParams({ access_token: token, caption: p.message, ...(urls[0] ? { url: urls[0] } : {}) });
    const r = await fetch(`${GRAPH}/${pageId}/photos`, { method: "POST", body });
    const j = await r.json();
    if (!r.ok) throw new Error(`FB photos ${r.status}: ${JSON.stringify(j).slice(0,200)}`);
    return { postId: j.post_id ?? j.id, permalink: j.post_id ? `https://www.facebook.com/${j.post_id}` : null };
  }

  const mediaFbids: string[] = [];
  for (const url of urls.slice(0, 10)) {
    const body = new URLSearchParams({ access_token: token, url, published: "false" });
    const r = await fetch(`${GRAPH}/${pageId}/photos`, { method: "POST", body });
    const j = await r.json();
    if (!r.ok) throw new Error(`FB upload ${r.status}: ${JSON.stringify(j).slice(0,200)}`);
    mediaFbids.push(j.id);
  }
  const feedBody: any = { access_token: token, message: p.message };
  mediaFbids.forEach((id, i) => { feedBody[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  const r = await fetch(`${GRAPH}/${pageId}/feed`, { method: "POST", body: new URLSearchParams(feedBody) });
  const j = await r.json();
  if (!r.ok) throw new Error(`FB feed ${r.status}: ${JSON.stringify(j).slice(0,200)}`);
  return { postId: j.id, permalink: `https://www.facebook.com/${j.id}` };
}
```

- [ ] **Step 3: verifyPageToken()** — `GET /{pageId}?fields=name,access_token` + `GET /me/permissions`; trả `{ok, pageName, canPost}` cho endpoint test (Task 5 Step 5).
- [ ] **Step 4: Test** `facebook-page-publish.test.ts` — set `AUTOPOST_DRY_RUN=true` → `publishToPage` KHÔNG fetch, trả `dryrun_*`. Mock `fetch`: 1 ảnh → gọi `/photos`; 3 ảnh → 3 lần `published=false` + 1 `/feed`; response !ok → throw.
- [ ] **Step 5: Commit** — `git commit -m "feat(autopost): facebook page publish (photos/feed) + DRY_RUN + verify"`

### Task 7.2: Biến môi trường

**Files:** Modify `.env.example`

- [ ] **Step 1:** Thêm:
```
# ─── AutoPost Facebook ───
ENABLE_AUTO_POST_FACEBOOK=false
AUTO_POST_CHECK_INTERVAL_SEC=120
AUTOPOST_DRY_RUN=true
# Page đăng bài (hoặc dùng settings.fb_active_page_id)
FB_PAGE_ID=
# PUBLIC_APP_URL dùng cho public_link caption (đã có ở phần Claude)
```
- [ ] **Step 2: Commit** — `git commit -m "chore(autopost): env example vars"`

---

# PHẦN 8 — UI ADMIN 7 MÀN

### Task 8.1: API client helper (`autopost-api.ts`)

**Files:** Create `artifacts/amazing-studio/src/lib/autopost-api.ts`

- [ ] **Step 1:** `authFetch` (token `amazingStudioToken_v2` + `getApiBase()`) + hàm `apGet/apPost/apPut/apPatch/apDelete`; export TanStack hooks: `usePool`, `useSchedules`, `usePosts(status)`, `useGenerate`, `useApprove`, `useSyncPool`, `useSettings`. (Theo pattern `authFetch` ở `layout.tsx:115` + `useQuery/useMutation`.)
- [ ] **Step 2: Commit** — `git commit -m "feat(autopost-ui): api client hooks"`

### Task 8.2: Trang admin 7 tab (`auto-post-facebook.tsx`)

**Files:** Create `artifacts/amazing-studio/src/pages/auto-post-facebook.tsx`; Modify `App.tsx`, `components/layout.tsx`

Dùng shadcn (`@/components/ui/*`), `useToast`. 7 tab khớp spec mục 7:

- [ ] **Step 1: Tab "Lịch đăng bài"** — bảng `useSchedules`, dialog tạo lịch + editor slots (giờ/loại/số ảnh/nguồn/bật-tắt), preset nhanh "7 bài/ngày" và "10 bài/ngày".
- [ ] **Step 2: Tab "Kho nội dung"** — lưới `usePool`, filter contentType/source, nút **Sync app/web** (`useSyncPool`) + **Upload** (qua `/storage/uploads/request-url`).
- [ ] **Step 3: Tab "Bài chờ duyệt"** ⭐ — `usePosts('pending_review')`: mỗi card hiện ảnh + 3 caption (radio chọn), textarea sửa tay, ô chọn `scheduledAt`, nút **Duyệt đăng** (`useApprove`). Caption có `⚠️[KIỂM TRA GIÁ]` hiển thị badge cảnh báo đỏ.
- [ ] **Step 4: Tab "Bài đã lên lịch"** — `usePosts('approved')` + `'scheduled'`, sửa giờ / huỷ (skip).
- [ ] **Step 5: Tab "Lịch sử đã đăng"** — `usePosts('posted')` + `'failed'`: link `facebook_post_link`, nút **Đăng lại** cho `failed`.
- [ ] **Step 6: Tab "Cấu hình Facebook Page"** — form token/page (lưu qua settings) + nút **Test** (`POST /autopost/facebook/test`) hiện page name + trạng thái quyền + nhắc DRY_RUN.
- [ ] **Step 7: Tab "Cấu hình Claude / Drive"** — `useSettings`: tone, từ cấm, default page; mục Drive để trống (Phase 2).
- [ ] **Step 8: Route + nav:**
  - `App.tsx`: `import AutoPostFacebookPage from "@/pages/auto-post-facebook";` + `<Route path="/auto-post-facebook" component={() => <AdminRoute component={AutoPostFacebookPage} />} />` (trong `InternalRouter`); thêm `"/auto-post-facebook"` vào `INTERNAL_PREFIXES`.
  - `layout.tsx`: thêm vào `ALL_NAV_ITEMS`: `{ href: "/auto-post-facebook", label: "AutoPost Facebook", icon: Share2, adminOnly: true }` (import `Share2` từ lucide-react).
- [ ] **Step 9: Verify (preview)** — chạy web, vào `/auto-post-facebook`: 7 tab render, nút Sync gọi API, tab chờ duyệt hiện 3 caption.
- [ ] **Step 10: Commit** — `git commit -m "feat(autopost-ui): admin page (7 tabs) + route + nav"`

---

# PHẦN 9 — TEST ĐẦY ĐỦ

### Task 9.1: Checklist test tự động (vitest)

- [ ] `ai-orchestrator.vision`: message có ảnh → content blocks đúng (image + text).
- [ ] `autopost-images`: content-type→mediaType; ảnh lỗi/404→null; >5MB→null.
- [ ] `autopost-caption`: priceGuard (đúng giá giữ nguyên / giá lạ gắn ⚠️); generateCaptions mock → 3 caption; fallback no-vision khi `{ok:false}`+ảnh.
- [ ] `autopost-pool`: sync chỉ lấy public+có-ảnh; sync 2 lần không nhân đôi; item bị ẩn → `is_eligible=false`.
- [ ] `auto-post-facebook` route: approve cần admin + caption_final; generate tạo `pending_review` + emitNotification.
- [ ] `facebook-page-publish`: DRY_RUN không fetch; 1 ảnh→/photos; nhiều ảnh→/feed; lỗi→throw.
- [ ] `autopost-scheduler`: due→posted; lỗi→failed+notify; pending_review không đăng; claim 2 lần chỉ đăng 1.

Lệnh: `pnpm --filter @workspace/api-server exec vitest run src/lib/autopost-*.test.ts src/autopost-scheduler.test.ts`
Expected: tất cả PASS.

### Task 9.2: Checklist test thủ công (theo thứ tự)

- [ ] **DB:** chạy server → `\dt autopost_*` đủ 5 bảng; `autopost_settings` có 1 row id=1.
- [ ] **Pool:** bấm Sync → đếm dresses/albums/ideas > 0; item ẩn không vào pool.
- [ ] **Caption:** Generate 1 bài từ váy cưới có giá → 3 caption, không bịa giá, có link; bài giá sale hiển thị đúng %.
- [ ] **Duyệt:** đổi caption tay → Duyệt đăng (đặt giờ +2 phút) → bài sang `approved`.
- [ ] **DRY_RUN:** `AUTOPOST_DRY_RUN=true`, `ENABLE_AUTO_POST_FACEBOOK=true` → tới giờ, log `[DRY_RUN]`, bài KHÔNG đăng thật, không sang `posted`? (DRY_RUN vẫn set `posted` với id `dryrun_*` để test luồng — kiểm tra link rỗng).
- [ ] **Page thật:** có token quyền `pages_manage_posts` → `AUTOPOST_DRY_RUN=false`, test trên **page nháp** trước → bài lên Page, lưu `facebook_post_id/link`.
- [ ] **Lỗi:** token sai → bài `failed`, admin nhận notification.
- [ ] **Dedupe:** duyệt 2 bài cùng ảnh/caption → bài thứ 2 bị chặn (unique index) → `failed`/skip có log.
- [ ] **An toàn:** kiểm tra KHÔNG có bản ghi mới ở bookings/payments/attendance; ảnh gốc dresses/albums không bị sửa/xoá.

---

# PHẦN 10 — CÁCH DEPLOY AN TOÀN

### Task 10.1: Thứ tự bật tính năng (rollout)

- [ ] **B1 — Schema:** deploy code, để `ENABLE_AUTO_POST_FACEBOOK=false`. `ensureAutoPostSchema()` tạo bảng (idempotent, không đụng bảng cũ). Xác nhận app cũ chạy bình thường.
- [ ] **B2 — Pool + UI:** bật trang admin, chạy Sync, kiểm tra pool. Scheduler vẫn tắt.
- [ ] **B3 — Caption + Duyệt:** generate + duyệt vài bài, vẫn `ENABLE_AUTO_POST_FACEBOOK=false` (không đăng).
- [ ] **B4 — DRY_RUN:** `ENABLE_AUTO_POST_FACEBOOK=true` + `AUTOPOST_DRY_RUN=true`. Quan sát log "sẽ đăng" đúng giờ trong 1 ngày.
- [ ] **B5 — Page nháp:** lấy token quyền đăng → `AUTOPOST_DRY_RUN=false`, page test. Theo dõi `posted`/`failed`.
- [ ] **B6 — Page thật:** đổi `fb_active_page_id`/`FB_PAGE_ID` sang page chính. Bắt đầu số bài/ngày thấp (2-3) rồi tăng.

### Task 10.2: Bí mật & an toàn deploy

- [ ] Token chỉ ở `settings.fb_page_access_token` / env. KHÔNG hardcode, KHÔNG commit `.env` (đã trong `.gitignore`).
- [ ] Không commit ảnh khách/upload (kiểm `.gitignore` có `uploads/`).
- [ ] `ANTHROPIC_API_KEY` đã có sẵn (dùng chung) — không thêm key mới vào code.

### Rủi ro & Rollback

| Rủi ro | Phát hiện | Rollback |
|---|---|---|
| Meta chưa duyệt `pages_manage_posts` | endpoint Test báo `canPost=false`; bài `failed` 403/200#permission | Giữ `AUTOPOST_DRY_RUN=true`; xin quyền; không ảnh hưởng app. |
| Scheduler đăng sai/spam | Lịch sử đăng tăng bất thường | Set `ENABLE_AUTO_POST_FACEBOOK=false` (tắt ngay, không cần deploy). |
| Claude bịa giá | caption có `⚠️[KIỂM TRA GIÁ]` | Bắt buộc admin duyệt; không bao giờ auto-approve. |
| Token hết hạn | bài `failed`, Test báo lỗi | Cập nhật token trong tab Cấu hình. |
| Bảng autopost lỗi | log `ensureAutoPostSchema` | `DROP TABLE autopost_*` (chỉ bảng module) — KHÔNG đụng bảng nghiệp vụ. |
| Lệch giờ VN | bài đăng sai giờ | Kiểm `timezone` slot = `Asia/Ho_Chi_Minh`, build `+07:00`. |

**Rollback toàn module (an toàn tuyệt đối):** `ENABLE_AUTO_POST_FACEBOOK=false` + ẩn nav item. Code module độc lập, không sửa logic nghiệp vụ cũ → tắt là về nguyên trạng.

---

## Phân pha MVP

**Phase 1 (MVP — làm theo plan này):**
- Nguồn: `dresses` (cho thuê đồ + beauty/áo dài/việt phục) + `gallery_albums` (album cưới) + `photo_ideas` + **upload thủ công**.
- Caption: **vision** (Claude đọc ảnh đại diện) + metadata, có price-guard.
- Đăng Page: full + **DRY_RUN** trước, rồi page nháp → page thật.
- 7 màn admin + duyệt thủ công bắt buộc.

**Phase 2 (sau khi MVP ổn — KHÔNG làm trong plan này):**
- Google Drive / folder nội bộ (hậu trường, makeup, feedback khách, bill, reels).
- Vision đa ảnh / phân tích chất lượng ảnh nâng cao.
- `feedback` / `bill` từ nguồn riêng (hiện CMS chưa có bảng).
- Multi-page đồng thời; A/B caption; thống kê hiệu quả bài đăng (reach/engagement) qua Graph insights.

---

## Self-Review (đã rà)

1. **Spec coverage:** mục 1 (Pool đa nguồn + metadata) → Task 3; mục 2 (lịch/slot) → Task 1.1+5+8; mục 3 (3 caption, vision, không bịa giá, từ cấm, link) → Task 2+4; mục 4 (duyệt) → Task 5; mục 5 (đăng + lưu id/link, chống trùng) → Task 6+7; mục 6 (status enum) → schema Task 1; mục 7 (7 màn) → Task 8; mục 8 (an toàn) → Quy ước + Task 6/10; mục 9 (MVP) → Phân pha; mục 10 (kiểm tra code + trình kế hoạch) → đã khảo sát, plan này.
2. **Placeholder scan:** không có TODO/TBD; các đoạn CRUD/UI tham chiếu file pattern thật (`golden-hour.ts`, `layout.tsx`) thay vì lặp boilerplate.
3. **Type consistency:** `ChatImage` (Task 2) dùng lại ở `autopost-images`/`autopost-caption`; `publishToPage({pageId,message,imageUrls})` thống nhất giữa Task 6 và 7; `status` enum thống nhất toàn plan.

## Execution Handoff

Plan đã lưu. Hai cách thực thi:
1. **Subagent-Driven (khuyến nghị)** — mỗi task 1 subagent, review giữa các task.
2. **Inline** — thực thi tuần tự trong phiên, checkpoint theo từng PHẦN.
