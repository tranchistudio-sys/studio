// Test hàm tài chính DÙNG CHUNG giữa màn "Tổng quan tài chính" và Copilot —
// sự cố 14/07: Copilot phồng 2.000.000 đ vì thiếu lớp loại refund + phiếu thu
// trên đơn CHA rỗng mà /dashboard/simple có.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { pool } from "@workspace/db";
import { getSimpleFinance } from "./finance-summary";

const q = pool.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  q.mockReset();
  q.mockImplementation(async () => ({ rows: [] }));
});

// GĐ1c: chi phí/chi cố định đi qua engineCashOut (cột alias "v"); income
// vẫn là query nội bộ (cột "total"). PR #102: nợ đi qua engineSystemDebt —
// SQL nợ giờ CHỨA "FROM payments" (phân bổ tiền gia đình) nên phải nhận diện
// bằng GREATEST TRƯỚC khi rơi vào nhánh payments.
function mockFinanceRows() {
  q.mockImplementation(async (sql: string) => {
    const s = String(sql);
    if (s.includes("GREATEST")) return { rows: [{ total: "409927995", v: "409927995" }] };
    if (s.includes("FROM payments")) return { rows: [{ total: "34198006", v: "34198006" }] };
    if (s.includes("FROM expenses")) return { rows: [{ total: "15310000", v: "15310000" }] };
    if (s.includes("FROM fixed_costs")) return { rows: [{ total: "37100000", v: "37100000" }] };
    return { rows: [] };
  });
}

describe("getSimpleFinance — đúng nguyên văn công thức /dashboard/simple", () => {
  it("query Đã thu: loại refund + voided + phiếu trên đơn CHA rỗng, đúng tham số from/to", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    q.mockImplementation(async (sql: string, params?: unknown[]) => {
      calls.push({ sql: String(sql), params });
      return { rows: [] };
    });
    await getSimpleFinance("2026-07-01", "2026-07-14");

    const income = calls.find(c => c.sql.includes("FROM payments"));
    expect(income).toBeDefined();
    expect(income!.sql).toContain("payment_type != 'refund'");
    expect(income!.sql).toContain("!= 'voided'");
    // Lớp chống cộng trùng cha rỗng (PR #65) — chính là khoản 2.000.000 đ bị phồng
    expect(income!.sql).toContain("is_parent_contract = true");
    expect(income!.sql).toContain("INTERVAL '1 day'");
    expect(income!.params).toEqual(["2026-07-01", "2026-07-14"]);

    // GĐ1c: chi phí qua engineCashOut — query CHI STUDIO phải lọc đủ quy tắc ②③
    const expense = calls.find(
      c => c.sql.includes("FROM expenses") && c.sql.includes("NOT IN ('personal','loan_principal')"),
    );
    expect(expense, "phải có query chi studio theo quy tắc ②③").toBeDefined();
    expect(expense!.sql).toContain("expense_date");
    expect(expense!.sql).toContain("status IN ('approved','paid')");
    expect(expense!.params).toEqual(["2026-07-01", "2026-07-14"]);

    const debt = calls.find(c => c.sql.includes("GREATEST"));
    expect(debt!.sql).toContain("deleted_at IS NULL"); // predicate countable chuẩn

    const fixed = calls.find(c => c.sql.includes("FROM fixed_costs"));
    expect(fixed!.sql).toContain("active = true");
  });

  it("toán: totalSpent = trực tiếp + cố định; realProfit; breakeven under khi lỗ", async () => {
    mockFinanceRows();
    const f = await getSimpleFinance("2026-07-01", "2026-07-14");
    expect(f.totalIncome).toBe(34198006);
    expect(f.directExpense).toBe(15310000);
    expect(f.fixedCostMonthly).toBe(37100000);
    expect(f.totalSpent).toBe(52410000);
    expect(f.realProfit).toBe(-18211994);
    expect(f.breakeven).toEqual({ status: "under", delta: 18211994 });
    expect(f.customerDebt).toBe(409927995);
  });

  it("breakeven over khi thu vượt chi", async () => {
    q.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes("GREATEST")) return { rows: [{ total: "0", v: "0" }] };
      if (s.includes("FROM payments")) return { rows: [{ total: "60000000", v: "60000000" }] };
      if (s.includes("FROM expenses")) return { rows: [{ total: "10000000", v: "10000000" }] };
      if (s.includes("FROM fixed_costs")) return { rows: [{ total: "20000000", v: "20000000" }] };
      return { rows: [] };
    });
    const f = await getSimpleFinance("2026-07-01", "2026-07-14");
    expect(f.realProfit).toBe(30000000);
    expect(f.breakeven).toEqual({ status: "over", delta: 30000000 });
  });
});
