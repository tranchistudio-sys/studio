/**
 * booking-total.ts — nguồn chuẩn DUY NHẤT tính "tổng tiền kỳ vọng" của một booking
 * từ dữ liệu dịch vụ thực tế (items + dịch vụ cộng thêm), và đối chiếu với tổng
 * client gửi lên.
 *
 * Công thức PHẢI khớp 1:1 với form Chỉnh sửa show (calendar.tsx):
 *   - calcSubPackageTotal:  Σ mỗi dòng max(0, price + Σ phụ thu dòng − Σ giảm trừ dòng)
 *   - calcSubExtrasTotal:   Σ dòng cộng thêm hợp lệ (title không rỗng, unitPrice > 0):
 *                           (totalPrice || round(qty × unitPrice))
 *
 * Bối cảnh (sự cố DH0191 2026-07-12): form edit gửi totalAmount = tổng TẤT CẢ dịch vụ
 * trên form nhưng items chỉ có Dịch vụ 1 → backend ghi thẳng total 22.7tr trong khi
 * items 6.5tr → detail (đọc cột total) và edit (tính lại từ items) lệch nhau.
 * Guard này chặn việc lưu totalAmount mâu thuẫn với items ở booking THƯỜNG.
 * (Booking CHA không dùng guard này — tổng cha luôn recalc từ Σ con còn hiệu lực.)
 */

type MoneyLike = number | string | null | undefined;

export type OrderLineLike = {
  price?: MoneyLike;
  unitPrice?: MoneyLike;
  surcharges?: { amount?: MoneyLike }[] | null;
  deductions?: { amount?: MoneyLike }[] | null;
};

export type ExtraLineLike = {
  title?: string | null;
  qty?: MoneyLike;
  unitPrice?: MoneyLike;
  totalPrice?: MoneyLike;
};

function num(v: MoneyLike): number {
  const n = typeof v === "string" ? parseFloat(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Σ các dòng dịch vụ: max(0, giá dòng + phụ thu dòng − giảm trừ dòng). Mirror calcSubPackageTotal. */
export function sumOrderLines(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return (items as OrderLineLike[]).reduce((s, l) => {
    if (!l || typeof l !== "object") return s;
    // Form luôn gửi `price`; fallback `unitPrice` cho payload script/legacy.
    const base = num(l.price !== undefined && l.price !== null ? l.price : l.unitPrice);
    const surch = Array.isArray(l.surcharges) ? l.surcharges.reduce((x, sc) => x + num(sc?.amount), 0) : 0;
    const deduct = Array.isArray(l.deductions) ? l.deductions.reduce((x, d) => x + num(d?.amount), 0) : 0;
    return s + Math.max(0, base + surch - deduct);
  }, 0);
}

/** Σ dịch vụ cộng thêm hợp lệ (title + unitPrice>0): totalPrice || round(qty×unitPrice). Mirror calcSubExtrasTotal. */
export function sumAdditionalServices(extras: unknown): number {
  if (!Array.isArray(extras)) return 0;
  return (extras as ExtraLineLike[])
    .filter((l) => l && typeof l === "object" && (l.title || "").trim() && num(l.unitPrice) > 0)
    .reduce((x, l) => x + (num(l.totalPrice) || Math.round(num(l.qty) * num(l.unitPrice))), 0);
}

/** Tổng kỳ vọng của booking thường = Σ dòng dịch vụ + Σ dịch vụ cộng thêm. */
export function computeExpectedBookingTotal(items: unknown, extras: unknown): number {
  return sumOrderLines(items) + sumAdditionalServices(extras);
}

export type ResolvedTotal = {
  /** Tổng AN TOÀN để ghi DB. */
  total: number;
  /** true = client gửi tổng lệch khỏi dữ liệu dịch vụ và đã bị tính lại. */
  mismatch: boolean;
  /** Tổng kỳ vọng tính từ items+extras (0 nếu không tính được). */
  expected: number;
};

/**
 * Đối chiếu tổng client gửi với dữ liệu dịch vụ.
 * - expected ≤ 0 (items không mang giá — vd content lines của gói, hoặc rỗng):
 *   KHÔNG đủ dữ liệu để đối chiếu → giữ nguyên tổng client (không phá total hợp lệ).
 * - |client − expected| ≤ 1đ: khớp (dung sai làm tròn) → giữ tổng client.
 * - Lệch: trả expected (tự tính lại từ dữ liệu thực tế) + mismatch=true.
 */
export function resolveBookingTotal(
  clientTotal: MoneyLike,
  items: unknown,
  extras: unknown,
): ResolvedTotal {
  const client = num(clientTotal);
  const expected = computeExpectedBookingTotal(items, extras);
  if (expected <= 0) return { total: client, mismatch: false, expected };
  if (Math.abs(client - expected) <= 1) return { total: client, mismatch: false, expected };
  return { total: expected, mismatch: true, expected };
}

/** Tóm tắt items cho lịch sử chỉnh sửa: "N dịch vụ (tên...) — X đ". */
export function summarizeItemsForLog(items: unknown, fmtVND: (v: unknown) => string): string {
  if (!Array.isArray(items) || items.length === 0) return "(chưa có dịch vụ)";
  const names = (items as Record<string, unknown>[])
    .map((l) => String(l?.serviceName ?? l?.serviceLabel ?? "").trim())
    .filter(Boolean);
  const nameStr = names.length ? ` (${names.join(", ").slice(0, 120)})` : "";
  return `${items.length} dịch vụ${nameStr} — ${fmtVND(sumOrderLines(items))}`;
}
