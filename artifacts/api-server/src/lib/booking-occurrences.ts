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

// ─── Sync ngày phụ TRONG transaction PUT /bookings/:id ───────────────────────
// Trước đây frontend tự sync bằng nhiều request rời (GET + PUT/POST/DELETE từng
// ngày) SAU khi booking đã lưu → lỗi giữa chừng là booking mới nhưng ngày phụ cũ.
// Giờ payload Lưu gửi kèm `occurrences`, backend diff + ghi trong CÙNG transaction.

export type OccurrenceDraftSanitized = {
  id: number | null;
  shootDate: string;
  shootTime: string | null;
  label: string | null;
};

export const MAX_OCCURRENCES_PER_BOOKING = 30;

/**
 * Validate + chuẩn hóa mảng occurrences từ body PUT /bookings/:id.
 * Trả lỗi CỤ THỂ để route 400 TRƯỚC khi mở transaction — payload sai thì không
 * ghi gì hết (atomic save: validate toàn bộ rồi mới đụng DB).
 */
export function sanitizeOccurrenceDrafts(
  raw: unknown,
): { ok: true; drafts: OccurrenceDraftSanitized[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "occurrences phải là mảng" };
  if (raw.length > MAX_OCCURRENCES_PER_BOOKING) {
    return { ok: false, error: `Tối đa ${MAX_OCCURRENCES_PER_BOOKING} ngày thực hiện phụ cho một dịch vụ` };
  }
  const drafts: OccurrenceDraftSanitized[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") return { ok: false, error: "Ngày thực hiện không hợp lệ" };
    const o = item as Record<string, unknown>;
    const shootDate = typeof o.shootDate === "string" ? o.shootDate.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(shootDate)) {
      return { ok: false, error: "Ngày thực hiện phụ không hợp lệ (YYYY-MM-DD)" };
    }
    const rawTime = o.shootTime;
    const shootTime =
      typeof rawTime === "string" && rawTime.trim() ? normalizeTime(rawTime) : null;
    if (shootTime !== null && !/^\d{2}:\d{2}$/.test(shootTime)) {
      return { ok: false, error: "Giờ thực hiện phụ không hợp lệ (HH:MM)" };
    }
    const label =
      typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 120) : null;
    const idNum = typeof o.id === "number" && Number.isInteger(o.id) && o.id > 0 ? o.id : null;
    drafts.push({ id: idNum, shootDate, shootTime, label });
  }
  return { ok: true, drafts };
}

export type OccurrenceSyncPlan = {
  toUpdate: { id: number; shootDate: string; shootTime: string | null; label: string | null }[];
  toInsert: { shootDate: string; shootTime: string | null; label: string | null }[];
  deleteIds: number[];
};

/**
 * Diff drafts (form) với rows hiện có (DB) → kế hoạch update/insert/delete.
 * - Draft có id khớp row hiện có → update row đó (đổi ngày = UPDATE in-place,
 *   KHÔNG delete-rồi-create → card lịch không bao giờ "mất tạm").
 * - Draft có id lạ (row đã bị xóa bởi người khác) → hạ xuống insert, không văng lỗi.
 * - Row hiện có không còn trong drafts → delete.
 * Trả lỗi khi 2 draft trùng hoàn toàn ngày+giờ, hoặc trùng với ngày chính của đơn.
 */
export function planOccurrencesSync(
  existing: { id: number }[],
  drafts: OccurrenceDraftSanitized[],
  mainDate: string | Date | null | undefined,
  mainTime: string | null | undefined,
): { ok: true; plan: OccurrenceSyncPlan } | { ok: false; error: string } {
  const seen = new Set<string>();
  const mainKey = `${normalizeDate(mainDate)}|${normalizeTime(mainTime)}`;
  // Message kèm NGÀY cụ thể (dd/mm/yyyy) — user phải biết sửa dòng nào (sự cố 19/07:
  // lỗi chung chung khiến người dùng tưởng "Cập nhật show không có tác dụng").
  const fmtDmy = (iso: string, t: string) => {
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}${t ? ` ${t}` : ""}`;
  };
  for (const d of drafts) {
    const t = normalizeTime(d.shootTime);
    const key = `${d.shootDate}|${t}`;
    if (key === mainKey) {
      return { ok: false, error: `Ngày thực hiện phụ ${fmtDmy(d.shootDate, t)} trùng hoàn toàn với ngày chính của dịch vụ — đổi ngày hoặc giờ rồi lưu lại` };
    }
    if (seen.has(key)) {
      return { ok: false, error: `Có hai ngày thực hiện phụ trùng hoàn toàn ngày + giờ (${fmtDmy(d.shootDate, t)}) — xóa bớt một dòng rồi lưu lại` };
    }
    seen.add(key);
  }
  const existingIds = new Set(existing.map((r) => r.id));
  const keptIds = new Set<number>();
  const plan: OccurrenceSyncPlan = { toUpdate: [], toInsert: [], deleteIds: [] };
  for (const d of drafts) {
    if (d.id != null && existingIds.has(d.id)) {
      keptIds.add(d.id);
      plan.toUpdate.push({ id: d.id, shootDate: d.shootDate, shootTime: d.shootTime, label: d.label });
    } else {
      plan.toInsert.push({ shootDate: d.shootDate, shootTime: d.shootTime, label: d.label });
    }
  }
  for (const r of existing) {
    if (!keptIds.has(r.id)) plan.deleteIds.push(r.id);
  }
  return { ok: true, plan };
}
