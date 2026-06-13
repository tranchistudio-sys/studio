import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db/schema";
import { verifyToken } from "./auth";
import { pool } from "@workspace/db";

const router: IRouter = Router();

const DEFAULT_SETTINGS = {
  studioName: "Amazing Studio",
  phone: "0901234567",
  email: "contact@amazingstudio.vn",
  address: "123 Đường Lê Lợi, Q1, TP.HCM",
  taxCode: null,
  bankAccount: null,
  bankName: null,
  logoUrl: null,
  workingHours: "08:00 - 18:00",
  defaultDeposit: 30,
  studio_lat: 11.3101,
  studio_lng: 106.1074,
  attendance_radius_m: 300,
  studio_wifi_name: "",
  studio_wifi_ips: "",
};

async function loadSettings() {
  const rows = await db.select().from(settingsTable);
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;

  return {
    studioName: map["studioName"] ?? DEFAULT_SETTINGS.studioName,
    phone: map["phone"] ?? DEFAULT_SETTINGS.phone,
    email: map["email"] ?? DEFAULT_SETTINGS.email,
    address: map["address"] ?? DEFAULT_SETTINGS.address,
    taxCode: map["taxCode"] ?? DEFAULT_SETTINGS.taxCode,
    bankAccount: map["bankAccount"] ?? DEFAULT_SETTINGS.bankAccount,
    bankName: map["bankName"] ?? DEFAULT_SETTINGS.bankName,
    logoUrl: map["logoUrl"] ?? DEFAULT_SETTINGS.logoUrl,
    workingHours: map["workingHours"] ?? DEFAULT_SETTINGS.workingHours,
    defaultDeposit: parseFloat(map["defaultDeposit"] ?? String(DEFAULT_SETTINGS.defaultDeposit)),
    studio_lat: parseFloat(map["studio_lat"] ?? String(DEFAULT_SETTINGS.studio_lat)),
    studio_lng: parseFloat(map["studio_lng"] ?? String(DEFAULT_SETTINGS.studio_lng)),
    attendance_radius_m: parseFloat(map["attendance_radius_m"] ?? String(DEFAULT_SETTINGS.attendance_radius_m)),
    studio_wifi_name: map["studio_wifi_name"] ?? DEFAULT_SETTINGS.studio_wifi_name,
    studio_wifi_ips: map["studio_wifi_ips"] ?? DEFAULT_SETTINGS.studio_wifi_ips,
    aiPricingInfo: map["aiPricingInfo"] ?? null,
  };
}

async function isAdminCaller(authorization: string | undefined): Promise<boolean> {
  const callerId = verifyToken(authorization);
  if (!callerId) return false;
  const r = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = r.rows[0] as Record<string, unknown> | undefined;
  return !!(caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin"))));
}

router.get("/settings", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  res.json(await loadSettings());
});

router.put("/settings", async (req, res) => {
  if (!await isAdminCaller(req.headers.authorization)) {
    return res.status(403).json({ error: "Không có quyền" });
  }
  const settings = req.body as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings)) {
    if (value === null || value === undefined) continue;
    await db
      .insert(settingsTable)
      .values({ key, value: String(value) })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: String(value) } });
  }
  res.json(await loadSettings());
});

// GET /public/pricing — trả bảng giá công khai, không cần đăng nhập
router.get("/public/pricing", async (_req, res) => {
  try {
    const rows = await db.select().from(settingsTable);
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    const studioName = map["studioName"] ?? "Amazing Studio";
    const aiPricingInfo = map["aiPricingInfo"] ?? null;
    const services = await pool.query(`
      SELECT name, code, price, description
      FROM services
      WHERE is_active = 1
      ORDER BY id ASC
    `);
    res.json({ studioName, aiPricingInfo, services: services.rows });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
