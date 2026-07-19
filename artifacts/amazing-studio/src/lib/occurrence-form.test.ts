/**
 * Test logic "Ngày thực hiện phụ" trên form booking — sự cố 19/07:
 * "+ Thêm ngày" default trùng ngày chính → backend 400 cả lượt lưu → user tưởng
 * "Cập nhật show không có tác dụng". Fix: default không bao giờ trùng + validate
 * TRƯỚC khi gọi API (mirror rule backend planOccurrencesSync).
 */
import { describe, it, expect } from "vitest";
import {
  addDays,
  defaultNewOccurrence,
  findOccurrenceConflict,
  occurrenceRowConflict,
  type OccurrenceFormDraft,
} from "./occurrence-form";

const occ = (shootDate: string, shootTime = "08:00", label = ""): OccurrenceFormDraft =>
  ({ id: null, shootDate, shootTime, label });

describe("addDays — cộng ngày an toàn qua ranh giới tháng/năm", () => {
  it("cộng giữa tháng", () => expect(addDays("2026-10-15", 1)).toBe("2026-10-16"));
  it("cuối tháng → sang tháng mới", () => expect(addDays("2026-10-31", 1)).toBe("2026-11-01"));
  it("cuối năm → sang năm mới", () => expect(addDays("2026-12-31", 1)).toBe("2027-01-01"));
  it("năm nhuận 29/02", () => expect(addDays("2028-02-28", 1)).toBe("2028-02-29"));
  it("chuỗi rác giữ nguyên (không crash)", () => expect(addDays("abc", 1)).toBe("abc"));
});

describe("defaultNewOccurrence — KHÔNG BAO GIỜ trùng ngày chính (root cause 19/07)", () => {
  it("chưa có ngày phụ → mặc định = ngày chính + 1, giờ = giờ ngày chính", () => {
    const d = defaultNewOccurrence("2026-10-15", "08:00", []);
    expect(d.shootDate).toBe("2026-10-16");
    expect(d.shootTime).toBe("08:00");
    expect(d.id).toBeNull();
  });
  it("đã có ngày phụ → mặc định = ngày lớn nhất + 1 (thêm liên tiếp tự tăng)", () => {
    const d = defaultNewOccurrence("2026-10-15", "17:00", [occ("2026-10-16"), occ("2026-10-18")]);
    expect(d.shootDate).toBe("2026-10-19");
    expect(d.shootTime).toBe("17:00");
  });
  it("ngày phụ hiện có TRƯỚC ngày chính → vẫn lấy max (ngày chính) + 1", () => {
    const d = defaultNewOccurrence("2026-10-15", "08:00", [occ("2026-10-10")]);
    expect(d.shootDate).toBe("2026-10-16");
  });
  it("giờ ngày chính rỗng → fallback 08:00", () => {
    expect(defaultNewOccurrence("2026-10-15", "", []).shootTime).toBe("08:00");
  });
  it("ngày chính rỗng (form chưa chọn) → shootDate rỗng, không crash", () => {
    expect(defaultNewOccurrence("", "08:00", []).shootDate).toBe("");
  });
  it("kịch bản screenshot 19/07: chính 15/10 08:00 → default 16/10 08:00, KHÔNG trùng", () => {
    const d = defaultNewOccurrence("2026-10-15", "08:00", []);
    expect(occurrenceRowConflict([d], 0, "2026-10-15", "08:00")).toBe(false);
  });
});

describe("occurrenceRowConflict — cờ đỏ inline từng dòng", () => {
  it("trùng hoàn toàn ngày chính → true", () => {
    expect(occurrenceRowConflict([occ("2026-10-15", "08:00")], 0, "2026-10-15", "08:00")).toBe(true);
  });
  it("cùng ngày KHÁC giờ với ngày chính → false (hợp lệ, backend cho phép)", () => {
    expect(occurrenceRowConflict([occ("2026-10-15", "14:00")], 0, "2026-10-15", "08:00")).toBe(false);
  });
  it("hai dòng phụ trùng nhau → cả hai true", () => {
    const list = [occ("2026-10-16"), occ("2026-10-16")];
    expect(occurrenceRowConflict(list, 0, "2026-10-15", "08:00")).toBe(true);
    expect(occurrenceRowConflict(list, 1, "2026-10-15", "08:00")).toBe(true);
  });
  it("giờ '08:00' vs '08:00:00' vẫn bắt trùng (normalize như backend)", () => {
    expect(occurrenceRowConflict([occ("2026-10-15", "08:00:00" as string)], 0, "2026-10-15", "08:00")).toBe(true);
  });
});

describe("findOccurrenceConflict — validate TRƯỚC submit, chặn lưu nửa chừng hợp đồng gộp", () => {
  it("sạch → null", () => {
    expect(findOccurrenceConflict([
      { serviceLabel: "Dịch vụ 1", shootDate: "2026-10-14", shootTime: "17:00", occurrences: [] },
      { serviceLabel: "Dịch vụ 2", shootDate: "2026-10-15", shootTime: "08:00", occurrences: [occ("2026-10-16")] },
    ])).toBeNull();
  });
  it("Dịch vụ 2 có ngày phụ trùng ngày chính → message kèm TÊN dịch vụ + NGÀY", () => {
    const msg = findOccurrenceConflict([
      { serviceLabel: "", shootDate: "2026-10-14", shootTime: "17:00", occurrences: [] },
      { serviceLabel: "", shootDate: "2026-10-15", shootTime: "08:00", occurrences: [occ("2026-10-15", "08:00")] },
    ]);
    expect(msg).toContain("Dịch vụ 2");
    expect(msg).toContain("15/10/2026");
    expect(msg).toContain("trùng hoàn toàn với ngày chính");
  });
  it("hai ngày phụ trùng nhau trong cùng dịch vụ → message rõ", () => {
    const msg = findOccurrenceConflict([
      { serviceLabel: "Ngoại cảnh", shootDate: "2026-10-15", shootTime: "08:00", occurrences: [occ("2026-10-16"), occ("2026-10-16")] },
    ]);
    expect(msg).toContain("Ngoại cảnh");
    expect(msg).toContain("trùng hoàn toàn ngày + giờ");
  });
  it("hai DỊCH VỤ KHÁC NHAU trùng ngày nhau → KHÔNG lỗi (mỗi dịch vụ một lịch riêng)", () => {
    expect(findOccurrenceConflict([
      { serviceLabel: "A", shootDate: "2026-10-15", shootTime: "08:00", occurrences: [occ("2026-10-16")] },
      { serviceLabel: "B", shootDate: "2026-10-16", shootTime: "08:00", occurrences: [] },
    ])).toBeNull();
  });
  it("dịch vụ dùng serviceLabel trong message khi có", () => {
    const msg = findOccurrenceConflict([
      { serviceLabel: "Tiệc cưới nhà hàng", shootDate: "2026-10-15", shootTime: "08:00", occurrences: [occ("2026-10-15", "08:00")] },
    ]);
    expect(msg).toContain("Tiệc cưới nhà hàng");
  });
});
