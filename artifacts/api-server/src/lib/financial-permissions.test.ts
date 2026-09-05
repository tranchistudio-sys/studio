import { describe, expect, it } from "vitest";
import {
  canCollectPayments,
  canViewBookingFinancials,
  canViewRevenueReports,
  normalizeCollectionAmount,
} from "./financial-permissions";

describe("financial permission matrix", () => {
  it("admin xem tài chính đơn, thu tiền và xem báo cáo", () => {
    expect(canViewBookingFinancials("admin")).toBe(true);
    expect(canCollectPayments("admin")).toBe(true);
    expect(canViewRevenueReports("admin")).toBe(true);
  });

  it("staff xem tài chính đơn và thu tiền nhưng không xem báo cáo", () => {
    expect(canViewBookingFinancials("staff")).toBe(true);
    expect(canCollectPayments("staff")).toBe(true);
    expect(canViewRevenueReports("staff")).toBe(false);
  });

  it("khách chưa đăng nhập không có quyền tài chính", () => {
    expect(canViewBookingFinancials(null)).toBe(false);
    expect(canCollectPayments(null)).toBe(false);
    expect(canViewRevenueReports(null)).toBe(false);
  });

  it("chỉ chấp nhận số tiền thu dương, hữu hạn", () => {
    expect(normalizeCollectionAmount(500_000)).toBe(500_000);
    expect(normalizeCollectionAmount("1000000")).toBe(1_000_000);
    expect(normalizeCollectionAmount(0)).toBeNull();
    expect(normalizeCollectionAmount(-1)).toBeNull();
    expect(normalizeCollectionAmount("không hợp lệ")).toBeNull();
  });
});
