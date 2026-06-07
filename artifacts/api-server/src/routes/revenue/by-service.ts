import { Router, type IRouter } from "express";
import { loadAllData } from "./data";
import { getBookingDate, getPaymentDate, SERVICE_LABELS } from "./helpers";

const router: IRouter = Router();

router.get("/revenue/v2/by-service", async (req, res) => {
  const { validBookings, castByBooking, directExpByBooking, payments } = await loadAllData();

  const from = req.query["from"] as string | undefined;
  const to = req.query["to"] as string | undefined;

  let filtered = validBookings;
  if (from && to) {
    filtered = validBookings.filter(b => {
      const d = getBookingDate(b);
      return d >= from && d <= to;
    });
  }

  const map = new Map<string, { count: number; contractValue: number; collected: number; remaining: number; staffCast: number; directExp: number }>();

  const filteredIds = new Set(filtered.map(b => b.id));
  const bookingPaymentsMap = new Map<number, number>();
  for (const p of payments) {
    if (p.paymentType === "refund" || !p.bookingId) continue;
    if (!filteredIds.has(p.bookingId)) continue;
    if (from && to) {
      const d = getPaymentDate(p);
      if (d < from || d > to) continue;
    }
    bookingPaymentsMap.set(p.bookingId, (bookingPaymentsMap.get(p.bookingId) ?? 0) + (parseFloat(p.amount) || 0));
  }

  for (const b of filtered) {
    const cat = b.serviceCategory || "other";
    const existing = map.get(cat) ?? { count: 0, contractValue: 0, collected: 0, remaining: 0, staffCast: 0, directExp: 0 };
    const total = parseFloat(b.totalAmount) || 0;
    const disc = parseFloat(b.discountAmount) || 0;
    const paid = parseFloat(b.paidAmount) || 0;
    const rem = Math.max(0, total - disc - paid);
    const collectedFromPayments = bookingPaymentsMap.get(b.id) ?? 0;
    map.set(cat, {
      count: existing.count + 1,
      contractValue: existing.contractValue + total,
      collected: existing.collected + collectedFromPayments,
      remaining: existing.remaining + rem,
      staffCast: existing.staffCast + (castByBooking.get(b.id) ?? 0),
      directExp: existing.directExp + (directExpByBooking.get(b.id) ?? 0),
    });
  }

  const rows = Array.from(map.entries())
    .map(([cat, data]) => ({
      service: SERVICE_LABELS[cat] ?? cat,
      serviceKey: cat,
      count: data.count,
      contractValue: data.contractValue,
      collected: data.collected,
      remaining: data.remaining,
      staffCast: data.staffCast,
      directExpenses: data.directExp,
      profit: data.collected - data.staffCast - data.directExp,
    }))
    .sort((a, b) => b.contractValue - a.contractValue);

  res.json(rows);
});

router.get("/revenue/by-service", async (_req, res) => {
  const { validBookings, castByBooking, directExpByBooking } = await loadAllData();

  const map = new Map<string, { count: number; revenue: number; expenses: number }>();
  for (const b of validBookings) {
    const cat = b.serviceCategory || "other";
    const existing = map.get(cat) ?? { count: 0, revenue: 0, expenses: 0 };
    const cost = (castByBooking.get(b.id) ?? 0) + (directExpByBooking.get(b.id) ?? 0);
    map.set(cat, {
      count: existing.count + 1,
      revenue: existing.revenue + (parseFloat(b.totalAmount) || 0),
      expenses: existing.expenses + cost,
    });
  }

  const totalRevenue = validBookings.reduce((s, b) => s + (parseFloat(b.totalAmount) || 0), 0);
  const totalCount = validBookings.length;

  const rows = Array.from(map.entries())
    .map(([cat, data]) => ({
      service: SERVICE_LABELS[cat] ?? cat,
      serviceKey: cat,
      count: data.count,
      revenue: data.revenue,
      profit: data.revenue - data.expenses,
      revenuePercentage: totalRevenue > 0 ? Math.round((data.revenue / totalRevenue) * 100) : 0,
      countPercentage: totalCount > 0 ? Math.round((data.count / totalCount) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  res.json(rows);
});

export default router;
