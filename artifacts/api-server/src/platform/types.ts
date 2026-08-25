export type PlatformRole = "PLATFORM_OWNER" | "PLATFORM_ADMIN" | null;
export type TenantRole = "OWNER" | "ADMIN" | "STAFF";
export type TenantPermissions = Record<string, unknown>;
export type TenantStatus =
  | "provisioning"
  | "trial"
  | "active"
  | "suspended"
  | "cancelled"
  | "provisioning_failed";

export interface TenantMembershipSummary {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  role: TenantRole;
  membershipId: string;
  tenantStaffId: number | null;
  permissions: TenantPermissions;
}

export interface PlatformUserSummary {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  platformRole: PlatformRole;
}

export interface PlatformSessionContext {
  sessionId: string;
  createdAt: Date;
  userId: string;
  userStatus: string;
  platformRole: PlatformRole;
  activeTenantId: string | null;
  tenantStatus: TenantStatus | null;
  membershipId: string | null;
  membershipStatus: string | null;
  tenantRole: TenantRole | null;
  tenantStaffId: number | null;
  permissions: TenantPermissions;
  csrfTokenHash: string;
  expiresAt: Date;
}
