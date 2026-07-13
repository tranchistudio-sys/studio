import { Router, type IRouter } from "express";
import { bookingColumnsCompat } from "../lib/schema-compat";
import { db, pool } from "@workspace/db";
import {
  bookingsTable, customersTable, dressesTable, rentalsTable,
  paymentsTable, tasksTable, transactionsTable, expensesTable,
} from "@workspace/db/schema";
import { eq, and, gte, lte, count, sum, ne, sql, isNull } from "drizzle-orm";
import { getCallerRole } from "./auth";
import { revenueCountableSql } from "../lib/booking-money";
import { paymentNotOnEmptyParentSql } from "../lib/parent-contract";

// PR D (read-layer): loại phiếu cọc nằm ở CHA RỖNG/ZOMBIE (hợp đồng cha hết dịch vụ con hiệu lực)
// khỏi các tổng "đã thu" active — dùng cho query tiền cash-basis của dashboard.
const paymentNotOnEmptyParentCond = sql.raw(paymentNotOnEmptyParentSql("payments"));

// Điều kiện "đơn tính doanh thu" dùng CHUNG cho mọi query dashboard (drizzle sql.raw
// + pool.query thô) — đồng bộ với booking-money.isRevenueCountable + revenue/data.ts.
// Loại: thùng rác, hủy, báo giá tạm, đơn CHA tổng (đếm con), con mồ côi (cha đã chết).
const countableBookingCond = sql.raw(revenueCountableSql("bookings"));

const router: IRouter = Router();

// ── Old stats route (backward compat) ─────────────────────────────────────────
router.get("/dashboard/stats", async (_req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const [totalCustomers] = await db.select({ count: count() }).from(customersTable);
  // Tổng đơn = đơn CÒN HIỆU LỰC (loại thùng rác/hủy/báo giá tạm/đơn cha/con mồ côi).
  const [totalBookings] = await db.select({ count: count() }).from(bookingsTable).where(countableBookingCond);
  // Các count còn lại cũng dùng countableBookingCond để là tập con nhất quán của tổng đơn
  // (không để confirmed/completed > tổng đơn khi có đơn cha tổng / con mồ côi / báo giá tạm).
  const [bookingsThisMonth] = await db.select({ count: count() }).from(bookingsTable)
    .where(and(countableBookingCond, gte(bookingsTable.shootDate, startOfMonth), lte(bookingsTable.shootDate, endOfMonth)));
  const [pendingBookings] = await db.select({ count: count() }).from(bookingsTable).where(and(countableBookingCond, eq(bookingsTable.status, "pending")));
  const [confirmedBookings] = await db.select({ count: count() }).from(bookingsTable).where(and(countableBookingCond, eq(bookingsTable.status, "confirmed")));
  const [completedBookings] = await db.select({ count: count() }).from(bookingsTable).where(and(countableBookingCond, eq(bookingsTable.status, "completed")));

  const [totalDresses] = await db.select({ count: count() }).from(dressesTable);
  const [availableDresses] = await db.select({ count: count() }).from(dressesTable).where(eq(dressesTable.isAvailable, true));
  const [activeRentals] = await db.select({ count: count() }).from(rentalsTable).where(eq(rentalsTable.status, "rented"));
  const [overdueRentals] = await db.select({ count: count() }).from(rentalsTable).where(eq(rentalsTable.status, "overdue"));
  const [pendingTasks] = await db.select({ count: count() }).from(tasksTable).where(eq(tasksTable.status, "todo"));

  const monthTransactions = await db.select().from(transactionsTable)
    .where(and(gte(transactionsTable.transactionDate, startOfMonth), lte(transactionsTable.transactionDate, endOfMonth)));
  const totalIncomeThisMonth = monthTransactions.filter(t => t.type === "income").reduce((s, t) => s + parseFloat(t.amount), 0);
  const totalExpenseThisMonth = monthTransactions.filter(t => t.type === "expense").reduce((s, t) => s + parseFloat(t.amount), 0);
  const profitThisMonth = totalIncomeThisMonth - totalExpenseThisMonth;

  // A2: "đã thu / doanh thu" KHÔNG tính phiếu đã hủy (voided) và KHÔNG cộng refund như tiền thu.
  const [allPaymentsSum] = await db.select({ total: sum(paymentsTable.amount) }).from(paymentsTable)
    .where(and(
      ne(paymentsTable.paymentType, "refund"),
      sql`COALESCE(${paymentsTable.status}, 'active') != 'voided'`,
    ));
  const totalRevenue = parseFloat(allPaymentsSum.total ?? "0");

  const allPayments = await db.select().from(paymentsTable)
    .where(and(
      gte(paymentsTable.paidAt, new Date(startOfMonth)),
      lte(paymentsTable.paidAt, new Date(endOfMonth + "T23:59:59")),
      ne(paymentsTable.paymentType, "refund"),
      sql`COALESCE(${paymentsTable.status}, 'active') != 'voided'`,
    ));
  const revenueThisMonth = allPayments.reduce((s, p) => s + parseFloat(p.amount), 0);

  // Công nợ tổng: chỉ đơn CÒN HIỆU LỰC (loại thùng rác/hủy/báo giá tạm/đơn cha/con mồ côi).
  const allBookings = await db.select(await bookingColumnsCompat()).from(bookingsTable).where(countableBookingCond);
  const allPaymentsAll = await db.select().from(paymentsTable);
  const totalOwed = allBookings.reduce((s, b) => s + parseFloat(b.totalAmount), 0);
  const totalPaidAll = allPaymentsAll
    .filter(p => p.paymentType !== "refund" && (p.status ?? "active") !== "voided")
    .reduce((s, p) => s + parseFloat(p.amount), 0);
  const totalDebt = Math.max(0, totalOwed - totalPaidAll);

  const upcomingRows = await db
    .select({
      id: bookingsTable.id,
      customerId: bookingsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      shootDate: bookingsTable.shootDate,
      shootTime: bookingsTable.shootTime,
      packageType: bookingsTable.packageType,
      status: bookingsTable.status,
      totalAmount: bookingsTable.totalAmount,
      depositAmount: bookingsTable.depositAmount,
      notes: bookingsTable.notes,
      createdAt: bookingsTable.createdAt,
    })
    .from(bookingsTable)
    .innerJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
    .where(and(isNull(bookingsTable.deletedAt), gte(bookingsTable.shootDate, today), eq(bookingsTable.status, "confirmed")))
    .orderBy(bookingsTable.shootDate)
    .limit(5);

  const upcomingBookings = upcomingRows.map((b) => ({
    ...b,
    totalAmount: parseFloat(b.totalAmount),
    depositAmount: parseFloat(b.depositAmount),
    remainingAmount: parseFloat(b.totalAmount) - parseFloat(b.depositAmount),
    assignedStaffId: null,
    assignedStaffName: null,
  }));

  res.json({
    totalCustomers: totalCustomers.count,
    totalBookings: totalBookings.count,
    bookingsThisMonth: bookingsThisMonth.count,
    pendingBookings: pendingBookings.count,
    confirmedBookings: confirmedBookings.count,
    completedBookings: completedBookings.count,
    totalDresses: totalDresses.count,
    availableDresses: availableDresses.count,
    activeRentals: activeRentals.count,
    overdueRentals: overdueRentals.count,
    revenueThisMonth,
    totalRevenue,
    profitThisMonth,
    totalExpenseThisMonth,
    totalIncomeThisMonth,
    upcomingBookings,
    pendingTasks: pendingTasks.count,
    totalDebt,
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
type PeriodPreset = "today" | "7days" | "month" | "year";

interface BookingRow {
  id: number;
  orderCode: string | null;
  customerId: number;
  shootDate: string;
  status: string;
  serviceCategory: string;
  packageType: string;
  serviceLabel: string | null;
  totalAmount: string;
  discountAmount: string;
  paidAmount: string;
  createdAt: Date;
}

interface PaymentRow {
  id: number;
  bookingId: number | null;
  amount: string;
  paidAt: Date;
  paymentType: string;
}

interface ServiceEntry {
  category: string;
  serviceKey: string;
  label: string;
  bookedCount: number;
  bookedAmount: number;
  owedAmount: number;
  collectedAmount: number;
}

// Use Asia/Ho_Chi_Minh timezone for date boundaries to avoid midnight day-shift.
// Dates are formatted as "YYYY-MM-DD" strings in local Vietnam time.
const APP_TZ = "Asia/Ho_Chi_Minh";

function toLocalDateString(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: APP_TZ }); // sv-SE gives "YYYY-MM-DD"
}

function startOfLocalDay(d: Date): Date {
  const ymd = toLocalDateString(d);
  // Reconstruct as UTC so DB comparisons (which store UTC) work correctly
  return new Date(`${ymd}T00:00:00+07:00`);
}

function endOfLocalDay(d: Date): Date {
  const ymd = toLocalDateString(d);
  return new Date(`${ymd}T23:59:59.999+07:00`);
}

function getPeriodRange(preset: PeriodPreset): { start: Date; end: Date; startDate: string; endDate: string } {
  const now = new Date();
  const end = endOfLocalDay(now);

  let start: Date;
  if (preset === "today") {
    start = startOfLocalDay(now);
  } else if (preset === "7days") {
    const d6ago = new Date(now);
    d6ago.setDate(d6ago.getDate() - 6);
    start = startOfLocalDay(d6ago);
  } else if (preset === "year") {
    const yearStart = new Date(now.getFullYear(), 0, 1);
    start = startOfLocalDay(yearStart);
  } else {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    start = startOfLocalDay(monthStart);
  }

  return {
    start,
    end,
    startDate: toLocalDateString(start),
    endDate: toLocalDateString(end),
  };
}

function computeRemaining(b: { totalAmount: string; discountAmount: string; paidAmount: string }): number {
  return Math.max(
    0,
    parseFloat(b.totalAmount) - parseFloat(b.discountAmount || "0") - parseFloat(b.paidAmount),
  );
}

function buildDayBuckets(start: Date, end: Date): { date: string; amount: number; count: number }[] {
  const buckets: { date: string; amount: number; count: number }[] = [];
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setHours(23, 59, 59, 999);
  while (cur <= endDay) {
    buckets.push({ date: cur.toISOString().slice(0, 10), amount: 0, count: 0 });
    cur.setDate(cur.getDate() + 1);
  }
  return buckets;
}

function buildMonthBuckets(year: number): { date: string; amount: number; count: number }[] {
  return Array.from({ length: 12 }, (_, i) => ({
    date: `${year}-${String(i + 1).padStart(2, "0")}`,
    amount: 0,
    count: 0,
  }));
}

const CATEGORY_LABELS: Record<string, string> = {
  wedding: "Cưới", prewedding: "Pre-wedding", portrait: "Chân dung",
  family: "Gia đình", fashion: "Thời trang", event: "Sự kiện",
  beauty: "Beauty", commercial: "Thương mại",
};

// ── Helper: compute operational + progress KPIs for a set of booking IDs ──────
async function computeOpsKPIs(bookingIds: number[], today: string): Promise<{
  unassigned: number; understaffed: number; upcomingShoot: number;
  inProgress: number; overdueJobs: number; completedJobs: number;
}> {
  if (bookingIds.length === 0) {
    return { unassigned: 0, understaffed: 0, upcomingShoot: 0, inProgress: 0, overdueJobs: 0, completedJobs: 0 };
  }

  const bids = `(${bookingIds.join(",")})`;

  const [taskRows, jobRows, upcomingRows, bookingRolesRows] = await Promise.all([
    pool.query(`
      SELECT booking_id, COUNT(*)::int AS task_count,
             COUNT(CASE WHEN assignee_id IS NOT NULL THEN 1 END)::int AS assigned_count,
             array_agg(DISTINCT role) FILTER (WHERE role IS NOT NULL AND assignee_id IS NOT NULL) AS covered_roles
      FROM tasks
      WHERE booking_id IN ${bids}
      GROUP BY booking_id
    `),
    pool.query(`
      SELECT booking_id, status, internal_deadline
      FROM photoshop_jobs
      WHERE booking_id IN ${bids} AND is_active = true
    `),
    pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM bookings
      WHERE id IN ${bids}
        AND shoot_date >= $1::date
        AND shoot_date <= ($1::date + 7)
        AND status != 'cancelled'
    `, [today]),
    pool.query(`
      SELECT id, required_roles
      FROM bookings
      WHERE id IN ${bids}
    `),
  ]);

  const taskMap = new Map<number, { taskCount: number; assignedCount: number; coveredRoles: string[] }>();
  for (const row of taskRows.rows) {
    taskMap.set(Number(row.booking_id), {
      taskCount: Number(row.task_count),
      assignedCount: Number(row.assigned_count),
      coveredRoles: Array.isArray(row.covered_roles) ? row.covered_roles as string[] : [],
    });
  }

  let unassigned = 0;
  let understaffed = 0;

  for (const bkRow of bookingRolesRows.rows) {
    const bid = Number(bkRow.id);
    const requiredRoles: string[] = Array.isArray(bkRow.required_roles) ? bkRow.required_roles as string[] : [];
    const taskInfo = taskMap.get(bid);

    if (!taskInfo || taskInfo.taskCount === 0) {
      unassigned++;
    } else {
      const coveredRoles = taskInfo.coveredRoles;
      const uncovered = requiredRoles.filter(r => !coveredRoles.includes(r));
      if (uncovered.length > 0) understaffed++;
    }
  }

  const upcomingShoot = Number(upcomingRows.rows[0]?.cnt ?? 0);

  let inProgress = 0, overdueJobs = 0, completedJobs = 0;
  for (const job of jobRows.rows) {
    if (job.status === "hoan_thanh") {
      completedJobs++;
    } else if (job.status === "dang_xu_ly" || job.status === "cho_duyet") {
      inProgress++;
      if (job.internal_deadline && String(job.internal_deadline) < today) overdueJobs++;
    } else if (job.status !== "tam_hoan" && job.internal_deadline && String(job.internal_deadline) < today) {
      overdueJobs++;
    }
  }

  return { unassigned, understaffed, upcomingShoot, inProgress, overdueJobs, completedJobs };
}

// ── Dashboard v2 ──────────────────────────────────────────────────────────────
// Response shape matches the user-approved JSON contract (nested: summary/charts/breakdown/debts).
router.get("/dashboard/v2", async (req, res): Promise<void> => {
  try {
    const callerRole = await getCallerRole(req.headers.authorization);
    const isAdmin = callerRole === "admin";

    // ── SHOOT-MONTH MODE (new) ─────────────────────────────────────────────
    const monthParam = req.query.month as string | undefined;
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      const [yr, mo] = monthParam.split("-");
      const startDate = `${yr}-${mo}-01`;
      const endOfMonth = new Date(Number(yr), Number(mo), 0).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);

      // Đơn CÒN HIỆU LỰC trong tháng chụp (loại thùng rác/hủy/báo giá tạm/đơn cha/con mồ côi)
      const bkResult = await pool.query(`
        SELECT b.id, b.order_code, b.shoot_date, b.status, b.service_category, b.package_type,
               b.service_label, b.total_amount, b.discount_amount, b.paid_amount,
               c.name AS customer_name, c.phone AS customer_phone
        FROM bookings b
        JOIN customers c ON c.id = b.customer_id
        WHERE b.shoot_date >= $1 AND b.shoot_date <= $2
          AND ${revenueCountableSql("b")}
        ORDER BY b.shoot_date
      `, [startDate, endOfMonth]);

      const bookingsInMonth = bkResult.rows as Array<Record<string, string>>;
      const bookingIds = bookingsInMonth.map(b => Number(b.id));
      const bookedCount = bookingsInMonth.length;
      const bookedAmount = bookingsInMonth.reduce((s, b) => s + parseFloat(b.total_amount), 0);
      const owedList = bookingsInMonth.map(b => Math.max(0, parseFloat(b.total_amount) - parseFloat(b.discount_amount || "0") - parseFloat(b.paid_amount)));
      const owedTotal = owedList.reduce((s, v) => s + v, 0);
      const owedCount = owedList.filter(v => v > 0).length;

      // "Đã thu" = tất cả payments trong tháng, bao gồm ad_hoc — không filter theo booking_id.
      // Dùng COALESCE(paid_date, paid_at VN) để nhất quán với getPaymentDate() trong revenue endpoint.
      const nextMonthStart = new Date(Number(yr), Number(mo), 1).toISOString().slice(0, 10);
      const pmResult = await pool.query(`
        SELECT COALESCE(SUM(amount::numeric), 0) AS total
        FROM payments
        WHERE payment_type != 'refund'
          AND COALESCE(status, 'active') != 'voided'
          AND ${paymentNotOnEmptyParentSql("payments")}
          AND COALESCE(paid_date, (paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text) >= $1
          AND COALESCE(paid_date, (paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text) < $2
      `, [startDate, nextMonthStart]);
      const collectedAmount = parseFloat(pmResult.rows[0]?.total ?? "0");

      // By-service breakdown
      const serviceMapM = new Map<string, { label: string; category: string; count: number; amount: number; owed: number }>();
      for (let i = 0; i < bookingsInMonth.length; i++) {
        const b = bookingsInMonth[i];
        const key = b.package_type || b.service_category || "other";
        const label = b.service_label || b.package_type || b.service_category || "Khác";
        const cat = b.service_category || "other";
        if (!serviceMapM.has(key)) serviceMapM.set(key, { label, category: cat, count: 0, amount: 0, owed: 0 });
        const e = serviceMapM.get(key)!;
        e.count++; e.amount += parseFloat(b.total_amount); e.owed += owedList[i];
      }
      const byService = Array.from(serviceMapM.values()).map(v => ({
        label: v.label, category: v.category, bookedCount: v.count, bookedAmount: v.amount, owedAmount: v.owed,
      })).sort((a, b) => b.bookedAmount - a.bookedAmount);

      // Operational + progress KPIs
      const opsKPIs = await computeOpsKPIs(bookingIds, today);

      // Top debtors for this month
      const topDebtors = bookingsInMonth
        .map((b, i) => ({
          bookingId: Number(b.id), bookingCode: b.order_code || `DH${String(b.id).padStart(4, "0")}`,
          customerName: b.customer_name || "—", customerPhone: b.customer_phone || "",
          totalAmount: parseFloat(b.total_amount), paidAmount: parseFloat(b.paid_amount),
          remainingAmount: owedList[i], shootDate: b.shoot_date, status: b.status,
        }))
        .filter(b => b.remainingAmount > 0)
        .sort((a, b) => b.remainingAmount - a.remainingAmount)
        .slice(0, 10);

      const financialSummary = isAdmin ? {
        bookedAmount, bookedCount, collectedAmount, owedTotal, owedCount,
      } : {};

      res.json({
        period: { mode: "shootMonth", month: monthParam, from: startDate, to: endOfMonth },
        summary: financialSummary,
        operationalKPIs: {
          totalBookings: bookedCount,
          unassigned: opsKPIs.unassigned,
          understaffed: opsKPIs.understaffed,
          upcomingShoot: opsKPIs.upcomingShoot,
        },
        progressKPIs: {
          inProgress: opsKPIs.inProgress,
          overdueJobs: opsKPIs.overdueJobs,
          completedJobs: opsKPIs.completedJobs,
        },
        breakdown: { byService },
        debts: { topDebtors: isAdmin ? topDebtors : [] },
        upcomingBookings: [],
      });
      return;
    }

    const preset = (req.query.period as PeriodPreset) || "month";
    const { start, end, startDate, endDate } = getPeriodRange(preset);
    const now = new Date();
    const year = now.getFullYear();
    const today = now.toISOString().slice(0, 10);
    // callerRole already fetched above

    // ── 1. Bookings in period (by createdAt) — for "đã chốt" KPI ──────────
    const bookingsInPeriod: BookingRow[] = await db
      .select({
        id: bookingsTable.id,
        orderCode: bookingsTable.orderCode,
        customerId: bookingsTable.customerId,
        shootDate: bookingsTable.shootDate,
        status: bookingsTable.status,
        serviceCategory: bookingsTable.serviceCategory,
        packageType: bookingsTable.packageType,
        serviceLabel: bookingsTable.serviceLabel,
        totalAmount: bookingsTable.totalAmount,
        discountAmount: bookingsTable.discountAmount,
        paidAmount: bookingsTable.paidAmount,
        createdAt: bookingsTable.createdAt,
      })
      .from(bookingsTable)
      .where(
        and(
          gte(bookingsTable.createdAt, start),
          lte(bookingsTable.createdAt, end),
          countableBookingCond,
        ),
      );

    // ── 2. ALL active NON-PARENT bookings — for owed totals ───────────────
    const allActiveBookings: BookingRow[] = await db
      .select({
        id: bookingsTable.id,
        orderCode: bookingsTable.orderCode,
        customerId: bookingsTable.customerId,
        shootDate: bookingsTable.shootDate,
        status: bookingsTable.status,
        serviceCategory: bookingsTable.serviceCategory,
        packageType: bookingsTable.packageType,
        serviceLabel: bookingsTable.serviceLabel,
        totalAmount: bookingsTable.totalAmount,
        discountAmount: bookingsTable.discountAmount,
        paidAmount: bookingsTable.paidAmount,
        createdAt: bookingsTable.createdAt,
      })
      .from(bookingsTable)
      .where(countableBookingCond);

    // ── 2b. ALL non-cancelled bookings (incl. parent contracts) — for service lookup
    // Payments may be recorded against parent contract bookings (isParentContract=true),
    // so we need to include them in the service lookup map.
    const allBookingsForLookup: BookingRow[] = await db
      .select({
        id: bookingsTable.id,
        orderCode: bookingsTable.orderCode,
        customerId: bookingsTable.customerId,
        shootDate: bookingsTable.shootDate,
        status: bookingsTable.status,
        serviceCategory: bookingsTable.serviceCategory,
        packageType: bookingsTable.packageType,
        serviceLabel: bookingsTable.serviceLabel,
        totalAmount: bookingsTable.totalAmount,
        discountAmount: bookingsTable.discountAmount,
        paidAmount: bookingsTable.paidAmount,
        createdAt: bookingsTable.createdAt,
      })
      .from(bookingsTable)
      .where(and(isNull(bookingsTable.deletedAt), ne(bookingsTable.status, "cancelled")));

    // ── 3. All active bookings WITH customer info — for top debtors ────────
    const allActiveWithCustomer = await db
      .select({
        id: bookingsTable.id,
        orderCode: bookingsTable.orderCode,
        shootDate: bookingsTable.shootDate,
        status: bookingsTable.status,
        totalAmount: bookingsTable.totalAmount,
        discountAmount: bookingsTable.discountAmount,
        paidAmount: bookingsTable.paidAmount,
        customerName: customersTable.name,
        customerPhone: customersTable.phone,
      })
      .from(bookingsTable)
      .leftJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
      .where(countableBookingCond);

    // ── 4. Payments in period (by paidAt) — for "đã thu" KPI ─────────────
    const paymentsInPeriod: PaymentRow[] = await db
      .select({
        id: paymentsTable.id,
        bookingId: paymentsTable.bookingId,
        amount: paymentsTable.amount,
        paidAt: paymentsTable.paidAt,
        paymentType: paymentsTable.paymentType,
      })
      .from(paymentsTable)
      .where(
        and(
          gte(paymentsTable.paidAt, start),
          lte(paymentsTable.paidAt, end),
          ne(paymentsTable.paymentType, "refund"),
          sql`COALESCE(${paymentsTable.status}, 'active') != 'voided'`,
          paymentNotOnEmptyParentCond, // PR D: bỏ cọc của cha rỗng khỏi "đã thu"
        ),
      );

    // ── 5. Expenses in period (by expenseDate) ─────────────────────────────
    const expensesInPeriod = await db
      .select({
        id: expensesTable.id,
        bookingId: expensesTable.bookingId,
        amount: expensesTable.amount,
        expenseDate: expensesTable.expenseDate,
      })
      .from(expensesTable)
      .where(
        and(
          gte(expensesTable.expenseDate, startDate),
          lte(expensesTable.expenseDate, endDate),
        ),
      );

    // ── 6. Upcoming bookings ───────────────────────────────────────────────
    const upcomingBookings = await db
      .select({
        id: bookingsTable.id,
        customerName: customersTable.name,
        customerPhone: customersTable.phone,
        shootDate: bookingsTable.shootDate,
        shootTime: bookingsTable.shootTime,
        packageType: bookingsTable.packageType,
        serviceLabel: bookingsTable.serviceLabel,
        status: bookingsTable.status,
      })
      .from(bookingsTable)
      .innerJoin(customersTable, eq(bookingsTable.customerId, customersTable.id))
      .where(and(
        gte(bookingsTable.shootDate, today),
        countableBookingCond,
      ))
      .orderBy(bookingsTable.shootDate)
      .limit(5);

    // ── Compute summary KPIs ───────────────────────────────────────────────
    const bookedAmount = bookingsInPeriod.reduce((s, b) => s + parseFloat(b.totalAmount), 0);
    const bookedCount = bookingsInPeriod.length;

    const collectedAmount = paymentsInPeriod.reduce((s, p) => s + parseFloat(p.amount), 0);
    const collectedCount = paymentsInPeriod.length;

    // owedTotal / owedCount: use booking.remainingAmount = max(0, total-discount-paid)
    const owedTotal = allActiveBookings.reduce((s, b) => s + computeRemaining(b), 0);
    const owedCount = allActiveBookings.filter(b => computeRemaining(b) > 0).length;
    const owedInPeriod = bookingsInPeriod.reduce((s, b) => s + computeRemaining(b), 0);

    const linkedExpenses = expensesInPeriod
      .filter(e => e.bookingId != null)
      .reduce((s, e) => s + parseFloat(e.amount), 0);
    const generalExpenses = expensesInPeriod
      .filter(e => e.bookingId == null)
      .reduce((s, e) => s + parseFloat(e.amount), 0);
    const totalExpenses = linkedExpenses + generalExpenses;
    const profit = collectedAmount - totalExpenses;

    // ── Charts ─────────────────────────────────────────────────────────────
    let chartBooked: { date: string; amount: number; count: number }[];
    let chartCollected: { date: string; amount: number; count: number }[];

    if (preset === "year") {
      const bookedBuckets = buildMonthBuckets(year);
      const collectedBuckets = buildMonthBuckets(year);

      // chartBooked: from bookings.createdAt
      bookingsInPeriod.forEach(b => {
        const m = new Date(b.createdAt).getMonth();
        bookedBuckets[m].amount += parseFloat(b.totalAmount);
        bookedBuckets[m].count += 1;
      });
      // chartCollected: from payments.paidAt
      paymentsInPeriod.forEach(p => {
        const m = new Date(p.paidAt).getMonth();
        collectedBuckets[m].amount += parseFloat(p.amount);
        collectedBuckets[m].count += 1;
      });

      chartBooked = bookedBuckets;
      chartCollected = collectedBuckets;
    } else {
      const bookedBuckets = buildDayBuckets(start, end);
      const collectedBuckets = buildDayBuckets(start, end);

      bookingsInPeriod.forEach(b => {
        const d = new Date(b.createdAt).toISOString().slice(0, 10);
        const bk = bookedBuckets.find(bk => bk.date === d);
        if (bk) { bk.amount += parseFloat(b.totalAmount); bk.count += 1; }
      });

      paymentsInPeriod.forEach(p => {
        const d = new Date(p.paidAt).toISOString().slice(0, 10);
        const bk = collectedBuckets.find(bk => bk.date === d);
        if (bk) { bk.amount += parseFloat(p.amount); bk.count += 1; }
      });

      chartBooked = bookedBuckets;
      chartCollected = collectedBuckets;
    }

    // ── Build service attribution maps from ALL non-cancelled bookings ────
    // Includes parent contracts so payments made against parent booking IDs
    // are still attributed to the correct service/category.
    const bookingServiceLookup = new Map<number, { serviceKey: string; category: string; label: string }>();
    for (const b of allBookingsForLookup) {
      bookingServiceLookup.set(b.id, {
        serviceKey: b.packageType || b.serviceCategory || "other",
        category: b.serviceCategory || "other",
        label: b.serviceLabel || b.packageType || b.serviceCategory || "Khác",
      });
    }

    const bookingCategoryLookup = new Map<number, { category: string; label: string }>();
    for (const b of allBookingsForLookup) {
      const cat = b.serviceCategory || "other";
      bookingCategoryLookup.set(b.id, { category: cat, label: CATEGORY_LABELS[cat] || cat });
    }

    // ── byService breakdown ────────────────────────────────────────────────
    const serviceMap = new Map<string, ServiceEntry>();

    // 1. Populate booked/owed from bookingsInPeriod
    for (const b of bookingsInPeriod) {
      const key = b.packageType || b.serviceCategory || "other";
      const label = b.serviceLabel || b.packageType || b.serviceCategory || "Khác";
      const cat = b.serviceCategory || "other";
      const rem = computeRemaining(b);

      if (!serviceMap.has(key)) {
        serviceMap.set(key, { category: cat, serviceKey: key, label, bookedCount: 0, bookedAmount: 0, owedAmount: 0, collectedAmount: 0 });
      }
      const e = serviceMap.get(key)!;
      e.bookedCount += 1;
      e.bookedAmount += parseFloat(b.totalAmount);
      e.owedAmount += rem;
    }

    // 2. Attribute payments to services using ALL active bookings as lookup
    for (const p of paymentsInPeriod) {
      if (p.bookingId == null) continue;
      const svc = bookingServiceLookup.get(p.bookingId);
      if (!svc) continue;

      // Ensure an entry exists even if the booking wasn't created in this period
      if (!serviceMap.has(svc.serviceKey)) {
        serviceMap.set(svc.serviceKey, {
          category: svc.category, serviceKey: svc.serviceKey, label: svc.label,
          bookedCount: 0, bookedAmount: 0, owedAmount: 0, collectedAmount: 0,
        });
      }
      serviceMap.get(svc.serviceKey)!.collectedAmount += parseFloat(p.amount);
    }

    const totalBookedSvc = Array.from(serviceMap.values()).reduce((s, v) => s + v.bookedAmount, 0) || 1;
    const totalCollectedSvc = Array.from(serviceMap.values()).reduce((s, v) => s + v.collectedAmount, 0) || 1;

    const byService = Array.from(serviceMap.values())
      .map(v => ({
        ...v,
        bookedPercent: parseFloat(((v.bookedAmount / totalBookedSvc) * 100).toFixed(1)),
        collectedPercent: parseFloat(((v.collectedAmount / totalCollectedSvc) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.bookedAmount - a.bookedAmount);

    // ── byCategory breakdown ───────────────────────────────────────────────
    const categoryMap = new Map<string, ServiceEntry>();

    for (const b of bookingsInPeriod) {
      const cat = b.serviceCategory || "other";
      const label = CATEGORY_LABELS[cat] || cat;
      const rem = computeRemaining(b);

      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, { category: cat, serviceKey: cat, label, bookedCount: 0, bookedAmount: 0, owedAmount: 0, collectedAmount: 0 });
      }
      const e = categoryMap.get(cat)!;
      e.bookedCount += 1;
      e.bookedAmount += parseFloat(b.totalAmount);
      e.owedAmount += rem;
    }

    for (const p of paymentsInPeriod) {
      if (p.bookingId == null) continue;
      const catInfo = bookingCategoryLookup.get(p.bookingId);
      if (!catInfo) continue;

      if (!categoryMap.has(catInfo.category)) {
        categoryMap.set(catInfo.category, {
          category: catInfo.category, serviceKey: catInfo.category, label: catInfo.label,
          bookedCount: 0, bookedAmount: 0, owedAmount: 0, collectedAmount: 0,
        });
      }
      categoryMap.get(catInfo.category)!.collectedAmount += parseFloat(p.amount);
    }

    const totalBookedCat = Array.from(categoryMap.values()).reduce((s, v) => s + v.bookedAmount, 0) || 1;
    const totalCollectedCat = Array.from(categoryMap.values()).reduce((s, v) => s + v.collectedAmount, 0) || 1;

    const byCategory = Array.from(categoryMap.values())
      .map(v => ({
        ...v,
        bookedPercent: parseFloat(((v.bookedAmount / totalBookedCat) * 100).toFixed(1)),
        collectedPercent: parseFloat(((v.collectedAmount / totalCollectedCat) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.bookedAmount - a.bookedAmount);

    // ── Top debtors (all time, sorted by remainingAmount desc) ────────────
    const topDebtors = allActiveWithCustomer
      .map(b => ({
        bookingId: b.id,
        bookingCode: b.orderCode || `DH${String(b.id).padStart(4, "0")}`,
        customerName: b.customerName || "—",
        customerPhone: b.customerPhone || "",
        totalAmount: parseFloat(b.totalAmount),
        paidAmount: parseFloat(b.paidAmount),
        remainingAmount: computeRemaining(b),
        shootDate: b.shootDate,
        status: b.status,
      }))
      .filter(b => b.remainingAmount > 0)
      .sort((a, b) => b.remainingAmount - a.remainingAmount)
      .slice(0, 10);

    // ── Operational + progress KPIs (all active bookings, no period filter) ─
    const allActiveIds = allActiveBookings.map(b => b.id);
    const opsKPIs = await computeOpsKPIs(allActiveIds, today);

    // ── Financial summary — strip for non-admin callers ────────────────────
    const financialSummary = isAdmin ? {
      bookedAmount, bookedCount, collectedAmount, collectedCount,
      owedTotal, owedCount, owedInPeriod, profit,
      linkedExpenses, generalExpenses, totalExpenses,
    } : {};

    // ── Response (nested shape per user-approved contract) ─────────────────
    res.json({
      period: {
        preset,
        from: startDate,
        to: endDate,
        bookingDateMode: "createdAt",
      },
      summary: financialSummary,
      operationalKPIs: {
        totalBookings: allActiveBookings.length,
        unassigned: opsKPIs.unassigned,
        understaffed: opsKPIs.understaffed,
        upcomingShoot: opsKPIs.upcomingShoot,
      },
      progressKPIs: {
        inProgress: opsKPIs.inProgress,
        overdueJobs: opsKPIs.overdueJobs,
        completedJobs: opsKPIs.completedJobs,
      },
      charts: {
        booked: chartBooked,
        collected: chartCollected,
      },
      breakdown: {
        byService,
        byCategory,
      },
      debts: {
        topDebtors: isAdmin ? topDebtors : [],
      },
      upcomingBookings,
      meta: {
        currency: "VND",
        bookingDateModeOptions: ["createdAt", "shootDate"],
      },
    });
  } catch (err) {
    console.error("[dashboard/v2]", err);
    res.status(500).json({ error: "Lỗi tải dashboard v2" });
  }
});


router.get("/dashboard/simple", async (req, res): Promise<void> => {
  try {
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`
    const from = String(req.query.from ?? firstOfMonth)
    const to = String(req.query.to ?? today)

    const [incomeRow, expenseRow, debtRow, fixedRow] = await Promise.all([
      pool.query(`
        SELECT COALESCE(SUM(amount::numeric), 0) AS total
        FROM payments
        WHERE paid_at >= $1::date
          AND paid_at < ($2::date + INTERVAL '1 day')
          AND payment_type != 'refund'
          AND COALESCE(status, 'active') != 'voided'
          AND ${paymentNotOnEmptyParentSql("payments")}
      `, [from, to]),
      pool.query(`
        SELECT COALESCE(SUM(amount::numeric), 0) AS total
        FROM expenses
        WHERE expense_date >= $1::date
          AND expense_date <= $2::date
      `, [from, to]),
      pool.query(`
        SELECT COALESCE(SUM(GREATEST(0, total_amount - COALESCE(discount_amount, 0) - COALESCE(paid_amount, 0))), 0) AS total
        FROM bookings
        WHERE ${revenueCountableSql("bookings")}
      `),
      pool.query(`
        SELECT COALESCE(SUM(amount::numeric), 0) AS total
        FROM fixed_costs
        WHERE active = true
      `),
    ])

    const totalIncome = parseFloat(incomeRow.rows[0]?.total ?? '0')
    const directExpense = parseFloat(expenseRow.rows[0]?.total ?? '0')
    const customerDebt = parseFloat(debtRow.rows[0]?.total ?? '0')
    const fixedCostMonthly = parseFloat(fixedRow.rows[0]?.total ?? '0')
    const totalSpent = directExpense + fixedCostMonthly
    const realProfit = totalIncome - totalSpent

    res.json({
      period: { from, to },
      totalIncome,
      // Giữ nguyên field cũ để không phá client cũ (totalExpense = chi trực tiếp)
      totalExpense: directExpense,
      profit: totalIncome - directExpense,
      customerDebt,
      // Field mới cho block "Lợi nhuận thực tế"
      directExpense,
      fixedCostMonthly,
      totalSpent,
      realProfit,
      breakeven: {
        status: realProfit >= 0 ? 'over' : 'under',
        delta: Math.abs(realProfit),
      },
    })
  } catch (err) {
    console.error('[dashboard/simple]', err)
    res.status(500).json({ error: 'Lỗi tải dashboard đơn giản' })
  }
})

export default router;
