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

/** Quy tắc ①: nợ sống per-booking. */
export const ENGINE_DEBT_SQL =
  "GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0))";

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
