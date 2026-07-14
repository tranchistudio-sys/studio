import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { isLlmConfigured } from "../lib/studio-copilot";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/check-ai-key", (_req, res) => {
  // Dùng CHUNG isLlmConfigured() với backend chat: trước đây endpoint này chỉ
  // check OpenAI env → máy có ANTHROPIC_API_KEY vẫn bị báo "chưa có AI",
  // frontend hiện banner sai sự thật.
  const llmReady = isLlmConfigured();
  res.json({
    configured: true,
    mode: llmReady ? "llm" : "copilot",
    llmReady,
  });
});

export default router;
