import { Router, type IRouter } from "express";
import { loadAllData } from "./data";

const router: IRouter = Router();

router.get("/revenue/stats", async (_req, res) => {
  const { validBookings, castByBooking, directExpByBooking } = await loadAllData();

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const weekStart = (() => {
    const d = new Date(now);
    const day = d.getDay();
    d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
    return d.toISOString().slice(0, 10);
  })();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const yearStart = `${now.getFullYear()}-01-01`;

  function sumInPeriod(start: string, end: string) {
    const inPeriod = validBookings.filter(b => b.shootDate >= start && b.shootDate <= end);
    const revenue = inPeriod.reduce((s, b) => s + (b.netAmount || 0), 0); // NET (đã trừ giảm giá)
    let cast = 0, direct = 0;
    for (const b of inPeriod) {
      cast += castByBooking.get(b.id) ?? 0;
      direct += directExpByBooking.get(b.id) ?? 0;
    }
    return { revenue, expenses: cast + direct, profit: revenue - cast - direct, count: inPeriod.length };
  }

  const todayData = sumInPeriod(today, today);
  const weekData = sumInPeriod(weekStart, today);
  const monthData = sumInPeriod(monthStart, today);
  const yearData = sumInPeriod(yearStart, today);

  res.json({
    todayRevenue: todayData.revenue, todayExpenses: todayData.expenses, todayProfit: todayData.profit, todayCount: todayData.count,
    weekRevenue: weekData.revenue, weekExpenses: weekData.expenses, weekProfit: weekData.profit, weekCount: weekData.count,
    monthRevenue: monthData.revenue, monthExpenses: monthData.expenses, monthProfit: monthData.profit, monthCount: monthData.count,
    yearRevenue: yearData.revenue, yearExpenses: yearData.expenses, yearProfit: yearData.profit, yearCount: yearData.count,
  });
});

export default router;
