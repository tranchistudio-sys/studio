/**
 * dress-warnings.ts — logic THUẦN tính chip cảnh báo lấy/trả váy trên Lịch.
 * Không React, không tiền. Mirror pattern leavesByDate của calendar.
 *
 * - Cảnh báo LẤY: hiện ĐÚNG 3 ngày TRƯỚC ngày lấy [pickup−3 .. pickup−1] (KHÔNG gồm
 *   ngày lấy) khi váy CHƯA lấy (reserved/preparing). Tự tắt khi "Khách đã lấy".
 * - Cảnh báo TRẢ: PERSISTENT — hiện ở ngày trả; nếu QUÁ HẠN chưa trả (return < hôm nay,
 *   status còn picked_up/waiting_return) thì hiện thêm ở HÔM NAY để luôn thấy ("đòi váy").
 *   Tắt ngay khi xác nhận đã trả (actualReturnDate có / status returned+).
 */

export type DressWarnRow = {
  id: number;
  bookingId: number;
  orderCode: string | null;
  customerName: string | null;
  pickupDate: string;
  returnDate: string;
  status: string;
  actualReturnDate?: string | null;
};

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

const NOT_YET_PICKED = new Set(["reserved", "preparing"]);
const STILL_OUT = new Set(["picked_up", "waiting_return"]);

/** Dựng Map ngày(YYYY-MM-DD) → danh sách chip cảnh báo. today = "YYYY-MM-DD". */
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
    // ── Cảnh báo LẤY: chưa lấy → [pickup−3 .. pickup] ──
    if (NOT_YET_PICKED.has(r.status)) {
      const pk = ymd(r.pickupDate);
      // ĐÚNG 3 ngày trước, KHÔNG gồm ngày lấy: [pk−3 .. pk−1].
      for (const day of daysBetween(shiftYmd(pk, -3), shiftYmd(pk, -1))) {
        add(day, { key: `pick-${r.id}-${day}`, kind: "pickup", bookingId: r.bookingId, label: `Sắp lấy váy: ${who}`, overdue: false });
      }
    }
    // ── Cảnh báo TRẢ: còn ở tay khách + chưa xác nhận trả ──
    if (STILL_OUT.has(r.status) && !ymd(r.actualReturnDate)) {
      const rt = ymd(r.returnDate);
      const overdue = !!rt && !!t && rt < t;
      add(rt, { key: `ret-${r.id}-${rt}`, kind: "return", bookingId: r.bookingId, label: `${overdue ? "QUÁ HẠN trả váy" : "Trả váy"}: ${who}`, overdue });
      // Quá hạn → hiện thêm ở HÔM NAY để luôn thấy (persistent, đòi váy)
      if (overdue && t !== rt) {
        add(t, { key: `ret-${r.id}-today`, kind: "return", bookingId: r.bookingId, label: `QUÁ HẠN trả váy: ${who}`, overdue: true });
      }
    }
  }
  return map;
}
