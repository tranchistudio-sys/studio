import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getCallerRole } from "./auth";

// ─────────────────────────────────────────────────────────────────────────────
// Giờ vàng (Golden Hour) — quản lý campaign giảm giá đồng loạt cho NHÓM danh mục
// (cms_categories, áp dụng cả nhánh con) hoặc cho 1 SẢN PHẨM (dresses).
// KHÔNG ghi đè giá gốc — chỉ lưu cấu hình; giá sau giảm tính lúc hiển thị (cms.ts).
// ─────────────────────────────────────────────────────────────────────────────

const router: IRouter = Router();

async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const role = await getCallerRole(req.headers.authorization);
  if (role !== "admin") {
    res.status(403).json({ error: "Chỉ admin được phép" });
    return false;
  }
  return true;
}

const ALLOWED_SCOPES = new Set(["category", "dress"]);

function fmt(row: any) {
  return { ...row, percent: parseFloat(row.percent), isActive: !!row.isActive };
}

// GET /api/golden-hour — toàn bộ campaign (admin)
router.get("/golden-hour", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(
      `SELECT id, scope, ref_id AS "refId", name, percent,
              starts_at AS "startsAt", ends_at AS "endsAt", is_active AS "isActive",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM golden_hour_campaigns
        ORDER BY scope, ref_id`,
    );
    res.json(r.rows.map(fmt));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/golden-hour — tạo / cập nhật theo (scope, ref_id) [upsert]
router.post("/golden-hour", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { scope, refId, name, percent, startsAt, endsAt, isActive } = req.body ?? {};
    if (!ALLOWED_SCOPES.has(scope)) {
      return res.status(400).json({ error: "scope phải là 'category' hoặc 'dress'" });
    }
    const ref = Number(refId);
    if (!Number.isInteger(ref) || ref <= 0) {
      return res.status(400).json({ error: "refId không hợp lệ" });
    }
    const pct = Number(percent);
    if (!(pct > 0) || pct >= 100) {
      return res.status(400).json({ error: "percent phải trong khoảng 1–99" });
    }
    const nm = typeof name === "string" && name.trim() ? name.trim() : "Giờ vàng";
    const sAt = startsAt ? new Date(startsAt) : null;
    const eAt = endsAt ? new Date(endsAt) : null;
    if (sAt && isNaN(sAt.getTime())) return res.status(400).json({ error: "startsAt không hợp lệ" });
    if (eAt && isNaN(eAt.getTime())) return res.status(400).json({ error: "endsAt không hợp lệ" });
    if (sAt && eAt && eAt <= sAt) return res.status(400).json({ error: "Thời gian kết thúc phải sau bắt đầu" });
    const active = isActive === undefined ? true : !!isActive;

    const r = await pool.query(
      `INSERT INTO golden_hour_campaigns (scope, ref_id, name, percent, starts_at, ends_at, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (scope, ref_id) DO UPDATE
         SET name = EXCLUDED.name, percent = EXCLUDED.percent,
             starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
             is_active = EXCLUDED.is_active, updated_at = now()
       RETURNING id, scope, ref_id AS "refId", name, percent,
                 starts_at AS "startsAt", ends_at AS "endsAt", is_active AS "isActive"`,
      [scope, ref, nm, pct, sAt, eAt, active],
    );
    res.json(fmt(r.rows[0]));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PATCH /api/golden-hour/:id/toggle — bật/tắt nhanh
router.patch("/golden-hour/:id/toggle", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await pool.query(
      `UPDATE golden_hour_campaigns SET is_active = NOT is_active, updated_at = now()
        WHERE id = $1 RETURNING id, is_active AS "isActive"`,
      [Number(req.params.id)],
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Không tìm thấy campaign" });
    res.json({ id: (r.rows[0] as any).id, isActive: !!(r.rows[0] as any).isActive });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// DELETE /api/golden-hour/:id — xoá campaign (về giá niêm yết)
router.delete("/golden-hour/:id", async (req: Request, res: Response) => {
  if (!(await requireAdmin(req, res))) return;
  try {
    await pool.query(`DELETE FROM golden_hour_campaigns WHERE id = $1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
