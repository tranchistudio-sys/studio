import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import { staffRatePricesTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyToken, getCallerRole } from "./auth";

const router: IRouter = Router();

const fmt = (r: { rate: string | null; [k: string]: unknown }) => ({
  ...r,
  rate: r.rate !== null && r.rate !== undefined ? parseFloat(r.rate as string) : null,
});

// ─── GET /staff-rates?staffId=X ───────────────────────────────────────────────
router.get("/staff-rates", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const cr = await pool.query(`SELECT role FROM staff WHERE id=$1`, [callerId]);
  const isAdmin = (cr.rows[0] as { role?: string })?.role === "admin";

  let staffId = req.query.staffId ? parseInt(req.query.staffId as string) : undefined;
  if (!isAdmin) {
    if (staffId && staffId !== callerId) {
      return res.status(403).json({ error: "Không có quyền xem mức lương của nhân viên khác" });
    }
    staffId = callerId;
  }
  let rows = await db.select().from(staffRatePricesTable).orderBy(staffRatePricesTable.role, staffRatePricesTable.taskKey);
  if (staffId) rows = rows.filter(r => r.staffId === staffId);
  res.json(rows.map(fmt));
});

// ─── POST /staff-rates — upsert (create or update) ────────────────────────────
router.post("/staff-rates", async (req, res) => {
  const { staffId, role, taskKey, taskName, rate, rateType, notes } = req.body;
  if (!staffId || !role || !taskKey || !taskName) {
    return res.status(400).json({ error: "Thiếu trường bắt buộc" });
  }

  // Check if already exists
  const existing = await db
    .select()
    .from(staffRatePricesTable)
    .where(and(
      eq(staffRatePricesTable.staffId, staffId),
      eq(staffRatePricesTable.role, role),
      eq(staffRatePricesTable.taskKey, taskKey),
    ));

  if (existing.length > 0) {
    const [updated] = await db
      .update(staffRatePricesTable)
      .set({
        taskName,
        rate: rate !== undefined && rate !== null && rate !== "" ? String(rate) : null,
        rateType: rateType || "fixed",
        notes: notes || null,
      })
      .where(eq(staffRatePricesTable.id, existing[0].id))
      .returning();
    return res.json(fmt(updated));
  }

  const [created] = await db
    .insert(staffRatePricesTable)
    .values({
      staffId,
      role,
      taskKey,
      taskName,
      rate: rate !== undefined && rate !== null && rate !== "" ? String(rate) : null,
      rateType: rateType || "fixed",
      notes: notes || null,
    })
    .returning();
  res.status(201).json(fmt(created));
});

// ─── PUT /staff-rates/:id ─────────────────────────────────────────────────────
router.put("/staff-rates/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const { rate, rateType, notes, taskName } = req.body;
  const update: Record<string, unknown> = {};
  if (rate !== undefined) update.rate = rate !== null && rate !== "" ? String(rate) : null;
  if (rateType !== undefined) update.rateType = rateType;
  if (notes !== undefined) update.notes = notes;
  if (taskName !== undefined) update.taskName = taskName;
  const [updated] = await db.update(staffRatePricesTable).set(update).where(eq(staffRatePricesTable.id, id)).returning();
  if (!updated) return res.status(404).json({ error: "Không tìm thấy" });
  res.json(fmt(updated));
});

// ─── DELETE /staff-rates/clear — xóa toàn bộ (admin only) ────────────────────
// Comment "admin only" có từ đầu nhưng CHƯA HỀ có kiểm tra: handler khai (_req)
// nên không đọc nổi header, và câu lệnh xoá KHÔNG có WHERE → ai cũng xoá sạch
// bảng đơn giá nhân sự của toàn studio. Bảng này không có soft-delete, không
// audit, mất là mất luôn; lương/hoa hồng sau đó âm thầm tính bằng 0.
router.delete("/staff-rates/clear", async (req, res) => {
  const role = await getCallerRole(req.headers.authorization);
  if (!role) { res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" }); return; }
  if (role !== "admin") { res.status(403).json({ error: "Chỉ admin mới được xoá toàn bộ bảng giá" }); return; }
  await db.delete(staffRatePricesTable);
  res.json({ ok: true, message: "Đã xóa toàn bộ bảng cast" });
});

// ─── DELETE /staff-rates/:id ──────────────────────────────────────────────────
router.delete("/staff-rates/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  await db.delete(staffRatePricesTable).where(eq(staffRatePricesTable.id, id));
  res.json({ ok: true });
});

// ─── POST /staff-rates/bulk — save all rates for a staff member in one call ───
// Body: { staffId, rates: [{ role, taskKey, taskName, rate, rateType }] }
router.post("/staff-rates/bulk", async (req, res) => {
  const { staffId, rates } = req.body as {
    staffId: number;
    rates: Array<{ role: string; taskKey: string; taskName: string; rate?: number | null; rateType?: string }>;
  };
  if (!staffId || !Array.isArray(rates)) {
    return res.status(400).json({ error: "Thiếu staffId hoặc rates" });
  }

  const results = [];
  for (const r of rates) {
    const { role, taskKey, taskName, rate, rateType } = r;
    const existing = await db
      .select()
      .from(staffRatePricesTable)
      .where(and(
        eq(staffRatePricesTable.staffId, staffId),
        eq(staffRatePricesTable.role, role),
        eq(staffRatePricesTable.taskKey, taskKey),
      ));

    const rateVal = rate !== undefined && rate !== null && rate !== "" ? String(rate) : null;
    if (existing.length > 0) {
      const [u] = await db
        .update(staffRatePricesTable)
        .set({ taskName, rate: rateVal, rateType: rateType || "fixed" })
        .where(eq(staffRatePricesTable.id, existing[0].id))
        .returning();
      results.push(fmt(u));
    } else {
      const [c] = await db
        .insert(staffRatePricesTable)
        .values({ staffId, role, taskKey, taskName, rate: rateVal, rateType: rateType || "fixed" })
        .returning();
      results.push(fmt(c));
    }
  }

  res.json(results);
});

export default router;
