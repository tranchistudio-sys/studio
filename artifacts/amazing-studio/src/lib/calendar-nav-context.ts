/**
 * calendar-nav-context.ts — chọn NGÀY LỊCH quay về sau khi lưu show.
 *
 * SỰ CỐ (chủ báo 31/07/2026): xem lịch tháng 10, mở show 18/10 (một dịch vụ trong HỢP ĐỒNG
 * NHIỀU DỊCH VỤ) để sửa, bấm "Lưu show" → lịch nhảy về 20/09 = ngày của Dịch vụ 1. Nguyên nhân:
 * nhánh lưu hợp đồng gộp trả về `subDrafts[0].shootDate` — luôn là DỊCH VỤ ĐẦU DANH SÁCH.
 *
 * Chữa: nhớ show người dùng đã bấm (id + ngày) rồi bám ĐÚNG dịch vụ đó khi lưu.
 * Tách thuần ở đây để test không cần render React (FE chỉ có vitest logic, không jsdom).
 */

/** Chế độ lịch lúc mở show — cũng là chế độ phải quay về sau khi lưu. */
export type CalendarViewMode = "month" | "week" | "day";

/** Ngữ cảnh ghi lại đúng lúc người dùng bấm mở một show trên lịch. */
export type ShowOrigin = {
  /** id hàng booking đã bấm. Hợp đồng gộp: id DỊCH VỤ CON, không phải id cha. */
  bookingId: number | null;
  /** Ngày của thẻ đã bấm (yyyy-MM-dd). */
  dateISO: string | null;
  view: CalendarViewMode;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Chuẩn hoá về yyyy-MM-dd; không hợp lệ → null (không để "Invalid Date" lọt ra). */
export function isoDateOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const head = v.slice(0, 10);
  return ISO_DATE.test(head) ? head : null;
}

/**
 * Ngày lịch phải quay về sau khi lưu — bám ĐÚNG dịch vụ người dùng đang sửa:
 *  1. Khớp `siblingId` với show đã bấm ⇒ theo ngày (mới) của CHÍNH dịch vụ đó.
 *  2. Form chỉ có 1 dòng (đơn lẻ) ⇒ dòng đó chính là show đang sửa.
 *  3. Không khớp được (dịch vụ vừa bị gỡ, hoặc tạo mới) ⇒ ngày người dùng đã mở show, rồi mới tới
 *     fallback của form. TUYỆT ĐỐI không lấy `drafts[0]` khi có nhiều dịch vụ.
 */
export function pickReturnDate(args: {
  origin: ShowOrigin | null;
  drafts: { siblingId?: number | null; shootDate?: string | null }[];
  /** Ngày mặc định của form — chỉ dùng cho luồng TẠO MỚI (chưa có ngữ cảnh). */
  fallback?: string | null;
}): string | null {
  const { origin } = args;
  const drafts = Array.isArray(args.drafts) ? args.drafts : [];
  const clicked = isoDateOrNull(origin?.dateISO);

  const focus = (origin?.bookingId != null
    ? drafts.find(d => d?.siblingId != null && Number(d.siblingId) === origin.bookingId)
    : undefined) ?? (drafts.length === 1 ? drafts[0] : undefined);

  return isoDateOrNull(focus?.shootDate) ?? clicked ?? isoDateOrNull(args.fallback);
}
