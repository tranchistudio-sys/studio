import { Router, type IRouter } from "express";
import { loadAllData } from "./data";

const router: IRouter = Router();

router.get("/revenue/by-period", async (req, res) => {
  const mode = (req.query["mode"] as string) || "12months";
  const { validBookings, castByBooking, directExpByBooking } = await loadAllData();

  const now = new Date();
  type PP = { label: string; start: string; end: string; revenue: number; expenses: number; profit: number };
  const points: PP[] = [];

  if (mode === "7days") {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      const label = i === 0 ? "Hôm nay" : d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
      points.push({ label, start: ds, end: ds, revenue: 0, expenses: 0, profit: 0 });
    }
  } else if (mode === "4weeks") {
    for (let i = 3; i >= 0; i--) {
      const wEnd = new Date(now); wEnd.setDate(wEnd.getDate() - i * 7);
      const wStart = new Date(wEnd); wStart.setDate(wEnd.getDate() - 6);
      const label = `${wStart.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })} - ${wEnd.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })}`;
      points.push({ label, start: wStart.toISOString().slice(0, 10), end: wEnd.toISOString().slice(0, 10), revenue: 0, expenses: 0, profit: 0 });
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const label = `T${d.getMonth() + 1}/${d.getFullYear()}`;
      points.push({ label, start: `${ym}-01`, end: `${ym}-${String(lastDay).padStart(2, "0")}`, revenue: 0, expenses: 0, profit: 0 });
    }
  }

  for (const p of points) {
    const inPeriod = validBookings.filter(b => b.shootDate >= p.start && b.shootDate <= p.end);
    p.revenue = inPeriod.reduce((s, b) => s + (parseFloat(b.totalAmount) || 0), 0);
    let cost = 0;
    for (const b of inPeriod) {
      cost += (castByBooking.get(b.id) ?? 0) + (directExpByBooking.get(b.id) ?? 0);
    }
    p.expenses = cost;
    p.profit = p.revenue - cost;
  }

  res.json(points.map(p => ({ label: p.label, revenue: p.revenue, expenses: p.expenses, profit: p.profit })));
});

export default router;
