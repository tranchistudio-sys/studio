/**
 * Attendance mode: SHOW (field work / booking) vs STUDIO (office) vs OFF (leave/weekend).
 * Staff assigned to a booking on a date are in SHOW mode — no 08:00 studio late penalty.
 */

import { pool } from "@workspace/db";
import { resolveAssignedStaffForDisplay } from "./staff-assignments";

export type AttendanceMode = "SHOW" | "STUDIO" | "OFF";

const CANCELLED_STATUSES = new Set(["cancelled", "huy", "cancel", "canceled"]);

function parseJsonb(val: unknown): unknown {
  if (val == null) return null;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return null; }
  }
  if (Buffer.isBuffer(val)) {
    try { return JSON.parse(val.toString("utf8")); } catch { return null; }
  }
  return val;
}

/** True when staffId appears in booking assignment (shared parse path + legacy photoId/makeupId). */
export function staffAssignedToBooking(row: Record<string, unknown>, staffId: number): boolean {
  const items = parseJsonb(row.items);
  const assigned = parseJsonb(row.assigned_staff);
  const resolved = resolveAssignedStaffForDisplay(assigned, items);
  if (resolved.some(a => a.staffId != null && Number(a.staffId) === staffId)) return true;

  const itemList = items as Array<Record<string, unknown>> | null;
  if (Array.isArray(itemList)) {
    for (const it of itemList) {
      if (!it) continue;
      if (Number(it.photoId) === staffId || Number(it.makeupId) === staffId) return true;
    }
  }
  return false;
}

function isCancelledStatus(status: unknown): boolean {
  const s = String(status ?? "").toLowerCase().trim();
  return CANCELLED_STATUSES.has(s);
}

function toDateStr(v: unknown): string {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

type BookingRow = {
  id: number;
  shoot_date: unknown;
  status: string | null;
  assigned_staff: unknown;
  items: unknown;
  service_label?: string | null;
  package_type?: string | null;
  customer_name?: string | null;
};

async function fetchBookingsInRange(startDate: string, endDate: string): Promise<BookingRow[]> {
  const r = await pool.query<BookingRow>(
    `SELECT b.id, b.shoot_date, b.status, b.assigned_staff, b.items,
            b.service_label, b.package_type, c.name AS customer_name
     FROM bookings b
     LEFT JOIN customers c ON c.id = b.customer_id
     WHERE b.shoot_date >= $1::date AND b.shoot_date <= $2::date
       AND COALESCE(b.is_parent_contract, false) = false
       AND (b.assigned_staff IS NOT NULL OR b.items IS NOT NULL)
     ORDER BY b.shoot_date`,
    [startDate, endDate],
  );
  return r.rows.filter(row => !isCancelledStatus(row.status));
}

export function resolveAttendanceMode(args: {
  hasBooking: boolean;
  isLeaveExcused: boolean;
  isWeekend: boolean;
}): AttendanceMode {
  if (args.isLeaveExcused || args.isWeekend) return "OFF";
  if (args.hasBooking) return "SHOW";
  return "STUDIO";
}

export function studioLatePenaltyApplies(mode: AttendanceMode): boolean {
  return mode === "STUDIO";
}

/** Dates in month where staff has an active booking assignment. */
export async function getShowDayDatesForStaff(staffId: number, month: string): Promise<Set<string>> {
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const bookings = await fetchBookingsInRange(monthStart, monthEnd);
  const dates = new Set<string>();
  for (const b of bookings) {
    if (!staffAssignedToBooking(b as unknown as Record<string, unknown>, staffId)) continue;
    const d = toDateStr(b.shoot_date);
    if (d) dates.add(d);
  }
  return dates;
}

/** Batch: staffId -> Set of show-day dates in month. */
export async function getShowDayDatesByStaffForMonth(
  staffIds: number[],
  month: string,
): Promise<Map<number, Set<string>>> {
  const map = new Map<number, Set<string>>();
  for (const id of staffIds) map.set(id, new Set());
  if (staffIds.length === 0) return map;

  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const bookings = await fetchBookingsInRange(monthStart, monthEnd);

  for (const b of bookings) {
    const date = toDateStr(b.shoot_date);
    if (!date) continue;
    const row = b as unknown as Record<string, unknown>;
    for (const staffId of staffIds) {
      if (staffAssignedToBooking(row, staffId)) {
        map.get(staffId)!.add(date);
      }
    }
  }
  return map;
}

/** Active staff with a booking on a specific date. */
export async function getShowDayStaffIdsForDate(date: string): Promise<Set<number>> {
  const bookings = await fetchBookingsInRange(date, date);
  const staffIds = new Set<number>();

  const activeR = await pool.query<{ id: number }>(
    `SELECT id FROM staff WHERE is_active = 1`,
  );
  const activeIds = activeR.rows.map(r => r.id);

  for (const b of bookings) {
    const row = b as unknown as Record<string, unknown>;
    for (const staffId of activeIds) {
      if (staffAssignedToBooking(row, staffId)) staffIds.add(staffId);
    }
  }
  return staffIds;
}

export function isSundayOff(date: string): boolean {
  return new Date(`${date}T12:00:00`).getDay() === 0;
}


export type StaffBookingOnDate = {
  id: number;
  customerName: string | null;
  serviceLabel: string | null;
  packageType: string | null;
  shootDate: string;
};

/** Bookings assigned to staff on a specific date (for Show Day UI). */
export async function getBookingsForStaffOnDate(staffId: number, date: string): Promise<StaffBookingOnDate[]> {
  const bookings = await fetchBookingsInRange(date, date);
  const out: StaffBookingOnDate[] = [];
  for (const b of bookings) {
    const row = b as unknown as Record<string, unknown>;
    if (!staffAssignedToBooking(row, staffId)) continue;
    const customerName = row.customer_name != null ? String(row.customer_name) : null;
    out.push({
      id: Number(b.id),
      customerName,
      serviceLabel: row.service_label != null ? String(row.service_label) : null,
      packageType: row.package_type != null ? String(row.package_type) : null,
      shootDate: toDateStr(b.shoot_date),
    });
  }
  return out;
}
