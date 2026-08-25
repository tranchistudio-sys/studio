import type { PlatformSessionContext, TenantPermissions } from "./types";

export const COLLABORATOR_PERMISSIONS: TenantPermissions = Object.freeze({
  accessPreset: "COLLABORATOR",
  calendarScope: "OWN",
  bookingDetailScope: "WORK_ONLY",
});

export function normalizeTenantPermissions(value: unknown): TenantPermissions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as TenantPermissions;
}

export function isCollaboratorPermissions(value: unknown): boolean {
  return normalizeTenantPermissions(value).accessPreset === "COLLABORATOR";
}

export function isCollaboratorSession(
  context: Pick<PlatformSessionContext, "permissions">,
): boolean {
  return isCollaboratorPermissions(context.permissions);
}

export type CalendarScope = "ALL" | "OWN" | "NONE";

export function resolveCalendarScope(
  context: Pick<PlatformSessionContext, "tenantRole" | "permissions">,
): CalendarScope {
  if (isCollaboratorSession(context)) return "OWN";
  if (context.tenantRole === "OWNER" || context.tenantRole === "ADMIN") return "ALL";
  if (context.tenantRole !== "STAFF") return "NONE";
  return "ALL";
}
