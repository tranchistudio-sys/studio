import { describe, expect, it } from "vitest";
import {
  isCustomerCountableBooking,
  customerVisibleBookings,
  computeCustomerAggregate,
  type AggBooking,
  type AggPayment,
} from "./customer-aggregate";

describe("isCustomerCountableBooking — bỏ đơn cha tổng + dữ liệu đã xóa/hủy", () => {
  it("đơn cha tổng (isParentContract=true) KHÔNG tính; đơn con/đơn lẻ CÓ tính", () => {
    expect(isCustomerCountableBooking({ id: 1, totalAmount: 0, isParentContract: true })).toBe(false);
    expect(isCustomerCountableBooking({ id: 2, totalAmount: 0, isParentContract: false })).toBe(true);
    expect(isCustomerCountableBooking({ id: 3, totalAmount: 0, isParentContract: null })).toBe(true);
    expect(isCustomerCountableBooking({ id: 4, totalAmount: 0 })).toBe(true);
  });

  it("đơn trong thùng rác (deletedAt != null) KHÔNG tính", () => {
    expect(isCustomerCountableBooking({ id: 1, totalAmount: 0, deletedAt: new Date() })).toBe(false);
    expect(isCustomerCountableBooking({ id: 2, totalAmount: 0, deletedAt: "2026-07-01" })).toBe(false);
    expect(isCustomerCountableBooking({ id: 3, totalAmount: 0, deletedAt: null })).toBe(true);
  });

  it("đơn hủy (cancelled) và báo giá tạm (temp_quote) KHÔNG tính", () => {
    expect(isCustomerCountableBooking({ id: 1, totalAmount: 0, status: "cancelled" })).toBe(false);
    expect(isCustomerCountableBooking({ id: 2, totalAmount: 0, status: "temp_quote" })).toBe(false);
    expect(isCustomerCountableBooking({ id: 3, totalAmount: 0, status: "confirmed" })).toBe(true);
    expect(isCustomerCountableBooking({ id: 4, totalAmount: 0, status: "completed" })).toBe(true);
  });
});

describe("computeCustomerAggregate — chống cộng trùng cha-con (PR #65 case 1)", () => {
  // Case thực tế báo lỗi: hồ sơ khách Bon Nie.
  // Hợp đồng nhiều dịch vụ: 1 đơn CHA tổng 11.9tr + 3 đơn CON (3.5 + 4.0 + 4.4 = 11.9tr).
  // Tiền cọc/đã thu 1.5tr ghi ở ĐƠN CHA. Còn nợ đúng phải là 10.4tr (KHÔNG phải 22.3tr).
  it("hợp đồng 3 dịch vụ 11.9tr, đã thu 1.5tr → còn nợ 10.4tr (không gấp đôi)", () => {
    const bookings: AggBooking[] = [
      { id: 100, totalAmount: "11900000", isParentContract: true }, // đơn CHA tổng
      { id: 101, totalAmount: "3500000", isParentContract: false, parentId: 100 }, // dịch vụ 1
      { id: 102, totalAmount: "4000000", isParentContract: false, parentId: 100 }, // dịch vụ 2
      { id: 103, totalAmount: "4400000", isParentContract: false, parentId: 100 }, // dịch vụ 3
    ];
    const payments: AggPayment[] = [
      { bookingId: 100, amount: "500000", paymentType: "deposit" }, // cọc ghi ở đơn cha
      { bookingId: 100, amount: "1000000", paymentType: "payment" }, // thu thêm ghi ở đơn cha
    ];

    const agg = computeCustomerAggregate(bookings, payments);

    expect(agg.totalBookings).toBe(3); // 3 dịch vụ, không đếm đơn cha
    expect(agg.totalOwed).toBe(11900000); // tổng phải thu = tổng dịch vụ con, KHÔNG cộng đơn cha
    expect(agg.totalPaid).toBe(1500000); // phiếu thu ở đơn cha vẫn được cộng
    expect(agg.totalDebt).toBe(10400000); // 11.9tr − 1.5tr, KHÔNG phải 22.3tr
    expect(agg.totalOwed - agg.totalPaid).toBe(agg.totalDebt); // đối chiếu: Tổng − Đã trả = Còn nợ
  });

  it("BUG cũ nếu cộng cả cha lẫn con: tổng phải thu là 23.8tr — helper mới trả 11.9tr", () => {
    const bookings: AggBooking[] = [
      { id: 1, totalAmount: 11900000, isParentContract: true },
      { id: 2, totalAmount: 3500000, parentId: 1 },
      { id: 3, totalAmount: 4000000, parentId: 1 },
      { id: 4, totalAmount: 4400000, parentId: 1 },
    ];
    const naiveOwed = bookings.reduce((s, b) => s + Number(b.totalAmount), 0);
    expect(naiveOwed).toBe(23800000); // cách cộng cũ (sai)

    const agg = computeCustomerAggregate(bookings, []);
    expect(agg.totalDebt).toBe(11900000); // chỉ tổng dịch vụ con, không cộng đơn cha
  });

  it("đơn lẻ (không cha-con) tính bình thường", () => {
    const bookings: AggBooking[] = [
      { id: 10, totalAmount: 5000000, isParentContract: false },
      { id: 11, totalAmount: 3000000 }, // isParentContract undefined ⇒ vẫn tính
    ];
    const payments: AggPayment[] = [{ bookingId: 10, amount: 2000000 }];

    const agg = computeCustomerAggregate(bookings, payments);
    expect(agg.totalBookings).toBe(2);
    expect(agg.totalPaid).toBe(2000000);
    expect(agg.totalDebt).toBe(6000000); // 8tr − 2tr
  });

  it("phiếu thu ở đơn cha vẫn tính dù đơn cha bị loại khỏi công nợ", () => {
    const bookings: AggBooking[] = [
      { id: 1, totalAmount: 10000000, isParentContract: true },
      { id: 2, totalAmount: 10000000, parentId: 1 },
    ];
    // Chỉ 1 phiếu thu, gắn ở đơn cha (id=1).
    const agg = computeCustomerAggregate(bookings, [{ bookingId: 1, amount: 4000000 }]);
    expect(agg.totalPaid).toBe(4000000);
    expect(agg.totalDebt).toBe(6000000); // 10tr con − 4tr thu ở cha
  });

  it("bỏ qua phiếu thu của khách khác (bookingId không thuộc khách)", () => {
    const bookings: AggBooking[] = [{ id: 5, totalAmount: 5000000 }];
    const payments: AggPayment[] = [
      { bookingId: 5, amount: 1000000 },
      { bookingId: 999, amount: 9999999 }, // đơn của khách khác
      { bookingId: null, amount: 500000 }, // thu lẻ không gắn đơn
    ];
    const agg = computeCustomerAggregate(bookings, payments);
    expect(agg.totalPaid).toBe(1000000);
    expect(agg.totalDebt).toBe(4000000);
  });

  it("đã thu vượt phải thu → còn nợ không âm (clamp 0)", () => {
    const bookings: AggBooking[] = [{ id: 1, totalAmount: 2000000 }];
    const agg = computeCustomerAggregate(bookings, [{ bookingId: 1, amount: 3000000 }]);
    expect(agg.totalOwed).toBe(2000000); // tổng phải thu KHÔNG bị clamp, giữ nguyên giá trị show
    expect(agg.totalPaid).toBe(3000000);
    expect(agg.totalDebt).toBe(0); // chỉ Còn nợ mới clamp về 0
  });

  it("khách không có đơn → tất cả bằng 0", () => {
    const agg = computeCustomerAggregate([], []);
    expect(agg).toEqual({ totalBookings: 0, totalOwed: 0, totalPaid: 0, totalDebt: 0 });
  });
});

describe("computeCustomerAggregate — loại dữ liệu đã xóa/hủy (PR #65 case 2)", () => {
  // Case yêu cầu: khách có 5 booking/service trong DB, 2 dòng đã xóa/removed
  // → chỉ hiện và chỉ tính tiền 3 dòng còn active.
  it("5 đơn trong DB, 2 đã xóa (thùng rác) → chỉ tính 3 đơn còn active", () => {
    const bookings: AggBooking[] = [
      { id: 1, totalAmount: 5900000, status: "completed" },
      { id: 2, totalAmount: 4500000, status: "confirmed" },
      { id: 3, totalAmount: 7500000, status: "confirmed" },
      { id: 4, totalAmount: 12000000, status: "confirmed", deletedAt: "2026-07-01" }, // đã xóa
      { id: 5, totalAmount: 5900000, status: "confirmed", deletedAt: "2026-07-02" }, // đã xóa
    ];
    const payments: AggPayment[] = [
      { bookingId: 1, amount: 1000000, paymentType: "payment" },
      { bookingId: 4, amount: 2000000, paymentType: "deposit" }, // tiền trên đơn đã xóa
    ];

    const agg = computeCustomerAggregate(bookings, payments);
    expect(agg.totalBookings).toBe(3); // không đếm 2 đơn đã xóa
    expect(agg.totalPaid).toBe(1000000); // tiền trên đơn đã xóa KHÔNG được giữ lại
    expect(agg.totalDebt).toBe(5900000 + 4500000 + 7500000 - 1000000); // 16.9tr

    const visible = customerVisibleBookings(bookings);
    expect(visible.map((b) => b.id)).toEqual([1, 2, 3]); // lịch sử show không còn đơn đã xóa
  });

  it("hợp đồng cha-con bị xóa cả cụm (cascade) → không tính đồng nào, kể cả phiếu thu ở cha", () => {
    const del = "2026-07-01";
    const bookings: AggBooking[] = [
      // hợp đồng đã xóa: cha + 2 con cùng deletedAt (cascade khi xóa cha)
      { id: 1, totalAmount: 10000000, isParentContract: true, deletedAt: del },
      { id: 2, totalAmount: 6000000, parentId: 1, deletedAt: del },
      { id: 3, totalAmount: 4000000, parentId: 1, deletedAt: del },
      // đơn lẻ còn sống
      { id: 4, totalAmount: 3000000, status: "confirmed" },
    ];
    const payments: AggPayment[] = [
      { bookingId: 1, amount: 2000000, paymentType: "deposit" }, // cọc ở cha ĐÃ XÓA
      { bookingId: 4, amount: 500000, paymentType: "payment" },
    ];

    const agg = computeCustomerAggregate(bookings, payments);
    expect(agg.totalBookings).toBe(1);
    expect(agg.totalPaid).toBe(500000); // cọc của hợp đồng đã xóa không được giữ
    expect(agg.totalDebt).toBe(2500000); // 3tr − 0.5tr
  });

  it("con MỒ CÔI (cha trong thùng rác, con quên cascade — dữ liệu cũ) → không tính con", () => {
    const bookings: AggBooking[] = [
      { id: 1, totalAmount: 9000000, isParentContract: true, deletedAt: "2026-06-01" }, // cha đã xóa
      { id: 2, totalAmount: 5000000, parentId: 1 }, // con còn active (mồ côi)
      { id: 3, totalAmount: 4000000, parentId: 1 }, // con còn active (mồ côi)
      { id: 4, totalAmount: 2000000, status: "confirmed" }, // đơn lẻ bình thường
    ];
    const agg = computeCustomerAggregate(bookings, []);
    expect(agg.totalBookings).toBe(1); // chỉ đơn lẻ id=4
    expect(agg.totalDebt).toBe(2000000);
    expect(customerVisibleBookings(bookings).map((b) => b.id)).toEqual([4]);
  });

  it("cha không có trong danh sách (đã purge kiểu cũ) → KHÔNG tự ý loại con", () => {
    const bookings: AggBooking[] = [
      { id: 2, totalAmount: 5000000, parentId: 999 }, // cha 999 không tồn tại trong DB
    ];
    const agg = computeCustomerAggregate(bookings, []);
    expect(agg.totalBookings).toBe(1); // giữ — không tự ý xóa tiền của khách
    expect(agg.totalDebt).toBe(5000000);
  });

  it("đơn hủy (cancelled) và báo giá tạm (temp_quote) không tính nợ, không hiện lịch sử", () => {
    const bookings: AggBooking[] = [
      { id: 1, totalAmount: 5000000, status: "confirmed" },
      { id: 2, totalAmount: 8000000, status: "cancelled" }, // hủy do nhập sai
      { id: 3, totalAmount: 6000000, status: "temp_quote" }, // báo giá tạm BG00xx
    ];
    const payments: AggPayment[] = [
      { bookingId: 1, amount: 1000000 },
      { bookingId: 2, amount: 700000 }, // tiền trên đơn hủy
    ];
    const agg = computeCustomerAggregate(bookings, payments);
    expect(agg.totalBookings).toBe(1);
    expect(agg.totalPaid).toBe(1000000); // không giữ tiền của đơn hủy
    expect(agg.totalDebt).toBe(4000000);
    expect(customerVisibleBookings(bookings).map((b) => b.id)).toEqual([1]);
  });

  it("phiếu thu voided/refund/ad_hoc KHÔNG tính vào đã thu", () => {
    const bookings: AggBooking[] = [{ id: 1, totalAmount: 10000000, status: "confirmed" }];
    const payments: AggPayment[] = [
      { bookingId: 1, amount: 2000000, paymentType: "payment", status: "active" },
      { bookingId: 1, amount: 3000000, paymentType: "payment", status: "voided" }, // phiếu đã hủy
      { bookingId: 1, amount: 1500000, paymentType: "refund", status: "active" }, // hoàn tiền
      { bookingId: 1, amount: 800000, paymentType: "ad_hoc", status: "active" }, // thu lẻ
    ];
    const agg = computeCustomerAggregate(bookings, payments);
    expect(agg.totalPaid).toBe(2000000); // chỉ phiếu active loại payment/deposit
    expect(agg.totalDebt).toBe(8000000);
  });

  it("RESTORE từ thùng rác (deletedAt về null) → đơn và tiền tự quay lại", () => {
    const trashed: AggBooking[] = [
      { id: 1, totalAmount: 10000000, isParentContract: true, deletedAt: "2026-07-01" },
      { id: 2, totalAmount: 10000000, parentId: 1, deletedAt: "2026-07-01" },
    ];
    const payments: AggPayment[] = [{ bookingId: 1, amount: 4000000, paymentType: "deposit" }];

    // Đang trong thùng rác: không show, không nợ, không giữ tiền.
    const before = computeCustomerAggregate(trashed, payments);
    expect(before).toEqual({ totalBookings: 0, totalOwed: 0, totalPaid: 0, totalDebt: 0 });

    // Sau restore (backend set deletedAt = null cho cả cha lẫn con):
    const restored = trashed.map((b) => ({ ...b, deletedAt: null }));
    const after = computeCustomerAggregate(restored, payments);
    expect(after.totalBookings).toBe(1); // dịch vụ con
    expect(after.totalPaid).toBe(4000000);
    expect(after.totalDebt).toBe(6000000);
  });

  it("HỦY đơn CHA (status không cascade xuống con) → cả cụm không tính, không giữ cọc", () => {
    // Trang Đơn hàng cho hủy đơn CHA qua dropdown status; status KHÔNG cascade xuống con
    // (chỉ thùng rác mới cascade deletedAt). Nếu chỉ kiểm tra deletedAt của cha thì con vẫn
    // cộng đủ nợ trong khi cọc ở cha đã hủy bị loại → nợ ảo (review PR #65 phát hiện).
    const bookings: AggBooking[] = [
      { id: 1, totalAmount: 9000000, isParentContract: true, status: "cancelled" }, // cha bị HỦY
      { id: 2, totalAmount: 5000000, parentId: 1, status: "confirmed" }, // con vẫn confirmed
      { id: 3, totalAmount: 4000000, parentId: 1, status: "confirmed" },
      { id: 4, totalAmount: 2000000, status: "confirmed" }, // đơn lẻ khác còn sống
    ];
    const payments: AggPayment[] = [
      { bookingId: 1, amount: 1500000, paymentType: "deposit" }, // cọc ở cha đã hủy
      { bookingId: 4, amount: 500000, paymentType: "payment" },
    ];
    const agg = computeCustomerAggregate(bookings, payments);
    expect(agg.totalBookings).toBe(1); // chỉ đơn lẻ id=4 — hợp đồng hủy không tính show nào
    expect(agg.totalPaid).toBe(500000); // cọc của hợp đồng hủy không giữ trong hồ sơ khách
    expect(agg.totalDebt).toBe(1500000); // 2tr − 0.5tr; KHÔNG phải 9tr nợ ảo
    expect(customerVisibleBookings(bookings).map((b) => b.id)).toEqual([4]);
  });

  it("cha là báo giá tạm (temp_quote) → các con không tính vào nợ/lịch sử", () => {
    const bookings: AggBooking[] = [
      { id: 1, totalAmount: 8000000, isParentContract: true, status: "temp_quote" },
      { id: 2, totalAmount: 5000000, parentId: 1, status: "confirmed" },
      { id: 3, totalAmount: 3000000, parentId: 1, status: "temp_quote" },
    ];
    const agg = computeCustomerAggregate(bookings, []);
    expect(agg).toEqual({ totalBookings: 0, totalOwed: 0, totalPaid: 0, totalDebt: 0 });
    expect(customerVisibleBookings(bookings)).toEqual([]);
  });

  it("phiếu thu gắn thẳng vào ĐƠN CON còn sống vẫn được tính vào đã thu", () => {
    // Chống thoái hóa kiểu "chỉ nhận phiếu thu trên đơn cha/đơn lẻ" — POST /payments
    // cho phép ghi phiếu thu theo bookingId của dịch vụ con.
    const bookings: AggBooking[] = [
      { id: 1, totalAmount: 9000000, isParentContract: true },
      { id: 2, totalAmount: 5000000, parentId: 1, status: "confirmed" },
      { id: 3, totalAmount: 4000000, parentId: 1, status: "confirmed" },
    ];
    const payments: AggPayment[] = [
      { bookingId: 2, amount: 1200000, paymentType: "deposit" }, // cọc ghi thẳng ở con
      { bookingId: 3, amount: 800000, paymentType: "payment" },
    ];
    const agg = computeCustomerAggregate(bookings, payments);
    expect(agg.totalPaid).toBe(2000000);
    expect(agg.totalDebt).toBe(7000000); // 9tr − 2tr
  });

  it("hợp đồng còn sống nhưng 1 dịch vụ con bị hủy → chỉ tính các con còn lại", () => {
    const bookings: AggBooking[] = [
      { id: 1, totalAmount: 9000000, isParentContract: true }, // cha còn sống (total có thể chưa recalc)
      { id: 2, totalAmount: 5000000, parentId: 1, status: "confirmed" },
      { id: 3, totalAmount: 4000000, parentId: 1, status: "cancelled" }, // con bị hủy
    ];
    const payments: AggPayment[] = [{ bookingId: 1, amount: 1000000, paymentType: "deposit" }];
    const agg = computeCustomerAggregate(bookings, payments);
    expect(agg.totalBookings).toBe(1);
    expect(agg.totalPaid).toBe(1000000); // cọc ở cha còn sống vẫn tính
    expect(agg.totalDebt).toBe(4000000); // 5tr − 1tr
  });

  it("PR D read-layer: CHA RỖNG/ZOMBIE (còn sống nhưng hết con hiệu lực) → cọc KHÔNG tính Đã trả", () => {
    // Ca KH029 id=66: cha 'confirmed' (KHÔNG bị đổi status), con đã xoá/hủy hết → cha rỗng.
    // Cọc 1tr ở cha rỗng là "tiền chờ xử lý", không cộng vào Đã trả active của khách.
    const bookings: AggBooking[] = [
      { id: 66, totalAmount: 5900000, isParentContract: true, status: "confirmed" }, // cha rỗng, KHÔNG cancelled
      { id: 67, totalAmount: 3000000, parentId: 66, status: "cancelled" }, // con đã hủy
    ];
    const payments: AggPayment[] = [{ bookingId: 66, amount: 1000000, paymentType: "deposit" }];
    const agg = computeCustomerAggregate(bookings, payments);
    expect(agg.totalOwed).toBe(0); // không con hiệu lực → không phải thu
    expect(agg.totalPaid).toBe(0); // cọc treo ở cha RỖNG KHÔNG tính (không cần cha đổi status)
    expect(agg.totalDebt).toBe(0);
  });

  it("PR D read-layer: thêm/khôi phục 1 con hiệu lực → cha hết rỗng, cọc tính lại NGAY (không cần đổi status)", () => {
    // Đối chứng đảo chiều: cùng cha 66 nhưng giờ có 1 con confirmed → cha KHÔNG còn rỗng.
    const bookings: AggBooking[] = [
      { id: 66, totalAmount: 5900000, isParentContract: true, status: "confirmed" },
      { id: 67, totalAmount: 3000000, parentId: 66, status: "cancelled" },
      { id: 68, totalAmount: 4000000, parentId: 66, status: "confirmed" }, // con sống trở lại
    ];
    const payments: AggPayment[] = [{ bookingId: 66, amount: 1000000, paymentType: "deposit" }];
    const agg = computeCustomerAggregate(bookings, payments);
    expect(agg.totalBookings).toBe(1); // con 68
    expect(agg.totalPaid).toBe(1000000); // cọc ở cha (giờ không rỗng) tính lại
    expect(agg.totalDebt).toBe(3000000); // 4tr − 1tr
  });
});
