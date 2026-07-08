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
  isSelfLiveBooking,
  buildParentContractMap,
  filterRevenueCountable,
  revenueCountableSql,
  liveBookingSql,
  type CountableBookingInput,
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
  it("bỏ đơn BÁO GIÁ TẠM (temp_quote)", () => {
    expect(isRevenueCountable({ status: "temp_quote" })).toBe(false);
  });
});

describe("isSelfLiveBooking — đơn tự thân còn hiệu lực", () => {
  it("đơn thường còn sống", () => {
    expect(isSelfLiveBooking({ status: "completed" })).toBe(true);
    expect(isSelfLiveBooking({ status: "pending" })).toBe(true);
  });
  it("chết khi thùng rác / hủy / báo giá tạm", () => {
    expect(isSelfLiveBooking({ status: "completed", deletedAt: "2026-06-20" })).toBe(false);
    expect(isSelfLiveBooking({ status: "cancelled" })).toBe(false);
    expect(isSelfLiveBooking({ status: "temp_quote" })).toBe(false);
  });
  it("KHÔNG loại đơn CHA ở tầng self-live (chỉ isRevenueCountable mới loại cha)", () => {
    expect(isSelfLiveBooking({ status: "pending", isParentContract: true })).toBe(true);
  });
});

describe("isRevenueCountable — CON MỒ CÔI của hợp đồng cha đã chết", () => {
  const parent = (over: Partial<CountableBookingInput>): CountableBookingInput => ({
    id: 1, isParentContract: true, status: "confirmed", ...over,
  });
  const child = (over: Partial<CountableBookingInput> = {}): CountableBookingInput => ({
    id: 2, isParentContract: false, parentId: 1, status: "confirmed", ...over,
  });

  it("con còn tính khi cha còn sống", () => {
    const map = buildParentContractMap([parent({})]);
    expect(isRevenueCountable(child(), map)).toBe(true);
  });
  it("bỏ con khi cha đã HỦY (cancel cha KHÔNG cascade xuống con)", () => {
    const map = buildParentContractMap([parent({ status: "cancelled" })]);
    expect(isRevenueCountable(child(), map)).toBe(false);
  });
  it("bỏ con khi cha là BÁO GIÁ TẠM", () => {
    const map = buildParentContractMap([parent({ status: "temp_quote" })]);
    expect(isRevenueCountable(child(), map)).toBe(false);
  });
  it("bỏ con khi cha đã vào THÙNG RÁC", () => {
    const map = buildParentContractMap([parent({ deletedAt: "2026-06-20" })]);
    expect(isRevenueCountable(child(), map)).toBe(false);
  });
  it("KHÔNG loại con khi cha không có trong map (không tự ý bỏ tiền khách)", () => {
    expect(isRevenueCountable(child(), new Map())).toBe(true);
  });
  it("không truyền parentById ⇒ tương thích ngược, không xét cha", () => {
    expect(isRevenueCountable(child())).toBe(true);
  });
});

describe("filterRevenueCountable — lọc cả cụm trong 1 lần", () => {
  it("giữ con sống + đơn lẻ, bỏ cha/hủy/tạm/con mồ côi", () => {
    const rows: CountableBookingInput[] = [
      { id: 1, isParentContract: true, status: "confirmed" },        // cha sống → bỏ (đếm con)
      { id: 2, parentId: 1, status: "confirmed" },                   // con sống → GIỮ
      { id: 3, parentId: 1, status: "confirmed" },                   // con sống → GIỮ
      { id: 10, isParentContract: true, status: "cancelled" },       // cha hủy → bỏ
      { id: 11, parentId: 10, status: "confirmed" },                 // con mồ côi → bỏ
      { id: 20, status: "temp_quote" },                              // báo giá tạm → bỏ
      { id: 21, status: "cancelled" },                               // đơn hủy → bỏ
      { id: 22, status: "completed", deletedAt: "2026-01-01" },      // thùng rác → bỏ
      { id: 30, status: "confirmed" },                               // đơn lẻ sống → GIỮ
    ];
    const kept = filterRevenueCountable(rows).map(b => b.id).sort((a, b) => (a! - b!));
    expect(kept).toEqual([2, 3, 30]);
  });
  it("bỏ con mồ côi khi cha ở THÙNG RÁC (parent deletedAt) — cần nạp cả đơn xóa vào tập", () => {
    // revenue/data.ts nạp CẢ đơn đã xóa để map cha đầy đủ; con của cha bị trash phải bị loại
    // (khớp dashboard revenueCountableSql NOT EXISTS + customer-aggregate PR #65).
    const rows: CountableBookingInput[] = [
      { id: 40, isParentContract: true, status: "confirmed", deletedAt: "2026-01-01" }, // cha trash → bỏ
      { id: 41, parentId: 40, status: "confirmed" },  // con sống nhưng cha trash → mồ côi → bỏ
      { id: 42, status: "confirmed", deletedAt: "2026-01-01" }, // đơn lẻ trash → bỏ
      { id: 43, status: "confirmed" },                // đơn lẻ sống → GIỮ
    ];
    expect(filterRevenueCountable(rows).map(b => b.id)).toEqual([43]);
  });
});

describe("revenueCountableSql — điều kiện SQL đồng bộ với predicate JS", () => {
  it("mặc định alias 'bookings' + loại đủ 5 trạng thái", () => {
    const sql = revenueCountableSql();
    expect(sql).toContain("bookings.deleted_at IS NULL");
    expect(sql).toContain("bookings.is_parent_contract = false");
    expect(sql).toContain("NOT IN ('cancelled', 'temp_quote')");
    expect(sql).toContain("NOT EXISTS"); // con mồ côi
  });
  it("nhận alias tùy biến", () => {
    expect(revenueCountableSql("b")).toContain("b.parent_id");
  });
  it("VẪN loại đơn CHA tổng (regression PR #66 — dashboard/doanh thu đếm con thay cha)", () => {
    expect(revenueCountableSql("b")).toContain("b.is_parent_contract = false");
  });
});

describe("liveBookingSql — đơn còn hiệu lực GIỮ đơn cha (ngữ cảnh tiền ghi ở cha: payments)", () => {
  it("loại thùng rác / hủy / báo giá tạm / con mồ côi", () => {
    const sql = liveBookingSql();
    expect(sql).toContain("bookings.deleted_at IS NULL");
    expect(sql).toContain("NOT IN ('cancelled', 'temp_quote')");
    expect(sql).toContain("NOT EXISTS"); // con mồ côi (cha đã chết)
    expect(sql).toContain("parent_chk.id = bookings.parent_id");
  });
  it("KHÔNG loại đơn CHA tổng — khác revenueCountableSql (tiền cọc/thu ghi ở đơn cha)", () => {
    expect(liveBookingSql("b")).not.toContain("is_parent_contract");
  });
  it("dùng CHUNG định nghĩa con mồ côi với revenueCountableSql", () => {
    // Cùng mệnh đề NOT EXISTS ⇒ một nguồn chân lý cho 'cha đã chết'.
    const orphan = "parent_chk.deleted_at IS NOT NULL";
    expect(liveBookingSql("b")).toContain(orphan);
    expect(revenueCountableSql("b")).toContain(orphan);
  });
  it("nhận alias tùy biến", () => {
    expect(liveBookingSql("b")).toContain("b.deleted_at IS NULL");
  });
});
