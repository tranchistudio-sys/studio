import { describe, expect, it } from "vitest";
import {
  parentIdsWithActiveChild,
  hasActiveChildren,
  isEmptyParentContract,
  isActiveBusinessBooking,
  notEmptyParentSql,
  paymentNotOnEmptyParentSql,
  type BookingLike,
} from "./parent-contract";

describe("notEmptyParentSql / paymentNotOnEmptyParentSql — SQL loại cha rỗng", () => {
  it("notEmptyParentSql: giữ đơn không-phải-cha, và cha CÒN con hiệu lực", () => {
    const s = notEmptyParentSql("b");
    expect(s).toContain("NOT b.is_parent_contract");
    expect(s).toContain("EXISTS"); // cha phải còn con hiệu lực
    expect(s).toContain("ac.parent_id = b.id");
    expect(s).toContain("NOT IN ('cancelled', 'temp_quote')");
  });
  it("paymentNotOnEmptyParentSql: loại phiếu ở cha rỗng, giữ ad_hoc/đơn thường", () => {
    const s = paymentNotOnEmptyParentSql("payments");
    expect(s).toContain("payments.booking_id IS NOT NULL");
    expect(s).toContain("zp.is_parent_contract = true");
    expect(s).toContain("NOT EXISTS");
  });
  it("nhận alias tùy biến", () => {
    expect(notEmptyParentSql("bookings")).toContain("bookings.is_parent_contract");
  });
});

// Cụm mẫu: cha 100 còn con sống; cha 200 rỗng (con đã hủy/thùng rác); đơn lẻ 300.
const sample: BookingLike[] = [
  { id: 100, isParentContract: true, status: "confirmed" },
  { id: 1, parentId: 100, status: "confirmed" }, // con sống của 100
  { id: 2, parentId: 100, status: "cancelled" }, // con hủy của 100
  { id: 200, isParentContract: true, status: "confirmed" }, // CHA RỖNG (con đều chết)
  { id: 3, parentId: 200, status: "cancelled" },
  { id: 4, parentId: 200, status: "confirmed", deletedAt: "2026-01-01" }, // thùng rác
  { id: 300, status: "confirmed" }, // đơn lẻ
];

describe("parentIdsWithActiveChild", () => {
  it("chỉ gồm cha còn ≥1 con CÒN HIỆU LỰC", () => {
    const s = parentIdsWithActiveChild(sample);
    expect(s.has(100)).toBe(true); // có con id=1 sống
    expect(s.has(200)).toBe(false); // con đều hủy/thùng rác
  });
  it("con báo giá tạm KHÔNG giữ cha là active", () => {
    const s = parentIdsWithActiveChild([{ id: 9, parentId: 500, status: "temp_quote" }]);
    expect(s.has(500)).toBe(false);
  });
});

describe("isEmptyParentContract / hasActiveChildren", () => {
  const active = parentIdsWithActiveChild(sample);
  it("cha còn con sống → KHÔNG rỗng", () => {
    expect(isEmptyParentContract({ id: 100, isParentContract: true }, active)).toBe(false);
    expect(hasActiveChildren(100, active)).toBe(true);
  });
  it("cha hết con hiệu lực → RỖNG/zombie", () => {
    expect(isEmptyParentContract({ id: 200, isParentContract: true }, active)).toBe(true);
    expect(hasActiveChildren(200, active)).toBe(false);
  });
  it("đơn lẻ / đơn con KHÔNG phải cha rỗng", () => {
    expect(isEmptyParentContract({ id: 300, isParentContract: false }, active)).toBe(false);
    expect(isEmptyParentContract({ id: 1, parentId: 100 }, active)).toBe(false);
  });
});

describe("isActiveBusinessBooking — điều kiện chung tính vào tiền", () => {
  const active = parentIdsWithActiveChild(sample);
  const parentById = new Map(sample.filter(b => b.isParentContract).map(b => [b.id!, b]));
  it("đơn lẻ còn hiệu lực → active", () => {
    expect(isActiveBusinessBooking({ id: 300, status: "confirmed" }, active, parentById)).toBe(true);
  });
  it("cha CÒN con sống → active (giữ để tính cọc ghi ở cha)", () => {
    expect(isActiveBusinessBooking({ id: 100, isParentContract: true, status: "confirmed" }, active, parentById)).toBe(true);
  });
  it("cha RỖNG/zombie → KHÔNG active (cọc treo không tính)", () => {
    expect(isActiveBusinessBooking({ id: 200, isParentContract: true, status: "confirmed" }, active, parentById)).toBe(false);
  });
  it("con còn hiệu lực của cha còn sống → active", () => {
    expect(isActiveBusinessBooking({ id: 1, parentId: 100, status: "confirmed" }, active, parentById)).toBe(true);
  });
  it("con của cha RỖNG (mồ côi) → KHÔNG active", () => {
    // Giả lập 1 con còn sống nhưng cha 200 rỗng: nhưng nếu con này sống thì 200 đã không rỗng.
    // Ca thực tế mồ côi: cha đã hủy/thùng rác. Ở đây kiểm con có cha đã chết:
    const deadParentMap = new Map([[900, { id: 900, isParentContract: true, status: "cancelled" }]]);
    expect(isActiveBusinessBooking({ id: 7, parentId: 900, status: "confirmed" }, new Set([900]), deadParentMap)).toBe(false);
  });
  it("đơn đã hủy/thùng rác → KHÔNG active", () => {
    expect(isActiveBusinessBooking({ id: 8, status: "cancelled" }, active, parentById)).toBe(false);
    expect(isActiveBusinessBooking({ id: 9, status: "confirmed", deletedAt: new Date() }, active, parentById)).toBe(false);
  });
});
