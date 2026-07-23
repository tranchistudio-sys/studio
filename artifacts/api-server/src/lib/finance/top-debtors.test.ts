import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@workspace/db", () => ({ db: {}, pool: { query: vi.fn() } }));

// Mock engine allocation snapshot — top-debtors CHỈ gộp, không tự tính nợ.
const mockSnap = vi.fn();
vi.mock("./financial-engine.js", () => ({ engineAllocationSnapshot: () => mockSnap() }));

import { getTopDebtors } from "./top-debtors.js";

function member(customerId: number | null, customerName: string | null, debt: number) {
  return { customerId, customerName, debt, bookingId: Math.random(), net: debt, allocPaid: 0 };
}

describe("getTopDebtors — gộp per-khách từ engine (không viết lại công thức nợ)", () => {
  beforeEach(() => mockSnap.mockReset());

  it("gộp nhiều booking cùng khách, sort giảm dần, tính tổng đúng", async () => {
    mockSnap.mockResolvedValue({
      members: [
        member(1, "Anh A", 5_000_000),
        member(2, "Chị B", 12_000_000),
        member(1, "Anh A", 3_000_000), // cùng khách 1 → gộp = 8tr
        member(3, "Anh C", 0), // nợ 0 → bỏ
      ],
    });
    const r = await getTopDebtors(10);
    expect(r.totalDebt).toBe(20_000_000); // 5+12+3
    expect(r.debtors).toEqual([
      { customerId: 2, customerName: "Chị B", bookingCount: 1, owed: 12_000_000 },
      { customerId: 1, customerName: "Anh A", bookingCount: 2, owed: 8_000_000 },
    ]);
  });

  it("limit cắt đúng số khách + kẹp trong [1,50]", async () => {
    mockSnap.mockResolvedValue({
      members: [member(1, "A", 9), member(2, "B", 8), member(3, "C", 7)],
    });
    expect((await getTopDebtors(2)).debtors).toHaveLength(2);
    expect((await getTopDebtors(0)).debtors.length).toBeGreaterThan(0); // 0 → kẹp về hợp lệ
    expect((await getTopDebtors(999)).debtors).toHaveLength(3); // cap 50, chỉ có 3
  });

  it("khách null (đơn chưa gắn khách) gom nhãn riêng, không nổ", async () => {
    mockSnap.mockResolvedValue({ members: [member(null, null, 2_000_000)] });
    const r = await getTopDebtors();
    expect(r.debtors[0].customerId).toBeNull();
    expect(r.debtors[0].owed).toBe(2_000_000);
  });

  it("không ai nợ → rỗng, tổng 0", async () => {
    mockSnap.mockResolvedValue({ members: [member(1, "A", 0)] });
    const r = await getTopDebtors();
    expect(r.debtors).toEqual([]);
    expect(r.totalDebt).toBe(0);
  });
});
