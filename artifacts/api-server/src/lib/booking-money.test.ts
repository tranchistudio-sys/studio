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

// ─── ALLOCATOR CHIA ĐỀU CỌC (chốt 17/07 đêm — thay pro-rata PR #102) ───────────
import { allocateFamilyPaid, allocateFamilies } from "./booking-money.js";

describe("allocateFamilies — cọc chia ĐỀU + thu trực tiếp + FIFO trên cha", () => {
  // Gia đình 5 dịch vụ — ví dụ CHÍNH của chủ: cọc 2.5tr → mỗi dịch vụ 500k
  const fam5 = [
    { id: 10, isParentContract: true, parentId: null, status: "confirmed", deletedAt: null, totalAmount: "0", discountAmount: "0", shootDate: "2026-07-01" },
    { id: 11, isParentContract: false, parentId: 10, status: "confirmed", deletedAt: null, totalAmount: "2000000", discountAmount: "0", shootDate: "2026-07-05" },
    { id: 12, isParentContract: false, parentId: 10, status: "confirmed", deletedAt: null, totalAmount: "5000000", discountAmount: "0", shootDate: "2026-07-20" },
    { id: 13, isParentContract: false, parentId: 10, status: "confirmed", deletedAt: null, totalAmount: "3000000", discountAmount: "0", shootDate: "2026-08-01" },
    { id: 14, isParentContract: false, parentId: 10, status: "confirmed", deletedAt: null, totalAmount: "10000000", discountAmount: "0", shootDate: "2026-08-15" },
    { id: 15, isParentContract: false, parentId: 10, status: "confirmed", deletedAt: null, totalAmount: "4000000", discountAmount: "0", shootDate: "2026-09-10" },
  ];
  const dep = (amt: string, id = 1) => ({ id, bookingId: 10, amount: amt, status: "active", paymentType: "deposit" });

  it("TEST 1 chủ: 5 dịch vụ, cọc 2.5tr → MỖI dịch vụ đúng 500k, Σ = đúng 2.5tr, delta 0", () => {
    const fam = allocateFamilies(fam5, [dep("2500000")]).get(10)!;
    expect(fam.totalDeposit).toBe(2_500_000);
    expect(fam.eligibleServiceCount).toBe(5);
    for (const m of fam.members) expect(m.equalDeposit).toBe(500_000); // KHÔNG phụ thuộc giá 2tr hay 10tr
    const sum = fam.members.reduce((s, m) => s + m.equalDeposit, 0);
    expect(sum + fam.overpayment - fam.totalDeposit).toBe(0); // Σ alloc + overpayment = totalDeposit
  });

  it("TEST 2+3 chủ: sửa cọc 2.5tr → 5tr → mỗi dịch vụ 1tr; sửa qua lại 10 lần vẫn recalculate from scratch", () => {
    const after = allocateFamilies(fam5, [dep("5000000")]).get(10)!;
    for (const m of after.members) expect(m.equalDeposit).toBe(1_000_000);
    // 10 lần đổi qua lại — kết quả chỉ phụ thuộc TỔNG CỌC HIỆN TẠI, không cộng dồn
    for (let i = 0; i < 10; i++) {
      const v = i % 2 === 0 ? "2500000" : "5000000";
      const f = allocateFamilies(fam5, [dep(v)]).get(10)!;
      const per = i % 2 === 0 ? 500_000 : 1_000_000;
      for (const m of f.members) expect(m.equalDeposit).toBe(per);
      expect(f.members.reduce((s, m) => s + m.equalDeposit, 0) + f.overpayment).toBe(Number(v));
    }
  });

  it("TEST 4 chủ: 1.000.001đ / 3 dịch vụ → 333.334 / 333.334 / 333.333 theo ID tăng dần, tổng khớp tuyệt đối", () => {
    const fam3 = [
      { id: 20, isParentContract: true, parentId: null, status: "confirmed", deletedAt: null, totalAmount: "0", discountAmount: "0" },
      { id: 21, isParentContract: false, parentId: 20, status: "confirmed", deletedAt: null, totalAmount: "9000000", discountAmount: "0" },
      { id: 22, isParentContract: false, parentId: 20, status: "confirmed", deletedAt: null, totalAmount: "9000000", discountAmount: "0" },
      { id: 23, isParentContract: false, parentId: 20, status: "confirmed", deletedAt: null, totalAmount: "9000000", discountAmount: "0" },
    ];
    const f = allocateFamilies(fam3, [{ id: 1, bookingId: 20, amount: "1000001", status: "active", paymentType: "deposit" }]).get(20)!;
    const byId = new Map(f.members.map(m => [m.bookingId, m.equalDeposit]));
    expect(byId.get(21)).toBe(333_334);
    expect(byId.get(22)).toBe(333_334);
    expect(byId.get(23)).toBe(333_333);
    expect(f.members.reduce((s, m) => s + m.equalDeposit, 0)).toBe(1_000_001);
  });

  it("TEST 5 chủ: dịch vụ NET nhỏ hơn phần chia → cap đúng, phần dư chia lại, không âm công nợ", () => {
    // 3 dịch vụ NET 300k/5tr/5tr, cọc 3tr: chia đều 1tr — dv nhỏ cap 300k, dư 700k chia lại 2 dv kia
    const famS = [
      { id: 30, isParentContract: true, parentId: null, status: "confirmed", deletedAt: null, totalAmount: "0", discountAmount: "0" },
      { id: 31, isParentContract: false, parentId: 30, status: "confirmed", deletedAt: null, totalAmount: "300000", discountAmount: "0" },
      { id: 32, isParentContract: false, parentId: 30, status: "confirmed", deletedAt: null, totalAmount: "5000000", discountAmount: "0" },
      { id: 33, isParentContract: false, parentId: 30, status: "confirmed", deletedAt: null, totalAmount: "5000000", discountAmount: "0" },
    ];
    const f = allocateFamilies(famS, [{ id: 1, bookingId: 30, amount: "3000000", status: "active", paymentType: "deposit" }]).get(30)!;
    const byId = new Map(f.members.map(m => [m.bookingId, m]));
    expect(byId.get(31)!.equalDeposit).toBe(300_000);   // cap = NET
    expect(byId.get(31)!.remaining).toBe(0);            // không âm
    expect(byId.get(32)!.equalDeposit).toBe(1_350_000); // 1tr + 350k dư chia lại
    expect(byId.get(33)!.equalDeposit).toBe(1_350_000);
    expect(f.members.reduce((s, m) => s + m.equalDeposit, 0)).toBe(3_000_000);
  });

  it("TEST 6 chủ: cọc vượt tổng hợp đồng → mọi công nợ 0, phần vượt = overpayment 'Khách trả dư'", () => {
    const f = allocateFamilies(fam5, [dep("30000000")]).get(10)!; // NET cả nhà 24tr, cọc 30tr
    for (const m of f.members) expect(m.remaining).toBe(0);
    expect(f.overpayment).toBe(6_000_000);
    expect(f.members.reduce((s, m) => s + m.equalDeposit, 0) + f.overpayment).toBe(30_000_000);
  });

  it("Q1-A: thu thêm trên CHA phân bổ FIFO theo ngày thực hiện tăng dần, cùng ngày theo ID", () => {
    // cọc 2.5tr (500k/dv) + thu thêm 4tr trên cha:
    // FIFO ngày: dv11(05/07 cần 1.5tr) → dv12(20/07 cần 4.5tr nhận 2.5tr còn lại)
    const f = allocateFamilies(fam5, [
      dep("2500000"),
      { id: 2, bookingId: 10, amount: "4000000", status: "active", paymentType: "payment" },
    ]).get(10)!;
    const byId = new Map(f.members.map(m => [m.bookingId, m]));
    expect(byId.get(11)!.parentFifo).toBe(1_500_000); // đến hạn sớm nhất, đủ trước
    expect(byId.get(11)!.remaining).toBe(0);
    expect(byId.get(12)!.parentFifo).toBe(2_500_000); // phần còn lại
    expect(byId.get(12)!.remaining).toBe(2_000_000);
    expect(byId.get(13)!.parentFifo).toBe(0);          // chưa tới lượt
    expect(f.overpayment).toBe(0);
  });

  it("Q2: phiếu cọc LEGACY trên đơn CON = thu trực tiếp của chính dịch vụ đó, không gom vào cọc chung", () => {
    const f = allocateFamilies(fam5, [
      dep("2500000"),
      { id: 5, bookingId: 13, amount: "500000", status: "active", paymentType: "deposit" }, // legacy trên con 13
    ]).get(10)!;
    expect(f.totalDeposit).toBe(2_500_000); // KHÔNG bị cộng 500k của con
    const m13 = f.members.find(m => m.bookingId === 13)!;
    expect(m13.directPaid).toBe(500_000);
    expect(m13.remaining).toBe(3_000_000 - 500_000 - 500_000); // NET − cọc đều − thu trực tiếp
  });

  it("Q3: partial/full đọc như payment (thu thêm hợp lệ)", () => {
    const f = allocateFamilies(fam5, [
      { id: 3, bookingId: 11, amount: "700000", status: "active", paymentType: "partial" },
      { id: 4, bookingId: 12, amount: "800000", status: "active", paymentType: "full" },
    ]).get(10)!;
    const byId = new Map(f.members.map(m => [m.bookingId, m]));
    expect(byId.get(11)!.directPaid).toBe(700_000);
    expect(byId.get(12)!.directPaid).toBe(800_000);
  });

  it("công thức chủ: remaining = NET − cọc đều − thu trực tiếp − FIFO từ cha (ví dụ Tiệc trong spec)", () => {
    // Tiệc NET 3tr, cọc đều 500k, thu trực tiếp 1tr, FIFO 0 → còn 1.5tr
    const f = allocateFamilies(fam5, [
      dep("2500000"),
      { id: 6, bookingId: 13, amount: "1000000", status: "active", paymentType: "payment" },
    ]).get(10)!;
    const m13 = f.members.find(m => m.bookingId === 13)!;
    expect(m13.remaining).toBe(1_500_000);
  });

  it("tiền THỪA của một dịch vụ chảy sang dịch vụ còn nợ theo FIFO — giữ bất biến gia đình", () => {
    // dv11 NET 2tr nhận trực tiếp 3tr (thừa 1tr) → 1tr chảy FIFO sang dv12
    const f = allocateFamilies(fam5, [
      { id: 7, bookingId: 11, amount: "3000000", status: "active", paymentType: "payment" },
    ]).get(10)!;
    const byId = new Map(f.members.map(m => [m.bookingId, m]));
    expect(byId.get(11)!.directCredited).toBe(2_000_000);
    expect(byId.get(11)!.remaining).toBe(0);
    expect(byId.get(12)!.parentFifo).toBe(1_000_000);
    const totalRemaining = f.members.reduce((s, m) => s + m.remaining, 0);
    expect(totalRemaining).toBe(24_000_000 - 3_000_000); // Σ nợ dịch vụ = NET nhà − tiền nhà
  });
});

describe("allocateFamilyPaid (interface cũ trên allocator mới) — bất biến mọi màn cùng một số", () => {
  const fam = [
    { id: 1, isParentContract: true, parentId: null, status: "confirmed", deletedAt: null, totalAmount: "10000000", discountAmount: "0" },
    { id: 2, isParentContract: false, parentId: 1, status: "confirmed", deletedAt: null, totalAmount: "3000000", discountAmount: "0", shootDate: "2026-07-01" },
    { id: 3, isParentContract: false, parentId: 1, status: "confirmed", deletedAt: null, totalAmount: "7000000", discountAmount: "0", shootDate: "2026-07-10" },
  ];
  const pay4onParent = [{ id: 1, bookingId: 1, amount: "4000000", status: "active", paymentType: "payment" }];

  it("phiếu 'payment' 4tr trên CHA → FIFO: con sớm (3tr) đủ trước, con sau nhận 1tr; CHA = 0", () => {
    const m = allocateFamilyPaid(fam, pay4onParent);
    expect(m.get(2)).toBe(3_000_000);
    expect(m.get(3)).toBe(1_000_000);
    expect(m.get(1)).toBe(0);
  });

  it("voided/refund/ad_hoc KHÔNG tính; phiếu ghi ở CON = thu trực tiếp của con đó", () => {
    const m = allocateFamilyPaid(fam, [
      { id: 1, bookingId: 2, amount: "1000000", status: "active", paymentType: "payment" },
      { id: 2, bookingId: 1, amount: "999", status: "voided", paymentType: "payment" },
      { id: 3, bookingId: 1, amount: "888", status: "active", paymentType: "refund" },
      { id: 4, bookingId: 1, amount: "777", status: "active", paymentType: "ad_hoc" },
    ]);
    expect(m.get(2)).toBe(1_000_000);
    expect(m.get(3)).toBe(0);
  });

  it("đơn lẻ: cọc canonical + thu thêm đều tính cho chính nó", () => {
    const solo = [{ id: 9, isParentContract: false, parentId: null, status: "confirmed", deletedAt: null, totalAmount: "2000000", discountAmount: "0" }];
    const m = allocateFamilyPaid(solo, [
      { id: 1, bookingId: 9, amount: "500000", status: "active", paymentType: "deposit" },
      { id: 2, bookingId: 9, amount: "300000", status: "active", paymentType: "payment" },
    ]);
    expect(m.get(9)).toBe(800_000);
  });

  it("TEST 8+9 chủ: cancelled/temp/cha tổng không nhận; net=0 cả nhà → không ai nhận, tiền = trả dư", () => {
    const famB = [
      { id: 1, isParentContract: true, parentId: null, status: "confirmed", deletedAt: null, totalAmount: "0", discountAmount: "0" },
      { id: 2, isParentContract: false, parentId: 1, status: "cancelled", deletedAt: null, totalAmount: "3000000", discountAmount: "0" },
      { id: 3, isParentContract: false, parentId: 1, status: "confirmed", deletedAt: null, totalAmount: "0", discountAmount: "0" },
      { id: 4, isParentContract: false, parentId: 1, status: "confirmed", deletedAt: null, totalAmount: "0", discountAmount: "0" },
    ];
    const m = allocateFamilyPaid(famB, pay4onParent);
    expect(m.get(2)).toBe(0);
    expect(m.get(3)).toBe(0); // net=0 → không cần tiền; 4tr = Khách trả dư
    expect(m.get(4)).toBe(0);
    const f = allocateFamilies(famB, pay4onParent).get(1)!;
    expect(f.overpayment).toBe(4_000_000); // không mất tiền
  });

  it("bất biến gia đình: Σ nợ per-booking = max(0, net gia đình − tiền gia đình) (kể cả giảm giá)", () => {
    const famC = [
      { id: 1, isParentContract: true, parentId: null, status: "confirmed", deletedAt: null, totalAmount: "10000000", discountAmount: "0" },
      { id: 2, isParentContract: false, parentId: 1, status: "confirmed", deletedAt: null, totalAmount: "3000000", discountAmount: "0", shootDate: "2026-07-01" },
      { id: 3, isParentContract: false, parentId: 1, status: "confirmed", deletedAt: null, totalAmount: "7000000", discountAmount: "1000000", shootDate: "2026-07-05" },
    ];
    const m = allocateFamilyPaid(famC, pay4onParent);
    const debt2 = Math.max(0, 3_000_000 - (m.get(2) ?? 0));
    const debt3 = Math.max(0, 6_000_000 - (m.get(3) ?? 0));
    expect(debt2 + debt3).toBeCloseTo(Math.max(0, 9_000_000 - 4_000_000), 6);
  });

  it("trả dư: nợ mọi dịch vụ 0, phần vượt là overpayment — tổng phân bổ + overpayment = tổng phiếu", () => {
    const m = allocateFamilyPaid(fam, [{ id: 1, bookingId: 1, amount: "24000000", status: "active", paymentType: "payment" }]);
    expect(m.get(2)).toBe(3_000_000);
    expect(m.get(3)).toBe(7_000_000);
    const f = allocateFamilies(fam, [{ id: 1, bookingId: 1, amount: "24000000", status: "active", paymentType: "payment" }]).get(1)!;
    expect(f.overpayment).toBe(14_000_000);
    expect((m.get(2) ?? 0) + (m.get(3) ?? 0) + f.overpayment).toBe(24_000_000);
  });
});
