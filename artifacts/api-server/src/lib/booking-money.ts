/**
 * booking-money.ts — NGUỒN TIỀN CHUẨN DUY NHẤT cho 1 booking.
 *
 * Mục tiêu: mọi module (doanh thu, công nợ, hoa hồng, lương, báo cáo, dashboard)
 * tính tiền của booking PHẢI gọi các hàm ở đây, thay vì mỗi nơi tự tính một kiểu.
 *
 * QUYẾT ĐỊNH NGHIỆP VỤ (chủ studio chốt 2026-06-26):
 *  1. Doanh thu/lợi nhuận = NET = (giá gốc − giảm giá).  [net]
 *  2. "Tháng doanh thu" gom theo NGÀY KHÁCH TRẢ tiền (xử lý ở tầng query, không ở đây).
 *  3. Hoa hồng Sale = MỘT con số % theo từng nhân viên (staff.commission_rate),
 *     KHÔNG lấy từ bảng giá/gói.  [commissionForStaff]
 *  4. Hoa hồng tính trên TIỀN KHÁCH ĐÃ TRẢ (collected), đã trừ giảm giá.
 *     → commissionable = paid.
 *
 * QUY ƯỚC DỮ LIỆU (đã xác minh từ schema + code hiện tại):
 *  - bookings.total_amount  = gói + phụ thu − giảm-trừ-dòng (KHÔNG gồm giảm giá toàn đơn,
 *    KHÔNG gồm dịch vụ cộng thêm).
 *  - bookings.discount_amount = giảm giá toàn đơn (lưu DƯƠNG).
 *  - bookings.additional_services = dịch vụ cộng thêm bán cho khách (có unitPrice/totalPrice)
 *    → LÀ doanh thu của đơn nhưng hiện KHÔNG nằm trong total_amount ⇒ phải cộng vào gross.
 *  - payments.amount luôn DƯƠNG; phân biệt bằng payment_type:
 *      'payment' | 'deposit' | 'ad_hoc' | 'refund'; status: 'active' | 'voided'.
 *  - refund LƯU DƯƠNG, KHÔNG bao giờ là tiền thu vào.
 *  - ad_hoc = thu lẻ KHÔNG gắn đơn ⇒ KHÔNG tính vào "đã thu" của 1 booking cụ thể.
 */

// ─── Tiện ích số tiền an toàn ────────────────────────────────────────────────
/** Parse mọi kiểu (number/string/null) về số hữu hạn; lỗi/NaN → 0. */
export function money(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v == null) return 0;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

const clampMin0 = (n: number): number => (n > 0 ? n : 0);

// ─── Kiểu dữ liệu vào ────────────────────────────────────────────────────────
export type MoneyBookingInput = {
  totalAmount: number | string | null | undefined;
  discountAmount?: number | string | null;
  /** Tổng dịch vụ cộng thêm (đã tính sẵn). Nếu không truyền sẽ coi như 0. */
  additionalServicesTotal?: number | string | null;
};

export type MoneyPaymentInput = {
  amount: number | string | null | undefined;
  paymentType?: string | null; // 'payment' | 'deposit' | 'ad_hoc' | 'refund'
  status?: string | null; // 'active' | 'voided'
};

export type BookingMoney = {
  gross: number; // giá gốc (gói + phụ thu + dịch vụ cộng thêm)
  discount: number; // giảm giá toàn đơn (đã clamp 0..gross)
  net: number; // DOANH THU = gross − discount
  paid: number; // đã thu (loại refund + voided + ad_hoc)
  refunded: number; // tổng hoàn tiền
  remaining: number; // CÔNG NỢ = max(0, net − paid)
  commissionable: number; // cơ sở tính hoa hồng = paid (tiền đã trả)
};

// ─── Phân loại phiếu thu ─────────────────────────────────────────────────────
/** Phiếu được tính là "đã thu" của 1 booking: không hủy, không phải refund, không phải ad_hoc. */
export function isCollectedPayment(p: MoneyPaymentInput): boolean {
  const type = p.paymentType ?? "payment";
  const status = p.status ?? "active";
  return status !== "voided" && type !== "refund" && type !== "ad_hoc";
}

/** Phiếu hoàn tiền còn hiệu lực (không hủy). */
export function isRefundPayment(p: MoneyPaymentInput): boolean {
  const status = p.status ?? "active";
  return status !== "voided" && (p.paymentType ?? "") === "refund";
}

export function sumCollected(payments: readonly MoneyPaymentInput[]): number {
  return payments.reduce((s, p) => (isCollectedPayment(p) ? s + money(p.amount) : s), 0);
}

export function sumRefunded(payments: readonly MoneyPaymentInput[]): number {
  return payments.reduce((s, p) => (isRefundPayment(p) ? s + money(p.amount) : s), 0);
}

// ─── Tính bộ tiền chuẩn cho 1 booking ────────────────────────────────────────
/**
 * Tính bộ số tiền chuẩn cho MỘT booking đứng độc lập.
 * Lưu ý: với hợp đồng cha-con, discount/payments nằm ở CHA; caller phải truyền
 * đúng booking (cha) + payments của cha khi muốn số tổng hợp đồng.
 */
export function computeBookingMoney(
  booking: MoneyBookingInput,
  payments: readonly MoneyPaymentInput[] = [],
): BookingMoney {
  const base = money(booking.totalAmount);
  const addl = money(booking.additionalServicesTotal);
  const gross = clampMin0(base + addl);

  // Giảm giá không vượt quá giá gốc (chống nhập nhầm → net âm).
  const discount = Math.min(clampMin0(money(booking.discountAmount)), gross);
  const net = clampMin0(gross - discount);

  const paid = sumCollected(payments);
  const refunded = sumRefunded(payments);
  const remaining = clampMin0(net - paid);
  const commissionable = paid; // chủ chốt: hoa hồng trên tiền ĐÃ TRẢ

  return { gross, discount, net, paid, refunded, remaining, commissionable };
}

// ─── Hoa hồng Sale theo cấu hình NHÂN VIÊN ───────────────────────────────────
export type CommissionResult = {
  ratePercent: number; // % áp dụng
  amount: number; // tiền hoa hồng (đã làm tròn về đồng)
  missingConfig: boolean; // true = nhân viên CHƯA cấu hình % → KHÔNG tính bừa
};

/**
 * Hoa hồng cho 1 nhân viên Sale = ratePercent% × commissionable (tiền đã trả).
 * Nếu nhân viên chưa cấu hình % (null/undefined/không phải số) → trả 0 + missingConfig=true,
 * KHÔNG tự đoán (theo yêu cầu chủ).
 *
 * @param commissionRatePercent  staff.commission_rate (vd 7 = 7%)
 * @param commissionableAmount   thường = BookingMoney.commissionable (đã thu)
 */
export function commissionForStaff(
  commissionRatePercent: number | string | null | undefined,
  commissionableAmount: number,
): CommissionResult {
  const hasConfig =
    commissionRatePercent != null &&
    commissionRatePercent !== "" &&
    Number.isFinite(Number(commissionRatePercent));
  if (!hasConfig) {
    return { ratePercent: 0, amount: 0, missingConfig: true };
  }
  const ratePercent = money(commissionRatePercent);
  const base = clampMin0(money(commissionableAmount));
  const amount = Math.round((base * ratePercent) / 100);
  return { ratePercent, amount, missingConfig: false };
}

// ─── Lọc booking được tính vào DOANH THU / tổng hợp ──────────────────────────
export type CountableBookingInput = {
  status?: string | null;
  isParentContract?: boolean | null;
  deletedAt?: unknown; // != null ⇒ đã vào thùng rác
};

/**
 * Booking có được tính vào doanh thu/báo cáo tổng không.
 * Bỏ: đơn trong thùng rác (deletedAt != null), đơn đã hủy (status='cancelled'),
 * và đơn CHA tổng (đếm các đơn con thay vì cha → tránh đếm trùng).
 */
export function isRevenueCountable(b: CountableBookingInput): boolean {
  if (b.deletedAt != null) return false;
  if ((b.status ?? "") === "cancelled") return false;
  if (b.isParentContract === true) return false;
  return true;
}
