// Phân quyền & phân loại cho module Chi tiền (expenses).
//
// Tách riêng các quyết định thuần (không đụng DB / req) để route mỏng và unit-test
// được — theo đúng convention các helper khác trong lib/ (vd autopost-route-helpers).
//
// Loại chi phí "Cá nhân" (personal) là RIÊNG TƯ: chỉ admin/chủ studio được tạo / xem
// / sửa / xoá. Nhân viên không thấy dòng, không thấy option, không lọc được — kể cả
// gọi API trực tiếp. Tuy nhiên khoản personal VẪN được tính vào tổng chi / lợi nhuận
// (nó rơi vào nhóm "operating" trong revenue/data.ts, không bị loại như loan_principal).

/** costClass "Cá nhân" — riêng tư, admin-only. */
export const PERSONAL_COST_CLASS = "personal";

/** Toàn bộ costClass hợp lệ: 5 loại cũ (giữ nguyên logic) + personal. */
export const ALLOWED_COST_CLASSES = [
  "direct",
  "operating",
  "depreciation",
  "interest",
  "loan_principal",
  PERSONAL_COST_CLASS,
] as const;
export type CostClass = (typeof ALLOWED_COST_CLASSES)[number];

export function isAllowedCostClass(v: unknown): v is CostClass {
  return typeof v === "string" && (ALLOWED_COST_CLASSES as readonly string[]).includes(v);
}

export function isPersonalClass(costClass: unknown): boolean {
  return costClass === PERSONAL_COST_CLASS;
}

/**
 * Chuẩn hoá costClass nhận từ client. Nếu hợp lệ → giữ nguyên; nếu không → suy mặc
 * định như cũ: có gắn booking → "direct", không → "operating".
 */
export function resolveCostClass(costClass: unknown, hasBooking: boolean): CostClass {
  if (isAllowedCostClass(costClass)) return costClass;
  return hasBooking ? "direct" : "operating";
}

/** Suy ra costClass hiệu lực của 1 phiếu (fallback cho phiếu cũ chưa có cột). */
export function effectiveCostClass(expense: ExpenseLike): CostClass {
  if (isAllowedCostClass(expense.costClass)) return expense.costClass;
  return expense.bookingId != null ? "direct" : "operating";
}

/** Admin nếu role === "admin" hoặc mảng roles chứa "admin". */
export function isAdminRole(role: unknown, roles: unknown): boolean {
  return role === "admin" || (Array.isArray(roles) && roles.includes("admin"));
}

/** Chỉ admin/chủ studio được dùng loại chi phí Cá nhân. */
export function canUsePersonalClass(isAdmin: boolean): boolean {
  return isAdmin;
}

export type ExpenseLike = {
  createdByStaffId?: number | null;
  costClass?: string | null;
  bookingId?: number | null;
};

/**
 * Caller có được THẤY 1 phiếu chi không (dùng chung cho list + detail).
 * - Admin: thấy tất cả (gồm cả Cá nhân).
 * - Nhân viên: chỉ thấy phiếu của chính mình VÀ phiếu đó KHÔNG phải Cá nhân.
 *   (Phiếu Cá nhân vốn do admin tạo nên nhân viên cũng không "sở hữu" — đây là lớp
 *    chặn phòng thủ thứ hai, không chỉ dựa vào createdByStaffId.)
 */
export function canViewExpense(
  expense: ExpenseLike,
  opts: { isAdmin: boolean; callerId: number | null },
): boolean {
  if (opts.isAdmin) return true;
  if (isPersonalClass(expense.costClass)) return false;
  return expense.createdByStaffId != null && expense.createdByStaffId === opts.callerId;
}

/** Lọc danh sách phiếu chi theo quyền của caller (giữ thứ tự). */
export function filterExpensesForCaller<T extends ExpenseLike>(
  rows: T[],
  opts: { isAdmin: boolean; callerId: number | null },
): T[] {
  return rows.filter((e) => canViewExpense(e, opts));
}

/** So khớp 1 phiếu với filter theo costClass (suy mặc định nếu phiếu chưa có cột). */
export function matchesCostClass(expense: ExpenseLike, filter: string): boolean {
  return effectiveCostClass(expense) === filter;
}

/**
 * Phiếu chi này có ĐƯỢC TÍNH vào tổng chi / lợi nhuận (P&L) không.
 * Chỉ "loan_principal" (trả gốc khoản vay) bị loại — nó là dòng tiền, không phải chi phí.
 * "personal" KHÔNG bị loại → vẫn cộng vào tổng (yêu cầu nghiệp vụ: ẩn dòng nhưng không
 * loại khỏi tổng). Mirror đúng logic revenue/data.ts.
 */
export function countsTowardTotals(costClass: unknown): boolean {
  return costClass !== "loan_principal";
}
