import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac } from "node:crypto";
import { pool } from "@workspace/db";
import { verifyToken, getCallerRole } from "./auth";
import { emitNotification } from "./notifications";
import { ensureAutoPostSchema } from "../lib/autopost-schema";
import { syncAppWebPool, addManualPoolItem } from "../lib/autopost-pool";
import { generateCaptions } from "../lib/autopost-caption";
import { verifyPageToken, MAX_PHOTOS } from "../lib/facebook-page-publish";
import { publishPostNow } from "../autopost-scheduler";
import {
  syncGoogleDrivePool,
  verifyDriveConnection,
  driveStatus,
  getOAuthClientEnv,
  getDriveAuthUrl,
  exchangeCodeForRefreshToken,
  saveDriveRefreshToken,
} from "../lib/autopost-drive";
import {
  isValidStatus,
  sha1,
  poolRowToCaptionItem,
  clampImages,
  DEFAULT_POST_IMAGES,
} from "../lib/autopost-route-helpers";
import { describeDryRun, patchAutopostConfig, getAutopostConfig } from "../lib/autopost-config";
import { pickRelevantSamples, getSamplesByIds, buildStyleBlock, ocrImageToText, topicForContentType, styleTopicLabel, isValidStyleTopic } from "../lib/autopost-style";
import { persistImageBuffer } from "../lib/autopost-storage";
import { getBrandFooter, buildFooterText } from "../lib/autopost-brand";
import { listSignatures, getDefaultSignatureContent } from "../lib/autopost-signature";

// ─────────────────────────────────────────────────────────────────────────────
// AutoPost Facebook (Amazing Studio) — admin router (Task 5).
//
// HARD CONSTRAINTS:
//  - CHỈ GHI vào các bảng autopost_* (pool, schedules, schedule_slots, posts,
//    settings). READ-ONLY tuyệt đối với mọi bảng khác.
//  - Mọi endpoint ghi đều require admin (requireAdmin).
//  - "Chỉ bài đã DUYỆT mới được đăng": chỉ POST /posts/:id/approve mới đưa bài
//    sang trạng thái 'approved' (kèm scheduled_at + người duyệt).
// ─────────────────────────────────────────────────────────────────────────────

// Đảm bảo schema tồn tại (fire-and-forget; hàm tự log lỗi, không throw).
void ensureAutoPostSchema();

const router: IRouter = Router();

async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const role = await getCallerRole(req.headers.authorization);
  if (role !== "admin") {
    res.status(403).json({ error: "Chỉ admin được phép" });
    return false;
  }
  return true;
}

// ─────────────────────────────── POOL ───────────────────────────────────────

// POST /autopost/pool/sync — đồng bộ nội dung app/web vào pool.
router.post("/autopost/pool/sync", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const n = await syncAppWebPool();
    res.json(n);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /autopost/pool — liệt kê item trong pool.
router.get("/autopost/pool", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { contentType, sourceType, eligible } = req.query as {
      contentType?: string;
      sourceType?: string;
      eligible?: string;
    };
    const where: string[] = [];
    const params: unknown[] = [];
    if (eligible !== "all") {
      where.push(`is_eligible = true`);
    }
    if (contentType) {
      params.push(contentType);
      where.push(`content_type = $${params.length}`);
    }
    if (sourceType) {
      params.push(sourceType);
      where.push(`source_type = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const r = await pool.query(
      `SELECT id, source_type AS "sourceType", source_table AS "sourceTable",
              source_item_id AS "sourceItemId", content_type AS "contentType", title,
              images, price, sale_price AS "salePrice",
              golden_hour_percent AS "goldenHourPercent", golden_hour_name AS "goldenHourName",
              category, badge, public_link AS "publicLink", image_hash AS "imageHash",
              is_eligible AS "isEligible", times_posted AS "timesPosted",
              last_posted_at AS "lastPostedAt"
         FROM autopost_content_pool
         ${whereSql}
        ORDER BY updated_at DESC
        LIMIT 500`,
      params,
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/pool/upload — thêm thủ công 1 item upload vào pool.
router.post("/autopost/pool/upload", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const body = req.body ?? {};
    const id = await addManualPoolItem({
      contentType: body.contentType,
      title: body.title,
      images: Array.isArray(body.images) ? body.images : [],
      price: body.price ?? null,
      salePrice: body.salePrice ?? null,
      category: body.category ?? null,
      badge: body.badge ?? null,
      publicLink: body.publicLink ?? null,
    });
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PATCH /autopost/pool/:id — cập nhật is_eligible / title / badge.
router.patch("/autopost/pool/:id", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const body = req.body ?? {};
    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.isEligible !== undefined) {
      params.push(!!body.isEligible);
      sets.push(`is_eligible = $${params.length}`);
    }
    if (body.title !== undefined) {
      params.push(String(body.title));
      sets.push(`title = $${params.length}`);
    }
    if (body.badge !== undefined) {
      params.push(body.badge == null ? null : String(body.badge));
      sets.push(`badge = $${params.length}`);
    }
    if (sets.length === 0) {
      res.status(400).json({ error: "Không có trường nào để cập nhật" });
      return;
    }
    params.push(Number(req.params.id));
    const r = await pool.query(
      `UPDATE autopost_content_pool SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $${params.length} RETURNING id`,
      params,
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Không tìm thấy item" }); return; }
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// DELETE /autopost/pool/:id — xoá item khỏi pool.
router.delete("/autopost/pool/:id", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    await pool.query(`DELETE FROM autopost_content_pool WHERE id = $1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ───────────────────────────── SCHEDULES ─────────────────────────────────────

async function loadSlots(scheduleId: number) {
  const r = await pool.query(
    `SELECT id, schedule_id AS "scheduleId", post_time AS "postTime",
            content_type AS "contentType", image_count AS "imageCount",
            source_priority AS "sourcePriority", enabled, sort_order AS "sortOrder"
       FROM autopost_schedule_slots
      WHERE schedule_id = $1
      ORDER BY sort_order`,
    [scheduleId],
  );
  return r.rows;
}

async function insertSlots(scheduleId: number, slots: any[]): Promise<void> {
  for (const s of slots) {
    await pool.query(
      `INSERT INTO autopost_schedule_slots
         (schedule_id, post_time, content_type, image_count, source_priority, enabled, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        scheduleId,
        String(s.postTime ?? ""),
        String(s.contentType ?? ""),
        Number(s.imageCount) || 1,
        String(s.sourcePriority ?? "app_web"),
        s.enabled === undefined ? true : !!s.enabled,
        Number(s.sortOrder) || 0,
      ],
    );
  }
}

// GET /autopost/schedules — danh sách lịch + slot của từng lịch.
router.get("/autopost/schedules", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(
      `SELECT id, name, enabled, page_id AS "pageId", timezone,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM autopost_schedules
        ORDER BY id`,
    );
    const out = [];
    for (const sch of r.rows as any[]) {
      out.push({ ...sch, slots: await loadSlots(sch.id) });
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/schedules — tạo lịch (kèm slot).
router.post("/autopost/schedules", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { name, enabled, pageId, timezone, slots } = req.body ?? {};
    const r = await pool.query(
      `INSERT INTO autopost_schedules (name, enabled, page_id, timezone, updated_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING id, name, enabled, page_id AS "pageId", timezone,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        String(name ?? "Lịch đăng"),
        enabled === undefined ? false : !!enabled,
        pageId ?? null,
        timezone || "Asia/Ho_Chi_Minh",
      ],
    );
    const created = r.rows[0] as any;
    if (Array.isArray(slots)) await insertSlots(created.id, slots);
    res.json({ ...created, slots: await loadSlots(created.id) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PUT /autopost/schedules/:id — cập nhật lịch; nếu có slots thì thay toàn bộ.
router.put("/autopost/schedules/:id", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const id = Number(req.params.id);
    const { name, enabled, pageId, timezone, slots } = req.body ?? {};
    const sets: string[] = [];
    const params: unknown[] = [];
    if (name !== undefined) {
      params.push(String(name));
      sets.push(`name = $${params.length}`);
    }
    if (enabled !== undefined) {
      params.push(!!enabled);
      sets.push(`enabled = $${params.length}`);
    }
    if (pageId !== undefined) {
      params.push(pageId ?? null);
      sets.push(`page_id = $${params.length}`);
    }
    if (timezone !== undefined) {
      params.push(timezone || "Asia/Ho_Chi_Minh");
      sets.push(`timezone = $${params.length}`);
    }
    sets.push(`updated_at = now()`);
    params.push(id);
    const r = await pool.query(
      `UPDATE autopost_schedules SET ${sets.join(", ")}
        WHERE id = $${params.length}
        RETURNING id, name, enabled, page_id AS "pageId", timezone,
                  created_at AS "createdAt", updated_at AS "updatedAt"`,
      params,
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Không tìm thấy lịch" }); return; }
    if (Array.isArray(slots)) {
      await pool.query(`DELETE FROM autopost_schedule_slots WHERE schedule_id = $1`, [id]);
      await insertSlots(id, slots);
    }
    res.json({ ...(r.rows[0] as any), slots: await loadSlots(id) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// DELETE /autopost/schedules/:id — xoá lịch (slot cascade).
router.delete("/autopost/schedules/:id", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    await pool.query(`DELETE FROM autopost_schedules WHERE id = $1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/schedules/:id/toggle — bật/tắt nhanh.
router.post("/autopost/schedules/:id/toggle", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(
      `UPDATE autopost_schedules SET enabled = NOT enabled, updated_at = now()
        WHERE id = $1 RETURNING id, enabled`,
      [Number(req.params.id)],
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Không tìm thấy lịch" }); return; }
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─────────────────────────────── POSTS ───────────────────────────────────────

const POST_SELECT = `
  SELECT p.id, p.schedule_id AS "scheduleId", p.slot_id AS "slotId",
         p.content_pool_id AS "contentPoolId", p.page_id AS "pageId",
         p.content_type AS "contentType", p.images,
         p.caption_options AS "captionOptions",
         p.caption_recommended_index AS "captionRecommendedIndex",
         p.caption_final AS "captionFinal", p.status,
         p.scheduled_at AS "scheduledAt", p.approved_by AS "approvedBy",
         p.approved_at AS "approvedAt", p.posted_at AS "postedAt",
         p.facebook_post_id AS "facebookPostId", p.facebook_post_link AS "facebookPostLink",
         p.error_message AS "errorMessage", p.retry_count AS "retryCount",
         p.caption_hash AS "captionHash", p.image_hash AS "imageHash",
         p.source_type AS "sourceType", p.source_item_id AS "sourceItemId",
         p.ai_model AS "aiModel", p.vision_image_count AS "visionImageCount",
         p.used_sample_ids AS "usedSampleIds", p.footer_enabled AS "footerEnabled",
         p.editing_until AS "editingUntil", p.auto_paused AS "autoPaused",
         p.created_at AS "createdAt", p.updated_at AS "updatedAt",
         cp.title AS "poolTitle"
    FROM autopost_posts p
    LEFT JOIN autopost_content_pool cp ON cp.id = p.content_pool_id`;

// POST /autopost/posts/generate — sinh caption AI cho 1 item pool → bài chờ duyệt.
router.post("/autopost/posts/generate", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { poolId, scheduleId, slotId, imageCount, captionCount, styleSampleIds, style } = req.body ?? {};

    // (1) Lấy item pool (phải tồn tại & is_eligible).
    const poolR = await pool.query(
      `SELECT * FROM autopost_content_pool WHERE id = $1`,
      [Number(poolId)],
    );
    const row = poolR.rows[0] as any;
    if (!row) { res.status(404).json({ error: "Không tìm thấy item trong pool" }); return; }
    if (!row.is_eligible) { res.status(400).json({ error: "Item không đủ điều kiện đăng" }); return; }

    // (2) Settings → tone + bannedWords + defaultPageId + số caption/ảnh-vision.
    const cfgR = await pool.query(`SELECT config FROM autopost_settings WHERE id = 1`);
    const cfg = (cfgR.rows[0]?.config as any) ?? {};
    const tone = typeof cfg.tone === "string" ? cfg.tone : undefined;
    const bannedWords = Array.isArray(cfg.bannedWords) ? cfg.bannedWords : undefined;
    const opcfg = await getAutopostConfig();
    const wantCaptions = Math.max(1, Math.min(6, Number(captionCount) || opcfg.captionOptionsPerPost));

    // (3) item chuẩn hóa.
    const item = poolRowToCaptionItem(row);

    // (3b) VĂN PHONG MẪU: id cụ thể (nếu client chọn) hoặc tự chọn theo content_type.
    const samples = Array.isArray(styleSampleIds) && styleSampleIds.length
      ? await getSamplesByIds(styleSampleIds.map(Number))
      : await pickRelevantSamples({ topicKey: topicForContentType(item.contentType), limit: 4 });
    const styleBlock = buildStyleBlock(samples);

    // (4) Sinh caption — KHÔNG crash khi thất bại.
    const result = await generateCaptions(item, {
      tone,
      bannedWords,
      styleBlock,
      captionCount: wantCaptions,
      maxVisionImages: opcfg.maxVisionImagesPerPost,
      style: typeof style === "string" ? style : undefined,
    });
    if (!result.ok) {
      res.status(502).json({ error: "caption_failed", reason: result.reason });
      return;
    }

    // (5) Ảnh + page id. MẶC ĐỊNH giữ NHIỀU ảnh của item (tối đa DEFAULT_POST_IMAGES
    // = 10 ảnh/bài) để 1 bài có nhiều ảnh thay vì chỉ ảnh bìa; chỉ giới hạn khác khi
    // client truyền imageCount cụ thể. Mọi trường hợp vẫn bị trần MAX_PHOTOS (50) chặn.
    const images = clampImages(item.images, Math.min(Number(imageCount) || DEFAULT_POST_IMAGES, MAX_PHOTOS));
    console.log(`[AutoPost] create draft sourceImages=${item.images.length} savedImages=${images.length}`);
    let pageId: string | null = (cfg.defaultPageId as string | undefined) ?? null;
    if (scheduleId) {
      const schR = await pool.query(`SELECT page_id FROM autopost_schedules WHERE id = $1`, [
        Number(scheduleId),
      ]);
      if (schR.rows[0]?.page_id) pageId = schR.rows[0].page_id;
    }

    // (6) INSERT bài (pending_review) — kèm vết AI: model, số ảnh vision, sample dùng, người tạo.
    const captionOptions = result.captions.map((c) => ({ text: c.text, flags: c.flags }));
    const generatedBy = verifyToken(req.headers.authorization);
    const usedSampleIds = samples.map((s) => s.id);
    const ins = await pool.query(
      `INSERT INTO autopost_posts
         (content_pool_id, schedule_id, slot_id, page_id, content_type, images,
          caption_options, caption_recommended_index, status, image_hash,
          source_type, source_item_id, ai_model, vision_image_count, used_sample_ids,
          generated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb,
               $7::jsonb, $8, 'pending_review', $9,
               $10, $11, $12, $13, $14::jsonb,
               $15, now())
       RETURNING id`,
      [
        row.id,
        scheduleId ? Number(scheduleId) : null,
        slotId ? Number(slotId) : null,
        pageId,
        item.contentType,
        JSON.stringify(images),
        JSON.stringify(captionOptions),
        result.recommendedIndex,
        images[0] ? sha1(images[0]) : null,
        row.source_type ?? null,
        row.source_item_id ?? null,
        result.provider,
        result.visionImageCount,
        JSON.stringify(usedSampleIds),
        generatedBy,
      ],
    );
    const newId = (ins.rows[0] as any).id;

    // (7) Thông báo admin có bài chờ duyệt (fire-and-forget).
    emitNotification({
      staffId: null,
      type: "autopost_pending",
      priority: "normal",
      title: "AutoPost: bài chờ duyệt",
      message: item.title,
      targetModule: "auto-post-facebook",
      targetId: String(newId),
    });

    // (8) Trả bài vừa tạo.
    const out = await pool.query(`${POST_SELECT} WHERE p.id = $1`, [newId]);
    res.json(out.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/posts/:id/regenerate — viết lại caption cho bài CHỜ DUYỆT theo
// phong cách/mood (Tạo lại / Ngắn hơn / Tình hơn / Vui hơn). Cập nhật caption_options,
// KHÔNG đổi status. Chỉ áp dụng cho bài chưa duyệt.
router.post("/autopost/posts/:id/regenerate", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const id = Number(req.params.id);
    const { style, captionCount, styleSampleIds } = req.body ?? {};
    const pr = await pool.query(
      `SELECT id, content_pool_id, content_type, images, status FROM autopost_posts WHERE id = $1`,
      [id],
    );
    const post = pr.rows[0] as any;
    if (!post) { res.status(404).json({ error: "Không tìm thấy bài" }); return; }
    if (post.status !== "pending_review" && post.status !== "draft_ai") {
      res.status(400).json({ error: "Chỉ viết lại được bài CHƯA duyệt" });
      return;
    }

    // Item: ưu tiên pool item (đủ giá/link); fallback dữ liệu của chính bài.
    let item: ReturnType<typeof poolRowToCaptionItem> | null = null;
    if (post.content_pool_id) {
      const poolR = await pool.query(`SELECT * FROM autopost_content_pool WHERE id = $1`, [post.content_pool_id]);
      if (poolR.rows[0]) item = poolRowToCaptionItem(poolR.rows[0]);
    }
    if (!item) {
      item = poolRowToCaptionItem({ content_type: post.content_type, title: `Bài #${id}`, images: post.images });
    }

    const cfgR = await pool.query(`SELECT config FROM autopost_settings WHERE id = 1`);
    const cfg = (cfgR.rows[0]?.config as any) ?? {};
    const tone = typeof cfg.tone === "string" ? cfg.tone : undefined;
    const bannedWords = Array.isArray(cfg.bannedWords) ? cfg.bannedWords : undefined;
    const opcfg = await getAutopostConfig();
    const wantCaptions = Math.max(1, Math.min(6, Number(captionCount) || opcfg.captionOptionsPerPost));

    const samples = Array.isArray(styleSampleIds) && styleSampleIds.length
      ? await getSamplesByIds(styleSampleIds.map(Number))
      : await pickRelevantSamples({ topicKey: topicForContentType(item.contentType), limit: 4 });
    const styleBlock = buildStyleBlock(samples);

    const result = await generateCaptions(item, {
      tone, bannedWords, styleBlock,
      captionCount: wantCaptions,
      maxVisionImages: opcfg.maxVisionImagesPerPost,
      style: typeof style === "string" ? style : undefined,
    });
    if (!result.ok) { res.status(502).json({ error: "caption_failed", reason: result.reason }); return; }

    const captionOptions = result.captions.map((c) => ({ text: c.text, flags: c.flags }));
    await pool.query(
      `UPDATE autopost_posts
          SET caption_options = $2::jsonb, caption_recommended_index = $3, ai_model = $4,
              vision_image_count = $5, used_sample_ids = $6::jsonb, updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(captionOptions), result.recommendedIndex, result.provider,
       result.visionImageCount, JSON.stringify(samples.map((s) => s.id))],
    );
    const out = await pool.query(`${POST_SELECT} WHERE p.id = $1`, [id]);
    res.json(out.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /autopost/posts — danh sách bài (lọc theo status tuỳ chọn).
router.get("/autopost/posts", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const status = req.query.status as string | undefined;
    const params: unknown[] = [];
    let whereSql = "";
    if (status) {
      if (!isValidStatus(status)) { res.status(400).json({ error: "status không hợp lệ" }); return; }
      params.push(status);
      whereSql = `WHERE p.status = $${params.length}`;
    }
    const r = await pool.query(
      `${POST_SELECT} ${whereSql} ORDER BY p.created_at DESC LIMIT 300`,
      params,
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /autopost/posts/:id — chi tiết 1 bài.
router.get("/autopost/posts/:id", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(`${POST_SELECT} WHERE p.id = $1`, [Number(req.params.id)]);
    if (!r.rows[0]) { res.status(404).json({ error: "Không tìm thấy bài" }); return; }
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PATCH /autopost/posts/:id — sửa caption nháp (chưa đổi trạng thái duyệt).
router.patch("/autopost/posts/:id", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const body = req.body ?? {};
    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.captionFinal !== undefined) {
      // caption_final phải là chuỗi không rỗng (giống ràng buộc của /approve).
      if (body.captionFinal == null || String(body.captionFinal).trim().length === 0) {
        res.status(400).json({ error: "captionFinal phải là chuỗi không rỗng" });
        return;
      }
      const cap = String(body.captionFinal).trim();
      params.push(cap);
      sets.push(`caption_final = $${params.length}`);
      // Tính caption_hash đồng bộ để dedupe luôn hoạt động dù sửa qua PATCH.
      params.push(sha1(cap));
      sets.push(`caption_hash = $${params.length}`);
    }
    if (body.captionRecommendedIndex !== undefined) {
      const idx = Number(body.captionRecommendedIndex);
      if (!Number.isFinite(idx) || idx < 0 || idx > 100) {
        res.status(400).json({ error: "captionRecommendedIndex không hợp lệ" });
        return;
      }
      params.push(idx);
      sets.push(`caption_recommended_index = $${params.length}`);
    }
    // Đổi GIỜ ĐĂNG (nút "Dời lịch"). Bỏ qua nếu rỗng. `newSchedRef` = biểu thức SQL
    // tham chiếu giờ đăng HIỆU LỰC (param mới) để tính lại status trong cùng UPDATE.
    let newSchedRef: string | null = null;
    if (body.scheduledAt !== undefined && body.scheduledAt !== null && String(body.scheduledAt).length > 0) {
      const when = new Date(body.scheduledAt);
      if (isNaN(when.getTime())) { res.status(400).json({ error: "scheduledAt không hợp lệ" }); return; }
      params.push(when);
      sets.push(`scheduled_at = $${params.length}`);
      newSchedRef = `$${params.length}::timestamptz`;
    }
    // Sửa ẢNH (xoá/đổi thứ tự ảnh hiện có). Mảng URL; tính lại image_hash theo ảnh đầu.
    if (Array.isArray(body.images)) {
      const imgs = clampImages(
        (body.images as unknown[]).map((x) => String(x)),
        Math.min(body.images.length || 1, MAX_PHOTOS),
      );
      params.push(JSON.stringify(imgs));
      sets.push(`images = $${params.length}::jsonb`);
      params.push(imgs[0] ? sha1(imgs[0]) : null);
      sets.push(`image_hash = $${params.length}`);
    }
    if (sets.length === 0) {
      res.status(400).json({ error: "Không có trường nào để cập nhật" });
      return;
    }
    // Lưu xong thì BỎ khoá "đang sửa" (editing_until) để cơ chế tự đăng chạy tiếp.
    sets.push(`editing_until = NULL`);
    // Tính lại status: bài 'review_pending' mà DỜI giờ ra ngoài cửa sổ (hoặc xoá giờ)
    // → trả về 'pending_review' (rời đếm ngược; Sweep A sẽ đưa lại khi tới gần giờ).
    let windowMin = 30;
    try { windowMin = (await getAutopostConfig()).autoApproveAfterMinutes || 30; } catch { /* mặc định 30 */ }
    params.push(windowMin);
    const wIdx = params.length;
    const schedRef = newSchedRef ?? "scheduled_at";
    sets.push(
      `status = CASE WHEN status = 'review_pending' AND (${schedRef} IS NULL OR ${schedRef} > now() + make_interval(mins => $${wIdx}::int)) THEN 'pending_review' ELSE status END`,
    );
    params.push(Number(req.params.id));
    // Cho sửa bài CHƯA duyệt (pending_review/draft_ai) HOẶC đang trong cửa sổ kiểm
    // duyệt (review_pending). Bài đã approved/scheduled vẫn phải qua /approve.
    const r = await pool.query(
      `UPDATE autopost_posts SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $${params.length} AND status IN ('pending_review', 'draft_ai', 'review_pending') RETURNING id, status`,
      params,
    );
    if (!r.rows[0]) { res.status(409).json({ error: "Chỉ sửa được bài chưa duyệt / đang chờ tự đăng" }); return; }
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/posts/:id/approve — DUYỆT bài (chỉ đường này mới sang 'approved').
router.post("/autopost/posts/:id/approve", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { captionFinal, scheduledAt, footerEnabled } = req.body ?? {};
    if (typeof captionFinal !== "string" || captionFinal.trim().length === 0) {
      res.status(400).json({ error: "captionFinal phải là chuỗi không rỗng" });
      return;
    }
    const when = scheduledAt ? new Date(scheduledAt) : null;
    if (!when || isNaN(when.getTime())) {
      res.status(400).json({ error: "scheduledAt không hợp lệ" });
      return;
    }
    const approver = verifyToken(req.headers.authorization);
    if (approver == null) {
      res.status(401).json({ error: "Token không hợp lệ hoặc hết hạn" });
      return;
    }
    // footerEnabled per-post: boolean → đặt; undefined → giữ nguyên (COALESCE).
    const footerVal = typeof footerEnabled === "boolean" ? footerEnabled : null;
    const r = await pool.query(
      `UPDATE autopost_posts
          SET caption_final = $1, status = 'approved', approved_by = $2,
              approved_at = now(), scheduled_at = $3, caption_hash = $4,
              footer_enabled = COALESCE($6, footer_enabled), updated_at = now()
        WHERE id = $5
          AND status IN ('pending_review', 'draft_ai', 'review_pending', 'approved', 'scheduled')
        RETURNING id, status`,
      [captionFinal, approver, when, sha1(captionFinal), Number(req.params.id), footerVal],
    );
    if (!r.rows[0]) {
      res.status(409).json({ error: "Bài không tồn tại hoặc không ở trạng thái duyệt được" });
      return;
    }
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/posts/:id/skip — bỏ qua / HUỶ bài. Có status-guard: KHÔNG huỷ
// được bài đang đăng / đã đăng (chống đua: tránh trường hợp scheduler vừa claim
// 'posting' thì lệnh huỷ vẫn ghi 'skipped' nhưng bài vẫn lên Facebook).
router.post("/autopost/posts/:id/skip", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(
      `UPDATE autopost_posts SET status = 'skipped', updated_at = now()
        WHERE id = $1 AND status NOT IN ('posting', 'posted') RETURNING id`,
      [Number(req.params.id)],
    );
    if (!r.rows[0]) { res.status(409).json({ error: "Không huỷ được — bài đang đăng hoặc đã đăng (hoặc không tồn tại)" }); return; }
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/posts/:id/retry — thử lại bài đã thất bại (về 'approved').
router.post("/autopost/posts/:id/retry", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(
      `UPDATE autopost_posts SET status = 'approved', error_message = NULL, updated_at = now()
        WHERE id = $1 AND status = 'failed' RETURNING id`,
      [Number(req.params.id)],
    );
    if (!r.rows[0]) { res.status(409).json({ error: "Chỉ bài thất bại mới thử lại được" }); return; }
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/posts/:id/publish-now — ĐĂNG NGAY bài đã duyệt (bỏ qua giờ hẹn).
// Vẫn qua DRY_RUN + dedupe như scheduler; chỉ đổi bài 'posted' khi đăng thành công.
router.post("/autopost/posts/:id/publish-now", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    res.json(await publishPostNow(Number(req.params.id)));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ───────────────── CỬA SỔ KIỂM DUYỆT 30' (Review Countdown) ───────────────────

// POST /autopost/posts/:id/lock-edit — admin bấm "Sửa": khoá auto-publish ~15 phút
// (editing_until) để không bị tự đăng mất trong lúc đang chỉnh. Chỉ bài chưa duyệt
// / đang chờ tự đăng. Trả editing_until để UI biết hạn khoá.
router.post("/autopost/posts/:id/lock-edit", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(
      `UPDATE autopost_posts
          SET editing_until = now() + interval '15 minutes', updated_at = now()
        WHERE id = $1 AND status IN ('pending_review', 'draft_ai', 'review_pending')
        RETURNING id, editing_until AS "editingUntil"`,
      [Number(req.params.id)],
    );
    if (!r.rows[0]) { res.status(409).json({ error: "Chỉ khoá sửa được bài chưa duyệt / đang chờ tự đăng" }); return; }
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/posts/:id/pause — "Tạm ngưng tự đăng" cho riêng bài này. Nếu đang
// 'review_pending' thì trả về 'pending_review' để RỜI đếm ngược (không tự đăng nữa).
router.post("/autopost/posts/:id/pause", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(
      `UPDATE autopost_posts
          SET auto_paused = true,
              status = CASE WHEN status = 'review_pending' THEN 'pending_review' ELSE status END,
              updated_at = now()
        WHERE id = $1 RETURNING id, status, auto_paused AS "autoPaused"`,
      [Number(req.params.id)],
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Không tìm thấy bài" }); return; }
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/posts/:id/resume — bỏ tạm ngưng (cho phép tự đăng lại theo lịch).
router.post("/autopost/posts/:id/resume", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(
      `UPDATE autopost_posts SET auto_paused = false, updated_at = now()
        WHERE id = $1 RETURNING id, status, auto_paused AS "autoPaused"`,
      [Number(req.params.id)],
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Không tìm thấy bài" }); return; }
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /autopost/server-time — giờ server (ISO) để UI tính đếm ngược chuẩn, không
// lệ thuộc đồng hồ máy client. Hiển thị theo Asia/Ho_Chi_Minh do FE format.
router.get("/autopost/server-time", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  res.json({ now: new Date().toISOString() });
});

// ─────────────────────────────── SETTINGS ────────────────────────────────────

// GET /autopost/settings — cấu hình AutoPost.
router.get("/autopost/settings", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(`SELECT config FROM autopost_settings WHERE id = 1`);
    const cfg = (r.rows[0]?.config as any) ?? {};
    // KHÔNG trả refresh token Drive ra client — chỉ báo đã kết nối hay chưa.
    if (cfg && cfg.drive && typeof cfg.drive === "object") {
      cfg.drive = { folderId: cfg.drive.folderId ?? undefined, connected: !!cfg.drive.refreshToken };
    }
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PUT /autopost/settings — ghi cấu hình (upsert singleton id=1).
router.put("/autopost/settings", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const config = req.body ?? {};
    const approver = verifyToken(req.headers.authorization);
    if (approver == null) {
      res.status(401).json({ error: "Token không hợp lệ hoặc hết hạn" });
      return;
    }
    // Giữ lại refresh token Drive (bị redact ở GET) để lưu settings KHÔNG xoá kết nối.
    try {
      const ex = await pool.query(`SELECT config FROM autopost_settings WHERE id = 1`);
      const exToken = (ex.rows[0]?.config as any)?.drive?.refreshToken;
      if (exToken) {
        if (!config.drive || typeof config.drive !== "object") config.drive = {};
        if (!config.drive.refreshToken) config.drive.refreshToken = exToken;
      }
    } catch {
      /* ignore */
    }
    const r = await pool.query(
      `INSERT INTO autopost_settings (id, config, updated_at, updated_by)
       VALUES (1, $1::jsonb, now(), $2)
       ON CONFLICT (id) DO UPDATE
         SET config = EXCLUDED.config, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING config`,
      [JSON.stringify(config), approver],
    );
    const saved = (r.rows[0] as any).config ?? {};
    if (saved && saved.drive && typeof saved.drive === "object") {
      saved.drive = { folderId: saved.drive.folderId ?? undefined, connected: !!saved.drive.refreshToken };
    }
    res.json(saved);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/facebook/test — kiểm tra token + page id.
router.post("/autopost/facebook/test", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const v = await verifyPageToken();
    res.json(v);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─────────────────────────────── DRY RUN ─────────────────────────────────────

// GET /autopost/dryrun — trạng thái dry-run HIỆU LỰC (env thắng → db → mặc định
// BẬT). Trả { dryRun, source: 'env'|'db'|'default', envForced, canToggle }.
router.get("/autopost/dryrun", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    res.json(await describeDryRun());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PUT /autopost/dryrun — đặt dry-run ở DB (body { dryRun: boolean }). KHÔNG ghi
// đè ENV: nếu ENV đang khóa thì vẫn lưu DB (dùng khi sau này gỡ ENV) và trả về
// trạng thái hiệu lực thật (vẫn theo ENV) để UI báo rõ. Không bao giờ tự bật
// đăng-thật do mơ hồ: chỉ dryRun=false tường minh mới mở.
router.put("/autopost/dryrun", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const approver = verifyToken(req.headers.authorization);
    if (approver == null) {
      res.status(401).json({ error: "Token không hợp lệ hoặc hết hạn" });
      return;
    }
    const dryRun = (req.body ?? {}).dryRun;
    if (typeof dryRun !== "boolean") {
      res.status(400).json({ error: "dryRun phải là boolean (true = chế độ thử, false = đăng thật)" });
      return;
    }
    await patchAutopostConfig({ dryRun }, approver);
    res.json(await describeDryRun());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─────────────────────── CẤU HÌNH VẬN HÀNH (operational) ─────────────────────

// GET /autopost/config — config đã chuẩn hoá (số bài/caption/ảnh-vision, auto-approve…).
router.get("/autopost/config", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    res.json(await getAutopostConfig());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PUT /autopost/config — gộp các key vận hành vào config (giữ tone/bannedWords/drive).
router.put("/autopost/config", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const approver = verifyToken(req.headers.authorization);
    if (approver == null) { res.status(401).json({ error: "Token không hợp lệ hoặc hết hạn" }); return; }
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};
    const intKeys: Array<[string, number, number]> = [
      ["postsPerTick", 1, 50], ["postsPerDay", 1, 50],
      ["captionOptionsPerPost", 1, 6], ["maxVisionImagesPerPost", 1, 10],
      ["autoApproveAfterMinutes", 1, 1440],
    ];
    for (const [k, min, max] of intKeys) {
      if (b[k] != null) {
        const n = Number(b[k]);
        if (Number.isFinite(n)) patch[k] = Math.min(max, Math.max(min, Math.trunc(n)));
      }
    }
    for (const k of ["autoApproveEnabled", "autoPublishAfterApproved", "requireManualApproval"]) {
      if (typeof b[k] === "boolean") patch[k] = b[k];
    }
    await patchAutopostConfig(patch, approver);
    // TẮT công tắc tự đăng → trả các bài đang đếm ngược ('review_pending') về
    // 'pending_review' để KHÔNG bị kẹt (sweep dừng đụng review_pending khi tắt; mà
    // /approve cũ thì không nhận). Tránh bài treo "đang đếm ngược" mà chẳng làm gì.
    if (patch.autoApproveEnabled === false) {
      await pool.query(
        `UPDATE autopost_posts SET status = 'pending_review', updated_at = now() WHERE status = 'review_pending'`,
      ).catch((e) => console.error("[AutoPost] demote review_pending khi tắt tự đăng lỗi:", e));
    }
    res.json(await getAutopostConfig());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─────────────────────── CHỮ KÝ CUỐI BÀI (footer thương hiệu) ────────────────

// GET /autopost/footer — cấu hình footer + text preview đã dựng sẵn.
router.get("/autopost/footer", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const bf = await getBrandFooter();
    res.json({ ...bf, text: buildFooterText(bf) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PUT /autopost/footer — lưu cấu hình footer (gộp đủ field, giữ field không gửi).
router.put("/autopost/footer", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const approver = verifyToken(req.headers.authorization);
    if (approver == null) { res.status(401).json({ error: "Token không hợp lệ hoặc hết hạn" }); return; }
    const b = req.body ?? {};
    const cur = await getBrandFooter();
    const next: Record<string, unknown> = {
      enabled: typeof b.enabled === "boolean" ? b.enabled : cur.enabled,
      template: b.template != null ? String(b.template) : cur.template,
      name: b.name != null ? String(b.name) : cur.name,
      address: b.address != null ? String(b.address) : cur.address,
      phone: b.phone != null ? String(b.phone) : cur.phone,
      website: b.website != null ? String(b.website) : cur.website,
      facebook: b.facebook != null ? String(b.facebook) : cur.facebook,
      tiktok: b.tiktok != null ? String(b.tiktok) : cur.tiktok,
      note: b.note != null ? String(b.note) : cur.note,
    };
    await patchAutopostConfig({ footer: next }, approver);
    const bf = await getBrandFooter();
    res.json({ ...bf, text: buildFooterText(bf) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─────────────────────────── CHỮ KÝ TIỆM (signatures) ───────────────────────
// Bảng riêng autopost_signatures: admin tự quản nhiều mẫu chữ ký, chọn 1 mặc định.
// Chữ ký gắn cuối bài lúc đăng (autopost-scheduler) — AI KHÔNG sửa, không hardcode.

// Chuẩn hoá payload chữ ký (dùng chung create/update). GIỮ NGUYÊN content (Unicode/xuống dòng).
function signatureFields(b: any): { name: string; content: string; isActive: boolean; isDefault: boolean } {
  return {
    name: String(b?.name ?? "").trim(),
    content: String(b?.content ?? ""),
    isActive: typeof b?.isActive === "boolean" ? b.isActive : true,
    isDefault: typeof b?.isDefault === "boolean" ? b.isDefault : false,
  };
}

// Đảm bảo chỉ 1 chữ ký là mặc định (gỡ cờ default ở các chữ ký khác).
async function clearOtherDefaults(keepId: number): Promise<void> {
  await pool.query(
    `UPDATE autopost_signatures SET is_default = false, updated_at = now() WHERE id <> $1 AND is_default = true`,
    [keepId],
  );
}

// GET /autopost/signatures — danh sách chữ ký (mặc định lên đầu).
router.get("/autopost/signatures", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    res.json(await listSignatures());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /autopost/signatures/default — chữ ký mặc định đang bật (cho preview nút gắn).
router.get("/autopost/signatures/default", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    res.json({ content: await getDefaultSignatureContent() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/signatures — thêm chữ ký.
router.post("/autopost/signatures", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const f = signatureFields(req.body);
    if (!f.name) { res.status(400).json({ error: "Cần nhập tên chữ ký" }); return; }
    if (!f.content.trim()) { res.status(400).json({ error: "Cần nhập nội dung chữ ký" }); return; }
    const r = await pool.query(
      `INSERT INTO autopost_signatures (name, content, is_active, is_default, updated_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING id`,
      [f.name, f.content, f.isActive, f.isDefault],
    );
    const id = Number((r.rows[0] as any).id);
    if (f.isDefault) await clearOtherDefaults(id);
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PUT /autopost/signatures/:id — sửa chữ ký.
router.put("/autopost/signatures/:id", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const f = signatureFields(req.body);
    const id = Number(req.params.id);
    if (!f.name) { res.status(400).json({ error: "Cần nhập tên chữ ký" }); return; }
    if (!f.content.trim()) { res.status(400).json({ error: "Cần nhập nội dung chữ ký" }); return; }
    const r = await pool.query(
      `UPDATE autopost_signatures
          SET name=$1, content=$2, is_active=$3, is_default=$4, updated_at=now()
        WHERE id=$5 RETURNING id`,
      [f.name, f.content, f.isActive, f.isDefault, id],
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Không tìm thấy chữ ký" }); return; }
    if (f.isDefault) await clearOtherDefaults(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// DELETE /autopost/signatures/:id — xoá chữ ký.
router.delete("/autopost/signatures/:id", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    await pool.query(`DELETE FROM autopost_signatures WHERE id = $1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─────────────────────────── VĂN PHONG MẪU (style bank) ──────────────────────

// GET /autopost/style-samples — liệt kê bài mẫu (mới/ưu tiên cao trước).
router.get("/autopost/style-samples", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(
      `SELECT id, title, content, tags, content_type AS "contentType", tone,
              is_active AS "isActive", priority, images,
              style_topic_key AS "styleTopicKey", style_topic_label AS "styleTopicLabel",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM autopost_style_samples
        ORDER BY priority DESC, id DESC`,
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Chuẩn hoá payload bài mẫu từ body (dùng chung create/update).
function styleSampleFields(b: any): { title: string; content: string; tags: string[]; contentType: string | null; tone: string | null; isActive: boolean; priority: number; images: string[]; styleTopicKey: string; styleTopicLabel: string } {
  const tags = Array.isArray(b?.tags)
    ? b.tags.filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0).map((t: string) => t.trim())
    : [];
  // images: chỉ chấp nhận objectPath nội bộ (/objects/...) — KHÔNG nhận base64/URL ngoài ở đây.
  const images = Array.isArray(b?.images)
    ? b.images.filter((u: unknown): u is string => typeof u === "string" && u.startsWith("/objects/")).slice(0, 10)
    : [];
  // Chủ đề văn phong: validate key trong 14 chủ đề; label luôn lấy chuẩn từ server theo key.
  const rawTopic = String(b?.styleTopicKey ?? "all").trim();
  const styleTopicKey = isValidStyleTopic(rawTopic) ? rawTopic : "all";
  return {
    title: String(b?.title ?? "").trim(),
    content: String(b?.content ?? "").trim(),
    tags,
    contentType: b?.contentType ? String(b.contentType) : null,
    tone: b?.tone ? String(b.tone) : null,
    isActive: typeof b?.isActive === "boolean" ? b.isActive : true,
    priority: Number.isFinite(Number(b?.priority)) ? Math.trunc(Number(b.priority)) : 0,
    images,
    styleTopicKey,
    styleTopicLabel: styleTopicLabel(styleTopicKey),
  };
}

// POST /autopost/style-samples — thêm bài mẫu (paste text, hoặc text OCR + ảnh gốc).
router.post("/autopost/style-samples", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const f = styleSampleFields(req.body);
    if (!f.title) { res.status(400).json({ error: "Cần nhập tiêu đề" }); return; }
    if (!f.content) { res.status(400).json({ error: "Cần nhập nội dung bài mẫu" }); return; }
    const r = await pool.query(
      `INSERT INTO autopost_style_samples (title, content, tags, content_type, tone, is_active, priority, images, style_topic_key, style_topic_label, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9, $10, now()) RETURNING id`,
      [f.title, f.content, JSON.stringify(f.tags), f.contentType, f.tone, f.isActive, f.priority, JSON.stringify(f.images), f.styleTopicKey, f.styleTopicLabel],
    );
    res.json({ id: (r.rows[0] as any).id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PUT /autopost/style-samples/:id — sửa bài mẫu.
router.put("/autopost/style-samples/:id", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const f = styleSampleFields(req.body);
    if (!f.title) { res.status(400).json({ error: "Cần nhập tiêu đề" }); return; }
    if (!f.content) { res.status(400).json({ error: "Cần nhập nội dung bài mẫu" }); return; }
    const r = await pool.query(
      `UPDATE autopost_style_samples
          SET title=$1, content=$2, tags=$3::jsonb, content_type=$4, tone=$5, is_active=$6, priority=$7, images=$8::jsonb, style_topic_key=$9, style_topic_label=$10, updated_at=now()
        WHERE id=$11 RETURNING id`,
      [f.title, f.content, JSON.stringify(f.tags), f.contentType, f.tone, f.isActive, f.priority, JSON.stringify(f.images), f.styleTopicKey, f.styleTopicLabel, Number(req.params.id)],
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Không tìm thấy bài mẫu" }); return; }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/style-samples/ocr — nhận 1 ảnh base64 → lưu ảnh gốc + AI OCR đọc chữ.
// Trả { url, text }. Frontend gọi lần lượt cho từng ảnh (tối đa 10) để có tiến độ.
router.post("/autopost/style-samples/ocr", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const b = req.body ?? {};
    const dataBase64 = String(b.dataBase64 ?? "").replace(/^data:[^;]+;base64,/, "");
    const mediaType = String(b.mediaType ?? "image/jpeg");
    if (!dataBase64) { res.status(400).json({ error: "Thiếu ảnh (dataBase64)" }); return; }

    // Lưu ảnh gốc để admin xem lại (không chặn OCR nếu lưu lỗi).
    let url: string | null = null;
    try {
      url = await persistImageBuffer(Buffer.from(dataBase64, "base64"), mediaType, "style-sample");
    } catch (e) {
      console.warn("[AutoPost] lưu ảnh OCR lỗi:", String(e).slice(0, 120));
    }

    const ocr = await ocrImageToText({ mediaType, dataBase64 });
    if (!ocr.ok) { res.status(502).json({ error: "ocr_failed", reason: ocr.reason, url }); return; }
    res.json({ url, text: ocr.text, provider: ocr.provider });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// DELETE /autopost/style-samples/:id — xoá bài mẫu.
router.delete("/autopost/style-samples/:id", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    await pool.query(`DELETE FROM autopost_style_samples WHERE id = $1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/style-samples/test — "Test viết theo văn phong này". Sinh caption
// NGAY để xem trước, KHÔNG lưu bài. Nhận poolId HOẶC item ad-hoc (title/contentType/images).
router.post("/autopost/style-samples/test", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const b = req.body ?? {};
    const cfgR = await pool.query(`SELECT config FROM autopost_settings WHERE id = 1`);
    const cfg = (cfgR.rows[0]?.config as any) ?? {};
    const tone = typeof cfg.tone === "string" ? cfg.tone : undefined;
    const bannedWords = Array.isArray(cfg.bannedWords) ? cfg.bannedWords : undefined;
    const opcfg = await getAutopostConfig();

    let item;
    if (b.poolId) {
      const pr = await pool.query(`SELECT * FROM autopost_content_pool WHERE id = $1`, [Number(b.poolId)]);
      if (!pr.rows[0]) { res.status(404).json({ error: "Không tìm thấy item trong pool" }); return; }
      item = poolRowToCaptionItem(pr.rows[0]);
    } else {
      const images = Array.isArray(b.images) ? b.images.filter((x: unknown): x is string => typeof x === "string") : [];
      item = poolRowToCaptionItem({
        content_type: b.contentType ?? "other",
        title: b.title ?? "Bài test",
        images,
        price: b.price ?? null,
        public_link: b.publicLink ?? null,
      });
    }

    const samples = Array.isArray(b.styleSampleIds) && b.styleSampleIds.length
      ? await getSamplesByIds(b.styleSampleIds.map(Number))
      : await pickRelevantSamples({ topicKey: topicForContentType(item.contentType), limit: 4 });
    const styleBlock = buildStyleBlock(samples);
    const wantCaptions = Math.max(1, Math.min(6, Number(b.captionCount) || opcfg.captionOptionsPerPost));

    const result = await generateCaptions(item, {
      tone, bannedWords, styleBlock,
      captionCount: wantCaptions,
      maxVisionImages: opcfg.maxVisionImagesPerPost,
    });
    if (!result.ok) { res.status(502).json({ error: "caption_failed", reason: result.reason }); return; }
    res.json({
      captions: result.captions,
      recommendedIndex: result.recommendedIndex,
      usedVision: result.usedVision,
      visionImageCount: result.visionImageCount,
      provider: result.provider,
      usedSampleIds: samples.map((s) => s.id),
      usedSampleTitles: samples.map((s) => s.title),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─────────────────────────── GOOGLE DRIVE (Phase 2) ─────────────────────────

// GET /autopost/drive/status — trạng thái kết nối (đã connect chưa, nguồn env, folder).
// Read-only; KHÔNG trả token/secret.
router.get("/autopost/drive/status", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    res.json(await driveStatus());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/drive/test — kiểm tra credential env + liệt kê folder con đã map.
router.post("/autopost/drive/test", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    res.json(await verifyDriveConnection());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/drive/sync — đồng bộ ảnh/video từ Google Drive vào pool (read-only).
router.post("/autopost/drive/sync", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    res.json(await syncGoogleDrivePool());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── OAuth 3-legged (Web app) — admin bấm "Kết nối Google Drive" ───────────────
// State ký HMAC (chống CSRF callback) + chứa redirectUri đã dùng để exchange khớp.
function driveStateSecret(): string {
  return process.env.SESSION_SECRET || "autopost-drive-oauth-state";
}
function signDriveState(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", driveStateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyDriveState(state: string): Record<string, any> | null {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) return null;
  const expect = createHmac("sha256", driveStateSecret()).update(body).digest("base64url");
  if (sig !== expect) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof p.exp === "number" && p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}
function safeDriveRedirectUri(raw: unknown): string | null {
  const s = String(raw || "");
  return /^https?:\/\/[^\s"']+\/api\/autopost\/drive\/callback$/.test(s) ? s : null;
}
function drivePage(message: string, ok = false): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;text-align:center;color:#222">
<div style="font-size:42px">${ok ? "✅" : "⚠️"}</div>
<p style="font-size:16px;line-height:1.6">${message}</p>
<p><a href="/auto-post-facebook" style="display:inline-block;margin-top:12px;padding:10px 18px;background:#e11d63;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">Quay lại AutoPost</a></p>
</body>`;
}

// GET /autopost/drive/connect?token=<jwt>&redirectUri=<...> — bắt đầu OAuth (browser nav).
router.get("/autopost/drive/connect", async (req: Request, res: Response) => {
  const role = await getCallerRole(`Bearer ${String(req.query.token ?? "")}`);
  if (role !== "admin") { res.status(403).send(drivePage("Chỉ admin được phép kết nối Google Drive.")); return; }
  if (!getOAuthClientEnv()) {
    res.status(400).send(drivePage("Thiếu Client ID/Secret: đặt GOOGLE_DRIVE_CLIENT_ID/SECRET hoặc GOOGLE_CLIENT_ID/SECRET trong môi trường."));
    return;
  }
  const redirectUri = safeDriveRedirectUri(req.query.redirectUri);
  if (!redirectUri) { res.status(400).send(drivePage("redirectUri không hợp lệ.")); return; }
  try {
    const state = signDriveState({ exp: Date.now() + 10 * 60 * 1000, r: redirectUri });
    res.redirect(302, getDriveAuthUrl(redirectUri, state));
  } catch (e) {
    res.status(500).send(drivePage(`Lỗi tạo URL OAuth: ${String(e instanceof Error ? e.message : e)}`));
  }
});

// GET /autopost/drive/callback?code=&state= — Google redirect về; đổi code → refresh_token.
router.get("/autopost/drive/callback", async (req: Request, res: Response) => {
  if (req.query.error) { res.status(400).send(drivePage(`Google từ chối: ${String(req.query.error)}`)); return; }
  const state = verifyDriveState(String(req.query.state ?? ""));
  if (!state) { res.status(400).send(drivePage("State không hợp lệ hoặc đã hết hạn — bấm Kết nối lại.")); return; }
  const redirectUri = safeDriveRedirectUri(state.r);
  const code = String(req.query.code ?? "");
  if (!redirectUri || !code) { res.status(400).send(drivePage("Thiếu code/redirectUri.")); return; }
  try {
    const refreshToken = await exchangeCodeForRefreshToken(code, redirectUri);
    await saveDriveRefreshToken(refreshToken); // không log token
    res.send(drivePage("Đã kết nối Google Drive thành công! Quay lại trang AutoPost → bấm <b>Test kết nối</b> rồi <b>Đồng bộ Google Drive</b>.", true));
  } catch (e) {
    res.status(500).send(drivePage(`Đổi token lỗi: ${String(e instanceof Error ? e.message : e)}`));
  }
});

export default router;
