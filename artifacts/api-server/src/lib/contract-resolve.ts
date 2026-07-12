/**
 * contract-resolve.ts — quyết định THUẦN (không I/O) cho thao tác "mở hợp đồng của một đơn".
 *
 * QUY TẮC BẤT BIẾN: hợp đồng gắn theo TỪNG đơn (contracts.booking_id). Mỗi đơn có
 * totalValue + chữ ký riêng. Khi bấm "Xem hợp đồng" cho một đơn, hệ thống CHỈ được:
 *   1) trả hợp đồng gắn đúng đơn đó (hoặc đơn CHA nếu là đơn gộp), hoặc
 *   2) tạo hợp đồng mới cho chính đơn đó.
 * TUYỆT ĐỐI KHÔNG fallback sang hợp đồng gần nhất của cùng khách — đó là bug P0 khiến
 * đơn MỚI của khách cũ mở nhầm hợp đồng CŨ đã ký (sai số tiền, sai chữ ký).
 *
 * Các hàm ở đây cố tình KHÔNG nhận customerId, để "không fallback theo khách" là bất biến
 * CẤU TRÚC (không thể lỡ tay dùng sai), chứ không chỉ là quy ước dễ vỡ.
 */

/**
 * Danh sách bookingId ứng viên để tìm hợp đồng, theo thứ tự ưu tiên:
 * đơn hiện tại trước, rồi tới đơn CHA (nếu đây là đơn con trong đơn gộp).
 */
export function contractCandidateBookingIds(
  bookingId: number,
  parentId: number | null | undefined,
): number[] {
  return parentId != null && parentId !== bookingId ? [bookingId, parentId] : [bookingId];
}

/**
 * Dựng map bookingId -> contractId MỚI NHẤT từ danh sách hợp đồng đã sắp xếp createdAt DESC.
 * rows phải được truyền theo thứ tự mới→cũ; hàng đầu tiên cho mỗi bookingId sẽ thắng.
 */
export function newestContractIdByBooking(
  rowsNewestFirst: ReadonlyArray<{ id: number; bookingId: number | null }>,
): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rowsNewestFirst) {
    if (row.bookingId != null && !map.has(row.bookingId)) {
      map.set(row.bookingId, row.id);
    }
  }
  return map;
}

/**
 * Chọn id hợp đồng có sẵn cho đơn — CHỈ theo bookingId, theo đúng thứ tự ưu tiên của candidates.
 * @param candidateBookingIds  kết quả của contractCandidateBookingIds()
 * @param contractIdByBooking  map bookingId -> contractId (mới nhất) đã tồn tại trong DB
 * @returns contractId để mở, hoặc null nếu chưa có ⇒ caller PHẢI tạo hợp đồng mới cho đơn.
 */
export function pickContractIdForBooking(
  candidateBookingIds: number[],
  contractIdByBooking: Map<number, number>,
): number | null {
  for (const bid of candidateBookingIds) {
    const cid = contractIdByBooking.get(bid);
    if (cid != null) return cid;
  }
  return null;
}
