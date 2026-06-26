import { describe, it, expect, vi, beforeEach } from "vitest";

const dbSelectMock = vi.fn();
const poolQueryMock = vi.fn();

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (..._args: unknown[]) => dbSelectMock(),
      }),
    }),
  },
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));
vi.mock("@workspace/db/schema", () => ({
  staffTable: { id: "staffTable.id" },
  staffJobEarningsTable: {
    staffId: "sje.staffId", month: "sje.month", year: "sje.year",
  },
  staffRatePricesTable: {
    staffId: "srp.staffId", role: "srp.role", taskKey: "srp.taskKey",
  },
  staffLeaveRequestsTable: {
    staffId: "slr.staffId", status: "slr.status",
  },
  payrollsTable: {
    staffId: "p.staffId", month: "p.month", year: "p.year",
  },
  serviceJobSplitsTable: {
    serviceId: "sjs.serviceId", role: "sjs.role",
  },
  staffCastRatesTable: {
    staffId: "scr.staffId", role: "scr.role", packageId: "scr.packageId",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
}));

import { computeMonthEstimate } from "./salary-estimate.js";

const STAFF = {
  id: 3,
  baseSalaryAmount: "6000000",
  salary: "6000000",
};

function setupDbForRealtime(opts: {
  existingEarnings?: unknown[];
  payroll?: unknown[];
  leave?: unknown[];
  rates?: unknown[];
  splits?: unknown[];
} = {}) {
  // staff(1) → earnings(2) → payroll(3) → leave(4) → rates/splits per call
  const queue = [
    [STAFF],
    opts.existingEarnings ?? [],
    opts.payroll ?? [],
    opts.leave ?? [],
  ];
  let rateIdx = 0;
  dbSelectMock.mockImplementation(() => {
    if (queue.length > 0) return queue.shift();
    // Subsequent calls are rate/split lookups from resolveEarning
    const r = opts.rates?.[rateIdx] ?? opts.splits?.[rateIdx] ?? [];
    rateIdx++;
    return r;
  });
}

describe("computeMonthEstimate", () => {
  beforeEach(() => {
    dbSelectMock.mockReset();
    poolQueryMock.mockReset();
  });

  it("uses castAmount from assigned_staff (TRUNG booking 324 case)", async () => {
    setupDbForRealtime();
    poolQueryMock.mockResolvedValue({
      rows: [{
        id: 324,
        shoot_date: "2026-05-06",
        package_type: "wedding",
        service_label: "Album Cưới",
        assigned_staff: [{ staffId: 3, role: "photographer", taskKey: "mac_dinh", castAmount: 500000 }],
        total_amount: 5000000,
        items: [{ serviceId: 1, price: 5000000 }],
        photo_count: 0,
      }],
    });

    const r = await computeMonthEstimate(3, 5, 2026);
    expect(r).not.toBeNull();
    expect(r!.showEarnings).toBeGreaterThanOrEqual(500000);
    expect(r!.showItems.some(s => s.bookingId === 324 && s.fromCastAmount)).toBe(true);
    expect(r!.source).toBe("realtime");
  });

  it("realtime source: bonus/penalty/advance = 0 even with attendance data present", async () => {
    setupDbForRealtime();
    poolQueryMock.mockResolvedValue({ rows: [] });
    const r = await computeMonthEstimate(3, 5, 2026);
    expect(r!.bonus).toBe(0);
    expect(r!.penalty).toBe(0);
    expect(r!.advance).toBe(0);
  });

  it("returns paid_payroll source verbatim when payroll status=paid", async () => {
    setupDbForRealtime({
      payroll: [{
        id: 99, status: "paid",
        baseSalary: "6000000", showBonus: "2000000",
        bonus: "500000", advance: "1000000", netSalary: "7500000",
        items: { penalty: 0, leaveDeduction: 0, leaveDaysUsed: 0, leaveDaysCap: 2 },
      }],
    });
    poolQueryMock.mockResolvedValue({ rows: [] });
    const r = await computeMonthEstimate(3, 5, 2026);
    expect(r!.source).toBe("paid_payroll");
    expect(r!.payrollId).toBe(99);
    expect(r!.total).toBe(7500000);
  });

  it("mixes draft_payroll bonus/penalty with realtime show", async () => {
    setupDbForRealtime({
      payroll: [{
        id: 50, status: "draft",
        baseSalary: "0", showBonus: "0",
        bonus: "300000", advance: "200000", netSalary: "0",
        items: { penalty: 50000 },
      }],
    });
    poolQueryMock.mockResolvedValue({ rows: [] });
    const r = await computeMonthEstimate(3, 5, 2026);
    expect(r!.source).toBe("draft_payroll");
    expect(r!.bonus).toBe(300000);
    expect(r!.penalty).toBe(50000);
    expect(r!.advance).toBe(200000);
  });

  // Task #499: helper để mock 1 booking + 1 payment với staff sale percent
  function setupSalePercentBooking(opts: {
    paid: number; total: number; percent: number;
  }) {
    const dbCalls: unknown[][] = [
      [STAFF],                                                        // staffTable
      [],                                                             // existingEarnings
      [{ amount: String(opts.percent), rateType: "percent" }],        // pkgCast (label)
      [{ amount: String(opts.percent), rateType: "percent" }],        // pkgCast (resolveEarning)
      [],                                                             // payrollsTable
      [],                                                             // staffLeaveRequestsTable
    ];
    let dbIdx = 0;
    dbSelectMock.mockImplementation(() => dbCalls[dbIdx++] ?? []);
    poolQueryMock.mockImplementation((sql: string) => {
      if (/FROM bookings/i.test(sql) && /assigned_staff IS NOT NULL/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            id: 801,
            shoot_date: "2026-05-10",
            package_type: "wedding",
            service_label: "Album Cưới",
            assigned_staff: [{ staffId: 3, role: "sale", taskKey: "mac_dinh", castAmount: 0 }],
            total_amount: opts.total,
            items: [{ serviceId: 99, price: opts.total }],
            photo_count: 0,
            service_package_id: 99,
          }],
        });
      }
      if (/FROM payments/i.test(sql)) {
        // Engine query đã filter status='active' → mock chỉ trả paid của active
        return opts.paid > 0
          ? Promise.resolve({ rows: [{ booking_id: 801, paid: String(opts.paid) }] })
          : Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it("Task #499: sale tách Đã thu (140k) + Còn treo (420k), tổng realtime chỉ +140k", async () => {
    setupSalePercentBooking({ paid: 2_000_000, total: 8_000_000, percent: 7 });
    const r = await computeMonthEstimate(3, 5, 2026);
    const sale = r!.showItems.find(s => s.bookingId === 801 && s.role === "sale")!;
    expect(sale.rate).toBe(140_000);
    expect(sale.collectedAmount).toBe(140_000);
    expect(sale.remainingAmount).toBe(420_000);
    expect(sale.collectedBase).toBe(2_000_000);
    expect(sale.remainingBase).toBe(6_000_000);
    // Tổng showEarnings CHỈ cộng collectedAmount, KHÔNG cộng remainingAmount
    expect(r!.showEarnings).toBe(140_000);
  });

  it("Task #499: thanh toán đủ → remainingAmount = 0, không hiển thị Còn treo", async () => {
    setupSalePercentBooking({ paid: 8_000_000, total: 8_000_000, percent: 7 });
    const r = await computeMonthEstimate(3, 5, 2026);
    const sale = r!.showItems.find(s => s.bookingId === 801 && s.role === "sale")!;
    expect(sale.collectedAmount).toBe(560_000);
    expect(sale.remainingAmount).toBe(0);
    expect(sale.remainingBase).toBe(0);
    expect(r!.showEarnings).toBe(560_000);
  });

  it("Task #499: payment void/refund (paid=0) → vẫn hiện Còn treo, không cộng vào showEarnings", async () => {
    // Engine query đã filter COALESCE(status,'active')='active'; mock trả rỗng = chỉ có voided
    setupSalePercentBooking({ paid: 0, total: 8_000_000, percent: 7 });
    const r = await computeMonthEstimate(3, 5, 2026);
    const sale = r!.showItems.find(s => s.bookingId === 801 && s.role === "sale");
    // Vẫn surface để sale biết còn bao nhiêu commission cần follow khách thu
    expect(sale).toBeDefined();
    expect(sale!.collectedBase).toBe(0);
    expect(sale!.collectedAmount).toBe(0);
    expect(sale!.remainingBase).toBe(8_000_000);
    expect(sale!.remainingAmount).toBe(560_000);
    expect(sale!.rate).toBe(0);
    // Tổng lương realtime CHỈ cộng collectedAmount (=0)
    expect(r!.showEarnings).toBe(0);
  });

  it("sale commission = % cast × tiền THỰC THU (payments active)", async () => {
    // Order: staff → earnings → pkgCast(label) → pkgCast(resolveEarning) → payroll → leave
    // (pkgCast lookups chen vào giữa bookings loop, TRƯỚC payroll/leave)
    const dbCalls: unknown[][] = [
      [STAFF],                                       // staffTable
      [],                                            // existingEarnings
      [{ amount: "7", rateType: "percent" }],        // pkgCast (label, called first in our code path)
      [{ amount: "7", rateType: "percent" }],        // pkgCast (resolveEarning)
      [],                                            // payrollsTable
      [],                                            // staffLeaveRequestsTable
    ];
    let dbIdx = 0;
    dbSelectMock.mockImplementation(() => dbCalls[dbIdx++] ?? []);
    poolQueryMock.mockImplementation((sql: string) => {
      if (/FROM bookings/i.test(sql) && /assigned_staff IS NOT NULL/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            id: 501,
            shoot_date: "2026-05-10",
            package_type: "wedding",
            service_label: "Album Cưới",
            assigned_staff: [{ staffId: 3, role: "sale", taskKey: "mac_dinh", castAmount: 0 }],
            total_amount: 10000000,
            items: [{ serviceId: 99, price: 10000000 }],
            photo_count: 0,
            service_package_id: 99,
          }],
        });
      }
      if (/FROM payments/i.test(sql)) {
        // 2 payments active tổng 4tr → 7% = 280k
        return Promise.resolve({ rows: [{ booking_id: 501, paid: "4000000" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const r = await computeMonthEstimate(3, 5, 2026);
    expect(r).not.toBeNull();
    const sale = r!.showItems.find(s => s.bookingId === 501 && s.role === "sale");
    expect(sale).toBeDefined();
    // 7% × 4tr = 280k (KHÔNG phải 7% × 10tr = 700k)
    expect(sale!.rate).toBe(280000);
    expect(sale!.rateType).toBe("percent");
    expect(sale!.percentRate).toBe(7);
    expect(sale!.percentBase).toBe(4000000);
  });

  it("dedups by (booking, role) using persisted earnings (no drift)", async () => {
    setupDbForRealtime({
      existingEarnings: [{
        id: 7, bookingId: 324, role: "photographer",
        serviceKey: "mac_dinh", serviceName: "Album", rate: "450000",
        status: "active",
      }],
    });
    poolQueryMock.mockResolvedValue({
      rows: [{
        id: 324,
        shoot_date: "2026-05-06",
        package_type: "wedding",
        service_label: "Album Cưới",
        assigned_staff: [{ staffId: 3, role: "photographer", taskKey: "mac_dinh", castAmount: 500000 }],
        total_amount: 5000000,
        items: [{ serviceId: 1, price: 5000000 }],
        photo_count: 0,
      }],
    });
    const r = await computeMonthEstimate(3, 5, 2026);
    expect(r!.showEarnings).toBe(450000);
    expect(r!.showItems[0].earningId).toBe(7);
    expect(r!.showItems[0].fromCastAmount).toBe(false);
  });

  it("KHÔNG tính lương earning thuộc booking đã HỦY (cancelled)", async () => {
    setupDbForRealtime({
      existingEarnings: [{
        id: 11, bookingId: 700, role: "photoshop",
        serviceKey: "mac_dinh", serviceName: "Hậu kỳ", rate: "300000",
        status: "active",
      }],
    });
    poolQueryMock.mockImplementation((sql: string) => {
      // pass chính: không có booking gắn staff → earning 700 thành orphan
      if (/FROM bookings/i.test(sql) && /assigned_staff IS NOT NULL/i.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      // pass cuối (orphan meta): booking 700 đã HỦY
      if (/FROM bookings/i.test(sql) && /id = ANY/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: 700, shoot_date: "2026-05-10", package_type: "wedding", service_label: "Album", status: "cancelled" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await computeMonthEstimate(3, 5, 2026);
    expect(r!.showEarnings).toBe(0);
    expect(r!.showItems.some(s => s.bookingId === 700)).toBe(false);
  });

  it("VẪN tính earning orphan nếu booking KHÔNG hủy (đối chứng)", async () => {
    setupDbForRealtime({
      existingEarnings: [{
        id: 11, bookingId: 700, role: "photoshop",
        serviceKey: "mac_dinh", serviceName: "Hậu kỳ", rate: "300000",
        status: "active",
      }],
    });
    poolQueryMock.mockImplementation((sql: string) => {
      if (/FROM bookings/i.test(sql) && /assigned_staff IS NOT NULL/i.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/FROM bookings/i.test(sql) && /id = ANY/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: 700, shoot_date: "2026-05-10", package_type: "wedding", service_label: "Album", status: "completed" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await computeMonthEstimate(3, 5, 2026);
    expect(r!.showEarnings).toBe(300000);
    expect(r!.showItems.some(s => s.bookingId === 700)).toBe(true);
  });
});
