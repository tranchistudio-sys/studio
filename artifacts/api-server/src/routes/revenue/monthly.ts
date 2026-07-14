import { Router, type IRouter } from "express";
import { loadAllData } from "./data";
import { getBookingDate, getPaymentDate, generateMonthRange, monthLabel } from "./helpers";
// GĐ1b-1 (kiến trúc 14/07): "Còn nợ tháng" đọc từ FINANCIAL ENGINE theo NGÀY CHỤP —
// route không tự tính công nợ nữa.
import { engineReceivableForRange, REVENUE_SCOPES } from "../../lib/finance/financial-engine";

const router: IRouter = Router();

router.get("/revenue/v2/monthly", async (req, res) => {
  const { validBookings, castByBooking, laborMeta, payments, classifiedExpenses, fixedCostPerMonth } = await loadAllData();

  const range = (req.query["range"] as string) || "6";
  const customFrom = req.query["from"] as string | undefined;
  const customTo = req.query["to"] as string | undefined;

  let months: string[];
  if (customFrom && customTo) {
    const fromYM = customFrom.slice(0, 7);
    const toYM = customTo.slice(0, 7);
    months = generateMonthRange(fromYM, toYM);
  } else {
    const n = parseInt(range) || 6;
    const now = new Date();
    months = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
  }

  const dateFrom = customFrom || `${months[0]}-01`;
  const dateTo = customTo || (() => {
    const last = months[months.length - 1];
    const [y, m] = last.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return `${last}-${String(lastDay).padStart(2, "0")}`;
  })();

  const result = [];
  for (const ym of months) {
    const [yy, mm] = ym.split("-").map(Number);
    const lastDay = new Date(yy, mm, 0).getDate();
    const ymStart = `${ym}-01`;
    const ymEnd = `${ym}-${String(lastDay).padStart(2, "0")}`;
    // Day-precision clipping when caller passed from/to within a month
    const bucketStart = customFrom && customFrom > ymStart ? customFrom : ymStart;
    const bucketEnd = customTo && customTo < ymEnd ? customTo : ymEnd;

    // Task #363: với từng tháng, range hiệu lực là giao của [dateFrom,dateTo] và [ymStart,ymEnd].
    // Khi user chọn "hôm nay" hoặc "tuần này", từng bucket sẽ chỉ tính bản ghi nằm đúng trong khoảng đó.
    const effFrom = bucketStart;
    const effTo = bucketEnd;

    // "Hợp đồng ký mới trong tháng" — scope booking_created_at (chỉ số BÁN HÀNG).
    // CẤM dùng cohort này để suy ra công nợ (phép trộn scope Task #394 cũ).
    const monthBookings = validBookings.filter(b => {
      const d = getBookingDate(b);
      return d >= effFrom && d <= effTo;
    });
    const contractValue = monthBookings.reduce((s, b) => s + (b.netAmount || 0), 0); // NET (đã trừ giảm giá)
    const bookingIds = new Set(monthBookings.map(b => b.id));

    // "Tiền thực thu trong tháng" — scope payment_date (gồm ad_hoc, không filter cohort).
    const monthPayments = payments.filter(p => {
      if (p.paymentType === "refund") return false;
      const d = getPaymentDate(p);
      return d >= effFrom && d <= effTo;
    });
    const collected = monthPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

    // GĐ1b-1: "Còn có thể thu từ show của tháng" — scope shoot_date/occurrence,
    // công nợ sống per-booking, đọc từ FINANCIAL ENGINE (đồng bộ Copilot 3B +
    // custom-range). Thay hẳn công thức trộn scope #394 (contractValue − cohort
    // cashIn) từng đẻ ra số 175.748.994 vô nghĩa vận hành.
    const remaining = await engineReceivableForRange(effFrom, effTo);

    let staffCast = 0;
    for (const bid of bookingIds) {
      staffCast += castByBooking.get(bid) ?? 0;
    }

    // Task #363: gom chi phí theo lớp + lọc theo range chính xác (ngày).
    let directExp = 0, operatingExp = 0, depreciation = 0, interest = 0;
    for (const e of classifiedExpenses) {
      // direct gắn booking → cộng nếu booking thuộc bucket này; ngược lại lọc theo ngày chi.
      if (e.cls === "direct" && e.bookingId != null) {
        if (bookingIds.has(e.bookingId)) directExp += e.amount;
        continue;
      }
      if (!e.date || e.date < effFrom || e.date > effTo) continue;
      if (e.cls === "direct") directExp += e.amount;
      else if (e.cls === "operating") operatingExp += e.amount;
      else if (e.cls === "depreciation") depreciation += e.amount;
      else if (e.cls === "interest") interest += e.amount;
    }

    // Task #364: cộng chi phí cố định hàng tháng vào operating của từng bucket.
    operatingExp += fixedCostPerMonth;

    // Mô hình tài chính chuẩn:
    //   revenue = doanh thu chốt (giá trị hợp đồng), KHÔNG phải tiền đã thu
    //   directCost = cast nhân viên + chi phí trực tiếp gắn show
    //   grossProfit = revenue - directCost
    //   operatingProfit = grossProfit - operatingCost
    //   netProfit = operatingProfit - depreciation - interest
    const directCost = staffCast + directExp;
    const grossProfit = contractValue - directCost;
    const operatingProfit = grossProfit - operatingExp;
    const netProfit = operatingProfit - depreciation - interest;

    const totalCost = directCost + operatingExp + depreciation + interest;
    const realProfit = collected - totalCost; // legacy field — giữ để không vỡ chỗ khác

    result.push({
      month: ym,
      label: monthLabel(ym),
      contractValue,
      collected,
      remaining,
      staffCast,
      directExpenses: directExp,
      operatingExpenses: operatingExp,
      depreciation,
      interest,
      directCost,
      grossProfit,
      operatingProfit,
      netProfit,
      totalCost,
      realProfit,
      bookingCount: monthBookings.length,
    });
  }

  const totals = result.reduce((acc, r) => ({
    contractValue: acc.contractValue + r.contractValue,
    collected: acc.collected + r.collected,
    remaining: acc.remaining + r.remaining,
    staffCast: acc.staffCast + r.staffCast,
    directExpenses: acc.directExpenses + r.directExpenses,
    operatingExpenses: acc.operatingExpenses + r.operatingExpenses,
    depreciation: acc.depreciation + r.depreciation,
    interest: acc.interest + r.interest,
    directCost: acc.directCost + r.directCost,
    grossProfit: acc.grossProfit + r.grossProfit,
    operatingProfit: acc.operatingProfit + r.operatingProfit,
    netProfit: acc.netProfit + r.netProfit,
    totalCost: acc.totalCost + r.totalCost,
    realProfit: acc.realProfit + r.realProfit,
    bookingCount: acc.bookingCount + r.bookingCount,
  }), {
    contractValue: 0, collected: 0, remaining: 0,
    staffCast: 0, directExpenses: 0, operatingExpenses: 0,
    depreciation: 0, interest: 0,
    directCost: 0, grossProfit: 0, operatingProfit: 0, netProfit: 0,
    totalCost: 0, realProfit: 0, bookingCount: 0,
  });

  // Tổng "còn có thể thu" tính MỘT lần trên cả khoảng — cộng từng bucket có thể
  // đếm trùng đơn có show ở 2 tháng (shoot_date tháng này + occurrence tháng sau).
  totals.remaining = await engineReceivableForRange(dateFrom, dateTo);

  // GĐ1b-2: metadata minh bạch — coverage cast còn partial thì KHÔNG được gọi
  // đây là "lợi nhuận chính xác tuyệt đối"; hoa hồng sale chưa ghi sổ chưa gồm.
  res.json({ months: result, totals, dateFrom, dateTo, scopes: REVENUE_SCOPES, labor: laborMeta });
});

export default router;
