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
  shoot_time: string | null;
  status: string | null;
  assigned_staff: unknown;
  items: unknown;
  service_label?: string | null;
  package_type?: string | null;
  customer_name?: string | null;
};

async function fetchBookingsInRange(startDate: string, endDate: string): Promise<BookingRow[]> {
  const r = await pool.query<BookingRow>(
    `SELECT b.id, b.shoot_date, b.shoot_time, b.status, b.assigned_staff, b.items,
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

/** Chuẩn hoá shoot_time về "HH:MM" (24h). Trả null nếu không parse được. */
export function normalizeShootTime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  // Đã đúng dạng HH:MM hoặc HH:MM:SS
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) {
    const hh = Math.min(23, Math.max(0, parseInt(m[1], 10)));
    const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  // Dạng "8h", "8h30", "8 giờ", "14g30"
  const vn = s.toLowerCase().match(/^(\d{1,2})\s*(?:h|g|:|giờ)\s*(\d{1,2})?/);
  if (vn) {
    const hh = Math.min(23, Math.max(0, parseInt(vn[1], 10)));
    const mm = vn[2] ? Math.min(59, Math.max(0, parseInt(vn[2], 10))) : 0;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  return null;
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

/** staffId -> (date -> giờ hẹn chụp sớm nhất "HH:MM") trong tháng. Chỉ ngày có shoot_time hợp lệ. */
export async function getShowTimesByStaffForMonth(
  staffIds: number[],
  month: string,
): Promise<Map<number, Map<string, string>>> {
  const map = new Map<number, Map<string, string>>();
  for (const id of staffIds) map.set(id, new Map());
  if (staffIds.length === 0) return map;

  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const bookings = await fetchBookingsInRange(monthStart, monthEnd);

  for (const b of bookings) {
    const date = toDateStr(b.shoot_date);
    const time = normalizeShootTime(b.shoot_time);
    if (!date || !time) continue;
    const row = b as unknown as Record<string, unknown>;
    for (const staffId of staffIds) {
      if (!staffAssignedToBooking(row, staffId)) continue;
      const inner = map.get(staffId)!;
      const prev = inner.get(date);
      // giữ giờ sớm nhất trong ngày
      if (!prev || time < prev) inner.set(date, time);
    }
  }
  return map;
}

/** date -> giờ hẹn chụp sớm nhất "HH:MM" cho 1 staff trong tháng. */
export async function getShowTimesForStaff(staffId: number, month: string): Promise<Map<string, string>> {
  const byStaff = await getShowTimesByStaffForMonth([staffId], month);
  return byStaff.get(staffId) ?? new Map();
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

export type LateRuleLike = { lateFromTime: string | null; lateToTime: string | null; penaltyAmount: string | number | null };

function hhmmToMin(t: string): number {
  const [h, m] = String(t).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Chấm trễ cho Show ngoài: so giờ chấm với giờ hẹn chụp (shootTime).
 * Quy tắc trễ vốn theo giờ tuyệt đối quanh mốc đúng giờ studio (checkInTo) được
 * quy về OFFSET phút, rồi áp lên shootTime. tierIdx map màu: 0=vàng, 1=cam, >=2=đỏ.
 */
export function computeShowLateness(
  checkIn: string,
  shootTime: string,
  lateRules: LateRuleLike[],
  checkInTo: string,
): { isLate: boolean; penalty: number; tierIdx: number; lateMinutes: number } {
  if (!checkIn || !shootTime) return { isLate: false, penalty: 0, tierIdx: -1, lateMinutes: 0 };
  const lateMinutes = hhmmToMin(checkIn) - hhmmToMin(shootTime);
  if (lateMinutes <= 0) return { isLate: false, penalty: 0, tierIdx: -1, lateMinutes: 0 };
  const anchor = hhmmToMin(checkInTo);
  const bands = lateRules
    .filter(r => r.lateFromTime)
    .map(r => ({
      fromOff: Math.max(1, hhmmToMin(r.lateFromTime!) - anchor),
      toOff: r.lateToTime ? hhmmToMin(r.lateToTime) - anchor : null,
      penalty: r.penaltyAmount != null ? parseFloat(String(r.penaltyAmount)) : 0,
    }))
    .sort((a, b) => a.fromOff - b.fromOff);
  if (bands.length === 0) return { isLate: true, penalty: 0, tierIdx: 0, lateMinutes };
  let tierIdx = -1;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (lateMinutes >= b.fromOff && (b.toOff === null || lateMinutes <= b.toOff)) { tierIdx = i; break; }
  }
  if (tierIdx === -1) tierIdx = bands.length - 1;
  return { isLate: true, penalty: bands[tierIdx]?.penalty ?? 0, tierIdx, lateMinutes };
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
