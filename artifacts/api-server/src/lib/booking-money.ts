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
// Đồng bộ với customer-aggregate.isCustomerCountableBooking + revenue/data.ts +
// dashboard.ts. Một nguồn chân lý cho câu hỏi "đơn này có phải doanh thu thật không".
export type CountableBookingInput = {
  /** id đơn — cần cho buildParentContractMap để tra con mồ côi. */
  id?: number;
  status?: string | null;
  isParentContract?: boolean | null;
  /** id đơn CHA nếu là dịch vụ con của hợp đồng nhiều dịch vụ. */
  parentId?: number | null;
  deletedAt?: unknown; // != null ⇒ đã vào thùng rác
};

/**
 * Dòng đơn TỰ THÂN còn hiệu lực: không thùng rác, không hủy, không báo giá tạm.
 * (Chưa xét quan hệ cha-con — xem isRevenueCountable cho con mồ côi.)
 */
export function isSelfLiveBooking(b: CountableBookingInput): boolean {
  if (b.deletedAt != null) return false;
  const st = b.status ?? "";
  if (st === "cancelled") return false; // đơn đã hủy — không phải doanh thu hiện tại
  if (st === "temp_quote") return false; // báo giá tạm — chưa phải đơn thật
  return true;
}

/**
 * Booking có được tính vào doanh thu/báo cáo tổng không.
 * Bỏ: đơn trong thùng rác (deletedAt != null), đơn đã hủy (status='cancelled'),
 * báo giá tạm (temp_quote), đơn CHA tổng (đếm các đơn con thay vì cha → tránh đếm
 * trùng), và con MỒ CÔI của hợp đồng cha đã chết (cha xóa/hủy/báo giá tạm).
 *
 * Con mồ côi: hủy đơn CHA qua trang Đơn hàng KHÔNG cascade status xuống con (chỉ
 * thùng rác mới cascade deletedAt), nên phải tra trạng thái cha ở đây — nếu không
 * con vẫn cộng doanh thu dù cả hợp đồng đã bị hủy.
 *
 * @param parentById  map id→đơn cha (từ buildParentContractMap). Bỏ qua ⇒ KHÔNG xét
 *                    con mồ côi (tương thích ngược với caller cũ truyền 1 tham số).
 */
export function isRevenueCountable(
  b: CountableBookingInput,
  parentById?: ReadonlyMap<number, CountableBookingInput>,
): boolean {
  if (!isSelfLiveBooking(b)) return false;
  if (b.isParentContract === true) return false;
  if (parentById && b.parentId != null) {
    const parent = parentById.get(b.parentId);
    // Cha không có trong map (đã purge/khác tập dữ liệu) ⇒ coi như còn sống, KHÔNG
    // tự ý loại doanh thu của con.
    if (parent && !isSelfLiveBooking(parent)) return false;
  }
  return true;
}

/** Map id đơn CHA tổng → đơn cha, để tra trạng thái cha khi lọc con mồ côi. */
export function buildParentContractMap<T extends CountableBookingInput>(
  bookings: readonly T[],
): Map<number, T> {
  const map = new Map<number, T>();
  for (const b of bookings) {
    if (b.isParentContract === true && b.id != null) map.set(b.id, b);
  }
  return map;
}

/**
 * Lọc danh sách đơn CHỈ giữ đơn tính doanh thu (tự dựng parent map để loại con mồ côi).
 * @param bookings TOÀN BỘ đơn của tập cần tính (KỂ CẢ đơn cha/hủy/báo giá tạm) — cần
 *                 đơn cha trong danh sách để nhận diện con mồ côi. Hàm tự lọc hết.
 */
export function filterRevenueCountable<T extends CountableBookingInput>(
  bookings: readonly T[],
): T[] {
  const parentById = buildParentContractMap(bookings);
  return bookings.filter((b) => isRevenueCountable(b, parentById));
}

/**
 * Điều kiện SQL "đơn được tính doanh thu" — ĐỒNG BỘ với isRevenueCountable() ở trên,
 * dùng cho query THÔ (pool.query / drizzle sql.raw) không gọi được predicate JS.
 * Loại: thùng rác, hủy, báo giá tạm, đơn CHA tổng, con mồ côi (cha chết/hủy/báo giá tạm).
 * Chuỗi hằng, KHÔNG chèn dữ liệu người dùng ⇒ an toàn với sql.raw / template.
 *
 * @param alias bí danh bảng bookings trong câu lệnh (mặc định "bookings").
 */
export function revenueCountableSql(alias = "bookings"): string {
  const a = alias;
  return `${a}.deleted_at IS NULL
    AND ${a}.is_parent_contract = false
    AND COALESCE(${a}.status, '') NOT IN ('cancelled', 'temp_quote')
    AND (${a}.parent_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM bookings parent_chk
      WHERE parent_chk.id = ${a}.parent_id
        AND (parent_chk.deleted_at IS NOT NULL
             OR COALESCE(parent_chk.status, '') IN ('cancelled', 'temp_quote'))
    ))`;
}
