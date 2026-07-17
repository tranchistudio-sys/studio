/**
 * monthly-core.ts — MỘT NGUỒN SỰ THẬT cho số liệu màn Doanh thu & Lợi nhuận.
 *
 * PR Financial Evidence: logic tính từng bucket của /revenue/v2/monthly được tách
 * ra đây để route /revenue/v2/evidence dùng ĐÚNG CÙNG code path khi liệt kê bằng
 * chứng — cấm tình trạng "card đọc một query, bảng chi tiết đọc query khác".
 *
 * computeBucketStats nhận optional EvidenceCollector: khi truyền vào, MỖI khoản
 * được cộng vào số tổng cũng đồng thời được đẩy ra collector — bằng chứng và số
 * tổng khớp nhau by-construction (cùng vòng lặp, cùng filter, cùng phép cộng).
 */
import type { loadAllData } from "./data";
import { getBookingDate, getPaymentDate } from "./helpers";

export type LoadedRevenueData = Awaited<ReturnType<typeof loadAllData>>;
export type ValidBooking = LoadedRevenueData["validBookings"][number];
export type ActivePayment = LoadedRevenueData["payments"][number];
export type ClassifiedExpense = LoadedRevenueData["classifiedExpenses"][number];

/** Nhận từng khoản ĐÚNG LÚC nó được cộng vào số tổng (một-một với phép cộng). */
export type EvidenceCollector = {
  contractRow?: (b: ValidBooking) => void;
  paymentRow?: (p: ActivePayment) => void;
  castRow?: (bookingId: number, amount: number) => void;
  expenseRow?: (e: ClassifiedExpense, cls: "direct" | "operating" | "depreciation" | "interest") => void;
  /** Gọi MỖI bucket tháng — chi phí cố định cộng fixedCostPerMonth cho từng bucket. */
  fixedCostBucket?: (ym: string) => void;
};

export type BucketStats = {
  contractValue: number;
  collected: number;
  staffCast: number;
  directExp: number;
  /** ĐÃ gồm fixedCostPerMonth của bucket (giữ nguyên ngữ nghĩa monthly cũ). */
  operatingExp: number;
  depreciation: number;
  interest: number;
  bookingCount: number;
};

export function computeBucketStats(
  data: Pick<
    LoadedRevenueData,
    "validBookings" | "castByBooking" | "payments" | "classifiedExpenses" | "fixedCostPerMonth"
  >,
  effFrom: string,
  effTo: string,
  collect?: EvidenceCollector,
): BucketStats {
  const { validBookings, castByBooking, payments, classifiedExpenses, fixedCostPerMonth } = data;

  // "Hợp đồng ký mới trong kỳ" — scope booking_created_at (chỉ số BÁN HÀNG).
  // CẤM dùng cohort này để suy ra công nợ (phép trộn scope Task #394 cũ).
  const monthBookings = validBookings.filter(b => {
    const d = getBookingDate(b);
    return d >= effFrom && d <= effTo;
  });
  const contractValue = monthBookings.reduce((s, b) => s + (b.netAmount || 0), 0); // NET (đã trừ giảm giá)
  const bookingIds = new Set(monthBookings.map(b => b.id));
  if (collect?.contractRow) for (const b of monthBookings) collect.contractRow(b);

  // "Tiền thực thu trong kỳ" — scope payment_date (gồm ad_hoc, không filter cohort).
  const monthPayments = payments.filter(p => {
    if (p.paymentType === "refund") return false;
    const d = getPaymentDate(p);
    return d >= effFrom && d <= effTo;
  });
  const collected = monthPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  if (collect?.paymentRow) for (const p of monthPayments) collect.paymentRow(p);

  let staffCast = 0;
  for (const bid of bookingIds) {
    const c = castByBooking.get(bid) ?? 0;
    staffCast += c;
    if (c !== 0) collect?.castRow?.(bid, c);
  }

  // Task #363: gom chi phí theo lớp + lọc theo range chính xác (ngày).
  let directExp = 0, operatingExp = 0, depreciation = 0, interest = 0;
  for (const e of classifiedExpenses) {
    // direct gắn booking → cộng nếu booking thuộc bucket này; ngược lại lọc theo ngày chi.
    if (e.cls === "direct" && e.bookingId != null) {
      if (bookingIds.has(e.bookingId)) {
        directExp += e.amount;
        collect?.expenseRow?.(e, "direct");
      }
      continue;
    }
    if (!e.date || e.date < effFrom || e.date > effTo) continue;
    if (e.cls === "direct") {
      directExp += e.amount;
      collect?.expenseRow?.(e, "direct");
    } else if (e.cls === "operating") {
      operatingExp += e.amount;
      collect?.expenseRow?.(e, "operating");
    } else if (e.cls === "depreciation") {
      depreciation += e.amount;
      collect?.expenseRow?.(e, "depreciation");
    } else if (e.cls === "interest") {
      interest += e.amount;
      collect?.expenseRow?.(e, "interest");
    }
  }

  // Task #364: cộng chi phí cố định hàng tháng vào operating của từng bucket.
  operatingExp += fixedCostPerMonth;
  collect?.fixedCostBucket?.(effFrom.slice(0, 7));

  return { contractValue, collected, staffCast, directExp, operatingExp, depreciation, interest, bookingCount: monthBookings.length };
}

export type DerivedMoney = {
  directCost: number;
  grossProfit: number;
  operatingProfit: number;
  netProfit: number;
  totalCost: number;
  realProfit: number;
};

/**
 * Mô hình tài chính chuẩn (giữ nguyên monthly cũ):
 *   revenue = doanh thu chốt (giá trị hợp đồng), KHÔNG phải tiền đã thu
 *   directCost = cast nhân viên + chi phí trực tiếp gắn show
 *   grossProfit = revenue - directCost
 *   operatingProfit = grossProfit - operatingCost
 *   netProfit = operatingProfit - depreciation - interest
 *   realProfit = collected - totalCost (legacy field — giữ để không vỡ chỗ khác)
 */
export function deriveMoney(s: BucketStats): DerivedMoney {
  const directCost = s.staffCast + s.directExp;
  const grossProfit = s.contractValue - directCost;
  const operatingProfit = grossProfit - s.operatingExp;
  const netProfit = operatingProfit - s.depreciation - s.interest;
  const totalCost = directCost + s.operatingExp + s.depreciation + s.interest;
  const realProfit = s.collected - totalCost;
  return { directCost, grossProfit, operatingProfit, netProfit, totalCost, realProfit };
}

/**
 * Danh sách bucket tháng [ymStart, ymEnd] đã CLIP theo from/to — đúng cách monthly
 * chia kỳ: các bucket lát kín [from, to], không chồng lấn.
 */
export function bucketRanges(months: string[], customFrom?: string, customTo?: string): Array<{ ym: string; effFrom: string; effTo: string }> {
  return months.map(ym => {
    const [yy, mm] = ym.split("-").map(Number);
    const lastDay = new Date(yy, mm, 0).getDate();
    const ymStart = `${ym}-01`;
    const ymEnd = `${ym}-${String(lastDay).padStart(2, "0")}`;
    return {
      ym,
      effFrom: customFrom && customFrom > ymStart ? customFrom : ymStart,
      effTo: customTo && customTo < ymEnd ? customTo : ymEnd,
    };
  });
}
