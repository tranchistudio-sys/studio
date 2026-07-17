import { Router, type IRouter } from "express";
import { loadAllData } from "./data";
import { generateMonthRange, monthLabel } from "./helpers";
// GĐ1b-1 (kiến trúc 14/07): "Còn nợ tháng" đọc từ FINANCIAL ENGINE theo NGÀY CHỤP —
// route không tự tính công nợ nữa.
import { engineReceivableForRange, REVENUE_SCOPES } from "../../lib/finance/financial-engine";
// PR Financial Evidence: logic tính bucket tách sang monthly-core (MỘT nguồn sự thật,
// route /evidence dùng chung) — hành vi giữ NGUYÊN.
import { computeBucketStats, deriveMoney, bucketRanges } from "./monthly-core";

const router: IRouter = Router();

router.get("/revenue/v2/monthly", async (req, res) => {
  const data = await loadAllData();
  const { laborMeta } = data;

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
  for (const { ym, effFrom, effTo } of bucketRanges(months, customFrom, customTo)) {
    // Task #363: với từng tháng, range hiệu lực là giao của [dateFrom,dateTo] và [ymStart,ymEnd].
    // Khi user chọn "hôm nay" hoặc "tuần này", từng bucket sẽ chỉ tính bản ghi nằm đúng trong khoảng đó.
    const stats = computeBucketStats(data, effFrom, effTo);

    // GĐ1b-1: "Còn có thể thu từ show của tháng" — scope shoot_date/occurrence,
    // công nợ sống per-booking, đọc từ FINANCIAL ENGINE (đồng bộ Copilot 3B +
    // custom-range). Thay hẳn công thức trộn scope #394 (contractValue − cohort
    // cashIn) từng đẻ ra số 175.748.994 vô nghĩa vận hành.
    const remaining = await engineReceivableForRange(effFrom, effTo);

    const derived = deriveMoney(stats);

    result.push({
      month: ym,
      label: monthLabel(ym),
      contractValue: stats.contractValue,
      collected: stats.collected,
      remaining,
      staffCast: stats.staffCast,
      directExpenses: stats.directExp,
      operatingExpenses: stats.operatingExp,
      depreciation: stats.depreciation,
      interest: stats.interest,
      directCost: derived.directCost,
      grossProfit: derived.grossProfit,
      operatingProfit: derived.operatingProfit,
      netProfit: derived.netProfit,
      totalCost: derived.totalCost,
      realProfit: derived.realProfit,
      bookingCount: stats.bookingCount,
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
