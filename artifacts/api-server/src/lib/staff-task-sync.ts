import { db } from "@workspace/db";
import { tasksTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  normalizeRoleStr,
  SINGLE_SLOT_ROLES,
  type StaffAssignmentRow,
} from "./staff-assignments";

const SYNC_ROLES = new Set([
  "photographer",
  "makeup",
  "videographer",
  "photoshop",
  "sales",
  "assistant",
  "assistant_photo",
  "marketing",
  "other",
]);

const ROLE_TO_TASK_TYPE: Record<string, string> = {
  photographer: "chup",
  makeup: "makeup",
  photoshop: "pts",
  videographer: "quay_phim",
  assistant: "support",
  assistant_photo: "support",
  sales: "other",
  marketing: "other",
  other: "other",
};

const ROLE_TO_TITLE: Record<string, string> = {
  photographer: "Chụp ảnh",
  makeup: "Trang điểm",
  photoshop: "Chỉnh ảnh (PTS)",
  videographer: "Quay phim",
  assistant: "Hỗ trợ",
  assistant_photo: "Thợ phụ",
  sales: "Sale",
  marketing: "Marketing",
  other: "Khác",
};

function desiredTaskKey(role: string, staffId: number): string {
  const r = normalizeRoleStr(role);
  return SINGLE_SLOT_ROLES.has(r) ? r : `${r}:${staffId}`;
}

/**
 * Sync tasks table assignees + cost from booking assignedStaff JSON.
 * Removes stale assignees and duplicate role rows so production cost stays accurate.
 */
export async function syncBookingTasksFromStaff(
  bookingId: number,
  staffList: StaffAssignmentRow[],
  servicePackageId?: number | null,
): Promise<void> {
  const desired = staffList.filter(
    (s) => s.staffId && s.role && SYNC_ROLES.has(normalizeRoleStr(s.role)),
  );

  const desiredKeys = new Set(
    desired.map((s) => desiredTaskKey(s.role!, s.staffId!)),
  );

  const existing = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.bookingId, bookingId));

  const syncExisting = existing.filter(
    (t) => t.role && SYNC_ROLES.has(normalizeRoleStr(t.role)),
  );

  // Delete tasks for synced roles no longer in desired set, and duplicate rows per role
  const keptTaskIds = new Set<number>();

  for (const sa of desired) {
    const role = normalizeRoleStr(sa.role!);
    const key = desiredTaskKey(role, sa.staffId!);
    const cost = String(sa.castAmount ?? 0);
    const taskType = ROLE_TO_TASK_TYPE[role] ?? "other";
    const title = ROLE_TO_TITLE[role] ?? role;

    const matches = syncExisting.filter((t) => {
      if (!t.assigneeId) return false;
      return desiredTaskKey(t.role ?? "", t.assigneeId) === key
        || (SINGLE_SLOT_ROLES.has(role) && normalizeRoleStr(t.role ?? "") === role);
    });

    if (matches.length > 0) {
      const [keep, ...dupes] = matches;
      keptTaskIds.add(keep.id);
      await db
        .update(tasksTable)
        .set({
          assigneeId: sa.staffId!,
          role,
          taskType,
          title,
          cost,
          servicePackageId: servicePackageId ?? keep.servicePackageId ?? null,
        })
        .where(eq(tasksTable.id, keep.id));

      for (const d of dupes) {
        await db.delete(tasksTable).where(eq(tasksTable.id, d.id));
      }
    } else {
      const [inserted] = await db
        .insert(tasksTable)
        .values({
          title,
          bookingId,
          assigneeId: sa.staffId!,
          role,
          taskType,
          cost,
          status: "todo",
          category: "production",
          servicePackageId: servicePackageId ?? null,
        })
        .returning({ id: tasksTable.id });
      if (inserted) keptTaskIds.add(inserted.id);
    }
  }

  // Remove stale synced-role tasks (old assignees)
  for (const t of syncExisting) {
    if (keptTaskIds.has(t.id)) continue;
    const role = normalizeRoleStr(t.role ?? "");
    if (!SYNC_ROLES.has(role)) continue;
    if (!t.assigneeId) {
      await db.delete(tasksTable).where(eq(tasksTable.id, t.id));
      continue;
    }
    const key = desiredTaskKey(role, t.assigneeId);
    if (!desiredKeys.has(key)) {
      await db.delete(tasksTable).where(eq(tasksTable.id, t.id));
    }
  }
}
