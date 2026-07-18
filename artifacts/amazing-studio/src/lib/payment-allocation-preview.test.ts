import { describe, it, expect } from "vitest";
import {
  previewPaymentAllocation,
  serviceDisplayLabel,
  type AllocationService,
} from "./payment-allocation-preview";

const svc = (over: Partial<AllocationService> & { bookingId: number; remaining: number }): AllocationService => ({
  orderCode: null,
  serviceLabel: null,
  serviceCategory: null,
  packageType: null,
  shootDate: null,
  net: over.remaining,
  equalDeposit: 0,
  directPaid: 0,
  legacyDepositPaid: 0,
  parentFifo: 0,
  allocPaid: 0,
  ...over,
});

// Thứ tự mảng = thứ tự FIFO server (ngày ASC, ID ASC)
const A = svc({ bookingId: 11, serviceLabel: "Chụp cưới", shootDate: "2026-07-20", remaining: 3_000_000 });
const B = svc({ bookingId: 12, serviceLabel: "Quay phóng sự", shootDate: "2026-07-25", remaining: 1_000_000 });
const C = svc({ bookingId: 13, serviceLabel: "Makeup", shootDate: "2026-08-01", remaining: 2_000_000 });

describe("previewPaymentAllocation — FIFO chung hợp đồng", () => {
  it("tiền ít hơn nợ dịch vụ đầu → trừ hết vào dịch vụ đầu", () => {
    const p = previewPaymentAllocation([A, B, C], 2_000_000, "contract");
    expect(p.fills).toEqual([{ bookingId: 11, label: "Chụp cưới", amount: 2_000_000 }]);
    expect(p.overpay).toBe(0);
  });

  it("tiền tràn qua nhiều dịch vụ theo đúng thứ tự FIFO", () => {
    const p = previewPaymentAllocation([A, B, C], 4_500_000, "fifo");
    expect(p.fills).toEqual([
      { bookingId: 11, label: "Chụp cưới", amount: 3_000_000 },
      { bookingId: 12, label: "Quay phóng sự", amount: 1_000_000 },
      { bookingId: 13, label: "Makeup", amount: 500_000 },
    ]);
    expect(p.overpay).toBe(0);
  });

  it("tiền vượt tổng nợ → phần dư thành Khách trả dư", () => {
    const p = previewPaymentAllocation([A, B, C], 7_000_000, "contract");
    expect(p.fills.map(f => f.amount)).toEqual([3_000_000, 1_000_000, 2_000_000]);
    expect(p.overpay).toBe(1_000_000);
  });

  it("dịch vụ đã đủ tiền (remaining 0) bị bỏ qua, không tạo dòng 0đ", () => {
    const paid = svc({ bookingId: 10, remaining: 0, shootDate: "2026-07-01" });
    const p = previewPaymentAllocation([paid, A], 1_000_000, "contract");
    expect(p.fills).toEqual([{ bookingId: 11, label: "Chụp cưới", amount: 1_000_000 }]);
  });
});

describe("previewPaymentAllocation — dịch vụ cụ thể", () => {
  it("trừ dịch vụ được chọn trước, không đụng dịch vụ khác khi đủ chỗ", () => {
    const p = previewPaymentAllocation([A, B, C], 1_500_000, "service", 13);
    expect(p.fills).toEqual([{ bookingId: 13, label: "Makeup", amount: 1_500_000 }]);
    expect(p.overpay).toBe(0);
  });

  it("phần thừa của dịch vụ được chọn tràn FIFO qua dịch vụ khác (đúng allocator)", () => {
    const p = previewPaymentAllocation([A, B, C], 3_500_000, "service", 12);
    expect(p.fills).toEqual([
      { bookingId: 12, label: "Quay phóng sự", amount: 1_000_000 },
      { bookingId: 11, label: "Chụp cưới", amount: 2_500_000 },
    ]);
    expect(p.overpay).toBe(0);
  });

  it("vượt cả tổng nợ gia đình → overpay", () => {
    const p = previewPaymentAllocation([A, B], 5_000_000, "service", 12);
    expect(p.fills.map(f => f.amount)).toEqual([1_000_000, 3_000_000]);
    expect(p.overpay).toBe(1_000_000);
  });

  it("targetBookingId không tồn tại → fallback FIFO chung, tiền không biến mất", () => {
    const p = previewPaymentAllocation([A, B], 500_000, "service", 999);
    expect(p.fills).toEqual([{ bookingId: 11, label: "Chụp cưới", amount: 500_000 }]);
  });
});

describe("previewPaymentAllocation — biên", () => {
  it("amount 0 / âm → không fill, không overpay", () => {
    expect(previewPaymentAllocation([A], 0, "contract")).toEqual({ fills: [], overpay: 0 });
    expect(previewPaymentAllocation([A], -5, "contract")).toEqual({ fills: [], overpay: 0 });
  });

  it("không có dịch vụ nào → toàn bộ thành overpay (hiển thị cảnh báo)", () => {
    const p = previewPaymentAllocation([], 1_000_000, "contract");
    expect(p.fills).toEqual([]);
    expect(p.overpay).toBe(1_000_000);
  });

  it("amount lẻ thập phân bị floor về đồng nguyên", () => {
    const p = previewPaymentAllocation([A], 1000.9, "contract");
    expect(p.fills[0].amount).toBe(1000);
  });
});

describe("serviceDisplayLabel", () => {
  it("ưu tiên serviceLabel → packageType → orderCode → Dịch vụ N", () => {
    expect(serviceDisplayLabel(A, 0)).toBe("Chụp cưới");
    expect(serviceDisplayLabel(svc({ bookingId: 1, remaining: 0, packageType: "Gói A" }), 0)).toBe("Gói A");
    expect(serviceDisplayLabel(svc({ bookingId: 1, remaining: 0, orderCode: "DH0001" }), 0)).toBe("DH0001");
    expect(serviceDisplayLabel(svc({ bookingId: 1, remaining: 0 }), 2)).toBe("Dịch vụ 3");
  });
});
