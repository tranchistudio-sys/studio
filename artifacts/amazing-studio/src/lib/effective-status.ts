/**
 * effective-status.ts — áp trạng thái HIỆU LỰC (statusOverride) vào object booking
 * trước khi bàn giao từ panel chi tiết sang form Chỉnh sửa.
 *
 * BUG (phát hiện 17/07 khi E2E PR #106): toggle "Báo giá tạm" ở panel chi tiết
 * PUT status + set statusOverride CỤC BỘ + invalidate cache, nhưng object
 * viewingBooking/parent/siblings bên ngoài vẫn là BẢN CŨ (state đã copy, refetch
 * không tự cập nhật). Bấm "Chỉnh sửa" → form init status cũ (tempQuoteMode=false)
 * → bấm Lưu → PUT đè status cũ → booking RỚT trạng thái temp_quote vừa toggle.
 *
 * Fix: mọi điểm bàn giao booking từ panel sang form phải đi qua hàm này. Toggle
 * flip CẢ GIA ĐÌNH trong 1 transaction (PR #100) nên override áp cho cha lẫn con.
 */
export function applyStatusOverride<T extends { status?: string | null }>(
  b: T,
  override: string | null | undefined,
): T {
  return override == null ? b : { ...b, status: override };
}
