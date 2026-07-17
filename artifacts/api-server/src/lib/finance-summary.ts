import { pool } from "@workspace/db";
import { paymentNotOnEmptyParentSql } from "./parent-contract";
// GĐ1c (quy tắc ②③ chủ chốt 14/07): chi phí studio đọc từ FINANCIAL ENGINE —
// chỉ approved/paid, LOẠI cost_class 'personal' (chi tiêu cá nhân không phải chi
// phí studio) và 'loan_principal' (trả gốc vay là dòng tiền, không phải chi phí).
// PR #102: công nợ cũng đọc thẳng engineSystemDebt (phân bổ tiền gia đình LIVE)
// — hết bản copy công thức nợ riêng trong file này.
import { engineCashOut, engineSystemDebt } from "./finance/financial-engine";

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
  const [incomeRow, cashOut, customerDebt] = await Promise.all([
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
    // GĐ1c: chi phí + chi cố định qua FINANCIAL ENGINE (quy tắc ②③) — trước đây
    // đếm MỌI status + mọi cost_class nên chi tiêu cá nhân (đi nhậu, làm răng...)
    // và khoản chưa duyệt bị trừ nhầm vào lợi nhuận studio.
    engineCashOut(from, to),
    // PR #102: nợ khách = engineSystemDebt (nợ sống ① trên "đã thu PHÂN BỔ" theo
    // gia đình đơn) — Dashboard/Copilot/Khách hàng cùng một con số engine.
    engineSystemDebt(),
  ]);

  const totalIncome = parseFloat((incomeRow.rows[0] as { total?: string } | undefined)?.total ?? "0");
  const directExpense = cashOut.studioExpense;
  const fixedCostMonthly = cashOut.fixedMonthly;
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
