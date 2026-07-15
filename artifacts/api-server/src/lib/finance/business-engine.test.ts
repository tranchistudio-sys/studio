// Unit test BUSINESS ENGINE — GĐ1e-1: lớp thuần hàm, CHỈ đọc Financial Engine.
// Khóa cứng: 0 SQL, không pool.query; status/caveats trung thực; recommendation
// phải trỏ tới bằng chứng thật; thiếu dữ liệu → missing/unknown, không đoán.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Mock TOÀN BỘ tầng Financial Engine — Business Engine không được đụng DB.
vi.mock("@workspace/db", () => ({
  pool: {
    query: vi.fn(async () => {
      throw new Error("BUSINESS ENGINE KHÔNG ĐƯỢC CHẠM DB");
    }),
  },
}));
vi.mock("./financial-engine", () => ({
  engineCashIn: vi.fn(),
  engineCashOut: vi.fn(),
  engineReceivableForRange: vi.fn(),
  engineSystemDebt: vi.fn(),
  engineAllCustomersFinance: vi.fn(),
  engineCastLedger: vi.fn(),
  engineOverdueReceivables: vi.fn(),
  engineBookingFinance: vi.fn(),
  engineServiceRollup: vi.fn(),
  REVENUE_SCOPES: {
    signedContractValue: { scope: "booking_created_at" },
    collectedAmount: { scope: "payment_date" },
    receivableAmount: { scope: "shoot_date_or_occurrence" },
  },
  LABOR_COVERAGE_NOTE: "NOTE_COVERAGE",
  SALES_COMMISSION_NOTE: "NOTE_COMMISSION",
}));
vi.mock("../finance-summary", () => ({ getSimpleFinance: vi.fn() }));

import { pool } from "@workspace/db";
import * as fin from "./financial-engine";
import { getSimpleFinance } from "../finance-summary";
import {
  bizMonthlyOverview,
  bizCashflowProjection,
  bizDebtInsights,
  bizBookingInsights,
  bizServiceInsights,
  bizBusinessHealth,
} from "./business-engine";

const M = {
  cashIn: fin.engineCashIn as ReturnType<typeof vi.fn>,
  cashOut: fin.engineCashOut as ReturnType<typeof vi.fn>,
  receivable: fin.engineReceivableForRange as ReturnType<typeof vi.fn>,
  systemDebt: fin.engineSystemDebt as ReturnType<typeof vi.fn>,
  customers: fin.engineAllCustomersFinance as ReturnType<typeof vi.fn>,
  ledger: fin.engineCastLedger as ReturnType<typeof vi.fn>,
  overdue: fin.engineOverdueReceivables as ReturnType<typeof vi.fn>,
  bookings: fin.engineBookingFinance as ReturnType<typeof vi.fn>,
  services: fin.engineServiceRollup as ReturnType<typeof vi.fn>,
  simple: getSimpleFinance as ReturnType<typeof vi.fn>,
};

const PARTIAL_LEDGER = {
  castByBooking: new Map<number, number>(),
  meta: {
    laborSource: "staff_job_earnings",
    salesCommissionIncluded: false,
    laborCoverage: { earningCount: 31, bookingCountWithEarnings: 29, eligibleBookingCount: 194, status: "partial" },
    notes: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  M.ledger.mockResolvedValue(PARTIAL_LEDGER);
  M.simple.mockResolvedValue({
    from: "2026-07-01", to: "2026-07-15",
    totalIncome: 22699006, directExpense: 3537000, customerDebt: 448227995,
    fixedCostMonthly: 37100000, totalSpent: 40637000, realProfit: -17937994,
    breakeven: { status: "under", delta: 17937994 },
  });
  M.receivable.mockResolvedValue(42798994);
  M.systemDebt.mockResolvedValue(448227995);
  M.cashIn.mockResolvedValue(22699006);
  M.cashOut.mockResolvedValue({
    studioExpense: 3537000, excludedPersonal: 4480000, excludedNotApproved: 0,
    excludedLoanPrincipal: 0, fixedMonthly: 37100000,
  });
  M.customers.mockResolvedValue(new Map([[150, { totalBookings: 7, totalOwed: 47800000, totalPaid: 5000006, totalDebt: 42799994 }]]));
  M.overdue.mockResolvedValue([
    { bookingId: 99, bookingCode: "DH0099", customerId: 150, customerName: "Trúc Ly", lastPerformanceDate: "2026-07-01", daysOverdue: 14, receivable: 12000000 },
  ]);
  M.bookings.mockResolvedValue([]);
  M.services.mockResolvedValue([]);
});

describe("KHÓA 0 SQL", () => {
  it("source business-engine.ts không chứa pool/SQL", () => {
    const src = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "business-engine.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/pool\.query/);
    expect(src).not.toMatch(/@workspace\/db/);
    expect(src).not.toMatch(/\bSELECT\s/i);
    expect(src).not.toMatch(/\bINSERT\s/i);
    expect(src).not.toMatch(/\bUPDATE\s/i);
  });

  it("chạy đủ 6 capability mà pool.query KHÔNG BAO GIỜ bị gọi", async () => {
    await bizMonthlyOverview("2026-07");
    await bizCashflowProjection("2026-06"); // tháng quá khứ → daysElapsed = daysInMonth
    await bizDebtInsights();
    await bizBookingInsights();
    await bizServiceInsights();
    await bizBusinessHealth("2026-07");
    expect((pool.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe("A. Tổng quan tháng — số đi thẳng từ Engine, không đổi một đồng", () => {
  it("facts giữ nguyên + projected có công thức + status partial khi cast partial", async () => {
    const r = await bizMonthlyOverview("2026-07");
    expect(r.status).toBe("partial"); // cast coverage partial → KHÔNG được nhận là ok
    expect(r.source).toBe("financial-engine");
    expect(r.data?.collected).toBe(22699006);
    expect(r.data?.receivable).toBe(42798994);
    expect(r.data?.spent.total).toBe(40637000);
    expect(r.data?.actualProfit).toBe(-17937994);
    // projected = 22.699.006 + 42.798.994 − 40.637.000 (công thức khai báo)
    expect(r.data?.projectedProfitIfCollectAll).toBe(24861000);
    expect(r.method).toContain("collected + receivable − spent");
    expect(r.caveats.join(" ")).toContain("NOTE_COMMISSION");
    expect(r.data?.coverage.salesCommissionIncluded).toBe(false);
  });
});

describe("B. Dự phóng dòng tiền — method khai báo, thiếu dữ liệu thì missing", () => {
  it("mới 1-2 ngày dữ liệu → missing, KHÔNG đoán", async () => {
    // Tháng hiện tại giả lập bằng fake timers ngày 02
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T12:00:00+07:00"));
    const r = await bizCashflowProjection();
    expect(r.status).toBe("missing");
    expect(r.data).toBeNull();
    expect(r.method).toBe("linear_run_rate");
    vi.useRealTimers();
  });

  it("đủ ngày → ngoại suy tuyến tính đúng số học, status partial", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00+07:00"));
    const r = await bizCashflowProjection();
    expect(r.status).toBe("partial");
    expect(r.method).toBe("linear_run_rate");
    // 22.699.006 / 15 * 31 = 46.911.279 (làm tròn)
    expect(r.data?.projectedCollectedEom).toBe(Math.round((22699006 / 15) * 31));
    expect(r.data?.projectedProfitEom).toBe(
      r.data!.projectedCollectedEom - r.data!.projectedDirectSpendEom - 37100000,
    );
    vi.useRealTimers();
  });
});

describe("C+F. Công nợ + sức khỏe — đề xuất phải có bằng chứng thật", () => {
  it("debt insights giữ nguyên số Engine + overdue rule", async () => {
    const r = await bizDebtInsights();
    expect(r.data?.totalReceivable).toBe(448227995);
    expect(r.data?.topDebtors[0]).toMatchObject({ customerId: 150, debt: 42799994 });
    expect(r.data?.overdueTotal).toBe(12000000);
  });

  it("recommendation trỏ đúng mã đơn + số tiền thật; health warning có reasonCodes", async () => {
    const r = await bizBusinessHealth("2026-07");
    expect(r.data?.health).toBe("warning"); // breakeven under + overdue 12tr ≥ 10tr
    expect(r.data?.reasonCodes).toContain("BREAKEVEN_UNDER");
    expect(r.data?.reasonCodes).toContain("OVERDUE_DEBT_HIGH");
    expect(r.data?.reasonCodes).toContain("LABOR_LEDGER_COVERAGE_LOW");
    expect(r.data?.reasonCodes).toContain("RECOVERABLE_IF_COLLECTED");
    const rec = r.data?.recommendations.find(x => x.rule.includes("nợ lớn trước"));
    expect(rec?.evidence.ids).toContain("DH0099");
    expect(rec?.evidence.amount).toBe(12000000);
    expect(rec?.action).toContain("Trúc Ly");
  });

  it("thiếu nguồn → unknown, không kết luận", async () => {
    M.simple.mockResolvedValue(null);
    const r = await bizBusinessHealth("2026-07");
    expect(["unknown", "partial"]).toContain(r.status);
  });
});

describe("D. Booking — không kết luận 'lời thấp' khi chưa có sổ chi", () => {
  it("đơn không có earnings/chi direct bị LOẠI khỏi lowProfit; watchlist có lý do cụ thể", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00+07:00"));
    M.bookings.mockResolvedValue([
      { bookingId: 1, bookingCode: "DH0001", customerId: 1, customerName: "A", service: "wedding", shootDate: "2026-07-01", occurrenceDates: [], netValue: 10_000_000, paid: 4_000_000, receivable: 6_000_000, laborCost: 3_000_000, hasLaborLedger: true, approvedDirectExpense: 0, estimatedProfit: 7_000_000 },
      { bookingId: 2, bookingCode: "DH0002", customerId: 2, customerName: "B", service: "baby", shootDate: "2026-07-18", occurrenceDates: [], netValue: 5_000_000, paid: 0, receivable: 5_000_000, laborCost: 0, hasLaborLedger: false, approvedDirectExpense: 0, estimatedProfit: 5_000_000 },
    ]);
    const r = await bizBookingInsights();
    // DH0002 không có sổ chi → không nằm trong lowProfit
    expect(r.data?.lowProfit.map(x => x.bookingCode)).toEqual(["DH0001"]);
    // watchlist: DH0001 đã chụp còn nợ; DH0002 show 3 ngày tới chưa cọc
    const w1 = r.data?.watchlist.find(w => w.booking.bookingCode === "DH0001");
    const w2 = r.data?.watchlist.find(w => w.booking.bookingCode === "DH0002");
    expect(w1?.reasons.join(" ")).toContain("còn nợ");
    expect(w2?.reasons.join(" ")).toContain("CHƯA cọc");
    expect(r.method).toContain("watchlist");
    vi.useRealTimers();
  });
});

describe("E. Dịch vụ — ngưỡng tối thiểu + coverage giữ nguyên", () => {
  it("dịch vụ < ngưỡng đơn không được xếp hạng hiệu quả", async () => {
    M.services.mockResolvedValue([
      { service: "wedding", bookingCount: 5, contractValue: 100, collected: 50, receivable: 50, laborRecognized: 10, approvedDirectExpense: 5, estimatedProfit: 85, bookingsWithLaborLedger: 3 },
      { service: "baby", bookingCount: 1, contractValue: 50, collected: 10, receivable: 40, laborRecognized: 0, approvedDirectExpense: 0, estimatedProfit: 50, bookingsWithLaborLedger: 0 },
    ]);
    const r = await bizServiceInsights();
    expect(r.data?.topRevenue.map(s => s.service)).toEqual(["wedding", "baby"]);
    expect(r.data?.topEstimatedProfit.map(s => s.service)).toEqual(["wedding"]); // baby < 3 đơn
    expect(r.data?.lowEfficiency.map(s => s.service)).toEqual(["wedding"]);
    expect(r.status).toBe("partial");
  });
});
