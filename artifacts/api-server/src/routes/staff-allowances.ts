import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { verifyToken, getCallerRole } from "./auth";

const router: IRouter = Router();

const VALID_TYPES = new Set(["di_xa", "tang_ca", "xang_xe", "gui_xe", "an_uong", "khac"]);

async function requireAdmin(req: any): Promise<
  | { ok: true; callerId: number }
  | { ok: false; status: number; message: string }
> {
  const h = req.headers.authorization as string | undefined;
  const id = verifyToken(h);
  if (!id) return { ok: false, status: 401, message: "Unauthorized" };
  const role = await getCallerRole(h);
  if (role !== "admin") return { ok: false, status: 403, message: "Chỉ admin mới có quyền thực hiện thao tác này" };
  return { ok: true, callerId: id };
}

function fmtRow(r: Record<string, unknown>) {
  return {
    id: r.id,
    bookingId: r.booking_id,
    staffId: r.staff_id,
    staffName: r.staff_name ?? null,
    role: r.role ?? null,
    serviceBookingId: r.service_booking_id ?? null,
    allowanceType: r.allowance_type,
    amount: parseFloat(String(r.amount ?? 0)),
    note: r.note ?? null,
    createdBy: r.created_by ?? null,
    createdByName: r.created_by_name ?? null,
    createdAt: r.created_at,
  };
}

async function withNames(id: unknown) {
  const r = await pool.query(
    `SELECT sa.*, s.name AS staff_name, cb.name AS created_by_name
       FROM staff_allowances sa
       LEFT JOIN staff s  ON s.id = sa.staff_id
       LEFT JOIN staff cb ON cb.id = sa.created_by
      WHERE sa.id = $1`,
    [id]
  );
  return r.rows[0] ? fmtRow(r.rows[0]) : null;
}

// ── GET /bookings/:bookingId/staff-allowances ────────────────────────────────
router.get("/bookings/:bookingId/staff-allowances", async (req, res) => {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const bookingId = parseInt(req.params.bookingId);
    if (isNaN(bookingId)) return res.status(400).json({ error: "bookingId không hợp lệ" });
    const rows = await pool.query(
      `SELECT sa.*, s.name AS staff_name, cb.name AS created_by_name
         FROM staff_allowances sa
         LEFT JOIN staff s  ON s.id = sa.staff_id
         LEFT JOIN staff cb ON cb.id = sa.created_by
        WHERE sa.booking_id = $1
        ORDER BY sa.created_at`,
      [bookingId]
    );
    res.json(rows.rows.map(fmtRow));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── POST /staff-allowances ───────────────────────────────────────────────────
router.post("/staff-allowances", async (req, res) => {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const { bookingId, staffId, allowanceType, amount, note, role, serviceBookingId } = req.body;
    if (!bookingId || !staffId || !allowanceType)
      return res.status(400).json({ error: "Thiếu bookingId/staffId/allowanceType" });
    if (!VALID_TYPES.has(allowanceType))
      return res.status(400).json({ error: "allowanceType không hợp lệ" });
    const amountNum = parseFloat(String(amount ?? 0));
    if (isNaN(amountNum) || amountNum <= 0)
      return res.status(400).json({ error: "amount phải lớn hơn 0" });
    const row = await pool.query(
      `INSERT INTO staff_allowances
         (booking_id, staff_id, allowance_type, amount, note, created_by, role, service_booking_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        +bookingId, +staffId, allowanceType, String(amountNum),
        note || null, auth.callerId,
        role || null,
        serviceBookingId != null ? +serviceBookingId : null,
      ]
    );
    const result = await withNames(row.rows[0].id);
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── PUT /staff-allowances/:id ────────────────────────────────────────────────
router.put("/staff-allowances/:id", async (req, res) => {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });
    const check = await pool.query(`SELECT id FROM staff_allowances WHERE id = $1`, [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy phụ cấp" });
    const { allowanceType, amount, note } = req.body;
    const updates: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;
    if (allowanceType !== undefined) {
      if (!VALID_TYPES.has(allowanceType)) return res.status(400).json({ error: "allowanceType không hợp lệ" });
      updates.push(`allowance_type = $${idx++}`); vals.push(allowanceType);
    }
    if (amount !== undefined) {
      const num = parseFloat(String(amount));
      if (isNaN(num) || num <= 0) return res.status(400).json({ error: "amount phải lớn hơn 0" });
      updates.push(`amount = $${idx++}`); vals.push(String(num));
    }
    if (note !== undefined) { updates.push(`note = $${idx++}`); vals.push(note || null); }
    if (updates.length === 0) return res.status(400).json({ error: "Không có trường nào để cập nhật" });
    vals.push(id);
    await pool.query(`UPDATE staff_allowances SET ${updates.join(", ")} WHERE id = $${idx}`, vals);
    const result = await withNames(id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── DELETE /staff-allowances/:id ─────────────────────────────────────────────
// Admin-only hard delete.
router.delete("/staff-allowances/:id", async (req, res) => {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });
    const check = await pool.query(`SELECT id FROM staff_allowances WHERE id = $1`, [id]);
    if (check.rows.length === 0) return res.status(404).json({ error: "Không tìm thấy" });
    await pool.query(`DELETE FROM staff_allowances WHERE id = $1`, [id]);
    res.status(204).send();
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

export default router;
