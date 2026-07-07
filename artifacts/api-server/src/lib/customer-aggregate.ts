/**
 * customer-aggregate.ts — gộp số liệu tiền của MỘT khách hàng (số show / đã thu / còn nợ),
 * CHỐNG cộng trùng cha-con của hợp đồng nhiều dịch vụ.
 *
 * Bối cảnh bug: 1 hợp đồng nhiều dịch vụ được lưu thành 1 đơn CHA tổng
 * (isParentContract = true, total_amount = tổng các dịch vụ) + N đơn CON
 * (parentId = id cha, mỗi đơn 1 dịch vụ). Nếu cộng CẢ cha LẪN con vào công nợ
 * thì tổng bị gấp đôi (vd 11.9tr cha + 3.5+4.0+4.4 con = 23.8tr).
 *
 * Quy ước (đồng bộ với booking-money.isRevenueCountable + dashboard.ts):
 *  - Công nợ / số show: CHỈ đếm đơn con + đơn lẻ, BỎ đơn cha tổng.
 *  - Đã thu: cộng phiếu thu trên MỌI đơn của khách (kể cả đơn cha) — vì tiền cọc/thu
 *    của hợp đồng cha-con được ghi ở ĐƠN CHA (xem booking-money.ts docstring).
 */
import { money } from "./booking-money";

export interface AggBooking {
  id: number;
  totalAmount: number | string | null | undefined;
  /** true = đơn CHA tổng của hợp đồng nhiều dịch vụ (total_amount = tổng dịch vụ con). */
  isParentContract?: boolean | null;
}

export interface AggPayment {
  bookingId: number | null;
  amount: number | string | null | undefined;
}

export interface CustomerAggregate {
  /** Số show = số đơn tính công nợ (đã bỏ đơn cha tổng). */
  totalBookings: number;
  /** Đã thu (tổng phiếu thu trên mọi đơn của khách). */
  totalPaid: number;
  /** Còn nợ = max(0, tổng phải thu − đã thu). */
  totalDebt: number;
}

/**
 * Đơn có được tính vào công nợ/số show của khách không.
 * Loại đơn CHA tổng để tránh cộng trùng với các đơn con. Đơn lẻ và đơn con đều tính.
 */
export function isDebtCountableBooking(b: { isParentContract?: boolean | null }): boolean {
  return b.isParentContract !== true;
}

/**
 * Tính bộ số liệu công nợ cho 1 khách từ danh sách đơn + toàn bộ phiếu thu.
 *
 * @param bookings  Đơn của khách (caller tự lọc trước đơn đã xoá / temp_quote nếu muốn —
 *                  giữ nguyên hành vi từng màn). PHẢI còn đơn cha trong danh sách để
 *                  phiếu thu gắn ở đơn cha vẫn được cộng vào "đã thu".
 * @param payments  Danh sách phiếu thu (có thể là toàn hệ thống); chỉ cộng phiếu có
 *                  bookingId thuộc các đơn của khách.
 */
export function computeCustomerAggregate(
  bookings: readonly AggBooking[],
  payments: readonly AggPayment[],
): CustomerAggregate {
  const countable = bookings.filter(isDebtCountableBooking);
  const totalOwed = countable.reduce((s, b) => s + money(b.totalAmount), 0);

  // Đã thu: cộng trên MỌI đơn của khách (kể cả đơn cha) — tiền của hợp đồng cha-con
  // nằm ở đơn cha, nên không được loại đơn cha khỏi tập id khi cộng phiếu thu.
  const bookingIds = new Set(bookings.map((b) => b.id));
  const totalPaid = payments.reduce(
    (s, p) => (p.bookingId != null && bookingIds.has(p.bookingId) ? s + money(p.amount) : s),
    0,
  );

  const totalDebt = Math.max(0, totalOwed - totalPaid);
  return { totalBookings: countable.length, totalPaid, totalDebt };
}
