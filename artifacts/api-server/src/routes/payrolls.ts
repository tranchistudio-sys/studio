import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import { payrollsTable, staffTable, staffJobEarningsTable, staffLeaveRequestsTable } from "@workspace/db/schema";
import { eq, desc, and, inArray } from "drizzle-orm";
import { computeOvertimeForMonth, type OvertimeLog } from "../lib/overtime";

const router: IRouter = Router();

const fmt = (p: { baseSalary: string; showBonus: string; commission: string; bonus: string; deductions: string; advance: string; netSalary: string; [key: string]: unknown }) => ({
  ...p,
  baseSalary: parseFloat(p.baseSalary),
  showBonus: parseFloat(p.showBonus),
  commission: parseFloat(p.commission),
  bonus: parseFloat(p.bonus),
  deductions: parseFloat(p.deductions),
  advance: parseFloat(p.advance),
  netSalary: parseFloat(p.netSalary),
});

// ─── Helper quyền: admin = role='admin' HOẶC roles[] chứa 'admin' ───────────
// Trả { id, isAdmin } hoặc null nếu token không hợp lệ. Dùng để chặn quyền
// ở các endpoint write/detail (trước đây thiếu → ai cũng sửa được lương).
async function getCaller(req: { headers: { authorization?: string } }): Promise<{ id: number; isAdmin: boolean } | null> {
  const { verifyToken } = await import("./auth");
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return null;
  const cr = await pool.query(`SELECT role, roles FROM staff WHERE id=$1`, [callerId]);
  const u = cr.rows[0] as { role?: string; roles?: unknown } | undefined;
  const isAdmin = !!(u && (u.role === "admin" || (Array.isArray(u.roles) && u.roles.includes("admin"))));
  return { id: callerId, isAdmin };
}

// ─── Helper: cap leave 2 ngày/tháng, tính số ngày approved trong tháng ──────
async function countApprovedLeaveDays(staffId: number, month: number, year: number): Promise<{ used: number; capped: number; cap: number }> {
  const cap = 2;
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

  const rows = await db.select().from(staffLeaveRequestsTable).where(and(
    eq(staffLeaveRequestsTable.staffId, staffId),
    eq(staffLeaveRequestsTable.status, "approved"),
  ));
  // Count distinct overlapping days in [monthStart, monthEnd]
  const days = new Set<string>();
  for (const r of rows) {
    const sdStr = typeof r.startDate === "string" ? r.startDate : (r.startDate as Date).toISOString().slice(0, 10);
    const edStr = typeof r.endDate === "string" ? r.endDate : (r.endDate as Date).toISOString().slice(0, 10);
    const s = sdStr > monthStart ? sdStr : monthStart;
    const e = edStr < monthEnd ? edStr : monthEnd;
    if (s > e) continue;
    const sd = new Date(s);
    const ed = new Date(e);
    for (let d = new Date(sd); d <= ed; d.setDate(d.getDate() + 1)) {
      days.add(d.toISOString().slice(0, 10));
    }
  }
  const used = days.size;
  return { used, capped: Math.min(used, cap), cap };
}

router.get("/payrolls", async (req, res) => {
  const { verifyToken } = await import("./auth");
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const cr = await pool.query(`SELECT role FROM staff WHERE id=$1`, [callerId]);
  const isAdmin = (cr.rows[0] as { role?: string })?.role === "admin";

  let staffId = req.query.staffId ? parseInt(req.query.staffId as string) : undefined;
  if (!isAdmin) {
    if (staffId && staffId !== callerId) {
      return res.status(403).json({ error: "Không có quyền xem bảng lương của nhân viên khác" });
    }
    staffId = callerId;
  }
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;

  const rows = await db
    .select({
      id: payrollsTable.id,
      staffId: payrollsTable.staffId,
      staffName: staffTable.name,
      staffRole: staffTable.role,
      month: payrollsTable.month,
      year: payrollsTable.year,
      baseSalary: payrollsTable.baseSalary,
      showBonus: payrollsTable.showBonus,
      commission: payrollsTable.commission,
      bonus: payrollsTable.bonus,
      deductions: payrollsTable.deductions,
      advance: payrollsTable.advance,
      netSalary: payrollsTable.netSalary,
      items: payrollsTable.items,
      status: payrollsTable.status,
      notes: payrollsTable.notes,
      createdAt: payrollsTable.createdAt,
    })
    .from(payrollsTable)
    .innerJoin(staffTable, eq(payrollsTable.staffId, staffTable.id))
    .orderBy(desc(payrollsTable.year), desc(payrollsTable.month));

  let filtered = rows;
  if (staffId) filtered = filtered.filter(p => p.staffId === staffId);
  if (month) filtered = filtered.filter(p => p.month === month);
  if (year) filtered = filtered.filter(p => p.year === year);

  res.json(filtered.map(fmt));
});

router.post("/payrolls", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  if (!caller.isAdmin) return res.status(403).json({ error: "Chỉ admin được tạo bảng lương" });
  const { staffId, month, year, baseSalary, showBonus, commission, bonus, deductions, advance, items, notes } = req.body;
  const netSalary = (parseFloat(baseSalary || 0) + parseFloat(showBonus || 0) + parseFloat(commission || 0) + parseFloat(bonus || 0)) - parseFloat(deductions || 0) - parseFloat(advance || 0);
  const [payroll] = await db
    .insert(payrollsTable)
    .values({
      staffId, month, year,
      baseSalary: String(baseSalary || 0),
      showBonus: String(showBonus || 0),
      commission: String(commission || 0),
      bonus: String(bonus || 0),
      deductions: String(deductions || 0),
      advance: String(advance || 0),
      netSalary: String(netSalary),
      items: items || [],
      notes,
      status: "draft",
    })
    .returning();
  const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, staffId));
  res.status(201).json(fmt({ ...payroll, staffName: staff.name, staffRole: staff.role }));
});

// ─── POST /payrolls/generate ─────────────────────────────────────────────────
// Aggregate draft payroll: base + earnings(pending) + attendance bonus/penalty
// − leaveDeduction (vượt 2 ngày/tháng). Status luôn 'draft'.
router.post("/payrolls/generate", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  if (!caller.isAdmin) return res.status(403).json({ error: "Chỉ admin được tạo bảng lương" });
  const staffId = parseInt(String(req.body?.staffId));
  // Accept either `month` as number + `year`, or `month` as "YYYY-MM"
  let month: number;
  let year: number;
  const rawMonth = String(req.body?.month ?? "");
  if (/^\d{4}-\d{1,2}$/.test(rawMonth)) {
    const [y, m] = rawMonth.split("-").map(Number);
    year = y; month = m;
  } else {
    month = parseInt(rawMonth);
    year = parseInt(String(req.body?.year));
  }
  if (!staffId || !month || !year) return res.status(400).json({ error: "Thiếu staffId/month/year" });

  // Duplicate check
  const existing = await db.select().from(payrollsTable).where(and(
    eq(payrollsTable.staffId, staffId),
    eq(payrollsTable.month, month),
    eq(payrollsTable.year, year),
  ));
  if (existing.length > 0) {
    return res.status(409).json({ error: "Bảng lương tháng này đã tồn tại." });
  }

  const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, staffId));
  if (!staff) return res.status(404).json({ error: "Không tìm thấy nhân viên" });

  // Lương cứng (lấy từ baseSalaryAmount, fallback salary text)
  const baseSalary = parseFloat(String(staff.baseSalaryAmount ?? 0)) ||
    parseFloat(String(staff.salary ?? "0").replace(/[^\d.]/g, "")) || 0;

  // Earnings pending (tiền show)
  const earningsRaw = await db.select().from(staffJobEarningsTable).where(and(
    eq(staffJobEarningsTable.staffId, staffId),
    eq(staffJobEarningsTable.month, month),
    eq(staffJobEarningsTable.year, year),
    eq(staffJobEarningsTable.status, "pending"),
  ));
  // Loại earnings thuộc booking đã HỦY (cancelled) — không đưa vào bảng lương.
  const earnBids = Array.from(new Set(earningsRaw.map(e => e.bookingId).filter((x): x is number => x != null)));
  const cancelledBids = new Set<number>();
  if (earnBids.length > 0) {
    const cR = await pool.query(`SELECT id FROM bookings WHERE id = ANY($1::int[]) AND (status = 'cancelled' OR deleted_at IS NOT NULL)`, [earnBids]);
    for (const r of cR.rows as Array<{ id: number }>) cancelledBids.add(r.id);
  }
  const earnings = earningsRaw.filter(e => e.bookingId == null || !cancelledBids.has(e.bookingId));
  const showBonus0 = earnings.reduce((s, e) => s + parseFloat(e.rate), 0);
  // Task #483: add per-show allowances to showBonus (loại booking đã hủy)
  const allowQ = await pool.query(
    `SELECT COALESCE(SUM(sa.amount), 0) AS total
       FROM staff_allowances sa
       JOIN bookings b ON b.id = sa.booking_id
      WHERE sa.staff_id = $1
        AND EXTRACT(YEAR  FROM b.shoot_date) = $2
        AND EXTRACT(MONTH FROM b.shoot_date) = $3
        AND COALESCE(b.status, '') <> 'cancelled'
        AND b.deleted_at IS NULL`,
    [staffId, year, month]
  );
  const allowanceTotal = parseFloat(String(allowQ.rows[0]?.total ?? 0));
  const showBonus = showBonus0 + allowanceTotal;

  // Attendance adjustments (bonus/penalty/advance) trong tháng
  const adjR = await pool.query(
    `SELECT id, type, amount, date, reason FROM attendance_adjustments
     WHERE staff_id = $1 AND to_char(date::timestamp, 'YYYY-MM') = $2`,
    [staffId, `${year}-${String(month).padStart(2, "0")}`]
  );
  let bonus = 0, penalty = 0, advance = 0;
  for (const a of adjR.rows as Array<{ type: string; amount: string }>) {
    const v = parseFloat(a.amount);
    if (a.type === "bonus") bonus += v;
    else if (a.type === "penalty") penalty += v;
    else if (a.type === "advance") advance += v;
  }

  // Task #504: snapshot tăng ca (giờ + rate hiện tại) → cộng vào bonus.
  // Rate snapshot vào items.overtime để khi admin đổi rate sau, bảng lương cũ giữ nguyên.
  const monthStr2 = `${year}-${String(month).padStart(2, "0")}`;
  const otRuleR = await pool.query(`SELECT overtime_rate_per_hour FROM attendance_rules WHERE is_active=1 LIMIT 1`);
  const otRate = parseFloat(String((otRuleR.rows[0] as { overtime_rate_per_hour?: string })?.overtime_rate_per_hour ?? "30000"));
  const otLogsR = await pool.query(
    `SELECT type,
            to_char(created_at + interval '7 hours', 'HH24:MI') as t,
            to_char(created_at + interval '7 hours', 'YYYY-MM-DD') as d
       FROM attendance_logs
      WHERE staff_id = $1
        AND to_char(created_at + interval '7 hours', 'YYYY-MM') = $2
        AND type IN ('overtime_check_in', 'overtime_check_out')
      ORDER BY created_at`,
    [staffId, monthStr2]
  );
  const otLogs: OvertimeLog[] = (otLogsR.rows as { type: string; t: string; d: string }[])
    .map(r => ({ date: r.d, type: r.type, time: r.t }));
  const ot = computeOvertimeForMonth(otLogs, otRate);
  // OT giữ riêng (KHÔNG cộng vào bonus). Cộng trực tiếp vào netSalary phía dưới
  // và snapshot vào items.overtime để breakdown hiển thị tách dòng.

  // Leave deduction: chỉ trừ phần vượt cap 2 ngày
  const daysInMonth = new Date(year, month, 0).getDate();
  const dailySalary = baseSalary / daysInMonth;
  const leave = await countApprovedLeaveDays(staffId, month, year);
  const overflow = Math.max(0, leave.used - leave.cap);
  const leaveDeduction = Math.round(dailySalary * overflow);

  const deductions = penalty + leaveDeduction;
  const netSalary = baseSalary + showBonus + bonus + ot.pay - deductions - advance;

  const items = {
    // Top-level fields the UI consumes for the 6-column breakdown
    baseSalary,
    totalEarnings: showBonus,
    showBonus,
    bonus,
    penalty,
    advance,
    leaveDeduction,
    leaveDaysUsed: leave.used,
    leaveDaysCap: leave.cap,
    dailySalary,
    daysInMonth,
    overtime: { hours: ot.hours, rate: ot.rate, pay: ot.pay, byDate: ot.byDate },
    breakdown: {
      baseSalary,
      showBonus,
      bonus,
      penalty,
      advance,
      leaveDeduction,
      leaveDaysUsed: leave.used,
      leaveDaysCap: leave.cap,
      dailySalary,
      daysInMonth,
      overtime: { hours: ot.hours, rate: ot.rate, pay: ot.pay },
    },
    earningIds: earnings.map(e => e.id),
  };

  // Insert payroll + link earnings — sequential, no transaction wrapper available, accept risk
  const [payroll] = await db.insert(payrollsTable).values({
    staffId, month, year,
    baseSalary: String(baseSalary),
    showBonus: String(showBonus),
    commission: "0",
    bonus: String(bonus),
    deductions: String(deductions),
    advance: String(advance),
    netSalary: String(netSalary),
    items,
    status: "draft",
  }).returning();

  if (earnings.length > 0) {
    await db.update(staffJobEarningsTable)
      .set({ status: "included_in_payroll", payrollId: payroll.id })
      .where(inArray(staffJobEarningsTable.id, earnings.map(e => e.id)));
  }

  res.status(201).json(fmt({ ...payroll, staffName: staff.name, staffRole: staff.role }));
});

router.put("/payrolls/:id", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  if (!caller.isAdmin) return res.status(403).json({ error: "Chỉ admin được sửa bảng lương" });
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });
  const { baseSalary, showBonus, commission, bonus, deductions, advance, items, status, notes } = req.body;

  const [current] = await db.select().from(payrollsTable).where(eq(payrollsTable.id, id));
  if (!current) return res.status(404).json({ error: "Không tìm thấy bảng lương" });

  // Terminal state: paid payrolls are immutable
  if (current.status === "paid") {
    return res.status(400).json({ error: "Không thể sửa bảng lương đã trả." });
  }

  // Status transition guards
  if (status !== undefined && status !== current.status) {
    const allowed: Record<string, string[]> = {
      draft: ["paid", "cancelled"],
      cancelled: ["draft"],
    };
    if (!(allowed[current.status] ?? []).includes(status)) {
      return res.status(400).json({ error: `Không thể chuyển ${current.status} → ${status}` });
    }
  }

  const update: Record<string, unknown> = {};
  if (baseSalary !== undefined) update.baseSalary = String(baseSalary);
  if (showBonus !== undefined) update.showBonus = String(showBonus);
  if (commission !== undefined) update.commission = String(commission);
  if (bonus !== undefined) update.bonus = String(bonus);
  if (deductions !== undefined) update.deductions = String(deductions);
  if (advance !== undefined) update.advance = String(advance);
  if (items !== undefined) update.items = items;
  if (status !== undefined) update.status = status;
  if (notes !== undefined) update.notes = notes;

  const bS = parseFloat(String(baseSalary ?? current.baseSalary));
  const sB = parseFloat(String(showBonus ?? current.showBonus));
  const cm = parseFloat(String(commission ?? current.commission));
  const bn = parseFloat(String(bonus ?? current.bonus));
  const dd = parseFloat(String(deductions ?? current.deductions));
  const av = parseFloat(String(advance ?? current.advance));
  update.netSalary = String(bS + sB + cm + bn - dd - av);

  const [payroll] = await db.update(payrollsTable).set(update).where(eq(payrollsTable.id, id)).returning();

  // Cascade earnings status based on transition
  if (status !== undefined && status !== current.status) {
    if (status === "paid") {
      await db.update(staffJobEarningsTable)
        .set({ status: "paid" })
        .where(eq(staffJobEarningsTable.payrollId, id));
    } else if (status === "cancelled") {
      await db.update(staffJobEarningsTable)
        .set({ status: "pending", payrollId: null })
        .where(eq(staffJobEarningsTable.payrollId, id));
    }
  }

  res.json(fmt(payroll));
});

router.delete("/payrolls/:id", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  if (!caller.isAdmin) return res.status(403).json({ error: "Chỉ admin được xóa bảng lương" });
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });
  const [current] = await db.select().from(payrollsTable).where(eq(payrollsTable.id, id));
  if (!current) return res.status(404).send();
  if (current.status === "paid") {
    return res.status(400).json({ error: "Không thể xóa bảng lương đã trả." });
  }
  // Rollback earnings về pending trước khi xóa
  await db.update(staffJobEarningsTable)
    .set({ status: "pending", payrollId: null })
    .where(eq(staffJobEarningsTable.payrollId, id));
  await db.delete(payrollsTable).where(eq(payrollsTable.id, id));
  res.status(204).send();
});

// ─── GET /payrolls/:id/detail — payroll + linked earnings + leave summary ──
router.get("/payrolls/:id/detail", async (req, res) => {
  const caller = await getCaller(req);
  if (!caller) return res.status(401).json({ error: "Chưa đăng nhập" });
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID không hợp lệ" });
  const [payroll] = await db.select().from(payrollsTable).where(eq(payrollsTable.id, id));
  if (!payroll) return res.status(404).json({ error: "Không tìm thấy" });
  if (!caller.isAdmin && payroll.staffId !== caller.id) {
    return res.status(403).json({ error: "Không có quyền xem bảng lương của nhân viên khác" });
  }
  const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, payroll.staffId));
  const earnings = await db.select().from(staffJobEarningsTable).where(eq(staffJobEarningsTable.payrollId, id));
  const leave = await countApprovedLeaveDays(payroll.staffId, payroll.month, payroll.year);
  const itemsAny = (payroll.items ?? {}) as Record<string, unknown>;
  const leaveDeduction = Number(itemsAny.leaveDeduction ?? 0);
  const overflowDays = Math.max(0, leave.used - leave.cap);
  res.json({
    payroll: fmt({ ...payroll, staffName: staff?.name, staffRole: staff?.role }),
    earnings: earnings.map(e => ({ ...e, rate: parseFloat(e.rate) })),
    leave: { ...leave, overflowDays, deduction: leaveDeduction },
  });
});

// POST /payrolls/finalize-payment — admin chốt & snapshot lương tháng (khóa vĩnh viễn)
router.post("/payrolls/finalize-payment", async (req, res) => {
  try {
    const { verifyToken } = await import("./auth");
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
    const cr = await pool.query(`SELECT role, name FROM staff WHERE id=$1`, [callerId]);
    const caller = cr.rows[0] as { role?: string; name?: string };
    if (caller?.role !== "admin") return res.status(403).json({ error: "Chỉ admin mới chốt lương" });

    const staffId = parseInt(String(req.body?.staffId));
    let month: number, year: number;
    const rawMonth = String(req.body?.month ?? "");
    if (/^\d{4}-\d{1,2}$/.test(rawMonth)) {
      [year, month] = rawMonth.split("-").map(Number);
    } else {
      month = parseInt(String(req.body?.month));
      year = parseInt(String(req.body?.year));
    }
    if (!staffId || !month || !year) return res.status(400).json({ error: "Thiếu staffId/month/year" });

    const { finalizePayrollPayment } = await import("../lib/payroll-snapshot");
    const payroll = await finalizePayrollPayment(staffId, month, year, callerId, caller?.name ?? "Admin");
    const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, staffId));
    res.status(201).json(fmt({ ...payroll, staffName: staff?.name, staffRole: staff?.role }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Lỗi hệ thống";
    console.error("POST /payrolls/finalize-payment error:", err);
    res.status(400).json({ error: msg });
  }
});


export default router;
