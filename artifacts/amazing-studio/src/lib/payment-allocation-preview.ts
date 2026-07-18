/**
 * PR-B: preview "tiền sẽ trừ vào đâu" cho màn Thu tiền — thuần JS, mirror đúng
 * quy tắc của allocator backend (booking-money.allocateFamilies, chốt 17/07):
 *  - Phiếu trên CHA (chung hợp đồng / phân bổ tự động) → pool FIFO theo thứ tự
 *    dịch vụ (ngày thực hiện ASC, cùng ngày ID ASC — server đã trả đúng thứ tự).
 *  - Phiếu gắn THẲNG dịch vụ con → trừ nợ dịch vụ đó trước (cap còn phải thu),
 *    phần THỪA tràn về pool FIFO cho các dịch vụ khác còn nợ.
 *  - Tiền dư sau khi mọi dịch vụ đủ → "Khách trả dư" (không tạo nợ âm).
 * Preview CHỈ để hiển thị trước xác nhận — số thật luôn do backend allocator tính.
 */

/** Một dịch vụ trong breakdown gia đình — shape của GET /api/bookings/:id/allocation. */
export interface AllocationService {
  bookingId: number;
  orderCode: string | null;
  serviceLabel: string | null;
  serviceCategory: string | null;
  packageType: string | null;
  shootDate: string | null;
  net: number;
  equalDeposit: number;
  directPaid: number;
  legacyDepositPaid: number;
  parentFifo: number;
  allocPaid: number;
  remaining: number;
}

export interface FamilyAllocationInfo {
  rootId: number;
  totalDeposit: number;
  canonicalDepositPaymentId?: number | null;
  overpayment: number;
  totalNet: number;
  totalAllocPaid: number;
  totalRemaining: number;
  services: AllocationService[];
}

/** Cách người thu chọn đích của phiếu mới. */
export type AllocTargetMode = "contract" | "service" | "fifo";

export interface PreviewFill {
  bookingId: number;
  label: string;
  amount: number;
}

export interface AllocationPreview {
  fills: PreviewFill[];
  /** Phần vượt tổng nợ gia đình → "Khách trả dư". */
  overpay: number;
}

export function serviceDisplayLabel(s: AllocationService, index: number): string {
  return (
    s.serviceLabel?.trim() ||
    s.packageType?.trim() ||
    s.orderCode?.trim() ||
    `Dịch vụ ${index + 1}`
  );
}

/**
 * Tính preview phân bổ cho số tiền `amount`:
 *  - mode "contract"/"fifo": FIFO trên toàn bộ services theo thứ tự mảng.
 *  - mode "service": trừ dịch vụ `targetBookingId` trước (cap remaining),
 *    phần thừa FIFO các dịch vụ còn lại.
 * `services` PHẢI theo thứ tự FIFO của server (đã sort ngày ASC, ID ASC).
 */
export function previewPaymentAllocation(
  services: readonly AllocationService[],
  amount: number,
  mode: AllocTargetMode,
  targetBookingId?: number | null,
): AllocationPreview {
  const fills: PreviewFill[] = [];
  let left = Math.max(0, Math.floor(amount));
  if (left <= 0 || services.length === 0) return { fills, overpay: left };

  const push = (s: AllocationService, idx: number, amt: number) => {
    if (amt <= 0) return;
    fills.push({ bookingId: s.bookingId, label: serviceDisplayLabel(s, idx), amount: amt });
  };

  if (mode === "service" && targetBookingId != null) {
    const idx = services.findIndex(s => s.bookingId === targetBookingId);
    if (idx >= 0) {
      const target = services[idx];
      const take = Math.min(left, Math.max(0, target.remaining));
      push(target, idx, take);
      left -= take;
      // Phần thừa tràn pool → FIFO các dịch vụ khác còn nợ (đúng allocator).
      for (let i = 0; i < services.length && left > 0; i++) {
        if (i === idx) continue;
        const take2 = Math.min(left, Math.max(0, services[i].remaining));
        push(services[i], i, take2);
        left -= take2;
      }
      return { fills, overpay: left };
    }
    // targetBookingId lạ → coi như thu chung (không silent-drop tiền trong preview).
  }

  for (let i = 0; i < services.length && left > 0; i++) {
    const take = Math.min(left, Math.max(0, services[i].remaining));
    push(services[i], i, take);
    left -= take;
  }
  return { fills, overpay: left };
}
