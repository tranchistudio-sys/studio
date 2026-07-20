import { describe, it, expect } from "vitest";
import { serviceDays, serviceDayText, serviceDayTextLines, isMultiDayService, formatDayDate } from "./service-days";

describe("formatDayDate", () => {
  it("chuỗi date YYYY-MM-DD → dd/MM/yyyy, không lệch múi giờ", () => {
    expect(formatDayDate("2026-10-15")).toBe("15/10/2026");
  });

  it("chuỗi ISO có giờ vẫn lấy đúng phần ngày", () => {
    expect(formatDayDate("2026-10-18T00:00:00.000Z")).toBe("18/10/2026");
  });

  it("rỗng/null/rác → chuỗi rỗng (chỗ gọi bỏ qua, không vẽ ngày sai)", () => {
    expect(formatDayDate(null)).toBe("");
    expect(formatDayDate(undefined)).toBe("");
    expect(formatDayDate("")).toBe("");
    expect(formatDayDate("không phải ngày")).toBe("");
  });
});

describe("serviceDays", () => {
  it("dịch vụ 1 ngày → đúng 1 phần tử, total = 1 (giao diện cũ giữ nguyên)", () => {
    const days = serviceDays({ shootDate: "2026-10-15", shootTime: "08:00:00" });
    expect(days).toEqual([{ date: "15/10/2026", time: "08:00", label: null, index: 1, total: 1 }]);
    expect(isMultiDayService({ shootDate: "2026-10-15", shootTime: "08:00" })).toBe(false);
  });

  it("dịch vụ 2 ngày → ngày chính + ngày phụ, đánh số 1..n (case DH của chủ: 15/10 + 18/10)", () => {
    const days = serviceDays({
      shootDate: "2026-10-15",
      shootTime: "08:00:00",
      occurrences: [{ shootDate: "2026-10-18", shootTime: "08:00:00", label: null }],
    });
    expect(days).toHaveLength(2);
    expect(days[0]).toEqual({ date: "15/10/2026", time: "08:00", label: null, index: 1, total: 2 });
    expect(days[1]).toEqual({ date: "18/10/2026", time: "08:00", label: null, index: 2, total: 2 });
    expect(isMultiDayService({ shootDate: "2026-10-15", occurrences: [{ shootDate: "2026-10-18" }] })).toBe(true);
  });

  it("ngày phụ không có giờ → mượn giờ ngày chính", () => {
    const days = serviceDays({
      shootDate: "2026-10-15",
      shootTime: "14:30",
      occurrences: [{ shootDate: "2026-10-18", shootTime: null, label: "Rước dâu" }],
    });
    expect(days[1].time).toBe("14:30");
    expect(days[1].label).toBe("Rước dâu");
  });

  it("nhãn chỉ toàn khoảng trắng → coi như không có nhãn", () => {
    const days = serviceDays({
      shootDate: "2026-10-15",
      occurrences: [{ shootDate: "2026-10-18", label: "   " }],
    });
    expect(days[1].label).toBeNull();
  });

  it("ngày phụ RỖNG không được tính vào tổng số ngày", () => {
    const days = serviceDays({
      shootDate: "2026-10-15",
      occurrences: [{ shootDate: "", label: "rác" }, { shootDate: "2026-10-18" }],
    });
    expect(days).toHaveLength(2);
    expect(days[1]).toMatchObject({ date: "18/10/2026", index: 2, total: 2 });
  });

  it("occurrences thiếu/không phải mảng → không nổ, trả 1 ngày", () => {
    expect(serviceDays({ shootDate: "2026-10-15" })).toHaveLength(1);
    expect(serviceDays({ shootDate: "2026-10-15", occurrences: null })).toHaveLength(1);
    expect(serviceDays(null)).toEqual([{ date: "", time: null, label: null, index: 1, total: 1 }]);
  });

  it("3 ngày → đánh số 1/3, 2/3, 3/3 theo đúng thứ tự server trả", () => {
    const days = serviceDays({
      shootDate: "2026-10-15",
      shootTime: "08:00",
      occurrences: [
        { shootDate: "2026-10-18", label: "Nhà gái" },
        { shootDate: "2026-10-20", label: "Tiệc" },
      ],
    });
    expect(days.map(d => `${d.index}/${d.total} ${d.date}`)).toEqual([
      "1/3 15/10/2026",
      "2/3 18/10/2026",
      "3/3 20/10/2026",
    ]);
  });
});

describe("serviceDayText / serviceDayTextLines (hợp đồng in)", () => {
  it("1 ngày → không có tiền tố 'Ngày', giữ đúng chuỗi cũ", () => {
    expect(serviceDayTextLines({ shootDate: "2026-10-15", shootTime: "08:00:00" }))
      .toEqual(["📅 15/10/2026 • 08:00"]);
  });

  it("2 ngày → mỗi ngày một dòng, có đánh số + nhãn", () => {
    expect(serviceDayTextLines({
      shootDate: "2026-10-15",
      shootTime: "08:00",
      occurrences: [{ shootDate: "2026-10-18", shootTime: "10:00", label: "Rước dâu" }],
    })).toEqual([
      "📅 Ngày 1/2: 15/10/2026 • 08:00",
      "📅 Ngày 2/2: 18/10/2026 • 10:00 — Rước dâu",
    ]);
  });

  it("không có giờ → chỉ hiện ngày", () => {
    expect(serviceDayText({ date: "15/10/2026", time: null, label: null, index: 1, total: 1 }))
      .toBe("📅 15/10/2026");
  });

  it("dịch vụ chưa có ngày → không sinh dòng nào", () => {
    expect(serviceDayTextLines({ shootDate: null })).toEqual([]);
  });
});
