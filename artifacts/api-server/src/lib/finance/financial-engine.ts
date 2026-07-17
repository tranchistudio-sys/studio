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
 * FAMILY CASH ALLOCATION — chốt nghiệp vụ 17/07 (thay pro-rata PR #102): engine
 * KHÔNG tin cột bookings.paid_amount; "đã thu" mỗi booking PHÂN BỔ LIVE từ
 * payments GỐC qua allocator DUY NHẤT allocateFamilies() (booking-money.ts):
 *
 *   1. Cọc CANONICAL (phiếu 'deposit' cũ nhất trên booking gốc — do ô "Tiền cọc"
 *      quản lý) chia ĐỀU cho N dịch vụ countable; đồng dư theo booking ID tăng
 *      dần; cap ≤ NET, phần vượt chia lại dịch vụ còn nợ (water-filling).
 *   2. Phiếu gắn thẳng dịch vụ = thu riêng dịch vụ đó (gồm cọc legacy trên con).
 *   3. Thu thêm trên CHA + phiếu trên thành viên không-countable + tiền thừa của
 *      dịch vụ đã đủ → pool FIFO theo (ngày thực hiện ASC, ID ASC).
 *   4. Dư cuối = overpayment "Khách trả dư" (không nợ âm, không mất tiền).
 *
 * Bất biến then chốt: Σ per-booking remaining = max(0, family_net − family_paid)
 * — tổng nợ per-booking (①) LUÔN bằng nợ mức gia đình mà màn Booking/Hợp đồng
 * hiển thị. Không copy dữ liệu, không sửa/tạo payment — chỉ đổi cách ĐỌC.
 * engineFamilyCashDrift giữ nguyên vai trò cảnh báo vệ sinh cột paid_amount cũ.
 */
import { pool } from "@workspace/db";
import {
  revenueCountableSql,
  allocateFamilies,
  money,
  type AllocBookingInput,
  type AllocPaymentInput,
  type FamilyAllocation,
} from "../booking-money";
import { paymentNotOnEmptyParentSql } from "../parent-contract";
import { getSchemaFlags } from "../schema-compat";

/**
 * SQL "đã thu PHÂN BỔ" của một dòng booking `alias` (correlated subquery).
 * Nguồn: bảng payments GỐC của CẢ GIA ĐÌNH đơn, pro-rata theo net từng thành viên.
 * Booking không countable (cha tổng/hủy/tạm/xóa/mồ côi) nhận 0 — nhất quán với
 * tập tính nợ; phiếu trên "cha rỗng" (không còn con hiệu lực) → không ai nhận
 * (mirror paymentNotOnEmptyParentSql: tiền treo, không tính vào Đã thu active).
 */
// ─── ALLOCATION SNAPSHOT (chốt 17/07 đêm — CHIA ĐỀU CỌC, thay pro-rata) ────────
// MỘT allocator duy nhất = allocateFamilies() trong booking-money.ts (thuần JS,
// unit test dày). Engine nạp 2 query nhẹ (bookings + payments) rồi tính JS —
// KHÔNG còn 2 bản SQL/JS song sinh có thể lệch nhau.

export type AllocatedBooking = {
  bookingId: number;
  rootId: number;
  customerId: number | null;
  orderCode: string | null;
  customerName: string | null;
  customerPhone: string | null;
  serviceLabel: string | null;
  serviceCategory: string | null;
  packageType: string | null;
  shootDate: string | null;
  net: number;
  /** Cọc chung chia ĐỀU (cap ≤ NET, water-filling). */
  equalDeposit: number;
  /** Phiếu gắn thẳng dịch vụ này (gồm cọc legacy trên con). */
  directPaid: number;
  /** Phần directPaid là phiếu 'deposit' LEGACY trên đơn con (nhãn riêng để admin rà). */
  legacyDepositPaid: number;
  directCredited: number;
  /** Phân bổ FIFO từ pool trên cha (thu thêm legacy + tiền thừa dịch vụ khác). */
  parentFifo: number;
  /** Tổng "đã thu phân bổ" = equalDeposit + directCredited + parentFifo. */
  allocPaid: number;
  /** Nợ sống quy tắc ① = max(0, net − allocPaid). */
  debt: number;
};

export type AllocationSnapshot = {
  /** CHỈ thành viên countable (đơn con hợp lệ + đơn lẻ hợp lệ). */
  members: AllocatedBooking[];
  byId: Map<number, AllocatedBooking>;
  /** Breakdown mức gia đình (totalDeposit / eligibleServiceCount / overpayment). */
  families: Map<number, FamilyAllocation>;
};

/**
 * Nạp toàn bộ bookings + payments (2 query nhẹ, ~vài trăm dòng) và chạy allocator
 * chung. Mọi hàm engine bên dưới đọc từ snapshot này — cùng MỘT thuật toán,
 * cùng MỘT thời điểm đọc dữ liệu.
 */
export async function engineAllocationSnapshot(): Promise<AllocationSnapshot> {
  // MỘT transaction REPEATABLE READ READ ONLY cho cả 2 SELECT — phiếu vừa ghi
  // giữa 2 câu không thể làm snapshot "nửa cũ nửa mới" (giữ tính chất PR #105).
  // Mock test chỉ có pool.query (không connect) → fallback đọc tuần tự thường.
  const BOOKINGS_SQL = `SELECT b.id, b.parent_id, b.is_parent_contract, b.status, b.deleted_at,
              b.total_amount, b.discount_amount, b.shoot_date::text AS shoot_date,
              b.customer_id, b.order_code, b.service_label, b.service_category, b.package_type,
              c.name AS customer_name, c.phone AS customer_phone
       FROM bookings b
       LEFT JOIN customers c ON c.id = b.customer_id`;
  const PAYMENTS_SQL = `SELECT id, booking_id, amount, payment_type, status FROM payments`;
  let bkR: { rows: unknown[] };
  let payR: { rows: unknown[] };
  const canTx = typeof (pool as unknown as { connect?: unknown }).connect === "function";
  if (canTx) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      bkR = await client.query(BOOKINGS_SQL);
      payR = await client.query(PAYMENTS_SQL);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } else {
    bkR = await pool.query(BOOKINGS_SQL);
    payR = await pool.query(PAYMENTS_SQL);
  }
  type BkRow = {
    id: number; parent_id: number | null; is_parent_contract: boolean | null;
    status: string | null; deleted_at: string | null;
    total_amount: string | null; discount_amount: string | null; shoot_date: string | null;
    customer_id: number | null; order_code: string | null; service_label: string | null;
    service_category: string | null; package_type: string | null;
    customer_name: string | null; customer_phone: string | null;
  };
  const bkRows = bkR.rows as BkRow[];
  const allocBookings: (AllocBookingInput & { row: BkRow })[] = bkRows.map(r => ({
    id: Number(r.id),
    parentId: r.parent_id == null ? null : Number(r.parent_id),
    isParentContract: !!r.is_parent_contract,
    status: r.status,
    deletedAt: r.deleted_at,
    totalAmount: r.total_amount,
    discountAmount: r.discount_amount,
    shootDate: r.shoot_date,
    row: r,
  }));
  const allocPayments: AllocPaymentInput[] = (payR.rows as Array<{
    id: number; booking_id: number | null; amount: string; payment_type: string | null; status: string | null;
  }>).map(p => ({
    id: Number(p.id),
    bookingId: p.booking_id == null ? null : Number(p.booking_id),
    amount: p.amount,
    paymentType: p.payment_type,
    status: p.status,
  }));

  const families = allocateFamilies(allocBookings, allocPayments);
  const rowById = new Map(allocBookings.map(b => [b.id, b.row]));
  const members: AllocatedBooking[] = [];
  for (const fam of families.values()) {
    for (const m of fam.members) {
      const r = rowById.get(m.bookingId);
      if (!r) continue;
      members.push({
        bookingId: m.bookingId,
        rootId: fam.rootId,
        customerId: r.customer_id == null ? null : Number(r.customer_id),
        orderCode: r.order_code,
        customerName: r.customer_name,
        customerPhone: r.customer_phone,
        serviceLabel: r.service_label,
        serviceCategory: r.service_category,
        packageType: r.package_type,
        shootDate: r.shoot_date ? String(r.shoot_date).slice(0, 10) : null,
        net: m.net,
        equalDeposit: m.equalDeposit,
        directPaid: m.directPaid,
        legacyDepositPaid: m.legacyDepositPaid,
        directCredited: m.directCredited,
        parentFifo: m.parentFifo,
        allocPaid: m.allocated,
        debt: m.remaining,
      });
    }
  }
  return { members, byId: new Map(members.map(m => [m.bookingId, m])), families };
}

/** Σ nợ của một tập member id (id không có trong snapshot đóng góp 0). */
function sumDebt(snap: AllocationSnapshot, ids?: Set<number>): number {
  let s = 0;
  for (const m of snap.members) {
    if (ids && !ids.has(m.bookingId)) continue;
    s += m.debt;
  }
  return s;
}

/** Id các đơn countable thỏa điều kiện SQL bổ sung (membership kỳ, khách...). */
async function countableIdsWhere(cond: string, params: unknown[]): Promise<Set<number>> {
  const r = await pool.query(
    `SELECT b.id FROM bookings b WHERE ${revenueCountableSql("b")}${cond ? ` AND ${cond}` : ""}`,
    params,
  );
  return new Set((r.rows as Array<{ id: number }>).map(x => Number(x.id)));
}

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
export async function engineReceivableForRange(
  from: string,
  to: string,
  reuseSnap?: AllocationSnapshot,
): Promise<number> {
  const hasOcc = (await getSchemaFlags()).occurrences;
  const [snap, ids] = await Promise.all([
    reuseSnap ?? engineAllocationSnapshot(),
    countableIdsWhere(monthMembershipSql("$1", "$2", hasOcc), [from, to]),
  ]);
  return sumDebt(snap, ids);
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
  /** Breakdown chia đều (chốt 17/07) — cho bảng bằng chứng 6 dòng. */
  equalDeposit: number;
  directPaid: number;
  legacyDepositPaid: number;
  parentFifo: number;
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
  // rows và total lấy từ CÙNG một snapshot allocator (một lần đọc dữ liệu) —
  // không thể lệch giả do ghi đồng thời giữa hai query rời (giữ tính chất PR #105).
  const [snap, ids] = await Promise.all([
    engineAllocationSnapshot(),
    countableIdsWhere(monthMembershipSql("$1", "$2", hasOcc), [from, to]),
  ]);
  const inRange = snap.members.filter(m => ids.has(m.bookingId));
  const rows = inRange
    .filter(m => m.debt > 0)
    .sort((a, b) => {
      const ka = a.shootDate ?? "9999-12-31";
      const kb = b.shootDate ?? "9999-12-31";
      return ka < kb ? -1 : ka > kb ? 1 : a.bookingId - b.bookingId;
    })
    .map(m => ({
      bookingId: m.bookingId,
      orderCode: m.orderCode,
      customerName: m.customerName,
      serviceLabel: m.serviceLabel,
      shootDate: m.shootDate,
      net: m.net,
      allocPaid: m.allocPaid,
      debt: m.debt,
      equalDeposit: m.equalDeposit,
      directPaid: m.directPaid,
      legacyDepositPaid: m.legacyDepositPaid,
      parentFifo: m.parentFifo,
    }));
  return { rows, total: inRange.reduce((s, m) => s + m.debt, 0) };
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
  return sumDebt(await engineAllocationSnapshot());
}

export async function engineCustomerDebt(customerId: number): Promise<number> {
  const snap = await engineAllocationSnapshot();
  return snap.members.reduce((s, m) => (m.customerId === customerId ? s + m.debt : s), 0);
}

export type CustomerFinance = {
  /** Số show = số đơn countable (đơn con + đơn lẻ hợp lệ). */
  totalBookings: number;
  /** Tổng phải thu = Σ NET per-booking (tổng − giảm giá, không âm). */
  totalOwed: number;
  /** Đã trả = Σ tiền ĐƯỢC TÍNH vào các dịch vụ (chốt 17/07: cọc chia đều + thu
   *  trực tiếp + FIFO, cap tại NET từng dịch vụ) — tiền ghi ở đơn CHA tự chảy
   *  xuống dịch vụ con. */
  totalPaid: number;
  /** Còn nợ = quy tắc ①: Σ GREATEST(0, net − paid) per-booking. */
  totalDebt: number;
  /** "Khách trả dư" = Σ overpayment các gia đình của khách — tiền thật vượt tổng
   *  hợp đồng, KHÔNG mất, không tạo nợ âm (chốt 17/07). */
  totalOverpaid: number;
};

function customerFinanceFromSnapshot(snap: AllocationSnapshot): Map<number, CustomerFinance> {
  const map = new Map<number, CustomerFinance>();
  const entry = (cid: number): CustomerFinance => {
    const cur = map.get(cid) ?? { totalBookings: 0, totalOwed: 0, totalPaid: 0, totalDebt: 0, totalOverpaid: 0 };
    map.set(cid, cur);
    return cur;
  };
  for (const m of snap.members) {
    if (m.customerId == null) continue;
    const cur = entry(m.customerId);
    cur.totalBookings += 1;
    cur.totalOwed += m.net;
    cur.totalPaid += m.allocPaid;
    cur.totalDebt += m.debt;
  }
  // "Khách trả dư" theo gia đình — gán cho khách của các dịch vụ trong gia đình.
  for (const fam of snap.families.values()) {
    if (fam.overpayment <= 0 || fam.members.length === 0) continue;
    const first = snap.byId.get(fam.members[0]!.bookingId);
    if (first?.customerId == null) continue;
    entry(first.customerId).totalOverpaid += fam.overpayment;
  }
  return map;
}

/** Bộ số tài chính hồ sơ MỘT khách (màn Khách hàng chi tiết dùng). */
export async function engineCustomerFinance(customerId: number): Promise<CustomerFinance> {
  const snap = await engineAllocationSnapshot();
  return (
    customerFinanceFromSnapshot(snap).get(customerId) ?? {
      totalBookings: 0, totalOwed: 0, totalPaid: 0, totalDebt: 0, totalOverpaid: 0,
    }
  );
}

/** Bộ số tài chính TOÀN BỘ khách từ MỘT snapshot allocator (màn danh sách Khách hàng dùng). */
export async function engineAllCustomersFinance(): Promise<Map<number, CustomerFinance>> {
  return customerFinanceFromSnapshot(await engineAllocationSnapshot());
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
  const [snap, perfR] = await Promise.all([
    engineAllocationSnapshot(),
    pool.query(
      `SELECT b.id, ${lastPerf} AS last_perf,
              ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - ${lastPerf}) AS days_overdue
       FROM bookings b
       WHERE ${revenueCountableSql("b")}
         AND b.shoot_date IS NOT NULL
         AND ${lastPerf} < (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`,
    ),
  ]);
  const out: OverdueReceivable[] = [];
  for (const x of perfR.rows as Array<{ id: number; last_perf: unknown; days_overdue: number }>) {
    const m = snap.byId.get(Number(x.id));
    if (!m || m.debt <= 0) continue;
    out.push({
      bookingId: m.bookingId,
      bookingCode: m.orderCode,
      customerId: m.customerId,
      customerName: m.customerName,
      lastPerformanceDate: String(x.last_perf).slice(0, 10),
      daysOverdue: Number(x.days_overdue),
      receivable: m.debt,
    });
  }
  out.sort((a, b) => b.receivable - a.receivable || b.daysOverdue - a.daysOverdue);
  return out.slice(0, limit);
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
  const [snap, r] = await Promise.all([
    engineAllocationSnapshot(),
    pool.query(
      `SELECT b.id, b.shoot_date, ${occSelect} AS occ_dates,
              COALESCE((SELECT SUM(e.rate::numeric) FROM staff_job_earnings e
                WHERE e.booking_id = b.id
                  AND COALESCE(e.status,'') NOT IN ('voided','cancelled')), 0) AS labor_cost,
              COALESCE((SELECT SUM(x.amount::numeric) FROM expenses x
                WHERE x.booking_id = b.id AND x.status IN ('approved','paid')
                  AND COALESCE(x.cost_class, 'direct') = 'direct'), 0) AS direct_expense
       FROM bookings b
       WHERE ${revenueCountableSql("b")}`,
    ),
  ]);
  const extra = new Map(
    (r.rows as Array<Record<string, unknown>>).map(x => [Number(x.id), x]),
  );
  return snap.members.map(m => {
    const x = extra.get(m.bookingId);
    const laborCost = Number(x?.labor_cost ?? 0);
    const direct = Number(x?.direct_expense ?? 0);
    return {
      bookingId: m.bookingId,
      bookingCode: m.orderCode,
      customerId: m.customerId,
      customerName: m.customerName,
      service: m.serviceLabel ?? m.packageType ?? m.serviceCategory,
      shootDate: m.shootDate,
      occurrenceDates: (x?.occ_dates as string[]) ?? [],
      netValue: m.net,
      paid: m.allocPaid,
      receivable: m.debt,
      laborCost,
      hasLaborLedger: laborCost > 0,
      approvedDirectExpense: direct,
      estimatedProfit: m.net - laborCost - direct,
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
  const [snap, r] = await Promise.all([
    engineAllocationSnapshot(),
    pool.query(
      `SELECT b.id,
              COALESCE((SELECT COALESCE(SUM(e.rate::numeric), 0) FROM staff_job_earnings e
                WHERE e.booking_id = b.id
                  AND COALESCE(e.status,'') NOT IN ('voided','cancelled')), 0) AS labor,
              COALESCE((SELECT COALESCE(SUM(x.amount::numeric), 0) FROM expenses x
                WHERE x.booking_id = b.id AND x.status IN ('approved','paid')
                  AND COALESCE(x.cost_class, 'direct') = 'direct'), 0) AS direct_expense
       FROM bookings b
       WHERE ${revenueCountableSql("b")}`,
    ),
  ]);
  const extra = new Map(
    (r.rows as Array<{ id: number; labor: string; direct_expense: string }>).map(x => [Number(x.id), x]),
  );
  const byService = new Map<string, ServiceRollup>();
  for (const m of snap.members) {
    const service = (m.serviceCategory ?? "").trim() || "khac";
    const cur = byService.get(service) ?? {
      service, bookingCount: 0, contractValue: 0, collected: 0, receivable: 0,
      laborRecognized: 0, approvedDirectExpense: 0, estimatedProfit: 0, bookingsWithLaborLedger: 0,
    };
    const x = extra.get(m.bookingId);
    const labor = Number(x?.labor ?? 0);
    const direct = Number(x?.direct_expense ?? 0);
    cur.bookingCount += 1;
    cur.contractValue += m.net;
    cur.collected += m.allocPaid;
    cur.receivable += m.debt;
    cur.laborRecognized += labor;
    cur.approvedDirectExpense += direct;
    if (labor > 0) cur.bookingsWithLaborLedger += 1;
    byService.set(service, cur);
  }
  for (const s of byService.values()) {
    s.estimatedProfit = s.contractValue - s.laborRecognized - s.approvedDirectExpense;
  }
  return [...byService.values()];
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
  const [snap, rangeIds] = await Promise.all([
    engineAllocationSnapshot(),
    range
      ? countableIdsWhere(monthMembershipSql("$1", "$2", hasOcc), [range.start, range.end])
      : Promise.resolve<Set<number> | undefined>(undefined),
  ]);
  const byCustomer = new Map<number, { name: string | null; phone: string | null; debt: number }>();
  let totalDebt = 0;
  let orderCount = 0;
  for (const m of snap.members) {
    if (rangeIds && !rangeIds.has(m.bookingId)) continue;
    totalDebt += m.debt;
    if (m.debt > 0) orderCount += 1;
    if (m.customerId == null) continue;
    const cur = byCustomer.get(m.customerId) ?? { name: m.customerName, phone: m.customerPhone, debt: 0 };
    cur.debt += m.debt;
    byCustomer.set(m.customerId, cur);
  }
  const customers = [...byCustomer.values()]
    .filter(c => c.debt > 0)
    .sort((a, b) => b.debt - a.debt)
    .slice(0, limit);
  return { customers, totalDebt, orderCount };
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
  const [snap, custR] = await Promise.all([
    engineAllocationSnapshot(),
    pool.query(
      `SELECT c.id, c.name, c.phone FROM customers c WHERE c.phone LIKE $1 LIMIT $2`,
      [`%${phoneSuffix}%`, limit],
    ),
  ]);
  const perCustomer = new Map<number, { bookingCount: number; debt: number }>();
  for (const m of snap.members) {
    if (m.customerId == null) continue;
    const cur = perCustomer.get(m.customerId) ?? { bookingCount: 0, debt: 0 };
    cur.bookingCount += 1;
    cur.debt += m.debt;
    perCustomer.set(m.customerId, cur);
  }
  return (custR.rows as Array<{ id: number; name: string | null; phone: string | null }>).map(c => ({
    name: c.name ?? null,
    phone: c.phone ?? null,
    bookingCount: perCustomer.get(Number(c.id))?.bookingCount ?? 0,
    debt: perCustomer.get(Number(c.id))?.debt ?? 0,
  }));
}
