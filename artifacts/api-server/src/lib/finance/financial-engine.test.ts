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

describe("read models GĐ1e-1 — đúng quy tắc ①②③④, không nguồn cấm", () => {
  it("engineOverdueReceivables: countable + show đã diễn ra + còn nợ; MAX occurrence (1 dòng/booking)", async () => {
    const sqls: string[] = [];
    q.mockImplementation(async (sql: string) => {
      const s = String(sql);
      sqls.push(s);
      if (s.includes("to_regclass")) return { rows: [{ occ: true, dw: true, wt: true, lc: true }] };
      return { rows: [] };
    });
    await engineOverdueReceivables();
    const main = sqls.find(s => s.includes("days_overdue"));
    expect(main).toBeDefined();
    expect(main).toContain("deleted_at IS NULL");
    expect(main).toContain("is_parent_contract = false");
    expect(main).toContain("GREATEST(b.shoot_date, COALESCE((SELECT MAX(oc.shoot_date)"); // MAX — không JOIN nhân dòng
    expect(main).toContain("Asia/Ho_Chi_Minh");
    expect(main).toContain("> 0"); // còn nợ
  });

  it("engineBookingFinance: cast từ earnings (loại voided/cancelled), expense approved/paid direct — KHÔNG tasks/payroll/advance/personal", async () => {
    const sqls: string[] = [];
    q.mockImplementation(async (sql: string) => {
      const s = String(sql);
      sqls.push(s);
      if (s.includes("to_regclass")) return { rows: [{ occ: false, dw: false, wt: false, lc: false }] };
      return { rows: [] };
    });
    await engineBookingFinance();
    const main = sqls.find(s => s.includes("net_value"));
    expect(main).toBeDefined();
    expect(main).toContain("staff_job_earnings");
    expect(main).toContain("NOT IN ('voided','cancelled')");
    expect(main).toContain("status IN ('approved','paid')");
    expect(main).not.toContain("tasks");
    expect(main).not.toContain("payroll_id IS NULL"); // consumed vẫn tính
    expect(main).not.toContain("advance");
  });

  it("engineServiceRollup: gộp service_category, cùng bộ quy tắc", async () => {
    const sqls: string[] = [];
    q.mockImplementation(async (sql: string) => {
      sqls.push(String(sql));
      return { rows: [] };
    });
    await engineServiceRollup();
    const main = sqls.find(s => s.includes("service_category"));
    expect(main).toBeDefined();
    expect(main).toContain("GROUP BY");
    expect(main).toContain("staff_job_earnings");
    expect(main).toContain("status IN ('approved','paid')");
    expect(main).not.toContain("tasks");
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

  it("engineUnpaidCustomers không range: nợ sống ① + countable, 2 query, tổng khớp system", async () => {
    const sqls: string[] = [];
    q.mockImplementation(async (sql: string) => {
      const s = String(sql);
      sqls.push(s);
      if (s.includes("total_debt")) return { rows: [{ order_cnt: "19", total_debt: "42798994" }] };
      return { rows: [{ name: "Khách A", phone: "0900000001", debt: "42798994" }] };
    });
    const r = await engineUnpaidCustomers();
    expect(sqls).toHaveLength(2); // list + total, KHÔNG dò schema khi không có range
    for (const s of sqls) {
      expect(s).toContain("deleted_at IS NULL");
      // PR #102: nợ sống ① dùng "đã thu PHÂN BỔ" từ payments gốc theo gia đình —
      // không còn tin cột paid_amount.
      expect(s).toContain("GREATEST(0, b.total_amount - COALESCE(b.discount_amount, 0) - (");
      expect(s).toContain("AS family_paid");
      expect(s).not.toContain("COALESCE(b.paid_amount, 0)");
    }
    expect(r.customers[0]).toEqual({ name: "Khách A", phone: "0900000001", debt: 42798994 });
    expect(r.totalDebt).toBe(42798994);
    expect(r.orderCount).toBe(19);
  });

  it("engineUnpaidCustomers có range: thêm membership shoot_date, tham số đúng vị trí", async () => {
    _resetSchemaFlagsCache();
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    q.mockImplementation(async (sql: string, params: unknown[]) => {
      calls.push({ sql: String(sql), params });
      return { rows: [] }; // to_regclass rỗng → occurrences off
    });
    await engineUnpaidCustomers(15, { start: "2026-07-01", end: "2026-07-31" });
    const data = calls.filter(c => !c.sql.includes("to_regclass"));
    expect(data[0].sql).toContain("b.shoot_date >= $2::date AND b.shoot_date <= $3::date");
    expect(data[0].params).toEqual([15, "2026-07-01", "2026-07-31"]);
    expect(data[1].sql).toContain("b.shoot_date >= $1::date AND b.shoot_date <= $2::date");
    expect(data[1].params).toEqual(["2026-07-01", "2026-07-31"]);
  });

  it("engineCustomersByPhone: tra đuôi SĐT + nợ sống ①, LIKE %suffix%", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    q.mockImplementation(async (sql: string, params: unknown[]) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ name: "Khách B", phone: "0912345678", booking_count: "3", debt: "500000" }] };
    });
    const r = await engineCustomersByPhone("123456789");
    expect(calls[0].sql).toContain("c.phone LIKE $1");
    expect(calls[0].sql).toContain("GREATEST(0, b.total_amount");
    expect(calls[0].params).toEqual(["%123456789%", 5]);
    expect(r[0]).toEqual({ name: "Khách B", phone: "0912345678", bookingCount: 3, debt: 500000 });
  });
});
