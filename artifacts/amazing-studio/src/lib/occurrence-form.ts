/**
 * occurrence-form.ts — logic THUẦN cho "Ngày thực hiện phụ" trên form booking (calendar.tsx).
 *
 * Sự cố 19/07: "+ Thêm ngày" mặc định copy ĐÚNG ngày chính (giờ 08:00 = giờ mặc định form)
 * → ngày phụ trùng hoàn toàn ngày chính → backend từ chối 400 cả lượt lưu (atomic) →
 * banner lỗi nằm ĐẦU form ngoài tầm nhìn → người dùng tưởng "Cập nhật show không có tác dụng",
 * hợp đồng không thấy lịch. Với hợp đồng gộp còn tệ hơn: dịch vụ trước đã lưu, dịch vụ sau
 * fail → lưu nửa chừng.
 *
 * File này sửa tận gốc cả chuỗi:
 *  - defaultNewOccurrence: ngày mặc định KHÔNG BAO GIỜ trùng ngày chính (ngày lớn nhất + 1).
 *  - findOccurrenceConflict: mirror đúng rule backend (planOccurrencesSync) để chặn TRƯỚC
 *    khi gọi API — không còn lưu nửa chừng hợp đồng gộp vì lỗi trùng ngày.
 *  - occurrenceRowConflict: cờ đỏ inline từng dòng ngày phụ ngay khi đang gõ.
 *
 * Tách thuần để test không cần render React (FE chỉ có vitest logic, không jsdom).
 */

export type OccurrenceFormDraft = { id: number | null; shootDate: string; shootTime: string; label: string };

/** Chuẩn hóa giờ "HH:MM" để so trùng — mirror normalizeTime của backend. */
const normTime = (t: string | null | undefined): string => (t ?? "").slice(0, 5);
/** Chuẩn hóa ngày "YYYY-MM-DD" — mirror normalizeDate của backend. */
const normDate = (d: string | null | undefined): string => (d ?? "").slice(0, 10);

/** Cộng N ngày vào chuỗi YYYY-MM-DD (an toàn qua ranh giới tháng/năm, không lệ thuộc timezone máy). */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = normDate(dateStr).split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

const fmtDmy = (iso: string): string => {
  const [y, m, d] = normDate(iso).split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
};

/**
 * Draft mặc định cho nút "+ Thêm ngày": ngày = (ngày LỚN NHẤT trong ngày chính +
 * các ngày phụ hiện có) + 1 — đúng nhịp cưới nhiều ngày liên tiếp và không bao giờ
 * đẻ ra bản trùng; giờ = giờ ngày chính (fallback 08:00).
 */
export function defaultNewOccurrence(
  mainDate: string,
  mainTime: string,
  existing: OccurrenceFormDraft[],
): OccurrenceFormDraft {
  const dates = [normDate(mainDate), ...existing.map(o => normDate(o.shootDate))]
    .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s))
    .sort();
  const maxDate = dates[dates.length - 1];
  return {
    id: null,
    shootDate: maxDate ? addDays(maxDate, 1) : "",
    shootTime: normTime(mainTime) || "08:00",
    label: "",
  };
}

/** Dòng ngày phụ thứ `index` có trùng (ngày chính hoặc dòng khác) không — cho cờ đỏ inline. */
export function occurrenceRowConflict(
  occurrences: OccurrenceFormDraft[],
  index: number,
  mainDate: string,
  mainTime: string,
): boolean {
  const o = occurrences[index];
  if (!o) return false;
  const key = `${normDate(o.shootDate)}|${normTime(o.shootTime)}`;
  if (key === `${normDate(mainDate)}|${normTime(mainTime)}`) return true;
  return occurrences.some(
    (x, i) => i !== index && `${normDate(x.shootDate)}|${normTime(x.shootTime)}` === key,
  );
}

export type SubForConflict = {
  serviceLabel?: string | null;
  shootDate: string;
  shootTime: string;
  occurrences?: OccurrenceFormDraft[];
};

/**
 * Kiểm tra TOÀN BỘ các dịch vụ trước khi lưu — mirror rule backend planOccurrencesSync
 * (trùng hoàn toàn ngày+giờ với ngày chính, hoặc giữa hai ngày phụ với nhau).
 * Trả message tiếng Việt kèm TÊN DỊCH VỤ + NGÀY để người dùng biết sửa ở đâu; null = sạch.
 */
export function findOccurrenceConflict(subs: SubForConflict[]): string | null {
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    const name = (sub.serviceLabel ?? "").trim() || `Dịch vụ ${i + 1}`;
    const mainKey = `${normDate(sub.shootDate)}|${normTime(sub.shootTime)}`;
    const seen = new Set<string>();
    for (const o of sub.occurrences ?? []) {
      const when = `${fmtDmy(o.shootDate)}${normTime(o.shootTime) ? ` ${normTime(o.shootTime)}` : ""}`;
      const key = `${normDate(o.shootDate)}|${normTime(o.shootTime)}`;
      if (key === mainKey) {
        return `${name}: ngày thực hiện phụ ${when} trùng hoàn toàn với ngày chính của dịch vụ — đổi ngày hoặc giờ rồi bấm lưu lại (chưa có gì được lưu).`;
      }
      if (seen.has(key)) {
        return `${name}: có hai ngày thực hiện phụ trùng hoàn toàn ngày + giờ (${when}) — xóa bớt một dòng rồi bấm lưu lại (chưa có gì được lưu).`;
      }
      seen.add(key);
    }
  }
  return null;
}
