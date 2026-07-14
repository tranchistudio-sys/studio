/**
 * truth-service — GĐ0 "Financial Truth Test" (chủ duyệt 14/07).
 *
 * Service này KHÔNG tính nghiệp vụ mới. Nó chỉ VERIFY: cùng một chỉ số tiền,
 * chạy qua NHIỀU đường code THẬT của hệ thống (màn Khách hàng / công thức
 * Dashboard / Copilot / booking-money) rồi so từng đồng. Lệch 1 đồng = FAIL,
 * log rõ surface nào lệch. Đây là chốt chặn của toàn bộ hệ thống tiền:
 * mọi PR về tài chính phải chạy `pnpm truth` PASS trước khi mở PR kế tiếp.
 */
import { pool } from "@workspace/db";
import { revenueCountableSql } from "../booking-money";
import { computeCustomerAggregate, type AggBooking, type AggPayment } from "../customer-aggregate";
import { computeBookingMoney } from "../booking-money";
import { getUnpaidCustomers, getRevenueSummary } from "../studio-copilot";
import { getSimpleFinance } from "../finance-summary";

export type TruthCheck = {
  metric: string;
  entity: string;
  /** Giá trị theo từng surface, vd { manKhachHang: 43299994, dashboardSql: 42799994, copilot: 42799994 }. */
  surfaces: Record<string, number>;
  pass: boolean;
  maxDiff: number;
};

export function compareSurfaces(
  metric: string,
  entity: string,
  surfaces: Record<string, number>,
): TruthCheck {
  const vals = Object.values(surfaces);
  const maxDiff = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  return { metric, entity, surfaces, pass: maxDiff === 0, maxDiff };
}

export function formatCheck(c: TruthCheck): string {
  const detail = Object.entries(c.surfaces)
    .map(([k, v]) => `${k}=${v}`)
    .join(" | ");
  return `${c.pass ? "PASS" : "FAIL"} | ${c.metric} | ${c.entity} | ${detail} | lệch=${c.maxDiff}`;
}

// Công thức nợ per-booking của Dashboard/Copilot (net − paid_amount, clamp từng đơn).
const DEBT_SQL =
  "GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0))";

// ─── Surface 1: màn Khách hàng (đường code THẬT của GET /customers/:id) ────────

async function customerScreenDebt(customerId: number): Promise<number> {
  // Route nạp TOÀN BỘ đơn của khách (kể cả đã xóa) + payments, rồi đưa qua
  // computeCustomerAggregate — tái hiện y nguyên nhưng chỉ nạp payments của
  // các đơn thuộc khách (liveIds ⊆ đơn của khách nên kết quả không đổi).
  const b = await pool.query(
    `SELECT id, total_amount AS "totalAmount", is_parent_contract AS "isParentContract",
            parent_id AS "parentId", status, deleted_at AS "deletedAt"
     FROM bookings WHERE customer_id = $1`,
    [customerId],
  );
  const bookings = b.rows as AggBooking[];
  if (!bookings.length) return 0;
  const ids = bookings.map(x => x.id);
  const p = await pool.query(
    `SELECT booking_id AS "bookingId", amount, status, payment_type AS "paymentType"
     FROM payments WHERE booking_id = ANY($1::int[])`,
    [ids],
  );
  return computeCustomerAggregate(bookings, p.rows as AggPayment[]).totalDebt;
}

// ─── Surface 2: công thức Dashboard (SQL per-booking, chuẩn PR #65) ────────────

async function dashboardSqlDebt(customerId: number): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(${DEBT_SQL}), 0) AS v
     FROM bookings b WHERE ${revenueCountableSql("b")} AND b.customer_id = $1`,
    [customerId],
  );
  return Number((r.rows[0] as { v?: string })?.v ?? 0);
}

// ─── Surface 3: Copilot — đúng dạng query GROUP BY khách của getUnpaidCustomers ─
// (tool thật trả line text theo tên+SĐT nên không tra id được; tái hiện đúng SQL
//  grouped của tool, còn TOOL THẬT được đối chiếu tổng ở verifySystemDebt.)

let copilotDebtMap: Map<string, number> | null = null;

export async function copilotDebtByCustomer(customerId: number): Promise<number> {
  if (!copilotDebtMap) {
    copilotDebtMap = new Map();
    const r = await pool.query(
      `SELECT c.id, SUM(${DEBT_SQL}) AS debt
       FROM bookings b JOIN customers c ON c.id = b.customer_id
       WHERE ${revenueCountableSql("b")}
       GROUP BY c.id HAVING SUM(${DEBT_SQL}) > 0`,
    );
    for (const row of r.rows as Array<{ id: number; debt: string }>) {
      copilotDebtMap.set(String(row.id), Number(row.debt));
    }
  }
  return copilotDebtMap.get(String(customerId)) ?? 0;
}

export function _resetTruthCache(): void {
  copilotDebtMap = null;
}

// ─── Check tổng hợp ────────────────────────────────────────────────────────────

export async function verifyCustomerDebt(customerId: number, label: string): Promise<TruthCheck> {
  const [screen, dash, copilot] = await Promise.all([
    customerScreenDebt(customerId),
    dashboardSqlDebt(customerId),
    copilotDebtByCustomer(customerId),
  ]);
  return compareSurfaces("no_khach", `KH#${customerId}${label ? ` ${label}` : ""}`, {
    manKhachHang: screen,
    dashboardSql: dash,
    copilot,
  });
}

export async function verifySystemDebt(): Promise<TruthCheck> {
  const dashR = await pool.query(
    `SELECT COALESCE(SUM(${DEBT_SQL}), 0) AS v FROM bookings b WHERE ${revenueCountableSql("b")}`,
  );
  const copilot = await getUnpaidCustomers(100000);
  return compareSurfaces("no_toan_he_thong", "ALL", {
    dashboardSql: Number((dashR.rows[0] as { v?: string })?.v ?? 0),
    copilotTool: copilot.totalDebt,
  });
}

/** Doanh thu kỳ: /dashboard/simple (qua getSimpleFinance — code màn thật) vs Copilot. */
export async function verifyRevenue(from: string, to: string): Promise<TruthCheck> {
  const simple = await getSimpleFinance(from, to);
  // Copilot getRevenueSummary tính TRỌN THÁNG theo giờ VN — để so cùng cửa sổ,
  // chỉ hợp lệ khi [from,to] = [đầu tháng, hôm nay] và không có phiếu thu ghi
  // ngày tương lai. Kiểm tra điều kiện đó luôn (phiếu tương lai > to = 0).
  const future = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS v FROM payments
     WHERE paid_at >= ($1::date + INTERVAL '1 day') AND COALESCE(status,'active') != 'voided'
       AND payment_type != 'refund'
       AND paid_at < (date_trunc('month', $1::date) + INTERVAL '1 month')`,
    [to],
  );
  const rev = await getRevenueSummary();
  return compareSurfaces("doanh_thu_thang", `${from}..${to}`, {
    manTongQuanTaiChinh: simple.totalIncome,
    copilotTool: rev.revenue - Number((future.rows[0] as { v?: string })?.v ?? 0),
  });
}

/** Booking đơn lẻ: remaining theo lib booking-money (payments thật) vs cột paid_amount (màn dùng). */
export async function verifyBookingRemaining(bookingId: number): Promise<TruthCheck> {
  const b = await pool.query(
    `SELECT id, total_amount AS "totalAmount", discount_amount AS "discountAmount",
            paid_amount AS "paidAmount"
     FROM bookings WHERE id = $1`,
    [bookingId],
  );
  const row = b.rows[0] as Record<string, unknown>;
  const p = await pool.query(
    `SELECT amount, status, payment_type AS "paymentType" FROM payments WHERE booking_id = $1`,
    [bookingId],
  );
  // additionalServicesTotal bỏ qua (0): mọi đường nợ production đều tính
  // total − discount − paid, không có term dịch vụ thêm riêng.
  const viaPayments = computeBookingMoney(
    {
      totalAmount: row.totalAmount as string,
      discountAmount: row.discountAmount as string,
    },
    p.rows as AggPayment[],
  ).remaining;
  const viaPaidColumn = Math.max(
    0,
    Number(row.totalAmount ?? 0) - Number(row.discountAmount ?? 0) - Number(row.paidAmount ?? 0),
  );
  return compareSurfaces("booking_remaining", `DH#${bookingId}`, {
    libBookingMoney_tuPhieuThu: viaPayments,
    cotPaidAmount_manDung: viaPaidColumn,
  });
}

/** Nhóm bị loại (deleted/cancelled/temp_quote/orphan/cha tổng) phải đóng góp = 0 vào countable. */
export async function verifyExcludedGroups(): Promise<TruthCheck[]> {
  const groups: Array<{ name: string; cond: string }> = [
    { name: "deleted", cond: "b.deleted_at IS NOT NULL" },
    { name: "cancelled", cond: "COALESCE(b.status,'') = 'cancelled'" },
    { name: "temp_quote", cond: "COALESCE(b.status,'') = 'temp_quote'" },
    { name: "parent_tong", cond: "b.is_parent_contract = true" },
    {
      name: "orphan_child",
      cond: `b.parent_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM bookings pk WHERE pk.id = b.parent_id
          AND (pk.deleted_at IS NOT NULL OR COALESCE(pk.status,'') IN ('cancelled','temp_quote')))`,
    },
  ];
  const out: TruthCheck[] = [];
  for (const g of groups) {
    const r = await pool.query(
      `SELECT COALESCE(SUM(${DEBT_SQL}), 0) AS v FROM bookings b
       WHERE ${revenueCountableSql("b")} AND (${g.cond})`,
    );
    out.push(
      compareSurfaces(`nhom_bi_loai_${g.name}`, "phải = 0 trong tập countable", {
        dongGopVaoCountable: Number((r.rows[0] as { v?: string })?.v ?? 0),
        kyVong: 0,
      }),
    );
  }
  return out;
}
