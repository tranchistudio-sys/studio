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
 * sang gọi engine. Ghi chú paid: cột bookings.paid_amount là KẾT QUẢ PHÂN BỔ phiếu
 * thu của hệ thống (tiền hợp đồng cha–con ghi ở cha rồi phân bổ) — engine dùng nó
 * cho công nợ per-booking (quy tắc ①) và VERIFY tính toàn vẹn ở mức GIA ĐÌNH đơn
 * bằng engineFamilyCashDrift (Σ phiếu thu gốc = Σ paid_amount phân bổ).
 */
import { pool } from "@workspace/db";
import { revenueCountableSql } from "../booking-money";
import { paymentNotOnEmptyParentSql } from "../parent-contract";
import { getSchemaFlags } from "../schema-compat";

/** Quy tắc ①: nợ sống per-booking. */
export const ENGINE_DEBT_SQL =
  "GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0))";

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
  /** Đã trả = Σ paid_amount PHÂN BỔ trên các đơn countable. Tiền còn treo ở đơn
   *  CHA chưa phân bổ xuống dịch vụ con sẽ KHÔNG hiện ở đây — chủ đích, để lộ
   *  data cần làm sạch (xem engineFamilyCashDrift). */
  totalPaid: number;
  /** Còn nợ = quy tắc ①: Σ GREATEST(0, net − paid) per-booking. */
  totalDebt: number;
};

const CUSTOMER_FINANCE_SELECT = `
  COUNT(*)::int AS cnt,
  COALESCE(SUM(GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0))), 0) AS owed,
  COALESCE(SUM(COALESCE(b.paid_amount, 0)), 0) AS paid,
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
            COALESCE(b.paid_amount, 0) AS paid,
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
            COALESCE(SUM(COALESCE(b.paid_amount, 0)), 0) AS collected,
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
