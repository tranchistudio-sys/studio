import { db } from "@workspace/db";
import { isNull } from "drizzle-orm";
import { bookingsTable, expensesTable, tasksTable, paymentsTable, fixedCostsTable } from "@workspace/db/schema";

export async function loadAllData() {
  const [bookings, tasks, expenses, payments] = await Promise.all([
    db.select({
      id: bookingsTable.id,
      totalAmount: bookingsTable.totalAmount,
      paidAmount: bookingsTable.paidAmount,
      discountAmount: bookingsTable.discountAmount,
      shootDate: bookingsTable.shootDate,
      status: bookingsTable.status,
      isParentContract: bookingsTable.isParentContract,
      parentId: bookingsTable.parentId,
      serviceCategory: bookingsTable.serviceCategory,
      assignedStaff: bookingsTable.assignedStaff,
      createdAt: bookingsTable.createdAt,
    }).from(bookingsTable).where(isNull(bookingsTable.deletedAt)), // Thùng rác: loại booking đã xoá khỏi MỌI báo cáo + lương
    db.select({
      id: tasksTable.id,
      bookingId: tasksTable.bookingId,
      cost: tasksTable.cost,
      role: tasksTable.role,
      taskType: tasksTable.taskType,
      status: tasksTable.status,
    }).from(tasksTable),
    db.select({
      id: expensesTable.id,
      bookingId: expensesTable.bookingId,
      amount: expensesTable.amount,
      expenseDate: expensesTable.expenseDate,
      status: expensesTable.status,
      costClass: expensesTable.costClass,
    }).from(expensesTable),
    db.select({
      id: paymentsTable.id,
      bookingId: paymentsTable.bookingId,
      amount: paymentsTable.amount,
      paymentType: paymentsTable.paymentType,
      paidDate: paymentsTable.paidDate,
      paidAt: paymentsTable.paidAt,
      status: paymentsTable.status,
    }).from(paymentsTable),
  ]);

  const castByBooking = new Map<number, number>();
  for (const t of tasks) {
    if (t.bookingId != null) {
      const c = parseFloat(t.cost) || 0;
      castByBooking.set(t.bookingId, (castByBooking.get(t.bookingId) ?? 0) + c);
    }
  }

  // Task #363: phân chia chi phí theo costClass theo mô hình tài chính chuẩn.
  // direct → gắn vào booking nếu có; operating/depreciation/interest → gom theo tháng;
  // loan_principal → bỏ qua (không phải chi phí, chỉ là dòng tiền trả gốc).
  const directExpByBooking = new Map<number, number>();
  const directExpByDate = new Map<string, number>();      // direct không gắn booking → vẫn rơi vào tháng
  const operatingExpByDate = new Map<string, number>();
  const depreciationByDate = new Map<string, number>();
  const interestByDate = new Map<string, number>();
  for (const e of expenses) {
    // Task #363: chỉ tính chi phí đã được duyệt (approved) hoặc đã chi (paid).
    // Submitted/rejected → chưa tính vào P&L để không khai khống.
    if (e.status !== "approved" && e.status !== "paid") continue;
    const amt = parseFloat(e.amount) || 0;
    const ym = (e.expenseDate || "").slice(0, 7);
    // cost_class nếu có; nếu không thì fallback theo dữ liệu cũ: có booking → direct, còn lại → operating
    const cls = e.costClass || (e.bookingId != null ? "direct" : "operating");
    if (cls === "loan_principal") continue;
    if (cls === "direct") {
      if (e.bookingId != null) {
        directExpByBooking.set(e.bookingId, (directExpByBooking.get(e.bookingId) ?? 0) + amt);
      } else if (ym) {
        directExpByDate.set(ym, (directExpByDate.get(ym) ?? 0) + amt);
      }
    } else if (cls === "depreciation") {
      if (ym) depreciationByDate.set(ym, (depreciationByDate.get(ym) ?? 0) + amt);
    } else if (cls === "interest") {
      if (ym) interestByDate.set(ym, (interestByDate.get(ym) ?? 0) + amt);
    } else {
      // operating (mặc định)
      if (ym) operatingExpByDate.set(ym, (operatingExpByDate.get(ym) ?? 0) + amt);
    }
  }

  const validBookings = bookings.filter(b => !b.isParentContract && b.status !== "cancelled");

  // Task #363: kèm danh sách chi phí đã phân lớp + ngày để route nào cần lọc theo range chính xác (ngày/tuần)
  // có thể tự gom lại mà không cần đụng vào loadAllData() của các route khác.
  const classifiedExpenses: Array<{ bookingId: number | null; amount: number; date: string; cls: string }> = [];
  for (const e of expenses) {
    if (e.status !== "approved" && e.status !== "paid") continue;
    const cls = e.costClass || (e.bookingId != null ? "direct" : "operating");
    if (cls === "loan_principal") continue;
    classifiedExpenses.push({
      bookingId: e.bookingId,
      amount: parseFloat(e.amount) || 0,
      date: e.expenseDate || "",
      cls,
    });
  }

  // Task #364: chi phí cố định hàng tháng (mặt bằng, lương cứng, internet…) — cộng vào operating cho mỗi tháng trong range.
  const fixedCostRows = await db.select({
    id: fixedCostsTable.id,
    amount: fixedCostsTable.amount,
    active: fixedCostsTable.active,
  }).from(fixedCostsTable);
  const fixedCostPerMonth = fixedCostRows
    .filter(r => r.active)
    .reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);

  // Task #397: loại bỏ phiếu thu đã huỷ khỏi mọi tính toán doanh thu
  const activePayments = payments.filter(p => (p.status ?? 'active') !== 'voided');

  return { validBookings, castByBooking, directExpByBooking, directExpByDate, operatingExpByDate, depreciationByDate, interestByDate, payments: activePayments, classifiedExpenses, fixedCostPerMonth };
}
