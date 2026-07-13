import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { verifyToken, getCallerRole } from "./auth";
import { resolveLifecycleTransition, type LifecycleAction } from "../lib/dress-lifecycle";

const router: IRouter = Router();

function dateStr(d: unknown): string | null {
  if (!d) return null;
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function requireAuth(req: any) {
  const h = req.headers.authorization as string | undefined;
  const id = verifyToken(h);
  if (!id) return { ok: false as const, status: 401, message: "Unauthorized" };
  const role = await getCallerRole(h);
  if (!role) return { ok: false as const, status: 403, message: "Forbidden" };
  return { ok: true as const, id, role };
}

// ─── GET schedule for a dress ───────────────────────────────────────────────────
router.get("/dresses/:id/schedule", async (req, res) => {
  try {
    const dressId = +req.params.id;
    const mode = (req.query.mode as string) || "public";
    const fromDate = (req.query.from as string) || todayStr();
    const isAdmin = mode === "admin";
    if (isAdmin) {
      const auth = await requireAuth(req);
      if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    }
    const rows = await pool.query(
      `SELECT bd.id, bd.pickup_date, bd.return_date, bd.status, bd.note,
              b.order_code, c.name as customer_name, c.phone as customer_phone
       FROM booking_dresses bd
       LEFT JOIN bookings b ON b.id = bd.booking_id
       LEFT JOIN customers c ON c.id = b.customer_id
       WHERE bd.dress_id = $1
         AND bd.status != 'cancelled'
         AND b.deleted_at IS NULL
         AND bd.return_date >= $2
       ORDER BY bd.pickup_date`,
      [dressId, fromDate]
    );
    const result = rows.rows.map((r: Record<string, unknown>) => {
      const base = { id: r.id, pickupDate: r.pickup_date, returnDate: r.return_date, status: r.status, note: r.note };
      if (isAdmin) return { ...base, bookingCode: r.order_code, customerName: r.customer_name, customerPhone: r.customer_phone };
      return base;
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── GET nhắc thuê đồ cho Lịch (gói/nhóm gạt "Thuê đồ" = warn_upcoming_show) ──
// Reminder theo TỪNG ĐƠN GỐC (family = đơn gốc + đơn con + ngày thực hiện phụ):
// - "rental": lấy đồ [ngàyĐẦU−N .. ngàyĐẦU−1] + trả đồ ngàyCUỐI+M (N/M chỉnh per booking,
//   mặc định 3/2). KHÔNG cần gắn váy; mã váy gắn thêm chỉ là thông tin hiển thị.
//   Tất cả váy gắn đã trả xong → tắt nhắc trả.
// - "overdue": váy THẬT đang ở tay khách quá hạn trả (đòi váy persistent) — theo trạng thái
//   lifecycle từng váy, độc lập với reminder lịch.
// Thuần đọc, không đụng tiền/đơn/công nợ/lương. FE tự đặt chip theo ngày.
let hasOccurrencesTable: boolean | null = null;
router.get("/dress-warnings", async (req, res) => {
  try {
    const auth = await requireAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const from = dateStr(req.query.from) || todayStr();
    const to = dateStr(req.query.to) || from;
    // Guard: bảng booking_occurrences có thể chưa tồn tại (PR ngày phụ chưa deploy).
    if (hasOccurrencesTable !== true) {
      const chk = await pool.query(`SELECT to_regclass('public.booking_occurrences') IS NOT NULL AS ok`);
      hasOccurrencesTable = chk.rows[0]?.ok === true;
    }
    const occUnion = hasOccurrencesTable
      ? `UNION ALL SELECT o.shoot_date FROM booking_occurrences o WHERE o.booking_id = f.id`
      : ``;
    const rentalRows = await pool.query(
      `WITH fam AS (
         SELECT COALESCE(b.parent_id, b.id) AS root_id, b.id, b.shoot_date,
                b.service_package_id, b.items, b.is_parent_contract
         FROM bookings b
         WHERE b.deleted_at IS NULL AND b.status != 'temp_quote'
       ),
       flagged AS (
         SELECT f.root_id, MIN(f.id) FILTER (WHERE NOT f.is_parent_contract) AS anchor_id
         FROM fam f
         WHERE EXISTS (
           SELECT 1 FROM service_packages sp
           WHERE sp.warn_upcoming_show = true
             AND (
               sp.id = f.service_package_id
               OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements(f.items) it
                 WHERE it->>'serviceKey' = 'pkg-' || sp.id::text
               )
             )
         )
         GROUP BY f.root_id
       ),
       dates AS (
         SELECT f.root_id, MIN(d.dt) AS first_date, MAX(d.dt) AS last_date
         FROM fam f
         JOIN LATERAL (
           SELECT f.shoot_date AS dt
           ${occUnion}
         ) d ON true
         GROUP BY f.root_id
       )
       SELECT r.id AS root_id,
              COALESCE(fl.anchor_id, r.id) AS anchor_id,
              r.order_code, c.name AS customer_name,
              d.first_date::text AS first_date, d.last_date::text AS last_date,
              LEAST(GREATEST(COALESCE(r.dress_warn_pickup_days, 3), 0), 30) AS pickup_days,
              LEAST(GREATEST(COALESCE(r.dress_warn_return_days, 2), 0), 30) AS return_days,
              (SELECT COALESCE(json_agg(DISTINCT bd.outfit_code) FILTER (WHERE bd.outfit_code IS NOT NULL AND bd.outfit_code != ''), '[]'::json)
                 FROM booking_dresses bd JOIN fam f2 ON f2.id = bd.booking_id AND f2.root_id = r.id
                WHERE bd.status != 'cancelled') AS dress_codes,
              (SELECT COUNT(*) FROM booking_dresses bd JOIN fam f2 ON f2.id = bd.booking_id AND f2.root_id = r.id
                WHERE bd.status != 'cancelled') AS n_dresses,
              (SELECT COUNT(*) FROM booking_dresses bd JOIN fam f2 ON f2.id = bd.booking_id AND f2.root_id = r.id
                WHERE bd.status != 'cancelled'
                  AND (bd.actual_return_date IS NOT NULL OR bd.status IN ('returned','cleaning','ready'))) AS n_returned
       FROM flagged fl
       JOIN bookings r ON r.id = fl.root_id AND r.deleted_at IS NULL AND r.status != 'temp_quote'
       JOIN dates d ON d.root_id = fl.root_id
       LEFT JOIN customers c ON c.id = r.customer_id
       WHERE (
         (d.first_date - LEAST(GREATEST(COALESCE(r.dress_warn_pickup_days, 3), 0), 30) <= $2::date
          AND d.first_date - 1 >= $1::date)
         OR (d.last_date + LEAST(GREATEST(COALESCE(r.dress_warn_return_days, 2), 0), 30) BETWEEN $1::date AND $2::date)
       )
       ORDER BY d.first_date`,
      [from, to],
    );
    // Váy thật quá hạn trả (đòi váy) — vẫn lọc theo gói bật Thuê đồ.
    const overdueRows = await pool.query(
      `SELECT bd.id, bd.booking_id, bd.outfit_code, bd.return_date::text AS return_date,
              b.order_code, c.name AS customer_name
       FROM booking_dresses bd
       JOIN bookings b ON b.id = bd.booking_id
       LEFT JOIN customers c ON c.id = b.customer_id
       WHERE b.deleted_at IS NULL
         AND bd.status IN ('picked_up','waiting_return')
         AND bd.actual_return_date IS NULL
         AND bd.return_date < CURRENT_DATE
         AND EXISTS (
           SELECT 1 FROM service_packages sp
           WHERE sp.warn_upcoming_show = true
             AND (
               sp.id = b.service_package_id
               OR EXISTS (
                 SELECT 1 FROM jsonb_array_elements(b.items) it
                 WHERE it->>'serviceKey' = 'pkg-' || sp.id::text
               )
             )
         )
       ORDER BY bd.return_date`,
      [],
    );
    res.json([
      ...rentalRows.rows.map((r: Record<string, unknown>) => ({
        kind: "rental",
        bookingId: Number(r.anchor_id),
        rootId: Number(r.root_id),
        orderCode: r.order_code,
        customerName: r.customer_name,
        firstDate: r.first_date,
        lastDate: r.last_date,
        pickupDaysBefore: Number(r.pickup_days),
        returnDaysAfter: Number(r.return_days),
        dressCodes: r.dress_codes ?? [],
        hasDresses: Number(r.n_dresses) > 0,
        allReturned: Number(r.n_dresses) > 0 && Number(r.n_returned) === Number(r.n_dresses),
      })),
      ...overdueRows.rows.map((r: Record<string, unknown>) => ({
        kind: "overdue",
        id: r.id,
        bookingId: Number(r.booking_id),
        orderCode: r.order_code,
        customerName: r.customer_name,
        dressCode: r.outfit_code || null,
        returnDate: r.return_date,
      })),
    ]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── GET conflict check ─────────────────────────────────────────────────────
router.get("/dresses/:id/conflict", async (req, res) => {
  try {
    const dressId = +req.params.id;
    const pickup = dateStr(req.query.pickup);
    const ret = dateStr(req.query.return);
    const excludeId = req.query.excludeId ? +req.query.excludeId : null;
    if (!pickup || !ret) return res.status(400).json({ error: "pickup và return required" });
    let sql = `
      SELECT bd.id, bd.pickup_date, bd.return_date, b.order_code, c.name as customer_name
      FROM booking_dresses bd
      LEFT JOIN bookings b ON b.id = bd.booking_id
      LEFT JOIN customers c ON c.id = b.customer_id
      WHERE bd.dress_id = $1
        -- CHỈ váy đang chiếm dụng mới gây trùng: bỏ cancelled + returned/ready
        -- (đã trả/sẵn sàng = váy về kho, không chặn). cleaning VẪN chiếm.
        AND bd.status NOT IN ('cancelled', 'returned', 'ready')
        AND b.deleted_at IS NULL
        AND bd.return_date >= $2
        AND bd.pickup_date <= $3
    `;
    const params: unknown[] = [dressId, pickup, ret];
    if (excludeId) { sql += ` AND bd.id != $${params.length + 1}`; params.push(excludeId); }
    sql += ` ORDER BY bd.pickup_date`;
    const rows = await pool.query(sql, params);
    res.json({ conflicts: rows.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── GET stats for a dress ───────────────────────────────────────────────────
router.get("/dresses/:id/stats", async (req, res) => {
  try {
    const dressId = +req.params.id;
    const auth = await requireAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const today = todayStr();
    const thirtyDaysAgo = (() => {
      const d = new Date(); d.setDate(d.getDate() - 30);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();
    const totalQ = await pool.query(`SELECT COUNT(*) FROM booking_dresses WHERE dress_id = $1 AND status = 'returned'`, [dressId]);
    const total = parseInt(totalQ.rows[0].count, 10);
    const last30Q = await pool.query(`SELECT COUNT(*) FROM booking_dresses WHERE dress_id = $1 AND status = 'returned' AND return_date >= $2`, [dressId, thirtyDaysAgo]);
    const last30 = parseInt(last30Q.rows[0].count, 10);
    const upcomingQ = await pool.query(
      `SELECT bd.id, bd.pickup_date, bd.return_date, bd.status, b.order_code, c.name as customer_name
       FROM booking_dresses bd LEFT JOIN bookings b ON b.id = bd.booking_id LEFT JOIN customers c ON c.id = b.customer_id
       WHERE bd.dress_id = $1 AND bd.status != 'cancelled' AND bd.return_date >= $2 ORDER BY bd.pickup_date`,
      [dressId, today]
    );
    const historyQ = await pool.query(
      `SELECT bd.id, bd.pickup_date, bd.return_date, bd.status, b.order_code, c.name as customer_name
       FROM booking_dresses bd LEFT JOIN bookings b ON b.id = bd.booking_id LEFT JOIN customers c ON c.id = b.customer_id
       WHERE bd.dress_id = $1 AND bd.status = 'returned' ORDER BY bd.return_date DESC LIMIT 50`,
      [dressId]
    );
    res.json({ totalUses: total, last30Days: last30, upcoming: upcomingQ.rows, history: historyQ.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── POST link outfit to booking ─────────────────────────────────────────────
router.post("/booking-dresses", async (req, res) => {
  try {
    const auth = await requireAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const { bookingId, dressId, outfitCode, outfitName, outfitImage, category, size, rentalPrice, pickupDate, returnDate, status, note } = req.body;
    const result = await pool.query(
      `INSERT INTO booking_dresses (booking_id, dress_id, outfit_code, outfit_name, outfit_image, category, size, rental_price, pickup_date, return_date, status, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [+bookingId, +dressId, outfitCode, outfitName, outfitImage || null, category || null, size || null, String(rentalPrice || 0), pickupDate, returnDate, status || "reserved", note || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── PUT update booking-dress row ───────────────────────────────────────────────────
router.put("/booking-dresses/:id", async (req, res) => {
  try {
    const auth = await requireAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const id = +req.params.id;
    const body = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (body.pickupDate !== undefined) add("pickup_date", body.pickupDate);
    if (body.returnDate !== undefined) add("return_date", body.returnDate);
    if (body.status !== undefined) add("status", body.status);
    if (body.note !== undefined) add("note", body.note);
    if (body.rentalPrice !== undefined) add("rental_price", String(body.rentalPrice));
    if (body.actualPickupDate !== undefined) add("actual_pickup_date", body.actualPickupDate || null);
    if (body.actualReturnDate !== undefined) add("actual_return_date", body.actualReturnDate || null);
    if (body.preparationNote !== undefined) add("preparation_note", body.preparationNote || null);
    if (body.returnNote !== undefined) add("return_note", body.returnNote || null);
    if (body.damageNote !== undefined) add("damage_note", body.damageNote || null);
    if (!sets.length) return res.json({ ok: true });
    const beforeQ = await pool.query(`SELECT dress_id, status FROM booking_dresses WHERE id = $1`, [id]);
    const beforeRow = beforeQ.rows[0];
    if (!beforeRow) return res.status(404).json({ error: "Not found" });
    params.push(id);
    const result = await pool.query(`UPDATE booking_dresses SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
    const after = result.rows[0];
    if (after.status === "returned" && beforeRow.status !== "returned") {
      await pool.query(`UPDATE dresses SET usage_count = usage_count + 1 WHERE id = $1`, [after.dress_id]);
    }
    if (beforeRow.status === "returned" && after.status !== "returned") {
      await pool.query(`UPDATE dresses SET usage_count = GREATEST(0, usage_count - 1) WHERE id = $1`, [after.dress_id]);
    }
    res.json(after);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── PATCH lifecycle: chuyển trạng thái vòng đời + ghi ngày lấy/trả thực tế ───
// Hành động từ UI (pick_up / receive_back / start_cleaning / mark_ready / set_preparing).
// Chỉ đổi trạng thái + ngày thực tế + ghi chú — KHÔNG đụng tiền/booking/công nợ.
router.patch("/booking-dresses/:id/lifecycle", async (req, res) => {
  try {
    const auth = await requireAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const id = +req.params.id;
    const action = String(req.body?.action || "") as LifecycleAction;

    const cur = await pool.query(`SELECT status FROM booking_dresses WHERE id = $1`, [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: "Không tìm thấy váy trong đơn" });
    const currentStatus = cur.rows[0].status as string;

    const transition = resolveLifecycleTransition(action, currentStatus);
    if (!transition) {
      return res.status(400).json({ error: `Không thể thực hiện thao tác này khi váy đang ở trạng thái "${currentStatus}"` });
    }

    const sets: string[] = ["status = $1"];
    const params: unknown[] = [transition.status];
    // COALESCE: không ghi đè ngày thực tế đã có (giữ dấu vết lần đầu).
    if (transition.setActualPickup) { params.push(todayStr()); sets.push(`actual_pickup_date = COALESCE(actual_pickup_date, $${params.length})`); }
    if (transition.setActualReturn) { params.push(todayStr()); sets.push(`actual_return_date = COALESCE(actual_return_date, $${params.length})`); }
    if (typeof req.body?.preparationNote === "string") { params.push(req.body.preparationNote); sets.push(`preparation_note = $${params.length}`); }
    if (typeof req.body?.returnNote === "string") { params.push(req.body.returnNote); sets.push(`return_note = $${params.length}`); }
    if (typeof req.body?.damageNote === "string") { params.push(req.body.damageNote); sets.push(`damage_note = $${params.length}`); }
    params.push(id);

    const result = await pool.query(`UPDATE booking_dresses SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── DELETE unlink outfit from booking ─────────────────────────────────────────────
router.delete("/booking-dresses/:id", async (req, res) => {
  try {
    const auth = await requireAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const id = +req.params.id;
    const beforeQ = await pool.query(`SELECT dress_id, status FROM booking_dresses WHERE id = $1`, [id]);
    if (beforeQ.rows[0] && beforeQ.rows[0].status === "returned") {
      await pool.query(`UPDATE dresses SET usage_count = GREATEST(0, usage_count - 1) WHERE id = $1`, [beforeQ.rows[0].dress_id]);
    }
    await pool.query(`DELETE FROM booking_dresses WHERE id = $1`, [id]);
    res.status(204).send();
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── GET booking-dresses for a booking ───────────────────────────────────────
router.get("/bookings/:bookingId/dresses", async (req, res) => {
  try {
    const auth = await requireAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const bookingId = +req.params.bookingId;
    const rows = await pool.query(`SELECT * FROM booking_dresses WHERE booking_id = $1 ORDER BY pickup_date`, [bookingId]);
    res.json(rows.rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── POST backfill usage_count ───────────────────────────────────────────────
router.post("/admin/backfill-usage-count", async (req, res) => {
  try {
    const auth = await requireAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    if (auth.role !== "admin" && auth.role !== "owner") return res.status(403).json({ error: "Forbidden" });
    await pool.query(`
      UPDATE dresses d
      SET usage_count = (
        SELECT COUNT(*) FROM booking_dresses bd
        WHERE bd.dress_id = d.id AND bd.status = 'returned'
      )
    `);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

export default router;
