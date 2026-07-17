/**
 * booking-cache.ts — invalidate TẬP TRUNG mọi query đọc từ booking sau khi lưu.
 *
 * Vấn đề gốc: staleTime toàn cục 5 phút (App.tsx) + mỗi màn tự invalidate lẻ tẻ
 * vài key → sửa booking xong mở Hợp đồng / Khách hàng / Đơn hàng / Tìm kiếm vẫn
 * thấy dữ liệu cũ tới 5 phút. Quy tắc mới: MỌI đường lưu booking (save form,
 * reschedule, đổi trạng thái, xóa, thêm/xóa dịch vụ con, sửa khách) gọi đúng 1
 * helper này SAU khi backend commit — không invalidate giữa chừng chuỗi lưu.
 *
 * invalidateQueries theo prefix: query đang mount refetch ngay, query không
 * mount chỉ bị đánh dấu stale → refetch khi mở màn đó. Rẻ, không refetch thừa.
 */
import type { QueryClient } from "@tanstack/react-query";

const BOOKING_RELATED_KEY_PREFIXES: string[] = [
  // Booking + lịch
  "bookings",
  "booking",
  "booking-full",
  "booking-items",
  "bookings-light",
  "child-removal-log",
  "booking-change-log",
  // Hợp đồng — trang danh sách + trang hợp đồng nội bộ + lịch sử
  "contracts",
  "contract-document",
  "contract-change-log",
  // Khách hàng
  "customers",
  "customers-light",
  "customer-detail",
  // Tìm kiếm toàn cục (tên/SĐT/mã đơn)
  "global-search",
  // Tiền: phiếu thu, gợi ý thu, tổng quan
  "payments",
  "payments-recent",
  "payments-monthly-list",
  "payments-overview",
  "payments-default-month",
  "payment-suggestions",
  // Dashboard + doanh thu (đọc tổng tiền/công nợ từ booking)
  "dashboard",
  "dashboard-simple",
  "dashboard-v2",
  "revenue-monthly",
  "revenue-today",
  "revenue-week",
  "revenue-by-service-v2",
  "revenue-by-sale",
  "revenue-daily-cashflow",
  "revenue-evidence",
  // Hậu kỳ (đọc dịch vụ/gói từ booking)
  "photoshop-booking-view",
  "photoshop-stats",
];

/** Gọi SAU khi mọi request lưu đã xong (commit) — một phát, phủ hết màn liên quan. */
export function invalidateBookingRelated(qc: QueryClient): void {
  for (const prefix of BOOKING_RELATED_KEY_PREFIXES) {
    qc.invalidateQueries({ queryKey: [prefix] });
  }
}
