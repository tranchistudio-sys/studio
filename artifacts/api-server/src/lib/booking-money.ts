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
 * Điều kiện con KHÔNG mồ côi: là đơn lẻ/cha (parent_id NULL) HOẶC cha còn sống
 * (không thùng rác/hủy/báo giá tạm). Tách riêng để liveBookingSql + revenueCountableSql
 * dùng CHUNG một định nghĩa "cha đã chết" — một nguồn chân lý.
 */
function notOrphanSqlFragment(a: string): string {
  return `(${a}.parent_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM bookings parent_chk
      WHERE parent_chk.id = ${a}.parent_id
        AND (parent_chk.deleted_at IS NOT NULL
             OR COALESCE(parent_chk.status, '') IN ('cancelled', 'temp_quote'))
    ))`;
}

/**
 * Điều kiện SQL "đơn CÒN HIỆU LỰC" (self-live + KHÔNG mồ côi), KHÔNG loại đơn CHA tổng.
 * Dùng cho ngữ cảnh tiền GHI Ở ĐƠN CHA: phiếu thu / cọc / đã thu / công nợ theo đơn —
 * đơn CHA đa dịch vụ là dòng mang tiền nên PHẢI giữ (payments ghi ở cha, xem booking-money
 * docstring + customer-aggregate PR #65). Muốn loại cha để ĐẾM DOANH THU theo con thì dùng
 * revenueCountableSql. Đồng bộ với isSelfLiveBooking (JS).
 * Loại: thùng rác (deleted_at), hủy (cancelled), báo giá tạm (temp_quote), con mồ côi.
 * Chuỗi hằng, KHÔNG chèn dữ liệu người dùng ⇒ an toàn với sql.raw / template.
 *
 * @param alias bí danh bảng bookings trong câu lệnh (mặc định "bookings").
 */
export function liveBookingSql(alias = "bookings"): string {
  const a = alias;
  return `${a}.deleted_at IS NULL
    AND COALESCE(${a}.status, '') NOT IN ('cancelled', 'temp_quote')
    AND ${notOrphanSqlFragment(a)}`;
}

/**
 * Điều kiện SQL "đơn được tính DOANH THU" = còn hiệu lực + loại đơn CHA tổng (đếm con thay
 * cha, tránh cộng trùng). ĐỒNG BỘ với isRevenueCountable() ở trên; dùng cho query THÔ
 * (pool.query / drizzle sql.raw) không gọi được predicate JS.
 * Loại: thùng rác, hủy, báo giá tạm, đơn CHA tổng, con mồ côi (cha chết/hủy/báo giá tạm).
 *
 * @param alias bí danh bảng bookings trong câu lệnh (mặc định "bookings").
 */
export function revenueCountableSql(alias = "bookings"): string {
  const a = alias;
  return `${a}.deleted_at IS NULL
    AND ${a}.is_parent_contract = false
    AND COALESCE(${a}.status, '') NOT IN ('cancelled', 'temp_quote')
    AND ${notOrphanSqlFragment(a)}`;
}

// ─── FAMILY CASH ALLOCATION (PR #102) — bản JS thuần, mirror engineAllocPaidSql ──
// Phiếu thu hợp đồng gộp nằm ở đơn CHA; "đã thu" của TỪNG booking = phân bổ
// pro-rata theo GIÁ TRỊ HỢP ĐỒNG (net) trên các thành viên countable của gia đình.
// Σ net = 0 → dồn hết vào thành viên countable id nhỏ nhất (deterministic).
// Gia đình không còn thành viên countable (cha rỗng/cả nhà hủy) → không ai nhận.

export type AllocBookingInput = CountableBookingInput & {
  id: number;
  totalAmount?: number | string | null;
  discountAmount?: number | string | null;
  /** Ngày thực hiện — cần cho FIFO phân bổ thu-thêm-trên-cha (chốt 17/07 Q1). */
  shootDate?: string | Date | null;
};

export type AllocPaymentInput = {
  /** id phiếu — cần để nhận diện phiếu cọc CANONICAL (cũ nhất trên root). */
  id?: number | null;
  bookingId?: number | null;
  amount?: number | string | null;
  status?: string | null;
  paymentType?: string | null;
};

/** Bộ số phân bổ đầy đủ của MỘT dịch vụ (thành viên countable) — cho evidence/Excel. */
export type FamilyMemberAllocation = {
  bookingId: number;
  net: number;
  /** Cọc chung chia ĐỀU (đã cap ≤ NET, water-filling — chốt 17/07). */
  equalDeposit: number;
  /** Tổng phiếu gắn THẲNG dịch vụ này (gồm cọc legacy trên con, payment/partial/full). */
  directPaid: number;
  /** Phần direct được tính vào nợ của CHÍNH nó = min(direct, NET − cọc đều). */
  directCredited: number;
  /** Phân bổ FIFO từ pool trên cha (thu thêm legacy + tiền thừa dịch vụ khác). */
  parentFifo: number;
  /** Tổng tiền tính vào nợ = equalDeposit + directCredited + parentFifo. */
  allocated: number;
  /** Còn phải thu = NET − allocated (không âm by-construction). */
  remaining: number;
};

export type FamilyAllocation = {
  rootId: number;
  /** Cọc CANONICAL: phiếu 'deposit' CŨ NHẤT (min id) nằm TRÊN ROOT — do máy ô "Tiền cọc" quản lý. */
  totalDeposit: number;
  canonicalDepositPaymentId: number | null;
  eligibleServiceCount: number;
  /** Tiền vượt tổng nợ gia đình — "Khách trả dư" (không tạo nợ âm, không mất tiền). */
  overpayment: number;
  members: FamilyMemberAllocation[];
};

/**
 * ALLOCATOR TẬP TRUNG — nghiệp vụ chủ chốt 17/07 đêm (thay pro-rata PR #102):
 *  1. Cọc CANONICAL (phiếu 'deposit' cũ nhất trên root) chia ĐỀU cho N dịch vụ
 *     countable: phần nguyên đều nhau, số đồng dư phát lần lượt theo booking ID
 *     tăng dần; KHÔNG vượt NET của dịch vụ — phần vượt chia đều tiếp cho các
 *     dịch vụ còn dư công nợ (water-filling, lặp tới khi hết cọc/hết chỗ).
 *  2. Phiếu gắn THẲNG dịch vụ con = thu riêng của dịch vụ đó (gồm phiếu cọc
 *     legacy trên con — Q2: không xóa/sửa/gom, đọc như thu trực tiếp).
 *  3. Thu thêm trên CHA (không canonical) + phiếu trên thành viên không-countable
 *     + phần THỪA của dịch vụ đã đủ tiền → gom POOL, phân bổ FIFO theo
 *     (ngày thực hiện tăng dần, ID tăng dần) — dịch vụ tới hạn trước trừ trước (Q1-A).
 *  4. Tiền dư sau tất cả = overpayment "Khách trả dư".
 * Bất biến: Σ remaining các dịch vụ = max(0, NET gia đình − tổng tiền hợp lệ) —
 * mọi màn (Booking/Dashboard/Copilot/Revenue) tiếp tục ra CÙNG MỘT SỐ.
 * Chỉ đổi cách ĐỌC — không tạo/sửa/copy payment nào.
 */
export function allocateFamilies(
  allBookings: readonly AllocBookingInput[],
  payments: readonly AllocPaymentInput[],
): Map<number, FamilyAllocation> {
  const byId = new Map(allBookings.map((b) => [b.id, b]));
  const rootOf = (b: AllocBookingInput): number => b.parentId ?? b.id;
  const parentById = buildParentContractMap(allBookings);
  const netOf = (b: AllocBookingInput): number =>
    clampMin0(money(b.totalAmount) - money(b.discountAmount));
  const shootKey = (b: AllocBookingInput): string => {
    const d = b.shootDate;
    if (d == null) return "9999-12-31"; // không có ngày → xếp cuối, vẫn deterministic
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  };

  // Gom thành viên + phiếu theo root.
  const familyMembers = new Map<number, AllocBookingInput[]>();
  for (const b of allBookings) {
    const root = rootOf(b);
    const list = familyMembers.get(root) ?? [];
    list.push(b);
    familyMembers.set(root, list);
  }
  const familyPayments = new Map<number, AllocPaymentInput[]>();
  for (const p of payments) {
    if (p.bookingId == null) continue;
    if ((p.status ?? "active") === "voided") continue;
    const t = p.paymentType ?? "";
    if (t === "refund" || t === "ad_hoc") continue;
    const owner = byId.get(p.bookingId);
    if (!owner) continue;
    const root = rootOf(owner);
    const list = familyPayments.get(root) ?? [];
    list.push(p);
    familyPayments.set(root, list);
  }

  const out = new Map<number, FamilyAllocation>();
  for (const [root, members] of familyMembers) {
    const pays = familyPayments.get(root) ?? [];
    const eligible = members
      .filter((b) => isRevenueCountable(b, parentById))
      .sort((a, b) => a.id - b.id);

    // 1) Cọc CANONICAL: phiếu 'deposit' cũ nhất (min id) gắn TRÊN ROOT.
    let canonical: AllocPaymentInput | null = null;
    for (const p of pays) {
      if (p.bookingId !== root) continue;
      if ((p.paymentType ?? "") !== "deposit") continue;
      if (canonical == null || money(p.id) < money(canonical.id)) canonical = p;
    }
    const totalDeposit = canonical ? money(canonical.amount) : 0;

    // 2) Phiếu gắn thẳng dịch vụ countable = thu riêng; mọi phiếu hợp lệ khác → pool.
    const directPaid = new Map<number, number>();
    let pool = 0;
    const eligibleIds = new Set(eligible.map((b) => b.id));
    for (const p of pays) {
      if (p === canonical) continue;
      if (p.bookingId != null && eligibleIds.has(p.bookingId)) {
        directPaid.set(p.bookingId, (directPaid.get(p.bookingId) ?? 0) + money(p.amount));
      } else {
        pool += money(p.amount); // thu thêm trên cha / phiếu trên thành viên không-countable
      }
    }

    // 3) Chia ĐỀU cọc — water-filling, phần dư đồng lẻ theo ID tăng dần.
    const dep = new Map<number, number>();
    for (const b of eligible) dep.set(b.id, 0);
    let overpayment = 0;
    if (eligible.length > 0 && totalDeposit > 0) {
      let left = totalDeposit;
      let alive = [...eligible]; // đã sort id ASC
      while (left > 0.000001 && alive.length > 0) {
        const wholeLeft = Math.floor(left);
        const share = Math.floor(wholeLeft / alive.length);
        const rem = wholeLeft % alive.length;
        const frac = left - wholeLeft; // phần lẻ <1đ (nếu numeric có thập phân) → dồn ID nhỏ nhất
        let overflow = 0;
        const next: AllocBookingInput[] = [];
        alive.forEach((b, idx) => {
          const give = share + (idx < rem ? 1 : 0) + (idx === 0 ? frac : 0);
          const cur = dep.get(b.id) ?? 0;
          const room = netOf(b) - cur;
          const take = Math.min(give, room);
          dep.set(b.id, cur + take);
          overflow += give - take;
          if (netOf(b) - (cur + take) > 0.000001) next.push(b);
        });
        left = overflow;
        alive = next;
      }
      overpayment += left; // cọc vượt tổng NET gia đình → Khách trả dư
    } else if (eligible.length === 0) {
      // Gia đình không còn dịch vụ hợp lệ (cha rỗng/cả nhà hủy) — không phân bổ (mirror
      // paymentNotOnEmptyParentSql: tiền treo, không tính vào công nợ active).
      out.set(root, {
        rootId: root, totalDeposit, canonicalDepositPaymentId: canonical?.id != null ? Number(canonical.id) : null,
        eligibleServiceCount: 0, overpayment: 0, members: [],
      });
      continue;
    }

    // 4) Direct credited + phần thừa dồn pool.
    const directCredited = new Map<number, number>();
    for (const b of eligible) {
      const d = directPaid.get(b.id) ?? 0;
      const room = clampMin0(netOf(b) - (dep.get(b.id) ?? 0));
      const credited = Math.min(d, room);
      directCredited.set(b.id, credited);
      pool += d - credited; // tiền thừa của dịch vụ đã đủ → chảy sang dịch vụ còn nợ
    }

    // 5) FIFO pool theo (ngày thực hiện ASC, id ASC) — tới hạn trước trừ trước.
    const fifoOrder = [...eligible].sort((a, b) => {
      const ka = shootKey(a), kb = shootKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : a.id - b.id;
    });
    const fifo = new Map<number, number>();
    let poolLeft = pool;
    for (const b of fifoOrder) {
      const need = clampMin0(netOf(b) - (dep.get(b.id) ?? 0) - (directCredited.get(b.id) ?? 0));
      const take = Math.min(need, poolLeft);
      fifo.set(b.id, take);
      poolLeft -= take;
      if (poolLeft <= 0.000001) { poolLeft = Math.max(0, poolLeft); }
    }
    overpayment += poolLeft;

    const memberAllocs: FamilyMemberAllocation[] = eligible.map((b) => {
      const net = netOf(b);
      const equalDeposit = dep.get(b.id) ?? 0;
      const direct = directPaid.get(b.id) ?? 0;
      const credited = directCredited.get(b.id) ?? 0;
      const pf = fifo.get(b.id) ?? 0;
      const allocated = equalDeposit + credited + pf;
      return {
        bookingId: b.id, net, equalDeposit, directPaid: direct, directCredited: credited,
        parentFifo: pf, allocated, remaining: clampMin0(net - allocated),
      };
    });

    out.set(root, {
      rootId: root,
      totalDeposit,
      canonicalDepositPaymentId: canonical?.id != null ? Number(canonical.id) : null,
      eligibleServiceCount: eligible.length,
      overpayment,
      members: memberAllocs,
    });
  }
  return out;
}

/**
 * Map bookingId → "đã thu PHÂN BỔ" (tương thích interface cũ — giờ chạy trên
 * allocator CHIA ĐỀU CỌC + direct + FIFO thay vì pro-rata).
 * @param allBookings TOÀN BỘ đơn của tập (kể cả cha/hủy/xóa) — cần đủ để gom gia đình.
 * @param payments    phiếu thu (loại voided/refund/ad_hoc tại đây — truyền thô).
 */
export function allocateFamilyPaid(
  allBookings: readonly AllocBookingInput[],
  payments: readonly AllocPaymentInput[],
): Map<number, number> {
  const families = allocateFamilies(allBookings, payments);
  const alloc = new Map<number, number>();
  for (const b of allBookings) alloc.set(b.id, 0);
  for (const fam of families.values()) {
    for (const m of fam.members) alloc.set(m.bookingId, m.allocated);
  }
  return alloc;
}
