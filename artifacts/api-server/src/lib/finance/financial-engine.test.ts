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
