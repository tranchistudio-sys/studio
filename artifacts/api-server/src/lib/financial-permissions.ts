export type BusinessRole = "admin" | "staff" | null;

/**
 * Amazing Studio hiện cấp quyền Thu tiền cho mọi nhân viên đang hoạt động.
 * Tách các quyết định ở đây để quyền tài chính từng đơn không kéo theo quyền
 * xem báo cáo tổng hợp của studio.
 */
export function canViewBookingFinancials(role: BusinessRole): boolean {
  return role === "admin" || role === "staff";
}

export function canCollectPayments(role: BusinessRole): boolean {
  return role === "admin" || role === "staff";
}

export function canViewRevenueReports(role: BusinessRole): boolean {
  return role === "admin";
}

export function normalizeCollectionAmount(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
