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

// ─── Atomic save: occurrences đi kèm PUT /bookings/:id ───────────────────────
import { sanitizeOccurrenceDrafts, planOccurrencesSync } from "./booking-occurrences.js";

describe("sanitizeOccurrenceDrafts — validate TRƯỚC transaction", () => {
  it("không phải mảng → lỗi", () => {
    expect(sanitizeOccurrenceDrafts("x").ok).toBe(false);
    expect(sanitizeOccurrenceDrafts({}).ok).toBe(false);
  });
  it("ngày sai định dạng → lỗi rõ ràng", () => {
    const r = sanitizeOccurrenceDrafts([{ shootDate: "07/08/2026" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("YYYY-MM-DD");
  });
  it("chuẩn hóa: giờ HH:MM:SS → HH:MM, label trim + cắt 120, id lạ → null", () => {
    const r = sanitizeOccurrenceDrafts([
      { id: 5, shootDate: "2026-08-08T00:00:00Z", shootTime: "04:30:00", label: "  Rước dâu  " },
      { id: -1, shootDate: "2026-08-09", shootTime: "", label: "" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.drafts[0]).toEqual({ id: 5, shootDate: "2026-08-08", shootTime: "04:30", label: "Rước dâu" });
      expect(r.drafts[1]).toEqual({ id: null, shootDate: "2026-08-09", shootTime: null, label: null });
    }
  });
  it("quá 30 ngày phụ → lỗi", () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ shootDate: `2026-08-${String((i % 28) + 1).padStart(2, "0")}` }));
    expect(sanitizeOccurrenceDrafts(many).ok).toBe(false);
  });
});

describe("planOccurrencesSync — diff UPDATE in-place, không delete-rồi-create", () => {
  const existing = [{ id: 1 }, { id: 2 }];
  it("đổi ngày của occurrence cũ → toUpdate đúng id, không delete", () => {
    const r = planOccurrencesSync(
      existing,
      [
        { id: 1, shootDate: "2026-08-10", shootTime: "04:30", label: null },
        { id: 2, shootDate: "2026-08-11", shootTime: null, label: "Tiệc" },
      ],
      "2026-08-07",
      "05:00",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.toUpdate.map(u => u.id)).toEqual([1, 2]);
      expect(r.plan.toInsert).toEqual([]);
      expect(r.plan.deleteIds).toEqual([]);
    }
  });
  it("bỏ 1 ngày + thêm 1 ngày mới → delete đúng id cũ, insert cái mới", () => {
    const r = planOccurrencesSync(
      existing,
      [
        { id: 1, shootDate: "2026-08-08", shootTime: null, label: null },
        { id: null, shootDate: "2026-08-12", shootTime: "08:00", label: null },
      ],
      "2026-08-07",
      "05:00",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.toUpdate.map(u => u.id)).toEqual([1]);
      expect(r.plan.toInsert).toEqual([{ shootDate: "2026-08-12", shootTime: "08:00", label: null }]);
      expect(r.plan.deleteIds).toEqual([2]);
    }
  });
  it("id lạ (row đã bị người khác xóa) → hạ xuống insert, không văng lỗi", () => {
    const r = planOccurrencesSync([{ id: 1 }], [{ id: 99, shootDate: "2026-08-09", shootTime: null, label: null }], "2026-08-07", null);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.toInsert).toHaveLength(1);
      expect(r.plan.deleteIds).toEqual([1]);
    }
  });
  it("trùng hoàn toàn ngày+giờ với ngày chính (kể cả ngày chính MỚI trong cùng PUT) → lỗi", () => {
    const r = planOccurrencesSync([], [{ id: null, shootDate: "2026-09-01", shootTime: "08:00", label: null }], "2026-09-01", "08:00");
    expect(r.ok).toBe(false);
  });
  it("2 draft trùng hoàn toàn nhau → lỗi", () => {
    const r = planOccurrencesSync(
      [],
      [
        { id: null, shootDate: "2026-09-02", shootTime: null, label: "A" },
        { id: null, shootDate: "2026-09-02", shootTime: null, label: "B" },
      ],
      "2026-09-01",
      null,
    );
    expect(r.ok).toBe(false);
  });
  it("mảng rỗng → xóa sạch ngày phụ (user đã gỡ hết trên form)", () => {
    const r = planOccurrencesSync(existing, [], "2026-08-07", null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.deleteIds).toEqual([1, 2]);
  });
});
