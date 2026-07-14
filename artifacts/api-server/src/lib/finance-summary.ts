import { pool } from "@workspace/db";
import { revenueCountableSql } from "./booking-money";
import { paymentNotOnEmptyParentSql } from "./parent-contract";

/**
 * Tài chính "thực tế" dùng CHUNG cho màn Tổng quan tài chính (GET /dashboard/simple)
 * và Studio Copilot — 4 query giữ NGUYÊN VĂN công thức của /dashboard/simple để hai
 * nơi luôn ra cùng một con số (sự cố 14/07: Copilot phồng 2.000.000 đ vì thiếu lớp
 * loại refund + phiếu thu trên đơn CHA rỗng). Mọi thay đổi công thức chỉ sửa ở đây.
 */

export type SimpleFinance = {
  from: string;
  to: string;
  /** Đã thu: phiếu thu thật (loại refund, loại voided, loại phiếu trên đơn cha rỗng). */
  totalIncome: number;
  /** Chi trực tiếp từ bảng expenses theo expense_date. */
  directExpense: number;
  /** Nợ khách toàn hệ thống trên tập đơn countable (net − đã thu, không âm). */
  customerDebt: number;
  /** Tổng chi phí cố định đang active (theo tháng). */
  fixedCostMonthly: number;
  totalSpent: number;
  realProfit: number;
  breakeven: { status: "over" | "under"; delta: number };
};

export async function getSimpleFinance(from: string, to: string): Promise<SimpleFinance> {
  const [incomeRow, expenseRow, debtRow, fixedRow] = await Promise.all([
    pool.query(
      `
        SELECT COALESCE(SUM(amount::numeric), 0) AS total
        FROM payments
        WHERE paid_at >= $1::date
          AND paid_at < ($2::date + INTERVAL '1 day')
          AND payment_type != 'refund'
          AND COALESCE(status, 'active') != 'voided'
          AND ${paymentNotOnEmptyParentSql("payments")}
      `,
      [from, to],
    ),
    pool.query(
      `
        SELECT COALESCE(SUM(amount::numeric), 0) AS total
        FROM expenses
        WHERE expense_date >= $1::date
          AND expense_date <= $2::date
      `,
      [from, to],
    ),
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
  ]);

  const totalIncome = parseFloat((incomeRow.rows[0] as { total?: string } | undefined)?.total ?? "0");
  const directExpense = parseFloat((expenseRow.rows[0] as { total?: string } | undefined)?.total ?? "0");
  const customerDebt = parseFloat((debtRow.rows[0] as { total?: string } | undefined)?.total ?? "0");
  const fixedCostMonthly = parseFloat((fixedRow.rows[0] as { total?: string } | undefined)?.total ?? "0");
  const totalSpent = directExpense + fixedCostMonthly;
  const realProfit = totalIncome - totalSpent;

  return {
    from,
    to,
    totalIncome,
    directExpense,
    customerDebt,
    fixedCostMonthly,
    totalSpent,
    realProfit,
    breakeven: {
      status: realProfit >= 0 ? "over" : "under",
      delta: Math.abs(realProfit),
    },
  };
}
