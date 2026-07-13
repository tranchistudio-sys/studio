/**
 * booking-occurrences.ts — helper thuần cho "dịch vụ nhiều ngày thực hiện".
 *
 * Mô hình: Ngày 1 = bookings.shoot_date/shoot_time (nguồn chuẩn cũ, không đổi);
 * ngày 2..n = bảng booking_occurrences (thuần lịch trình + nhãn, KHÔNG có tiền).
 */

export type OccurrenceLike = {
  id?: number;
  shootDate: string;
  shootTime?: string | null;
};

/** Chuẩn hóa giờ về "HH:MM" để so trùng ("05:00:00" ≡ "05:00"; null/"" ≡ ""). */
export function normalizeTime(t: string | null | undefined): string {
  return (t ?? "").slice(0, 5);
}

/** Chuẩn hóa ngày về "YYYY-MM-DD" (nhận cả ISO datetime từ pg date serialize). */
export function normalizeDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  if (d instanceof Date) {
    // pg date → Date lúc nửa đêm UTC; lấy phần ngày theo ISO là đúng ngày lưu.
    return d.toISOString().slice(0, 10);
  }
  return String(d).slice(0, 10);
}

/**
 * Ngày+giờ ứng viên có TRÙNG HOÀN TOÀN với ngày chính của booking hoặc một
 * occurrence khác không (bỏ qua chính nó khi sửa — excludeId).
 */
export function isDuplicateOccurrence(
  candidate: { shootDate: string; shootTime?: string | null },
  mainDate: string | Date,
  mainTime: string | null | undefined,
  existing: OccurrenceLike[],
  excludeId?: number,
): boolean {
  const cd = normalizeDate(candidate.shootDate);
  const ct = normalizeTime(candidate.shootTime);
  if (cd === normalizeDate(mainDate) && ct === normalizeTime(mainTime)) return true;
  return existing.some(
    (o) =>
      (excludeId === undefined || o.id !== excludeId) &&
      normalizeDate(o.shootDate) === cd &&
      normalizeTime(o.shootTime) === ct,
  );
}

/** Nhãn hiển thị trên lịch: "Ngày 2/3 — Rước dâu" (label rỗng thì chỉ "Ngày 2/3"). */
export function occurrenceDayLabel(index1Based: number, total: number, label?: string | null): string {
  const base = `Ngày ${index1Based}/${total}`;
  const l = (label ?? "").trim();
  return l ? `${base} — ${l}` : base;
}
