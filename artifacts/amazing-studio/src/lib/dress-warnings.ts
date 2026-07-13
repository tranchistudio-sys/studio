/**
 * dress-warnings.ts — logic THUẦN tính chip nhắc thuê đồ trên Lịch.
 * Không React, không tiền. Mirror pattern leavesByDate của calendar.
 *
 * Nguồn: gói/nhóm bảng giá gạt "Thuê đồ" (warn_upcoming_show) → MỌI đơn dùng gói
 * tự sinh reminder, KHÔNG cần gắn váy cụ thể (mã váy gắn thêm chỉ để hiển thị).
 *
 * 2 loại row từ BE:
 * - "rental" — reminder per ĐƠN GỐC (family = gốc + con + ngày thực hiện phụ):
 *   · Lấy đồ: chip VÀNG [ngàyĐẦU−N .. ngàyĐẦU−1] (N mặc định 3, chỉnh per booking).
 *     Tới ngày thực hiện thì thôi không nhắc lấy nữa.
 *   · Trả đồ: chip CAM đúng ngày (ngàyCUỐI + M) (M mặc định 2, chỉnh per booking).
 *     Nhiều ngày thực hiện → mốc trả là ngày CUỐI CÙNG, không phải ngày đầu.
 *     Tất cả váy gắn (nếu có) đã trả xong → tự tắt nhắc trả.
 * - "overdue" — váy THẬT quá hạn trả (picked_up/waiting_return, quá return_date):
 *   chip ĐỎ ở ngày trả + bám ở HÔM NAY tới khi bấm "Nhận lại đồ" (đòi váy).
 *
 * Chip là reminder phụ: không phải booking, không đụng doanh thu/công nợ/lương.
 */

export type RentalReminder = {
  kind: "rental";
  bookingId: number;        // booking để mở khi bấm chip (đơn dịch vụ thật, không phải hợp đồng gộp)
  rootId: number;
  orderCode: string | null;
  customerName: string | null;
  firstDate: string;        // ngày thực hiện ĐẦU TIÊN của cả đơn (YYYY-MM-DD)
  lastDate: string;         // ngày thực hiện CUỐI CÙNG của cả đơn
  pickupDaysBefore: number; // nhắc lấy trước N ngày (mặc định 3)
  returnDaysAfter: number;  // nhắc trả sau M ngày (mặc định 2)
  dressCodes: string[];     // mã váy gắn thêm (nếu có) — chỉ hiển thị
  hasDresses: boolean;
  allReturned: boolean;     // có váy và TẤT CẢ đã trả → tắt nhắc trả
};

export type OverdueReminder = {
  kind: "overdue";
  id: number;
  bookingId: number;
  orderCode: string | null;
  customerName: string | null;
  dressCode: string | null;
  returnDate: string;
};

export type DressWarnRow = RentalReminder | OverdueReminder;

export type DressWarnChip = {
  key: string;
  kind: "pickup" | "return";
  bookingId: number;
  label: string;
  overdue: boolean;
};

function ymd(d: string | null | undefined): string {
  return (d ?? "").slice(0, 10);
}

/** Cộng số ngày vào chuỗi YYYY-MM-DD (dùng UTC để không lệch múi giờ). */
export function shiftYmd(dateStr: string, days: number): string {
  const s = ymd(dateStr);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Liệt kê các ngày YYYY-MM-DD trong [start, end] (bao gồm 2 đầu). Trả rỗng nếu start > end. */
export function daysBetween(startYmd: string, endYmd: string, cap = 400): string[] {
  const a = ymd(startYmd), b = ymd(endYmd);
  if (!a || !b || a > b) return [];
  const out: string[] = [];
  let cur = a;
  let guard = 0;
  while (cur <= b && guard < cap) { out.push(cur); cur = shiftYmd(cur, 1); guard++; }
  return out;
}

function clampDays(n: unknown, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(30, Math.max(0, Math.floor(v)));
}

/** Dựng Map ngày(YYYY-MM-DD) → danh sách chip nhắc. today = "YYYY-MM-DD". */
export function buildDressWarningsByDate(rows: DressWarnRow[], today: string): Map<string, DressWarnChip[]> {
  const map = new Map<string, DressWarnChip[]>();
  const add = (dayKey: string, chip: DressWarnChip) => {
    if (!dayKey) return;
    const arr = map.get(dayKey);
    if (arr) arr.push(chip); else map.set(dayKey, [chip]);
  };
  const t = ymd(today);
  for (const r of rows) {
    const who = `${r.customerName || "Khách"} · ${r.orderCode || "DH"}`;
    if (r.kind === "rental") {
      const codes = Array.isArray(r.dressCodes) && r.dressCodes.length > 0 ? ` (${r.dressCodes.join(", ")})` : "";
      // ── Lấy đồ: [ngàyĐẦU−N .. ngàyĐẦU−1], KHÔNG gồm ngày thực hiện ──
      const first = ymd(r.firstDate);
      const n = clampDays(r.pickupDaysBefore, 3);
      if (n > 0) {
        for (const day of daysBetween(shiftYmd(first, -n), shiftYmd(first, -1))) {
          add(day, { key: `pick-${r.rootId}-${day}`, kind: "pickup", bookingId: r.bookingId, label: `Sắp lấy đồ${codes}: ${who}`, overdue: false });
        }
      }
      // ── Trả đồ: đúng ngày (ngàyCUỐI + M). Váy gắn đã trả hết → thôi nhắc ──
      if (!(r.hasDresses && r.allReturned)) {
        const retDay = shiftYmd(ymd(r.lastDate), clampDays(r.returnDaysAfter, 2));
        add(retDay, { key: `ret-${r.rootId}`, kind: "return", bookingId: r.bookingId, label: `Nhắc trả đồ${codes}: ${who}`, overdue: false });
      }
      continue;
    }
    // ── overdue: váy thật quá hạn — chip đỏ ở ngày trả + bám hôm nay (đòi váy) ──
    const code = r.dressCode ? ` (${r.dressCode})` : "";
    const rt = ymd(r.returnDate);
    add(rt, { key: `ovd-${r.id}-${rt}`, kind: "return", bookingId: r.bookingId, label: `QUÁ HẠN trả đồ${code}: ${who}`, overdue: true });
    if (t && t !== rt) {
      add(t, { key: `ovd-${r.id}-today`, kind: "return", bookingId: r.bookingId, label: `QUÁ HẠN trả đồ${code}: ${who}`, overdue: true });
    }
  }
  return map;
}
