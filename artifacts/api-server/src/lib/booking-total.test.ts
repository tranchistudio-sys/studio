import { describe, it, expect } from "vitest";
import {
  sumOrderLines,
  sumAdditionalServices,
  computeExpectedBookingTotal,
  resolveBookingTotal,
  summarizeItemsForLog,
} from "./booking-total.js";

const fmtVND = (v: unknown) => `${Number(v).toLocaleString("vi-VN")}đ`;

// ── sumOrderLines — mirror calcSubPackageTotal (calendar.tsx) ────────────────
describe("sumOrderLines", () => {
  it("rỗng / không phải mảng → 0", () => {
    expect(sumOrderLines([])).toBe(0);
    expect(sumOrderLines(null)).toBe(0);
    expect(sumOrderLines("x")).toBe(0);
  });

  it("giá dòng đơn thuần", () => {
    expect(sumOrderLines([{ price: 5900000 }])).toBe(5900000);
  });

  it("DH0191 thật: 5.900.000 + phụ thu dòng 600.000 (Hình cổng) = 6.500.000", () => {
    expect(
      sumOrderLines([{ price: 5900000, surcharges: [{ amount: 600000 }] }]),
    ).toBe(6500000);
  });

  it("giảm trừ dòng bị trừ, chặn âm bằng max(0,...)", () => {
    expect(sumOrderLines([{ price: 100, deductions: [{ amount: 30 }] }])).toBe(70);
    expect(sumOrderLines([{ price: 100, deductions: [{ amount: 500 }] }])).toBe(0);
  });

  it("price dạng string (legacy) và fallback unitPrice", () => {
    expect(sumOrderLines([{ price: "1000000" }])).toBe(1000000);
    expect(sumOrderLines([{ unitPrice: 200000 }])).toBe(200000);
  });

  it("content lines của gói (không có giá) → 0 (không đoán bừa)", () => {
    expect(sumOrderLines([{ serviceName: "2 SARE + 3 VEST" }, { serviceName: "PHOTO MASTER" }])).toBe(0);
  });
});

// ── sumAdditionalServices — mirror calcSubExtrasTotal ────────────────────────
describe("sumAdditionalServices", () => {
  it("lọc dòng không hợp lệ (title rỗng / unitPrice 0)", () => {
    expect(sumAdditionalServices([{ title: "", unitPrice: 500 }, { title: "X", unitPrice: 0 }])).toBe(0);
  });

  it("ưu tiên totalPrice, fallback round(qty×unitPrice)", () => {
    expect(sumAdditionalServices([{ title: "Make up bà sui", qty: 2, unitPrice: 600000 }])).toBe(1200000);
    expect(sumAdditionalServices([{ title: "Take care", qty: 2, unitPrice: 500000, totalPrice: 1000000 }])).toBe(1000000);
  });
});

// ── computeExpectedBookingTotal ──────────────────────────────────────────────
describe("computeExpectedBookingTotal", () => {
  it("DH0245 thật: gói 13tr + 3 dịch vụ cộng thêm 3.2tr = 16.2tr", () => {
    const items = [{ price: 13000000 }];
    const extras = [
      { title: "make up tận nhà 2 ngày", qty: 1, unitPrice: 1000000 },
      { title: "make up bà sui 2 ngày", qty: 1, unitPrice: 1200000 },
      { title: "take care 2 ngày", qty: 1, unitPrice: 1000000 },
    ];
    expect(computeExpectedBookingTotal(items, extras)).toBe(16200000);
  });
});

// ── resolveBookingTotal — guard chống lệch total/items ───────────────────────
describe("resolveBookingTotal", () => {
  it("Case hợp lệ: client khớp expected → giữ nguyên, mismatch=false", () => {
    const r = resolveBookingTotal(6500000, [{ price: 5900000, surcharges: [{ amount: 600000 }] }], []);
    expect(r).toEqual({ total: 6500000, mismatch: false, expected: 6500000 });
  });

  it("CASE 5 (sự cố thật): items=6.5tr nhưng client gửi total=22.7tr → TÍNH LẠI 6.5tr, mismatch=true", () => {
    const r = resolveBookingTotal(
      22700000,
      [{ price: 5900000, surcharges: [{ amount: 600000 }] }],
      [],
    );
    expect(r.mismatch).toBe(true);
    expect(r.total).toBe(6500000);
    expect(r.expected).toBe(6500000);
  });

  it("dung sai 1đ cho làm tròn", () => {
    expect(resolveBookingTotal(1000001, [{ price: 1000000 }], []).mismatch).toBe(false);
    expect(resolveBookingTotal(1000002, [{ price: 1000000 }], []).mismatch).toBe(true);
  });

  it("expected=0 (items không mang giá / rỗng) → KHÔNG đối chiếu, giữ tổng client", () => {
    // items từ gói auto-fill (content lines không giá) — không được phá total hợp lệ
    const r1 = resolveBookingTotal(5900000, [{ serviceName: "2 SARE + 3 VEST" }], []);
    expect(r1).toEqual({ total: 5900000, mismatch: false, expected: 0 });
    const r2 = resolveBookingTotal(1000000, [], []);
    expect(r2.mismatch).toBe(false);
    expect(r2.total).toBe(1000000);
  });

  it("client string + extras cùng tham gia đối chiếu", () => {
    const r = resolveBookingTotal("16200000", [{ price: 13000000 }], [
      { title: "extra", qty: 1, unitPrice: 3200000 },
    ]);
    expect(r.mismatch).toBe(false);
  });
});

// ── summarizeItemsForLog — lịch sử chỉnh sửa dịch vụ ─────────────────────────
describe("summarizeItemsForLog", () => {
  it("rỗng → (chưa có dịch vụ)", () => {
    expect(summarizeItemsForLog([], fmtVND)).toBe("(chưa có dịch vụ)");
  });
  it("đếm + tên + tổng tiền", () => {
    const s = summarizeItemsForLog(
      [{ serviceName: "Chụp cổng Luxury", price: 5900000, surcharges: [{ amount: 600000 }] }],
      fmtVND,
    );
    expect(s).toContain("1 dịch vụ");
    expect(s).toContain("Chụp cổng Luxury");
    expect(s).toContain("6.500.000");
  });
});
