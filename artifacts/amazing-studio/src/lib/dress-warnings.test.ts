import { describe, it, expect } from "vitest";
import { shiftYmd, daysBetween, buildDressWarningsByDate, type RentalReminder, type OverdueReminder } from "./dress-warnings";

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

const rental = (o: Partial<RentalReminder>): RentalReminder => ({
  kind: "rental", bookingId: 10, rootId: 10, orderCode: "DH0238", customerName: "Chí Thiện",
  firstDate: "2026-08-05", lastDate: "2026-08-10", pickupDaysBefore: 3, returnDaysAfter: 2,
  dressCodes: [], hasDresses: false, allReturned: false, ...o,
});

describe("rental — acceptance: 2 ngày thực hiện 05/08 + 10/08, mặc định lấy −3 / trả +2", () => {
  const m = buildDressWarningsByDate([rental({})], "2026-08-01");
  it("Sắp lấy đồ ở 02, 03, 04/08 (vàng), KHÔNG gồm ngày thực hiện 05/08", () => {
    expect(m.get("2026-08-02")?.[0].kind).toBe("pickup");
    expect(m.get("2026-08-02")?.[0].label).toContain("Sắp lấy đồ");
    expect(m.get("2026-08-03")?.[0].kind).toBe("pickup");
    expect(m.get("2026-08-04")?.[0].kind).toBe("pickup");
    expect(m.has("2026-08-05")).toBe(false);
    expect(m.has("2026-08-01")).toBe(false);
  });
  it("KHÔNG nhắc trả sau ngày ĐẦU (06→11/08 sạch) — mốc trả phải là ngày CUỐI", () => {
    for (const d of ["2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11"]) {
      expect(m.has(d)).toBe(false);
    }
  });
  it("Nhắc trả đồ đúng 12/08 = ngày CUỐI 10/08 + 2", () => {
    const c = m.get("2026-08-12")?.[0];
    expect(c?.kind).toBe("return");
    expect(c?.label).toContain("Nhắc trả đồ");
    expect(c?.overdue).toBe(false);
  });
});

describe("rental — setting per booking + mã váy + tắt nhắc", () => {
  it("chỉnh N/M: lấy trước 5 ngày, trả sau 1 ngày", () => {
    const m = buildDressWarningsByDate([rental({ pickupDaysBefore: 5, returnDaysAfter: 1 })], "2026-08-01");
    expect(m.get("2026-07-31")?.[0].kind).toBe("pickup"); // 05/08 − 5
    expect(m.get("2026-08-11")?.[0].kind).toBe("return"); // 10/08 + 1
    expect(m.has("2026-08-12")).toBe(false);
  });
  it("N=0 → không nhắc lấy; vẫn nhắc trả", () => {
    const m = buildDressWarningsByDate([rental({ pickupDaysBefore: 0 })], "2026-08-01");
    expect([...m.values()].flat().some(c => c.kind === "pickup")).toBe(false);
    expect(m.get("2026-08-12")?.[0].kind).toBe("return");
  });
  it("mã váy gắn thêm → hiện trong label (không phải điều kiện)", () => {
    const m = buildDressWarningsByDate([rental({ dressCodes: ["V012", "V034"], hasDresses: true })], "2026-08-01");
    expect(m.get("2026-08-02")?.[0].label).toContain("V012, V034");
  });
  it("có váy và TẤT CẢ đã trả → tắt nhắc trả (vẫn còn nhắc lấy nếu chưa tới ngày)", () => {
    const m = buildDressWarningsByDate([rental({ hasDresses: true, allReturned: true })], "2026-08-01");
    expect([...m.values()].flat().some(c => c.kind === "return")).toBe(false);
  });
  it("1 ngày thực hiện: first = last → trả = ngày đó + 2", () => {
    const m = buildDressWarningsByDate([rental({ firstDate: "2026-08-05", lastDate: "2026-08-05" })], "2026-08-01");
    expect(m.get("2026-08-07")?.[0].kind).toBe("return");
  });
});

const overdue = (o: Partial<OverdueReminder>): OverdueReminder => ({
  kind: "overdue", id: 7, bookingId: 22, orderCode: "DH0100", customerName: "HAZI",
  dressCode: "V001", returnDate: "2026-08-01", ...o,
});

describe("overdue — váy thật quá hạn (đòi váy persistent)", () => {
  it("chip đỏ ở ngày trả VÀ bám hôm nay", () => {
    const m = buildDressWarningsByDate([overdue({})], "2026-08-05");
    expect(m.get("2026-08-01")?.[0].overdue).toBe(true);
    expect(m.get("2026-08-05")?.[0].overdue).toBe(true);
    expect(m.get("2026-08-05")?.[0].label).toContain("V001");
  });
});
