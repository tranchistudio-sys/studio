import { resolveBookingAssignedStaff } from "./staff-assignments";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 93;

function validDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseCollaboratorCalendarRange(
  fromValue: unknown,
  toValue: unknown,
): { from: string; to: string } | null {
  if (typeof fromValue !== "string" || typeof toValue !== "string") return null;
  if (!validDateOnly(fromValue) || !validDateOnly(toValue)) return null;
  const fromMs = Date.parse(`${fromValue}T00:00:00.000Z`);
  const toMs = Date.parse(`${toValue}T00:00:00.000Z`);
  const days = Math.floor((toMs - fromMs) / 86_400_000) + 1;
  if (days < 1 || days > MAX_RANGE_DAYS) return null;
  return { from: fromValue, to: toValue };
}

export type CollaboratorCalendarRow = {
  id: number;
  order_code: string | null;
  customer_name: string;
  shoot_date: string | Date;
  shoot_time: string | null;
  service_category: string;
  package_type: string;
  location: string | null;
  status: string;
  items: unknown;
  assigned_staff: unknown;
  additional_services: unknown;
  service_label: string | null;
  [key: string]: unknown;
};

export type CollaboratorOccurrenceRow = {
  id: number;
  booking_id: number;
  shoot_date: string | Date;
  shoot_time: string | null;
  label: string | null;
  sort_order: number;
};

function dateOnly(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function buildCollaboratorCalendarEntry(
  row: CollaboratorCalendarRow,
  occurrences: CollaboratorOccurrenceRow[],
  tenantStaffId: number,
) {
  const ownAssignments = resolveBookingAssignedStaff(
    row.assigned_staff,
    row.items,
    row.additional_services,
  ).filter(assignment => Number(assignment.staffId) === tenantStaffId);
  if (ownAssignments.length === 0) return null;

  return {
    bookingId: row.id,
    orderCode: row.order_code,
    shootDate: dateOnly(row.shoot_date),
    shootTime: row.shoot_time,
    customerName: row.customer_name,
    serviceLabel: row.service_label,
    serviceCategory: row.service_category,
    packageType: row.package_type,
    location: row.location,
    status: row.status,
    assignedRoles: [...new Set(ownAssignments.map(item => item.role).filter(Boolean))],
    occurrences: occurrences.map(occurrence => ({
      id: occurrence.id,
      shootDate: dateOnly(occurrence.shoot_date),
      shootTime: occurrence.shoot_time,
      label: occurrence.label,
      sortOrder: occurrence.sort_order,
    })),
  };
}
