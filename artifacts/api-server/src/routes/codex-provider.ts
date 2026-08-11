import { Router, type Request, type Response, type NextFunction } from "express";
const router = Router();
const enabled = () => process.env.AI_CODEX_X20_SETTINGS_ENABLED === "true";
const metadata = { providerId: "wiseai_provider", providerName: "AMAZINGSTUDIO", baseUrl: "https://llm.14k7-homelab.io.vn/v1", model: "gpt-5.6-sol", reasoningEffort: "xhigh" };
const status = () => ({ enabled: enabled(), configured: false, connected: false, active: false, ...metadata });
function requireAdmin(req: Request, res: Response, next: NextFunction) { const user = (req as Request & { user?: { role?: string; isAdmin?: boolean } }).user; if (!user || (user.role !== "admin" && user.isAdmin !== true)) return res.status(403).json({ error: "ADMIN_REQUIRED" }); next(); }
router.use(requireAdmin);
router.get("/status", (_req, res) => res.set("Cache-Control", "no-store").json(status()));
router.post("/test", (_req, res) => res.status(enabled() ? 501 : 403).set("Cache-Control", "no-store").json({ ok: false, status: "PROTOTYPE_ONLY", ...status() }));
router.put("/config", (_req, res) => res.status(403).set("Cache-Control", "no-store").json({ error: "SECRET_INJECTION_REQUIRED", ...status() }));
router.post("/activate", (_req, res) => res.status(403).set("Cache-Control", "no-store").json({ error: "ACTIVATION_DISABLED_IN_PREVIEW", ...status() }));
router.delete("/config", (_req, res) => res.set("Cache-Control", "no-store").json({ ok: true, ...status() }));
export default router;
