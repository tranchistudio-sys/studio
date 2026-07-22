import { describe, it, expect, vi } from "vitest";

// Mock DB để import module không mở kết nối (business-snapshot kéo theo
// finance-summary/loadAllData vốn import @workspace/db). Chỉ test HÀM THUẦN.
vi.mock("@workspace/db", () => ({ db: {}, pool: { query: vi.fn() } }));
vi.mock("@workspace/db/schema", () => ({
  bookingsTable: {}, expensesTable: {}, paymentsTable: {}, fixedCostsTable: {},
  contractsTable: {}, customersTable: {}, bookingOccurrencesTable: {},
  servicePackagesTable: {}, staffTable: {}, settingsTable: {},
}));

import {
  deriveSnapshot,
  renderBusinessSummary,
  buildBusinessAnalysisPrompt,
  isBusinessOverviewQuestion,
  type PeriodFigures,
  type BusinessSnapshot,
} from "./business-snapshot.js";
import { aiNumbersWithinSources } from "./copilot-composer.js";

function sampleSnapshot(): BusinessSnapshot {
  const current: PeriodFigures & { breakeven: { status: "over" | "under"; delta: number } } = {
    contractValue: 100_000_000,
    collected: 60_000_000,
    directExpense: 20_000_000,
    fixedCostMonthly: 10_000_000,
    totalSpent: 30_000_000,
    realProfit: 30_000_000,
    bookingCount: 10,
    breakeven: { status: "over", delta: 30_000_000 },
  };
  const previous: PeriodFigures = {
    contractValue: 80_000_000,
    collected: 50_000_000,
    directExpense: 18_000_000,
    fixedCostMonthly: 10_000_000,
    totalSpent: 28_000_000,
    realProfit: 20_000_000,
    bookingCount: 8,
  };
  return deriveSnapshot({
    month: "2026-07",
    period: { from: "2026-07-01", to: "2026-07-22", label: "Tháng 7/2026 (tới 22/07)" },
    previousPeriod: { from: "2026-06-01", to: "2026-06-30", label: "Tháng 6/2026" },
    current,
    previous,
    customerDebtNow: 25_000_000,
    caveats: ["Lợi nhuận chưa gồm hoa hồng sale."],
  });
}

describe("deriveSnapshot — App tính SẴN mọi số dẫn xuất (ChatGPT không tính lại)", () => {
  it("trung bình/booking, biên lợi nhuận, tỉ lệ thu đúng công thức", () => {
    const s = sampleSnapshot();
    expect(s.derived.avgCollectedPerBooking).toBe(6_000_000); // 60tr / 10
    expect(s.derived.avgContractPerBooking).toBe(10_000_000); // 100tr / 10
    expect(s.derived.profitMarginPct).toBe(50); // 30/60*100
    expect(s.derived.collectionRatePct).toBe(60); // 60/100*100
  });

  it("% và mức tăng giảm so kỳ trước đúng", () => {
    const s = sampleSnapshot();
    expect(s.deltaVsPrevious.collectedPct).toBe(20); // (60-50)/50
    expect(s.deltaVsPrevious.contractValuePct).toBe(25); // (100-80)/80
    expect(s.deltaVsPrevious.realProfitPct).toBe(50); // (30-20)/20
    expect(s.deltaVsPrevious.bookingCountPct).toBe(25); // (10-8)/8
    expect(s.deltaVsPrevious.collectedAbs).toBe(10_000_000);
    expect(s.deltaVsPrevious.realProfitAbs).toBe(10_000_000);
    expect(s.deltaVsPrevious.bookingCountAbs).toBe(2);
  });

  it("0 booking → trung bình null; kỳ trước = 0 → % null (không bịa)", () => {
    const s = deriveSnapshot({
      month: "2026-07",
      period: { from: "2026-07-01", to: "2026-07-22", label: "Tháng 7/2026" },
      previousPeriod: { from: "2026-06-01", to: "2026-06-30", label: "Tháng 6/2026" },
      current: {
        contractValue: 0, collected: 0, directExpense: 0, fixedCostMonthly: 0,
        totalSpent: 0, realProfit: 0, bookingCount: 0, breakeven: { status: "under", delta: 0 },
      },
      previous: {
        contractValue: 0, collected: 0, directExpense: 0, fixedCostMonthly: 0,
        totalSpent: 0, realProfit: 0, bookingCount: 0,
      },
      customerDebtNow: 0,
      caveats: [],
    });
    expect(s.derived.avgCollectedPerBooking).toBeNull();
    expect(s.derived.profitMarginPct).toBeNull();
    expect(s.derived.collectionRatePct).toBeNull();
    expect(s.deltaVsPrevious.collectedPct).toBeNull();
    expect(s.deltaVsPrevious.bookingCountPct).toBeNull();
  });

  it("giữ nguyên số THÔ từ engine (không đụng), có scopeNotes + caveats", () => {
    const s = sampleSnapshot();
    expect(s.current.collected).toBe(60_000_000);
    expect(s.current.realProfit).toBe(30_000_000);
    expect(s.customerDebtNow).toBe(25_000_000);
    expect(s.scopeNotes.collected).toMatch(/thuc thu|thực thu|paid_at/i);
    expect(s.caveats.length).toBeGreaterThan(0);
  });
});

describe("isBusinessOverviewQuestion — chỉ bắt câu tổng quan kinh doanh", () => {
  it("khớp các câu tổng quan (kể cả không dấu)", () => {
    for (const q of [
      "Tháng này studio kinh doanh thế nào?",
      "thang nay studio kinh doanh the nao",
      "Tình hình tháng này ra sao?",
      "Tổng quan kinh doanh giúp anh",
      "studio làm ăn thế nào rồi",
    ]) {
      expect(isBusinessOverviewQuestion(q)).toBe(true);
    }
  });

  it("KHÔNG bắt câu cụ thể (đi đường Copilot cũ)", () => {
    for (const q of [
      "Khách nào đang nợ tiền?",
      "Hôm nay có bao nhiêu show?",
      "Doanh thu tháng này bao nhiêu?",
      "Đơn nào trễ hậu kỳ?",
      "",
    ]) {
      expect(isBusinessOverviewQuestion(q)).toBe(false);
    }
  });
});

describe("renderBusinessSummary — câu deterministic từ engine (dự phòng)", () => {
  it("chứa các con số chủ chốt định dạng VND", () => {
    const s = sampleSnapshot();
    const txt = renderBusinessSummary(s);
    expect(txt).toContain("60.000.000đ"); // thực thu
    expect(txt).toContain("30.000.000đ"); // lợi nhuận thực
    expect(txt).toContain("25.000.000đ"); // công nợ
    expect(txt).toContain("Số booking: 10");
    expect(txt).toContain("Biên lợi nhuận: 50%");
  });
});

describe("Guard-compat — snapshot cấp đủ số để ChatGPT phân tích mà không bị chặn", () => {
  it("câu deterministic (mọi số từ snapshot) LỌT qua khoá số", () => {
    const s = sampleSnapshot();
    const summary = renderBusinessSummary(s);
    expect(aiNumbersWithinSources(summary, [JSON.stringify(s), summary])).toBe(true);
  });

  it("câu AI trích ĐÚNG số snapshot + % dẫn xuất → LỌT", () => {
    const s = sampleSnapshot();
    const aiLike =
      "Tháng này thực thu 60.000.000đ, tăng 20% so tháng trước. Lợi nhuận thực 30.000.000đ, biên lợi nhuận 50%. Trung bình mỗi booking thu 6.000.000đ.";
    expect(aiNumbersWithinSources(aiLike, [JSON.stringify(s), renderBusinessSummary(s)])).toBe(true);
  });

  it("câu AI BỊA số tiền (không có trong snapshot) → BỊ CHẶN", () => {
    const s = sampleSnapshot();
    const fabricated = "Dự báo quý tới studio sẽ đạt 999.888.777đ doanh thu.";
    expect(aiNumbersWithinSources(fabricated, [JSON.stringify(s), renderBusinessSummary(s)])).toBe(false);
  });
});

describe("buildBusinessAnalysisPrompt — prompt phân tích, cấm tính lại số", () => {
  it("nhúng JSON snapshot + ràng buộc chỉ-dùng-số-có-sẵn", () => {
    const s = sampleSnapshot();
    const p = buildBusinessAnalysisPrompt(s);
    expect(p).toContain("\"collected\": 60000000");
    expect(p).toMatch(/kh[oô]ng.*t[ií]nh l[aạ]i|đã có sẵn/i);
    expect(p).toContain("deltaVsPrevious");
  });
});
