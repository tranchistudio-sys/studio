/**
 * autopost-scheduler.ts — Scheduler đăng bài Facebook tự động (Task 6).
 *
 * Theo khuôn `follow-up-scheduler.ts`: env-gate + setTimeout→setInterval +
 * atomic-claim chống đua (race). Mỗi tick gồm 2 việc:
 *   1) generatePendingPosts() — sinh sẵn bài CHỜ DUYỆT cho các slot lịch sắp tới
 *      (lookahead 24h, chỉ tạo khi còn thiếu). KHÔNG tự đăng.
 *   2) publishDuePosts()      — đăng các bài ĐÃ DUYỆT (approved/scheduled) tới giờ.
 *
 * AN TOÀN (spec mục 8):
 *  - CHỈ đăng bài đã duyệt: publishDuePosts chỉ lấy status IN ('approved','scheduled')
 *    + approved_by IS NOT NULL + caption_final IS NOT NULL.
 *  - Atomic claim (UPDATE ... WHERE status IN (...) RETURNING) → chỉ 1 worker đăng 1 bài.
 *  - Dedupe: bỏ qua (skip) nếu đã có bài 'posted' cùng page + image_hash/caption_hash —
 *    chặn TRƯỚC khi gọi Graph API (tránh spam), bổ trợ cho unique index ở DB.
 *  - Mọi lần đăng đi qua cờ AUTOPOST_DRY_RUN (mặc định BẬT) trong facebook-page-publish.
 *  - CHỈ ghi vào bảng autopost_*; không đụng bảng nghiệp vụ.
 *
 * ENV (KHÔNG sửa .env — chỉ đọc lúc runtime):
 *  - ENABLE_AUTO_POST_FACEBOOK: "true"|"1"|"yes" mới bật scheduler. Mặc định TẮT.
 *  - AUTO_POST_CHECK_INTERVAL_SEC: chu kỳ poll (giây). Mặc định 120, tối thiểu 60.
 *  - AUTOPOST_DRY_RUN: xem facebook-page-publish.ts (mặc định true).
 */
import { pool } from "@workspace/db";
import { publishToPage, isDryRun } from "./lib/facebook-page-publish";
import { generateCaptions } from "./lib/autopost-caption";
import { emitNotification } from "./routes/notifications";
import { poolRowToCaptionItem, clampImages, sha1 } from "./lib/autopost-route-helpers";

const TAG = "[AutoPost]";

/** Số bài chờ-duyệt tối đa được tự sinh trong 1 tick (chặn tốn token/đua). */
const MAX_NEW_PER_TICK = 5;

// ─────────────────────────── PURE HELPERS ────────────────────────────────────

/** Parse trường images jsonb (đã là mảng) hoặc chuỗi JSON → string[]. Không throw. */
function toImageArray(raw: unknown): string[] {
  try {
    let arr: unknown = raw;
    if (typeof raw === "string") arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Tính thời điểm (Date UTC) cho một slot `post_time='HH:MM'` theo GIỜ VIỆT NAM
 * (Asia/Ho_Chi_Minh = UTC+7, không DST) tại `dayOffset` ngày so với hôm nay (giờ VN).
 * Trả null nếu post_time không hợp lệ.
 */
export function computeSlotDateUtc(postTime: string, dayOffset: number, nowMs: number): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((postTime || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 23 || mm > 59) return null;
  // Lịch "hôm nay" theo giờ VN: dịch now sang +7h rồi đọc field UTC.
  const vn = new Date(nowMs + 7 * 3600_000);
  const y = vn.getUTCFullYear();
  const mo = vn.getUTCMonth();
  const d = vn.getUTCDate() + dayOffset;
  // Wall-clock VN (y,mo,d,hh,mm) ↔ UTC = wall-clock − 7h.
  return new Date(Date.UTC(y, mo, d, hh, mm, 0) - 7 * 3600_000);
}

// ─────────────────────────── PUBLISH DUE ─────────────────────────────────────

type DuePost = {
  id: number;
  page_id: string | null;
  images: unknown;
  caption_final: string;
  content_pool_id: number | null;
  image_hash: string | null;
  caption_hash: string | null;
};

/**
 * Đăng các bài đã duyệt tới giờ. Atomic-claim chống đua, dedupe chống trùng,
 * báo lỗi admin khi thất bại. Không bao giờ throw (tự bắt mọi lỗi).
 */
export async function publishDuePosts(nowMs: number = Date.now()): Promise<{ posted: number; failed: number; skipped: number }> {
  void nowMs; // scheduled_at <= now() được DB đánh giá; nowMs giữ cho test/đối xứng API.
  let posted = 0;
  let failed = 0;
  let skipped = 0;

  let due: { rows: DuePost[] };
  try {
    due = await pool.query(
      `SELECT id, page_id, images, caption_final, content_pool_id, image_hash, caption_hash
         FROM autopost_posts
        WHERE status IN ('approved','scheduled')
          AND approved_by IS NOT NULL
          AND caption_final IS NOT NULL
          AND scheduled_at IS NOT NULL
          AND scheduled_at <= now()
        ORDER BY scheduled_at ASC
        LIMIT 10`,
    );
  } catch (e) {
    console.error(`${TAG} query bài tới giờ lỗi:`, e);
    return { posted, failed, skipped };
  }

  for (const post of due.rows) {
    // ── Atomic claim: chỉ worker đầu tiên chiếm được bài (đổi sang 'posting'). ──
    let claim: { rowCount: number | null };
    try {
      claim = await pool.query(
        `UPDATE autopost_posts SET status = 'posting', updated_at = now()
          WHERE id = $1 AND status IN ('approved','scheduled')
          RETURNING id`,
        [post.id],
      );
    } catch (e) {
      console.error(`${TAG} claim bài #${post.id} lỗi:`, e);
      continue;
    }
    if ((claim.rowCount ?? 0) === 0) continue; // worker khác đã chiếm / state đổi

    // ── Dedupe chủ động: trùng ảnh/caption đã đăng → skip, KHÔNG gọi Graph API. ──
    if (post.image_hash || post.caption_hash) {
      try {
        const dup = await pool.query(
          `SELECT 1 FROM autopost_posts
            WHERE status = 'posted' AND id <> $1 AND page_id IS NOT DISTINCT FROM $2
              AND ( (image_hash IS NOT NULL AND image_hash = $3)
                 OR (caption_hash IS NOT NULL AND caption_hash = $4) )
            LIMIT 1`,
          [post.id, post.page_id, post.image_hash, post.caption_hash],
        );
        if (dup.rows.length > 0) {
          await pool.query(
            `UPDATE autopost_posts
                SET status = 'skipped', error_message = 'trùng bài đã đăng (dedupe)', updated_at = now()
              WHERE id = $1`,
            [post.id],
          );
          skipped++;
          console.log(`${TAG} bỏ qua bài #${post.id} — trùng ảnh/caption đã đăng`);
          continue;
        }
      } catch (e) {
        console.error(`${TAG} dedupe-check bài #${post.id} lỗi:`, e);
        // Không chặn việc đăng vì lỗi dedupe-check; tiếp tục như thường.
      }
    }

    // ── Đăng (đi qua DRY_RUN bên trong publishToPage). ──
    try {
      const r = await publishToPage({
        pageId: post.page_id ?? undefined,
        message: post.caption_final,
        imageUrls: toImageArray(post.images),
      });
      await pool.query(
        `UPDATE autopost_posts
            SET status = 'posted', facebook_post_id = $2, facebook_post_link = $3,
                posted_at = now(), error_message = NULL, updated_at = now()
          WHERE id = $1`,
        [post.id, r.postId, r.permalink],
      );
      if (post.content_pool_id != null) {
        await pool.query(
          `UPDATE autopost_content_pool
              SET times_posted = times_posted + 1, last_posted_at = now(), updated_at = now()
            WHERE id = $1`,
          [post.content_pool_id],
        );
      }
      posted++;
      console.log(`${TAG} ✓ đăng bài #${post.id} (${r.dryRun ? "DRY_RUN" : "thật"}) post_id=${r.postId}`);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 300);
      try {
        await pool.query(
          `UPDATE autopost_posts
              SET status = 'failed', error_message = $2, retry_count = retry_count + 1, updated_at = now()
            WHERE id = $1`,
          [post.id, msg],
        );
      } catch (e2) {
        console.error(`${TAG} ghi trạng thái failed bài #${post.id} lỗi:`, e2);
      }
      emitNotification({
        staffId: null,
        type: "autopost_failed",
        priority: "urgent",
        title: "AutoPost lỗi đăng bài",
        message: `Bài #${post.id}: ${msg.slice(0, 120)}`,
        targetModule: "auto-post-facebook",
        targetId: String(post.id),
      });
      failed++;
      console.warn(`${TAG} ✗ đăng bài #${post.id} thất bại: ${msg}`);
    }
  }

  return { posted, failed, skipped };
}

// ─────────────────────────── GENERATE PENDING ────────────────────────────────

/** Chọn 1 item pool phù hợp slot: đúng content_type, đủ ảnh, chưa được dùng. */
async function pickPoolItemForSlot(contentType: string, sourcePriority: string): Promise<Record<string, unknown> | null> {
  const params: unknown[] = [contentType];
  let srcFilter = "";
  if (sourcePriority === "app_web" || sourcePriority === "upload") {
    params.push(sourcePriority);
    srcFilter = `AND source_type = $${params.length}`;
  }
  try {
    const r = await pool.query(
      `SELECT * FROM autopost_content_pool
        WHERE is_eligible = true
          AND content_type = $1
          ${srcFilter}
          AND COALESCE(jsonb_array_length(images), 0) >= 1
          AND id NOT IN (
            SELECT content_pool_id FROM autopost_posts
             WHERE content_pool_id IS NOT NULL
               AND status IN ('pending_review','approved','scheduled','posting','posted')
          )
        ORDER BY last_posted_at ASC NULLS FIRST, times_posted ASC, id ASC
        LIMIT 1`,
      params,
    );
    return (r.rows[0] as Record<string, unknown>) ?? null;
  } catch (e) {
    console.error(`${TAG} chọn item pool (${contentType}) lỗi:`, e);
    return null;
  }
}

/**
 * Sinh sẵn bài CHỜ DUYỆT cho các slot lịch đang bật, trong cửa sổ 24h tới,
 * chỉ tạo khi slot+thời điểm đó CHƯA có bài. Không bao giờ throw.
 */
export async function generatePendingPosts(nowMs: number = Date.now()): Promise<{ created: number }> {
  let created = 0;

  let schedules: { rows: Array<{ id: number; page_id: string | null }> };
  try {
    schedules = await pool.query(
      `SELECT id, page_id FROM autopost_schedules WHERE enabled = true ORDER BY id`,
    );
  } catch (e) {
    console.error(`${TAG} query lịch lỗi:`, e);
    return { created };
  }
  if (schedules.rows.length === 0) return { created };

  // Cấu hình tone / từ cấm / page mặc định.
  let cfg: Record<string, unknown> = {};
  try {
    const c = await pool.query(`SELECT config FROM autopost_settings WHERE id = 1`);
    cfg = (c.rows[0]?.config as Record<string, unknown>) ?? {};
  } catch {
    /* dùng mặc định */
  }
  const tone = typeof cfg.tone === "string" ? cfg.tone : undefined;
  const bannedWords = Array.isArray(cfg.bannedWords) ? (cfg.bannedWords as string[]) : undefined;
  const defaultPageId = typeof cfg.defaultPageId === "string" && cfg.defaultPageId ? cfg.defaultPageId : null;

  for (const sch of schedules.rows) {
    if (created >= MAX_NEW_PER_TICK) break;
    let slots: { rows: Array<{ id: number; post_time: string; content_type: string; image_count: number; source_priority: string }> };
    try {
      slots = await pool.query(
        `SELECT id, post_time, content_type, image_count, source_priority
           FROM autopost_schedule_slots
          WHERE schedule_id = $1 AND enabled = true
          ORDER BY sort_order, id`,
        [sch.id],
      );
    } catch (e) {
      console.error(`${TAG} query slot lịch #${sch.id} lỗi:`, e);
      continue;
    }

    for (const slot of slots.rows) {
      if (created >= MAX_NEW_PER_TICK) break;
      for (const dayOffset of [0, 1]) {
        if (created >= MAX_NEW_PER_TICK) break;
        const when = computeSlotDateUtc(slot.post_time, dayOffset, nowMs);
        if (!when) continue;
        const diffMs = when.getTime() - nowMs;
        if (diffMs <= 0) continue; // đã qua giờ
        if (diffMs > 24 * 3600_000) continue; // ngoài cửa sổ 24h → để tick sau

        // Đã có bài cho đúng slot + thời điểm này (trừ bài bỏ/lỗi) → bỏ qua.
        try {
          const exists = await pool.query(
            `SELECT 1 FROM autopost_posts
              WHERE slot_id = $1 AND scheduled_at = $2 AND status NOT IN ('skipped','failed')
              LIMIT 1`,
            [slot.id, when],
          );
          if (exists.rows.length > 0) continue;
        } catch (e) {
          console.error(`${TAG} check tồn tại bài slot #${slot.id} lỗi:`, e);
          continue;
        }

        const row = await pickPoolItemForSlot(slot.content_type, slot.source_priority);
        if (!row) continue;

        const item = poolRowToCaptionItem(row);
        let result;
        try {
          result = await generateCaptions(item, { tone, bannedWords });
        } catch (e) {
          console.error(`${TAG} generateCaptions pool #${String(row.id)} lỗi:`, e);
          continue;
        }
        if (!result.ok) {
          console.warn(`${TAG} caption thất bại pool #${String(row.id)}: ${result.reason}`);
          continue;
        }

        const images = clampImages(item.images, Number(slot.image_count) || 1);
        const captionOptions = result.captions.map((c) => ({ text: c.text, flags: c.flags }));
        const pageId = sch.page_id ?? defaultPageId;
        try {
          const ins = await pool.query(
            `INSERT INTO autopost_posts
               (content_pool_id, schedule_id, slot_id, page_id, content_type, images,
                caption_options, caption_recommended_index, status, scheduled_at, image_hash,
                source_type, source_item_id, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,'pending_review',$9,$10,$11,$12, now())
             RETURNING id`,
            [
              row.id,
              sch.id,
              slot.id,
              pageId,
              item.contentType,
              JSON.stringify(images),
              JSON.stringify(captionOptions),
              result.recommendedIndex,
              when,
              sha1(images[0] || ""),
              (row.source_type as string | null) ?? null,
              (row.source_item_id as string | null) ?? null,
            ],
          );
          const newId = (ins.rows[0] as { id: number }).id;
          emitNotification({
            staffId: null,
            type: "autopost_pending",
            priority: "normal",
            title: "AutoPost: bài chờ duyệt (tự sinh)",
            message: item.title,
            targetModule: "auto-post-facebook",
            targetId: String(newId),
          });
          created++;
          console.log(`${TAG} tạo bài chờ duyệt #${newId} (slot #${slot.id}, ${when.toISOString()})`);
        } catch (e) {
          console.error(`${TAG} INSERT bài chờ duyệt (slot #${slot.id}) lỗi:`, e);
        }
      }
    }
  }

  return { created };
}

// ─────────────────────────── TICK + BOOT ─────────────────────────────────────

/** Một nhịp scheduler: sinh bài chờ duyệt rồi đăng bài tới giờ. */
export async function runAutoPostTick(nowMs: number = Date.now()): Promise<void> {
  await generatePendingPosts(nowMs);
  await publishDuePosts(nowMs);
}

/** Khởi động scheduler (gọi 1 lần ở app.ts). Tắt mặc định cho tới khi bật env. */
export function startAutoPostScheduler(): void {
  const on = (process.env.ENABLE_AUTO_POST_FACEBOOK ?? "").toLowerCase();
  if (!["true", "1", "yes"].includes(on)) {
    console.log(`${TAG} scheduler TẮT (đặt ENABLE_AUTO_POST_FACEBOOK=true để bật)`);
    return;
  }
  const raw = parseInt(process.env.AUTO_POST_CHECK_INTERVAL_SEC ?? "", 10);
  const sec = Number.isNaN(raw) || raw < 60 ? 120 : raw;
  const run = () => {
    runAutoPostTick().catch((e) => console.error(`${TAG} tick lỗi:`, e));
  };
  // Trễ 30s đầu để app khởi động xong (giống follow-up-scheduler).
  setTimeout(() => {
    run();
    setInterval(run, sec * 1000);
  }, 30_000);
  console.log(`${TAG} scheduler khởi động — poll mỗi ${sec}s (DRY_RUN=${isDryRun()})`);
}
