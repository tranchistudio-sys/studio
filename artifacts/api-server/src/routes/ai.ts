import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { verifyToken, getCallerRole } from "./auth";
import {
  answerStudioCopilot,
  buildAnalysisContext,
  COPILOT_SYSTEM_PROMPT,
  isLlmConfigured,
} from "../lib/studio-copilot";
import { callChat } from "../lib/ai-orchestrator";

const router: IRouter = Router();

const rateLimitMap = new Map<number, number>();
const RATE_LIMIT_MS = 3000;

function streamCopilotAnswer(res: import("express").Response, answer: string) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write("data: " + JSON.stringify({ content: answer }) + "\n\n");
  res.write("data: " + JSON.stringify({ done: true }) + "\n\n");
  res.end();
}

function checkRateLimit(callerId: number): boolean {
  const now = Date.now();
  const lastCall = rateLimitMap.get(callerId) ?? 0;
  if (now - lastCall < RATE_LIMIT_MS) return false;
  rateLimitMap.set(callerId, now);
  return true;
}

async function getStaffName(callerId: number): Promise<string | null> {
  try {
    const r = await pool.query(`SELECT name FROM staff WHERE id = $1 AND is_active = 1`, [callerId]);
    const name = (r.rows[0] as { name?: string } | undefined)?.name;
    return name?.trim() || null;
  } catch {
    return null;
  }
}

router.post("/ai/chat", async (req, res) => {
  try {
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });

    // Studio Copilot đọc dữ liệu nhạy cảm (doanh thu/công nợ/SĐT khách/chấm công)
    // → CHỈ admin/quản lý. Nhân viên thường bị chặn.
    const callerRole = await getCallerRole(req.headers.authorization);
    if (callerRole !== "admin") {
      return res.status(403).json({ error: "Trợ lý điều hành chỉ dành cho quản trị viên/quản lý." });
    }

    if (!checkRateLimit(callerId)) {
      return res.status(429).json({ error: "Chờ 3 giây rồi hãy gọi lại." });
    }

    const { messages } = req.body as { messages?: Array<{ role: string; content: string }> };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Thiếu nội dung tin nhắn" });
    }

    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const lastQuestion = (lastUser?.content ?? "").trim();
    const staffName = await getStaffName(callerId);

    const copilot = await answerStudioCopilot(lastQuestion, staffName);

    // Copilot xử lý mọi intent trừ phân tích khi có LLM
    if (copilot.intent !== "analysis" || !isLlmConfigured()) {
      streamCopilotAnswer(res, copilot.answer);
      return;
    }

    const analysisContext = await buildAnalysisContext();
    const systemInstruction = `${COPILOT_SYSTEM_PROMPT}

## QUY TẮC TRẢ LỜI
1. Chỉ dùng số liệu bên dưới — không bịa.
2. Trả lời ngắn: tổng số → danh sách quan trọng → cảnh báo → gợi ý hành động.
3. Không chào hỏi dài, không FAQ chung chung.

## DỮ LIỆU THỰC TẾ
${analysisContext}`;

    // Qua TỔNG ĐÀI: Claude (chính) → OpenAI (dự phòng). Giữ NGUYÊN prompt nội bộ
    // (COPILOT_SYSTEM_PROMPT) — KHÔNG giọng Hoa, KHÔNG playbook sale.
    // Trả nguyên khối (không stream từng chữ) để hỗ trợ fallback nhiều provider;
    // frontend đọc cùng định dạng SSE {content}+{done}.
    const convo = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content ?? "") }));
    while (convo.length && convo[0].role === "assistant") convo.shift();

    const result = await callChat({
      system: systemInstruction,
      messages: convo,
      maxTokens: 4096,
      label: "copilot",
    });

    const answer = result.ok
      ? result.text
      : "Dạ trợ lý đang bận hoặc cấu hình AI gặp trục trặc, anh/chị thử lại sau ít phút giúp em nha.";
    streamCopilotAnswer(res, answer);
  } catch (err: unknown) {
    console.error("POST /ai/chat error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    const isQuota = msg.includes("429") || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("rate limit");
    const userMsg = isQuota
      ? "Đã đạt giới hạn yêu cầu AI. Vui lòng thử lại sau ít phút."
      : "Lỗi kết nối AI. Vui lòng thử lại.";
    if (!res.headersSent) {
      res.status(500).json({ error: userMsg });
    } else {
      res.write(`data: ${JSON.stringify({ error: userMsg })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  }
});

export default router;
