import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { staffTable } from "@workspace/db/schema";
import { loadAllData } from "./data";
import { getBookingDate } from "./helpers";

export type BySaleBooking = {
  id: number;
  totalAmount: string;
  assignedStaff: unknown;
  createdAt: Date;
};

export type BySaleRow = {
  staffId: number;
  staffName: string;
  count: number;
  revenue: number;
  profit: number;
  contribution: number;
};

export function buildBySaleRows(
  bookings: BySaleBooking[],
  staffMap: Map<number, string>,
  castByBooking: Map<number, number>,
  directExpByBooking: Map<number, number>,
  from?: string,
  to?: string,
): BySaleRow[] {
  const scoped = (from && to)
    ? bookings.filter(b => {
        const d = getBookingDate(b);
        return d >= from && d <= to;
      })
    : bookings;

  const map = new Map<number, { count: number; revenue: number; expenses: number }>();
  let unassignedCount = 0, unassignedRevenue = 0, unassignedExpenses = 0;

  for (const b of scoped) {
    const staff = b.assignedStaff as Record<string, unknown> | null;
    const saleId = staff && typeof staff === "object" && !Array.isArray(staff)
      ? (staff["sale"] as number | undefined) : undefined;

    const cost = (castByBooking.get(b.id) ?? 0) + (directExpByBooking.get(b.id) ?? 0);
    const rev = parseFloat(b.totalAmount) || 0;

    if (saleId && typeof saleId === "number") {
      const existing = map.get(saleId) ?? { count: 0, revenue: 0, expenses: 0 };
      map.set(saleId, { count: existing.count + 1, revenue: existing.revenue + rev, expenses: existing.expenses + cost });
    } else {
      unassignedCount++;
      unassignedRevenue += rev;
      unassignedExpenses += cost;
    }
  }

  const totalRevenue = scoped.reduce((s, b) => s + (parseFloat(b.totalAmount) || 0), 0);

  const rows: BySaleRow[] = Array.from(map.entries())
    .map(([saleId, data]) => ({
      staffId: saleId,
      staffName: staffMap.get(saleId) ?? `Nhân viên #${saleId}`,
      count: data.count,
      revenue: data.revenue,
      profit: data.revenue - data.expenses,
      contribution: totalRevenue > 0 ? Math.round((data.revenue / totalRevenue) * 100) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  if (unassignedRevenue > 0 || unassignedCount > 0) {
    rows.push({
      staffId: 0,
      staffName: "Chưa gán Sale",
      count: unassignedCount,
      revenue: unassignedRevenue,
      profit: unassignedRevenue - unassignedExpenses,
      contribution: totalRevenue > 0 ? Math.round((unassignedRevenue / totalRevenue) * 100) : 0,
    });
  }

  return rows;
}

const router: IRouter = Router();

router.get("/revenue/by-sale", async (req, res) => {
  const { validBookings, castByBooking, directExpByBooking } = await loadAllData();

  const from = req.query["from"] as string | undefined;
  const to = req.query["to"] as string | undefined;

  const allStaff = await db.select({ id: staffTable.id, name: staffTable.name }).from(staffTable);
  const staffMap = new Map(allStaff.map(s => [s.id, s.name]));

  const rows = buildBySaleRows(validBookings, staffMap, castByBooking, directExpByBooking, from, to);
  res.json(rows);
});

export default router;
