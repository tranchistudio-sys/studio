/**
 * truth-service — GĐ0 "Financial Truth Test" (chủ duyệt 14/07, chỉnh kiến trúc cùng ngày).
 *
 * Service này KHÔNG tính nghiệp vụ. Nó chỉ VERIFY theo mô hình:
 *
 *   FINANCIAL ENGINE (financial-engine.ts — tính từ bảng gốc + quy tắc đã chốt)
 *        ↑ là CHUẨN duy nhất
 *   mọi CONSUMER (màn Khách hàng / Dashboard / Revenue / Copilot) phải đọc ra ĐÚNG số Engine.
 *
 * KHÔNG phải "Dashboard đúng thì mọi nơi giống Dashboard" — Dashboard cũng chỉ là
 * một consumer bị kiểm. Lệch 1 đồng so với Engine = FAIL, log rõ consumer nào lệch.
 */
import { pool } from "@workspace/db";
import { computeCustomerAggregate, type AggBooking, type AggPayment } from "../customer-aggregate";
import { computeBookingMoney } from "../booking-money";
import { revenueCountableSql } from "../booking-money";
import { getUnpaidCustomers, getRevenueSummary } from "../studio-copilot";
import { getSimpleFinance } from "../finance-summary";
import {
  ENGINE_DEBT_SQL,
  engineSystemDebt,
  engineCustomerDebt,
  engineCashIn,
  engineCashOut,
  engineLaborCost,
  engineFamilyCashDrift,
} from "./financial-engine";

export type TruthCheck = {
  metric: string;
  entity: string;
  /** surfaces.engine là CHUẨN; các key còn lại là consumer bị đối chiếu với engine. */
  surfaces: Record<string, number>;
  pass: boolean;
  maxDiff: number;
};

/** PASS khi MỌI consumer bằng đúng surfaces.engine (không so consumer với nhau). */
export function compareAgainstEngine(
  metric: string,
  entity: string,
  surfaces: Record<string, number> & { engine: number },
): TruthCheck {
  const diffs = Object.entries(surfaces)
    .filter(([k]) => k !== "engine")
    .map(([, v]) => Math.abs(v - surfaces.engine));
  const maxDiff = diffs.length ? Math.max(...diffs) : 0;
  return { metric, entity, surfaces, pass: maxDiff === 0, maxDiff };
}

export function formatCheck(c: TruthCheck): string {
  const detail = Object.entries(c.surfaces)
    .map(([k, v]) => `${k}=${v}`)
    .join(" | ");
  return `${c.pass ? "PASS" : "FAIL"} | ${c.metric} | ${c.entity} | ${detail} | lệch-max-vs-engine=${c.maxDiff}`;
}

// ─── Consumer: màn Khách hàng (đường code THẬT của GET /customers/:id) ─────────

async function consumerCustomerScreenDebt(customerId: number): Promise<number> {
  // Route nạp TOÀN BỘ đơn của khách (kể cả đã xóa) + payments, đưa qua
  // computeCustomerAggregate — tái hiện y nguyên (payments chỉ cần của các đơn
  // thuộc khách vì liveIds ⊆ đơn của khách).
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

// ─── Consumer: Copilot — đúng dạng query GROUP BY khách của getUnpaidCustomers ─
// (tool thật trả line text theo tên+SĐT nên không tra id được; tái hiện đúng SQL
//  grouped của tool, còn TOOL THẬT được đối chiếu tổng ở verifySystemDebt.)

let copilotDebtMap: Map<string, number> | null = null;

export async function consumerCopilotDebtByCustomer(customerId: number): Promise<number> {
  if (!copilotDebtMap) {
    copilotDebtMap = new Map();
    const r = await pool.query(
      `SELECT c.id, SUM(${ENGINE_DEBT_SQL}) AS debt
       FROM bookings b JOIN customers c ON c.id = b.customer_id
       WHERE ${revenueCountableSql("b")}
       GROUP BY c.id HAVING SUM(${ENGINE_DEBT_SQL}) > 0`,
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

// ─── Check: công nợ ────────────────────────────────────────────────────────────

export async function verifyCustomerDebt(customerId: number, label: string): Promise<TruthCheck> {
  const [engine, screen, copilot] = await Promise.all([
    engineCustomerDebt(customerId),
    consumerCustomerScreenDebt(customerId),
    consumerCopilotDebtByCustomer(customerId),
  ]);
  return compareAgainstEngine("no_khach", `KH#${customerId}${label ? ` ${label}` : ""}`, {
    engine,
    manKhachHang: screen,
    copilot,
  });
}

export async function verifySystemDebt(): Promise<TruthCheck> {
  const [engine, simple, copilot] = await Promise.all([
    engineSystemDebt(),
    // Consumer Dashboard: đúng code màn Tổng quan tài chính đang chạy.
    // customerDebt của getSimpleFinance KHÔNG phụ thuộc kỳ — truyền kỳ giả cho gọn.
    getSimpleFinance("2000-01-01", "2000-01-02").then(f => f.customerDebt),
    getUnpaidCustomers(100000),
  ]);
  return compareAgainstEngine("no_toan_he_thong", "ALL", {
    engine,
    dashboardSimple: simple,
    copilotTool: copilot.totalDebt,
  });
}

// ─── Check: dòng tiền vào ──────────────────────────────────────────────────────

export async function verifyCashIn(from: string, to: string): Promise<TruthCheck> {
  const engine = await engineCashIn(from, to);
  const simple = await getSimpleFinance(from, to);
  // Copilot getRevenueSummary tính TRỌN THÁNG theo giờ VN — quy về cùng cửa sổ
  // bằng cách trừ phiếu thu sau `to` trong cùng tháng (nếu có).
  const future = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS v FROM payments
     WHERE paid_at >= ($1::date + INTERVAL '1 day') AND COALESCE(status,'active') != 'voided'
       AND payment_type != 'refund'
       AND paid_at < (date_trunc('month', $1::date) + INTERVAL '1 month')`,
    [to],
  );
  const rev = await getRevenueSummary();
  return compareAgainstEngine("tien_da_thu_ky", `${from}..${to}`, {
    engine,
    dashboardSimple: simple.totalIncome,
    copilotTool: rev.revenue - Number((future.rows[0] as { v?: string })?.v ?? 0),
  });
}

// ─── Check: chi phí studio theo quy tắc ②③ (consumer Dashboard đang đếm khác) ──

export async function verifyCashOutRules(from: string, to: string): Promise<TruthCheck> {
  const engine = await engineCashOut(from, to);
  const simple = await getSimpleFinance(from, to);
  const check = compareAgainstEngine("chi_phi_studio_ky", `${from}..${to}`, {
    engine: engine.studioExpense,
    dashboardSimple_directExpense: simple.directExpense,
  });
  // Đính kèm phần Engine loại ra để đọc log là hiểu ngay lệch nằm đâu.
  check.surfaces["(engine loại: personal)"] = engine.excludedPersonal;
  check.surfaces["(engine loại: chưa duyệt)"] = engine.excludedNotApproved;
  check.surfaces["(engine loại: trả gốc vay)"] = engine.excludedLoanPrincipal;
  return check;
}

// ─── Check: lương cast quy tắc ④ (consumer màn Doanh thu đang dùng tasks.cost) ─

export async function verifyLaborSource(from: string, to: string): Promise<TruthCheck> {
  const engine = await engineLaborCost(from, to);
  const tasksCost = await pool.query(
    `SELECT COALESCE(SUM(t.cost::numeric), 0) AS v
     FROM tasks t JOIN bookings b ON b.id = t.booking_id
     WHERE ${revenueCountableSql("b")}
       AND b.shoot_date >= $1::date AND b.shoot_date <= $2::date`,
    [from, to],
  );
  return compareAgainstEngine("luong_cast_ky", `${from}..${to}`, {
    engine,
    manDoanhThu_tasksCost: Number((tasksCost.rows[0] as { v?: string })?.v ?? 0),
  });
}

// ─── Check: toàn vẹn per-booking & theo gia đình đơn ───────────────────────────

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
  return compareAgainstEngine("booking_remaining", `DH#${bookingId}`, {
    engine: viaPaidColumn, // quy tắc ①: paid_amount là phân bổ chuẩn per-booking
    tuPhieuThuGoc: viaPayments, // đối chiếu ngược về bảng payments gốc
  });
}

export async function verifyFamilyCashIntegrity(limit = 200): Promise<TruthCheck[]> {
  const drifts = await engineFamilyCashDrift(limit);
  return drifts.map(d =>
    compareAgainstEngine("gia_dinh_don_phieu_thu_vs_phan_bo", `FAM#${d.familyRootId}`, {
      engine: d.rawPaymentsSum,
      cot_paid_amount: d.paidColumnSum,
    }),
  );
}

/** Nhóm bị loại (deleted/cancelled/temp_quote/cha tổng/mồ côi) phải đóng góp = 0 vào countable. */
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
      `SELECT COALESCE(SUM(${ENGINE_DEBT_SQL}), 0) AS v FROM bookings b
       WHERE ${revenueCountableSql("b")} AND (${g.cond})`,
    );
    out.push(
      compareAgainstEngine(`nhom_bi_loai_${g.name}`, "trong tập countable", {
        engine: 0,
        dongGop: Number((r.rows[0] as { v?: string })?.v ?? 0),
      }),
    );
  }
  return out;
}
