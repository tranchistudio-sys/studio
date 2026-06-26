import { describe, expect, it } from "vitest";
import {
  money,
  isCollectedPayment,
  isRefundPayment,
  sumCollected,
  sumRefunded,
  computeBookingMoney,
  commissionForStaff,
  isRevenueCountable,
  type MoneyPaymentInput,
} from "./booking-money";

describe("money() — parse số tiền an toàn", () => {
  it("nhận number/string, loại NaN/null về 0", () => {
    expect(money(1000)).toBe(1000);
    expect(money("2500000")).toBe(2500000);
    expect(money("12.50")).toBe(12.5);
    expect(money(null)).toBe(0);
    expect(money(undefined)).toBe(0);
    expect(money("abc")).toBe(0);
    expect(money("")).toBe(0);
    expect(money(NaN)).toBe(0);
  });
});

describe("phân loại phiếu thu", () => {
  const P = (o: Partial<MoneyPaymentInput>): MoneyPaymentInput => ({ amount: 1000, ...o });
  it("đã thu = không hủy, không refund, không ad_hoc", () => {
    expect(isCollectedPayment(P({ paymentType: "payment" }))).toBe(true);
    expect(isCollectedPayment(P({ paymentType: "deposit" }))).toBe(true);
    expect(isCollectedPayment(P({ paymentType: undefined }))).toBe(true); // default 'payment'
    expect(isCollectedPayment(P({ paymentType: "refund" }))).toBe(false);
    expect(isCollectedPayment(P({ paymentType: "ad_hoc" }))).toBe(false);
    expect(isCollectedPayment(P({ paymentType: "payment", status: "voided" }))).toBe(false);
  });
  it("refund = type refund + không hủy", () => {
    expect(isRefundPayment(P({ paymentType: "refund" }))).toBe(true);
    expect(isRefundPayment(P({ paymentType: "refund", status: "voided" }))).toBe(false);
    expect(isRefundPayment(P({ paymentType: "payment" }))).toBe(false);
  });
});

describe("sumCollected / sumRefunded", () => {
  const payments: MoneyPaymentInput[] = [
    { amount: 5_000_000, paymentType: "deposit", status: "active" },
    { amount: 3_000_000, paymentType: "payment", status: "active" },
    { amount: 2_000_000, paymentType: "refund", status: "active" }, // hoàn tiền (lưu dương)
    { amount: 1_000_000, paymentType: "ad_hoc", status: "active" }, // thu lẻ không gắn đơn
    { amount: 9_000_000, paymentType: "payment", status: "voided" }, // phiếu đã hủy
  ];
  it("đã thu chỉ gồm deposit+payment active = 8tr (BỎ refund, ad_hoc, voided)", () => {
    expect(sumCollected(payments)).toBe(8_000_000);
  });
  it("hoàn tiền = 2tr", () => {
    expect(sumRefunded(payments)).toBe(2_000_000);
  });
});

describe("computeBookingMoney — bộ tiền chuẩn", () => {
  it("đơn cơ bản không giảm giá", () => {
    const m = computeBookingMoney({ totalAmount: 10_000_000 }, [
      { amount: 3_000_000, paymentType: "deposit" },
    ]);
    expect(m).toMatchObject({ gross: 10_000_000, discount: 0, net: 10_000_000, paid: 3_000_000, remaining: 7_000_000 });
  });

  it("doanh thu = NET (đã trừ giảm giá) — đơn 50tr giảm 5tr → net 45tr", () => {
    const m = computeBookingMoney({ totalAmount: 50_000_000, discountAmount: 5_000_000 });
    expect(m.gross).toBe(50_000_000);
    expect(m.discount).toBe(5_000_000);
    expect(m.net).toBe(45_000_000);
  });

  it("gộp DỊCH VỤ CỘNG THÊM vào doanh thu", () => {
    const m = computeBookingMoney({ totalAmount: 10_000_000, additionalServicesTotal: 2_000_000, discountAmount: 1_000_000 });
    expect(m.gross).toBe(12_000_000); // 10tr + 2tr cộng thêm
    expect(m.net).toBe(11_000_000); // − 1tr giảm giá
  });

  it("CHẶN giảm giá > giá gốc → net không âm", () => {
    const m = computeBookingMoney({ totalAmount: 5_000_000, discountAmount: 9_000_000 });
    expect(m.discount).toBe(5_000_000); // clamp về gross
    expect(m.net).toBe(0);
  });

  it("KHÔNG cộng refund vào tiền thu (lỗi daily-cashflow)", () => {
    const m = computeBookingMoney({ totalAmount: 10_000_000 }, [
      { amount: 5_000_000, paymentType: "payment" },
      { amount: 2_000_000, paymentType: "refund" }, // phải bị loại
    ]);
    expect(m.paid).toBe(5_000_000);
    expect(m.refunded).toBe(2_000_000);
    expect(m.remaining).toBe(5_000_000);
  });

  it("đã thu vượt net → công nợ = 0 (không âm)", () => {
    const m = computeBookingMoney({ totalAmount: 10_000_000, discountAmount: 2_000_000 }, [
      { amount: 9_000_000, paymentType: "payment" },
    ]);
    expect(m.net).toBe(8_000_000);
    expect(m.remaining).toBe(0);
  });
});

describe("commissionForStaff — hoa hồng theo cấu hình NHÂN VIÊN, trên tiền ĐÃ TRẢ", () => {
  it("Hoa 7%, đơn 10tr đã thu đủ → 700k", () => {
    const m = computeBookingMoney({ totalAmount: 10_000_000 }, [{ amount: 10_000_000, paymentType: "payment" }]);
    const c = commissionForStaff(7, m.commissionable);
    expect(c).toMatchObject({ ratePercent: 7, amount: 700_000, missingConfig: false });
  });

  it("nhân viên khác 5% cùng đơn → 500k (khác Hoa)", () => {
    const m = computeBookingMoney({ totalAmount: 10_000_000 }, [{ amount: 10_000_000, paymentType: "payment" }]);
    expect(commissionForStaff(5, m.commissionable).amount).toBe(500_000);
  });

  it("hoa hồng tính trên tiền ĐÃ TRẢ, không phải tổng đơn — đơn 10tr mới thu 6tr, 7% → 420k", () => {
    const m = computeBookingMoney({ totalAmount: 10_000_000 }, [{ amount: 6_000_000, paymentType: "payment" }]);
    expect(m.commissionable).toBe(6_000_000);
    expect(commissionForStaff(7, m.commissionable).amount).toBe(420_000);
  });

  it("hoa hồng trên tiền đã trả ĐÃ trừ giảm giá (khách trả số sau giảm)", () => {
    // đơn 50tr giảm 5tr → khách trả 45tr; hoa hồng 5% × 45tr = 2.25tr (KHÔNG phải 2.5tr trên giá gốc)
    const m = computeBookingMoney({ totalAmount: 50_000_000, discountAmount: 5_000_000 }, [
      { amount: 45_000_000, paymentType: "payment" },
    ]);
    expect(m.commissionable).toBe(45_000_000);
    expect(commissionForStaff(5, m.commissionable).amount).toBe(2_250_000);
  });

  it("nhân viên CHƯA cấu hình % → KHÔNG tính bừa (0 + missingConfig)", () => {
    expect(commissionForStaff(null, 10_000_000)).toMatchObject({ amount: 0, missingConfig: true });
    expect(commissionForStaff(undefined, 10_000_000)).toMatchObject({ amount: 0, missingConfig: true });
    expect(commissionForStaff("", 10_000_000)).toMatchObject({ amount: 0, missingConfig: true });
  });

  it("rate = 0 (cấu hình rõ ràng 0%) KHÁC với chưa cấu hình", () => {
    expect(commissionForStaff(0, 10_000_000)).toMatchObject({ amount: 0, missingConfig: false });
  });
});

describe("isRevenueCountable — lọc đơn không tính doanh thu", () => {
  it("đơn thường được tính", () => {
    expect(isRevenueCountable({ status: "completed" })).toBe(true);
    expect(isRevenueCountable({ status: "pending" })).toBe(true);
  });
  it("bỏ đơn đã HỦY", () => {
    expect(isRevenueCountable({ status: "cancelled" })).toBe(false);
  });
  it("bỏ đơn trong THÙNG RÁC", () => {
    expect(isRevenueCountable({ status: "completed", deletedAt: "2026-06-20T00:00:00Z" })).toBe(false);
  });
  it("bỏ đơn CHA tổng (đếm con thay vì cha)", () => {
    expect(isRevenueCountable({ status: "pending", isParentContract: true })).toBe(false);
  });
  it("đơn con (parent contract = false) vẫn được tính", () => {
    expect(isRevenueCountable({ status: "pending", isParentContract: false })).toBe(true);
  });
});
