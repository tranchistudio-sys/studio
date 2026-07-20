/**
 * service-days.ts — danh sách NGÀY THỰC HIỆN của MỘT dòng dịch vụ (1 booking row).
 *
 * Ngày 1 = booking.shootDate; ngày 2..n = booking_occurrences (thuần lịch, KHÔNG có tiền).
 *
 * Yêu cầu chủ studio 20/07: ngày phải nằm NGAY TẠI DÒNG DỊCH VỤ (màn xem show +
 * hợp đồng) để khách nhìn phát là biết show đi mấy ngày — không để riêng một ô
 * phía trên, dễ lạc thông tin. Helper thuần để 3 nơi hiển thị (card dịch vụ trong
 * app, hợp đồng in/xuất ảnh, hợp đồng React) dùng CHUNG một cách đánh số ngày.
 */

export type ServiceDaySource = {
  shootDate?: string | null;
  shootTime?: string | null;
  occurrences?: { shootDate?: string | null; shootTime?: string | null; label?: string | null }[] | null;
};

export type ServiceDay = {
  /** dd/MM/yyyy — "" nếu ngày rỗng/không đọc được (chỗ gọi tự bỏ qua, không vẽ). */
  date: string;
  /** HH:mm hoặc null nếu không có giờ. */
  time: string | null;
  /** Nhãn ngày phụ ("Nhà gái", "Rước dâu"…). Ngày 1 không có nhãn. */
  label: string | null;
  /** Số thứ tự ngày, bắt đầu từ 1. */
  index: number;
  /** Tổng số ngày của dịch vụ này (1 = show 1 ngày). */
  total: number;
};

/**
 * dd/MM/yyyy. Chuỗi "YYYY-MM-DD..." cắt thẳng (không qua Date → không lệch múi
 * giờ, giống chỗ đang vẽ ngày phụ hiện tại); dạng khác mới fallback qua Date.
 */
export function formatDayDate(input: string | null | undefined): string {
  if (!input) return "";
  const s = String(input);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

/** HH:mm; "" / null → null. */
function fmtTime(input: string | null | undefined): string | null {
  const t = (input ?? "").slice(0, 5);
  return t.length === 5 ? t : null;
}

/**
 * Ngày chính + các ngày phụ, đã đánh số và format sẵn.
 * Dịch vụ 1 ngày → đúng 1 phần tử (total = 1) → chỗ gọi giữ nguyên giao diện cũ.
 * Ngày phụ thiếu giờ thì mượn giờ ngày chính (form vẫn cho để trống).
 */
export function serviceDays(svc: ServiceDaySource | null | undefined): ServiceDay[] {
  const mainDate = formatDayDate(svc?.shootDate);
  const mainTime = fmtTime(svc?.shootTime);
  const occ = Array.isArray(svc?.occurrences) ? svc!.occurrences! : [];
  // Ngày phụ rỗng (không có ngày) coi như không tồn tại — không đẩy số ngày lên sai.
  const extras = occ.filter(o => formatDayDate(o?.shootDate) !== "");
  const total = extras.length + 1;
  return [
    { date: mainDate, time: mainTime, label: null, index: 1, total },
    ...extras.map((o, i) => ({
      date: formatDayDate(o.shootDate),
      time: fmtTime(o.shootTime) ?? mainTime,
      label: (o.label ?? "").trim() || null,
      index: i + 2,
      total,
    })),
  ];
}

/** Có nhiều hơn 1 ngày thực hiện? */
export function isMultiDayService(svc: ServiceDaySource | null | undefined): boolean {
  return serviceDays(svc).length > 1;
}

/**
 * Một dòng ngày dạng text thuần — dùng cho hợp đồng in/xuất ảnh (HTML string,
 * nội dung bị escape nên không nhét markup được).
 * 1 ngày:  "📅 15/10/2026 • 08:00"
 * n ngày:  "📅 Ngày 2/2: 18/10/2026 • 08:00 — Rước dâu"
 */
export function serviceDayText(d: ServiceDay): string {
  const prefix = d.total > 1 ? `Ngày ${d.index}/${d.total}: ` : "";
  const time = d.time ? ` • ${d.time}` : "";
  const label = d.label ? ` — ${d.label}` : "";
  return `📅 ${prefix}${d.date}${time}${label}`;
}

/** Toàn bộ dòng ngày của 1 dịch vụ; [] nếu dịch vụ chưa có ngày nào. */
export function serviceDayTextLines(svc: ServiceDaySource | null | undefined): string[] {
  return serviceDays(svc).filter(d => d.date !== "").map(serviceDayText);
}
