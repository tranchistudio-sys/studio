// Unit test FINANCIAL ENGINE — GĐ1b-2: cast từ sổ staff_job_earnings (quy tắc ④).
// Mock @workspace/db theo convention repo; kiểm SQL + logic coverage, không cần DB.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { pool } from "@workspace/db";
import {
  engineCastLedger,
  engineCastForCreatedCohort,
  LABOR_COVERAGE_NOTE,
  SALES_COMMISSION_NOTE,
} from "./financial-engine";

const q = pool.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  q.mockReset();
  q.mockImplementation(async () => ({ rows: [] }));
});

describe("engineCastLedger — nguồn cast DUY NHẤT, chống trừ trùng", () => {
  it("SQL: chỉ đọc staff_job_earnings hợp lệ + đơn countable; KHÔNG đụng payroll/advance/tasks", async () => {
    const sqls: string[] = [];
    q.mockImplementation(async (sql: string) => {
      sqls.push(String(sql));
      return { rows: [] };
    });
    await engineCastLedger();
    const castSql = sqls.find(s => s.includes("staff_job_earnings"));
    expect(castSql).toBeDefined();
    // Loại voided/cancelled (quy tắc ② GĐ1b-2)
    expect(castSql).toContain("NOT IN ('voided', 'cancelled')");
    // Mỗi booking một dòng tổng — earning không thể bị cộng 2 lần
    expect(castSql).toContain("GROUP BY e.booking_id");
    // Chỉ đơn hợp lệ
    expect(castSql).toContain("deleted_at IS NULL");
    expect(castSql).toContain("is_parent_contract = false");
    // TUYỆT ĐỐI không cộng thêm nguồn khác
    for (const s of sqls) {
      expect(s).not.toContain("payroll");
      expect(s).not.toContain("advance");
      expect(s).not.toContain("tasks");
    }
  });

  it("map per booking + coverage partial khi chưa phủ hết đơn hợp lệ + đủ 2 câu note", async () => {
    q.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("staff_job_earnings")) {
        return {
          rows: [
            { bid: 10, cast_total: "1200000", cnt: "2" },
            { bid: 20, cast_total: "450000", cnt: "1" },
          ],
        };
      }
      // eligibleBookingCount
      return { rows: [{ v: "256" }] };
    });
    const r = await engineCastLedger();
    expect(r.castByBooking.get(10)).toBe(1200000);
    expect(r.castByBooking.get(20)).toBe(450000);
    expect(r.meta.laborSource).toBe("staff_job_earnings");
    expect(r.meta.salesCommissionIncluded).toBe(false);
    expect(r.meta.laborCoverage).toEqual({
      earningCount: 3,
      bookingCountWithEarnings: 2,
      eligibleBookingCount: 256,
      status: "partial",
    });
    expect(r.meta.notes).toContain(LABOR_COVERAGE_NOTE);
    expect(r.meta.notes).toContain(SALES_COMMISSION_NOTE);
  });

  it("coverage full khi mọi đơn hợp lệ đều có earning → chỉ còn note hoa hồng", async () => {
    q.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("staff_job_earnings")) {
        return { rows: [{ bid: 1, cast_total: "100", cnt: "1" }, { bid: 2, cast_total: "200", cnt: "1" }] };
      }
      return { rows: [{ v: "2" }] };
    });
    const r = await engineCastLedger();
    expect(r.meta.laborCoverage.status).toBe("full");
    expect(r.meta.notes).toEqual([SALES_COMMISSION_NOTE]);
  });
});

describe("engineCastForCreatedCohort — gán theo BOOKING BUCKET (không phải earned_date)", () => {
  it("SQL: bucket theo created_at giờ VN của booking, đúng tham số kỳ", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    q.mockImplementation(async (sql: string, params: unknown[]) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ v: "1650000" }] };
    });
    const v = await engineCastForCreatedCohort("2026-07-01", "2026-07-31");
    expect(v).toBe(1650000);
    expect(calls[0].sql).toContain("b.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ho_Chi_Minh'");
    expect(calls[0].sql).not.toContain("earned_date"); // quyết định mục 3: KHÔNG theo earned_date
    expect(calls[0].sql).toContain("NOT IN ('voided', 'cancelled')");
    expect(calls[0].params).toEqual(["2026-07-01", "2026-07-31"]);
  });
});

// ─── GĐ1e-1: 3 read model cho Business Engine ─────────────────────────────────

import {
  engineOverdueReceivables,
  engineBookingFinance,
  engineServiceRollup,
} from "./financial-engine";

// ─── Helper mock SNAPSHOT (chốt 17/07: engine đọc qua allocator chung) ─────────
// Nhận diện 2 query snapshot + trả seed; query phụ từng hàm xử lý qua `extra`.
type MockRow = Record<string, unknown>;
function mockSnapshot(opts: {
  bookings?: MockRow[];
  payments?: MockRow[];
  extra?: (sql: string, params: unknown[]) => { rows: MockRow[] } | null;
}) {
  return async (sql: string, params: unknown[] = []) => {
    const s = String(sql);
    if (opts.extra) {
      const r = opts.extra(s, params);
      if (r) return r;
    }
    if (s.includes("LEFT JOIN customers c ON c.id = b.customer_id") && s.includes("b.parent_id")) {
      return { rows: opts.bookings ?? [] };
    }
    if (s.includes("FROM payments") && s.includes("payment_type, status")) {
      return { rows: opts.payments ?? [] };
    }
    return { rows: [] };
  };
}
/** Đơn lẻ countable chuẩn cho seed snapshot. */
function bkRow(over: MockRow): MockRow {
  return {
    id: 1, parent_id: null, is_parent_contract: false, status: "confirmed", deleted_at: null,
    total_amount: "0", discount_amount: "0", shoot_date: null, customer_id: null,
    order_code: null, service_label: null, service_category: null, package_type: null,
    customer_name: null, customer_phone: null, ...over,
  };
}

describe("read models GĐ1e-1 — đúng quy tắc ①②③④ trên snapshot allocator chung", () => {
  it("engineOverdueReceivables: nợ từ snapshot + query ngày MAX occurrence (1 dòng/booking), chỉ show đã diễn ra còn nợ", async () => {
    const sqls: string[] = [];
    q.mockImplementation(mockSnapshot({
      bookings: [
        bkRow({ id: 10, total_amount: "5000000", customer_id: 7, order_code: "DH0010", customer_name: "Khách A", shoot_date: "2026-07-01" }),
        bkRow({ id: 11, total_amount: "2000000", customer_id: 7, order_code: "DH0011", shoot_date: "2026-07-02" }), // đã trả đủ → không ra
      ],
      payments: [
        { id: 1, booking_id: 10, amount: "2000000", payment_type: "payment", status: "active" },
        { id: 2, booking_id: 11, amount: "2000000", payment_type: "payment", status: "active" },
      ],
      extra: (s) => {
        sqls.push(s);
        if (s.includes("to_regclass")) return { rows: [{ occ: true, dw: true, wt: true, lc: true }] };
        if (s.includes("days_overdue")) return { rows: [
          { id: 10, last_perf: "2026-07-01", days_overdue: 16 },
          { id: 11, last_perf: "2026-07-02", days_overdue: 15 },
        ] };
        return null;
      },
    }));
    const r = await engineOverdueReceivables();
    // Query ngày vẫn phải đúng quy tắc SQL: countable + MAX occurrence + giờ VN
    const main = sqls.find(s => s.includes("days_overdue"))!;
    expect(main).toContain("deleted_at IS NULL");
    expect(main).toContain("is_parent_contract = false");
    expect(main).toContain("GREATEST(b.shoot_date, COALESCE((SELECT MAX(oc.shoot_date)");
    expect(main).toContain("Asia/Ho_Chi_Minh");
    // Nợ đọc từ snapshot allocator: 5tr − 2tr = 3tr; đơn 11 đã đủ → loại
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ bookingId: 10, bookingCode: "DH0010", receivable: 3_000_000, daysOverdue: 16 });
  });

  it("engineBookingFinance: paid/nợ từ snapshot; cast từ earnings + expense approved/paid direct — KHÔNG tasks/payroll/advance", async () => {
    const sqls: string[] = [];
    q.mockImplementation(mockSnapshot({
      bookings: [bkRow({ id: 10, total_amount: "5000000", customer_id: 7, order_code: "DH0010", service_label: "Ngày cưới", shoot_date: "2026-07-01" })],
      payments: [{ id: 1, booking_id: 10, amount: "1000000", payment_type: "payment", status: "active" }],
      extra: (s) => {
        sqls.push(s);
        if (s.includes("to_regclass")) return { rows: [] };
        if (s.includes("labor_cost")) return { rows: [{ id: 10, shoot_date: "2026-07-01", occ_dates: [], labor_cost: "1200000", direct_expense: "300000" }] };
        return null;
      },
    }));
    const r = await engineBookingFinance();
    const main = sqls.find(s => s.includes("labor_cost"))!;
    expect(main).toContain("staff_job_earnings");
    expect(main).toContain("NOT IN ('voided','cancelled')");
    expect(main).toContain("status IN ('approved','paid')");
    expect(main).not.toContain("tasks");
    expect(main).not.toContain("advance");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      bookingId: 10, netValue: 5_000_000, paid: 1_000_000, receivable: 4_000_000,
      laborCost: 1_200_000, hasLaborLedger: true, approvedDirectExpense: 300_000,
      estimatedProfit: 5_000_000 - 1_200_000 - 300_000,
    });
  });

  it("engineServiceRollup: gộp service_category từ snapshot, cast/expense đúng bộ quy tắc", async () => {
    const sqls: string[] = [];
    q.mockImplementation(mockSnapshot({
      bookings: [
        bkRow({ id: 10, total_amount: "5000000", service_category: "wedding" }),
        bkRow({ id: 11, total_amount: "3000000", service_category: "wedding" }),
      ],
      payments: [{ id: 1, booking_id: 10, amount: "2000000", payment_type: "payment", status: "active" }],
      extra: (s) => {
        sqls.push(s);
        if (s.includes("labor")) return { rows: [
          { id: 10, labor: "1000000", direct_expense: "200000" },
          { id: 11, labor: "0", direct_expense: "0" },
        ] };
        return null;
      },
    }));
    const r = await engineServiceRollup();
    const main = sqls.find(s => s.includes("staff_job_earnings"))!;
    expect(main).toContain("status IN ('approved','paid')");
    expect(main).not.toContain("tasks");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      service: "wedding", bookingCount: 2, contractValue: 8_000_000,
      collected: 2_000_000, receivable: 6_000_000,
      laborRecognized: 1_000_000, approvedDirectExpense: 200_000,
      estimatedProfit: 8_000_000 - 1_000_000 - 200_000, bookingsWithLaborLedger: 1,
    });
  });
});

// ─── GĐ1e-2: read cho Copilot — số tiền Copilot đọc TỪ ĐÂY, khớp Engine/Dashboard ─

import {
  engineMonthlyRevenueActivity,
  engineServicePerformance,
  engineUnpaidCustomers,
  engineCustomersByPhone,
} from "./financial-engine";
import { _resetSchemaFlagsCache } from "../schema-compat";

describe("read models GĐ1e-2 — Copilot đọc số tiền, KHÔNG tự SQL nữa", () => {
  it("engineMonthlyRevenueActivity: đã thu = engineCashIn (cùng lọc dashboard) + đếm phiếu/đơn, không trộn scope", async () => {
    const sqls: string[] = [];
    q.mockImplementation(async (sql: string) => {
      sqls.push(String(sql));
      return { rows: [{ v: "0" }] };
    });
    await engineMonthlyRevenueActivity("2026-07-01", "2026-07-31");
    const collected = sqls.find(s => s.includes("SUM(amount"))!;
    // Đã thu: cùng cửa sổ + lọc với Dashboard (nửa mở phải, loại voided/refund/cha rỗng)
    expect(collected).toContain("paid_at < ($2::date + INTERVAL '1 day')");
    expect(collected).toContain("!= 'voided'");
    expect(collected).toContain("!= 'refund'");
    expect(collected).toContain("is_parent_contract = true");
    // Đếm đơn theo shoot_date (scope vận hành) — KHÔNG trộn với payment scope
    const bookingCnt = sqls.find(s => s.includes("FROM bookings b") && s.includes("COUNT(*)"))!;
    expect(bookingCnt).toContain("b.shoot_date >=");
    expect(bookingCnt).toContain("deleted_at IS NULL"); // countable ①
  });

  it("engineMonthlyRevenueActivity: mapping số từ cột v (đã thu / phiếu / đơn)", async () => {
    q.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("SUM(amount")) return { rows: [{ v: "24699006" }] };
      if (s.includes("FROM payments")) return { rows: [{ v: "24" }] };
      return { rows: [{ v: "40" }] };
    });
    const r = await engineMonthlyRevenueActivity("2026-07-01", "2026-07-31");
    expect(r).toEqual({ collected: 24699006, paymentCount: 24, bookingCount: 40 });
  });

  it("engineServicePerformance: gộp theo tên gói, countable, doanh thu = Σ total_amount, xếp theo số đơn", async () => {
    const sqls: string[] = [];
    q.mockImplementation(async (sql: string) => {
      sqls.push(String(sql));
      return { rows: [{ package_name: "Gói A", booking_count: "5", revenue: "12000000" }] };
    });
    const r = await engineServicePerformance("2026-07-01", "2026-07-31");
    const main = sqls[0];
    expect(main).toContain("service_packages");
    expect(main).toContain("SUM(CAST(b.total_amount AS numeric))");
    expect(main).toContain("deleted_at IS NULL"); // countable ①
    expect(main).toContain("ORDER BY booking_count DESC");
    expect(r[0]).toEqual({ packageName: "Gói A", bookingCount: 5, revenue: 12000000 });
  });

  it("engineUnpaidCustomers không range: nợ từ snapshot allocator, KHÔNG dò schema, tổng khớp system", async () => {
    const sqls: string[] = [];
    q.mockImplementation(mockSnapshot({
      bookings: [
        bkRow({ id: 10, total_amount: "50000000", customer_id: 7, customer_name: "Khách A", customer_phone: "0900000001" }),
        bkRow({ id: 11, total_amount: "2000000", customer_id: 8, customer_name: "Khách B", customer_phone: "0900000002" }),
      ],
      payments: [
        { id: 1, booking_id: 10, amount: "7201006", payment_type: "payment", status: "active" },
        { id: 2, booking_id: 11, amount: "2000000", payment_type: "payment", status: "active" }, // đủ tiền → không nợ
      ],
      extra: (s) => { sqls.push(s); return null; },
    }));
    const r = await engineUnpaidCustomers();
    expect(sqls.some(s => s.includes("to_regclass"))).toBe(false); // không dò schema khi không range
    expect(r.customers).toHaveLength(1);
    expect(r.customers[0]).toEqual({ name: "Khách A", phone: "0900000001", debt: 42_798_994 });
    expect(r.totalDebt).toBe(42_798_994);
    expect(r.orderCount).toBe(1);
  });

  it("engineUnpaidCustomers có range: membership shoot_date đúng tham số, chỉ đếm đơn trong kỳ", async () => {
    _resetSchemaFlagsCache();
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    q.mockImplementation(mockSnapshot({
      bookings: [
        bkRow({ id: 10, total_amount: "5000000", customer_id: 7, customer_name: "Khách A", customer_phone: "0900000001", shoot_date: "2026-07-10" }),
        bkRow({ id: 11, total_amount: "4000000", customer_id: 8, customer_name: "Khách B", customer_phone: "0900000002", shoot_date: "2026-08-10" }),
      ],
      extra: (s, params) => {
        calls.push({ sql: s, params });
        if (s.includes("to_regclass")) return { rows: [] }; // occurrences off
        if (s.includes("SELECT b.id FROM bookings b WHERE")) return { rows: [{ id: 10 }] }; // chỉ đơn tháng 7
        return null;
      },
    }));
    const r = await engineUnpaidCustomers(15, { start: "2026-07-01", end: "2026-07-31" });
    const member = calls.find(c => c.sql.includes("SELECT b.id FROM bookings b WHERE"))!;
    expect(member.sql).toContain("b.shoot_date >= $1::date AND b.shoot_date <= $2::date");
    expect(member.params).toEqual(["2026-07-01", "2026-07-31"]);
    expect(r.customers).toHaveLength(1); // Khách B chụp tháng 8 — không vào kỳ
    expect(r.customers[0]).toMatchObject({ name: "Khách A", debt: 5_000_000 });
    expect(r.totalDebt).toBe(5_000_000);
  });

  it("engineCustomersByPhone: LIKE %suffix% + nợ/đếm đơn từ snapshot", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    q.mockImplementation(mockSnapshot({
      bookings: [
        bkRow({ id: 10, total_amount: "300000", customer_id: 7 }),
        bkRow({ id: 11, total_amount: "200000", customer_id: 7 }),
        bkRow({ id: 12, total_amount: "0", customer_id: 7 }),
      ],
      payments: [],
      extra: (s, params) => {
        if (s.includes("c.phone LIKE $1")) {
          calls.push({ sql: s, params });
          return { rows: [{ id: 7, name: "Khách B", phone: "0912345678" }] };
        }
        return null;
      },
    }));
    const r = await engineCustomersByPhone("123456789");
    expect(calls[0].params).toEqual(["%123456789%", 5]);
    expect(r[0]).toEqual({ name: "Khách B", phone: "0912345678", bookingCount: 3, debt: 500_000 });
  });
});
