import { Router, type IRouter } from "express";
import { loadAllData } from "./data";
import { getPaymentDate } from "./helpers";

const router: IRouter = Router();

function todayVN(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function fmtLabel(dateStr: string): string {
  const parts = dateStr.split("-");
  return parts.length >= 3 ? `${parts[2]}/${parts[1]}` : dateStr;
}

function buildDateRange(daysCount: number): string[] {
  const today = todayVN();
  const list: string[] = [];
  for (let i = daysCount - 1; i >= 0; i--) {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() - i);
    list.push(d.toISOString().slice(0, 10));
  }
  return list;
}

function buildMonthDates(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

router.get("/revenue/v2/daily-cashflow", async (req, res) => {
  const { payments, classifiedExpenses } = await loadAllData();

  const month = req.query.month as string | undefined;
  const daysParam = parseInt(String(req.query.days ?? "30"), 10);
  const daysCount = Math.min(Math.max(Number.isFinite(daysParam) ? daysParam : 30, 7), 90);

  const dateList = month && /^\d{4}-\d{2}$/.test(month)
    ? buildMonthDates(month)
    : buildDateRange(daysCount);

  const collectedByDate = new Map<string, { amount: number; count: number }>();
  const spentByDate = new Map<string, { amount: number; count: number }>();
  for (const d of dateList) {
    collectedByDate.set(d, { amount: 0, count: 0 });
    spentByDate.set(d, { amount: 0, count: 0 });
  }

  for (const p of payments) {
    const d = getPaymentDate(p);
    const bucket = collectedByDate.get(d);
    if (!bucket) continue;
    bucket.amount += parseFloat(String(p.amount)) || 0;
    bucket.count += 1;
  }

  for (const e of classifiedExpenses) {
    const d = (e.date || "").slice(0, 10);
    if (!d) continue;
    const bucket = spentByDate.get(d);
    if (!bucket) continue;
    bucket.amount += e.amount;
    bucket.count += 1;
  }

  const days = dateList.map(date => {
    const c = collectedByDate.get(date)!;
    const s = spentByDate.get(date)!;
    return {
      date,
      label: fmtLabel(date),
      collected: c.amount,
      spent: s.amount,
      net: c.amount - s.amount,
      paymentCount: c.count,
      expenseCount: s.count,
    };
  });

  const totals = days.reduce(
    (acc, d) => ({
      collected: acc.collected + d.collected,
      spent: acc.spent + d.spent,
      net: acc.net + d.net,
    }),
    { collected: 0, spent: 0, net: 0 },
  );

  const peakDay = days.reduce(
    (best, d) => (d.collected > best.collected ? d : best),
    days[0] ?? { date: "", label: "", collected: 0, spent: 0, net: 0, paymentCount: 0, expenseCount: 0 },
  );

  const peakExpenseDay = days.reduce(
    (best, d) => (d.spent > best.spent ? d : best),
    days[0] ?? { date: "", label: "", collected: 0, spent: 0, net: 0, paymentCount: 0, expenseCount: 0 },
  );

  const topCollectionDays = [...days]
    .filter(d => d.collected > 0)
    .sort((a, b) => b.collected - a.collected)
    .slice(0, 10)
    .map(d => ({ date: d.date, label: d.label, collected: d.collected, paymentCount: d.paymentCount }));

  res.json({
    from: dateList[0] ?? null,
    to: dateList[dateList.length - 1] ?? null,
    month: month ?? null,
    days,
    totals,
    peakDay: peakDay.collected > 0
      ? { date: peakDay.date, label: peakDay.label, collected: peakDay.collected, paymentCount: peakDay.paymentCount }
      : null,
    peakExpenseDay: peakExpenseDay.spent > 0
      ? { date: peakExpenseDay.date, label: peakExpenseDay.label, spent: peakExpenseDay.spent, expenseCount: peakExpenseDay.expenseCount }
      : null,
    topCollectionDays,
  });
});

export default router;
