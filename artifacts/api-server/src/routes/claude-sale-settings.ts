import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "./auth";
import {
  getClaudeSaleSettings,
  saveClaudeSaleSettings,
  defaultClaudeSaleSettings,
  normalizeClaudeSaleSettings,
  buildSettingsPromptBlock,
  buildCalendarRulesBlock,
  type ClaudeSaleSettings,
} from "../lib/sale-settings";
import { getMasterEnabled, setMasterEnabled } from "../lib/sale-master";
import { getMonitorStats, getMonitorLeads, clearNeedsHuman } from "../lib/sale-lead-flags";
import { scanReengageCandidates } from "../lib/sale-reengage";
import { getSaleContext } from "../lib/sale-context";
import { getScheduleContext } from "../lib/sale-calendar";
import { getActivePlaybook } from "../lib/sale-playbook";

/**
 * Module "Cài đặt Claude Sale" + Monitor + Follow-up khách cũ.
 * Tất cả endpoint CHỈ admin. KHÔNG đụng booking/tài chính/CRM-logic/khách hàng.
 */

const router: IRouter = Router();

async function requireAdmin(req: Request, res: Response): Promise<number | null> {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) {
    res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
    return null;
  }
  const r = await pool.query(`SELECT role, roles FROM staff WHERE id = $1 AND is_active = 1`, [callerId]);
  const u = r.rows[0] as { role?: string; roles?: unknown } | undefined;
  const isAdmin = u && (u.role === "admin" || (Array.isArray(u.roles) && u.roles.includes("admin")));
  if (!isAdmin) {
    res.status(403).json({ error: "Chỉ admin được dùng Cài đặt Claude Sale" });
    return null;
  }
  return callerId;
}

// ─── Cấu hình ─────────────────────────────────────────────────────────────────

router.get("/claude-sale/settings", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const settings = await getClaudeSaleSettings();
  const masterEnabled = await getMasterEnabled();
  res.json({ settings, defaults: defaultClaudeSaleSettings(), masterEnabled });
});

router.put("/claude-sale/settings", async (req, res) => {
  const callerId = await requireAdmin(req, res);
  if (!callerId) return;
  try {
    const incoming = (req.body?.settings ?? req.body) as Partial<ClaudeSaleSettings>;
    const merged = normalizeClaudeSaleSettings({ ...(await getClaudeSaleSettings()), ...incoming });
    const saved = await saveClaudeSaleSettings(merged, callerId);
    res.json({ settings: saved });
  } catch (err) {
    res.status(500).json({ error: `Lưu cấu hình lỗi: ${String(err).slice(0, 200)}` });
  }
});

router.post("/claude-sale/settings/reset", async (req, res) => {
  const callerId = await requireAdmin(req, res);
  if (!callerId) return;
  const saved = await saveClaudeSaleSettings(defaultClaudeSaleSettings(), callerId);
  res.json({ settings: saved });
});

// "Xem prompt đang dùng" — dựng đúng system prompt (rút gọn context để dễ đọc).
router.get("/claude-sale/settings/prompt-preview", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const settings = await getClaudeSaleSettings();
  const [persona, calendar, playbook] = [
    buildSettingsPromptBlock(settings),
    buildCalendarRulesBlock(settings),
    await getActivePlaybook(),
  ];
  let scheduleContext = "";
  if (settings.calendarEnabled) {
    try { scheduleContext = await getScheduleContext(settings.calWindowDays); } catch { /* bỏ qua */ }
  }
  let pricingContext = "";
  try { pricingContext = await getSaleContext(); } catch { /* bỏ qua */ }
  res.json({ persona, calendar, scheduleContext, pricingContext, playbook: playbook ?? null });
});

// ─── Cầu dao tổng ─────────────────────────────────────────────────────────────

router.get("/claude-sale/master", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  res.json({ enabled: await getMasterEnabled() });
});

router.put("/claude-sale/master", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const enabled = !!(req.body as { enabled?: boolean }).enabled;
  await setMasterEnabled(enabled);
  res.json({ enabled });
});

// ─── Monitor ──────────────────────────────────────────────────────────────────

router.get("/claude-sale/monitor", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const [stats, leads, masterEnabled] = await Promise.all([
      getMonitorStats(),
      getMonitorLeads(200),
      getMasterEnabled(),
    ]);
    res.json({ stats, leads, masterEnabled });
  } catch (err) {
    res.status(500).json({ error: `Monitor lỗi: ${String(err).slice(0, 200)}` });
  }
});

// Gỡ cờ "cần nhân viên" sau khi đã xử lý.
router.patch("/claude-sale/leads/:psid/clear-escalation", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const psid = req.params.psid;
  try {
    await clearNeedsHuman(psid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err).slice(0, 200) });
  }
});

// ─── Follow-up khách cũ ("Khách cần chăm lại") ────────────────────────────────

router.get("/claude-sale/reengage", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const minSilenceDays = Number(req.query.minSilenceDays);
  const includeSkip = req.query.includeSkip === "1" || req.query.includeSkip === "true";
  try {
    const candidates = await scanReengageCandidates({
      minSilenceDays: Number.isFinite(minSilenceDays) ? minSilenceDays : 2,
      includeSkip,
      limit: 200,
    });
    res.json({ candidates, count: candidates.length });
  } catch (err) {
    res.status(500).json({ error: `Quét khách cần chăm lại lỗi: ${String(err).slice(0, 200)}` });
  }
});

export default router;
