import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import { fixedCostsTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { verifyToken } from "./auth";

const router: IRouter = Router();

const fmt = (r: { amount: string; [key: string]: unknown }) => ({ ...r, amount: parseFloat(r.amount) });

async function isAdminCaller(authorization: string | undefined): Promise<boolean> {
  const callerId = verifyToken(authorization);
  if (!callerId) return false;
  const r = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = r.rows[0] as Record<string, unknown> | undefined;
  return !!(caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin"))));
}

router.get("/fixed-costs", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const rows = await db.select().from(fixedCostsTable).orderBy(fixedCostsTable.id);
  res.json(rows.map(fmt));
});

router.post("/fixed-costs", async (req, res) => {
  if (!await isAdminCaller(req.headers.authorization)) {
    return res.status(403).json({ error: "Không có quyền" });
  }
  const { label, amount, notes, active } = req.body ?? {};
  if (!label || typeof label !== "string") return res.status(400).json({ error: "label là bắt buộc" });
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: "amount không hợp lệ" });
  const [row] = await db
    .insert(fixedCostsTable)
    .values({ label: label.trim(), amount: String(amt), notes: notes ?? null, active: active !== false })
    .returning();
  res.status(201).json(fmt(row));
});

router.put("/fixed-costs/:id", async (req, res) => {
  if (!await isAdminCaller(req.headers.authorization)) {
    return res.status(403).json({ error: "Không có quyền" });
  }
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id không hợp lệ" });
  const { label, amount, notes, active } = req.body ?? {};
  const update: Record<string, unknown> = { updatedAt: sql`now()` };
  if (label !== undefined) {
    if (typeof label !== "string" || !label.trim()) return res.status(400).json({ error: "label không hợp lệ" });
    update.label = label.trim();
  }
  if (amount !== undefined) {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: "amount không hợp lệ" });
    update.amount = String(amt);
  }
  if (notes !== undefined) update.notes = notes;
  if (active !== undefined) update.active = !!active;
  const [row] = await db.update(fixedCostsTable).set(update).where(eq(fixedCostsTable.id, id)).returning();
  if (!row) return res.status(404).json({ error: "Không tìm thấy" });
  res.json(fmt(row));
});

router.delete("/fixed-costs/:id", async (req, res) => {
  if (!await isAdminCaller(req.headers.authorization)) {
    return res.status(403).json({ error: "Không có quyền" });
  }
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "id không hợp lệ" });
  await db.delete(fixedCostsTable).where(eq(fixedCostsTable.id, id));
  res.status(204).send();
});

export default router;
