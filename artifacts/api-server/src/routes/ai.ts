import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "./auth";
import OpenAI from "openai";
import {
  answerStudioCopilot,
  buildAnalysisContext,
  COPILOT_SYSTEM_PROMPT,
  isLlmConfigured,
} from "../lib/studio-copilot";

const router: IRouter = Router();

const openai = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? "placeholder",
});

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

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const stream = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 4096,
      messages: [
        { role: "system", content: systemInstruction },
        ...messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ],
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
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
