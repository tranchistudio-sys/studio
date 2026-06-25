/**
 * routes/autopost-style-jobs.ts — Endpoint HÀNG CHỜ học Văn phong mẫu (async).
 *
 * Tách riêng khỏi auto-post-facebook.ts để KHÔNG đụng vào file đang có WIP + giữ
 * commit sạch. Mọi endpoint require admin (giống auto-post-facebook).
 *  - POST   /autopost/style-samples/jobs        → tạo job, trả NGAY (không chờ AI).
 *  - GET    /autopost/style-samples/jobs        → danh sách job + trạng thái.
 *  - POST   /autopost/style-samples/jobs/:id/retry → job 'failed' → 'pending'.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { getCallerRole } from "./auth";
import { persistImageBuffer } from "../lib/autopost-storage";
import {
  createStyleJob, listStyleJobs, retryStyleJob, type StyleJobImage,
} from "../lib/autopost-style-jobs";

const router: IRouter = Router();

async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const role = await getCallerRole(req.headers.authorization);
  if (role !== "admin") { res.status(403).json({ error: "Chỉ admin được phép" }); return false; }
  return true;
}

function asStr(v: unknown, def = ""): string { return typeof v === "string" ? v : def; }

// POST /autopost/style-samples/jobs — tạo job học bài mẫu (trả ngay, worker xử lý nền).
router.post("/autopost/style-samples/jobs", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const b = req.body ?? {};
    const title = asStr(b.title).trim();
    if (!title) { res.status(400).json({ error: "Cần nhập tiêu đề" }); return; }

    const rawImages: Array<{ dataBase64?: unknown; mediaType?: unknown }> = Array.isArray(b.images) ? b.images : [];
    const pastedText = asStr(b.pastedText).trim() || null;
    if (rawImages.length === 0 && !pastedText) {
      res.status(400).json({ error: "Cần ít nhất 1 ảnh để đọc hoặc nội dung dán sẵn" });
      return;
    }

    // Lưu ảnh gốc NGAY (I/O nhanh) để admin xem lại + gắn vào sample; giữ base64 cho worker OCR.
    const imagesBase64: StyleJobImage[] = [];
    const imageUrls: string[] = [];
    for (const img of rawImages.slice(0, 10)) {
      const dataBase64 = asStr(img.dataBase64).replace(/^data:[^;]+;base64,/, "");
      const mediaType = asStr(img.mediaType, "image/jpeg");
      if (!dataBase64) continue;
      imagesBase64.push({ dataBase64, mediaType });
      try {
        const url = await persistImageBuffer(Buffer.from(dataBase64, "base64"), mediaType, "style-sample");
        if (url) imageUrls.push(url);
      } catch (e) {
        // Lưu ảnh lỗi → không chặn job (OCR vẫn chạy từ base64); chỉ thiếu ảnh hiển thị.
        console.warn("[AutoPostStyleJobs] lưu ảnh lỗi:", String(e).slice(0, 120));
      }
    }

    const id = await createStyleJob({
      title,
      contentType: asStr(b.contentType) || null,
      tone: asStr(b.tone) || null,
      tags: Array.isArray(b.tags) ? b.tags.filter((t: unknown): t is string => typeof t === "string") : [],
      priority: Number.isFinite(Number(b.priority)) ? Number(b.priority) : 0,
      styleTopicKey: asStr(b.styleTopicKey) || "all",
      styleTopicLabel: asStr(b.styleTopicLabel) || "Tất cả / Dùng chung",
      pastedText,
      imagesBase64,
      imageUrls,
    });
    res.status(202).json({ id, status: "pending" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /autopost/style-samples/jobs — danh sách job gần đây + trạng thái.
router.get("/autopost/style-samples/jobs", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    res.json({ jobs: await listStyleJobs(limit) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /autopost/style-samples/jobs/:id/retry — chạy lại job lỗi.
router.post("/autopost/style-samples/jobs/:id/retry", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const ok = await retryStyleJob(Number(req.params.id));
    if (!ok) { res.status(400).json({ error: "Chỉ retry được job đang ở trạng thái 'failed'" }); return; }
    res.json({ ok: true, status: "pending" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
