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
  engineAllocationSnapshot,
  engineSystemDebt,
  engineCustomerDebt,
  engineCashIn,
  engineCashOut,
  engineCastForCreatedCohort,
  engineFamilyCashDrift,
  engineReceivableForRange,
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

// ─── Consumer: màn Khách hàng ──────────────────────────────────────────────────
// GĐ1a: route /customers/:id ĐÃ chuyển sang engineCustomerFinance. Surface trung
// thực nhất là HTTP API THẬT (server đang chạy) — bật bằng env TRUTH_API_BASE
// (vd http://localhost:3000). Không có server → fallback legacyAggregate (đường
// code CŨ computeCustomerAggregate) để ledger vẫn ghi được khoảng lệch dữ liệu cũ.

async function consumerCustomerScreenDebt(
  customerId: number,
): Promise<{ surface: string; value: number }> {
  const base = (process.env.TRUTH_API_BASE ?? "").replace(/\/$/, "");
  if (base) {
    const r = await fetch(`${base}/api/customers/${customerId}`);
    if (!r.ok) throw new Error(`GET /api/customers/${customerId} → HTTP ${r.status}`);
    const j = (await r.json()) as { totalDebt?: number };
    return { surface: "manKhachHang_httpApi", value: Number(j.totalDebt ?? 0) };
  }
  const b = await pool.query(
    `SELECT id, total_amount AS "totalAmount", is_parent_contract AS "isParentContract",
            parent_id AS "parentId", status, deleted_at AS "deletedAt"
     FROM bookings WHERE customer_id = $1`,
    [customerId],
  );
  const bookings = b.rows as AggBooking[];
  if (!bookings.length) return { surface: "manKhachHang_legacyAggregate", value: 0 };
  const ids = bookings.map(x => x.id);
  const p = await pool.query(
    `SELECT booking_id AS "bookingId", amount, status, payment_type AS "paymentType"
     FROM payments WHERE booking_id = ANY($1::int[])`,
    [ids],
  );
  return {
    surface: "manKhachHang_legacyAggregate",
    value: computeCustomerAggregate(bookings, p.rows as AggPayment[]).totalDebt,
  };
}

// ─── Consumer: Copilot — đọc OUTPUT của TOOL THẬT (engineUnpaidCustomers) ──────
// Chốt 17/07: không tái hiện lại phép tính (tautology với engine snapshot) —
// gọi đúng tool Copilot dùng rồi map (name, phone) → customerId qua bảng customers
// để lớp đối chiếu per-khách kiểm tra THẬT đầu ra wiring của tool.

let copilotDebtMap: Map<string, number> | null = null;

export async function consumerCopilotDebtByCustomer(customerId: number): Promise<number> {
  if (!copilotDebtMap) {
    copilotDebtMap = new Map();
    const { engineUnpaidCustomers } = await import("./financial-engine");
    const tool = await engineUnpaidCustomers(100000);
    const custR = await pool.query(`SELECT id, name, phone FROM customers`);
    const idByKey = new Map<string, string>();
    for (const c of custR.rows as Array<{ id: number; name: string | null; phone: string | null }>) {
      idByKey.set(`${c.name ?? ""}|${c.phone ?? ""}`, String(c.id));
    }
    for (const row of tool.customers) {
      const cid = idByKey.get(`${row.name ?? ""}|${row.phone ?? ""}`);
      if (cid) copilotDebtMap.set(cid, (copilotDebtMap.get(cid) ?? 0) + row.debt);
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
    [screen.surface]: screen.value,
    copilot,
  } as Record<string, number> & { engine: number });
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

// ─── Check: lương cast quy tắc ④ — GĐ1b-2: sổ staff_job_earnings, gán booking bucket ─

/**
 * Engine cast (cohort đơn TẠO trong kỳ, từ sổ earnings) ↔ HTTP Revenue monthly
 * staffCast ↔ HTTP custom-range staffCast. HTTP surface cần TRUTH_API_BASE.
 */
export async function verifyLaborSource(ym: string): Promise<TruthCheck> {
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const from = `${ym}-01`;
  const to = `${ym}-${String(lastDay).padStart(2, "0")}`;
  const surfaces: Record<string, number> & { engine: number } = {
    engine: await engineCastForCreatedCohort(from, to),
  };
  const base = (process.env.TRUTH_API_BASE ?? "").replace(/\/$/, "");
  if (base) {
    const mj = (await (await fetch(`${base}/api/revenue/v2/monthly?from=${from}&to=${to}`)).json()) as {
      months?: Array<{ month: string; staffCast: number }>;
    };
    surfaces.revenueMonthly_http = Number((mj.months ?? []).find(x => x.month === ym)?.staffCast ?? Number.NaN);
    const cj = (await (await fetch(`${base}/api/revenue/v2/custom-range?from=${from}&to=${to}`)).json()) as {
      staffCast?: number;
    };
    surfaces.revenueCustomRange_http = Number(cj.staffCast ?? Number.NaN);
  }
  return compareAgainstEngine("luong_cast_ky", ym, surfaces);
}

// ─── Check: toàn vẹn per-booking & theo gia đình đơn ───────────────────────────

/**
 * PR #102 — bất biến GIA ĐÌNH của phân bổ pro-rata:
 *   Σ nợ per-booking (Engine, "đã thu PHÂN BỔ") trên các thành viên countable
 *   = max(0, Σ net gia đình − Σ phiếu thu gốc của gia đình)
 * Vế phải là ĐÚNG con số màn Booking detail / Hợp đồng hiển thị (tổng gia đình −
 * phiếu thu trên đơn đích) — tức Booking screen ↔ Engine phải ra cùng một số.
 */
export async function verifyBookingRemaining(bookingId: number): Promise<TruthCheck> {
  const rootR = await pool.query(
    `SELECT COALESCE(parent_id, id) AS root FROM bookings WHERE id = $1`,
    [bookingId],
  );
  const root = Number((rootR.rows[0] as { root?: number } | undefined)?.root ?? bookingId);

  const snap = await engineAllocationSnapshot();
  const engine = snap.members.reduce((s, m) => (m.rootId === root ? s + m.debt : s), 0);

  // Độc lập với Engine: net gia đình từ bảng bookings + phiếu gốc từ bảng payments.
  const famR = await pool.query(
    `SELECT COALESCE(SUM(GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0))), 0) AS net
     FROM bookings b
     WHERE COALESCE(b.parent_id, b.id) = $1 AND ${revenueCountableSql("b")}`,
    [root],
  );
  const p = await pool.query(
    `SELECT p.amount, p.status, p.payment_type AS "paymentType"
     FROM payments p JOIN bookings pb ON pb.id = p.booking_id
     WHERE COALESCE(pb.parent_id, pb.id) = $1`,
    [root],
  );
  const familyNet = Number((famR.rows[0] as { net?: string })?.net ?? 0);
  const viaPayments = computeBookingMoney(
    { totalAmount: String(familyNet), discountAmount: "0" },
    p.rows as AggPayment[],
  ).remaining;

  const check = compareAgainstEngine("booking_remaining_family", `DH#${bookingId} (FAM#${root})`, {
    engine,
    manBooking_tuPhieuThuGoc: viaPayments,
  });
  // Phép chia pro-rata có thể lệch phần lẻ cực nhỏ của numeric — dưới 1 đồng coi là khớp.
  if (!check.pass && check.maxDiff < 1) return { ...check, pass: true };
  return check;
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
  const snapEx = await engineAllocationSnapshot();
  for (const g of groups) {
    // Nhóm bị loại KHÔNG được nằm trong snapshot member (allocator chỉ nhận countable).
    // Lấy id CHỈ theo điều kiện nhóm (KHÔNG kèm countable — kèm là mâu thuẫn logic
    // → luôn 0 dòng → phép kiểm rỗng), rồi soi snapshot: có id nào lọt = leak.
    const r = await pool.query(
      `SELECT b.id FROM bookings b WHERE (${g.cond})`,
    );
    const leakedDebt = (r.rows as Array<{ id: number }>).reduce(
      (s, x) => s + (snapEx.byId.get(Number(x.id))?.debt ?? 0),
      0,
    );
    out.push(
      compareAgainstEngine(`nhom_bi_loai_${g.name}`, "trong tập countable", {
        engine: 0,
        dongGop: leakedDebt,
      }),
    );
  }
  return out;
}

// ─── GĐ1b-1: "Còn có thể thu từ show của tháng" (scope ngày chụp/occurrence) ───

/**
 * Engine ↔ Revenue monthly (HTTP) ↔ Revenue custom-range (HTTP) ↔ Copilot tool
 * thật — cùng kỳ phải cùng MỘT số. HTTP surface chỉ chạy khi TRUTH_API_BASE bật.
 */
export async function verifyMonthReceivable(ym: string): Promise<TruthCheck> {
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const from = `${ym}-01`;
  const to = `${ym}-${String(lastDay).padStart(2, "0")}`;

  const surfaces: Record<string, number> & { engine: number } = {
    engine: await engineReceivableForRange(from, to),
  };
  const base = (process.env.TRUTH_API_BASE ?? "").replace(/\/$/, "");
  if (base) {
    const mj = (await (await fetch(`${base}/api/revenue/v2/monthly?from=${from}&to=${to}`)).json()) as {
      months?: Array<{ month: string; remaining: number }>;
    };
    const bucket = (mj.months ?? []).find(x => x.month === ym);
    surfaces.revenueMonthly_http = Number(bucket?.remaining ?? Number.NaN);
    const cj = (await (await fetch(`${base}/api/revenue/v2/custom-range?from=${from}&to=${to}`)).json()) as {
      remaining?: number;
    };
    surfaces.revenueCustomRange_http = Number(cj.remaining ?? Number.NaN);
  }
  const cop = await getUnpaidCustomers(100000, { start: from, end: to, label: ym });
  surfaces.copilotTool = cop.totalDebt;
  return compareAgainstEngine("con_co_the_thu_thang", ym, surfaces);
}

/**
 * Bảo toàn phạm vi GĐ1b-1: contractValue (Hợp đồng ký mới, scope created_at) và
 * collected (Tiền thực thu, scope payment_date) KHÔNG được đổi — đối chiếu HTTP
 * với bản tính lại độc lập bằng SQL (đúng semantics getBookingDate/getPaymentDate).
 */
export async function verifySignedAndCollected(ym: string): Promise<TruthCheck[]> {
  const base = (process.env.TRUTH_API_BASE ?? "").replace(/\/$/, "");
  if (!base) return [];
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const from = `${ym}-01`;
  const to = `${ym}-${String(lastDay).padStart(2, "0")}`;

  const signedSql = await pool.query(
    `SELECT COALESCE(SUM(GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0))), 0) AS v
     FROM bookings b
     WHERE ${revenueCountableSql("b")}
       AND (b.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $1::date AND $2::date`,
    [from, to],
  );
  const collectedSql = await pool.query(
    `SELECT COALESCE(SUM(p.amount::numeric), 0) AS v
     FROM payments p
     WHERE COALESCE(p.status,'active') != 'voided' AND COALESCE(p.payment_type,'') != 'refund'
       AND NOT (p.booking_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM bookings zp WHERE zp.id = p.booking_id AND zp.is_parent_contract = true
           AND NOT EXISTS (SELECT 1 FROM bookings zch WHERE zch.parent_id = zp.id
             AND zch.deleted_at IS NULL AND COALESCE(zch.status,'') NOT IN ('cancelled','temp_quote'))))
       AND (CASE WHEN p.paid_date IS NOT NULL AND length(p.paid_date) >= 10
                 THEN substring(p.paid_date, 1, 10)
                 ELSE to_char(p.paid_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')
            END) BETWEEN $1 AND $2`,
    [from, to],
  );

  const mj = (await (await fetch(`${base}/api/revenue/v2/monthly?from=${from}&to=${to}`)).json()) as {
    months?: Array<{ month: string; contractValue: number; collected: number }>;
  };
  const bucket = (mj.months ?? []).find(x => x.month === ym);

  return [
    compareAgainstEngine("hop_dong_ky_moi_thang", ym, {
      engine: Number((signedSql.rows[0] as { v?: string })?.v ?? 0),
      revenueMonthly_http: Number(bucket?.contractValue ?? Number.NaN),
    }),
    compareAgainstEngine("tien_thuc_thu_thang", ym, {
      engine: Number((collectedSql.rows[0] as { v?: string })?.v ?? 0),
      revenueMonthly_http: Number(bucket?.collected ?? Number.NaN),
    }),
  ];
}

// ─── GĐ1e-1: BUSINESS ENGINE = Financial Engine TỪNG ĐỒNG ─────────────────────
// Business Engine chỉ được XẾP HẠNG/GẮN NHÃN — không được đổi bất kỳ số nào.

import {
  engineOverdueReceivables as _engOverdue,
  engineBookingFinance as _engBookings,
  engineServiceRollup as _engServices,
  engineCastLedger as _engLedger,
} from "./financial-engine";
import {
  bizMonthlyOverview,
  bizDebtInsights,
} from "./business-engine";

export async function verifyBusinessMonthly(ym: string): Promise<TruthCheck[]> {
  const o = await bizMonthlyOverview(ym);
  if (!o.data) {
    return [
      compareAgainstEngine("business_monthly", ym, { engine: 0, businessDataNull: Number.NaN }),
    ];
  }
  const w = o.data.window;
  const [y, m] = ym.split("-").map(Number);
  const monthEnd = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  const [simple, receivable, systemDebt] = await Promise.all([
    getSimpleFinance(w.from, w.to),
    engineReceivableForRange(w.from, monthEnd),
    engineSystemDebt(),
  ]);
  return [
    compareAgainstEngine("biz_thang_da_thu", ym, { engine: simple.totalIncome, business: o.data.collected }),
    compareAgainstEngine("biz_thang_con_thu", ym, { engine: receivable, business: o.data.receivable }),
    compareAgainstEngine("biz_thang_da_chi", ym, { engine: simple.totalSpent, business: o.data.spent.total }),
    compareAgainstEngine("biz_thang_loi_nhuan", ym, { engine: simple.realProfit, business: o.data.actualProfit }),
    compareAgainstEngine("biz_no_he_thong", ym, { engine: systemDebt, business: o.data.systemDebt }),
    compareAgainstEngine("biz_du_kien_cong_thuc", ym, {
      engine: simple.totalIncome + receivable - simple.totalSpent,
      business: o.data.projectedProfitIfCollectAll,
    }),
  ];
}

export async function verifyBusinessDebt(): Promise<TruthCheck[]> {
  const d = await bizDebtInsights(5);
  const out: TruthCheck[] = [];
  const systemDebt = await engineSystemDebt();
  out.push(
    compareAgainstEngine("biz_tong_con_thu", "ALL", {
      engine: systemDebt,
      business: d.data?.totalReceivable ?? Number.NaN,
    }),
  );
  // Từng khách top nợ đối chiếu lại bằng query per-customer ĐỘC LẬP của Engine
  for (const t of d.data?.topDebtors ?? []) {
    out.push(
      compareAgainstEngine("biz_top_no_khach", `KH#${t.customerId}`, {
        engine: await engineCustomerDebt(t.customerId),
        business: t.debt,
      }),
    );
  }
  const overdueSum = (d.data?.overdue ?? []).reduce((s, x) => s + x.receivable, 0);
  out.push(
    compareAgainstEngine("biz_tong_qua_han", "ALL", {
      engine: overdueSum,
      business: d.data?.overdueTotal ?? Number.NaN,
    }),
  );
  return out;
}

/** Chéo sổ: per-booking ↔ per-service ↔ tổng hệ thống phải cùng một thế giới số. */
export async function verifyBusinessCrossSums(): Promise<TruthCheck[]> {
  const [bookings, services, systemDebt, ledger] = await Promise.all([
    _engBookings(),
    _engServices(),
    engineSystemDebt(),
    _engLedger(),
  ]);
  const sumB = (f: (b: { netValue: number; receivable: number; laborCost: number }) => number) =>
    bookings.reduce((s, b) => s + f(b), 0);
  const sumS = (f: (s: { contractValue: number; receivable: number; laborRecognized: number }) => number) =>
    services.reduce((acc, s) => acc + f(s), 0);
  const ledgerTotal = [...ledger.castByBooking.values()].reduce((s, v) => s + v, 0);
  return [
    compareAgainstEngine("cheo_so_no", "bookingFinance ↔ systemDebt ↔ serviceRollup", {
      engine: systemDebt,
      sumBookingFinance: sumB(b => b.receivable),
      sumServiceRollup: sumS(s => s.receivable),
    }),
    compareAgainstEngine("cheo_so_net", "bookingFinance ↔ serviceRollup", {
      engine: sumB(b => b.netValue),
      sumServiceRollup: sumS(s => s.contractValue),
    }),
    compareAgainstEngine("cheo_so_cast", "bookingFinance ↔ castLedger ↔ serviceRollup", {
      engine: ledgerTotal,
      sumBookingFinance: sumB(b => b.laborCost),
      sumServiceRollup: sumS(s => s.laborRecognized),
    }),
  ];
}
