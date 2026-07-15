/**
 * BUSINESS ENGINE — GĐ1e-1 (chủ duyệt 15/07).
 *
 *   Database → FINANCIAL ENGINE → BUSINESS ENGINE → JSON Insight<T> → (Copilot AI chỉ diễn đạt)
 *
 * LỚP THUẦN HÀM: chỉ ĐỌC Financial Engine — TUYỆT ĐỐI không truy vấn DB trực tiếp,
 * không tự tính lại nguồn tiền. Việc của tầng này: xếp hạng, so sánh, tỷ lệ,
 * ngoại suy CÓ CÔNG THỨC KHAI BÁO (field `method`), gắn status/caveats.
 * Thiếu dữ liệu → status "partial"/"missing"/"unknown" — KHÔNG suy diễn, không đoán.
 * Mọi recommendation phải trỏ tới bằng chứng thật (mã đơn/khách + số tiền).
 */
import {
  engineCashIn,
  engineCashOut,
  engineReceivableForRange,
  engineSystemDebt,
  engineAllCustomersFinance,
  engineCastLedger,
  engineOverdueReceivables,
  engineBookingFinance,
  engineServiceRollup,
  REVENUE_SCOPES,
  LABOR_COVERAGE_NOTE,
  SALES_COMMISSION_NOTE,
  type OverdueReceivable,
  type BookingFinance,
  type ServiceRollup,
  type LaborCoverage,
} from "./financial-engine";
import { getSimpleFinance } from "../finance-summary";

// ─── Schema bắt buộc ───────────────────────────────────────────────────────────

export type InsightStatus = "ok" | "partial" | "missing" | "unknown";

export type Insight<T> = {
  status: InsightStatus;
  asOf: string;
  scope: string;
  data: T | null;
  caveats: string[];
  method?: string;
  source: "financial-engine";
};

const APP_TZ = "Asia/Ho_Chi_Minh";

function vnToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: APP_TZ });
}

function monthWindow(ym?: string): { ym: string; from: string; to: string; daysInMonth: number } {
  const today = vnToday();
  const month = ym ?? today.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const from = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  // "đến hôm nay" nếu là tháng hiện tại, ngược lại trọn tháng
  const to = month === today.slice(0, 7) ? today : monthEnd;
  return { ym: month, from, to, daysInMonth };
}

function insight<T>(
  status: InsightStatus,
  scope: string,
  data: T | null,
  caveats: string[],
  method?: string,
): Insight<T> {
  return { status, asOf: vnToday(), scope, data, caveats, ...(method ? { method } : {}), source: "financial-engine" };
}

/** Caveats chuẩn khi sổ cast chưa phủ hết + hoa hồng sale chưa ghi sổ. */
function laborCaveats(coverage: LaborCoverage): string[] {
  const out: string[] = [];
  if (coverage.status === "partial") {
    out.push(
      `Sổ cast mới phủ ${coverage.bookingCountWithEarnings}/${coverage.eligibleBookingCount} đơn hợp lệ (${coverage.earningCount} khoản) — ${LABOR_COVERAGE_NOTE}`,
    );
  }
  out.push(SALES_COMMISSION_NOTE);
  return out;
}

// ─── A. Tổng quan tài chính tháng ─────────────────────────────────────────────

export type MonthlyOverview = {
  period: string;
  window: { from: string; to: string };
  collected: number;
  receivable: number;
  spent: { direct: number; fixedMonthly: number; total: number };
  actualProfit: number;
  breakeven: { status: "over" | "under"; delta: number };
  /** = collected + receivable − spent.total — nếu thu đủ show của tháng. */
  projectedProfitIfCollectAll: number;
  systemDebt: number;
  coverage: {
    labor: LaborCoverage;
    salesCommissionIncluded: false;
  };
};

export async function bizMonthlyOverview(ym?: string): Promise<Insight<MonthlyOverview>> {
  const w = monthWindow(ym);
  let simple, receivable, ledger, systemDebt;
  try {
    [simple, receivable, ledger, systemDebt] = await Promise.all([
      getSimpleFinance(w.from, w.to),
      engineReceivableForRange(w.from, `${w.ym}-${String(w.daysInMonth).padStart(2, "0")}`),
      engineCastLedger(),
      engineSystemDebt(),
    ]);
  } catch {
    simple = null;
  }
  if (!simple || !ledger) {
    // Thiếu nguồn → unknown, KHÔNG kết luận (quy tắc F).
    return insight("unknown", JSON.stringify(REVENUE_SCOPES), null, [
      "Không đọc được nguồn Financial Engine — không kết luận số liệu tháng.",
    ]);
  }
  const data: MonthlyOverview = {
    period: w.ym,
    window: { from: w.from, to: w.to },
    collected: simple.totalIncome,
    receivable,
    spent: {
      direct: simple.directExpense,
      fixedMonthly: simple.fixedCostMonthly,
      total: simple.totalSpent,
    },
    actualProfit: simple.realProfit,
    breakeven: simple.breakeven,
    projectedProfitIfCollectAll: simple.totalIncome + receivable - simple.totalSpent,
    systemDebt,
    coverage: { labor: ledger.meta.laborCoverage, salesCommissionIncluded: false },
  };
  const caveats = [
    "Lợi nhuận dự kiến = đã thu + còn phải thu từ show của tháng − chi phí studio đã ghi nhận; chưa trừ cast/chi phí phát sinh chưa ghi sổ.",
    ...laborCaveats(ledger.meta.laborCoverage),
  ];
  // Coverage cast partial + hoa hồng missing → không được nhận là số cuối cùng
  const status: InsightStatus = ledger.meta.laborCoverage.status === "partial" ? "partial" : "ok";
  return insight(status, JSON.stringify(REVENUE_SCOPES), data, caveats, "collected + receivable − spent (khai báo)");
}

// ─── B. Dự phóng dòng tiền cuối tháng ─────────────────────────────────────────

export type CashflowProjection = {
  period: string;
  daysElapsed: number;
  daysInMonth: number;
  collectedSoFar: number;
  directSpentSoFar: number;
  fixedMonthly: number;
  projectedCollectedEom: number;
  projectedDirectSpendEom: number;
  projectedProfitEom: number;
};

/** Ngoại suy TUYẾN TÍNH khai báo — không phải AI đoán tốc độ tăng trưởng. */
export async function bizCashflowProjection(ym?: string): Promise<Insight<CashflowProjection>> {
  const w = monthWindow(ym);
  const today = vnToday();
  const isCurrentMonth = w.ym === today.slice(0, 7);
  const daysElapsed = isCurrentMonth ? Number(today.slice(8, 10)) : w.daysInMonth;

  if (daysElapsed < 3) {
    return insight(
      "missing",
      "payment_date + expense_date trong tháng",
      null,
      [`Mới ${daysElapsed} ngày dữ liệu trong ${w.ym} — chưa đủ để ngoại suy tốc độ, em không đoán.`],
      "linear_run_rate",
    );
  }

  const [collected, cashOut, ledger] = await Promise.all([
    engineCashIn(w.from, w.to),
    engineCashOut(w.from, w.to),
    engineCastLedger(),
  ]);
  const scale = w.daysInMonth / daysElapsed;
  const projectedCollectedEom = Math.round(collected * scale);
  const projectedDirectSpendEom = Math.round(cashOut.studioExpense * scale);
  const projectedProfitEom =
    projectedCollectedEom - projectedDirectSpendEom - cashOut.fixedMonthly;
  const data: CashflowProjection = {
    period: w.ym,
    daysElapsed,
    daysInMonth: w.daysInMonth,
    collectedSoFar: collected,
    directSpentSoFar: cashOut.studioExpense,
    fixedMonthly: cashOut.fixedMonthly,
    projectedCollectedEom,
    projectedDirectSpendEom,
    projectedProfitEom,
  };
  return insight(
    "partial",
    "payment_date + expense_date trong tháng",
    data,
    [
      `Ngoại suy tuyến tính từ ${daysElapsed}/${w.daysInMonth} ngày — thu/chi studio thường dồn theo lịch show nên số cuối tháng có thể lệch.`,
      ...laborCaveats(ledger.meta.laborCoverage),
    ],
    "linear_run_rate",
  );
}

// ─── C. Công nợ ────────────────────────────────────────────────────────────────

export type DebtInsights = {
  totalReceivable: number;
  topDebtors: Array<{ customerId: number; name: string | null; debt: number }>;
  /** Ưu tiên thu = show ĐÃ DIỄN RA còn nợ, xếp theo nợ lớn (rule khai báo). */
  collectFirst: OverdueReceivable[];
  overdue: OverdueReceivable[];
  overdueTotal: number;
};

export async function bizDebtInsights(topN = 10): Promise<Insight<DebtInsights>> {
  const [systemDebt, byCustomer, overdue] = await Promise.all([
    engineSystemDebt(),
    engineAllCustomersFinance(),
    engineOverdueReceivables(100),
  ]);
  const topDebtors = [...byCustomer.entries()]
    .map(([customerId, f]) => ({ customerId, name: null as string | null, debt: f.totalDebt }))
    .filter(x => x.debt > 0)
    .sort((a, b) => b.debt - a.debt)
    .slice(0, topN);
  // Gắn tên từ danh sách overdue nếu trùng khách (không SQL thêm — đủ cho insight)
  for (const d of topDebtors) {
    const hit = overdue.find(o => o.customerId === d.customerId);
    if (hit) d.name = hit.customerName;
  }
  const overdueTotal = overdue.reduce((s, o) => s + o.receivable, 0);
  const data: DebtInsights = {
    totalReceivable: systemDebt,
    topDebtors,
    collectFirst: overdue.slice(0, topN),
    overdue,
    overdueTotal,
  };
  return insight(
    "ok",
    "nợ tồn toàn hệ thống (quy tắc ①); quá hạn = show đã diễn ra xong còn nợ",
    data,
    ["Ưu tiên thu xếp theo rule: đơn đã thực hiện xong, nợ lớn trước."],
    "rank: overdue theo receivable desc",
  );
}

// ─── D. Booking ───────────────────────────────────────────────────────────────

export type BookingInsights = {
  topRevenue: BookingFinance[];
  /** Margin thấp nhất trong các đơn net ≥ ngưỡng — chỉ xét đơn ĐÃ có sổ cast/chi. */
  lowProfit: Array<BookingFinance & { margin: number }>;
  watchlist: Array<{ booking: BookingFinance; reasons: string[] }>;
  rules: { minNetForLowProfit: number; upcomingDays: number };
};

export const BOOKING_RULES = { minNetForLowProfit: 1_000_000, upcomingDays: 7 };

export async function bizBookingInsights(topN = 5): Promise<Insight<BookingInsights>> {
  const [list, ledger] = await Promise.all([engineBookingFinance(), engineCastLedger()]);
  const today = vnToday();
  const upcomingLimit = new Date(new Date(today).getTime() + BOOKING_RULES.upcomingDays * 86400000)
    .toISOString()
    .slice(0, 10);

  const topRevenue = [...list].sort((a, b) => b.netValue - a.netValue).slice(0, topN);
  const lowProfit = list
    .filter(b => b.netValue >= BOOKING_RULES.minNetForLowProfit)
    .filter(b => b.hasLaborLedger || b.approvedDirectExpense > 0) // chưa có sổ chi → không kết luận "lời thấp"
    .map(b => ({ ...b, margin: b.netValue > 0 ? b.estimatedProfit / b.netValue : 0 }))
    .sort((a, b) => a.margin - b.margin)
    .slice(0, topN);

  const watchlist: Array<{ booking: BookingFinance; reasons: string[] }> = [];
  for (const b of list) {
    const reasons: string[] = [];
    if (b.receivable > 0 && b.shootDate && b.shootDate < today) {
      reasons.push(`Đã chụp ${b.shootDate} nhưng còn nợ ${b.receivable.toLocaleString("vi-VN")} đ`);
    }
    if (b.paid === 0 && b.shootDate && b.shootDate >= today && b.shootDate <= upcomingLimit) {
      reasons.push(`Show ${b.shootDate} trong ${BOOKING_RULES.upcomingDays} ngày tới nhưng CHƯA cọc đồng nào`);
    }
    if (reasons.length) watchlist.push({ booking: b, reasons });
  }
  watchlist.sort((a, b) => b.booking.receivable - a.booking.receivable);

  const data: BookingInsights = {
    topRevenue,
    lowProfit,
    watchlist: watchlist.slice(0, topN * 2),
    rules: BOOKING_RULES,
  };
  return insight(
    ledger.meta.laborCoverage.status === "partial" ? "partial" : "ok",
    "per-booking: net(created scope) / paid(phân bổ) / nợ ① / cast ④ / chi direct ②③",
    data,
    [
      `Lợi nhuận per-booking là TẠM TÍNH (net − cast đã ghi sổ − chi direct đã duyệt); đơn chưa có sổ chi bị LOẠI khỏi xếp hạng "lời thấp" thay vì đoán.`,
      ...laborCaveats(ledger.meta.laborCoverage),
    ],
    `rules: lowProfit = margin asc, net ≥ ${BOOKING_RULES.minNetForLowProfit}; watchlist = (đã chụp còn nợ) hoặc (show ≤${BOOKING_RULES.upcomingDays} ngày chưa cọc)`,
  );
}

// ─── E. Dịch vụ ───────────────────────────────────────────────────────────────

export type ServiceInsights = {
  topRevenue: ServiceRollup[];
  topEstimatedProfit: ServiceRollup[];
  lowEfficiency: Array<ServiceRollup & { margin: number }>;
  rules: { minBookingsForRanking: number };
};

export const SERVICE_RULES = { minBookingsForRanking: 3 };

export async function bizServiceInsights(topN = 5): Promise<Insight<ServiceInsights>> {
  const [rollup, ledger] = await Promise.all([engineServiceRollup(), engineCastLedger()]);
  const ranked = rollup.filter(s => s.bookingCount >= SERVICE_RULES.minBookingsForRanking);
  const data: ServiceInsights = {
    topRevenue: [...rollup].sort((a, b) => b.contractValue - a.contractValue).slice(0, topN),
    topEstimatedProfit: [...ranked].sort((a, b) => b.estimatedProfit - a.estimatedProfit).slice(0, topN),
    lowEfficiency: ranked
      .map(s => ({ ...s, margin: s.contractValue > 0 ? s.estimatedProfit / s.contractValue : 0 }))
      .sort((a, b) => a.margin - b.margin)
      .slice(0, topN),
    rules: SERVICE_RULES,
  };
  return insight(
    ledger.meta.laborCoverage.status === "partial" ? "partial" : "ok",
    "gộp theo service_category (khóa gộp kỹ thuật — có thể khác nhãn gói trên màn Bảng giá)",
    data,
    [
      `Xếp hạng lợi nhuận/hiệu quả chỉ xét dịch vụ có ≥ ${SERVICE_RULES.minBookingsForRanking} đơn.`,
      ...laborCaveats(ledger.meta.laborCoverage),
    ],
    "rank: margin = estimatedProfit / contractValue",
  );
}

// ─── F. Sức khỏe kinh doanh + đề xuất có bằng chứng ───────────────────────────

export type BusinessHealth = {
  health: "healthy" | "warning" | "critical" | "unknown";
  reasonCodes: string[];
  recommendations: Array<{
    action: string;
    evidence: { ids: string[]; amount: number };
    rule: string;
  }>;
};

export const HEALTH_RULES = {
  overdueWarn: 10_000_000, // tổng nợ quá hạn vượt mức này → warning
  overdueCritical: 50_000_000,
  coverageLowRatio: 0.5, // sổ cast phủ dưới 50% đơn hợp lệ → cảnh báo dữ liệu
};

export async function bizBusinessHealth(ym?: string): Promise<Insight<BusinessHealth>> {
  const [overview, debt] = await Promise.all([bizMonthlyOverview(ym), bizDebtInsights(5)]);
  if (!overview.data || !debt.data) {
    return insight("unknown", "tổng hợp từ A + C", null, ["Thiếu dữ liệu nguồn — không kết luận."]);
  }
  const o = overview.data;
  const d = debt.data;
  const reasonCodes: string[] = [];
  const recommendations: BusinessHealth["recommendations"] = [];

  if (o.breakeven.status === "under") reasonCodes.push("BREAKEVEN_UNDER");
  if (d.overdueTotal >= HEALTH_RULES.overdueCritical) reasonCodes.push("OVERDUE_DEBT_CRITICAL");
  else if (d.overdueTotal >= HEALTH_RULES.overdueWarn) reasonCodes.push("OVERDUE_DEBT_HIGH");
  const cov = o.coverage.labor;
  if (cov.eligibleBookingCount > 0 && cov.bookingCountWithEarnings / cov.eligibleBookingCount < HEALTH_RULES.coverageLowRatio) {
    reasonCodes.push("LABOR_LEDGER_COVERAGE_LOW");
  }
  if (o.projectedProfitIfCollectAll >= 0 && o.breakeven.status === "under") {
    reasonCodes.push("RECOVERABLE_IF_COLLECTED"); // thu đủ show của tháng là qua hòa vốn
  }

  // Đề xuất CHỈ từ record thật
  if (d.collectFirst.length) {
    const top = d.collectFirst.slice(0, 3);
    recommendations.push({
      action: `Thu nợ ${top.map(x => `${x.bookingCode ?? "#" + x.bookingId} (${x.customerName ?? "?"}) ${x.receivable.toLocaleString("vi-VN")} đ — quá ${x.daysOverdue} ngày`).join("; ")}`,
      evidence: { ids: top.map(x => x.bookingCode ?? String(x.bookingId)), amount: top.reduce((s, x) => s + x.receivable, 0) },
      rule: "show đã diễn ra xong còn nợ, nợ lớn trước",
    });
  }
  if (reasonCodes.includes("LABOR_LEDGER_COVERAGE_LOW")) {
    recommendations.push({
      action: `Hoàn thiện sổ cast: mới ${cov.bookingCountWithEarnings}/${cov.eligibleBookingCount} đơn có ghi nhận (${cov.earningCount} khoản) — lợi nhuận đang tạm tính cao hơn thực tế.`,
      evidence: { ids: ["staff_job_earnings"], amount: 0 },
      rule: `coverage < ${HEALTH_RULES.coverageLowRatio * 100}% đơn hợp lệ`,
    });
  }

  const health: BusinessHealth["health"] = reasonCodes.includes("OVERDUE_DEBT_CRITICAL")
    ? "critical"
    : reasonCodes.includes("BREAKEVEN_UNDER") || reasonCodes.includes("OVERDUE_DEBT_HIGH")
      ? "warning"
      : "healthy";

  return insight(
    overview.status === "partial" ? "partial" : "ok",
    "tổng hợp A (tháng) + C (công nợ)",
    { health, reasonCodes, recommendations },
    [...overview.caveats],
    `rules: overdue ≥ ${HEALTH_RULES.overdueWarn.toLocaleString("vi-VN")} → warning; ≥ ${HEALTH_RULES.overdueCritical.toLocaleString("vi-VN")} → critical; breakeven under → warning`,
  );
}
