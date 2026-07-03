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
import { poolRowToCaptionItem, clampImages, sha1, resolveSlotImageCount, pickRecommendedCaption } from "./lib/autopost-route-helpers";
import { getBrandFooter, appendFooter } from "./lib/autopost-brand";
import { getDefaultSignatureContent, appendSignature } from "./lib/autopost-signature";
import { stripContacts } from "./lib/autopost-sanitize";
import { getAutopostConfig } from "./lib/autopost-config";

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
  footer_enabled: boolean | null;
};

type PublishOutcome = {
  status: "posted" | "skipped" | "failed";
  dryRun?: boolean;
  postId?: string;
  permalink?: string | null;
  error?: string;
};

/**
 * Đăng 1 bài ĐÃ được claim (status='posting'). Lõi dùng chung cho scheduler
 * (publishDuePosts) và nút "Đăng ngay" (publishPostNow): dedupe chống trùng →
 * publishToPage (qua DRY_RUN) → cập nhật posted/skipped/failed + đếm pool +
 * báo lỗi admin. KHÔNG bao giờ throw.
 */
async function publishClaimedPost(post: DuePost): Promise<PublishOutcome> {
  // ── Dedupe chủ động: trùng ảnh/caption đã đăng → skip, KHÔNG gọi Graph API. ──
  if (post.image_hash || post.caption_hash) {
    try {
      const dup = await pool.query(
        `SELECT 1 FROM autopost_posts
          WHERE status IN ('posted', 'posting') AND id <> $1 AND page_id IS NOT DISTINCT FROM $2
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
        console.log(`${TAG} bỏ qua bài #${post.id} — trùng ảnh/caption đã đăng`);
        return { status: "skipped" };
      }
    } catch (e) {
      console.error(`${TAG} dedupe-check bài #${post.id} lỗi:`, e);
      // Không chặn việc đăng vì lỗi dedupe-check; tiếp tục như thường.
    }
  }

  // ── Dựng caption CUỐI: sanitize liên hệ lạ → gắn CHỮ KÝ TIỆM chính chủ (nếu bật). ──
  // Nguồn chữ ký: bảng autopost_signatures (mặc định đang bật). Nếu chưa có chữ ký
  // nào → fallback footer cũ (autopost_settings.config.footer) để không vỡ bài cũ.
  const cleaned = stripContacts(post.caption_final ?? "");
  let finalMessage = cleaned;
  try {
    const wantSignature = post.footer_enabled === false ? false : true; // mặc định BẬT
    if (wantSignature) {
      const sig = await getDefaultSignatureContent();
      if (sig) {
        finalMessage = appendSignature(cleaned, sig);
      } else {
        const bf = await getBrandFooter();
        if (bf.enabled) finalMessage = appendFooter(cleaned, bf);
      }
    }
  } catch (e) {
    console.warn(`${TAG} build chữ ký bài #${post.id} lỗi (đăng không chữ ký):`, String(e).slice(0, 120));
  }

  // ── Đăng (đi qua DRY_RUN bên trong publishToPage). ──
  try {
    const r = await publishToPage({
      pageId: post.page_id ?? undefined,
      message: finalMessage,
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
    console.log(`${TAG} ✓ đăng bài #${post.id} (${r.dryRun ? "DRY_RUN" : "thật"}) post_id=${r.postId}`);
    return { status: "posted", dryRun: r.dryRun, postId: r.postId, permalink: r.permalink };
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
    console.warn(`${TAG} ✗ đăng bài #${post.id} thất bại: ${msg}`);
    return { status: "failed", error: msg };
  }
}

/** Bài đã claim 'posting' nhưng caption_final CÓ THỂ còn trống (luồng tự đăng / đăng ngay). */
type ClaimedRow = {
  id: number;
  page_id: string | null;
  images: unknown;
  caption_final: string | null;
  content_pool_id: number | null;
  image_hash: string | null;
  caption_hash: string | null;
  footer_enabled: boolean | null;
  caption_options?: unknown;
  caption_recommended_index?: number | null;
};

/**
 * Bảo đảm bài (đã claim 'posting') có caption_final: nếu trống thì lấy caption
 * ĐỀ XUẤT từ caption_options[recommendedIndex], GHI vào DB (kèm caption_hash) để
 * bản ghi nhất quán + dedupe hoạt động. Trả false nếu không có caption nào dùng được.
 */
async function ensureCaptionFinal(row: ClaimedRow): Promise<boolean> {
  if (row.caption_final && row.caption_final.trim().length > 0) return true;
  const fc = pickRecommendedCaption(row.caption_options, row.caption_recommended_index);
  if (!fc) return false;
  const h = sha1(fc);
  // GHI caption_final/caption_hash là BẮT BUỘC (để bản ghi nhất quán + dedupe theo
  // caption hoạt động). Nếu ghi lỗi → trả false (fail-closed): KHÔNG đăng bài có
  // caption chưa lưu được, để caller đánh dấu failed thay vì đăng rồi mất dedupe.
  try {
    await pool.query(
      `UPDATE autopost_posts SET caption_final = $2, caption_hash = $3, updated_at = now() WHERE id = $1`,
      [row.id, fc, h],
    );
  } catch (e) {
    console.error(`${TAG} ghi caption_final bài #${row.id} lỗi (bỏ đăng):`, e);
    return false;
  }
  row.caption_final = fc;
  row.caption_hash = h;
  return true;
}

/**
 * Đăng các bài đã duyệt tới giờ. Atomic-claim chống đua, dedupe chống trùng,
 * báo lỗi admin khi thất bại. Không bao giờ throw (tự bắt mọi lỗi).
 */
export async function publishDuePosts(nowMs: number = Date.now()): Promise<{ posted: number; failed: number; skipped: number }> {
  void nowMs; // scheduled_at <= now() được DB đánh giá; nowMs giữ cho test/đối xứng API.
  let posted = 0;
  let failed = 0;
  let skipped = 0;

  // CÔNG TẮC TỔNG "Tự động đăng bài" (autoApproveEnabled). TẮT → KHÔNG tự đăng bất
  // kỳ bài nào (kể cả bài người-thật đã duyệt + hẹn giờ): bài giữ nguyên trạng thái,
  // chờ admin bấm "Đăng ngay" thủ công. (Sweep cửa sổ kiểm duyệt cũng gated tương tự.)
  let cfg: Awaited<ReturnType<typeof getAutopostConfig>> | null = null;
  try { cfg = await getAutopostConfig(); } catch { cfg = null; }
  if (!cfg?.autoApproveEnabled) return { posted, failed, skipped };

  let due: { rows: DuePost[] };
  try {
    due = await pool.query(
      `SELECT id, page_id, images, caption_final, content_pool_id, image_hash, caption_hash, footer_enabled
         FROM autopost_posts
        WHERE status IN ('approved','scheduled')
          AND approved_by IS NOT NULL
          AND caption_final IS NOT NULL
          AND auto_paused = false
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
          WHERE id = $1 AND status IN ('approved','scheduled') AND auto_paused = false
          RETURNING id`,
        [post.id],
      );
    } catch (e) {
      console.error(`${TAG} claim bài #${post.id} lỗi:`, e);
      continue;
    }
    if ((claim.rowCount ?? 0) === 0) continue; // worker khác đã chiếm / state đổi

    const outcome = await publishClaimedPost(post);
    if (outcome.status === "posted") posted++;
    else if (outcome.status === "skipped") skipped++;
    else failed++;
  }

  return { posted, failed, skipped };
}

/**
 * Đăng NGAY 1 bài (bỏ qua việc chờ tới `scheduled_at`) — dùng cho nút "Đăng ngay"
 * để admin test gấp. Vẫn đi qua DRY_RUN + dedupe y như scheduler. CHỈ đăng được
 * bài ĐÃ DUYỆT: status IN ('approved','scheduled') + có người duyệt + có caption.
 * KHÔNG throw — luôn trả object kết quả cho route.
 */
export async function publishPostNow(
  id: number,
): Promise<{ ok: boolean; status: string; dryRun?: boolean; postId?: string; permalink?: string | null; error?: string }> {
  // Atomic claim NGAY (không phụ thuộc scheduled_at) — chống đua với scheduler.
  // Cho cả bài ĐÃ DUYỆT (approved/scheduled) lẫn bài trong cửa sổ kiểm duyệt
  // (review_pending — caption_final có thể còn trống, sẽ tự lấy caption đề xuất).
  let claim: { rowCount: number | null };
  try {
    claim = await pool.query(
      `UPDATE autopost_posts SET status = 'posting', updated_at = now()
        WHERE id = $1
          AND (
            (status IN ('approved','scheduled') AND approved_by IS NOT NULL AND caption_final IS NOT NULL)
            OR (status = 'review_pending' AND auto_paused = false AND (editing_until IS NULL OR editing_until <= now()))
          )
        RETURNING id`,
      [id],
    );
  } catch (e) {
    return { ok: false, status: "error", error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
  if ((claim.rowCount ?? 0) === 0) {
    return { ok: false, status: "not_publishable", error: "Chỉ đăng ngay được bài ĐÃ DUYỆT hoặc đang chờ tự đăng (chưa duyệt / đang đăng / đã đăng / đã huỷ)" };
  }

  let row: ClaimedRow | undefined;
  try {
    const r = await pool.query(
      `SELECT id, page_id, images, caption_final, caption_options, caption_recommended_index,
              content_pool_id, image_hash, caption_hash, footer_enabled
         FROM autopost_posts WHERE id = $1`,
      [id],
    );
    row = r.rows[0] as ClaimedRow | undefined;
  } catch (e) {
    // Đã claim 'posting' nhưng không đọc được dữ liệu → trả bài về 'review_pending' cho khỏi kẹt.
    await pool.query(`UPDATE autopost_posts SET status = 'review_pending', updated_at = now() WHERE id = $1 AND status = 'posting'`, [id]).catch(() => {});
    return { ok: false, status: "error", error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
  if (!row) return { ok: false, status: "not_found", error: "Không tìm thấy bài" };

  if (!(await ensureCaptionFinal(row))) {
    await pool.query(`UPDATE autopost_posts SET status = 'failed', error_message = 'thiếu caption để đăng', updated_at = now() WHERE id = $1`, [id]).catch(() => {});
    return { ok: false, status: "failed", error: "Bài chưa có caption để đăng" };
  }

  const outcome = await publishClaimedPost(row as DuePost);
  return {
    ok: outcome.status === "posted",
    status: outcome.status,
    dryRun: outcome.dryRun,
    postId: outcome.postId,
    permalink: outcome.permalink,
    error: outcome.error,
  };
}

// ─────────────────── REVIEW COUNTDOWN (cửa sổ kiểm duyệt 30') ────────────────

/**
 * Sweep A — ĐƯA BÀI VÀO CỬA SỔ KIỂM DUYỆT: các bài 'pending_review' đã CÓ giờ đăng
 * và sắp tới giờ (trong `autoApproveAfterMinutes` phút tới) → chuyển 'review_pending'
 * để hiện đếm ngược trên UI và bật cơ chế tự đăng. Bỏ qua bài đang sửa / tạm ngưng.
 * GATED bởi config autoApproveEnabled (TẮT mặc định → không làm gì). KHÔNG throw.
 */
export async function sweepEnterReviewWindow(nowMs: number = Date.now()): Promise<{ entered: number }> {
  void nowMs; // mốc thời gian do DB (now()) đánh giá; tham số giữ cho test/đối xứng.
  let entered = 0;
  let cfg: Awaited<ReturnType<typeof getAutopostConfig>> | null = null;
  try { cfg = await getAutopostConfig(); } catch { cfg = null; }
  if (!cfg?.autoApproveEnabled) return { entered };
  const windowMin = Math.max(1, Math.min(1440, cfg.autoApproveAfterMinutes || 30));
  try {
    const r = await pool.query(
      `UPDATE autopost_posts
          SET status = 'review_pending', updated_at = now()
        WHERE status = 'pending_review'
          AND scheduled_at IS NOT NULL
          AND auto_paused = false
          AND (editing_until IS NULL OR editing_until <= now())
          -- Trong cửa sổ N phút tới; KÈM cả bài đã QUÁ giờ (trong 24h) để không bị
          -- kẹt mãi ở pending_review nếu tick lỡ mất khung giờ (server restart / bật
          -- công tắc muộn). Sweep B sẽ đăng ngay vì scheduled_at <= now().
          AND scheduled_at >= now() - interval '24 hours'
          AND scheduled_at <= now() + make_interval(mins => $1::int)
        RETURNING id`,
      [windowMin],
    );
    entered = r.rowCount ?? 0;
    for (const row of r.rows as Array<{ id: number }>) {
      emitNotification({
        staffId: null,
        type: "autopost_review",
        priority: "normal",
        title: "AutoPost: bài sắp tự đăng",
        message: `Bài #${row.id} vào cửa sổ kiểm duyệt ${windowMin} phút`,
        targetModule: "auto-post-facebook",
        targetId: String(row.id),
      });
    }
  } catch (e) {
    console.error(`${TAG} sweep vào cửa sổ kiểm duyệt lỗi:`, e);
  }
  return { entered };
}

/**
 * Sweep B — TỰ ĐĂNG khi countdown về 0: các bài 'review_pending' đã tới giờ
 * (scheduled_at <= now), KHÔNG đang sửa / tạm ngưng. Atomic-claim review_pending →
 * posting (idempotent, chống đăng trùng), tự lấy caption đề xuất nếu chưa có, rồi
 * dùng chung publishClaimedPost (DRY_RUN + dedupe + posted/failed). KHÔNG throw.
 * GATED bởi autoApproveEnabled (tắt switch giữa chừng = dừng tự đăng — an toàn).
 */
export async function sweepAutoPublishDue(nowMs: number = Date.now()): Promise<{ posted: number; failed: number; skipped: number }> {
  void nowMs;
  let posted = 0, failed = 0, skipped = 0;
  let cfg: Awaited<ReturnType<typeof getAutopostConfig>> | null = null;
  try { cfg = await getAutopostConfig(); } catch { cfg = null; }
  if (!cfg?.autoApproveEnabled) return { posted, failed, skipped };

  let due: { rows: ClaimedRow[] };
  try {
    due = await pool.query(
      `SELECT id, page_id, images, caption_final, caption_options, caption_recommended_index,
              content_pool_id, image_hash, caption_hash, footer_enabled
         FROM autopost_posts
        WHERE status = 'review_pending'
          AND scheduled_at IS NOT NULL AND scheduled_at <= now()
          AND auto_paused = false
          AND (editing_until IS NULL OR editing_until <= now())
        ORDER BY scheduled_at ASC
        LIMIT 10`,
    );
  } catch (e) {
    console.error(`${TAG} query review_pending tới giờ lỗi:`, e);
    return { posted, failed, skipped };
  }

  for (const row of due.rows) {
    // Atomic claim: chỉ worker đầu tiên chiếm được bài (review_pending → posting).
    // Gắn approved_by=0 (sentinel "hệ thống") + approved_at để bản ghi nhất quán.
    let claim: { rowCount: number | null };
    try {
      claim = await pool.query(
        `UPDATE autopost_posts
            SET status = 'posting',
                approved_by = COALESCE(approved_by, 0),
                approved_at = COALESCE(approved_at, now()),
                updated_at = now()
          WHERE id = $1 AND status = 'review_pending' AND auto_paused = false
            AND (editing_until IS NULL OR editing_until <= now())
          RETURNING id`,
        [row.id],
      );
    } catch (e) {
      console.error(`${TAG} claim review #${row.id} lỗi:`, e);
      continue;
    }
    if ((claim.rowCount ?? 0) === 0) continue; // worker khác đã chiếm / đang sửa / đã tạm ngưng

    if (!(await ensureCaptionFinal(row))) {
      await pool.query(
        `UPDATE autopost_posts SET status = 'failed', error_message = 'thiếu caption để tự đăng', updated_at = now() WHERE id = $1`,
        [row.id],
      ).catch(() => {});
      console.warn(`${TAG} ✗ tự đăng bài #${row.id} thất bại: thiếu caption`);
      failed++;
      continue;
    }
    const outcome = await publishClaimedPost(row as DuePost);
    if (outcome.status === "posted") posted++;
    else if (outcome.status === "skipped") skipped++;
    else failed++;
  }
  return { posted, failed, skipped };
}

/**
 * REAPER — thu hồi bài KẸT ở 'posting'. Mỗi luồng đăng claim bài sang 'posting'
 * (UPDATE riêng, đã commit) rồi mới gọi publishClaimedPost. Nếu tiến trình bị
 * KILL/restart/Republish (Replit) GIỮA hai bước, bài kẹt 'posting' vĩnh viễn vì
 * KHÔNG truy vấn nào chọn lại 'posting'. Đưa về 'failed' (hiện trên UI + /retry
 * khôi phục được) thay vì tự đăng lại — tránh đăng trùng nếu bài đã kịp lên FB.
 * Ngưỡng 10' an toàn hơn nhiều thời gian publish thật (vài giây). KHÔNG throw.
 */
export async function reclaimStalePostingPosts(): Promise<{ reclaimed: number }> {
  try {
    const r = await pool.query(
      `UPDATE autopost_posts
          SET status = 'failed',
              error_message = 'kẹt ở trạng thái đang đăng do server khởi động lại — bấm Đăng lại nếu cần',
              retry_count = retry_count + 1,
              updated_at = now()
        WHERE status = 'posting'
          AND updated_at < now() - interval '10 minutes'
        RETURNING id`,
    );
    const reclaimed = r.rowCount ?? 0;
    if (reclaimed > 0) console.warn(`${TAG} thu hồi ${reclaimed} bài kẹt 'posting' → 'failed' (server restart giữa chừng)`);
    return { reclaimed };
  } catch (e) {
    console.error(`${TAG} reaper 'posting' lỗi:`, e);
    return { reclaimed: 0 };
  }
}

/** Một nhịp cửa sổ kiểm duyệt (chạy mỗi ~1 phút): thu hồi kẹt → vào cửa sổ → tự đăng. */
export async function runReviewCountdownTick(nowMs: number = Date.now()): Promise<void> {
  await reclaimStalePostingPosts();
  await sweepEnterReviewWindow(nowMs);
  await sweepAutoPublishDue(nowMs);
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
               AND status IN ('pending_review','review_pending','approved','scheduled','posting','posted')
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

        // Số ảnh/bài: TÔN TRỌNG khi slot đặt rõ >=2; còn 0/1/null (giá trị mặc định
        // cũ vốn gây rớt còn 1 ảnh) → giữ NHIỀU ảnh theo DEFAULT_POST_IMAGES.
        const images = clampImages(item.images, resolveSlotImageCount(slot.image_count));
        console.log(`[AutoPost] create draft (auto) sourceImages=${item.images.length} savedImages=${images.length} slot=#${slot.id}`);
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
              images[0] ? sha1(images[0]) : null,
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
  await reclaimStalePostingPosts();
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

  // Cửa sổ kiểm duyệt 30': quét RIÊNG mỗi 60s (truy vấn rẻ, KHÔNG tốn token AI) —
  // đưa bài sắp tới giờ vào 'review_pending' rồi tự đăng khi countdown về 0.
  const reviewRun = () => {
    runReviewCountdownTick().catch((e) => console.error(`${TAG} review tick lỗi:`, e));
  };
  setTimeout(() => {
    reviewRun();
    setInterval(reviewRun, 60_000);
  }, 45_000);

  console.log(`${TAG} scheduler khởi động — poll mỗi ${sec}s + cửa sổ kiểm duyệt mỗi 60s (DRY_RUN=${isDryRun()})`);
}
