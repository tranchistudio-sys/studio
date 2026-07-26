/**
 * Unit tests cho normalizeItemsAssignedStaffCast + buildPrevManualMap
 * (fix/calendar-full-crew-manual-cast):
 *  - Giá tay áp cho MỌI role (không còn whitelist photographer/makeup).
 *  - Manual 0đ là giá trị hợp lệ (chốt 0 công) — khác "Chưa có giá".
 *  - Non-admin: không bơm được giá tay MỚI/ĐỔI; giá tay trùng DB được giữ.
 *  - Đổi người: giá tay của người cũ KHÔNG lây sang người mới.
 *  - Duplicate staffId+role trong 1 item bị drop.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { state, T } = vi.hoisted(() => {
  const T = {
    staffCastRates:  { _t: "staffCastRates" },
    staffRatePrices: { _t: "staffRatePrices" },
  };
  const state = {
    castRates:  [] as any[],
    staffRates: [] as any[],
  };
  return { state, T };
});

vi.mock("@workspace/db/schema", () => ({
  staffCastRatesTable:  T.staffCastRates,
  staffRatePricesTable: T.staffRatePrices,
}));

vi.mock("drizzle-orm", () => ({
  eq:  (col: any, val: any) => ({ _type: "eq", col, val }),
  and: (...args: any[]) => ({ _type: "and", args }),
}));

vi.mock("@workspace/db", () => {
  function makeSelect() {
    let _table: any;
    const chain = {
      from(table: any) { _table = table; return chain; },
      where(_cond: any): Promise<any[]> {
        if (_table === T.staffCastRates)  return Promise.resolve(state.castRates);
        if (_table === T.staffRatePrices) return Promise.resolve(state.staffRates);
        return Promise.resolve([]);
      },
    };
    return chain;
  }
  return { db: { select: makeSelect } };
});

import { normalizeItemsAssignedStaffCast, buildPrevManualMap } from "./resolve-staff-cast";

type SA = { id?: string; staffId?: number; staffName?: string; role?: string; castAmount?: number; castSource?: string };

function itemWith(assignedStaff: SA[], extra: Record<string, unknown> = {}) {
  return { serviceName: "Gói A", assignedStaff, ...extra };
}
function staffOf(result: unknown[], idx = 0): SA[] {
  return (result[idx] as { assignedStaff: SA[] }).assignedStaff;
}

describe("normalizeItemsAssignedStaffCast — giá tay mọi role", () => {
  beforeEach(() => {
    state.castRates = [];
    state.staffRates = [];
  });

  it("admin: giá tay được GIỮ cho marketing / videographer / assistant / sales", async () => {
    const items = [itemWith([
      { staffId: 1, staffName: "A", role: "marketing",    castAmount: 500_000, castSource: "manual" },
      { staffId: 2, staffName: "B", role: "videographer", castAmount: 700_000, castSource: "manual" },
      { staffId: 3, staffName: "C", role: "assistant",    castAmount: 200_000, castSource: "manual" },
      { staffId: 4, staffName: "D", role: "sales",        castAmount: 900_000, castSource: "manual" },
    ])];
    const out = await normalizeItemsAssignedStaffCast(items, null, { allowManual: true });
    const sa = staffOf(out);
    expect(sa).toHaveLength(4);
    for (const s of sa) {
      expect(s.castSource).toBe("manual");
    }
    expect(sa.map(s => s.castAmount)).toEqual([500_000, 700_000, 200_000, 900_000]);
  });

  it("admin: giá tay 0đ được GIỮ (chốt 0 công), không bị resolve lại theo bảng", async () => {
    // Có bảng rate 300k — nếu manual-0 bị resolve lại sẽ ra 300k (SAI).
    state.staffRates = [{ rate: "300000", rateType: "fixed" }];
    const items = [itemWith([
      { staffId: 5, staffName: "E", role: "photographer", castAmount: 0, castSource: "manual" },
    ])];
    const out = await normalizeItemsAssignedStaffCast(items, null, { allowManual: true });
    const sa = staffOf(out);
    expect(sa[0].castAmount).toBe(0);
    expect(sa[0].castSource).toBe("manual");
  });

  it("non-admin: giá tay MỚI bị resolve lại theo bảng (chặn bơm lương)", async () => {
    state.staffRates = [{ rate: "300000", rateType: "fixed" }];
    const items = [itemWith([
      { staffId: 6, staffName: "F", role: "marketing", castAmount: 9_999_999, castSource: "manual" },
    ])];
    const out = await normalizeItemsAssignedStaffCast(items, null, { allowManual: false });
    const sa = staffOf(out);
    expect(sa[0].castSource).not.toBe("manual");
    expect(sa[0].castAmount).toBe(300_000);
  });

  it("non-admin: giá tay TRÙNG giá đang lưu trong DB được giữ (kể cả 0đ)", async () => {
    const prev = buildPrevManualMap([
      itemWith([
        { staffId: 7, staffName: "G", role: "assistant", castAmount: 250_000, castSource: "manual" },
        { staffId: 8, staffName: "H", role: "makeup",    castAmount: 0,       castSource: "manual" },
      ]),
    ]);
    const items = [itemWith([
      { staffId: 7, staffName: "G", role: "assistant", castAmount: 250_000, castSource: "manual" },
      { staffId: 8, staffName: "H", role: "makeup",    castAmount: 0,       castSource: "manual" },
    ])];
    const out = await normalizeItemsAssignedStaffCast(items, null, { allowManual: false, prevManual: prev });
    const sa = staffOf(out);
    expect(sa[0].castSource).toBe("manual");
    expect(sa[0].castAmount).toBe(250_000);
    expect(sa[1].castSource).toBe("manual");
    expect(sa[1].castAmount).toBe(0);
  });

  it("đổi NGƯỜI: non-admin không mang được giá tay của người cũ sang người mới", async () => {
    // DB đang lưu giá tay 400k cho staff 10; client (non-admin) đổi sang staff 11
    // nhưng vẫn gửi castSource manual 400k → key staffId:role không khớp → resolve lại.
    const prev = buildPrevManualMap([
      itemWith([{ staffId: 10, staffName: "Cũ", role: "photographer", castAmount: 400_000, castSource: "manual" }]),
    ]);
    const items = [itemWith([
      { staffId: 11, staffName: "Mới", role: "photographer", castAmount: 400_000, castSource: "manual" },
    ])];
    const out = await normalizeItemsAssignedStaffCast(items, null, { allowManual: false, prevManual: prev });
    const sa = staffOf(out);
    expect(sa[0].castSource).not.toBe("manual");
    expect(sa[0].castAmount).toBe(0); // không có bảng giá → Chưa có giá
  });

  it("drop duplicate: cùng staffId + cùng role trong 1 item chỉ giữ 1 dòng", async () => {
    const items = [itemWith([
      { staffId: 12, staffName: "K", role: "photographer", castAmount: 100_000, castSource: "manual" },
      { staffId: 12, staffName: "K", role: "photo",        castAmount: 100_000, castSource: "manual" },
      { staffId: 12, staffName: "K", role: "makeup",       castAmount: 150_000, castSource: "manual" },
    ])];
    const out = await normalizeItemsAssignedStaffCast(items, null, { allowManual: true });
    const sa = staffOf(out);
    // photo ≡ photographer (canonical) → bị drop; makeup là role khác → giữ (2 vai trò 2 dòng)
    expect(sa).toHaveLength(2);
    expect(sa.map(s => s.role).sort()).toEqual(["makeup", "photographer"]);
  });

  it("buildPrevManualMap giữ cả entry 0đ", () => {
    const m = buildPrevManualMap([
      itemWith([{ staffId: 9, staffName: "I", role: "support", castAmount: 0, castSource: "manual" }]),
    ]);
    expect(m.get("9:support")).toBe(0);
  });
});
