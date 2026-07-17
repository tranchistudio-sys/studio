/**
 * FINANCIAL ENGINE — trái tim tính tiền của hệ thống (kiến trúc chủ duyệt 14/07):
 *
 *   Booking / Payment / Expense / Payroll / Commission  (dữ liệu GỐC)
 *        ↓
 *   FINANCIAL ENGINE  (file này — MỘT nơi định nghĩa quy tắc tiền)
 *        ↓
 *   Dashboard / Customer / Revenue / Accounting / Copilot  (đều là CONSUMER)
 *
 * Engine KHÔNG lấy bất kỳ màn hình nào làm chuẩn — nó tính thẳng từ bảng gốc
 * theo 5 quy tắc nghiệp vụ chủ đã chốt (GĐ2, 14/07):
 *   ① Công nợ = CÔNG NỢ SỐNG per-booking: max(0, tổng − giảm giá − đã thu),
 *      trên tập đơn hợp lệ (loại thùng rác/hủy/báo giá tạm/đơn cha tổng/con mồ côi).
 *   ② Chi phí cost_class 'personal' KHÔNG tính vào lợi nhuận studio.
 *   ③ Expense chỉ tính APPROVED / đã chi thực tế (paid) — không submitted/rejected;
 *      'loan_principal' là trả gốc vay, không phải chi phí.
 *   ④ Lương/cast theo show = staff_job_earnings (KHÔNG dùng tasks.cost).
 *   ⑤ Hệ thống chỉ có MỘT pipeline tiền — bảng transactions (accounting) không phải nguồn.
 *
 * GĐ0: engine phục vụ Financial Truth Test (read-only). GĐ1: các consumer chuyển
 * sang gọi engine.
 *
 * GĐ3 — FAMILY CASH ALLOCATION (PR #102): engine KHÔNG còn tin cột
 * bookings.paid_amount (bản phân bổ ghi sẵn — thực tế phân bổ hỏng: phiếu thu
 * hợp đồng gộp nằm ở đơn CHA, đơn CON không nhận được phần tiền → màn Khách/
 * Dashboard/Copilot báo nợ sai). "Đã thu" của MỖI booking giờ được PHÂN BỔ LIVE
 * từ bảng payments GỐC theo gia đình đơn:
 *
 *   family_paid = Σ phiếu thu hợp lệ (không voided/refund/ad_hoc) ghi trên BẤT KỲ
 *                 thành viên nào của gia đình (cha hoặc con)
 *   phân bổ pro-rata theo GIÁ TRỊ HỢP ĐỒNG (net) của từng thành viên countable:
 *   alloc(b) = family_paid × net(b) / Σ net(thành viên countable)
 *   (Σ net = 0 → dồn toàn bộ vào thành viên countable id nhỏ nhất — deterministic)
 *
 * Tính chất then chốt của pro-rata: nếu family_paid ≤ family_net thì
 * Σ per-booking GREATEST(0, net−alloc) = family_net − family_paid — tức tổng nợ
 * per-booking (①) LUÔN bằng nợ mức gia đình mà màn Booking/Hợp đồng hiển thị.
 * Không copy dữ liệu, không sửa/tạo payment — chỉ đổi cách ĐỌC.
 * engineFamilyCashDrift giữ nguyên vai trò cảnh báo vệ sinh cột paid_amount cũ.
 */
import { pool } from "@workspace/db";
import { revenueCountableSql } from "../booking-money";
import { paymentNotOnEmptyParentSql } from "../parent-contract";
import { getSchemaFlags } from "../schema-compat";

/**
 * SQL "đã thu PHÂN BỔ" của một dòng booking `alias` (correlated subquery).
 * Nguồn: bảng payments GỐC của CẢ GIA ĐÌNH đơn, pro-rata theo net từng thành viên.
 * Booking không countable (cha tổng/hủy/tạm/xóa/mồ côi) nhận 0 — nhất quán với
 * tập tính nợ; phiếu trên "cha rỗng" (không còn con hiệu lực) → không ai nhận
 * (mirror paymentNotOnEmptyParentSql: tiền treo, không tính vào Đã thu active).
 */
export function engineAllocPaidSql(alias = "b"): string {
  const a = alias;
  return `(
    SELECT CASE
      WHEN NOT (${revenueCountableSql(a)}) THEN 0
      WHEN fam.family_net > 0
        THEN fam.family_paid * GREATEST(0, ${a}.total_amount - COALESCE(${a}.discount_amount, 0)) / fam.family_net
      WHEN fam.first_countable_id = ${a}.id THEN fam.family_paid
      ELSE 0
    END
    FROM (
      SELECT
        COALESCE(SUM(GREATEST(0, fm.total_amount - COALESCE(fm.discount_amount, 0)))
          FILTER (WHERE ${revenueCountableSql("fm")}), 0) AS family_net,
        MIN(fm.id) FILTER (WHERE ${revenueCountableSql("fm")}) AS first_countable_id,
        COALESCE((
          SELECT SUM(p.amount::numeric)
          FROM payments p JOIN bookings pb ON pb.id = p.booking_id
          WHERE COALESCE(pb.parent_id, pb.id) = COALESCE(${a}.parent_id, ${a}.id)
            AND COALESCE(p.status, 'active') != 'voided'
            AND COALESCE(p.payment_type, '') NOT IN ('refund', 'ad_hoc')
        ), 0) AS family_paid
      FROM bookings fm
      WHERE COALESCE(fm.parent_id, fm.id) = COALESCE(${a}.parent_id, ${a}.id)
    ) fam
  )`;
}

/** "Đã thu phân bổ" cho alias mặc định b — dùng trong mọi SELECT của engine. */
export const ENGINE_ALLOC_PAID_SQL = engineAllocPaidSql("b");

/** Quy tắc ①: nợ sống per-booking = max(0, net − đã thu PHÂN BỔ từ payments gốc). */
export const ENGINE_DEBT_SQL =
  `GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0) - ${ENGINE_ALLOC_PAID_SQL})`;

/**
 * BA SCOPE CHÍNH THỨC của doanh thu tháng (chủ chốt 14/07 tối) — ba chỉ số là ba
 * phạm vi KHÁC NHAU, cấm trộn (phép trộn contractValue(created_at) − payments(tháng)
 * từng đẻ ra con số 175.748.994 vô nghĩa vận hành):
 *  - Hợp đồng ký mới trong tháng   → scope booking_created_at (chỉ số bán hàng)
 *  - Tiền thực thu trong tháng     → scope payment_date
 *  - Còn có thể thu từ show của tháng → scope shoot_date_or_occurrence (công nợ sống)
 */
export const REVENUE_SCOPES = {
  signedContractValue: { scope: "booking_created_at" },
  collectedAmount: { scope: "payment_date" },
  receivableAmount: { scope: "shoot_date_or_occurrence" },
} as const;

/**
 * Membership "đơn thuộc kỳ" theo NGÀY THỰC HIỆN: shoot_date trong kỳ HOẶC có ngày
 * thực hiện phụ (booking_occurrences) trong kỳ — mỗi đơn tính MỘT lần (EXISTS,
 * không JOIN nên không thể double-count đơn nhiều occurrence). Bảng occurrences
 * có thể chưa tồn tại trên DB chưa migrate → chỉ thêm vế EXISTS khi flag bật
 * (cùng cơ chế chống sập PR #82).
 */
export function monthMembershipSql(p1: string, p2: string, hasOccurrences: boolean): string {
  const byShootDate = `b.shoot_date >= ${p1}::date AND b.shoot_date <= ${p2}::date`;
  if (!hasOccurrences) return `(${byShootDate})`;
  return `((${byShootDate}) OR EXISTS (
    SELECT 1 FROM booking_occurrences oc
    WHERE oc.booking_id = b.id AND oc.shoot_date >= ${p1}::date AND oc.shoot_date <= ${p2}::date))`;
}

/**
 * "Còn có thể thu" của các show trong kỳ [from, to]: công nợ sống per-booking
 * (quy tắc ①) trên tập đơn hợp lệ có ngày chụp/occurrence trong kỳ.
 * Đơn tạo tháng trước nhưng chụp trong kỳ → TÍNH; đơn tạo trong kỳ nhưng chụp
 * kỳ sau → KHÔNG tính.
 */
export async function engineReceivableForRange(from: string, to: string): Promise<number> {
  const hasOcc = (await getSchemaFlags()).occurrences;
  return num(
    `SELECT COALESCE(SUM(${ENGINE_DEBT_SQL}), 0) AS v
     FROM bookings b
     WHERE ${revenueCountableSql("b")} AND ${monthMembershipSql("$1", "$2", hasOcc)}`,
    [from, to],
  );
}

export type ReceivableEvidenceRow = {
  bookingId: number;
  orderCode: string | null;
  customerName: string | null;
  serviceLabel: string | null;
  shootDate: string | null;
  net: number;
  allocPaid: number;
  debt: number;
};

/**
 * Bằng chứng của engineReceivableForRange: liệt kê TỪNG ĐƠN còn nợ trong kỳ,
 * dùng ĐÚNG cùng biểu thức ENGINE_DEBT_SQL + cùng WHERE với hàm tổng ở trên.
 * `total` được tính bằng SUM window TRONG CÙNG MỘT câu SQL (cùng snapshot) trên
 * tập đầy đủ TRƯỚC khi lọc debt > 0 ⇒ luôn bằng engineReceivableForRange và bằng
 * SUM(rows) by-construction (đơn nợ 0 bị ẩn khỏi danh sách không đổi tổng) —
 * không thể lệch do ghi đồng thời giữa hai query rời.
 */
export async function engineReceivableRowsForRange(
  from: string,
  to: string,
): Promise<{ rows: ReceivableEvidenceRow[]; total: number }> {
  const hasOcc = (await getSchemaFlags()).occurrences;
  const r = await pool.query(
    `SELECT * FROM (
       SELECT t.*, SUM(t.debt) OVER () AS card_total
       FROM (
         SELECT b.id, b.order_code, b.service_label, b.shoot_date::text AS shoot_date,
                c.name AS customer_name,
                GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0)) AS net,
                ${ENGINE_ALLOC_PAID_SQL} AS alloc_paid,
                ${ENGINE_DEBT_SQL} AS debt
         FROM bookings b
         LEFT JOIN customers c ON c.id = b.customer_id
         WHERE ${revenueCountableSql("b")} AND ${monthMembershipSql("$1", "$2", hasOcc)}
       ) t
     ) w
     WHERE w.debt > 0
     ORDER BY w.shoot_date, w.id`,
    [from, to],
  );
  const list = r.rows as Array<{
    id: number; order_code: string | null; service_label: string | null;
    shoot_date: string | null; customer_name: string | null;
    net: string; alloc_paid: string; debt: string; card_total: string;
  }>;
  return {
    rows: list.map(row => ({
      bookingId: Number(row.id),
      orderCode: row.order_code,
      customerName: row.customer_name,
      serviceLabel: row.service_label,
      shootDate: row.shoot_date,
      net: Number(row.net),
      allocPaid: Number(row.alloc_paid),
      debt: Number(row.debt),
    })),
    // 0 dòng nợ dương → tổng chắc chắn 0 (mọi debt đều GREATEST(0,…) = 0).
    total: list.length > 0 ? Number(list[0]!.card_total) : 0,
  };
}

/** Phiếu thu HỢP LỆ của dòng tiền: không voided, không refund, không nằm trên đơn cha rỗng. */
function collectedPaymentCond(alias = "payments"): string {
  return `COALESCE(${alias}.status,'active') != 'voided'
    AND COALESCE(${alias}.payment_type,'') != 'refund'
    AND ${paymentNotOnEmptyParentSql(alias)}`;
}

async function num(sql: string, params: unknown[] = []): Promise<number> {
  const r = await pool.query(sql, params);
  return Number((r.rows[0] as { v?: string } | undefined)?.v ?? 0);
}

// ─── Công nợ (quy tắc ①) ───────────────────────────────────────────────────────

export async function engineSystemDebt(): Promise<number> {
  return num(
    `SELECT COALESCE(SUM(${ENGINE_DEBT_SQL}), 0) AS v FROM bookings b WHERE ${revenueCountableSql("b")}`,
  );
}

export async function engineCustomerDebt(customerId: number): Promise<number> {
  return num(
    `SELECT COALESCE(SUM(${ENGINE_DEBT_SQL}), 0) AS v
     FROM bookings b WHERE ${revenueCountableSql("b")} AND b.customer_id = $1`,
    [customerId],
  );
}

export type CustomerFinance = {
  /** Số show = số đơn countable (đơn con + đơn lẻ hợp lệ). */
  totalBookings: number;
  /** Tổng phải thu = Σ NET per-booking (tổng − giảm giá, không âm). */
  totalOwed: number;
  /** Đã trả = Σ "đã thu PHÂN BỔ LIVE" (từ payments gốc, pro-rata theo gia đình)
   *  trên các đơn countable — tiền ghi ở đơn CHA giờ TỰ chảy xuống các dịch vụ
   *  con theo giá trị hợp đồng (PR #102). */
  totalPaid: number;
  /** Còn nợ = quy tắc ①: Σ GREATEST(0, net − paid) per-booking. */
  totalDebt: number;
};

const CUSTOMER_FINANCE_SELECT = `
  COUNT(*)::int AS cnt,
  COALESCE(SUM(GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0))), 0) AS owed,
  COALESCE(SUM(${ENGINE_ALLOC_PAID_SQL}), 0) AS paid,
  COALESCE(SUM(${ENGINE_DEBT_SQL}), 0) AS debt`;

function rowToCustomerFinance(row?: Record<string, unknown>): CustomerFinance {
  return {
    totalBookings: Number(row?.cnt ?? 0),
    totalOwed: Number(row?.owed ?? 0),
    totalPaid: Number(row?.paid ?? 0),
    totalDebt: Number(row?.debt ?? 0),
  };
}

/** Bộ số tài chính hồ sơ MỘT khách (màn Khách hàng chi tiết dùng). */
export async function engineCustomerFinance(customerId: number): Promise<CustomerFinance> {
  const r = await pool.query(
    `SELECT ${CUSTOMER_FINANCE_SELECT}
     FROM bookings b WHERE ${revenueCountableSql("b")} AND b.customer_id = $1`,
    [customerId],
  );
  return rowToCustomerFinance(r.rows[0] as Record<string, unknown> | undefined);
}

/** Bộ số tài chính TOÀN BỘ khách trong MỘT query (màn danh sách Khách hàng dùng
 *  — thay vòng lặp N+1 query + nạp toàn bộ payments vào RAM trước đây). */
export async function engineAllCustomersFinance(): Promise<Map<number, CustomerFinance>> {
  const r = await pool.query(
    `SELECT b.customer_id AS cid, ${CUSTOMER_FINANCE_SELECT}
     FROM bookings b
     WHERE ${revenueCountableSql("b")} AND b.customer_id IS NOT NULL
     GROUP BY b.customer_id`,
  );
  const map = new Map<number, CustomerFinance>();
  for (const row of r.rows as Array<Record<string, unknown>>) {
    map.set(Number(row.cid), rowToCustomerFinance(row));
  }
  return map;
}

// ─── Dòng tiền vào (từ bảng payments GỐC) ─────────────────────────────────────

/** Tiền đã thu trong kỳ [from, to] (ngày, nửa đóng hai đầu theo ngày). */
export async function engineCashIn(from: string, to: string): Promise<number> {
  return num(
    `SELECT COALESCE(SUM(amount::numeric), 0) AS v FROM payments
     WHERE paid_at >= $1::date AND paid_at < ($2::date + INTERVAL '1 day')
       AND ${collectedPaymentCond("payments")}`,
    [from, to],
  );
}

// ─── Dòng tiền ra / chi phí studio (quy tắc ② + ③) ────────────────────────────

export type EngineCashOut = {
  /** Chi phí studio trong kỳ: approved/paid, KHÔNG personal, KHÔNG loan_principal. */
  studioExpense: number;
  /** Khoản bị loại theo quy tắc (để đối chiếu với consumer đang đếm sai). */
  excludedPersonal: number;
  excludedNotApproved: number;
  excludedLoanPrincipal: number;
  /** Chi phí cố định tháng (fixed_costs đang active). */
  fixedMonthly: number;
};

export async function engineCashOut(from: string, to: string): Promise<EngineCashOut> {
  const base = `FROM expenses WHERE expense_date >= $1::date AND expense_date <= $2::date`;
  const [studio, personal, notApproved, loan, fixed] = await Promise.all([
    num(
      `SELECT COALESCE(SUM(amount::numeric),0) AS v ${base}
        AND status IN ('approved','paid')
        AND COALESCE(cost_class,'') NOT IN ('personal','loan_principal')`,
      [from, to],
    ),
    num(
      `SELECT COALESCE(SUM(amount::numeric),0) AS v ${base}
        AND status IN ('approved','paid') AND COALESCE(cost_class,'') = 'personal'`,
      [from, to],
    ),
    num(
      `SELECT COALESCE(SUM(amount::numeric),0) AS v ${base}
        AND status NOT IN ('approved','paid')`,
      [from, to],
    ),
    num(
      `SELECT COALESCE(SUM(amount::numeric),0) AS v ${base}
        AND status IN ('approved','paid') AND COALESCE(cost_class,'') = 'loan_principal'`,
      [from, to],
    ),
    num(`SELECT COALESCE(SUM(amount::numeric),0) AS v FROM fixed_costs WHERE active = true`),
  ]);
  return {
    studioExpense: studio,
    excludedPersonal: personal,
    excludedNotApproved: notApproved,
    excludedLoanPrincipal: loan,
    fixedMonthly: fixed,
  };
}

// ─── Lương/cast theo show (quy tắc ④) — v1 cho Truth Test, GĐ1d tinh chỉnh ─────

export async function engineLaborCost(from: string, to: string): Promise<number> {
  // staff_job_earnings: rate = tiền công per show (GIÁ TAY PR #55); loại voided;
  // chỉ tính earning gắn đơn hợp lệ. Bucket theo earned_date.
  return num(
    `SELECT COALESCE(SUM(e.rate::numeric), 0) AS v
     FROM staff_job_earnings e
     JOIN bookings b ON b.id = e.booking_id
     WHERE COALESCE(e.status,'') != 'voided'
       AND e.earned_date >= $1::date AND e.earned_date <= $2::date
       AND ${revenueCountableSql("b")}`,
    [from, to],
  );
}

// ─── Toàn vẹn dữ liệu gốc: phiếu thu ↔ phân bổ paid_amount theo GIA ĐÌNH đơn ───

export type FamilyCashDrift = {
  familyRootId: number;
  paidColumnSum: number;
  rawPaymentsSum: number;
  drift: number;
};

/**
 * Với mỗi "gia đình" đơn (đơn lẻ, hoặc cha + toàn bộ con): Σ paid_amount của các
 * đơn SỐNG phải bằng Σ phiếu thu hợp lệ ghi trên bất kỳ thành viên nào. Lệch =
 * phân bổ hỏng (double-count / mất tiền khi xóa con...) — lỗi DỮ LIỆU phải xử lý.
 */
export async function engineFamilyCashDrift(limit = 200): Promise<FamilyCashDrift[]> {
  const r = await pool.query(
    `WITH fam AS (
       SELECT b.id, COALESCE(b.parent_id, b.id) AS root_id, b.paid_amount, b.deleted_at, b.status,
              b.is_parent_contract
       FROM bookings b
     ), live AS (
       -- paid_amount cộng trên MỌI thành viên SỐNG của gia đình, KỂ CẢ đơn cha
       -- (tiền hợp đồng nhiều dịch vụ hợp lệ nằm ở cha — xem customer-aggregate).
       SELECT root_id,
              SUM(CASE WHEN deleted_at IS NULL AND COALESCE(status,'') NOT IN ('cancelled','temp_quote')
                       THEN COALESCE(paid_amount,0) ELSE 0 END) AS paid_col
       FROM fam GROUP BY root_id
     ), cash AS (
       SELECT COALESCE(b.parent_id, b.id) AS root_id, SUM(p.amount::numeric) AS pay_sum
       FROM payments p JOIN bookings b ON b.id = p.booking_id
       WHERE COALESCE(p.status,'active') != 'voided' AND COALESCE(p.payment_type,'') != 'refund'
       GROUP BY COALESCE(b.parent_id, b.id)
     )
     SELECT l.root_id, COALESCE(l.paid_col,0) AS paid_col, COALESCE(c.pay_sum,0) AS pay_sum
     FROM live l FULL OUTER JOIN cash c ON c.root_id = l.root_id
     WHERE COALESCE(l.paid_col,0) <> COALESCE(c.pay_sum,0)
     ORDER BY ABS(COALESCE(l.paid_col,0) - COALESCE(c.pay_sum,0)) DESC
     LIMIT $1`,
    [limit],
  );
  return (r.rows as Array<{ root_id: number; paid_col: string; pay_sum: string }>).map(x => ({
    familyRootId: Number(x.root_id),
    paidColumnSum: Number(x.paid_col),
    rawPaymentsSum: Number(x.pay_sum),
    drift: Number(x.paid_col) - Number(x.pay_sum),
  }));
}

// ─── GĐ1b-2: CAST theo show từ SỔ staff_job_earnings (quy tắc ④ + chốt 14/07) ──
// Nguồn cast DUY NHẤT của Revenue/Profit. KHÔNG dùng tasks.cost. KHÔNG cộng thêm
// payroll đã thanh toán (payroll chỉ là kỳ THANH TOÁN nghĩa vụ đã ghi nhận) và
// KHÔNG cộng salary advance (ứng = dòng tiền, không phải chi phí mới). Lương CỨNG
// nằm riêng ở fixed_costs — hai loại chi phí độc lập, nhân viên có cả hai chính
// sách thì lợi nhuận trừ CẢ HAI. Không suy luận theo chức danh: chỉ tính khi có
// earning hợp lệ trong sổ.

export type LaborCoverage = {
  earningCount: number;
  bookingCountWithEarnings: number;
  eligibleBookingCount: number;
  status: "partial" | "full";
};

export type EngineLaborMeta = {
  laborSource: "staff_job_earnings";
  /** Hoa hồng sale runtime CHƯA được ghi sổ → chưa nằm trong lợi nhuận (GĐ1b-3). */
  salesCommissionIncluded: false;
  laborCoverage: LaborCoverage;
  notes: string[];
};

export const LABOR_COVERAGE_NOTE =
  "Lợi nhuận hiện được tính theo các khoản cast đã ghi nhận trong hệ thống; một số show cũ chưa có dữ liệu cast nên lợi nhuận có thể đang cao hơn thực tế.";
export const SALES_COMMISSION_NOTE = "Chưa bao gồm hoa hồng sale chưa được ghi sổ.";

const EARNING_VALID = `COALESCE(e.status, '') NOT IN ('voided', 'cancelled')`;

/** Map bookingId → tổng cast từ sổ earnings hợp lệ (mỗi earning tính ĐÚNG MỘT lần). */
export async function engineCastLedger(): Promise<{
  castByBooking: Map<number, number>;
  meta: EngineLaborMeta;
}> {
  const r = await pool.query(
    `SELECT e.booking_id AS bid, SUM(e.rate::numeric) AS cast_total, COUNT(*) AS cnt
     FROM staff_job_earnings e
     JOIN bookings b ON b.id = e.booking_id
     WHERE ${EARNING_VALID} AND ${revenueCountableSql("b")}
     GROUP BY e.booking_id`,
  );
  const castByBooking = new Map<number, number>();
  let earningCount = 0;
  for (const row of r.rows as Array<{ bid: number; cast_total: string; cnt: string }>) {
    castByBooking.set(Number(row.bid), Number(row.cast_total));
    earningCount += Number(row.cnt);
  }
  const eligible = await num(
    `SELECT COUNT(*) AS v FROM bookings b WHERE ${revenueCountableSql("b")}`,
  );
  const coverage: LaborCoverage = {
    earningCount,
    bookingCountWithEarnings: castByBooking.size,
    eligibleBookingCount: eligible,
    status: castByBooking.size >= eligible && eligible > 0 ? "full" : "partial",
  };
  return {
    castByBooking,
    meta: {
      laborSource: "staff_job_earnings",
      salesCommissionIncluded: false,
      laborCoverage: coverage,
      notes:
        coverage.status === "partial"
          ? [LABOR_COVERAGE_NOTE, SALES_COMMISSION_NOTE]
          : [SALES_COMMISSION_NOTE],
    },
  };
}

/**
 * Tổng cast của cohort đơn TẠO trong kỳ (gán theo BOOKING BUCKET — quyết định
 * GĐ1b-2 mục 3, đồng bộ mô hình accrual màn Revenue; KHÔNG gán theo earned_date).
 */
export async function engineCastForCreatedCohort(from: string, to: string): Promise<number> {
  return num(
    `SELECT COALESCE(SUM(e.rate::numeric), 0) AS v
     FROM staff_job_earnings e
     JOIN bookings b ON b.id = e.booking_id
     WHERE ${EARNING_VALID} AND ${revenueCountableSql("b")}
       AND (b.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
           BETWEEN $1::date AND $2::date`,
    [from, to],
  );
}

// ─── GĐ1e-1: READ MODEL cho Business Engine (chủ duyệt 15/07) ──────────────────
// Business Engine KHÔNG được SQL — mọi con số đi qua 3 hàm read dưới đây.
// Quy tắc giữ nguyên: countable chuẩn ①, cast từ sổ earnings ④ (không tasks.cost),
// expense chỉ approved/paid ③ không personal/loan ②, không payroll/advance.

export type OverdueReceivable = {
  bookingId: number;
  bookingCode: string | null;
  customerId: number | null;
  customerName: string | null;
  /** Ngày thực hiện CUỐI CÙNG (shoot_date hoặc occurrence muộn nhất). */
  lastPerformanceDate: string;
  daysOverdue: number;
  receivable: number;
};

/**
 * Đơn hợp lệ đã DIỄN RA XONG (ngày thực hiện cuối < hôm nay VN) mà còn công nợ.
 * Multi-occurrence: lấy MAX(ngày) — mỗi booking đúng MỘT dòng, không double-count.
 */
export async function engineOverdueReceivables(limit = 100): Promise<OverdueReceivable[]> {
  const hasOcc = (await getSchemaFlags()).occurrences;
  const lastPerf = hasOcc
    ? `GREATEST(b.shoot_date, COALESCE((SELECT MAX(oc.shoot_date) FROM booking_occurrences oc WHERE oc.booking_id = b.id), b.shoot_date))`
    : `b.shoot_date`;
  const r = await pool.query(
    `SELECT b.id, b.order_code, b.customer_id, c.name AS customer_name,
            ${lastPerf} AS last_perf,
            ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - ${lastPerf}) AS days_overdue,
            ${ENGINE_DEBT_SQL} AS receivable
     FROM bookings b
     LEFT JOIN customers c ON c.id = b.customer_id
     WHERE ${revenueCountableSql("b")}
       AND b.shoot_date IS NOT NULL
       AND ${lastPerf} < (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
       AND ${ENGINE_DEBT_SQL} > 0
     ORDER BY receivable DESC, days_overdue DESC
     LIMIT $1`,
    [limit],
  );
  return (r.rows as Array<Record<string, unknown>>).map(x => ({
    bookingId: Number(x.id),
    bookingCode: (x.order_code as string) ?? null,
    customerId: x.customer_id == null ? null : Number(x.customer_id),
    customerName: (x.customer_name as string) ?? null,
    lastPerformanceDate: String(x.last_perf).slice(0, 10),
    daysOverdue: Number(x.days_overdue),
    receivable: Number(x.receivable),
  }));
}

export type BookingFinance = {
  bookingId: number;
  bookingCode: string | null;
  customerId: number | null;
  customerName: string | null;
  service: string | null;
  shootDate: string | null;
  occurrenceDates: string[];
  netValue: number;
  paid: number;
  receivable: number;
  /** Cast từ SỔ staff_job_earnings (④) — 0 nếu chưa có khoản nào được ghi sổ. */
  laborCost: number;
  hasLaborLedger: boolean;
  /** Expense approved/paid, class direct (kể cả class NULL gắn booking theo quy ước cũ). */
  approvedDirectExpense: number;
  /** Tạm tính = net − laborCost − approvedDirectExpense (accrual). */
  estimatedProfit: number;
};

/** Sổ tài chính per-booking trên toàn tập countable (Business Engine xếp hạng từ đây). */
export async function engineBookingFinance(): Promise<BookingFinance[]> {
  const hasOcc = (await getSchemaFlags()).occurrences;
  const occSelect = hasOcc
    ? `(SELECT COALESCE(array_agg(oc.shoot_date::text ORDER BY oc.shoot_date), '{}')
        FROM booking_occurrences oc WHERE oc.booking_id = b.id)`
    : `'{}'::text[]`;
  const r = await pool.query(
    `SELECT b.id, b.order_code, b.customer_id, c.name AS customer_name,
            COALESCE(b.service_label, b.package_type, b.service_category) AS service,
            b.shoot_date, ${occSelect} AS occ_dates,
            GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0)) AS net_value,
            ${ENGINE_ALLOC_PAID_SQL} AS paid,
            ${ENGINE_DEBT_SQL} AS receivable,
            COALESCE((SELECT SUM(e.rate::numeric) FROM staff_job_earnings e
              WHERE e.booking_id = b.id
                AND COALESCE(e.status,'') NOT IN ('voided','cancelled')), 0) AS labor_cost,
            COALESCE((SELECT SUM(x.amount::numeric) FROM expenses x
              WHERE x.booking_id = b.id AND x.status IN ('approved','paid')
                AND COALESCE(x.cost_class, 'direct') = 'direct'), 0) AS direct_expense
     FROM bookings b
     LEFT JOIN customers c ON c.id = b.customer_id
     WHERE ${revenueCountableSql("b")}`,
  );
  return (r.rows as Array<Record<string, unknown>>).map(x => {
    const netValue = Number(x.net_value);
    const laborCost = Number(x.labor_cost);
    const direct = Number(x.direct_expense);
    return {
      bookingId: Number(x.id),
      bookingCode: (x.order_code as string) ?? null,
      customerId: x.customer_id == null ? null : Number(x.customer_id),
      customerName: (x.customer_name as string) ?? null,
      service: (x.service as string) ?? null,
      shootDate: x.shoot_date ? String(x.shoot_date).slice(0, 10) : null,
      occurrenceDates: (x.occ_dates as string[]) ?? [],
      netValue,
      paid: Number(x.paid),
      receivable: Number(x.receivable),
      laborCost,
      hasLaborLedger: laborCost > 0,
      approvedDirectExpense: direct,
      estimatedProfit: netValue - laborCost - direct,
    };
  });
}

export type ServiceRollup = {
  service: string;
  bookingCount: number;
  contractValue: number;
  collected: number;
  receivable: number;
  laborRecognized: number;
  approvedDirectExpense: number;
  /** Tạm tính = contractValue − labor − direct (accrual, coverage partial). */
  estimatedProfit: number;
  bookingsWithLaborLedger: number;
};

/** Gộp tài chính theo DỊCH VỤ (khóa gộp: service_category — chú thích ở caveats tầng business). */
export async function engineServiceRollup(): Promise<ServiceRollup[]> {
  const r = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(b.service_category), ''), 'khac') AS service,
            COUNT(*)::int AS booking_count,
            COALESCE(SUM(GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0))), 0) AS contract_value,
            COALESCE(SUM(${ENGINE_ALLOC_PAID_SQL}), 0) AS collected,
            COALESCE(SUM(${ENGINE_DEBT_SQL}), 0) AS receivable,
            COALESCE(SUM((SELECT COALESCE(SUM(e.rate::numeric), 0) FROM staff_job_earnings e
              WHERE e.booking_id = b.id
                AND COALESCE(e.status,'') NOT IN ('voided','cancelled'))), 0) AS labor,
            COALESCE(SUM((SELECT COALESCE(SUM(x.amount::numeric), 0) FROM expenses x
              WHERE x.booking_id = b.id AND x.status IN ('approved','paid')
                AND COALESCE(x.cost_class, 'direct') = 'direct')), 0) AS direct_expense,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM staff_job_earnings e
              WHERE e.booking_id = b.id
                AND COALESCE(e.status,'') NOT IN ('voided','cancelled')))::int AS with_labor
     FROM bookings b
     WHERE ${revenueCountableSql("b")}
     GROUP BY COALESCE(NULLIF(TRIM(b.service_category), ''), 'khac')`,
  );
  return (r.rows as Array<Record<string, unknown>>).map(x => {
    const contractValue = Number(x.contract_value);
    const labor = Number(x.labor);
    const direct = Number(x.direct_expense);
    return {
      service: String(x.service),
      bookingCount: Number(x.booking_count),
      contractValue,
      collected: Number(x.collected),
      receivable: Number(x.receivable),
      laborRecognized: labor,
      approvedDirectExpense: direct,
      estimatedProfit: contractValue - labor - direct,
      bookingsWithLaborLedger: Number(x.with_labor),
    };
  });
}

// ─── GĐ1e-2: READ cho Copilot (chủ duyệt 15/07) ────────────────────────────────
// Copilot KHÔNG được tự SQL tài chính nữa — 4 hàm dưới đây là nơi DUY NHẤT tính
// các số Copilot cần, cùng quy tắc tiền với phần trên (countable ①, phiếu thu hợp
// lệ, nợ sống ①). Mọi số Copilot đọc ra vì thế bằng ĐÚNG số Engine/Dashboard.

export type MonthlyRevenueActivity = {
  /** Tiền thực thu trong kỳ (payment_date scope) — CÙNG cửa sổ & lọc với Dashboard. */
  collected: number;
  /** Số phiếu thu hợp lệ trong kỳ (cùng lớp lọc collected). */
  paymentCount: number;
  /** Số đơn hợp lệ có ngày chụp trong kỳ (shoot_date scope — chỉ số vận hành). */
  bookingCount: number;
};

/**
 * Bộ số cho câu "doanh thu tháng này" của Copilot. `collected` = engineCashIn nên
 * KHỚP TỪNG ĐỒNG với màn Tổng quan tài chính (getSimpleFinance) và Truth Test.
 */
export async function engineMonthlyRevenueActivity(
  from: string,
  to: string,
): Promise<MonthlyRevenueActivity> {
  const [collected, paymentCount, bookingCount] = await Promise.all([
    engineCashIn(from, to),
    num(
      `SELECT COUNT(*) AS v FROM payments
       WHERE paid_at >= $1::date AND paid_at < ($2::date + INTERVAL '1 day')
         AND ${collectedPaymentCond("payments")}`,
      [from, to],
    ),
    num(
      `SELECT COUNT(*) AS v FROM bookings b
       WHERE b.shoot_date >= $1::date AND b.shoot_date <= $2::date AND ${revenueCountableSql("b")}`,
      [from, to],
    ),
  ]);
  return { collected, paymentCount, bookingCount };
}

export type ServicePerformanceRow = {
  packageName: string;
  bookingCount: number;
  /** Doanh thu gói = Σ total_amount (giá trị hợp đồng gộp) của đơn hợp lệ chụp trong kỳ. */
  revenue: number;
};

/** "Gói bán chạy tháng này": gom theo tên gói (fallback package_type), xếp theo số đơn. */
export async function engineServicePerformance(
  from: string,
  to: string,
  limit = 10,
): Promise<ServicePerformanceRow[]> {
  const r = await pool.query(
    `SELECT COALESCE(sp.name, b.package_type, 'Khác') AS package_name,
            COUNT(b.id) AS booking_count,
            COALESCE(SUM(CAST(b.total_amount AS numeric)), 0) AS revenue
     FROM bookings b
     LEFT JOIN service_packages sp ON sp.id = b.service_package_id
     WHERE b.shoot_date >= $1::date AND b.shoot_date <= $2::date
       AND ${revenueCountableSql("b")}
     GROUP BY COALESCE(sp.name, b.package_type, 'Khác')
     ORDER BY booking_count DESC
     LIMIT $3`,
    [from, to, limit],
  );
  return (r.rows as Array<Record<string, unknown>>).map(x => ({
    packageName: String(x.package_name),
    bookingCount: Number(x.booking_count),
    revenue: Number(x.revenue),
  }));
}

export type UnpaidCustomerRow = { name: string | null; phone: string | null; debt: number };
export type UnpaidCustomers = {
  /** Khách còn nợ > 0, xếp theo nợ giảm dần (đã LIMIT). */
  customers: UnpaidCustomerRow[];
  /** Tổng nợ sống (quy tắc ①) trên phạm vi — khớp engineSystemDebt khi không giới hạn kỳ. */
  totalDebt: number;
  /** Số đơn còn nợ > 0 trên phạm vi. */
  orderCount: number;
};

/**
 * Danh sách khách còn nợ + tổng, cùng predicate countable & nợ sống ① với engineSystemDebt.
 * @param range giới hạn "đơn thuộc kỳ": shoot_date HOẶC occurrence trong kỳ (chung
 *  monthMembershipSql với màn Doanh thu — GĐ1b-1). Bỏ range = nợ tồn toàn hệ thống.
 */
export async function engineUnpaidCustomers(
  limit = 15,
  range?: { start: string; end: string },
): Promise<UnpaidCustomers> {
  const hasOcc = range ? (await getSchemaFlags()).occurrences : false;
  const rangeCond = range ? ` AND ${monthMembershipSql("$2", "$3", hasOcc)}` : "";
  const listR = await pool.query(
    `SELECT c.name, c.phone, SUM(${ENGINE_DEBT_SQL}) AS debt
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     WHERE ${revenueCountableSql("b")}${rangeCond}
     GROUP BY c.id, c.name, c.phone
     HAVING SUM(${ENGINE_DEBT_SQL}) > 0
     ORDER BY debt DESC
     LIMIT $1`,
    range ? [limit, range.start, range.end] : [limit],
  );
  const customers = (listR.rows as Array<Record<string, unknown>>).map(d => ({
    name: (d.name as string) ?? null,
    phone: (d.phone as string) ?? null,
    debt: Number(d.debt),
  }));
  const totalR = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ${ENGINE_DEBT_SQL} > 0) AS order_cnt,
            COALESCE(SUM(${ENGINE_DEBT_SQL}), 0) AS total_debt
     FROM bookings b
     WHERE ${revenueCountableSql("b")}${range ? ` AND ${monthMembershipSql("$1", "$2", hasOcc)}` : ""}`,
    range ? [range.start, range.end] : [],
  );
  const totalRow = totalR.rows[0] as Record<string, unknown> | undefined;
  return {
    customers,
    totalDebt: Number(totalRow?.total_debt ?? 0),
    orderCount: Number(totalRow?.order_cnt ?? 0),
  };
}

export type CustomerByPhone = {
  name: string | null;
  phone: string | null;
  bookingCount: number;
  debt: number;
};

/** Tra khách theo đuôi SĐT + nợ sống ① (Copilot dùng cho intent customer). */
export async function engineCustomersByPhone(
  phoneSuffix: string,
  limit = 5,
): Promise<CustomerByPhone[]> {
  const r = await pool.query(
    `SELECT c.name, c.phone,
            COUNT(b.id) AS booking_count,
            COALESCE(SUM(${ENGINE_DEBT_SQL}), 0) AS debt
     FROM customers c
     LEFT JOIN bookings b ON b.customer_id = c.id AND ${revenueCountableSql("b")}
     WHERE c.phone LIKE $1
     GROUP BY c.id, c.name, c.phone
     LIMIT $2`,
    [`%${phoneSuffix}%`, limit],
  );
  return (r.rows as Array<Record<string, unknown>>).map(c => ({
    name: (c.name as string) ?? null,
    phone: (c.phone as string) ?? null,
    bookingCount: Number(c.booking_count),
    debt: Number(c.debt),
  }));
}
