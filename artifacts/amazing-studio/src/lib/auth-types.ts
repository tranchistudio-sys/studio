export type PlatformRole = "PLATFORM_OWNER" | "PLATFORM_ADMIN" | null;
export type TenantRole = "OWNER" | "ADMIN" | "STAFF";

export interface LegacyViewerUser {
  id: number;
  name: string;
  role: string;
  roles: string[];
  phone?: string;
  email?: string;
  avatar?: string;
  username?: string;
}

export interface PlatformUser {
  id: string | number;
  name: string;
  email?: string;
  avatar?: string;
  platformRole?: PlatformRole;
}

export interface TenantMembershipSummary {
  id: string | number;
  name: string;
  slug: string;
  status: string;
  role: TenantRole;
  membershipId: string | number;
  tenantStaffId?: number | null;
}

export interface AuthResponse {
  platformEnabled?: boolean;
  token?: string;
  user?: LegacyViewerUser;
  platformUser?: PlatformUser;
  activeTenant?: TenantMembershipSummary | null;
  memberships?: TenantMembershipSummary[];
  requiresTenantSelection?: boolean;
  csrfToken?: string;
}

export interface AuthConfig {
  platformEnabled: boolean;
  googleEnabled: boolean;
  googleClientId?: string;
  loginCsrfToken?: string;
}

export interface AuthClientState {
  platformSession: boolean;
  token: string | null;
  activeTenant: TenantMembershipSummary | null;
  memberships: TenantMembershipSummary[];
  requiresTenantSelection: boolean;
}

export function isLegacyViewerUser(value: unknown): value is LegacyViewerUser {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyViewerUser>;
  return typeof candidate.id === "number" && typeof candidate.name === "string" && typeof candidate.role === "string";
}

/** Accept both the new session envelope and the old `/auth/me` user payload. */
export function normalizeAuthResponse(value: unknown): AuthResponse | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as AuthResponse;
  if (
    candidate.user ||
    candidate.platformUser ||
    candidate.activeTenant ||
    Array.isArray(candidate.memberships) ||
    typeof candidate.requiresTenantSelection === "boolean" ||
    typeof candidate.token === "string"
  ) {
    return candidate;
  }
  if (isLegacyViewerUser(value)) return { user: value };
  return null;
}

export function canManageTenantMembers(role: TenantRole | undefined): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function legacyViewerCanAdmin(user: LegacyViewerUser | null | undefined): boolean {
  if (!user) return false;
  const roles = Array.isArray(user.roles) ? user.roles : [];
  return user.role === "admin" || roles.includes("admin");
}

/**
 * Membership is authoritative whenever a platform tenant is active. A legacy
 * staff role may only grant admin access while the platform database is off.
 */
export function resolveTenantAdmin(
  activeTenant: TenantMembershipSummary | null | undefined,
  user: LegacyViewerUser | null | undefined,
): boolean {
  return activeTenant
    ? canManageTenantMembers(activeTenant.role)
    : legacyViewerCanAdmin(user);
}

/** Pure startup/session reduction shared by initial auth, login and tenant switch. */
export function resolveAuthClientState(
  response: AuthResponse,
  fallbackToken: string | null = null,
): AuthClientState {
  const platformSession = response.platformEnabled === true || Boolean(response.platformUser);
  const activeTenant = response.activeTenant ?? null;
  const memberships = Array.isArray(response.memberships) ? response.memberships : [];
  return {
    platformSession,
    token: platformSession ? null : (response.token ?? fallbackToken),
    activeTenant,
    memberships,
    requiresTenantSelection: response.requiresTenantSelection ?? (
      !activeTenant && memberships.length > 1
    ),
  };
}

export function authNeedsStudioSelection(input: {
  platformUser?: PlatformUser | null;
  activeTenant?: TenantMembershipSummary | null;
  memberships?: TenantMembershipSummary[];
  requiresTenantSelection?: boolean;
}): boolean {
  if (input.requiresTenantSelection === true) return true;
  if (input.platformUser && !input.activeTenant) return true;
  return !input.activeTenant && (input.memberships?.length ?? 0) > 1;
}

export function tenantCanRunApp(tenant: TenantMembershipSummary): boolean {
  return tenant.status === "active" || tenant.status === "trial";
}
