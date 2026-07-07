import { describe, expect, it } from "vitest";
import {
  isDebtCountableBooking,
  computeCustomerAggregate,
  type AggBooking,
  type AggPayment,
} from "./customer-aggregate";

describe("isDebtCountableBooking — bỏ đơn cha tổng", () => {
  it("đơn cha tổng (isParentContract=true) KHÔNG tính; đơn con/đơn lẻ CÓ tính", () => {
    expect(isDebtCountableBooking({ isParentContract: true })).toBe(false);
    expect(isDebtCountableBooking({ isParentContract: false })).toBe(true);
    expect(isDebtCountableBooking({ isParentContract: null })).toBe(true);
    expect(isDebtCountableBooking({})).toBe(true);
  });
});

describe("computeCustomerAggregate — chống cộng trùng cha-con", () => {
  // Case thực tế báo lỗi: hồ sơ khách Bon Nie.
  // Hợp đồng nhiều dịch vụ: 1 đơn CHA tổng 11.9tr + 3 đơn CON (3.5 + 4.0 + 4.4 = 11.9tr).
  // Tiền cọc/đã thu 1.5tr ghi ở ĐƠN CHA. Còn nợ đúng phải là 10.4tr (KHÔNG phải 22.3tr).
  it("hợp đồng 3 dịch vụ 11.9tr, đã thu 1.5tr → còn nợ 10.4tr (không gấp đôi)", () => {
    const bookings: AggBooking[] = [
      { id: 100, totalAmount: "11900000", isParentContract: true }, // đơn CHA tổng
      { id: 101, totalAmount: "3500000", isParentContract: false }, // dịch vụ 1
      { id: 102, totalAmount: "4000000", isParentContract: false }, // dịch vụ 2
      { id: 103, totalAmount: "4400000", isParentContract: false }, // dịch vụ 3
    ];
    const payments: AggPayment[] = [
      { bookingId: 100, amount: "500000" }, // cọc ghi ở đơn cha
      { bookingId: 100, amount: "1000000" }, // thu thêm ghi ở đơn cha
    ];

    const agg = computeCustomerAggregate(bookings, payments);

    expect(agg.totalBookings).toBe(3); // 3 dịch vụ, không đếm đơn cha
    expect(agg.totalPaid).toBe(1500000); // phiếu thu ở đơn cha vẫn được cộng
    expect(agg.totalDebt).toBe(10400000); // 11.9tr − 1.5tr, KHÔNG phải 22.3tr
  });

  it("BUG cũ nếu cộng cả cha lẫn con: tổng phải thu là 23.8tr — helper mới trả 11.9tr", () => {
    const bookings: AggBooking[] = [
      { id: 1, totalAmount: 11900000, isParentContract: true },
      { id: 2, totalAmount: 3500000, isParentContract: false },
      { id: 3, totalAmount: 4000000, isParentContract: false },
      { id: 4, totalAmount: 4400000, isParentContract: false },
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
      { id: 2, totalAmount: 10000000, isParentContract: false },
    ];
    // Chỉ 1 phiếu thu, gắn ở đơn cha (id=1).
    const agg = computeCustomerAggregate(bookings, [{ bookingId: 1, amount: 4000000 }]);
    expect(agg.totalPaid).toBe(4000000);
    expect(agg.totalDebt).toBe(6000000); // 10tr con − 4tr thu ở cha
  });

  it("bỏ qua phiếu thu của khách khác (bookingId không thuộc khách)", () => {
    const bookings: AggBooking[] = [{ id: 5, totalAmount: 5000000, isParentContract: false }];
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
    const bookings: AggBooking[] = [{ id: 1, totalAmount: 2000000, isParentContract: false }];
    const agg = computeCustomerAggregate(bookings, [{ bookingId: 1, amount: 3000000 }]);
    expect(agg.totalDebt).toBe(0);
  });

  it("khách không có đơn → tất cả bằng 0", () => {
    const agg = computeCustomerAggregate([], []);
    expect(agg).toEqual({ totalBookings: 0, totalPaid: 0, totalDebt: 0 });
  });
});
