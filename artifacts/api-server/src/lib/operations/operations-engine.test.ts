// Unit test OPERATIONS ENGINE — GĐ1e-3: Copilot đọc query vận hành TỪ ĐÂY (zero-SQL).
// Mock @workspace/db theo convention repo; kiểm SQL (predicate/guard) + mapping camelCase.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { pool } from "@workspace/db";
import {
  opsBookingsOnDate,
  opsBookingsInRange,
  opsOverduePostProductionJobs,
  opsStaffWorkload,
  opsAttendance,
  opsPricingPackages,
} from "./operations-engine";

const q = pool.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  q.mockReset();
  q.mockImplementation(async () => ({ rows: [] }));
});

describe("opsBookingsOnDate — lịch 1 ngày, đơn hợp lệ, kèm SĐT", () => {
  it("SQL: shoot_date = $1, countable, có phone; param [date]", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    q.mockImplementation(async (sql: string, params: unknown[]) => {
      calls.push({ sql: String(sql), params });
      return { rows: [] };
    });
    await opsBookingsOnDate("2026-08-01");
    expect(calls[0].sql).toContain("b.shoot_date = $1::date");
    expect(calls[0].sql).toContain("c.phone AS customer_phone");
    expect(calls[0].sql).toContain("deleted_at IS NULL"); // countable
    expect(calls[0].params).toEqual(["2026-08-01"]); // KHÔNG kèm limit (giữ test getTodayBookings)
  });

  it("mapping camelCase + phone", async () => {
    q.mockImplementation(async () => ({
      rows: [{ shoot_date: "2026-08-01", shoot_time: "09:00", order_code: "DH1", package_type: "Cưới", customer_name: "A", customer_phone: "0900" }],
    }));
    const r = await opsBookingsOnDate("2026-08-01");
    expect(r[0]).toEqual({ shootDate: "2026-08-01", shootTime: "09:00", orderCode: "DH1", packageType: "Cưới", customerName: "A", customerPhone: "0900" });
  });
});

describe("opsBookingsInRange — lịch tháng/tuần theo khoảng ngày", () => {
  it("SQL: shoot_date BETWEEN qua >=/<=, countable, limit $3; param [from,to,limit], KHÔNG có phone", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    q.mockImplementation(async (sql: string, params: unknown[]) => {
      calls.push({ sql: String(sql), params });
      return { rows: [] };
    });
    await opsBookingsInRange("2026-07-01", "2026-07-31", 50);
    expect(calls[0].sql).toContain("b.shoot_date >= $1::date AND b.shoot_date <= $2::date");
    expect(calls[0].sql).not.toContain("customer_phone");
    expect(calls[0].params).toEqual(["2026-07-01", "2026-07-31", 50]);
  });
});

describe("opsOverduePostProductionJobs — guard cột deadline TEXT, ngày VN", () => {
  it("SQL dùng substring (không cast trần ::date) + NOW ngày VN + photoshop_jobs mở", async () => {
    let captured = "";
    q.mockImplementation(async (sql: string) => {
      captured = String(sql);
      return { rows: [] };
    });
    await opsOverduePostProductionJobs();
    expect(captured).toContain(String.raw`substring(pj.customer_deadline from '^\d{4}-\d{2}-\d{2}')`);
    expect(captured).toContain(String.raw`substring(pj.deadline_system from '^\d{4}-\d{2}-\d{2}')`);
    expect(captured).not.toContain("pj.customer_deadline::date");
    expect(captured).toContain("NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh'");
    expect(captured).toContain("pj.status NOT IN ('xong_show', 'hoan_thanh')");
  });

  it("mapping camelCase, staff mặc định 'Chưa giao'", async () => {
    q.mockImplementation(async () => ({
      rows: [{ job_code: "J1", order_code: "DH1", customer_name: "B", customer_deadline: "", deadline_system: "2026-07-10 00:00:00", status: "chua_nhan", staff_name: "Chưa giao" }],
    }));
    const r = await opsOverduePostProductionJobs();
    expect(r[0]).toEqual({ jobCode: "J1", orderCode: "DH1", customerName: "B", customerDeadline: "", deadlineSystem: "2026-07-10 00:00:00", status: "chua_nhan", staffName: "Chưa giao" });
  });
});

describe("opsStaffWorkload — job hậu kỳ mở gom theo nhân sự", () => {
  it("SQL: photoshop_jobs active, GROUP BY staff, ORDER job_count DESC", async () => {
    let captured = "";
    q.mockImplementation(async (sql: string) => { captured = String(sql); return { rows: [] }; });
    await opsStaffWorkload();
    expect(captured).toContain("FROM photoshop_jobs");
    expect(captured).toContain("GROUP BY assigned_staff_id, assigned_staff_name");
    expect(captured).toContain("ORDER BY job_count DESC");
  });

  it("mapping: staffName + jobCount number", async () => {
    q.mockImplementation(async () => ({ rows: [{ staff_name: "An", job_count: "7" }] }));
    const r = await opsStaffWorkload();
    expect(r[0]).toEqual({ staffName: "An", jobCount: 7 });
  });
});

describe("opsAttendance — đi trễ sau 08:10 giờ VN, cửa sổ tháng", () => {
  it("SQL: created_at quy đổi UTC↔VN đúng chiều + mốc 08:10 + param [from,to]", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    q.mockImplementation(async (sql: string, params: unknown[]) => { calls.push({ sql: String(sql), params }); return { rows: [] }; });
    await opsAttendance("2026-07-01", "2026-08-01");
    expect(calls[0].sql).toContain("AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ho_Chi_Minh'");
    expect(calls[0].sql).toContain("08:10:00");
    expect(calls[0].params).toEqual(["2026-07-01", "2026-08-01"]);
  });

  it("mapping: lateCount + checkins number", async () => {
    q.mockImplementation(async () => ({ rows: [{ name: "An", late_count: "2", checkins: "20" }] }));
    const r = await opsAttendance("2026-07-01", "2026-08-01");
    expect(r[0]).toEqual({ name: "An", lateCount: 2, checkins: 20 });
  });
});

describe("opsPricingPackages — gói đang mở bán", () => {
  it("SQL: service_packages chưa xóa, join nhóm, order nhóm→tên", async () => {
    let captured = "";
    q.mockImplementation(async (sql: string) => { captured = String(sql); return { rows: [] }; });
    await opsPricingPackages();
    expect(captured).toContain("FROM service_packages p");
    expect(captured).toContain("p.deleted_at IS NULL");
  });

  it("mapping: price number, groupName", async () => {
    q.mockImplementation(async () => ({ rows: [{ code: "G1", name: "Gói A", price: "12000000", description: "x", group_name: "Cưới" }] }));
    const r = await opsPricingPackages();
    expect(r[0]).toEqual({ code: "G1", name: "Gói A", price: 12000000, description: "x", groupName: "Cưới" });
  });
});
