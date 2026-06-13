import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "./auth";
import { askClaudeForReply, resolveModel, type ClaudeHistoryItem } from "../lib/claude-sale";
import { getSaleContext, getSaleContextInfo } from "../lib/sale-context";
import { getActivePlaybook } from "../lib/sale-playbook";
import { getClaudeSaleSettings, computeReplyDelayMs } from "../lib/sale-settings";
import { getScheduleContext } from "../lib/sale-calendar";
import { getMasterEnabled } from "../lib/sale-master";

/**
 * KARU / Claude Sale Test — sân test nội bộ cho admin.
 *
 * Dùng ĐÚNG askClaudeForReply() + sale-context.ts như luồng Facebook, NHƯNG:
 *  - KHÔNG gửi tin ra Messenger.
 *  - KHÔNG ghi fb_inbox_messages, KHÔNG tạo/sửa crm_leads, KHÔNG tạo booking.
 *  - Chỉ mô phỏng khách → trả về câu trả lời của Claude để admin xem.
 * Không phụ thuộc CLAUDE_FB_BOT_ENABLED (đây là công cụ test trước khi bật).
 */

const router: IRouter = Router();

async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) {
    res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
    return false;
  }
  const r = await pool.query(`SELECT role, roles FROM staff WHERE id = $1 AND is_active = 1`, [callerId]);
  const u = r.rows[0] as { role?: string; roles?: unknown } | undefined;
  const isAdmin = u && (u.role === "admin" || (Array.isArray(u.roles) && u.roles.includes("admin")));
  if (!isAdmin) {
    res.status(403).json({ error: "Chỉ admin được dùng Claude Sale Test" });
    return false;
  }
  return true;
}

// Thông tin để hiển thị: model, số gói context, đã có API key chưa
router.get("/claude-sale-test/info", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const hasApiKey = !!(process.env.ANTHROPIC_API_KEY ?? "").trim();
  let packageCount = 0;
  let totalActive = 0;
  try {
    const info = await getSaleContextInfo();
    packageCount = info.packageCount;
    totalActive = info.totalActive;
  } catch { /* để 0 nếu lỗi đọc DB */ }
  const playbookActive = !!(await getActivePlaybook());
  const masterEnabled = await getMasterEnabled();
  res.json({
    model: resolveModel(),
    hasApiKey,
    packageCount,
    totalActive,
    playbookActive,
    // fbBotEnabled = cầu dao tổng (DB) — nguồn duy nhất cho cả Test & Messenger.
    fbBotEnabled: masterEnabled,
    masterEnabled,
  });
});

// Gửi 1 tin khách (mô phỏng) → nhận câu trả lời của Claude
router.post("/claude-sale-test/chat", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;

  const body = req.body as {
    message?: string;
    messages?: Array<{ direction?: string; text?: string }>;
  };
  const message = (body.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "Thiếu nội dung tin nhắn" });

  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) {
    return res.status(400).json({ error: "Chưa cấu hình ANTHROPIC_API_KEY trong .env" });
  }

  // Lịch sử trước đó (admin gửi lên) → chuẩn hóa, rồi nối tin mới ở cuối (incoming)
  const prior: ClaudeHistoryItem[] = Array.isArray(body.messages)
    ? body.messages
        .filter((m) => m && typeof m.text === "string" && m.text.trim())
        .map((m) => ({
          direction: m.direction === "outgoing" ? "outgoing" : "incoming",
          message: String(m.text).trim(),
        }))
    : [];
  const history: ClaudeHistoryItem[] = [...prior, { direction: "incoming", message }];

  const model = resolveModel();
  const startedAt = Date.now();
  try {
    const context = await getSaleContext();
    const styleGuide = await getActivePlaybook();
    const settings = await getClaudeSaleSettings();
    let scheduleContext = "";
    if (settings.calendarEnabled) {
      try { scheduleContext = await getScheduleContext(settings.calWindowDays); } catch { /* bỏ qua */ }
    }
    const reply = await askClaudeForReply({
      apiKey,
      model,
      customerMessage: message,
      customerName: "Khách test",
      history,
      context,
      styleGuide,
      settings,
      scheduleContext,
    });
    const responseTimeMs = Date.now() - startedAt;
    return res.json({
      reply: reply.messages.length > 0 ? reply.messages : reply.raw ? [reply.raw] : ["(Claude không trả về nội dung)"],
      raw: reply.raw,
      model,
      responseTimeMs,
      // Delay cấu hình theo độ dài tin khách (để sân test mô phỏng đúng tốc độ Fanpage).
      replyDelayMs: computeReplyDelayMs(message, settings),
      // Sân test KHÔNG đụng DB: chỉ hiển thị để admin thấy AI sẽ làm gì.
      escalation: reply.escalation,
      learnedName: reply.learnedName,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ClaudeSaleTest] lỗi gọi Claude:", msg);
    // Không crash — trả lỗi gọn để UI hiển thị
    return res.status(502).json({ error: `Claude lỗi: ${msg.slice(0, 300)}`, model, responseTimeMs: Date.now() - startedAt });
  }
});

export default router;
