import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "./auth";

const router: IRouter = Router();

// GET /api/staff-commissions?staffId=X[&month=YYYY-MM]
//
// Trả về commission của 1 sale (Kinh doanh):
// - Mỗi booking có assignedStaff->>'sale' = staffId
// - Mỗi item (gói) trong items[] tra rate% từ staff_cast_rates(staff=sale, role='sale', package_id=item.serviceId)
// - bookingForecast = SUM(item.totalPrice × rate% / 100)
// - paidRatio = paidAmount / totalAmount (0 nếu totalAmount=0)
// - bookingCollected = bookingForecast × paidRatio (commission đã phát sinh tới hiện tại)
//
// Lọc tháng: nếu có ?month=YYYY-MM thì chỉ lấy booking có ít nhất 1 payment trong tháng đó,
// và "collected" = SUM(payment.amount in month × commissionRate) — commissionRate là tỉ lệ
// bookingForecast / bookingTotal (% commission trên doanh thu) để phân bổ theo payment.
//
// Quyền: caller phải là chính staff đó hoặc admin.
router.get("/staff-commissions", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const cr = await pool.query(`SELECT role FROM staff WHERE id=$1`, [callerId]);
  const callerRole = (cr.rows[0] as { role?: string })?.role;
  const isAdmin = callerRole === "admin";

  const staffId = parseInt(String(req.query.staffId || ""), 10);
  if (!Number.isFinite(staffId) || staffId <= 0) {
    return res.status(400).json({ error: "Thiếu hoặc sai staffId" });
  }
  if (!isAdmin && staffId !== callerId) {
    return res.status(403).json({ error: "Không có quyền xem commission của nhân viên khác" });
  }

  const month = req.query.month as string | undefined;
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "Sai định dạng month (YYYY-MM)" });
  }

  // Lấy danh sách booking + items + cast rate cho staff (sale)
  // jsonb_array_elements(items) trả từng item; LEFT JOIN cast theo serviceId của item.
  const bookingsRes = await pool.query(`
    WITH sale_bookings AS (
      SELECT
        b.id,
        b.order_code              AS code,
        b.shoot_date              AS event_date,
        c.name                    AS customer_name,
        b.total_amount::numeric   AS total_amount,
        b.paid_amount::numeric    AS paid_amount,
        b.items
      FROM bookings b
      LEFT JOIN customers c ON c.id = b.customer_id
      WHERE jsonb_typeof(b.assigned_staff) = 'object'
        AND (b.assigned_staff->>'sale') ~ '^[0-9]+$'
        AND (b.assigned_staff->>'sale')::int = $1
    ),
    items_expanded AS (
      SELECT
        sb.id AS booking_id,
        (item->>'serviceId')::int                                   AS package_id,
        COALESCE(item->>'serviceName', item->>'name', 'Gói')        AS package_name,
        COALESCE(NULLIF(item->>'totalPrice','')::numeric, 0)        AS item_total,
        COALESCE(scr.amount::numeric, 0)                            AS rate_percent,
        COALESCE(NULLIF(item->>'totalPrice','')::numeric, 0)
          * COALESCE(scr.amount::numeric, 0) / 100                  AS item_forecast
      FROM sale_bookings sb,
           jsonb_array_elements(sb.items) AS item
      LEFT JOIN staff_cast_rates scr
        ON scr.staff_id = $1
       AND scr.role = 'sale'
       AND scr.rate_type = 'percent'
       AND scr.package_id = NULLIF(item->>'serviceId','')::int
      WHERE jsonb_typeof(sb.items) = 'array'
    ),
    booking_forecast AS (
      SELECT
        booking_id,
        SUM(item_forecast)::numeric AS forecast,
        json_agg(json_build_object(
          'packageId',  package_id,
          'packageName', package_name,
          'itemTotal',  item_total,
          'ratePercent', rate_percent,
          'itemForecast', item_forecast
        ) ORDER BY package_id) AS items_breakdown
      FROM items_expanded
      GROUP BY booking_id
    )
    SELECT
      sb.id,
      sb.code,
      sb.event_date,
      sb.customer_name,
      sb.total_amount,
      sb.paid_amount,
      COALESCE(bf.forecast, 0)::numeric AS forecast,
      COALESCE(bf.items_breakdown, '[]'::json) AS items_breakdown
    FROM sale_bookings sb
    LEFT JOIN booking_forecast bf ON bf.booking_id = sb.id
    ORDER BY sb.event_date DESC NULLS LAST, sb.id DESC
  `, [staffId]);

  type Row = {
    id: number;
    code: string | null;
    event_date: string | null;
    customer_name: string | null;
    total_amount: string;
    paid_amount: string;
    forecast: string;
    items_breakdown: Array<{
      packageId: number;
      packageName: string;
      itemTotal: string | number;
      ratePercent: string | number;
      itemForecast: string | number;
    }>;
  };
  const bookings = bookingsRes.rows as Row[];
  const bookingIds = bookings.map(b => b.id);

  // Lấy payments theo booking (status='active' = chưa void)
  const paymentsByBooking = new Map<number, Array<{ amount: number; paidAt: string; type: string }>>();
  if (bookingIds.length > 0) {
    const pRes = await pool.query(
      `SELECT booking_id, amount::numeric AS amount, paid_at, payment_type
         FROM payments
        WHERE booking_id = ANY($1::int[])
          AND COALESCE(status, 'active') = 'active'
        ORDER BY paid_at ASC`,
      [bookingIds]
    );
    for (const p of pRes.rows as Array<{ booking_id: number; amount: string; paid_at: Date; payment_type: string }>) {
      const arr = paymentsByBooking.get(p.booking_id) || [];
      arr.push({ amount: Number(p.amount) || 0, paidAt: new Date(p.paid_at).toISOString(), type: p.payment_type });
      paymentsByBooking.set(p.booking_id, arr);
    }
  }

  const items = bookings.map(b => {
    const totalAmount = Number(b.total_amount) || 0;
    const paidAmount  = Number(b.paid_amount) || 0;
    const forecast    = Number(b.forecast) || 0;
    // commissionRate = forecast / totalAmount (vd 0.05 = 5% trên doanh thu)
    const commissionRate = totalAmount > 0 ? forecast / totalAmount : 0;
    const payments = paymentsByBooking.get(b.id) || [];

    // Lọc theo tháng (nếu có)
    const paymentsScoped = month
      ? payments.filter(p => p.paidAt.slice(0, 7) === month)
      : payments;

    const paidInScope = paymentsScoped.reduce((s, p) => s + p.amount, 0);
    const collected = paidInScope * commissionRate;
    const collectedAllTime = paidAmount * commissionRate;

    return {
      bookingId: b.id,
      code: b.code,
      eventDate: b.event_date,
      customerName: b.customer_name,
      totalAmount,
      paidAmount,
      forecast,                       // commission khi thu đủ
      collected,                      // commission đã phát sinh trong scope (theo month hoặc all-time)
      collectedAllTime,               // commission đã phát sinh lifetime (luôn trả để admin tham chiếu)
      remaining: forecast - collectedAllTime,
      commissionRate,
      itemsBreakdown: b.items_breakdown.map(i => ({
        packageId: i.packageId,
        packageName: i.packageName,
        itemTotal: Number(i.itemTotal) || 0,
        ratePercent: Number(i.ratePercent) || 0,
        itemForecast: Number(i.itemForecast) || 0,
      })),
      payments: paymentsScoped.map(p => ({
        amount: p.amount,
        paidAt: p.paidAt,
        type: p.type,
        commission: p.amount * commissionRate,
      })),
    };
  })
  // Bỏ booking không có forecast VÀ không có payment trong scope (không liên quan)
  .filter(b => month ? (b.payments.length > 0) : (b.forecast > 0 || b.collectedAllTime > 0));

  const totals = items.reduce(
    (acc, b) => ({
      forecast: acc.forecast + b.forecast,
      collected: acc.collected + b.collected,
      collectedAllTime: acc.collectedAllTime + b.collectedAllTime,
    }),
    { forecast: 0, collected: 0, collectedAllTime: 0 }
  );

  res.json({
    staffId,
    month: month || null,
    isAdmin,
    bookings: items,
    totals: {
      forecast: totals.forecast,
      collected: totals.collected,           // trong scope
      collectedAllTime: totals.collectedAllTime,
      remaining: totals.forecast - totals.collectedAllTime,
    },
  });
});

export default router;
