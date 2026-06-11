/**
 * Shared staff assignment helpers — single source of truth for parse/dedupe/sync.
 */

export type StaffAssignmentRow = {
  id?: string;
  staffId?: number | null;
  staffName?: string;
  role?: string;
  castAmount?: number;
  taskKey?: string;
};

/** Roles that allow at most one assignee per booking. */
export const SINGLE_SLOT_ROLES = new Set([
  "photographer",
  "makeup",
  "videographer",
  "photoshop",
  "sales",
]);

export function normalizeRoleStr(role: string): string {
  const r = role.toLowerCase().trim();
  if (r === "photo") return "photographer";
  return r;
}

function parseTopLevelAssignedStaff(rawStaff: unknown): StaffAssignmentRow[] {
  if (Array.isArray(rawStaff)) {
    return rawStaff as StaffAssignmentRow[];
  }
  if (typeof rawStaff === "string" && rawStaff.trim()) {
    try {
      const parsed = JSON.parse(rawStaff);
      return parseTopLevelAssignedStaff(parsed);
    } catch {
      return [];
    }
  }
  if (rawStaff && typeof rawStaff === "object") {
    const obj = rawStaff as Record<string, unknown>;
    const roleKeys = ["sale", "sales", "photoshop", "photo", "photographer", "makeup", "video", "videographer"];
    const out: StaffAssignmentRow[] = [];
    for (const role of roleKeys) {
      const val = obj[role];
      if (val == null || val === "") continue;
      const staffId = typeof val === "number" ? val : parseInt(String(val), 10);
      if (!Number.isFinite(staffId)) continue;
      const normRole = role === "sale" ? "sales" : role === "photo" ? "photographer" : role === "video" ? "videographer" : role;
      out.push({
        id: `obj-${normRole}-${staffId}`,
        role: normRole,
        staffId,
        staffName: "",
        castAmount: 0,
      });
    }
    return out;
  }
  return [];
}

function assignedStaffFromItems(rawItems: unknown): StaffAssignmentRow[] {
  if (!Array.isArray(rawItems)) return [];
  const out: StaffAssignmentRow[] = [];
  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    const sa = (item as Record<string, unknown>).assignedStaff;
    if (!Array.isArray(sa)) continue;
    for (const row of sa) {
      if (row && typeof row === "object") out.push(row as StaffAssignmentRow);
    }
  }
  return out;
}

/** True when items[] explicitly carries assignedStaff (even empty). */
export function itemsHaveExplicitAssignedStaff(rawItems: unknown): boolean {
  if (!Array.isArray(rawItems)) return false;
  return rawItems.some(
    (item) => item && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, "assignedStaff"),
  );
}

/**
 * Read path: items[].assignedStaff wins when present; else top-level assigned_staff.
 * Never merge both — that caused stale photographer A + new photographer B duplicates.
 */
export function resolveAssignedStaffForDisplay(
  rawStaff: unknown,
  rawItems: unknown,
): StaffAssignmentRow[] {
  if (itemsHaveExplicitAssignedStaff(rawItems)) {
    return dedupeAssignedStaff(assignedStaffFromItems(rawItems));
  }
  return dedupeAssignedStaff(parseTopLevelAssignedStaff(rawStaff));
}

/** Merge items staff + optional top-level extras (e.g. photoshop only on booking level). */
export function consolidateAssignedStaff(
  items: Record<string, unknown>[],
  topLevel?: StaffAssignmentRow[] | null,
): StaffAssignmentRow[] {
  const fromItems = assignedStaffFromItems(items);
  const base = fromItems.length > 0 || itemsHaveExplicitAssignedStaff(items)
    ? fromItems
    : [];
  const extras = Array.isArray(topLevel) ? topLevel : [];
  if (base.length === 0 && extras.length === 0) return [];
  if (base.length === 0) return dedupeAssignedStaff(extras);
  if (extras.length === 0) return dedupeAssignedStaff(base);

  const merged = [...base];
  const seen = new Set(base.map((s) => assignmentKey(s)));
  for (const sa of extras) {
    const key = assignmentKey(sa);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(sa);
  }
  return dedupeAssignedStaff(merged);
}

function assignmentKey(sa: StaffAssignmentRow): string {
  const role = normalizeRoleStr(String(sa.role ?? ""));
  const staffId = sa.staffId ?? 0;
  if (SINGLE_SLOT_ROLES.has(role)) return role;
  return `${role}:${staffId}:${sa.staffName ?? ""}`;
}

/**
 * Dedupe: single-slot roles keep the last entry; multi-slot by staffId+role.
 */
export function dedupeAssignedStaff(list: StaffAssignmentRow[]): StaffAssignmentRow[] {
  const normalized = list.map((sa) => ({
    ...sa,
    role: sa.role ? normalizeRoleStr(sa.role) : sa.role,
  }));

  const singleByRole = new Map<string, StaffAssignmentRow>();
  const multi: StaffAssignmentRow[] = [];
  const multiSeen = new Set<string>();

  for (const sa of normalized) {
    const role = sa.role ?? "";
    if (!role) continue;
    if (SINGLE_SLOT_ROLES.has(role)) {
      singleByRole.set(role, sa);
      continue;
    }
    const key = `${role}:${sa.staffId ?? ""}:${sa.staffName ?? ""}`;
    if (multiSeen.has(key)) continue;
    multiSeen.add(key);
    multi.push(sa);
  }

  return [...singleByRole.values(), ...multi];
}

export function normalizeStaffList(list: unknown): StaffAssignmentRow[] {
  if (!Array.isArray(list)) return [];
  return dedupeAssignedStaff(
    (list as StaffAssignmentRow[]).map((sa) => ({
      ...sa,
      role: sa.role ? normalizeRoleStr(sa.role) : sa.role,
    })),
  );
}
