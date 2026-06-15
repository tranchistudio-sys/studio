/**
 * Đồng bộ với artifacts/api-server/src/lib/attendance-eligible-shared.ts
 * Danh sách chấm công động từ Nhân sự — không hard-code tên NV.
 */

export const ATTENDANCE_EXCLUDED_STAFF_TYPES = new Set(["freelancer", "ctv", "collaborator"]);
export const ATTENDANCE_EXCLUDED_ROLES = new Set(["admin", "owner"]);

export const ATTENDANCE_OPERATIONAL_ROLES = new Set([
  "photographer",
  "sale",
  "makeup",
  "assistant",
  "staff",
  "retouch",
  "editor",
  "designer",
  "reception",
  "driver",
]);

export type AttendanceStaffRow = {
  name?: string | null;
  staffType?: string | null;
  staff_type?: string | null;
  role?: string | null;
  roles?: string[] | unknown;
  username?: string | null;
  isAdmin?: boolean | null;
  attendanceEnabled?: boolean | null;
  attendance_enabled?: boolean | null;
};

export function normalizeStaffIdentity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\s._-]+/g, "");
}

export function isAttendanceBlockedIdentity(row: { name?: string | null; username?: string | null }): boolean {
  const username = normalizeStaffIdentity(String(row.username ?? ""));
  if (username === "tranchi") return true;
  const name = normalizeStaffIdentity(String(row.name ?? ""));
  if (!name) return false;
  if (name === "tranchi" || name === "tranchiadmin") return true;
  if (name.includes("tranchi")) return true;
  return false;
}

function parseRoles(roles: string[] | unknown | undefined): string[] {
  if (Array.isArray(roles)) return roles.map(r => String(r).toLowerCase());
  return [];
}

function isRolesOnlyAdministrative(role: string, extra: string[]): boolean {
  if (extra.length === 0) return false;
  const hasExcludedInExtra = extra.some(r => ATTENDANCE_EXCLUDED_ROLES.has(r));
  if (!hasExcludedInExtra) return false;
  if (extra.some(r => ATTENDANCE_OPERATIONAL_ROLES.has(r))) return false;
  if (ATTENDANCE_OPERATIONAL_ROLES.has(role) && role !== "staff") return false;
  return true;
}

function isAttendanceAdminLike(row: AttendanceStaffRow): boolean {
  if (row.isAdmin === true) return true;
  if (isAttendanceBlockedIdentity(row)) return true;
  const role = String(row.role ?? "").trim().toLowerCase();
  if (ATTENDANCE_EXCLUDED_ROLES.has(role)) return true;
  const extra = parseRoles(row.roles);
  if (!role && extra.length > 0 && extra.every(r => ATTENDANCE_EXCLUDED_ROLES.has(r))) return true;
  if (isRolesOnlyAdministrative(role, extra)) return true;
  return false;
}

export function isAttendanceEligibleStaff(row: AttendanceStaffRow): boolean {
  // Nút gạt "Tính chấm công" trong Nhân sự: tắt = loại khỏi lịch/thống kê
  if (row.attendanceEnabled === false || row.attendance_enabled === false) return false;
  const staffType = String(row.staffType ?? row.staff_type ?? "official").trim().toLowerCase();
  if (ATTENDANCE_EXCLUDED_STAFF_TYPES.has(staffType)) return false;
  if (isAttendanceAdminLike(row)) return false;
  return true;
}
