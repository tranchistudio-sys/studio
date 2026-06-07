import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/check-ai-key", (_req, res) => {
  const base = (process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "").trim();
  const key = (process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] ?? "").trim();
  const llmReady = !!base && !!key && key !== "placeholder";
  res.json({
    configured: true,
    mode: llmReady ? "llm" : "copilot",
    llmReady,
  });
});

export default router;
