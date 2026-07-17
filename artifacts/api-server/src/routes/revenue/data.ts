import { db } from "@workspace/db";
import { bookingsTable, expensesTable, paymentsTable, fixedCostsTable } from "@workspace/db/schema";
import { money, filterRevenueCountable, allocateFamilyPaid } from "../../lib/booking-money";
import { parentIdsWithActiveChild, isEmptyParentContract } from "../../lib/parent-contract";
// GĐ1b-2 (quy tắc ④ chủ chốt 14/07): cast theo show đọc từ SỔ staff_job_earnings
// qua FINANCIAL ENGINE — bỏ hẳn tasks.cost (toàn hệ thống 0 dòng có cost > 0,
// nghĩa là lợi nhuận trước nay chưa từng trừ cast).
import { engineCastLedger } from "../../lib/finance/financial-engine";

export async function loadAllData() {
  const [bookings, expenses, payments, castLedger] = await Promise.all([
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
      deletedAt: bookingsTable.deletedAt,
      // Cố ý KHÔNG lọc deletedAt ở query: cần cả đơn CHA đã vào thùng rác trong tập để
      // filterRevenueCountable nhận diện CON MỒ CÔI của cha đã xóa (giống customer-aggregate
      // PR #65 + dashboard revenueCountableSql). filterRevenueCountable tự loại đơn đã xóa
      // (isSelfLiveBooking đọc deletedAt) khỏi validBookings ⇒ báo cáo/lương vẫn không tính rác.
    }).from(bookingsTable),
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
    engineCastLedger(),
  ]);

  // Cast per booking từ Engine (earnings hợp lệ, mỗi khoản đúng MỘT lần) — payroll
  // đã thanh toán và salary advance KHÔNG cộng thêm (chỉ là thanh toán/ứng của
  // nghĩa vụ đã ghi nhận). Lương CỨNG nằm riêng ở fixed_costs.
  const castByBooking = castLedger.castByBooking;
  const laborMeta = castLedger.meta;

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

  // Nguồn tiền chuẩn (chủ chốt): doanh thu = NET = giá gốc − giảm giá (không âm).
  // netAmount gắn sẵn vào từng booking để mọi route dùng CHUNG, hết cảnh chỗ gross chỗ net.
  // filterRevenueCountable: loại đơn đã xóa (thùng rác) + đơn cha tổng + hủy + báo giá tạm
  // + con MỒ CÔI của hợp đồng cha đã CHẾT (xóa/hủy/báo giá tạm). Vì query trên nạp CẢ đơn đã
  // xóa nên map cha đầy đủ ⇒ con của cha bị trash cũng bị loại (khớp dashboard + customer PR #65).
  // PR #102: paidAmount per-booking = "đã thu PHÂN BỔ" theo gia đình từ payments gốc
  // (mirror ENGINE) — cột paid_amount thô không dùng nữa (phiếu hợp đồng gộp nằm ở CHA).
  const allocPaid = allocateFamilyPaid(bookings, payments);
  const validBookings = filterRevenueCountable(bookings)
    .map(b => ({
      ...b,
      paidAmount: String(allocPaid.get(b.id) ?? 0),
      netAmount: Math.max(0, money(b.totalAmount) - money(b.discountAmount)),
    }));

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

  // PR D (read-layer): cọc/thu nằm ở CHA RỖNG/ZOMBIE (hợp đồng cha không còn dịch vụ con hiệu lực)
  // KHÔNG tính vào doanh thu/dòng tiền active — suy ra từ dữ liệu con, không cần cha đổi status.
  const activeParentIds = parentIdsWithActiveChild(bookings); // tính 1 lần (tránh O(n²))
  const zombieParentIds = new Set(
    bookings.filter(b => isEmptyParentContract(b, activeParentIds)).map(b => b.id),
  );

  // Task #397: loại phiếu đã huỷ (voided) + phiếu HOÀN TIỀN (refund — lưu DƯƠNG, KHÔNG phải
  // tiền thu) khỏi MỌI tính toán doanh thu/dòng tiền. Vá lỗi daily-cashflow cộng nhầm refund.
  // (Giữ ad_hoc vì đó là khoản thu thật của kỳ, chỉ không gắn vào 1 booking.)
  const activePayments = payments.filter(
    p => (p.status ?? 'active') !== 'voided' && (p.paymentType ?? '') !== 'refund'
      && !(p.bookingId != null && zombieParentIds.has(p.bookingId)), // loại cọc của cha rỗng
  );

  return { validBookings, castByBooking, laborMeta, directExpByBooking, directExpByDate, operatingExpByDate, depreciationByDate, interestByDate, payments: activePayments, classifiedExpenses, fixedCostPerMonth };
}
