import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { transactionsTable } from "@workspace/db/schema";
import { eq, and, gte, lte, sum } from "drizzle-orm";

const router: IRouter = Router();

router.get("/accounting/transactions", async (req, res) => {
  const type = req.query.type as string | undefined;
  const month = req.query.month ? parseInt(req.query.month as string) : new Date().getMonth() + 1;
  const year = req.query.year ? parseInt(req.query.year as string) : new Date().getFullYear();

  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = new Date(year, month, 0).toISOString().slice(0, 10);

  let q = db.select().from(transactionsTable)
    .where(and(gte(transactionsTable.transactionDate, start), lte(transactionsTable.transactionDate, end)))
    .$dynamic();

  const rows = await q.orderBy(transactionsTable.transactionDate);
  let filtered = rows;
  if (type) filtered = filtered.filter((t) => t.type === type);

  res.json(filtered.map((t) => ({ ...t, amount: parseFloat(t.amount) })));
});

router.post("/accounting/transactions", async (req, res) => {
  const { type, category, amount, description, paymentMethod, transactionDate } = req.body;
  const [tx] = await db
    .insert(transactionsTable)
    .values({ type, category, amount: String(amount), description, paymentMethod, transactionDate })
    .returning();
  res.status(201).json({ ...tx, amount: parseFloat(tx.amount) });
});

router.delete("/accounting/transactions/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  await db.delete(transactionsTable).where(eq(transactionsTable.id, id));
  res.status(204).send();
});

router.get("/accounting/summary", async (req, res) => {
  const month = req.query.month ? parseInt(req.query.month as string) : new Date().getMonth() + 1;
  const year = req.query.year ? parseInt(req.query.year as string) : new Date().getFullYear();

  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = new Date(year, month, 0).toISOString().slice(0, 10);

  const rows = await db.select()
    .from(transactionsTable)
    .where(and(gte(transactionsTable.transactionDate, start), lte(transactionsTable.transactionDate, end)));

  const incomeRows = rows.filter((r) => r.type === "income");
  const expenseRows = rows.filter((r) => r.type === "expense");

  const totalIncome = incomeRows.reduce((s, r) => s + parseFloat(r.amount), 0);
  const totalExpense = expenseRows.reduce((s, r) => s + parseFloat(r.amount), 0);
  const profit = totalIncome - totalExpense;
  const profitPercent = totalIncome > 0 ? Math.round((profit / totalIncome) * 100) : 0;

  const incomeByCategory = Object.entries(
    incomeRows.reduce((acc: Record<string, number>, r) => {
      acc[r.category] = (acc[r.category] || 0) + parseFloat(r.amount);
      return acc;
    }, {})
  ).map(([category, total]) => ({ category, total }));

  const expenseByCategory = Object.entries(
    expenseRows.reduce((acc: Record<string, number>, r) => {
      acc[r.category] = (acc[r.category] || 0) + parseFloat(r.amount);
      return acc;
    }, {})
  ).map(([category, total]) => ({ category, total }));

  // Monthly data for last 6 months
  const monthlyData = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(year, month - 1 - i, 1);
    const m = d.getMonth() + 1;
    const y = d.getFullYear();
    const s = `${y}-${String(m).padStart(2, "0")}-01`;
    const e = new Date(y, m, 0).toISOString().slice(0, 10);
    const monthRows = await db.select().from(transactionsTable)
      .where(and(gte(transactionsTable.transactionDate, s), lte(transactionsTable.transactionDate, e)));
    const inc = monthRows.filter(r => r.type === "income").reduce((s, r) => s + parseFloat(r.amount), 0);
    const exp = monthRows.filter(r => r.type === "expense").reduce((s, r) => s + parseFloat(r.amount), 0);
    monthlyData.push({ month: `T${m}`, income: inc, expense: exp, profit: inc - exp });
  }

  res.json({ month, year, totalIncome, totalExpense, profit, profitPercent, incomeByCategory, expenseByCategory, monthlyData });
});

export default router;
