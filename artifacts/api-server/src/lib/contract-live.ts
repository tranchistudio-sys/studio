/**
 * contract-live.ts — overlay dữ liệu LIVE từ booking lên danh sách hợp đồng.
 *
 * Vấn đề gốc: contracts.total_value / contracts.customer_id là bản copy chụp lúc
 * tạo hợp đồng, không bao giờ được cập nhật khi booking đổi → trang Hợp đồng và
 * tab hợp đồng của khách hiện số cũ vĩnh viễn (kể cả F5).
 *
 * Quy tắc (Booking = source of truth):
 * - Hợp đồng CHƯA KÝ + có gắn booking → totalValue/customerName/customerPhone
 *   đọc live từ booking hiện tại (tiền theo FAMILY: child → tổng của parent).
 * - Hợp đồng ĐÃ KÝ → giữ nguyên số đã lưu (bản pháp lý, mirror signed_snapshot).
 * - Hợp đồng không gắn booking → giữ nguyên (dữ liệu tự do của hợp đồng rời).
 */
import { db } from "@workspace/db";
import { bookingsTable, customersTable } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import { money } from "./booking-money";

export type ContractListRow = {
  id: number;
  bookingId: number | null;
  status: string;
  totalValue: unknown;
  customerName: string;
  customerPhone: string | null;
};

export type LiveBookingInfo = {
  id: number;
  parentId: number | null;
  isParentContract: boolean | null;
  customerId: number | null;
  totalAmount: string | null;
};

/**
 * Thuần (test được): quyết định totalValue/customer hiển thị cho MỘT dòng hợp đồng.
 * familyTotal = tổng live theo family (đã resolve parent nếu là child).
 */
export function overlayContractRow<T extends ContractListRow>(
  row: T,
  booking: LiveBookingInfo | undefined,
  familyTotal: number | null,
  customer: { name: string; phone: string | null } | undefined,
): T {
  if (row.status === "signed" || !row.bookingId || !booking) return row;
  return {
    ...row,
    totalValue: familyTotal != null ? String(familyTotal) : row.totalValue,
    customerName: customer?.name ?? row.customerName,
    customerPhone: customer !== undefined ? customer.phone : row.customerPhone,
  };
}

/** Overlay live cho cả danh sách — 3 query batch, không N+1. */
export async function overlayLiveContractRows<T extends ContractListRow>(rows: T[]): Promise<T[]> {
  const bookingIds = [
    ...new Set(rows.filter((r) => r.status !== "signed" && r.bookingId != null).map((r) => r.bookingId as number)),
  ];
  if (bookingIds.length === 0) return rows;

  const bookingCols = {
    id: bookingsTable.id,
    parentId: bookingsTable.parentId,
    isParentContract: bookingsTable.isParentContract,
    customerId: bookingsTable.customerId,
    totalAmount: bookingsTable.totalAmount,
  };
  const bookings = await db.select(bookingCols).from(bookingsTable).where(inArray(bookingsTable.id, bookingIds));
  const byId = new Map<number, LiveBookingInfo>(bookings.map((b) => [b.id, b]));

  // Child booking → tiền family nằm ở PARENT (mirror buildContractPayload/GET /bookings/:id).
  const missingParentIds = [
    ...new Set(
      bookings
        .map((b) => b.parentId)
        .filter((pid): pid is number => pid != null && !byId.has(pid)),
    ),
  ];
  if (missingParentIds.length > 0) {
    const parents = await db.select(bookingCols).from(bookingsTable).where(inArray(bookingsTable.id, missingParentIds));
    for (const p of parents) byId.set(p.id, p);
  }

  const customerIds = [
    ...new Set(
      bookings
        .map((b) => {
          const base = b.parentId != null ? byId.get(b.parentId) ?? b : b;
          return base.customerId;
        })
        .filter((cid): cid is number => cid != null),
    ),
  ];
  const customers = customerIds.length
    ? await db
        .select({ id: customersTable.id, name: customersTable.name, phone: customersTable.phone })
        .from(customersTable)
        .where(inArray(customersTable.id, customerIds))
    : [];
  const custById = new Map(customers.map((cu) => [cu.id, { name: cu.name, phone: cu.phone ?? null }]));

  return rows.map((row) => {
    const booking = row.bookingId != null ? byId.get(row.bookingId) : undefined;
    if (!booking) return row;
    const base = booking.parentId != null ? byId.get(booking.parentId) ?? booking : booking;
    const familyTotal = money(base.totalAmount);
    const customer = base.customerId != null ? custById.get(base.customerId) : undefined;
    return overlayContractRow(row, booking, familyTotal, customer);
  });
}
