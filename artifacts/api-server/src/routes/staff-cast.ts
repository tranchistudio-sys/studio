import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, pool } from "@workspace/db";
import { staffCastRatesTable } from "@workspace/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { verifyToken } from "./auth";
import { resolveStaffCastAmount } from "../lib/resolve-staff-cast";

const router: IRouter = Router();

// Chỉ admin được sửa/xóa cast. Nhân viên thường vẫn xem được (GET).
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const r = await pool.query(`SELECT role FROM staff WHERE id = $1`, [callerId]);
  const role = (r.rows[0] as { role?: string })?.role;
  if (role !== "admin") {
    return res.status(403).json({ error: "Chỉ admin được chỉnh sửa cast" });
  }
  next();
}

const fmt = (r: typeof staffCastRatesTable.$inferSelect) => ({
  id: r.id,
  staffId: r.staffId,
  role: r.role,
  packageId: r.packageId,
  slotKey: r.slotKey ?? null, // null = cast cấp role (dữ liệu cũ / gói không slot)
  amount: r.amount !== null ? parseFloat(r.amount as string) : null,
  rateType: r.rateType ?? "fixed",
});

// slotKey từ client: chuỗi rỗng/undefined → null (cast cấp role).
const normSlotKey = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
};

// Sale role bắt buộc rate_type='percent' (hoa hồng %), các role khác mặc định 'fixed' (VND).
function normalizeRateType(role: string, rateType?: string): "fixed" | "percent" {
  if (role === "sale") return "percent";
  return rateType === "percent" ? "percent" : "fixed";
}


// GET /staff-cast/resolve?staffId=&role=&packageId=&taskKey=
router.get("/staff-cast/resolve", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const staffId = req.query.staffId ? parseInt(req.query.staffId as string) : NaN;
  const role = (req.query.role as string) || "";
  if (!staffId || !role) {
    return res.status(400).json({ error: "Thiếu staffId hoặc role" });
  }

  const packageIdRaw = req.query.packageId as string | undefined;
  const packageId = packageIdRaw ? parseInt(packageIdRaw) : null;
  const taskKey = (req.query.taskKey as string) || "mac_dinh";
  const staffName = (req.query.staffName as string) || undefined;
  const slotKey = normSlotKey(req.query.slotKey);

  const resolved = await resolveStaffCastAmount({
    staffId,
    role,
    packageId: packageId && !Number.isNaN(packageId) ? packageId : null,
    taskKey,
    staffName,
    slotKey,
  });

  console.info("[cast-resolve]", {
    staffId: resolved.staffId,
    staffName: resolved.staffName,
    role: resolved.role,
    packageId: resolved.packageId,
    taskKey: resolved.taskKey,
    slotKey: resolved.slotKey,
    resolvedCastAmount: resolved.amount,
    source: resolved.source,
  });

  res.json(resolved);
});


// GET /staff-cast?staffId=X&role=Y
router.get("/staff-cast", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const cr = await pool.query(`SELECT role FROM staff WHERE id=$1`, [callerId]);
  const isAdmin = (cr.rows[0] as { role?: string })?.role === "admin";

  let staffId = req.query.staffId ? parseInt(req.query.staffId as string) : undefined;
  if (!isAdmin) {
    if (staffId && staffId !== callerId) {
      return res.status(403).json({ error: "Không có quyền xem cast của nhân viên khác" });
    }
    staffId = callerId;
  }
  const role = req.query.role as string | undefined;

  let rows = await db.select().from(staffCastRatesTable);
  if (staffId) rows = rows.filter(r => r.staffId === staffId);
  if (role) rows = rows.filter(r => r.role === role);

  res.json(rows.map(fmt));
});

// POST /staff-cast/upsert — upsert single cast rate (admin only)
// Key upsert: (staffId, role, packageId, slotKey) — slotKey null = cast cấp role như cũ.
router.post("/staff-cast/upsert", requireAdmin, async (req, res) => {
  const { staffId, role, packageId, amount, rateType } = req.body;
  if (!staffId || !role || !packageId) {
    return res.status(400).json({ error: "Thiếu staffId, role hoặc packageId" });
  }
  const slotKey = normSlotKey(req.body.slotKey);

  const existing = await db
    .select()
    .from(staffCastRatesTable)
    .where(and(
      eq(staffCastRatesTable.staffId, staffId),
      eq(staffCastRatesTable.role, role),
      eq(staffCastRatesTable.packageId, packageId),
      slotKey ? eq(staffCastRatesTable.slotKey, slotKey) : isNull(staffCastRatesTable.slotKey),
    ));

  const amountVal = amount !== null && amount !== undefined && amount !== "" ? String(amount) : null;
  const rt = normalizeRateType(role, rateType);

  if (existing.length > 0) {
    const [u] = await db
      .update(staffCastRatesTable)
      .set({ amount: amountVal, rateType: rt })
      .where(eq(staffCastRatesTable.id, existing[0].id))
      .returning();
    return res.json(fmt(u));
  } else {
    const [c] = await db
      .insert(staffCastRatesTable)
      .values({ staffId, role, packageId, slotKey, amount: amountVal, rateType: rt })
      .returning();
    return res.status(201).json(fmt(c));
  }
});

// POST /staff-cast/bulk — upsert multiple cast rates for a staff member (admin only)
router.post("/staff-cast/bulk", requireAdmin, async (req, res) => {
  const { staffId, role, rates, rateType: bodyRateType } = req.body as {
    staffId: number;
    role: string;
    rates: Array<{ packageId: number; amount: number | null; rateType?: string; slotKey?: string | null }>;
    rateType?: string;
  };

  if (!staffId || !role || !Array.isArray(rates)) {
    return res.status(400).json({ error: "Thiếu staffId, role hoặc rates" });
  }

  const results = [];
  for (const r of rates) {
    const { packageId, amount, rateType } = r;
    const slotKey = normSlotKey(r.slotKey);
    const existing = await db
      .select()
      .from(staffCastRatesTable)
      .where(and(
        eq(staffCastRatesTable.staffId, staffId),
        eq(staffCastRatesTable.role, role),
        eq(staffCastRatesTable.packageId, packageId),
        slotKey ? eq(staffCastRatesTable.slotKey, slotKey) : isNull(staffCastRatesTable.slotKey),
      ));

    const amountVal = amount !== null && amount !== undefined && String(amount) !== "" ? String(amount) : null;
    const rt = normalizeRateType(role, rateType ?? bodyRateType);

    if (existing.length > 0) {
      const [u] = await db
        .update(staffCastRatesTable)
        .set({ amount: amountVal, rateType: rt })
        .where(eq(staffCastRatesTable.id, existing[0].id))
        .returning();
      results.push(fmt(u));
    } else {
      const [c] = await db
        .insert(staffCastRatesTable)
        .values({ staffId, role, packageId, slotKey, amount: amountVal, rateType: rt })
        .returning();
      results.push(fmt(c));
    }
  }

  res.json(results);
});

// DELETE /staff-cast/:id (admin only)
router.delete("/staff-cast/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  await db.delete(staffCastRatesTable).where(eq(staffCastRatesTable.id, id));
  res.json({ ok: true });
});

// DELETE /staff-cast/staff/:staffId — xóa toàn bộ cast của một nhân viên (admin only)
router.delete("/staff-cast/staff/:staffId", requireAdmin, async (req, res) => {
  const staffId = parseInt(req.params.staffId);
  await db.delete(staffCastRatesTable).where(eq(staffCastRatesTable.staffId, staffId));
  res.json({ ok: true });
});

export default router;
