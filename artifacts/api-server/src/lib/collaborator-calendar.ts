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

const GENERIC_SERVICE_LABEL = /^d(?:ị|i)ch v(?:ụ|u)(?:\s+\d+)?(?:\s*\+\s*d(?:ị|i)ch v(?:ụ|u)\s+\d+)*$/iu;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function meaningfulServiceName(value: unknown): string {
  const name = text(value);
  return name && !GENERIC_SERVICE_LABEL.test(name) ? name : "";
}

function itemServiceName(item: Record<string, unknown>): string {
  for (const value of [
    item.serviceName,
    item.packageName,
    item.serviceLabel,
    item.packageType,
    item.label,
    item.name,
  ]) {
    const name = meaningfulServiceName(value);
    if (name) return name;
  }
  return "";
}

function hasStaffId(rawAssignments: unknown, tenantStaffId: number): boolean {
  return Array.isArray(rawAssignments) && rawAssignments.some(assignment => {
    if (!assignment || typeof assignment !== "object") return false;
    return Number((assignment as Record<string, unknown>).staffId) === tenantStaffId;
  });
}

/**
 * Prefer the booking item snapshot assigned to this collaborator. This keeps the
 * displayed name stable even if the pricing catalogue is renamed later.
 */
export function resolveCollaboratorServiceNames(
  row: Pick<CollaboratorCalendarRow, "items" | "additional_services" | "service_label" | "package_type" | "service_category">,
  tenantStaffId: number,
): string[] {
  const items = Array.isArray(row.items)
    ? row.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  const assignedItemNames = items
    .filter(item => hasStaffId(item.assignedStaff, tenantStaffId))
    .map(itemServiceName)
    .filter(Boolean);

  const additionalServiceNames = Array.isArray(row.additional_services)
    ? row.additional_services
      .filter(service => Boolean(service) && typeof service === "object")
      .filter(service => hasStaffId((service as Record<string, unknown>).staffAssignments, tenantStaffId))
      .map(service => meaningfulServiceName((service as Record<string, unknown>).title))
      .filter(Boolean)
    : [];

  const itemNames = assignedItemNames.length > 0
    ? assignedItemNames
    : items.map(itemServiceName).filter(Boolean);
  const names = [...new Set([...itemNames, ...additionalServiceNames])];
  if (names.length > 0) return names;

  for (const fallback of [row.service_label, row.package_type, row.service_category]) {
    const name = meaningfulServiceName(fallback);
    if (name) return [name];
  }
  return ["Dịch vụ"];
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
  const serviceNames = resolveCollaboratorServiceNames(row, tenantStaffId);

  return {
    bookingId: row.id,
    orderCode: row.order_code,
    shootDate: dateOnly(row.shoot_date),
    shootTime: row.shoot_time,
    customerName: row.customer_name,
    serviceLabel: row.service_label,
    serviceCategory: row.service_category,
    packageType: row.package_type,
    serviceName: serviceNames.join(" + "),
    serviceNames,
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
