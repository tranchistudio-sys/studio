/**
 * Unit tests cho computeBookingEarnings (fix/calendar-full-crew-manual-cast):
 *  - Giá tay role NGOÀI photographer/makeup (marketing/assistant/...) được persist
 *    vào staff_job_earnings khi > 0; sale/photoshop KHÔNG persist.
 *  - Không tạo 2 khoản cho cùng người/role (item manual + booking-level marketing).
 *  - Manual 0đ photographer: không tạo earning VÀ chặn legacy fallback photoId.
 *  - Re-save (delete pending + reinsert) không nhân đôi; earning đã vào payroll
 *    và earning photoshop pending không bị đụng.
 *  - Booking cancelled: dọn pending, không tạo mới.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { state, T } = vi.hoisted(() => {
  const T = {
    staffJobEarnings: { _t: "staffJobEarnings" },
    staffRatePrices:  { _t: "staffRatePrices" },
    staff:            { _t: "staff" },
    bookings:         { _t: "bookings" },
    serviceJobSplits: { _t: "serviceJobSplits" },
    services:         { _t: "services" },
  };
  const state = {
    booking: null as any,
    earnings: [] as any[],
    staffRates: [] as any[],
    splits: [] as any[],
    inserts: [] as any[],
  };
  return { state, T };
});

vi.mock("@workspace/db/schema", () => ({
  staffJobEarningsTable: T.staffJobEarnings,
  staffRatePricesTable:  T.staffRatePrices,
  staffTable:            T.staff,
  bookingsTable:         T.bookings,
  serviceJobSplitsTable: T.serviceJobSplits,
  servicesTable:         T.services,
}));

vi.mock("drizzle-orm", () => ({
  eq:   (col: any, val: any) => ({ _type: "eq", col, val }),
  and:  (...args: any[]) => ({ _type: "and", args }),
  ne:   (col: any, val: any) => ({ _type: "ne", col, val }),
  desc: vi.fn(),
}));

vi.mock("../lib/schema-compat", () => ({
  bookingColumnsCompat: async () => ({}),
}));

vi.mock("@workspace/db", () => {
  function makeSelect(..._args: any[]) {
    let _table: any;
    const chain = {
      from(table: any) { _table = table; return chain; },
      where(_cond: any): Promise<any[]> {
        if (_table === T.bookings)         return Promise.resolve(state.booking ? [state.booking] : []);
        if (_table === T.staffJobEarnings) return Promise.resolve(state.earnings);
        if (_table === T.staffRatePrices)  return Promise.resolve(state.staffRates);
        if (_table === T.serviceJobSplits) return Promise.resolve(state.splits);
        if (_table === T.services)         return Promise.resolve([]);
        return Promise.resolve([]);
      },
      innerJoin() { return chain; },
      orderBy(): Promise<any[]> { return Promise.resolve([]); },
    };
    return chain;
  }
  function makeDelete() {
    return {
      where(_cond: any): Promise<void> {
        // computeBookingEarnings chỉ có 1 lệnh delete: pending + role != photoshop
        // (của đúng booking đang tính — test mỗi lần 1 booking).
        state.earnings = state.earnings.filter(
          e => !(e.status === "pending" && e.role !== "photoshop"),
        );
        return Promise.resolve();
      },
    };
  }
  function makeInsert() {
    return {
      values(rows: any): Promise<void> {
        const arr = Array.isArray(rows) ? rows : [rows];
        state.inserts.push(...arr);
        state.earnings.push(...arr.map((r: any) => ({ ...r })));
        return Promise.resolve();
      },
    };
  }
  return {
    db: {
      select: makeSelect,
      delete: (_t: any) => makeDelete(),
      insert: (_t: any) => makeInsert(),
    },
    pool: { query: vi.fn(async () => ({ rows: [] })) },
  };
});

import { computeBookingEarnings } from "./job-earnings";

function baseBooking(extra: Record<string, unknown> = {}) {
  return {
    id: 100,
    status: "completed",
    deletedAt: null,
    shootDate: "2026-07-14",
    totalAmount: "10000000",
    photoCount: 0,
    packageType: "Chụp cưới",
    items: [] as any[],
    assignedStaff: null as unknown,
    additionalServices: [] as any[],
    ...extra,
  };
}

describe("computeBookingEarnings — giá tay mọi role, chống trùng", () => {
  beforeEach(() => {
    state.booking = null;
    state.earnings = [];
    state.staffRates = [];
    state.splits = [];
    state.inserts = [];
  });

  it("persist giá tay marketing/assistant + SALE thành CÔNG SHOW (role 'sale', nhãn riêng); role khác không manual → realtime-only", async () => {
    state.booking = baseBooking({
      items: [{
        serviceName: "Gói A",
        serviceId: 9,
        price: 10_000_000,
        assignedStaff: [
          { staffId: 1, staffName: "P",  role: "photographer", castAmount: 400_000, castSource: "manual" },
          { staffId: 2, staffName: "M",  role: "makeup",       castAmount: 350_000, castSource: "staff_pricing" },
          { staffId: 7, staffName: "Mk", role: "marketing",    castAmount: 500_000, castSource: "manual" },
          { staffId: 3, staffName: "TL", role: "assistant",    castAmount: 200_000, castSource: "manual" },
          { staffId: 4, staffName: "S",  role: "sales",        castAmount: 999_000, castSource: "manual" },
          { staffId: 5, staffName: "V",  role: "videographer", castAmount: 0,       castSource: "none" },
        ],
      }],
      // Booking-level marketing CÙNG người 7 nhưng taskKey khác — không được tạo khoản thứ 2.
      assignedStaff: { marketing: 7, marketingTask: "chay_ads" },
    });
    // Bảng rate marketing 111k — nếu thiếu guard, booking-level sẽ chèn thêm khoản 111k.
    state.staffRates = [{ rate: "111000", rateType: "fixed" }];

    await computeBookingEarnings(100);

    const roles = state.inserts.map(e => `${e.staffId}:${e.role}:${e.rate}`).sort();
    expect(roles).toEqual([
      "1:photographer:400000",
      "2:makeup:350000",
      "3:assistant:200000",
      "4:sale:999000",
      "7:marketing:500000",
    ]);
    // Sale manual = CÔNG SHOW: persist với role chuẩn 'sale' + nhãn tách bạch hoa hồng
    // (salary-estimate pass1/orphan LUÔN bỏ persisted 'sale' → không cộng lần 2).
    const saleRow = state.inserts.find(e => e.role === "sale")!;
    expect(saleRow.serviceName).toContain("Công show");
    expect(state.inserts.some(e => e.role === "sales")).toBe(false); // role đã chuẩn hoá
    // Videographer không manual → realtime-only.
    expect(state.inserts.some(e => e.role === "videographer")).toBe(false);
    // Marketing chỉ 1 khoản duy nhất (500k giá tay, không kèm 111k booking-level).
    expect(state.inserts.filter(e => e.role === "marketing")).toHaveLength(1);
  });

  it("SALE KHÔNG manual: vẫn không persist (hoa hồng realtime thuần)", async () => {
    state.booking = baseBooking({
      items: [{
        serviceName: "Gói A", serviceId: 9, price: 5_000_000,
        assignedStaff: [
          { staffId: 4, staffName: "S", role: "sales", castAmount: 0, castSource: "none" },
        ],
      }],
    });
    await computeBookingEarnings(100);
    expect(state.inserts).toHaveLength(0);
  });

  it("manual 0đ photographer: không tạo earning VÀ chặn legacy fallback photoId", async () => {
    state.booking = baseBooking({
      items: [{
        serviceName: "Gói A",
        serviceId: 9,
        price: 5_000_000,
        photoId: 1,
        photoTask: "chup_cong",
        assignedStaff: [
          { staffId: 1, staffName: "P", role: "photographer", castAmount: 0, castSource: "manual" },
        ],
      }],
    });
    // Nếu fallback photoId chạy sẽ ra 300k — phải bị chặn vì admin đã chốt 0đ.
    state.staffRates = [{ rate: "300000", rateType: "fixed" }];

    await computeBookingEarnings(100);
    expect(state.inserts).toHaveLength(0);
  });

  it("re-save không nhân đôi; earning đã vào payroll + photoshop pending không bị đụng", async () => {
    state.booking = baseBooking({
      items: [{
        serviceName: "Gói A",
        serviceId: 9,
        price: 5_000_000,
        assignedStaff: [
          { staffId: 3, staffName: "TL", role: "assistant", castAmount: 200_000, castSource: "manual" },
        ],
      }],
    });
    state.earnings = [
      { bookingId: 100, staffId: 1, role: "photographer", rate: "400000", status: "included_in_payroll" },
      { bookingId: 100, staffId: 9, role: "photoshop",    rate: "120000", status: "pending" },
    ];

    await computeBookingEarnings(100);
    await computeBookingEarnings(100); // lưu lần 2 — không được tạo khoản trùng

    const assistantRows = state.earnings.filter(e => e.role === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0].rate).toBe("200000");
    // Khoản đã vào payroll và khoản photoshop pending giữ nguyên.
    expect(state.earnings.some(e => e.status === "included_in_payroll")).toBe(true);
    expect(state.earnings.some(e => e.role === "photoshop" && e.status === "pending")).toBe(true);
  });

  it("REVIEW B1: manual 0đ marketing CHẶN cả nhánh booking-level — không được trả theo bảng", async () => {
    state.booking = baseBooking({
      items: [{
        serviceName: "Gói A",
        serviceId: 9,
        price: 5_000_000,
        assignedStaff: [
          // Admin chốt KHÔNG trả công marketing show này
          { staffId: 7, staffName: "Mk", role: "marketing", castAmount: 0, castSource: "manual" },
        ],
      }],
      // Cùng người đứng marketing booking-level — nếu thiếu guard sẽ trả 111k theo bảng
      assignedStaff: { marketing: 7 },
    });
    state.staffRates = [{ rate: "111000", rateType: "fixed" }];

    await computeBookingEarnings(100);
    expect(state.inserts.filter(e => e.role === "marketing")).toHaveLength(0);
  });

  it("REVIEW B2: earning marketing từ DỊCH VỤ CỘNG THÊM không được nuốt khoản booking-level (hành vi gốc)", async () => {
    state.booking = baseBooking({
      items: [{ serviceName: "Gói A", serviceId: 9, price: 5_000_000, assignedStaff: [] }],
      assignedStaff: { marketing: 7 },
      additionalServices: [{
        id: "extra1", title: "Chạy ads", taskKey: "chay_ads",
        staffAssignments: [{ staffId: 7, role: "marketing", allocatedQty: 1, castAmount: 300_000 }],
      }],
    });
    state.staffRates = [{ rate: "111000", rateType: "fixed" }];

    await computeBookingEarnings(100);
    const mk = state.inserts.filter(e => e.role === "marketing").map(e => e.rate).sort();
    // CẢ 2 khoản: 300k dịch vụ cộng thêm + 111k booking-level — như trên main
    expect(mk).toEqual(["111000", "300000"]);
  });

  it("booking cancelled: dọn pending, không tạo earning mới", async () => {
    state.booking = baseBooking({
      status: "cancelled",
      items: [{
        serviceName: "Gói A",
        assignedStaff: [
          { staffId: 3, staffName: "TL", role: "assistant", castAmount: 200_000, castSource: "manual" },
        ],
      }],
    });
    state.earnings = [
      { bookingId: 100, staffId: 3, role: "assistant", rate: "200000", status: "pending" },
    ];

    await computeBookingEarnings(100);
    expect(state.inserts).toHaveLength(0);
    expect(state.earnings.filter(e => e.status === "pending")).toHaveLength(0);
  });
});
