/**
 * parent-contract.ts — predicate TẦNG ĐỌC cho "hợp đồng cha rỗng / zombie" (PR D, hướng read-layer).
 *
 * Nguyên tắc (chủ studio chốt): hợp đồng CHA không còn dịch vụ con active thì KHÔNG được tính là
 * đơn active trong các màn tiền/công nợ/doanh thu/payments. Thay vì tự đổi status cha ở mọi đường
 * ghi (dễ sót/whack-a-mole, dễ un-cancel nhầm hợp đồng huỷ tay), ta DẪN XUẤT trạng thái "rỗng" ở
 * tầng đọc từ chính dữ liệu con hiện tại — luôn đúng, không cần migration, không đổi status.
 *
 * "Còn hiệu lực" của con = isSelfLiveBooking (không thùng rác / không huỷ / không báo giá tạm),
 * đồng bộ với booking-money + customer-aggregate + revenueCountableSql.
 *
 * Tiền cọc nằm ở cha rỗng KHÔNG bị xoá/void — chỉ bị loại khỏi tổng ACTIVE (có thể gom hiển thị
 * "tiền cọc/chờ xử lý của đơn không còn dịch vụ" ở UI sau — proposal riêng).
 */
import { isSelfLiveBooking } from "./booking-money";

export type BookingLike = {
  id?: number;
  parentId?: number | null;
  isParentContract?: boolean | null;
  deletedAt?: unknown;
  status?: string | null;
};

/**
 * Tập id các đơn CHA đang còn ≥1 dịch vụ con CÒN HIỆU LỰC. Tính 1 lần từ toàn bộ đơn của phạm vi
 * đang xét (của khách / của kỳ báo cáo). Dùng để nhận diện "cha rỗng" = cha KHÔNG có trong tập này.
 */
export function parentIdsWithActiveChild(bookings: readonly BookingLike[]): Set<number> {
  const s = new Set<number>();
  for (const b of bookings) {
    if (b.parentId != null && isSelfLiveBooking(b)) s.add(b.parentId);
  }
  return s;
}

/** Hợp đồng cha có còn dịch vụ con active không (tra theo tập parentIdsWithActiveChild). */
export function hasActiveChildren(parentId: number, activeParentIds: ReadonlySet<number>): boolean {
  return activeParentIds.has(parentId);
}

/**
 * Đơn cha RỖNG/ZOMBIE: là hợp đồng cha (isParentContract) NHƯNG không còn dịch vụ con nào còn
 * hiệu lực. Đây là đơn KHÔNG được tính vào tiền/công nợ/doanh thu active.
 */
export function isEmptyParentContract(b: BookingLike, activeParentIds: ReadonlySet<number>): boolean {
  return b.isParentContract === true && b.id != null && !activeParentIds.has(b.id);
}

/**
 * Có phải "đơn active kinh doanh" không — điều kiện CHUNG để một booking được tính vào tiền:
 *  - tự thân còn hiệu lực (không thùng rác/huỷ/báo giá tạm), VÀ
 *  - KHÔNG phải cha rỗng/zombie, VÀ
 *  - nếu là con thì cha còn hiệu lực (không mồ côi).
 * @param parentById  map id→đơn cha (để tra cha của con). Con có cha đã chết ⇒ loại.
 */
export function isActiveBusinessBooking(
  b: BookingLike,
  activeParentIds: ReadonlySet<number>,
  parentById: ReadonlyMap<number, BookingLike>,
): boolean {
  if (!isSelfLiveBooking(b)) return false;
  if (isEmptyParentContract(b, activeParentIds)) return false;
  if (b.parentId != null) {
    const parent = parentById.get(b.parentId);
    if (parent && !isSelfLiveBooking(parent)) return false;
  }
  return true;
}

/**
 * Điều kiện SQL (raw query) LOẠI phiếu thu nằm ở CHA RỖNG/ZOMBIE khỏi tổng tiền ACTIVE — dùng cho
 * query tiền cash-basis (dashboard/payments) không đi qua predicate JS. Giữ phiếu ad_hoc
 * (booking_id NULL) + phiếu gắn đơn thường/con/cha-còn-con. Chuỗi hằng, an toàn với template.
 * @param p bí danh bảng payments trong câu lệnh (mặc định "payments").
 */
export function paymentNotOnEmptyParentSql(p = "payments"): string {
  return `NOT (${p}.booking_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM bookings zp WHERE zp.id = ${p}.booking_id
      AND zp.is_parent_contract = true
      AND NOT EXISTS (
        SELECT 1 FROM bookings zch WHERE zch.parent_id = zp.id
          AND zch.deleted_at IS NULL
          AND COALESCE(zch.status, '') NOT IN ('cancelled', 'temp_quote')
      )
  ))`;
}

/**
 * Điều kiện SQL "booking KHÔNG phải CHA RỖNG": hoặc không phải đơn cha, HOẶC là đơn cha còn ≥1
 * dịch vụ con CÒN HIỆU LỰC. Ghép với liveBookingSql (vốn GIỮ đơn cha để tính cọc) nhằm LOẠI cha
 * rỗng/zombie khỏi báo cáo tiền active — dùng cho query LỌC BOOKING (payments/monthly/export).
 * "Con còn hiệu lực" = deleted_at IS NULL + status NOT IN (cancelled, temp_quote) — khớp isSelfLiveBooking.
 * @param alias bí danh bảng bookings trong câu lệnh (mặc định "bookings").
 */
export function notEmptyParentSql(alias = "bookings"): string {
  const a = alias;
  return `(NOT ${a}.is_parent_contract OR EXISTS (
    SELECT 1 FROM bookings ac WHERE ac.parent_id = ${a}.id
      AND ac.deleted_at IS NULL
      AND COALESCE(ac.status, '') NOT IN ('cancelled', 'temp_quote')
  ))`;
}
