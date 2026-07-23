/**
 * top-debtors.ts — "Top khách còn nợ" gom theo KHÁCH từ engineAllocationSnapshot.
 *
 * KHÔNG viết lại công thức nợ: mỗi dòng booking đã có `debt` (nợ sống quy tắc ①)
 * do engine tính; đây chỉ GỘP per-khách + sắp xếp — cùng MỘT source of truth với
 * màn Công nợ / Dashboard. (Trước đây logic này nằm inline trong dashboard.ts.)
 */
import { engineAllocationSnapshot } from "./financial-engine.js";

export type TopDebtor = {
  customerId: number | null;
  customerName: string;
  bookingCount: number;
  owed: number;
};

export type TopDebtorsResult = {
  totalDebt: number;
  debtors: TopDebtor[];
};

/**
 * @param limit số khách trả về (mặc định 10, chặn trong [1,50]).
 */
export async function getTopDebtors(limit = 10): Promise<TopDebtorsResult> {
  const lim = Math.min(50, Math.max(1, Math.floor(limit) || 10));
  const snap = await engineAllocationSnapshot();

  const byCustomer = new Map<number, { name: string; owed: number; count: number }>();
  let totalDebt = 0;
  for (const m of snap.members) {
    if (m.debt <= 0) continue;
    totalDebt += m.debt;
    // Khách null (đơn chưa gắn khách) gom vào khoá -1 với nhãn rõ ràng.
    const key = m.customerId ?? -1;
    const cur = byCustomer.get(key) ?? { name: m.customerName?.trim() || (m.customerId ? `#${m.customerId}` : "(chưa gắn khách)"), owed: 0, count: 0 };
    cur.owed += m.debt;
    cur.count += 1;
    byCustomer.set(key, cur);
  }

  const debtors: TopDebtor[] = [...byCustomer.entries()]
    .map(([customerId, v]) => ({
      customerId: customerId === -1 ? null : customerId,
      customerName: v.name,
      bookingCount: v.count,
      owed: Math.round(v.owed),
    }))
    .sort((a, b) => b.owed - a.owed)
    .slice(0, lim);

  return { totalDebt: Math.round(totalDebt), debtors };
}
