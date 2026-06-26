import { db, pool } from "@workspace/db";
import {
  payrollsTable, staffTable, staffJobEarningsTable,
  staffCastRatesTable, staffRatePricesTable,
} from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { computeMonthEstimate, type ShowItem } from "./salary-estimate";
import { computeOvertimeForMonth, type OvertimeLog } from "./overtime";

export interface PayrollSnapshotMeta {
  lockedAt: string;
  paidByStaffId: number;
  paidByName: string;
  showItems: ShowItem[];
  castRatesAtLock: Array<{ role: string; packageId: number; amount: number | null; rateType: string }>;
  ratePricesAtLock: Array<{ role: string; taskKey: string; taskName: string; rate: number | null; rateType: string }>;
}

async function loadAttendanceAdjustments(staffId: number, month: number, year: number) {
  const monthStr = `${year}-${String(month).padStart(2, "0")}`;
  const adjR = await pool.query(
    `SELECT type, amount FROM attendance_adjustments
     WHERE staff_id = $1 AND to_char(date::timestamp, 'YYYY-MM') = $2`,
    [staffId, monthStr]
  );
  let bonus = 0, penalty = 0, advance = 0;
  for (const a of adjR.rows as Array<{ type: string; amount: string }>) {
    const v = parseFloat(a.amount);
    if (a.type === "bonus") bonus += v;
    else if (a.type === "penalty") penalty += v;
    else if (a.type === "advance") advance += v;
  }
  return { bonus, penalty, advance };
}

async function loadOvertime(staffId: number, month: number, year: number) {
  const monthStr = `${year}-${String(month).padStart(2, "0")}`;
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
    [staffId, monthStr]
  );
  const otLogs: OvertimeLog[] = (otLogsR.rows as { type: string; t: string; d: string }[])
    .map(r => ({ date: r.d, type: r.type, time: r.t }));
  return computeOvertimeForMonth(otLogs, otRate);
}

/** Chốt thanh toán lương — snapshot toàn bộ, khóa tháng đó. */
export async function finalizePayrollPayment(
  staffId: number, month: number, year: number,
  paidByStaffId: number, paidByName: string,
) {
  const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, staffId));
  if (!staff) throw new Error("Không tìm thấy nhân viên");

  const [existing] = await db.select().from(payrollsTable).where(and(
    eq(payrollsTable.staffId, staffId),
    eq(payrollsTable.month, month),
    eq(payrollsTable.year, year),
  ));
  if (existing?.status === "paid") {
    throw new Error("Lương tháng này đã được chốt thanh toán.");
  }

  const estimate = await computeMonthEstimate(staffId, month, year, { includeForecast: false });
  if (!estimate) throw new Error("Không tính được lương tháng này");

  const adj = await loadAttendanceAdjustments(staffId, month, year);
  const ot = await loadOvertime(staffId, month, year);
  const bonus = existing ? parseFloat(String(existing.bonus)) || adj.bonus : adj.bonus;
  const advance = existing ? parseFloat(String(existing.advance)) || adj.advance : adj.advance;
  const penalty = adj.penalty;
  const leaveDeduction = estimate.leaveDeduction;
  // MẢNG-5: chốt giữa tháng VẪN TRẢ ĐỦ lương cứng (đồng bộ /payrolls/generate dùng
  // baseSalary đủ tháng). KHÔNG dùng baseSalaryAccrued (pro-rate tới hôm nay) — nếu không,
  // chốt ngày 15 sẽ trả thiếu ~nửa lương cứng so với nút "Tạo bảng lương".
  const baseSalaryLocked = estimate.baseSalary;
  const showBonus = estimate.showEarnings;
  const netSalary = baseSalaryLocked + showBonus + bonus + ot.pay - penalty - leaveDeduction - advance;

  const castRates = await db.select().from(staffCastRatesTable).where(eq(staffCastRatesTable.staffId, staffId));
  const ratePrices = await db.select().from(staffRatePricesTable).where(eq(staffRatePricesTable.staffId, staffId));

  const snapshot: PayrollSnapshotMeta = {
    lockedAt: new Date().toISOString(),
    paidByStaffId,
    paidByName,
    showItems: estimate.showItems,
    castRatesAtLock: castRates.map(r => ({
      role: r.role,
      packageId: r.packageId,
      amount: r.amount != null ? parseFloat(String(r.amount)) : null,
      rateType: r.rateType,
    })),
    ratePricesAtLock: ratePrices.map(r => ({
      role: r.role,
      taskKey: r.taskKey,
      taskName: r.taskName,
      rate: r.rate != null ? parseFloat(String(r.rate)) : null,
      rateType: r.rateType,
    })),
  };

  const items = {
    snapshot,
    baseSalary: baseSalaryLocked,
    totalEarnings: showBonus,
    showBonus,
    bonus,
    penalty,
    advance,
    leaveDeduction,
    leaveDaysUsed: estimate.leaveDaysUsed,
    leaveDaysCap: estimate.leaveDaysCap,
    daysInMonth: estimate.daysInMonth,
    daysAccrued: estimate.daysAccrued,
    overtime: { hours: ot.hours, rate: ot.rate, pay: ot.pay, byDate: ot.byDate },
    estimateTotal: netSalary,
  };

  let payrollId: number;
  if (existing) {
    const [updated] = await db.update(payrollsTable).set({
      baseSalary: String(baseSalaryLocked),
      showBonus: String(showBonus),
      bonus: String(bonus),
      deductions: String(penalty + leaveDeduction),
      advance: String(advance),
      netSalary: String(netSalary),
      items,
      status: "paid",
      notes: existing.notes,
    }).where(eq(payrollsTable.id, existing.id)).returning();
    payrollId = updated.id;
  } else {
    const [created] = await db.insert(payrollsTable).values({
      staffId, month, year,
      baseSalary: String(baseSalaryLocked),
      showBonus: String(showBonus),
      commission: "0",
      bonus: String(bonus),
      deductions: String(penalty + leaveDeduction),
      advance: String(advance),
      netSalary: String(netSalary),
      items,
      status: "paid",
    }).returning();
    payrollId = created.id;
  }

  const earnings = await db.select().from(staffJobEarningsTable).where(and(
    eq(staffJobEarningsTable.staffId, staffId),
    eq(staffJobEarningsTable.month, month),
    eq(staffJobEarningsTable.year, year),
  ));
  if (earnings.length > 0) {
    await db.update(staffJobEarningsTable)
      .set({ status: "paid", payrollId })
      .where(inArray(staffJobEarningsTable.id, earnings.map(e => e.id)));
  }

  const [payroll] = await db.select().from(payrollsTable).where(eq(payrollsTable.id, payrollId));
  return payroll;
}
