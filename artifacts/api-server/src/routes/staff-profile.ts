import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import {
  staffTable, staffJobEarningsTable, staffRatePricesTable,
  staffLeaveRequestsTable, staffInternalNotesTable,
  staffKpiConfigTable, payrollsTable,
} from "@workspace/db/schema";
import { eq, desc, and, lte, gte } from "drizzle-orm";
import { verifyToken } from "./auth";
import { computeMonthEstimate } from "../lib/salary-estimate";
import { computeOvertimeForMonth, type OvertimeLog } from "../lib/overtime";

const router: IRouter = Router();

function parseJsonb(val: unknown): unknown {
  if (val == null) return null;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return null; }
  }
  if (Buffer.isBuffer(val)) {
    try { return JSON.parse(val.toString("utf8")); } catch { return null; }
  }
  return val;
}

// ─── Helper: check if staff appears anywhere in a booking ────────────────────────
function hasStaffInBooking(row: Record<string, unknown>, staffId: number): boolean {
  const assigned = parseJsonb(row.assigned_staff) as unknown;
  const items = parseJsonb(row.items) as Array<Record<string, unknown>> | null;
  // 1) top-level assigned_staff
  if (assigned) {
    if (Array.isArray(assigned)) {
      for (const entry of assigned) {
        // legacy format: array of raw IDs, e.g. [3, 5]
        if (typeof entry === "number" || typeof entry === "string") {
          if (String(entry) === String(staffId)) return true;
          continue;
        }
        if (entry && typeof entry === "object" && String((entry as Record<string, unknown>).staffId ?? "") === String(staffId)) return true;
      }
    } else if (typeof assigned === "object") {
      const a = assigned as Record<string, unknown>;
      if (String(a.photo) === String(staffId) || String(a.photographer) === String(staffId)) return true;
      if (String(a.makeup) === String(staffId)) return true;
      if (String(a.sale) === String(staffId)) return true;
      if (String(a.photoshop) === String(staffId)) return true;
    }
  }
  // 2) items[].assignedStaff  or  items[].photoId / makeupId
  if (Array.isArray(items)) {
    for (const it of items) {
      if (!it) continue;
      const itemStaff = it.assignedStaff;
      if (Array.isArray(itemStaff)) {
        for (const s of itemStaff as Array<Record<string, unknown>>) {
          if (s && String(s.staffId ?? "") === String(staffId)) return true;
        }
      }
      if (String(it.photoId ?? "") === String(staffId)) return true;
      if (String(it.makeupId ?? "") === String(staffId)) return true;
    }
  }
  return false;
}

// ─── Helper: build profile data for a staff ID (shared by /me and /:id) ──────
async function buildProfileData(staffId: number, includeForecast = false, isAdminCaller = false, monthOverride?: number, yearOverride?: number) {
  const [member] = await db.select().from(staffTable).where(eq(staffTable.id, staffId));
  if (!member) return null;

  const now = new Date();
  const thisMonth = monthOverride ?? (now.getMonth() + 1);
  const thisYear = yearOverride ?? now.getFullYear();
  const today = now.toISOString().slice(0, 10);
  const monthStart = `${thisYear}-${String(thisMonth).padStart(2, "0")}-01`;

  const jobsResult = await pool.query(`
    SELECT b.id, b.shoot_date, b.package_type, b.status, b.total_amount, b.assigned_staff, b.items,
      b.service_label, b.is_parent_contract, b.parent_id,
      c.name AS customer_name, c.phone AS customer_phone
    FROM bookings b
    LEFT JOIN customers c ON c.id = b.customer_id
    WHERE (b.assigned_staff IS NOT NULL OR b.items IS NOT NULL)
      AND (
        b.assigned_staff::text LIKE $1
        OR b.items::text LIKE $1
      )
    ORDER BY b.shoot_date DESC
  `, [`%${staffId}%`]);

  const STATUS_MAP: Record<string, string> = {
    completed: "completed", hoan_thanh: "completed", done: "completed",
    cancelled: "cancelled", huy: "cancelled",
    pending: "pending", confirmed: "confirmed", in_progress: "in_progress",
  };
  const normalizeStatus = (s: string) => STATUS_MAP[s?.toLowerCase()] ?? "pending";

  const toDateStr = (v: unknown): string => {
    if (!v) return "";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v);
    return s.length >= 10 ? s.slice(0, 10) : s;
  };

  const allJobs = jobsResult.rows
    .filter((r: Record<string, unknown>) => hasStaffInBooking(r, staffId))
    .map((r: Record<string, unknown>) => {
      const assigned = parseJsonb(r.assigned_staff) as Record<string, unknown> | unknown[];
      const items = parseJsonb(r.items) as Array<Record<string, unknown>> | null;
      const roles: string[] = [];
      const roleTasks: Record<string, string> = {};

      // 1) top-level assigned_staff
      if (Array.isArray(assigned)) {
        const isObjArray = assigned.length > 0 && typeof assigned[0] === "object" && assigned[0] !== null && "role" in (assigned[0] as object);
        if (isObjArray) {
          for (const entry of assigned as { role?: string; staffId?: unknown; taskKey?: string }[]) {
            if (String(entry.staffId ?? "") !== String(staffId)) continue;
            const mappedRole = entry.role === "sales" ? "sale" : (entry.role || "unknown");
            roles.push(mappedRole);
            if (entry.taskKey) roleTasks[mappedRole] = entry.taskKey;
          }
        } else {
          if ((assigned as unknown[]).includes(staffId) || (assigned as unknown[]).map(Number).includes(staffId)) roles.push("unknown");
        }
      } else if (assigned && typeof assigned === "object") {
        const a = assigned as Record<string, unknown>;
        if (String(a.photo) === String(staffId)) { roles.push("photo"); if (a.photoTask) roleTasks.photo = String(a.photoTask); }
        if (String(a.photographer) === String(staffId)) { roles.push("photo"); if (a.photographerTask) roleTasks.photo = String(a.photographerTask); }
        if (String(a.makeup) === String(staffId)) { roles.push("makeup"); if (a.makeupTask) roleTasks.makeup = String(a.makeupTask); }
        if (String(a.sale) === String(staffId)) { roles.push("sale"); if (a.saleTask) roleTasks.sale = String(a.saleTask); }
        if (String(a.photoshop) === String(staffId)) { roles.push("photoshop"); if (a.photoshopTask) roleTasks.photoshop = String(a.photoshopTask); }
      }

      // 2) items[].assignedStaff  /  items[].photoId / makeupId
      if (Array.isArray(items)) {
        for (const it of items) {
          if (!it) continue;
          const itemStaff = it.assignedStaff as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(itemStaff)) {
            for (const s of itemStaff) {
              if (!s || String(s.staffId ?? "") !== String(staffId)) continue;
              const mappedRole = String(s.role ?? "unknown") === "sales" ? "sale" : (String(s.role) || "unknown");
              if (!roles.includes(mappedRole)) roles.push(mappedRole);
            }
          }
          if (String(it.photoId ?? "") === String(staffId) && !roles.includes("photo")) roles.push("photo");
          if (String(it.makeupId ?? "") === String(staffId) && !roles.includes("makeup")) roles.push("makeup");
        }
      }

      return {
        id: r.id, shootDate: toDateStr(r.shoot_date), packageType: r.package_type,
        serviceLabel: r.service_label, status: r.status,
        totalAmount: parseFloat(String(r.total_amount || 0)),
        customerName: r.customer_name, customerPhone: r.customer_phone,
        roles, roleTasks, isParentContract: Boolean(r.is_parent_contract), parentId: r.parent_id,
      };
    });

  const monthEnd = `${thisYear}-${String(thisMonth).padStart(2, "0")}-31`;
  const monthJobs = allJobs.filter(j => j.shootDate >= monthStart && j.shootDate <= monthEnd);
  const todayJobs = allJobs.filter(j => j.shootDate === today);
  // Date-based completion: shootDate <= today → completed; > today → pending.
  // Admin không bấm "hoàn thành" thủ công, nên dùng ngày làm nguồn duy nhất
  // để đồng bộ với salary-estimate (showEarnings cũng filter shoot_date ≤ today).
  const completedCount = monthJobs.filter(j => j.shootDate && j.shootDate <= today).length;
  const pendingCount = monthJobs.filter(j => j.shootDate && j.shootDate > today).length;
  const monthStats = {
    total: monthJobs.length,
    completed: completedCount,
    pending: pendingCount,
    inProgress: 0,
    cancelled: 0,
  };

  const earnings = await db.select().from(staffJobEarningsTable)
    .where(eq(staffJobEarningsTable.staffId, staffId))
    .orderBy(desc(staffJobEarningsTable.createdAt));

  const monthEarnings = earnings.filter(e => e.month === thisMonth && e.year === thisYear);
  const todayEarnings = earnings.filter(e => e.earnedDate === today);

  const rates = await db.select().from(staffRatePricesTable)
    .where(eq(staffRatePricesTable.staffId, staffId))
    .orderBy(staffRatePricesTable.role, staffRatePricesTable.taskKey);

  const leaves = await db.select().from(staffLeaveRequestsTable)
    .where(eq(staffLeaveRequestsTable.staffId, staffId))
    .orderBy(desc(staffLeaveRequestsTable.createdAt));

  // Task #465: tính số ngày leave approved tháng hiện tại (cap 2)
  const _now = new Date();
  const _y = _now.getFullYear();
  const _m = _now.getMonth() + 1;
  const _daysInMonth = new Date(_y, _m, 0).getDate();
  const _monthStart = `${_y}-${String(_m).padStart(2, "0")}-01`;
  const _monthEnd = `${_y}-${String(_m).padStart(2, "0")}-${String(_daysInMonth).padStart(2, "0")}`;
  const _leaveDaysSet = new Set<string>();
  for (const l of leaves) {
    if (l.status !== "approved") continue;
    const s = l.startDate > _monthStart ? l.startDate : _monthStart;
    const e = l.endDate < _monthEnd ? l.endDate : _monthEnd;
    if (s > e) continue;
    const sd = new Date(s), ed = new Date(e);
    for (let d = new Date(sd); d <= ed; d.setDate(d.getDate() + 1)) {
      _leaveDaysSet.add(d.toISOString().slice(0, 10));
    }
  }
  const leaveThisMonth = { used: _leaveDaysSet.size, cap: 2 };

  const [internalNotes] = await db.select().from(staffInternalNotesTable)
    .where(eq(staffInternalNotesTable.staffId, staffId));

  const estimate = await computeMonthEstimate(staffId, thisMonth, thisYear, { includeForecast });

  // Task #504: gắn overtime vào estimate (cộng vào total cho realtime/draft; với paid_payroll
  // số đã chốt nằm trong netSalary nên KHÔNG cộng thêm — chỉ surface snapshot từ payroll items).
  let overtime: { hours: number; rate: number; pay: number } = { hours: 0, rate: 30000, pay: 0 };
  if (estimate) {
    if (estimate.source === "paid_payroll" || estimate.source === "draft_payroll") {
      const pr = await pool.query(
        `SELECT items FROM payrolls WHERE staff_id=$1 AND month=$2 AND year=$3 LIMIT 1`,
        [staffId, thisMonth, thisYear]
      );
      const items = (pr.rows[0] as { items?: Record<string, unknown> } | undefined)?.items as Record<string, unknown> | undefined;
      const snap = items?.overtime as { hours?: number; rate?: number; pay?: number } | undefined;
      if (snap) {
        overtime = {
          hours: Number(snap.hours ?? 0),
          rate: Number(snap.rate ?? 30000),
          pay: Number(snap.pay ?? 0),
        };
      }
    } else {
      // realtime: query rule + OT logs trực tiếp
      const ruleR = await pool.query(`SELECT overtime_rate_per_hour FROM attendance_rules WHERE is_active=1 LIMIT 1`);
      const otRate = parseFloat(String((ruleR.rows[0] as { overtime_rate_per_hour?: string })?.overtime_rate_per_hour ?? "30000"));
      const monthStr = `${thisYear}-${String(thisMonth).padStart(2, "0")}`;
      const otR = await pool.query(
        `SELECT type,
                to_char(created_at + interval '7 hours', 'HH24:MI') as t,
                to_char(created_at + interval '7 hours', 'YYYY-MM-DD') as d
           FROM attendance_logs
          WHERE staff_id = $1
            AND to_char(created_at + interval '7 hours', 'YYYY-MM') = $2
            AND type IN ('overtime_check_in', 'overtime_check_out')
          ORDER BY created_at`,
        [staffId, monthStr]
      );
      const otLogs: OvertimeLog[] = (otR.rows as { type: string; t: string; d: string }[])
        .map(r => ({ date: r.d, type: r.type, time: r.t }));
      const otRes = computeOvertimeForMonth(otLogs, otRate);
      overtime = { hours: otRes.hours, rate: otRes.rate, pay: otRes.pay };
      // Cộng vào total realtime
      (estimate as unknown as Record<string, unknown>).total = estimate.total + otRes.pay;
    }
    (estimate as unknown as Record<string, unknown>).overtime = overtime;
  }

  return {
    staff: fmtStaff(member as unknown as Record<string, unknown>),
    monthStats, monthJobs, todayJobs, jobHistory: allJobs,
    earnings: {
      thisMonth: monthEarnings.reduce((s, e) => s + parseFloat(e.rate), 0),
      today: todayEarnings.reduce((s, e) => s + parseFloat(e.rate), 0),
      total: earnings.reduce((s, e) => s + parseFloat(e.rate), 0),
      records: monthEarnings.map(e => ({ ...e, rate: parseFloat(e.rate) })),
      estimate,
    },
    rates: rates.map(r => ({ ...r, rate: r.rate ? parseFloat(r.rate) : null })),
    leaveRequests: leaves,
    leaveThisMonth,
    internalNotes: isAdminCaller ? (internalNotes || null) : null,
  };
}

const fmtStaff = (s: Record<string, unknown>) => ({
  ...s,
  salary: s.salary ? parseFloat(s.salary as string) : null,
  baseSalaryAmount: s.baseSalaryAmount ? parseFloat(s.baseSalaryAmount as string) : 0,
  commissionRate: s.commissionRate ? parseFloat(s.commissionRate as string) : 0,
  isActive: Boolean(s.isActive),
  roles: Array.isArray(s.roles) ? s.roles : (s.roles ? [s.roles] : []),
});

// ── /me: Hồ sơ cá nhân (nhân viên tự xem chính mình) ─────────────────────────
router.get("/staff/me", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const isAdmin = await isCallerAdmin(callerId);
  const data = await buildProfileData(callerId, isAdmin, isAdmin);
  if (!data) return res.status(404).json({ error: "Không tìm thấy hồ sơ" });
  res.json(data);
});

// Alias kept for backward compat with existing frontend
router.get("/staff/me/profile", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const isAdmin = await isCallerAdmin(callerId);
  const data = await buildProfileData(callerId, isAdmin, isAdmin);
  if (!data) return res.status(404).json({ error: "Không tìm thấy hồ sơ" });
  res.json(data);
});

// ── /me/metrics: Số liệu theo tháng ──────────────────────────────────────────
router.get("/staff/me/metrics", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const now = new Date();
  const month = parseInt(String(req.query.month)) || now.getMonth() + 1;
  const year = parseInt(String(req.query.year)) || now.getFullYear();
  const monthStr = `${year}-${String(month).padStart(2, "0")}`;

  const earnings = await db.select().from(staffJobEarningsTable)
    .where(eq(staffJobEarningsTable.staffId, callerId));
  const monthEarnings = earnings.filter(e => e.month === month && e.year === year);

  // Earnings by week within the month (week 1..5)
  const byWeek: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  monthEarnings.forEach(e => {
    const day = parseInt((e.earnedDate || "").slice(8, 10)) || 1;
    const week = Math.ceil(day / 7);
    byWeek[Math.min(week, 5)] = (byWeek[Math.min(week, 5)] || 0) + parseFloat(e.rate);
  });

  const startDate = `${monthStr}-01`;
  const endDate = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const jobsR = await pool.query(`
    SELECT b.id, b.status, b.shoot_date, b.assigned_staff, b.items FROM bookings b
    WHERE shoot_date >= $1::date AND shoot_date < $2::date
      AND (b.assigned_staff IS NOT NULL OR b.items IS NOT NULL)
  `, [startDate, endDate]);

  const jobs = (jobsR.rows as Array<Record<string, unknown>>).filter(r => hasStaffInBooking(r, callerId));
  // Date-based completion: shoot_date <= today → completed; > today → pending.
  // Đồng bộ với monthStats trong buildProfileData() và showEarnings của
  // salary-estimate (cùng dùng shoot_date làm trigger hoàn thành).
  const todayStr = new Date().toISOString().slice(0, 10);
  const toDate = (v: unknown): string => {
    if (!v) return "";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v);
    return s.length >= 10 ? s.slice(0, 10) : s;
  };
  res.json({
    month, year,
    jobs: {
      total: jobs.length,
      completed: jobs.filter(j => { const d = toDate(j.shoot_date); return d && d <= todayStr; }).length,
      pending:   jobs.filter(j => { const d = toDate(j.shoot_date); return d && d >  todayStr; }).length,
      inProgress: 0,
      cancelled: 0,
    },
    earnings: {
      thisMonth: monthEarnings.reduce((s, e) => s + parseFloat(e.rate), 0),
      byWeek: Object.entries(byWeek).map(([w, v]) => ({ week: `T${w}`, amount: v })),
    },
  });
});

// ── /me/kpi: KPI targets vs actual ────────────────────────────────────────────
router.get("/staff/me/kpi", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const now = new Date();
  const month = parseInt(String(req.query.month)) || now.getMonth() + 1;
  const year = parseInt(String(req.query.year)) || now.getFullYear();
  const monthStr = `${year}-${String(month).padStart(2, "0")}`;

  const kpiConfigs = await db.select().from(staffKpiConfigTable)
    .where(eq(staffKpiConfigTable.staffId, callerId));

  const earnings = await db.select().from(staffJobEarningsTable)
    .where(eq(staffJobEarningsTable.staffId, callerId));
  const monthEarnings = earnings.filter(e => e.month === month && e.year === year);

  const startDate2 = `${monthStr}-01`;
  const endDate2 = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const jobsR = await pool.query(`
    SELECT b.id, b.status, b.assigned_staff, b.items FROM bookings b
    WHERE shoot_date >= $1::date AND shoot_date < $2::date
      AND (b.assigned_staff IS NOT NULL OR b.items IS NOT NULL)
  `, [startDate2, endDate2]);

  const STATUS_MAP: Record<string, string> = {
    completed: "completed", hoan_thanh: "completed", done: "completed",
  };
  const completedJobs = (jobsR.rows as Array<Record<string, unknown>>)
    .filter(r => hasStaffInBooking(r, callerId))
    .filter(j => STATUS_MAP[String(j.status)?.toLowerCase()]);
  const totalEarnings = monthEarnings.reduce((s, e) => s + parseFloat(e.rate), 0);

  const metrics: Array<{ metric: string; target: number; actual: number; score: number; status: "green" | "yellow" | "red"; bonusAmount: number }> = kpiConfigs
    .filter(k => k.isActive)
    .map(k => {
      const target = parseFloat(k.targetValue);
      const actual = k.metric === "jobs_count" ? completedJobs.length
        : k.metric === "earnings" ? totalEarnings : 0;
      const ratio = target > 0 ? Math.min(actual / target, 1) : 0;
      const score = Math.round(ratio * 100);
      const status = score >= 80 ? "green" : score >= 50 ? "yellow" : "red";
      return { metric: k.metric, target, actual, score, status, bonusAmount: parseFloat(k.bonusAmount) };
    });

  const overallScore = metrics.length > 0
    ? Math.round(metrics.reduce((s, m) => s + m.score, 0) / metrics.length)
    : 0;
  const overallStatus: "green" | "yellow" | "red" = overallScore >= 80 ? "green" : overallScore >= 50 ? "yellow" : "red";

  res.json({ month, year, metrics, overallScore, overallStatus });
});

// ── PATCH /staff/me: Cập nhật hồ sơ bản thân (avatar, email, phone, name) ────
router.patch("/staff/me", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const { avatar, email, phone, name } = req.body as {
    avatar?: string; email?: string; phone?: string; name?: string;
  };
  const update: Record<string, unknown> = {};
  if (avatar !== undefined) update.avatar = avatar || null;
  if (email !== undefined) update.email = email || null;
  if (phone !== undefined) update.phone = phone || null;
  if (name !== undefined) update.name = name || null;

  if (Object.keys(update).length === 0) return res.status(400).json({ error: "Không có dữ liệu để cập nhật" });

  const [member] = await db.update(staffTable).set(update).where(eq(staffTable.id, callerId)).returning();
  if (!member) return res.status(404).json({ error: "Không tìm thấy nhân viên" });

  const { passwordHash: _ph, ...safe } = member as typeof member & { passwordHash?: unknown };
  void _ph;
  res.json(safe);
});

// ── /me: Đổi mật khẩu ────────────────────────────────────────────────────────
router.patch("/staff/me/password", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: "Mật khẩu mới phải có ít nhất 4 ký tự" });

  const r = await pool.query(`SELECT password_hash FROM staff WHERE id = $1`, [callerId]);
  const existing = (r.rows[0] as Record<string, unknown>)?.password_hash as string | null;

  // Always require currentPassword when a hash exists — never bypass verification
  if (existing) {
    if (!currentPassword) return res.status(400).json({ error: "Vui lòng nhập mật khẩu hiện tại" });
    const bcrypt = await import("bcryptjs");
    const matches = await bcrypt.compare(currentPassword, existing);
    if (!matches) return res.status(401).json({ error: "Mật khẩu hiện tại không đúng" });
  }

  const bcrypt = await import("bcryptjs");
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query(`UPDATE staff SET password_hash = $1 WHERE id = $2`, [hash, callerId]);
  res.json({ success: true });
});

// ── Lấy toàn bộ dữ liệu hồ sơ nhân viên ──────────────────────────────────────
// Row-level security: chỉ admin hoặc chính nhân viên đó được xem
router.get("/staff/:id/profile", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const staffId = parseInt(req.params.id);
  if (isNaN(staffId)) return res.status(400).json({ error: "ID không hợp lệ" });

  // Check if caller is admin or viewing their own profile
  const callerR = await pool.query(`SELECT role FROM staff WHERE id = $1`, [callerId]);
  const callerRole = (callerR.rows[0] as { role?: string })?.role;
  if (callerRole !== "admin" && callerId !== staffId) {
    return res.status(403).json({ error: "Không có quyền xem hồ sơ này" });
  }

  // ── Dùng chung buildProfileData() để đảm bảo monthStats/jobHistory/estimate đồng bộ ──
  // Forecast cuối tháng CHỈ trả về khi caller là admin (gate ở API).
  const monthQ = req.query.month ? parseInt(String(req.query.month)) : undefined;
  const yearQ = req.query.year ? parseInt(String(req.query.year)) : undefined;
  const data = await buildProfileData(staffId, callerRole === "admin", callerRole === "admin", monthQ, yearQ);
  if (!data) return res.status(404).json({ error: "Không tìm thấy nhân viên" });
  res.json({ ...data, selectedMonth: monthQ ?? (new Date().getMonth() + 1), selectedYear: yearQ ?? new Date().getFullYear() });
});

// ── Helper: check if caller is admin ──────────────────────────────────────────
async function isCallerAdmin(callerId: number): Promise<boolean> {
  const r = await pool.query(`SELECT role FROM staff WHERE id = $1`, [callerId]);
  return (r.rows[0] as { role?: string })?.role === "admin";
}

// ── Đơn xin nghỉ ──────────────────────────────────────────────────────────────
// GET: admin or self can view leave requests
router.get("/staff/:id/leave-requests", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const staffId = parseInt(req.params.id);
  if (!(await isCallerAdmin(callerId)) && callerId !== staffId) {
    return res.status(403).json({ error: "Không có quyền xem đơn của người khác" });
  }
  const leaves = await db.select().from(staffLeaveRequestsTable)
    .where(eq(staffLeaveRequestsTable.staffId, staffId))
    .orderBy(desc(staffLeaveRequestsTable.createdAt));
  res.json(leaves);
});

// POST: staff can only submit their own leave request
router.post("/staff/:id/leave-requests", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const staffId = parseInt(req.params.id);
  if (!(await isCallerAdmin(callerId)) && callerId !== staffId) {
    return res.status(403).json({ error: "Chỉ được nộp đơn xin nghỉ của chính mình" });
  }
  const { startDate, endDate, reason, notes } = req.body;
  if (!startDate || !endDate || !reason?.trim()) {
    return res.status(400).json({ error: "Vui lòng điền đầy đủ thông tin" });
  }
  const [created] = await db.insert(staffLeaveRequestsTable)
    .values({ staffId, startDate, endDate, reason, notes: notes || null })
    .returning();
  res.status(201).json(created);
});

// ── Calendar overlay: range GET ───────────────────────────────────────────────
// GET /api/leave-requests?from=YYYY-MM-DD&to=YYYY-MM-DD
// Trả về đơn (mọi trạng thái) overlap khoảng ngày, join staff để có staffName.
// Admin: tất cả; staff thường: chỉ chính mình.
router.get("/leave-requests", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: "Thiếu from/to (YYYY-MM-DD)" });
  }
  const admin = await isCallerAdmin(callerId);
  // overlap: start_date <= to AND end_date >= from
  const conds = [
    lte(staffLeaveRequestsTable.startDate, to),
    gte(staffLeaveRequestsTable.endDate, from),
  ];
  if (!admin) conds.push(eq(staffLeaveRequestsTable.staffId, callerId));

  const rows = await db.select({
    id: staffLeaveRequestsTable.id,
    staffId: staffLeaveRequestsTable.staffId,
    staffName: staffTable.name,
    startDate: staffLeaveRequestsTable.startDate,
    endDate: staffLeaveRequestsTable.endDate,
    reason: staffLeaveRequestsTable.reason,
    status: staffLeaveRequestsTable.status,
    approvedByName: staffLeaveRequestsTable.approvedByName,
    reviewedAt: staffLeaveRequestsTable.reviewedAt,
    notes: staffLeaveRequestsTable.notes,
    leaveType: staffLeaveRequestsTable.leaveType,
    session: staffLeaveRequestsTable.session,
    startTime: staffLeaveRequestsTable.startTime,
    endTime: staffLeaveRequestsTable.endTime,
    createdAt: staffLeaveRequestsTable.createdAt,
  })
    .from(staffLeaveRequestsTable)
    .leftJoin(staffTable, eq(staffTable.id, staffLeaveRequestsTable.staffId))
    .where(and(...conds))
    .orderBy(desc(staffLeaveRequestsTable.createdAt));
  res.json(rows);
});

// ── POST mới: linh hoạt (cho phép admin tạo thay cho NV khác) ─────────────────
router.post("/leave-requests", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const admin = await isCallerAdmin(callerId);
  const body = req.body || {};
  const staffId = admin ? (Number(body.staffId) || callerId) : callerId;
  const { startDate, endDate, reason } = body;
  const notes = body.notes ?? null;
  const leaveType = body.leaveType || "off";
  const session = body.session || "full_day";
  const startTime = body.startTime || null;
  const endTime = body.endTime || null;

  if (!startDate || !endDate) {
    return res.status(400).json({ error: "Thiếu ngày bắt đầu/kết thúc" });
  }
  if (!reason || String(reason).trim().length < 5) {
    return res.status(400).json({ error: "Lý do phải ≥ 5 ký tự" });
  }
  if (session === "custom" && (!startTime || !endTime)) {
    return res.status(400).json({ error: "Buổi tuỳ chọn yêu cầu giờ bắt đầu và kết thúc" });
  }
  const [created] = await db.insert(staffLeaveRequestsTable)
    .values({
      staffId, startDate, endDate, reason: String(reason).trim(), notes,
      leaveType, session, startTime, endTime,
    })
    .returning();
  res.status(201).json(created);
});

// ── PUT: admin duyệt/từ chối/huỷ; owner-staff được huỷ đơn pending của mình ──
router.put("/leave-requests/:id", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "ID không hợp lệ" });

  const [existing] = await db.select().from(staffLeaveRequestsTable)
    .where(eq(staffLeaveRequestsTable.id, id));
  if (!existing) return res.status(404).json({ error: "Không tìm thấy đơn" });

  const admin = await isCallerAdmin(callerId);
  const { status, approvedByName, notes } = req.body || {};

  if (!admin) {
    // owner-staff: chỉ cho cancelled khi pending
    if (existing.staffId !== callerId) {
      return res.status(403).json({ error: "Không có quyền" });
    }
    if (status !== "cancelled") {
      return res.status(403).json({ error: "Chỉ admin mới có thể duyệt/từ chối" });
    }
    if (existing.status !== "pending") {
      return res.status(400).json({ error: "Chỉ có thể huỷ đơn đang chờ duyệt" });
    }
  } else {
    if (status === "rejected") {
      if (!notes || String(notes).trim().length < 5) {
        return res.status(400).json({ error: "Lý do từ chối phải ≥ 5 ký tự" });
      }
    }
  }

  const update: Record<string, unknown> = {};
  if (status) update.status = status;
  if (approvedByName !== undefined) update.approvedByName = approvedByName;
  if (notes !== undefined) update.notes = notes;
  if (status && status !== "pending") update.reviewedAt = new Date();

  const [updated] = await db.update(staffLeaveRequestsTable)
    .set(update).where(eq(staffLeaveRequestsTable.id, id)).returning();
  res.json(updated);
});

// DELETE /api/leave-requests/:id — xóa thật đơn xin nghỉ (chỉ admin/owner)
router.delete("/leave-requests/:id", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "ID không hợp lệ" });

  // Chỉ Admin và Owner được xóa đơn; nhân viên không được phép.
  const cr = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = cr.rows[0] as { role?: string; roles?: unknown } | undefined;
  const callerRoles = Array.isArray(caller?.roles) ? (caller!.roles as string[]) : [];
  const privileged =
    caller?.role === "admin" || caller?.role === "owner" ||
    callerRoles.includes("admin") || callerRoles.includes("owner");
  if (!privileged) return res.status(403).json({ error: "Chỉ Admin/Owner mới có thể xóa đơn xin nghỉ" });

  const [existing] = await db.select().from(staffLeaveRequestsTable)
    .where(eq(staffLeaveRequestsTable.id, id));
  if (!existing) return res.status(404).json({ error: "Không tìm thấy đơn" });

  await db.delete(staffLeaveRequestsTable).where(eq(staffLeaveRequestsTable.id, id));
  res.json({ ok: true, id });
});

// ── Ghi chú nội bộ: admin-only ────────────────────────────────────────────────
router.get("/staff/:id/internal-notes", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  if (!(await isCallerAdmin(callerId))) {
    return res.status(403).json({ error: "Chỉ admin mới có thể xem ghi chú nội bộ" });
  }
  const staffId = parseInt(req.params.id);
  const [notes] = await db.select().from(staffInternalNotesTable)
    .where(eq(staffInternalNotesTable.staffId, staffId));
  res.json(notes || null);
});

router.put("/staff/:id/internal-notes", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  if (!(await isCallerAdmin(callerId))) {
    return res.status(403).json({ error: "Chỉ admin mới có thể cập nhật ghi chú nội bộ" });
  }
  const staffId = parseInt(req.params.id);
  const { skillsStrong, workNotes, internalRating, generalNotes } = req.body;
  const [existing] = await db.select().from(staffInternalNotesTable)
    .where(eq(staffInternalNotesTable.staffId, staffId));

  const data = {
    skillsStrong: skillsStrong ?? null,
    workNotes: workNotes ?? null,
    internalRating: internalRating ?? null,
    generalNotes: generalNotes ?? null,
    updatedAt: new Date(),
  };

  let result;
  if (existing) {
    [result] = await db.update(staffInternalNotesTable)
      .set(data).where(eq(staffInternalNotesTable.staffId, staffId)).returning();
  } else {
    [result] = await db.insert(staffInternalNotesTable)
      .values({ staffId, ...data }).returning();
  }
  res.json(result);
});

// ── Lịch sử lương theo nhân viên ─────────────────────────────────────────────
router.get("/staff/:id/salary-history", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const staffId = parseInt(req.params.id);
  if (isNaN(staffId)) return res.status(400).json({ error: "ID không hợp lệ" });
  const admin = await isCallerAdmin(callerId);
  if (!admin && callerId !== staffId) return res.status(403).json({ error: "Không có quyền" });

  const limit = Math.min(parseInt(String(req.query.limit ?? "24")) || 24, 36);
  const payrolls = await db.select().from(payrollsTable)
    .where(eq(payrollsTable.staffId, staffId))
    .orderBy(desc(payrollsTable.year), desc(payrollsTable.month));

  const rows = [];
  for (const pr of payrolls.slice(0, limit)) {
    const items = (pr.items ?? {}) as Record<string, unknown>;
    rows.push({
      month: pr.month,
      year: pr.year,
      monthLabel: `${String(pr.month).padStart(2, "0")}/${pr.year}`,
      baseSalary: parseFloat(String(pr.baseSalary)),
      showBonus: parseFloat(String(pr.showBonus)),
      bonus: parseFloat(String(pr.bonus)),
      penalty: Number(items.penalty ?? 0),
      deductions: parseFloat(String(pr.deductions)),
      advance: parseFloat(String(pr.advance)),
      netSalary: parseFloat(String(pr.netSalary)),
      status: pr.status,
      payrollId: pr.id,
      isLocked: pr.status === "paid",
      paidAt: (items.snapshot as { lockedAt?: string } | undefined)?.lockedAt ?? null,
    });
  }

  // Tháng có earnings nhưng chưa có payroll → tính tạm tính
  const earnMonths = await pool.query(
    `SELECT DISTINCT year, month FROM staff_job_earnings WHERE staff_id=$1 ORDER BY year DESC, month DESC LIMIT $2`,
    [staffId, limit]
  );
  const existingKeys = new Set(rows.map(r => `${r.year}-${r.month}`));
  for (const em of earnMonths.rows as Array<{ year: number; month: number }>) {
    const key = `${em.year}-${em.month}`;
    if (existingKeys.has(key)) continue;
    const est = await computeMonthEstimate(staffId, em.month, em.year);
    if (!est || est.total <= 0) continue;
    rows.push({
      month: em.month,
      year: em.year,
      monthLabel: `${String(em.month).padStart(2, "0")}/${em.year}`,
      baseSalary: est.baseSalaryAccrued,
      showBonus: est.showEarnings,
      bonus: est.bonus,
      penalty: est.penalty,
      deductions: est.penalty + est.leaveDeduction,
      advance: est.advance,
      netSalary: est.total,
      status: "estimate",
      payrollId: null,
      isLocked: false,
      paidAt: null,
    });
  }
  rows.sort((a, b) => b.year - a.year || b.month - a.month);
  res.json(rows.slice(0, limit));
});

// ── Xu hướng thu nhập N tháng ───────────────────────────────────────────────
router.get("/staff/:id/salary-trend", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const staffId = parseInt(req.params.id);
  if (isNaN(staffId)) return res.status(400).json({ error: "ID không hợp lệ" });
  const admin = await isCallerAdmin(callerId);
  if (!admin && callerId !== staffId) return res.status(403).json({ error: "Không có quyền" });

  const months = Math.min(parseInt(String(req.query.months ?? "12")) || 12, 24);
  const now = new Date();
  const points = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = d.getMonth() + 1;
    const y = d.getFullYear();
    const [pr] = await db.select().from(payrollsTable).where(and(
      eq(payrollsTable.staffId, staffId),
      eq(payrollsTable.month, m),
      eq(payrollsTable.year, y),
    ));
    let total = 0;
    let source: string = "estimate";
    if (pr?.status === "paid") {
      total = parseFloat(String(pr.netSalary));
      source = "paid";
    } else if (pr) {
      total = parseFloat(String(pr.netSalary));
      source = pr.status;
    } else {
      const est = await computeMonthEstimate(staffId, m, y);
      total = est?.total ?? 0;
    }
    points.push({
      month: m, year: y,
      label: d.toLocaleDateString("vi-VN", { month: "short", year: "2-digit" }),
      total, source,
    });
  }
  const cur = points[points.length - 1]?.total ?? 0;
  const prev = points[points.length - 2]?.total ?? 0;
  const changePct = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0);
  res.json({ points, currentMonth: cur, previousMonth: prev, changePct });
});

// ── Chi tiết snapshot lương đã chốt ─────────────────────────────────────────
router.get("/staff/:id/salary-snapshot", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const staffId = parseInt(req.params.id);
  const month = parseInt(String(req.query.month));
  const year = parseInt(String(req.query.year));
  if (isNaN(staffId) || !month || !year) return res.status(400).json({ error: "Thiếu tham số" });
  const admin = await isCallerAdmin(callerId);
  if (!admin && callerId !== staffId) return res.status(403).json({ error: "Không có quyền" });

  const [pr] = await db.select().from(payrollsTable).where(and(
    eq(payrollsTable.staffId, staffId),
    eq(payrollsTable.month, month),
    eq(payrollsTable.year, year),
    eq(payrollsTable.status, "paid"),
  ));
  if (!pr) return res.status(404).json({ error: "Chưa có lương đã chốt cho tháng này" });
  const items = (pr.items ?? {}) as Record<string, unknown>;
  res.json({ payroll: pr, snapshot: items.snapshot ?? null, items });
});


export default router;
