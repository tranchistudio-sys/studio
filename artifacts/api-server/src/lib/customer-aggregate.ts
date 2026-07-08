/**
 * customer-aggregate.ts — gộp số liệu tiền của MỘT khách hàng (số show / đã thu / còn nợ),
 * CHỐNG cộng trùng cha-con của hợp đồng nhiều dịch vụ và CHỐNG tính dữ liệu đã xóa/hủy.
 *
 * Bối cảnh 2 bug đã gặp:
 *  1. Cộng trùng cha-con: 1 hợp đồng nhiều dịch vụ = 1 đơn CHA tổng (isParentContract = true,
 *     total_amount = tổng các dịch vụ) + N đơn CON (parentId = id cha). Cộng CẢ cha LẪN con
 *     ⇒ nợ gấp đôi (vd 11.9tr cha + 3.5+4.0+4.4 con = 23.8tr).
 *  2. Tính cả dữ liệu đã xóa/hủy: đơn trong thùng rác (deletedAt), đơn đã hủy (cancelled),
 *     báo giá tạm (temp_quote), và con "mồ côi" của cha đã vào thùng rác (dữ liệu cũ trước khi
 *     xóa cha cascade con) vẫn bị cộng vào công nợ/lịch sử ⇒ nợ ảo từ đơn nhập sai đã xóa.
 *
 * Quy ước (đồng bộ booking-money.isRevenueCountable + dashboard.ts + recalcParentTotalFromChildren):
 *  - Công nợ / số show / lịch sử show: CHỈ đơn con + đơn lẻ CÒN HIỆU LỰC
 *    (không deletedAt, không cancelled, không temp_quote, không phải đơn cha tổng,
 *    và cha của nó — nếu có — cũng còn hiệu lực: không thùng rác/hủy/báo giá tạm).
 *  - Đã thu: chỉ phiếu thu CÒN HIỆU LỰC (isCollectedPayment: bỏ voided/refund/ad_hoc)
 *    trên các đơn còn hiệu lực CỦA KHÁCH — kể cả ĐƠN CHA còn hiệu lực, vì tiền cọc/thu của
 *    hợp đồng cha-con được ghi ở đơn cha (xem booking-money.ts docstring).
 *  - Restore từ thùng rác (deletedAt → null) ⇒ đơn tự được tính lại, không cần code thêm
 *    (predicate thuần trên trạng thái hiện tại của dòng dữ liệu).
 *  - Bảng audit (booking_change_log / lịch sử xóa dịch vụ) KHÔNG BAO GIỜ là nguồn tính tiền.
 */
import { money, isCollectedPayment, type MoneyPaymentInput } from "./booking-money";
import { parentIdsWithActiveChild, isEmptyParentContract } from "./parent-contract";

export interface AggBooking {
  id: number;
  totalAmount: number | string | null | undefined;
  /** true = đơn CHA tổng của hợp đồng nhiều dịch vụ (total_amount = tổng dịch vụ con). */
  isParentContract?: boolean | null;
  /** id đơn cha nếu là dịch vụ con của hợp đồng nhiều dịch vụ. */
  parentId?: number | null;
  /** 'cancelled' | 'temp_quote' | các trạng thái hoạt động khác. */
  status?: string | null;
  /** != null ⇒ đơn đang trong thùng rác (soft-delete). */
  deletedAt?: unknown;
}

export interface AggPayment extends MoneyPaymentInput {
  bookingId: number | null;
}

export interface CustomerAggregate {
  /** Số show = số đơn tính công nợ (đơn con + đơn lẻ còn hiệu lực). */
  totalBookings: number;
  /** Tổng phải thu = tổng total_amount các đơn còn hiệu lực (đơn con + đơn lẻ, KHÔNG gồm
   *  đơn cha tổng để tránh cộng trùng). Dùng để đối chiếu: totalOwed − totalPaid = totalDebt. */
  totalOwed: number;
  /** Đã thu (phiếu thu còn hiệu lực trên các đơn còn hiệu lực của khách). */
  totalPaid: number;
  /** Còn nợ = max(0, tổng phải thu − đã thu). */
  totalDebt: number;
}

/** Map id đơn cha → đơn cha, để tra trạng thái cha của các đơn con. */
function buildParentMap(bookings: readonly AggBooking[]): Map<number, AggBooking> {
  const map = new Map<number, AggBooking>();
  for (const b of bookings) if (b.isParentContract === true) map.set(b.id, b);
  return map;
}

/** Bản thân dòng đơn còn hiệu lực: không thùng rác, không hủy, không phải báo giá tạm. */
function isSelfLive(b: AggBooking): boolean {
  if (b.deletedAt != null) return false;
  const st = b.status ?? "";
  if (st === "cancelled") return false; // đơn đã hủy — không phải doanh thu/nợ hiện tại
  if (st === "temp_quote") return false; // báo giá tạm — chưa phải đơn thật
  return true;
}

/**
 * Đơn còn "sống" về mặt nghiệp vụ với KHÁCH: bản thân còn hiệu lực VÀ (nếu là con)
 * hợp đồng CHA cũng còn hiệu lực. Cha bị xóa/hủy/chỉ là báo giá tạm ⇒ cả cụm không tính
 * (hủy đơn CHA qua trang Đơn hàng KHÔNG cascade status xuống con — chỉ thùng rác mới
 * cascade deletedAt — nên phải kiểm tra cha ở đây, nếu không sẽ ra nợ ảo: con vẫn cộng
 * nợ trong khi phiếu thu ghi ở cha đã hủy lại bị loại).
 * Cha không tìm thấy trong danh sách (đã bị purge/hard-delete kiểu cũ, hoặc khác khách)
 * ⇒ coi như còn sống, KHÔNG tự ý loại tiền của khách.
 */
function isLiveForCustomer(b: AggBooking, parentById: Map<number, AggBooking>): boolean {
  if (!isSelfLive(b)) return false;
  if (b.parentId != null) {
    const parent = parentById.get(b.parentId);
    if (parent && !isSelfLive(parent)) return false; // con của hợp đồng đã xóa/hủy/báo giá tạm
  }
  return true;
}

/**
 * Đơn có được tính vào công nợ / số show / lịch sử show của khách không.
 * = còn sống VÀ không phải đơn CHA tổng (tránh cộng trùng với các đơn con).
 */
export function isCustomerCountableBooking(
  b: AggBooking,
  parentById?: Map<number, AggBooking>,
): boolean {
  if (b.isParentContract === true) return false;
  return isLiveForCustomer(b, parentById ?? new Map());
}

/**
 * Lọc danh sách đơn hiển thị trong "Lịch sử show" của hồ sơ khách.
 * @param allBookings TOÀN BỘ đơn của khách, KỂ CẢ đơn đã xóa mềm — cần đơn cha đã xóa
 *                    trong danh sách để nhận diện con mồ côi. Hàm tự lọc hết.
 */
export function customerVisibleBookings<T extends AggBooking>(allBookings: readonly T[]): T[] {
  const parentById = buildParentMap(allBookings);
  return allBookings.filter((b) => isCustomerCountableBooking(b, parentById));
}

/**
 * Tính bộ số liệu công nợ cho 1 khách.
 *
 * @param allBookings TOÀN BỘ đơn của khách (kể cả đã xóa mềm / hủy / báo giá tạm) —
 *                    hàm tự lọc; KHÔNG lọc trước ở query để còn nhận diện con mồ côi.
 * @param payments    Danh sách phiếu thu (có thể là toàn hệ thống, cần amount/paymentType/status);
 *                    chỉ cộng phiếu còn hiệu lực (bỏ voided/refund/ad_hoc) gắn vào đơn còn sống
 *                    của khách (gồm cả đơn cha còn sống — nơi ghi tiền của hợp đồng).
 */
export function computeCustomerAggregate(
  allBookings: readonly AggBooking[],
  payments: readonly AggPayment[],
): CustomerAggregate {
  const parentById = buildParentMap(allBookings);

  const countable = allBookings.filter((b) => isCustomerCountableBooking(b, parentById));
  const totalOwed = countable.reduce((s, b) => s + money(b.totalAmount), 0);

  // Đã thu: phiếu thu gắn vào đơn còn sống (kể cả đơn cha còn sống). Đơn đã xóa/hủy/tạm
  // bị loại khỏi tập id ⇒ tiền của đơn đã xóa không còn được giữ lại trong hồ sơ khách.
  // PR D (read-layer): loại thêm CHA RỖNG/ZOMBIE (hợp đồng cha không còn dịch vụ con hiệu lực) —
  // cọc treo ở cha rỗng KHÔNG tính vào "Đã trả" active. Suy ra từ dữ liệu con hiện tại, KHÔNG
  // cần cha đổi status. Cọc vẫn còn nguyên trong DB (chờ xử lý), chỉ không cộng vào tổng active.
  const activeParentIds = parentIdsWithActiveChild(allBookings);
  const liveIds = new Set(
    allBookings
      .filter((b) => isLiveForCustomer(b, parentById))
      .filter((b) => !isEmptyParentContract(b, activeParentIds))
      .map((b) => b.id),
  );
  const totalPaid = payments.reduce(
    (s, p) =>
      p.bookingId != null && liveIds.has(p.bookingId) && isCollectedPayment(p)
        ? s + money(p.amount)
        : s,
    0,
  );

  const totalDebt = Math.max(0, totalOwed - totalPaid);
  return { totalBookings: countable.length, totalOwed, totalPaid, totalDebt };
}
