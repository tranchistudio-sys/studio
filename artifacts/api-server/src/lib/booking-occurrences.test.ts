import { describe, it, expect } from "vitest";
import {
  normalizeTime,
  normalizeDate,
  isDuplicateOccurrence,
  occurrenceDayLabel,
} from "./booking-occurrences.js";

describe("normalizeTime", () => {
  it("cắt về HH:MM; null/rỗng → ''", () => {
    expect(normalizeTime("05:00:00")).toBe("05:00");
    expect(normalizeTime("04:30")).toBe("04:30");
    expect(normalizeTime(null)).toBe("");
    expect(normalizeTime(undefined)).toBe("");
  });
});

describe("normalizeDate", () => {
  it("string ISO/datetime → YYYY-MM-DD", () => {
    expect(normalizeDate("2026-08-07")).toBe("2026-08-07");
    expect(normalizeDate("2026-08-07T17:00:00.000Z")).toBe("2026-08-07");
  });
  it("Date → phần ngày UTC (đúng ngày pg lưu)", () => {
    expect(normalizeDate(new Date("2026-08-08T00:00:00.000Z"))).toBe("2026-08-08");
  });
  it("null/undefined → ''", () => {
    expect(normalizeDate(null)).toBe("");
    expect(normalizeDate(undefined)).toBe("");
  });
});

describe("isDuplicateOccurrence — Case 8: chặn trùng hoàn toàn ngày+giờ", () => {
  const main = "2026-08-07";
  const mainTime = "05:00";
  const existing = [
    { id: 1, shootDate: "2026-08-08", shootTime: "04:30" },
  ];

  it("trùng NGÀY CHÍNH của booking → true", () => {
    expect(isDuplicateOccurrence({ shootDate: "2026-08-07", shootTime: "05:00" }, main, mainTime, existing)).toBe(true);
  });
  it("trùng giờ chuẩn hoá (05:00 ≡ 05:00:00) → true", () => {
    expect(isDuplicateOccurrence({ shootDate: "2026-08-07", shootTime: "05:00:00" }, main, mainTime, existing)).toBe(true);
  });
  it("trùng một occurrence khác → true", () => {
    expect(isDuplicateOccurrence({ shootDate: "2026-08-08", shootTime: "04:30" }, main, mainTime, existing)).toBe(true);
  });
  it("cùng ngày KHÁC giờ → không trùng (được phép: 2 buổi cùng ngày)", () => {
    expect(isDuplicateOccurrence({ shootDate: "2026-08-08", shootTime: "14:00" }, main, mainTime, existing)).toBe(false);
  });
  it("ngày+giờ hoàn toàn mới → không trùng", () => {
    expect(isDuplicateOccurrence({ shootDate: "2026-08-09", shootTime: "08:00" }, main, mainTime, existing)).toBe(false);
  });
  it("sửa chính occurrence đó (excludeId) → không tự coi là trùng", () => {
    expect(isDuplicateOccurrence({ shootDate: "2026-08-08", shootTime: "04:30" }, main, mainTime, existing, 1)).toBe(false);
  });
});

describe("occurrenceDayLabel", () => {
  it("có nhãn → 'Ngày x/y — nhãn'", () => {
    expect(occurrenceDayLabel(2, 2, "Rước dâu")).toBe("Ngày 2/2 — Rước dâu");
  });
  it("không nhãn → 'Ngày x/y'", () => {
    expect(occurrenceDayLabel(1, 2, null)).toBe("Ngày 1/2");
    expect(occurrenceDayLabel(2, 3, "  ")).toBe("Ngày 2/3");
  });
});
