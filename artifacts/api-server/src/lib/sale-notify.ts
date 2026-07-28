/**
 * sale-notify.ts — khóa dedupe + cờ cho NOTIFICATION của Lulu (Đợt 1 PR-B). THUẦN.
 *
 * Vá gốc điều tra 09/07: bot off / khách mới / khách để SĐT — hệ thống CHỈ ghi DB,
 * không báo ai → 5 khách treo 7 ngày "sale ngồi không vì không được báo".
 *
 * CHỐNG SPAM bằng hạ tầng sẵn có: bảng notifications có partial-unique index trên
 * dedupe_key + emitNotification ON CONFLICT DO NOTHING (trùng key → bỏ cả SSE lẫn
 * push). Chu kỳ thời gian MÃ HÓA VÀO KEY (tiền lệ: deadline checker dùng key theo
 * ngày) — race-safe cả khi nhiều instance autoscale cùng bắn.
 *
 * Cờ LULU_NOTIFY_ENABLED (mặc định TẮT).
 */

export function isLuluNotifyEnabled(): boolean {
  return /^(1|true|yes)$/i.test((process.env.LULU_NOTIFY_ENABLED ?? "").trim());
}

/** Bucket giờ UTC "2026-07-28T09" — tối đa 1 noti/khóa/giờ. */
export function hourBucket(d: Date): string {
  return d.toISOString().slice(0, 13);
}

/** Bucket ngày UTC "2026-07-28" — tối đa 1 noti/khóa/ngày. */
export function dayBucket(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Khách nhắn khi BOT ĐANG TẮT — 1 noti/khách/giờ (khách nhắn 10 tin không thành 10 noti). */
export function botOffKey(psid: string, d: Date): string {
  return `lulu_botoff_${psid}_${hourBucket(d)}`;
}

/** Khách MỚI lần đầu nhắn page — 1 noti/khách TRỌN ĐỜI. */
export function newLeadKey(psid: string): string {
  return `lulu_newlead_${psid}`;
}

/** Khách để SĐT — 1 noti/khách/ngày. */
export function phoneKey(psid: string, d: Date): string {
  return `lulu_phone_${psid}_${dayBucket(d)}`;
}

/** Khách thể hiện ý định đặt lịch — 1 noti/khách/ngày. */
export function apptKey(psid: string, d: Date): string {
  return `lulu_appt_${psid}_${dayBucket(d)}`;
}

/** Escalation cần người thật — 1 noti/khách/ngày (đủ nhắc, không dội). */
export function escKey(psid: string, d: Date): string {
  return `lulu_esc_${psid}_${dayBucket(d)}`;
}

/** Lỗi nghiêm trọng khiến Lulu không trả lời được — 1 noti/giờ TOÀN HỆ (chống bão). */
export function errorKey(d: Date): string {
  return `lulu_error_${hourBucket(d)}`;
}
