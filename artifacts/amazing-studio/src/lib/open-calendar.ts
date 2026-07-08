/**
 * open-calendar.ts — logic THUẦN cho shortcut "Mở lịch chụp" (điều hướng về đúng show trên Calendar).
 *
 * Calendar (pages/calendar.tsx) đã hỗ trợ deep-link `?bookingId=N`: tự nhảy đúng ngày/tháng của
 * show + mở detail panel + phản ứng ngay cả khi đang ở sẵn /calendar + tự dọn query khỏi URL.
 * Vì vậy nút chỉ cần điều hướng tới URL này với bookingId — không cần thêm API/route.
 *
 * Tách thuần ở đây để test không cần render React (FE project chỉ có vitest logic, không jsdom).
 */

/** URL deep-link mở đúng booking/show trên Calendar. */
export function bookingCalendarUrl(bookingId: number): string {
  return `/calendar?bookingId=${bookingId}`;
}

/**
 * Có được phép hiện nút "Mở lịch chụp" cho item này không — CHỈ khi có bookingId hợp lệ (số nguyên
 * dương). Item không gắn booking (ad_hoc / chi phí chung / rental) hoặc booking đã bị xóa cứng (id
 * null) ⇒ không hiện nút (yêu cầu: không hiện nút nếu không còn lịch chụp).
 */
export function canOpenBookingCalendar(bookingId: number | null | undefined): boolean {
  return typeof bookingId === "number" && Number.isInteger(bookingId) && bookingId > 0;
}
