import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import { staffSalaryRatesTable, staffSalaryOverridesTable, staffTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyToken } from "./auth";

const router: IRouter = Router();

const fmtRate = (r: { rate: string; [key: string]: unknown }) => ({ ...r, rate: parseFloat(r.rate) });

// ─── Default salary rates ─────────────────────────────────────────────────────
router.get("/salary-rates", async (_req, res) => {
  const rates = await db.select().from(staffSalaryRatesTable).orderBy(staffSalaryRatesTable.serviceKey);
  res.json(rates.map(fmtRate));
});

router.post("/salary-rates", async (req, res) => {
  const { serviceKey, serviceName, role, rate, notes } = req.body;
  if (!serviceKey || !role) return res.status(400).json({ error: "serviceKey và role là bắt buộc" });
  const [row] = await db
    .insert(staffSalaryRatesTable)
    .values({ serviceKey, serviceName: serviceName || serviceKey, role, rate: String(rate || 0), notes })
    .returning();
  res.status(201).json(fmtRate(row));
});

router.put("/salary-rates/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const { serviceKey, serviceName, role, rate, notes } = req.body;
  const update: Record<string, unknown> = {};
  if (serviceKey !== undefined) update.serviceKey = serviceKey;
  if (serviceName !== undefined) update.serviceName = serviceName;
  if (role !== undefined) update.role = role;
  if (rate !== undefined) update.rate = String(rate);
  if (notes !== undefined) update.notes = notes;
  const [row] = await db.update(staffSalaryRatesTable).set(update).where(eq(staffSalaryRatesTable.id, id)).returning();
  if (!row) return res.status(404).json({ error: "Không tìm thấy" });
  res.json(fmtRate(row));
});

router.delete("/salary-rates/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  await db.delete(staffSalaryRatesTable).where(eq(staffSalaryRatesTable.id, id));
  res.status(204).send();
});

// ─── Per-staff salary overrides ───────────────────────────────────────────────
router.get("/salary-overrides", async (req, res) => {
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
  let rows = await db
    .select({
      id: staffSalaryOverridesTable.id,
      staffId: staffSalaryOverridesTable.staffId,
      staffName: staffTable.name,
      serviceKey: staffSalaryOverridesTable.serviceKey,
      role: staffSalaryOverridesTable.role,
      rate: staffSalaryOverridesTable.rate,
      notes: staffSalaryOverridesTable.notes,
      createdAt: staffSalaryOverridesTable.createdAt,
    })
    .from(staffSalaryOverridesTable)
    .innerJoin(staffTable, eq(staffSalaryOverridesTable.staffId, staffTable.id));
  if (staffId) rows = rows.filter(r => r.staffId === staffId);
  res.json(rows.map(r => ({ ...r, rate: parseFloat(r.rate) })));
});

router.post("/salary-overrides", async (req, res) => {
  const { staffId, serviceKey, role, rate, notes } = req.body;
  if (!staffId || !serviceKey || !role) return res.status(400).json({ error: "staffId, serviceKey và role là bắt buộc" });
  const [row] = await db
    .insert(staffSalaryOverridesTable)
    .values({ staffId, serviceKey, role, rate: String(rate || 0), notes })
    .returning();
  res.status(201).json({ ...row, rate: parseFloat(row.rate) });
});

router.put("/salary-overrides/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const { rate, notes } = req.body;
  const update: Record<string, unknown> = {};
  if (rate !== undefined) update.rate = String(rate);
  if (notes !== undefined) update.notes = notes;
  const [row] = await db.update(staffSalaryOverridesTable).set(update).where(eq(staffSalaryOverridesTable.id, id)).returning();
  if (!row) return res.status(404).json({ error: "Không tìm thấy" });
  res.json({ ...row, rate: parseFloat(row.rate) });
});

router.delete("/salary-overrides/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  await db.delete(staffSalaryOverridesTable).where(eq(staffSalaryOverridesTable.id, id));
  res.status(204).send();
});

export default router;
