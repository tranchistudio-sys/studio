import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import { paymentsTable, bookingsTable, customersTable, staffTable } from "@workspace/db/schema";
import { eq, desc, and, ne, sql } from "drizzle-orm";
import { emitNotification } from "./notifications";
import { verifyToken, getCallerRole } from "./auth";

const router: IRouter = Router();

// GET /payments — danh sách phiếu thu (lọc theo bookingId hoặc rentalId)
router.get("/payments", async (req, res) => {
  try {
  const bookingId = req.query.bookingId ? parseInt(req.query.bookingId as string) : undefined;
  const rentalId  = req.query.rentalId  ? parseInt(req.query.rentalId  as string) : undefined;

  let query = db.select().from(paymentsTable).$dynamic();
  if (bookingId) query = query.where(eq(paymentsTable.bookingId, bookingId));
  else if (rentalId) query = query.where(eq(paymentsTable.rentalId, rentalId));

  const payments = await query.orderBy(desc(paymentsTable.paidAt));
  res.json(payments.map(p => ({ ...p, amount: parseFloat(p.amount) })));
  } catch (err) {
    console.error("GET /payments error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

function fmtBookingRow(row: any) {
  const totalAmount    = parseFloat(row.totalAmount    || 0);
  const discountAmount = parseFloat(row.discountAmount || 0);
  const paidAmount     = parseFloat(row.paidAmount     || 0);
  const remainingAmount = parseFloat(row.remainingAmount || 0);
  return {
    id:              Number(row.id),
    orderCode:       row.orderCode ?? null,
    customerId:      Number(row.customerId),
    customerName:    row.customerName ?? "",
    customerPhone:   row.customerPhone ?? "",
    customerCode:    row.customerCode ?? null,
    packageType:     row.packageType ?? "",
    totalAmount,
    discountAmount,
    paidAmount,
    remainingAmount,
    status:          row.status ?? "",
    shootDate:       row.shootDate ?? null,
    createdAt:       row.createdAt ?? null,
    notes:           row.notes ?? null,
    latestPaymentAt: row.latestPaymentAt ?? null,
    isParentContract: Boolean(row.isParentContract),
    serviceCount:    Number(row.serviceCount ?? 0),
  };
}

// Base SQL for booking rows — chỉ lấy hồ sơ tài chính thực sự:
// - Booking đơn lẻ (parent_id IS NULL AND is_parent_contract = false)
// - Booking cha đa dịch vụ (is_parent_contract = true)
// → KHÔNG lấy booking con (parent_id IS NOT NULL) vì chúng chỉ là lịch chụp
const BOOKING_JOIN_SQL = `
  SELECT
    b.id,
    b.order_code                  AS "orderCode",
    b.customer_id                 AS "customerId",
    c.name                        AS "customerName",
    c.phone                       AS "customerPhone",
    c.custom_code                 AS "customerCode",
    b.package_type                AS "packageType",
    b.total_amount::numeric       AS "totalAmount",
    b.discount_amount::numeric    AS "discountAmount",
    b.paid_amount::numeric        AS "paidAmount",
    GREATEST(0, (b.total_amount - COALESCE(b.discount_amount, 0) - b.paid_amount)::numeric) AS "remainingAmount",
    b.status,
    b.shoot_date                  AS "shootDate",
    b.created_at                  AS "createdAt",
    b.notes,
    b.is_parent_contract          AS "isParentContract",
    (SELECT COUNT(*) FROM bookings ch WHERE ch.parent_id = b.id) AS "serviceCount"
  FROM bookings b
  LEFT JOIN customers c ON b.customer_id = c.id
  WHERE b.parent_id IS NULL
    AND b.deleted_at IS NULL
`;

// GET /payments/suggestions — gợi ý thông minh khi mở ô tìm kiếm (chưa nhập)
router.get("/payments/suggestions", async (req, res) => {
  try {
  const [bookingsResult, paymentsResult] = await Promise.all([
    pool.query(`${BOOKING_JOIN_SQL}
      AND b.status NOT IN ('cancelled','temp_quote')
      ORDER BY b.created_at DESC
      LIMIT 200`),
    pool.query(`
      SELECT booking_id, MAX(paid_at) AS latest_paid_at
      FROM payments
      WHERE booking_id IS NOT NULL
        AND COALESCE(status, 'active') != 'voided'
      GROUP BY booking_id`),
  ]);

  const latestMap = new Map<number, string>();
  for (const row of paymentsResult.rows) {
    if (row.booking_id) latestMap.set(Number(row.booking_id), String(row.latest_paid_at));
  }

  const items = bookingsResult.rows.map((b: any) => ({
    ...fmtBookingRow(b),
    latestPaymentAt: latestMap.get(Number(b.id)) ?? null,
  }));

  const sorted = items.sort((a: any, b: any) => {
    const aOwed = a.remainingAmount > 0 ? 1 : 0;
    const bOwed = b.remainingAmount > 0 ? 1 : 0;
    if (bOwed !== aOwed) return bOwed - aOwed;
    const aTime = String(a.latestPaymentAt ?? a.createdAt ?? "");
    const bTime = String(b.latestPaymentAt ?? b.createdAt ?? "");
    return bTime > aTime ? 1 : -1;
  });

  res.json(sorted);
  } catch (err) {
    console.error("GET /payments/suggestions error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});


// GET /payments/default-month — tháng gần nhất có phiếu thu (dùng làm mặc định UI)
router.get("/payments/default-month", async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT to_char(MAX(paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM') AS month
      FROM payments
      WHERE COALESCE(status, 'active') != 'voided'
    `);
    let month = r.rows[0]?.month as string | null;
    if (!month) {
      month = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).slice(0, 7);
    }
    res.json({ month });
  } catch (err) {
    console.error("GET /payments/default-month error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

// GET /payments/recent?period=today|7days|month&month=YYYY-MM&limit=10 — lịch sử thu gần đây
router.get("/payments/recent", async (req, res) => {
  try {
  const period = (req.query.period as string) || "today";
  const monthParam = req.query.month as string | undefined;
  const limit  = Math.min(parseInt((req.query.limit as string) || "10"), 100);

  let dateFilter: string;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [yr, mo] = monthParam.split("-");
    const startDate = `${yr}-${mo}-01`;
    const nextYr  = parseInt(mo) === 12 ? String(parseInt(yr) + 1) : yr;
    const nextMo  = parseInt(mo) === 12 ? "01" : String(parseInt(mo) + 1).padStart(2, "0");
    const nextMonthStart = `${nextYr}-${nextMo}-01`;
    dateFilter = `p.paid_at >= '${startDate}'::timestamp AND p.paid_at < '${nextMonthStart}'::timestamp`;
  } else if (period === "today") {
    dateFilter = `p.paid_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'`;
  } else if (period === "7days") {
    dateFilter = `p.paid_at >= NOW() - INTERVAL '7 days'`;
  } else if (period === "all") {
    dateFilter = `TRUE`;
  } else {
    // month (calendar month hiện tại)
    dateFilter = `p.paid_at >= date_trunc('month', NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'`;
  }

  const BASE_SELECT = `
    SELECT
      p.id,
      p.booking_id         AS "bookingId",
      p.rental_id          AS "rentalId",
      p.amount::numeric    AS "amount",
      p.payment_method     AS "paymentMethod",
      p.payment_type       AS "paymentType",
      p.collector_name     AS "collectorName",
      p.bank_name          AS "bankName",
      p.proof_image_url    AS "proofImageUrl",
      p.proof_image_urls   AS "proofImageUrls",
      p.paid_date          AS "paidDate",
      p.paid_at            AS "paidAt",
      p.notes,
      p.payer_name         AS "payerName",
      p.payer_phone        AS "payerPhone",
      p.description        AS "description",
      p.ad_hoc_category    AS "adHocCategory",
      COALESCE(p.status, 'active') AS "paymentStatus",
      p.voided_at          AS "voidedAt",
      p.voided_by          AS "voidedBy",
      p.void_reason        AS "voidReason",
      c.name               AS "customerName",
      c.phone              AS "customerPhone",
      b.order_code         AS "orderCode",
      b.package_type       AS "packageType",
      b.shoot_date         AS "shootDate",
      b.total_amount::numeric       AS "totalAmount",
      b.discount_amount::numeric    AS "discountAmount",
      b.paid_amount::numeric        AS "paidAmount",
      GREATEST(0, (b.total_amount - COALESCE(b.discount_amount, 0) - b.paid_amount)::numeric) AS "remainingAmount",
      b.status             AS "status",
      b.is_parent_contract AS "isParentContract",
      (SELECT COUNT(*) FROM payments pp WHERE pp.booking_id = b.id AND COALESCE(pp.status, 'active') != 'voided') AS "paymentCount"
    FROM payments p
    LEFT JOIN bookings b ON p.booking_id = b.id
    LEFT JOIN customers c ON b.customer_id = c.id
    WHERE p.payment_type IN ('payment', 'deposit', 'ad_hoc')
      AND (p.booking_id IS NULL OR b.deleted_at IS NULL)
      AND ${dateFilter}
    ORDER BY p.paid_at DESC, p.id DESC
    LIMIT $1`;

  const [listResult, sumResult] = await Promise.all([
    pool.query(BASE_SELECT, [limit]),
    pool.query(
      `SELECT
         COUNT(*)::int          AS "count",
         COALESCE(SUM(p.amount::numeric), 0) AS "total"
       FROM payments p
       WHERE p.payment_type IN ('payment', 'deposit', 'ad_hoc')
         AND COALESCE(p.status, 'active') != 'voided'
         AND ${dateFilter}`
    ),
  ]);

  const payments = listResult.rows.map((p: any) => ({
    id:           Number(p.id),
    bookingId:    p.bookingId ? Number(p.bookingId) : null,
    rentalId:     p.rentalId  ? Number(p.rentalId)  : null,
    amount:       parseFloat(p.amount),
    paymentMethod: p.paymentMethod,
    paymentType:  p.paymentType,
    collectorName: p.collectorName ?? null,
    bankName:     p.bankName ?? null,
    proofImageUrl: p.proofImageUrl ?? null,
    proofImageUrls: Array.isArray(p.proofImageUrls) ? p.proofImageUrls : [],
    paidDate:     p.paidDate ?? null,
    paidAt:       p.paidAt ?? null,
    notes:        p.notes ?? null,
    payerName:    p.payerName ?? null,
    payerPhone:   p.payerPhone ?? null,
    description:  p.description ?? null,
    adHocCategory: p.adHocCategory ?? null,
    paymentStatus: p.paymentStatus ?? 'active',
    voidedAt:    p.voidedAt ?? null,
    voidedBy:    p.voidedBy ?? null,
    voidReason:  p.voidReason ?? null,
    customerName: p.customerName ?? p.payerName ?? null,
    customerPhone: p.customerPhone ?? p.payerPhone ?? null,
    orderCode:    p.orderCode ?? null,
    packageType:  p.packageType ?? null,
    shootDate:    p.shootDate ?? null,
    totalAmount:     parseFloat(p.totalAmount    || 0),
    discountAmount:  parseFloat(p.discountAmount || 0),
    paidAmount:      parseFloat(p.paidAmount     || 0),
    remainingAmount: parseFloat(p.remainingAmount || 0),
    status:          p.status ?? null,
    isParentContract: Boolean(p.isParentContract),
    paymentCount: Number(p.paymentCount ?? 0),
  }));

  const summary = sumResult.rows[0];
  res.json({
    payments,
    summary: {
      count: Number(summary.count),
      total: parseFloat(summary.total),
    },
  });
  } catch (err) {
    console.error("GET /payments/recent error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

// GET /payments/search?q=... — tìm đơn hàng cần thu theo tên/SĐT/mã đơn
// Hỗ trợ tìm kiếm có dấu/không dấu nhờ unaccent()
router.get("/payments/search", async (req, res) => {
  try {
  const q = ((req.query.q as string) || "").trim();
  if (!q) { res.json([]); return; }

  const pct = `%${q}%`;
  const result = await pool.query(
    `${BOOKING_JOIN_SQL}
     AND (
       unaccent(c.name) ILIKE unaccent($1)
       OR c.phone ILIKE $2
       OR b.order_code ILIKE $3
     )
     AND b.status != 'cancelled'
     ORDER BY b.created_at DESC
     LIMIT 20`,
    [pct, pct, pct]
  );

  res.json(result.rows.map(fmtBookingRow));
  } catch (err) {
    console.error("GET /payments/search error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

// POST /payments — tạo phiếu thu mới
router.post("/payments", async (req, res) => {
  try {
  const {
    bookingId, rentalId, amount, paymentMethod, paymentType,
    collectorName, bankName, proofImageUrl, proofImageUrls, paidDate, notes, paidAt,
    payerName, payerPhone, description, adHocCategory,
  } = req.body;
  const callerId = verifyToken(req.headers.authorization);

  // Task #390: nếu không có bookingId/rentalId → mặc định coi là phiếu thu lẻ (ad_hoc).
  // Phiếu ad_hoc KHÔNG bao giờ recalc booking.paidAmount.
  // NOTE: remainingAmount là computed runtime, không cần update column riêng.
  // Ad-hoc khi: client báo ad_hoc HOẶC không có bookingId & rentalId.
  // Ad-hoc luôn force bookingId/rentalId = null + KHÔNG recalc booking/rental.
  const effectivePaymentType =
    (paymentType === "ad_hoc" || (!bookingId && !rentalId))
      ? "ad_hoc"
      : (paymentType || "payment");

  const [payment] = await db
    .insert(paymentsTable)
    .values({
      bookingId:     effectivePaymentType === "ad_hoc" ? null : (bookingId || null),
      rentalId:      effectivePaymentType === "ad_hoc" ? null : (rentalId  || null),
      amount:        String(amount),
      paymentMethod,
      paymentType:   effectivePaymentType,
      collectorName: collectorName || null,
      bankName:      bankName      || null,
      proofImageUrl: proofImageUrl || (Array.isArray(proofImageUrls) && proofImageUrls.length ? proofImageUrls[0] : null),
      proofImageUrls: Array.isArray(proofImageUrls) ? proofImageUrls : [],
      paidDate:      paidDate      || null,
      notes:         notes         || null,
      payerName:     payerName     || null,
      payerPhone:    payerPhone    || null,
      description:   description   || null,
      adHocCategory: adHocCategory || null,
      ...(paidAt ? { paidAt: new Date(paidAt) } : {}),
    })
    .returning();

  // CHỈ recalc khi có bookingId hợp lệ VÀ KHÔNG phải ad_hoc.
  if (bookingId && effectivePaymentType !== "ad_hoc") {
    const allPaid = await db.select().from(paymentsTable)
      .where(and(
        eq(paymentsTable.bookingId, bookingId),
        ne(paymentsTable.paymentType, "ad_hoc"),
        ne(paymentsTable.paymentType, "refund"), // A4: refund không cộng như tiền thu
        sql`COALESCE(${paymentsTable.status}, 'active') != 'voided'`,
      ));
    const totalPaid = allPaid.reduce((s, p) => s + parseFloat(p.amount), 0);
    await db.update(bookingsTable)
      .set({ paidAmount: String(totalPaid) })
      .where(eq(bookingsTable.id, bookingId));
  }

  const fmtAmt = new Intl.NumberFormat("vi-VN").format(parseFloat(payment.amount));
  // Enrich notification: ai thu, từ khách nào, đơn nào
  let collector = collectorName || null;
  if (!collector && callerId) {
    const [staff] = await db.select({ name: staffTable.name }).from(staffTable).where(eq(staffTable.id, callerId));
    collector = staff?.name || null;
  }
  let custName = "";
  let orderCodeStr = "";
  if (bookingId) {
    const [bk] = await db.select({
      orderCode: bookingsTable.orderCode,
      customerName: customersTable.name,
    }).from(bookingsTable)
      .leftJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
      .where(eq(bookingsTable.id, bookingId));
    if (bk?.customerName) custName = bk.customerName;
    if (bk?.orderCode) orderCodeStr = ` ${bk.orderCode}`;
  }
  const collectorPart = collector ? `${collector} thu` : "Đã thu";
  if (effectivePaymentType === "ad_hoc") {
    // Phiếu thu lẻ — không có booking/khách hàng cố định.
    const who = (payerName && String(payerName).trim()) || "khách lẻ";
    const what = (description && String(description).trim()) || (adHocCategory ? String(adHocCategory) : "thu lẻ");
    emitNotification({
      staffId: null,
      senderStaffId: callerId ?? null,
      type: "payment_new",
      title: `${collectorPart} lẻ ${fmtAmt}đ — ${who}`,
      message: `${collectorPart} ${fmtAmt}đ (${what}) từ ${who}.`,
      targetModule: "payments",
      targetId: String(payment.id),
    });
  } else {
    const kind = effectivePaymentType === "deposit" ? "cọc" : "thanh toán";
    const customerPart = custName ? ` từ khách ${custName}` : "";
    const orderPart = orderCodeStr ? ` — đơn${orderCodeStr}` : "";
    emitNotification({
      staffId: null,
      senderStaffId: callerId ?? null,
      type: "payment_new",
      title: `${collectorPart} ${fmtAmt}đ (${kind})${customerPart ? " — " + custName : ""}`,
      message: `${collectorPart} ${fmtAmt}đ tiền ${kind}${customerPart}${orderPart}.`,
      targetModule: "payments",
      targetId: String(payment.id),
      bookingId: bookingId || undefined,
    });
  }
  res.status(201).json({ ...payment, amount: parseFloat(payment.amount) });
  } catch (err) {
    console.error("POST /payments error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi tạo phiếu thu" });
  }
});

// POST /payments/sync-deposits — đồng bộ tiền cọc cũ thành phiếu thu
// - Xóa duplicate deposit records (giữ bản cũ nhất)
// - Update deposit record nếu amount lệch
// - Tạo deposit record cho booking nào có depositAmount > 0 nhưng chưa có phiếu thu nào
// - Cập nhật lại paid_amount trên bookings table
router.post("/payments/sync-deposits", async (_req, res) => {
  try {
  const report: { created: number; removed: number; updated: number; recalculated: number } = {
    created: 0, removed: 0, updated: 0, recalculated: 0,
  };

  // Lấy tất cả bookings có depositAmount > 0, không phải child booking
  const bookingsWithDeposit = await pool.query(`
    SELECT id, deposit_amount::numeric AS deposit_amount, total_amount::numeric AS total_amount,
           order_code, shoot_date, status
    FROM bookings
    WHERE deposit_amount::numeric > 0
      AND parent_id IS NULL
    ORDER BY id
  `);

  const affectedBookingIds: number[] = [];

  for (const bk of bookingsWithDeposit.rows) {
    const bkId       = Number(bk.id);
    const depAmount  = parseFloat(bk.deposit_amount);

    // Lấy tất cả deposit payments cho booking này, sắp xếp theo id (cũ nhất trước)
    const depPayments = await pool.query(`
      SELECT id, amount, proof_image_url
      FROM payments
      WHERE booking_id = $1 AND payment_type = 'deposit'
      ORDER BY id ASC
    `, [bkId]);

    if (depPayments.rows.length === 0) {
      // Không có deposit record → tạo mới
      await pool.query(`
        INSERT INTO payments (booking_id, amount, payment_method, payment_type, paid_date, notes, proof_image_url, paid_at)
        VALUES ($1, $2, 'cash', 'deposit', $3, 'Cọc giữ lịch', NULL, NOW())
      `, [bkId, String(depAmount), bk.shoot_date || null]);
      report.created++;
      affectedBookingIds.push(bkId);
    } else if (depPayments.rows.length > 1) {
      // Có nhiều hơn 1 deposit → giữ cái đầu tiên, xóa phần thừa
      const toDelete = depPayments.rows.slice(1).map((r: any) => Number(r.id));
      for (const did of toDelete) {
        await pool.query(`DELETE FROM payments WHERE id = $1`, [did]);
        report.removed++;
      }
      affectedBookingIds.push(bkId);
    } else if (depPayments.rows.length === 1) {
      // Có 1 record — kiểm tra xem amount có lệch không
      const existingAmount = parseFloat(depPayments.rows[0].amount);
      if (Math.abs(existingAmount - depAmount) > 0.01) {
        // Amount lệch → update chỉ amount, không đổi paymentMethod/notes/paidAt
        await pool.query(
          `UPDATE payments SET amount = $1 WHERE id = $2`,
          [String(depAmount), depPayments.rows[0].id]
        );
        report.updated++;
        affectedBookingIds.push(bkId);
      }
      if (!depPayments.rows[0].proof_image_url) {
        await pool.query(
          `UPDATE payments SET proof_image_url = COALESCE(proof_image_url, NULL) WHERE id = $1`,
          [depPayments.rows[0].id]
        );
      }
    }
  }

  // Tính lại paid_amount cho tất cả booking bị ảnh hưởng
  // (remaining_amount tính runtime, không lưu column riêng trong bookings)
  const uniqueIds = [...new Set(affectedBookingIds)];
  for (const bkId of uniqueIds) {
    const paidResult = await pool.query(
      `SELECT COALESCE(SUM(amount::numeric), 0) AS total_paid FROM payments WHERE booking_id = $1 AND payment_type != 'refund' AND COALESCE(status, 'active') != 'voided'`,
      [bkId]
    );
    const totalPaid = parseFloat(paidResult.rows[0]?.total_paid || 0);
    await pool.query(`UPDATE bookings SET paid_amount = $1 WHERE id = $2`, [String(totalPaid), bkId]);
    report.recalculated++;
  }

  res.json({
    message: `Đồng bộ hoàn tất: tạo ${report.created} phiếu cọc mới, cập nhật ${report.updated} phiếu, xóa ${report.removed} bản trùng, cập nhật ${report.recalculated} đơn hàng`,
    ...report,
  });
  } catch (err) {
    console.error("POST /payments/sync-deposits error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi đồng bộ cọc" });
  }
});

// PATCH /payments/:id — chỉ cập nhật proofImageUrl cho payment đã tồn tại
router.patch("/payments/:id", async (req, res) => {
  try {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });
  const { proofImageUrl, proofImageUrls } = req.body;
  if (proofImageUrl === undefined && proofImageUrls === undefined) {
    return res.status(400).json({ error: "Thiếu proofImageUrl" });
  }

  const urls = Array.isArray(proofImageUrls)
    ? proofImageUrls
    : (proofImageUrl ? [proofImageUrl] : []);
  const primary = proofImageUrl ?? urls[0] ?? null;

  const [updated] = await db
    .update(paymentsTable)
    .set({ proofImageUrl: primary || null, proofImageUrls: urls })
    .where(eq(paymentsTable.id, id))
    .returning();

  if (!updated) return res.status(404).json({ error: "Không tìm thấy phiếu thu" });
  res.json({ ...updated, amount: parseFloat(updated.amount) });
  } catch (err) {
    console.error("PATCH /payments/:id error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi cập nhật ảnh cọc" });
  }
});

// DELETE /payments/:id — giới hạn super-admin only, khuyến cáo dùng void
router.delete("/payments/:id", async (req, res) => {
  try {
  // Auth: require valid admin token
  const role = await getCallerRole(req.headers.authorization);
  if (!role) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (role !== "admin") { res.status(403).json({ error: "Chỉ super-admin mới được xóa vật lý" }); return; }
  const id = parseInt(req.params.id);
  const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, id));
  await db.delete(paymentsTable).where(eq(paymentsTable.id, id));
  if (payment?.bookingId && payment.paymentType !== "ad_hoc") {
    const remainingPmts = await db.select().from(paymentsTable)
      .where(and(
        eq(paymentsTable.bookingId, payment.bookingId),
        ne(paymentsTable.paymentType, "ad_hoc"),
        ne(paymentsTable.paymentType, "refund"), // A4: refund không cộng như tiền thu
        sql`COALESCE(${paymentsTable.status}, 'active') != 'voided'`,
      ));
    const totalPaid = remainingPmts.reduce((s, p) => s + parseFloat(p.amount), 0);
    await db.update(bookingsTable)
      .set({ paidAmount: String(totalPaid) })
      .where(eq(bookingsTable.id, payment.bookingId));
  }
  res.status(204).send();
  } catch (err) {
    console.error("DELETE /payments/:id error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi xóa phiếu thu" });
  }
});

// POST /payments/:id/void — huỷ phiếu thu (soft delete, chỉ admin)
// Bắt buộc nhập lý do. Recalculate booking paid_amount/remaining_amount nếu có.
router.post("/payments/:id/void", async (req, res) => {
  try {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });

  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const [caller] = await db.select({ id: staffTable.id, name: staffTable.name, role: staffTable.role })
    .from(staffTable).where(eq(staffTable.id, callerId));
  const isAdmin = caller?.role === "admin";
  if (!isAdmin) return res.status(403).json({ error: "Chỉ admin mới có thể huỷ phiếu thu" });

  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: "Vui lòng nhập lý do huỷ" });

  const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, id));
  if (!payment) return res.status(404).json({ error: "Không tìm thấy phiếu thu" });
  if (payment.status === "voided") return res.status(400).json({ error: "Phiếu đã được huỷ trước đó" });

  await pool.query(
    `UPDATE payments SET status = 'voided', voided_at = NOW(), voided_by = $1, void_reason = $2 WHERE id = $3`,
    [caller.name || String(callerId), reason.trim(), id]
  );

  // Recalculate booking paid_amount nếu phiếu gắn với booking.
  // NOTE: bookings table không có cột remaining_amount; nó được tính
  // runtime = GREATEST(0, total_amount - discount_amount - paid_amount).
  // Chỉ cần update paid_amount để remaining_amount tự động chính xác.
  if (payment.bookingId && payment.paymentType !== "ad_hoc" && payment.paymentType !== "refund") {
    const paidResult = await pool.query(
      `SELECT COALESCE(SUM(amount::numeric), 0) AS total_paid
       FROM payments
       WHERE booking_id = $1
         AND payment_type != 'refund'
         AND COALESCE(status, 'active') != 'voided'`,
      [payment.bookingId]
    );
    const totalPaid = parseFloat(paidResult.rows[0]?.total_paid || "0");
    await pool.query(
      `UPDATE bookings SET paid_amount = $1 WHERE id = $2`,
      [String(totalPaid), payment.bookingId]
    );
  }

  res.json({ ok: true, message: "Đã huỷ phiếu thu thành công" });
  } catch (err) {
    console.error("POST /payments/:id/void error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi huỷ phiếu thu" });
  }
});

// GET /payments/monthly-list — bookings + payments grouped by shoot month or collection month
// ?viewMode=shootMonth|collectMonth (default: collectMonth)
// ?month=YYYY-MM (required)
router.get("/payments/monthly-list", async (req, res) => {
  try {
    const viewMode = (req.query.viewMode as string) || "collectMonth";
    const month = req.query.month as string | undefined;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "Cần tham số ?month=YYYY-MM" });
    }
    const moNum = parseInt(month.split("-")[1]);
    if (moNum < 1 || moNum > 12) {
      return res.status(400).json({ error: "Tháng không hợp lệ (phải từ 01 đến 12)" });
    }
    const [yr, mo] = month.split("-");
    const startDate = `${yr}-${mo}-01`;
    // Dùng đầu tháng tiếp theo thay vì ngày 31 cố định — tránh invalid date cho tháng ≤ 30 ngày
    const nextYr  = parseInt(mo) === 12 ? String(parseInt(yr) + 1) : yr;
    const nextMo  = parseInt(mo) === 12 ? "01" : String(parseInt(mo) + 1).padStart(2, "0");
    const nextMonthStart = `${nextYr}-${nextMo}-01`;

    let bookingRows: Record<string, unknown>[];
    if (viewMode === "shootMonth") {
      const r = await pool.query(`
        SELECT b.id, b.order_code, b.shoot_date, b.created_at, b.package_type, b.service_label,
               b.total_amount, b.discount_amount, b.paid_amount, b.status,
               b.service_category, b.is_parent_contract,
               c.name AS customer_name, c.phone AS customer_phone,
               COALESCE((
                 SELECT json_agg(json_build_object(
                   'id', p.id, 'amount', p.amount::numeric, 'paidAt', p.paid_at, 'note', p.notes, 'paymentType', p.payment_type,
                   'proofImageUrl', p.proof_image_url, 'proofImageUrls', p.proof_image_urls,
                   'paymentStatus', COALESCE(p.status, 'active'), 'voidedAt', p.voided_at, 'voidedBy', p.voided_by, 'voidReason', p.void_reason
                 ) ORDER BY p.paid_at DESC, p.id DESC)
                 FROM payments p WHERE p.booking_id = b.id AND p.payment_type != 'refund'
               ), '[]') AS payments_list,
               (SELECT MAX(p.paid_at) FROM payments p WHERE p.booking_id = b.id AND p.payment_type != 'refund'
                  AND COALESCE(p.status, 'active') != 'voided') AS latest_paid_at
        FROM bookings b
        JOIN customers c ON c.id = b.customer_id
        WHERE b.shoot_date >= $1 AND b.shoot_date < $2
          AND b.status != 'cancelled'
          AND b.is_parent_contract = false
        ORDER BY latest_paid_at DESC NULLS LAST, b.shoot_date ASC, b.id ASC
      `, [startDate, nextMonthStart]);
      bookingRows = r.rows;
    } else {
      // collectMonth mode: bookings that have payments in this month
      const r = await pool.query(`
        SELECT b.id, b.order_code, b.shoot_date, b.created_at, b.package_type, b.service_label,
               b.total_amount, b.discount_amount, b.paid_amount, b.status,
               b.service_category, b.is_parent_contract,
               c.name AS customer_name, c.phone AS customer_phone,
               COALESCE((
                 SELECT json_agg(json_build_object(
                   'id', p.id, 'amount', p.amount::numeric, 'paidAt', p.paid_at, 'note', p.notes, 'paymentType', p.payment_type,
                   'proofImageUrl', p.proof_image_url, 'proofImageUrls', p.proof_image_urls,
                   'paymentStatus', COALESCE(p.status, 'active'), 'voidedAt', p.voided_at, 'voidedBy', p.voided_by, 'voidReason', p.void_reason
                 ) ORDER BY p.paid_at DESC, p.id DESC)
                 FROM payments p WHERE p.booking_id = b.id AND p.payment_type != 'refund'
                   AND p.paid_at >= $1 AND p.paid_at < $2
               ), '[]') AS payments_list,
               COALESCE((
                 SELECT SUM(p.amount::numeric)
                 FROM payments p WHERE p.booking_id = b.id AND p.payment_type != 'refund'
                   AND COALESCE(p.status, 'active') != 'voided'
                   AND p.paid_at >= $1 AND p.paid_at < $2
               ), 0) AS collected_in_period,
               (SELECT MAX(p.paid_at) FROM payments p WHERE p.booking_id = b.id AND p.payment_type != 'refund'
                  AND COALESCE(p.status, 'active') != 'voided'
                  AND p.paid_at >= $1 AND p.paid_at < $2) AS latest_paid_at
        FROM bookings b
        JOIN customers c ON c.id = b.customer_id
        WHERE EXISTS (
          SELECT 1 FROM payments p2
          WHERE p2.booking_id = b.id AND p2.payment_type != 'refund'
            AND p2.paid_at >= $1 AND p2.paid_at < $2
        )
        ORDER BY latest_paid_at DESC NULLS LAST, b.shoot_date ASC, b.id ASC
      `, [startDate, nextMonthStart]);
      bookingRows = r.rows;
    }

    const data = bookingRows.map(b => {
      const total = parseFloat(String(b.total_amount));
      const discount = parseFloat(String(b.discount_amount || 0));
      const paid = parseFloat(String(b.paid_amount));
      const remaining = Math.max(0, total - discount - paid);
      const collectedInPeriod = parseFloat(String(b.collected_in_period || paid));
      const paymentsList = Array.isArray(b.payments_list) ? b.payments_list : [];
      return {
        id: Number(b.id), orderCode: b.order_code, shootDate: b.shoot_date, createdAt: b.created_at,
        packageType: b.package_type, serviceLabel: b.service_label, serviceCategory: b.service_category,
        customerName: b.customer_name, customerPhone: b.customer_phone,
        totalAmount: total, discountAmount: discount, paidAmount: paid, remainingAmount: remaining,
        collectedInPeriod,
        status: b.status,
        latestPaidAt: b.latest_paid_at ?? null,
        payments: paymentsList,
      };
    });

    // Task #390: phiếu thu lẻ (ad_hoc) — không gắn booking. Chỉ liệt kê khi
    // viewMode = collectMonth (xem theo tháng thu tiền).
    let adHocPayments: any[] = [];
    let adHocTotal = 0;
    if (viewMode === "collectMonth") {
      const ah = await pool.query(
        `SELECT id, amount::numeric AS amount, payment_method, paid_at, paid_date,
                payer_name, payer_phone, description, ad_hoc_category, collector_name,
                bank_name, notes, proof_image_url, proof_image_urls,
                COALESCE(status, 'active') AS payment_status, voided_at, voided_by, void_reason
         FROM payments
         WHERE payment_type = 'ad_hoc'
           AND paid_at >= $1 AND paid_at < $2
         ORDER BY paid_at DESC, id DESC`,
        [startDate, nextMonthStart]
      );
      adHocPayments = ah.rows.map(r => ({
        id: Number(r.id),
        amount: parseFloat(r.amount),
        paymentMethod: r.payment_method,
        paidAt: r.paid_at,
        paidDate: r.paid_date,
        payerName: r.payer_name,
        payerPhone: r.payer_phone,
        description: r.description,
        adHocCategory: r.ad_hoc_category,
        collectorName: r.collector_name,
        bankName: r.bank_name,
        notes: r.notes,
        proofImageUrl: r.proof_image_url,
        proofImageUrls: Array.isArray(r.proof_image_urls) ? r.proof_image_urls : [],
        paymentStatus: r.payment_status ?? 'active',
        voidedAt: r.voided_at ?? null,
        voidedBy: r.voided_by ?? null,
        voidReason: r.void_reason ?? null,
      }));
      adHocTotal = adHocPayments.filter(p => p.paymentStatus !== 'voided').reduce((s, p) => s + p.amount, 0);
    }

    const totalCollected = data.reduce((s, b) => s + (viewMode === "shootMonth" ? b.paidAmount : b.collectedInPeriod), 0) + adHocTotal;
    const totalOwed = data.reduce((s, b) => s + b.remainingAmount, 0);
    const totalAmount = data.reduce((s, b) => s + b.totalAmount, 0);

    res.json({
      viewMode, month,
      summary: { totalBookings: data.length, totalAmount, totalCollected, totalOwed, adHocCount: adHocPayments.length, adHocTotal },
      bookings: data,
      adHocPayments,
    });
  } catch (err) {
    console.error("GET /payments/monthly-list error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

// GET /payments/export — xuất danh sách công nợ ra CSV
// ?month=YYYY-MM (bắt buộc hoặc bỏ để xuất tất cả)
// ?status=all|owed|paid (default: all)
// ?viewMode=shootMonth|collectMonth (default: collectMonth)
router.get("/payments/export", async (req, res) => {
  try {
    const month    = req.query.month    as string | undefined;
    const status   = (req.query.status   as string) || "all";
    const viewMode = (req.query.viewMode as string) || "collectMonth";

    // Validate enums
    if (!["all", "owed", "paid"].includes(status)) {
      return res.status(400).json({ error: "Tham số status phải là: all, owed, hoặc paid" });
    }
    if (!["shootMonth", "collectMonth"].includes(viewMode)) {
      return res.status(400).json({ error: "Tham số viewMode phải là: shootMonth hoặc collectMonth" });
    }

    // Validate định dạng và giá trị tháng
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: "Tham số month phải có định dạng YYYY-MM" });
      }
      const moNum = parseInt(month.split("-")[1]);
      if (moNum < 1 || moNum > 12) {
        return res.status(400).json({ error: "Tháng không hợp lệ (phải từ 01 đến 12)" });
      }
    }

    let dateClause = "";
    const params: string[] = [];

    if (month) {
      const [yr, mo] = month.split("-");
      const startDate      = `${yr}-${mo}-01`;
      const nextYr  = parseInt(mo) === 12 ? String(parseInt(yr) + 1) : yr;
      const nextMo  = parseInt(mo) === 12 ? "01" : String(parseInt(mo) + 1).padStart(2, "0");
      const nextMonthStart = `${nextYr}-${nextMo}-01`;
      params.push(startDate, nextMonthStart);

      if (viewMode === "shootMonth") {
        dateClause = `AND b.shoot_date >= $1 AND b.shoot_date < $2`;
      } else {
        dateClause = `AND EXISTS (
          SELECT 1 FROM payments px
          WHERE px.booking_id = b.id AND px.payment_type != 'refund'
            AND COALESCE(px.status, 'active') != 'voided'
            AND px.paid_at >= $1 AND px.paid_at < $2
        )`;
      }
    }

    let statusClause = "";
    if (status === "owed") {
      statusClause = `AND GREATEST(0, (b.total_amount - COALESCE(b.discount_amount, 0) - b.paid_amount)::numeric) > 0`;
    } else if (status === "paid") {
      statusClause = `AND GREATEST(0, (b.total_amount - COALESCE(b.discount_amount, 0) - b.paid_amount)::numeric) <= 0`;
    }

    const result = await pool.query(`
      SELECT
        b.id,
        b.order_code                                                              AS "orderCode",
        c.name                                                                    AS "customerName",
        c.phone                                                                   AS "customerPhone",
        b.shoot_date                                                              AS "shootDate",
        b.package_type                                                            AS "packageType",
        b.total_amount::numeric                                                   AS "totalAmount",
        COALESCE(b.discount_amount::numeric, 0)                                   AS "discountAmount",
        b.paid_amount::numeric                                                    AS "paidAmount",
        GREATEST(0, (b.total_amount - COALESCE(b.discount_amount, 0) - b.paid_amount)::numeric) AS "remainingAmount",
        b.status,
        COALESCE((
          SELECT STRING_AGG(DISTINCT
            CASE p.payment_method
              WHEN 'cash' THEN 'Tiền mặt'
              WHEN 'bank_transfer' THEN 'Chuyển khoản'
              ELSE p.payment_method
            END, ', '
          )
          FROM payments p
          WHERE p.booking_id = b.id AND p.payment_type != 'refund'
            AND COALESCE(p.status, 'active') != 'voided'
        ), '') AS "paymentMethods",
        COALESCE((
          SELECT MAX(p.paid_at)
          FROM payments p
          WHERE p.booking_id = b.id AND p.payment_type != 'refund'
            AND COALESCE(p.status, 'active') != 'voided'
        ), NULL) AS "lastPaymentAt"
      FROM bookings b
      JOIN customers c ON c.id = b.customer_id
      WHERE b.parent_id IS NULL
        AND b.status != 'cancelled'
        ${dateClause}
        ${statusClause}
      ORDER BY b.shoot_date ASC, b.id ASC
    `, params);

    const STATUS_LABEL: Record<string, string> = {
      pending:     "Chờ xác nhận",
      confirmed:   "Đã xác nhận",
      in_progress: "Đang thực hiện",
      completed:   "Hoàn thành",
      cancelled:   "Đã hủy",
    };

    const fmtDateCSV = (d: string | null) => {
      if (!d) return "";
      const dt = new Date(d);
      return `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}/${dt.getFullYear()}`;
    };

    // Sanitize a text cell: neutralize formula-leading chars (=, +, -, @) and quote for CSV
    const textCell = (v: string | null | undefined): string => {
      if (v === null || v === undefined || v === "") return "";
      let s = String(v);
      // Prevent Excel formula injection
      if (/^[=+\-@]/.test(s)) s = " " + s;
      // Standard CSV quoting
      if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    // Force a value to display as text in Excel using ="value" notation
    const textForced = (v: string | null | undefined): string => {
      if (v === null || v === undefined || v === "") return "";
      const s = String(v).replace(/"/g, '""');
      return `="` + s + `"`;
    };

    const headers = [
      "Tên khách", "Số điện thoại", "Mã đơn", "Ngày chụp",
      "Gói dịch vụ", "Tổng tiền", "Giảm giá", "Phải thu",
      "Đã thu", "Còn nợ", "Phương thức TT", "Trạng thái", "Thu lần cuối",
    ];

    const rows = result.rows.map((b: any) => {
      const total    = parseFloat(b.totalAmount    || 0);
      const discount = parseFloat(b.discountAmount || 0);
      const paid     = parseFloat(b.paidAmount     || 0);
      const remain   = parseFloat(b.remainingAmount || 0);
      return [
        textCell(b.customerName),
        textForced(b.customerPhone),   // preserve leading zeroes (e.g. 0362...)
        textForced(b.orderCode),       // preserve as text (e.g. HS-001)
        textCell(fmtDateCSV(b.shootDate)),
        textCell(b.packageType),
        total,
        discount > 0 ? discount : "",
        total - discount,
        paid,
        remain,
        textCell(b.paymentMethods),
        textCell(STATUS_LABEL[b.status] ?? b.status),
        textCell(fmtDateCSV(b.lastPaymentAt)),
      ].join(",");
    });

    const csv = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");

    const filename = month
      ? `cong-no-${month}.csv`
      : `cong-no-tat-ca.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error("GET /payments/export error:", err);
    res.status(500).json({ error: "Lỗi hệ thống khi xuất dữ liệu" });
  }
});

export default router;
