/**
 * dress-lifecycle.ts — logic THUẦN cho vòng đời thuê váy theo từng sản phẩm.
 * Không đọc DB, không tiền. Dùng chung FE + BE (BE import; FE có bản mirror nhỏ).
 *
 * status LƯU trong DB (8 trạng thái):
 *   reserved | preparing | picked_up | waiting_return | returned | cleaning | ready | cancelled
 * "overdue" KHÔNG lưu — TÍNH TỰ ĐỘNG từ status + return_date + actual_return_date.
 */

export type DressStatus =
  | "reserved" | "preparing" | "picked_up" | "waiting_return"
  | "returned" | "cleaning" | "ready" | "cancelled";

export const DRESS_STATUSES: DressStatus[] = [
  "reserved", "preparing", "picked_up", "waiting_return", "returned", "cleaning", "ready", "cancelled",
];

/** Trạng thái HIỂN THỊ = status lưu + "overdue" suy ra. */
export type EffectiveDressStatus = DressStatus | "overdue";

function ymd(d: string | Date | null | undefined): string {
  if (!d) return "";
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/**
 * Quá hạn (derived): đang ở tay khách (picked_up/waiting_return), đã qua ngày trả dự kiến,
 * mà CHƯA có ngày trả thực tế. today dạng "YYYY-MM-DD".
 */
export function isOverdue(
  status: string,
  returnDate: string | Date | null | undefined,
  actualReturnDate: string | Date | null | undefined,
  today: string,
): boolean {
  if (status !== "picked_up" && status !== "waiting_return") return false;
  if (ymd(actualReturnDate)) return false;
  const rd = ymd(returnDate);
  return !!rd && rd < ymd(today);
}

/** Trạng thái hiển thị hiệu dụng (đắp "overdue" lên trên status lưu). */
export function effectiveDressStatus(
  row: { status: string; returnDate?: string | Date | null; actualReturnDate?: string | Date | null },
  today: string,
): EffectiveDressStatus {
  if (isOverdue(row.status, row.returnDate, row.actualReturnDate, today)) return "overdue";
  return (DRESS_STATUSES as string[]).includes(row.status) ? (row.status as DressStatus) : "reserved";
}

/** Váy có đang CHIẾM DỤNG (chưa sẵn sàng cho khách khác) không. cleaning vẫn chiếm. */
export function isBlockingStatus(status: string): boolean {
  // ready/returned/cancelled = không chiếm; còn lại (kể cả cleaning) = đang chiếm.
  return status !== "ready" && status !== "returned" && status !== "cancelled";
}

/** Hành động vòng đời từ UI → (status mới, cột ngày thực tế cần set). */
export type LifecycleAction = "pick_up" | "receive_back" | "start_cleaning" | "mark_ready" | "set_preparing";

export type LifecycleTransition = {
  status: DressStatus;
  setActualPickup?: boolean;
  setActualReturn?: boolean;
};

/** null = hành động không hợp lệ với trạng thái hiện tại. */
export function resolveLifecycleTransition(action: LifecycleAction, current: string): LifecycleTransition | null {
  switch (action) {
    case "set_preparing":
      // Chỉ từ reserved (bắt đầu chuẩn bị trước khi khách lấy).
      return current === "reserved" || current === "ready" ? { status: "preparing" } : null;
    case "pick_up":
      // Khách đã lấy: từ reserved/preparing → picked_up, ghi ngày lấy thực tế.
      return current === "reserved" || current === "preparing"
        ? { status: "picked_up", setActualPickup: true }
        : null;
    case "receive_back":
      // Đã nhận lại: từ picked_up/waiting_return → CLEANING (KHÔNG về ready ngay),
      // ghi ngày trả thực tế.
      return current === "picked_up" || current === "waiting_return"
        ? { status: "cleaning", setActualReturn: true }
        : null;
    case "start_cleaning":
      // Chuyển giặt thủ công (vd đã returned mà giờ mới giặt).
      return current === "returned" || current === "picked_up" || current === "waiting_return"
        ? { status: "cleaning" }
        : null;
    case "mark_ready":
      // Sẵn sàng: chỉ sau cleaning/returned. Đây là bước DUY NHẤT cho thuê tiếp.
      return current === "cleaning" || current === "returned" ? { status: "ready" } : null;
    default:
      return null;
  }
}

/** Gợi ý ngày lấy/trả mặc định từ ngày cưới: lấy trước N ngày, trả sau N ngày. */
export function suggestDressDates(weddingDate: string, beforeDays = 3, afterDays = 3): { pickupDate: string; returnDate: string } {
  const base = ymd(weddingDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return { pickupDate: "", returnDate: "" };
  const shift = (iso: string, days: number): string => {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  };
  return { pickupDate: shift(base, -beforeDays), returnDate: shift(base, afterDays) };
}
