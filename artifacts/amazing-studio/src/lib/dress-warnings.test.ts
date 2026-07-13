import { describe, it, expect } from "vitest";
import { shiftYmd, daysBetween, buildDressWarningsByDate, type DressWarnRow } from "./dress-warnings";

describe("shiftYmd", () => {
  it("cộng/trừ ngày, qua ranh giới tháng", () => {
    expect(shiftYmd("2026-08-05", -3)).toBe("2026-08-02");
    expect(shiftYmd("2026-08-02", -3)).toBe("2026-07-30");
    expect(shiftYmd("2026-08-30", 3)).toBe("2026-09-02");
  });
});

describe("daysBetween", () => {
  it("liệt kê đủ ngày 2 đầu", () => {
    expect(daysBetween("2026-08-02", "2026-08-05")).toEqual(["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"]);
  });
  it("start > end → rỗng", () => {
    expect(daysBetween("2026-08-05", "2026-08-02")).toEqual([]);
  });
});

const row = (o: Partial<DressWarnRow>): DressWarnRow => ({
  id: 1, bookingId: 10, orderCode: "DH0254", customerName: "HAZI",
  pickupDate: "2026-08-05", returnDate: "2026-08-11", status: "reserved", actualReturnDate: null, ...o,
});

describe("buildDressWarningsByDate — cảnh báo LẤY", () => {
  it("chưa lấy (reserved) → chip ĐÚNG 3 ngày trước [pickup−3 .. pickup−1], KHÔNG gồm ngày lấy", () => {
    const m = buildDressWarningsByDate([row({ pickupDate: "2026-08-05", status: "reserved" })], "2026-08-01");
    // lấy 05/08 → chip 02, 03, 04 (KHÔNG có 05)
    expect(m.get("2026-08-02")?.[0].kind).toBe("pickup");
    expect(m.get("2026-08-04")?.[0].kind).toBe("pickup");
    expect(m.has("2026-08-05")).toBe(false); // ngày lấy → KHÔNG
    expect(m.has("2026-08-06")).toBe(false); // sau ngày lấy → không
    expect(m.has("2026-08-01")).toBe(false); // trước pickup−3 → không
  });
  it("đã lấy (picked_up) → KHÔNG còn chip lấy", () => {
    const m = buildDressWarningsByDate([row({ status: "picked_up", returnDate: "2026-08-11" })], "2026-08-06");
    // không có chip 'pickup' nào
    const all = [...m.values()].flat();
    expect(all.some(c => c.kind === "pickup")).toBe(false);
  });
});

describe("buildDressWarningsByDate — cảnh báo TRẢ (persistent)", () => {
  it("còn ở tay khách, chưa quá hạn → chip trả ở ngày trả (không overdue)", () => {
    const m = buildDressWarningsByDate([row({ status: "picked_up", returnDate: "2026-08-11" })], "2026-08-08");
    const c = m.get("2026-08-11")?.[0];
    expect(c?.kind).toBe("return");
    expect(c?.overdue).toBe(false);
  });
  it("QUÁ HẠN chưa trả → chip đỏ ở ngày trả VÀ ở hôm nay (đòi váy)", () => {
    const m = buildDressWarningsByDate([row({ status: "picked_up", returnDate: "2026-08-11" })], "2026-08-20");
    expect(m.get("2026-08-11")?.[0].overdue).toBe(true);
    expect(m.get("2026-08-20")?.[0].overdue).toBe(true); // hôm nay
  });
  it("đã xác nhận trả (actualReturnDate có) → KHÔNG còn chip trả", () => {
    const m = buildDressWarningsByDate([row({ status: "cleaning", actualReturnDate: "2026-08-10", returnDate: "2026-08-11" })], "2026-08-20");
    const all = [...m.values()].flat();
    expect(all.some(c => c.kind === "return")).toBe(false);
  });
  it("đã trả (returned) → không cảnh báo gì", () => {
    const m = buildDressWarningsByDate([row({ status: "returned", actualReturnDate: "2026-08-10" })], "2026-08-20");
    expect([...m.values()].flat().length).toBe(0);
  });
});
