import { Router, type IRouter } from "express";
import { loadAllData } from "./data";
import { generateMonthRange, getPaymentDate } from "./helpers";
// GĐ1b-1: "còn có thể thu" đọc từ FINANCIAL ENGINE (scope ngày chụp/occurrence) —
// CÙNG helper với revenue/monthly + Copilot, cấm mỗi route một công thức.
import { engineReceivableForRange, REVENUE_SCOPES } from "../../lib/finance/financial-engine";

const router: IRouter = Router();

router.get("/revenue/v2/custom-range", async (req, res) => {
  const from = req.query["from"] as string;
  const to = req.query["to"] as string;
  if (!from || !to) return res.status(400).json({ error: "from and to required (YYYY-MM-DD)" });

  const { validBookings, castByBooking, directExpByBooking, operatingExpByDate, payments, fixedCostPerMonth } = await loadAllData();

  const rangeBookings = validBookings.filter(b => {
    const created = b.createdAt.toISOString().slice(0, 10);
    return created >= from && created <= to;
  });

  const bookingIds = new Set(rangeBookings.map(b => b.id));

  const contractValue = rangeBookings.reduce((s, b) => s + (b.netAmount || 0), 0); // NET (đã trừ giảm giá)

  // Task #394: "Đã thu" = tất cả payments có paidAt trong khoảng ngày, bao gồm ad_hoc — không filter theo booking_id cohort.
  // Dùng getPaymentDate() để nhất quán timezone với revenue/monthly.ts.
  const rangePayments = payments.filter(p => {
    if (p.paymentType === "refund") return false;
    const pd = getPaymentDate(p);
    return pd >= from && pd <= to;
  });
  const collected = rangePayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

  // GĐ1b-1: trước đây tính công nợ sống nhưng trên cohort NGÀY TẠO (rangeBookings)
  // → lệch với monthly và Copilot. Giờ cùng một helper Engine, scope ngày chụp.
  const remaining = await engineReceivableForRange(from, to);

  let staffCast = 0;
  let directExp = 0;
  for (const bid of bookingIds) {
    staffCast += castByBooking.get(bid) ?? 0;
    directExp += directExpByBooking.get(bid) ?? 0;
  }

  const fromYM = from.slice(0, 7);
  const toYM = to.slice(0, 7);
  let operatingExp = 0;
  for (const [ym, amt] of operatingExpByDate) {
    if (ym >= fromYM && ym <= toYM) operatingExp += amt;
  }
  const monthsInRange = generateMonthRange(fromYM, toYM).length;
  operatingExp += fixedCostPerMonth * monthsInRange;

  const totalCost = staffCast + directExp + operatingExp;
  const realProfit = collected - totalCost;

  return res.json({
    from, to,
    contractValue, collected, remaining,
    staffCast, directExpenses: directExp, operatingExpenses: operatingExp,
    totalCost, realProfit,
    bookingCount: rangeBookings.length,
    scopes: REVENUE_SCOPES,
  });
});

export default router;
