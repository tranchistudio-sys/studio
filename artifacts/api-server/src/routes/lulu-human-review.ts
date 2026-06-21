import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "./auth";
import { sendManualReply } from "./fb-inbox";
import { clearNeedsHuman } from "../lib/sale-lead-flags";
import { getClaudeSaleSettings } from "../lib/sale-settings";
import { ensureSalePlaybookTable, clearPlaybookCache } from "../lib/sale-playbook";
import {
  listHumanReviews, getHumanReview, markReviewSent, markReviewIgnored,
  markReviewSavedToPlaybook, countOpenReviews,
  type HumanReviewStatus, type HumanReviewPriority,
} from "../lib/sale-human-review";

/**
 * Module "Câu hỏi lạ cần xử lý" (Lulu Human Review).
 *
 * Nhân viên thật xử lý các báo đỏ do Lulu tạo khi không chắc: trả lời NGUYÊN VĂN cho khách,
 * lưu câu trả lời tốt thành kịch bản (draft), bỏ qua, hoặc mở lại bot.
 *
 * AN TOÀN: chỉ đụng bảng của module sale AI + gửi tin Messenger qua helper dùng chung.
 * KHÔNG đụng booking/payment/calendar/attendance.
 */

const router: IRouter = Router();

async function requireStaff(req: Request, res: Response): Promise<{ id: number; name: string | null } | null> {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) {
    res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
    return null;
  }
  const r = await pool.query(`SELECT id, name FROM staff WHERE id = $1 AND is_active = 1`, [callerId]);
  const u = r.rows[0] as { id: number; name?: string } | undefined;
  if (!u) {
    res.status(401).json({ error: "Tài khoản không hợp lệ" });
    return null;
  }
  return { id: u.id, name: u.name ?? null };
}

function parseFbError(errStr: string): string {
  try {
    const m = errStr.match(/Facebook send failed: \d+ (.+)/);
    if (m) {
      const parsed = JSON.parse(m[1]) as { error?: { message?: string } };
      if (parsed?.error?.message) return parsed.error.message;
    }
  } catch { /* giữ nguyên */ }
  return errStr;
}

// Danh sách báo đỏ (mặc định status=open). ?status=open|sent|ignored|all &priority=...&limit=
router.get("/lulu-human-reviews", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  const status = (req.query.status as HumanReviewStatus | "all") || "open";
  const priority = (req.query.priority as HumanReviewPriority | "all") || "all";
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  try {
    const rows = await listHumanReviews({ status, priority, limit });
    const openCount = await countOpenReviews();
    res.json({ reviews: rows, openCount });
  } catch (err) {
    console.error("[HumanReview] list lỗi:", String(err).slice(0, 200));
    res.status(500).json({ error: "Không tải được danh sách" });
  }
});

// Badge đỏ — số báo đỏ đang chờ xử lý.
router.get("/lulu-human-reviews/count-open", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  try {
    res.json({ openCount: await countOpenReviews() });
  } catch {
    res.json({ openCount: 0 });
  }
});

// Gửi câu trả lời của nhân viên cho khách — NGUYÊN VĂN. Giữ takeover (KHÔNG tự mở lại bot — điểm 1).
router.post("/lulu-human-reviews/:id/reply", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const id = Number(req.params.id);
  const { text } = req.body as { text?: string };
  if (!text || !text.trim()) return res.status(400).json({ error: "Thiếu nội dung trả lời" });

  const review = await getHumanReview(id);
  if (!review) return res.status(404).json({ error: "Không tìm thấy báo đỏ" });
  if (review.channel !== "messenger") {
    return res.status(400).json({ error: "Chỉ gửi được cho hội thoại Messenger" });
  }

  try {
    await sendManualReply(review.facebookUserId, text, caller.name);
    await markReviewSent(id, text.trim(), caller.id);
    // Escalation đã được người thật xử lý → gỡ cờ needs_human (Monitor). Vẫn GIỮ takeover.
    await clearNeedsHuman(review.facebookUserId).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    const errStr = String(err);
    console.error(`[HumanReview] reply id=${id} gửi lỗi:`, errStr.slice(0, 200));
    res.status(500).json({ error: "Gửi Facebook thất bại", fbError: parseFbError(errStr) });
  }
});

// Lưu câu trả lời tốt thành kịch bản sale — CHỈ tạo DRAFT (không tự active — điểm 5).
router.post("/lulu-human-reviews/:id/save-playbook", async (req, res) => {
  const caller = await requireStaff(req, res);
  if (!caller) return;
  const id = Number(req.params.id);

  const settings = await getClaudeSaleSettings();
  if (!settings.saveHumanAnswerAsPlaybook) {
    return res.status(400).json({ error: "Tính năng lưu kịch bản đang tắt trong Cấu hình Lulu" });
  }
  const review = await getHumanReview(id);
  if (!review) return res.status(404).json({ error: "Không tìm thấy báo đỏ" });
  const answer = (review.staffReply ?? "").trim();
  if (!answer) return res.status(400).json({ error: "Chưa có câu trả lời của nhân viên để lưu" });

  const content =
    `Tình huống khách hỏi: "${review.customerQuestion.trim()}"\n` +
    `Cách trả lời tốt (nhân viên thật đã duyệt): "${answer}"`;
  const title = `Lulu học: ${(review.detectedIntent || review.reasonForEscalation || "tình huống lạ").slice(0, 60)}`;

  try {
    await ensureSalePlaybookTable();
    await pool.query(
      `INSERT INTO sale_playbooks (title, status, content, source_summary, created_by, created_by_name)
       VALUES ($1, 'draft', $2, $3, $4, $5)`,
      [title, content, `Từ Human Review #${id}`, caller.id, caller.name],
    );
    clearPlaybookCache();
    await markReviewSavedToPlaybook(id);
    res.json({ success: true, message: "Đã lưu thành kịch bản nháp — vào Sale Learning để duyệt & bật." });
  } catch (err) {
    console.error(`[HumanReview] save-playbook id=${id} lỗi:`, String(err).slice(0, 200));
    res.status(500).json({ error: "Lưu kịch bản thất bại" });
  }
});

// Bỏ qua báo đỏ (không cần trả lời).
router.post("/lulu-human-reviews/:id/ignore", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  const id = Number(req.params.id);
  const review = await getHumanReview(id);
  if (!review) return res.status(404).json({ error: "Không tìm thấy báo đỏ" });
  try {
    await markReviewIgnored(id);
    await clearNeedsHuman(review.facebookUserId).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error(`[HumanReview] ignore id=${id} lỗi:`, String(err).slice(0, 200));
    res.status(500).json({ error: "Không bỏ qua được" });
  }
});

// Mở lại bot cho thread (set ai_mode='active') — nút riêng (điểm 1).
router.post("/lulu-human-reviews/:id/reopen-bot", async (req, res) => {
  if (!(await requireStaff(req, res))) return;
  const id = Number(req.params.id);
  const review = await getHumanReview(id);
  if (!review) return res.status(404).json({ error: "Không tìm thấy báo đỏ" });
  try {
    await pool.query(`UPDATE crm_leads SET ai_mode = 'active' WHERE facebook_user_id = $1`, [review.facebookUserId]);
    await clearNeedsHuman(review.facebookUserId).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    console.error(`[HumanReview] reopen-bot id=${id} lỗi:`, String(err).slice(0, 200));
    res.status(500).json({ error: "Không mở lại được bot" });
  }
});

export default router;
