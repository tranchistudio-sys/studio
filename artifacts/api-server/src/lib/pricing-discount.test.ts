import { describe, expect, it } from "vitest";
import { resolveDiscount, applyDiscount, discountWindowStatus } from "./pricing-discount";

const NOW = new Date("2026-07-15T10:00:00+07:00"); // giữa tháng 7
const past = "2026-07-01T00:00:00+07:00";
const future = "2026-07-20T00:00:00+07:00";
const longPast = "2026-06-01T00:00:00+07:00";

describe("applyDiscount (giá sau giảm thuần)", () => {
  it("giảm % và số tiền cố định, clamp >= 0", () => {
    expect(applyDiscount(1900000, "percent", 10)).toBe(1710000);
    expect(applyDiscount(1900000, "fixed", 100000)).toBe(1800000);
    expect(applyDiscount(100000, "fixed", 500000)).toBe(0); // không âm
    expect(applyDiscount(1900000, null, 10)).toBe(1900000); // thiếu loại → giữ gốc
  });
});

describe("discountWindowStatus (cửa sổ ngày)", () => {
  it("off khi tắt / value <= 0; scheduled khi chưa tới; expired khi quá hạn; active trong khoảng", () => {
    expect(discountWindowStatus({ enabled: false, type: "percent", value: 10 }, NOW)).toBe("off");
    expect(discountWindowStatus({ enabled: true, type: "percent", value: 0 }, NOW)).toBe("off");
    expect(discountWindowStatus({ enabled: true, type: "percent", value: 10, startDate: future }, NOW)).toBe("scheduled");
    expect(discountWindowStatus({ enabled: true, type: "percent", value: 10, startDate: longPast, endDate: past }, NOW)).toBe("expired");
    expect(discountWindowStatus({ enabled: true, type: "percent", value: 20, startDate: longPast, endDate: null }, NOW)).toBe("active");
  });
});

describe("resolveDiscount (ưu tiên gói > nhóm, KHÔNG cộng dồn)", () => {
  it("giảm % cấp gói", () => {
    const r = resolveDiscount({ basePrice: 1900000, pkg: { enabled: true, type: "percent", value: 10, startDate: past, endDate: future, name: "Ưu đãi mùa cưới" }, now: NOW });
    expect(r).toMatchObject({ finalPrice: 1710000, discountApplied: true, discountSource: "package", savedAmount: 190000, discountName: "Ưu đãi mùa cưới" });
  });

  it("giảm số tiền cố định cấp gói", () => {
    const r = resolveDiscount({ basePrice: 1900000, pkg: { enabled: true, type: "fixed", value: 100000, name: "Giờ vàng" }, now: NOW });
    expect(r).toMatchObject({ finalPrice: 1800000, discountType: "fixed", discountSource: "package" });
  });

  it("giảm cấp NHÓM khi gói không có giảm riêng", () => {
    const r = resolveDiscount({ basePrice: 1000000, group: { enabled: true, type: "percent", value: 10, name: "Ưu đãi nhóm" }, now: NOW });
    expect(r).toMatchObject({ finalPrice: 900000, discountSource: "group" });
  });

  it("gói VÀ nhóm cùng giảm → ưu tiên GÓI, không cộng dồn", () => {
    const r = resolveDiscount({
      basePrice: 1900000,
      group: { enabled: true, type: "percent", value: 10, name: "Nhóm 10%" },
      pkg: { enabled: true, type: "fixed", value: 100000, name: "Gói -100k" },
      now: NOW,
    });
    expect(r.finalPrice).toBe(1800000); // không phải 1710000, không cộng dồn
    expect(r.discountSource).toBe("package");
    expect(r.savedAmount).toBe(100000);
    expect(r.discountName).toBe("Gói -100k");
  });

  it("ưu đãi gói chưa tới ngày (scheduled) → KHÔNG áp", () => {
    const r = resolveDiscount({ basePrice: 1900000, pkg: { enabled: true, type: "percent", value: 10, startDate: future }, now: NOW });
    expect(r).toMatchObject({ discountApplied: false, finalPrice: 1900000, discountSource: "none" });
  });

  it("ưu đãi gói đã hết hạn (expired) → KHÔNG áp", () => {
    const r = resolveDiscount({ basePrice: 1900000, pkg: { enabled: true, type: "percent", value: 10, startDate: longPast, endDate: past }, now: NOW });
    expect(r.discountApplied).toBe(false);
  });

  it("gói value 0 → rớt xuống giảm nhóm", () => {
    const r = resolveDiscount({ basePrice: 1000000, pkg: { enabled: true, type: "percent", value: 0 }, group: { enabled: true, type: "percent", value: 10 }, now: NOW });
    expect(r).toMatchObject({ discountSource: "group", finalPrice: 900000 });
  });

  it("gói scheduled + nhóm active → dùng giảm NHÓM", () => {
    const r = resolveDiscount({ basePrice: 1000000, pkg: { enabled: true, type: "fixed", value: 100000, startDate: future }, group: { enabled: true, type: "percent", value: 10 }, now: NOW });
    expect(r).toMatchObject({ discountSource: "group", finalPrice: 900000 });
  });

  it("giá gốc 0 (liên hệ) → không áp giảm", () => {
    const r = resolveDiscount({ basePrice: 0, pkg: { enabled: true, type: "percent", value: 10 }, now: NOW });
    expect(r.discountSource).toBe("none");
  });
});
