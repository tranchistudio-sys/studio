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

/**
 * Browser-side scope for tenant-owned state that can outlive a React render
 * (upload queues, IndexedDB blobs, local drafts, etc.).  This is deliberately
 * made from opaque ids only; it must never contain an email, token or session
 * secret.
 */
export interface AuthClientScope {
  key: string;
  tenantId: string;
  membershipId: string;
  userId: string;
}

function encodeScopePart(value: string | number): string {
  return encodeURIComponent(String(value));
}

/**
 * Platform users may only own tenant state after selecting a tenant. Legacy
 * users keep a compatibility scope so existing single-studio login continues
 * to work while the platform migration is in progress.
 */
export function resolveAuthClientScope(input: {
  platformUser?: PlatformUser | null;
  viewer?: LegacyViewerUser | null;
  activeTenant?: TenantMembershipSummary | null;
}): AuthClientScope | null {
  if (input.activeTenant) {
    const userId = input.platformUser
      ? `platform:${encodeScopePart(input.platformUser.id)}`
      : input.viewer
        ? `legacy:${encodeScopePart(input.viewer.id)}`
        : null;
    if (!userId) return null;
    const tenantId = String(input.activeTenant.id);
    const membershipId = String(input.activeTenant.membershipId);
    return {
      tenantId,
      membershipId,
      userId,
      key: [
        "tenant", encodeScopePart(tenantId),
        "membership", encodeScopePart(membershipId),
        "user", userId,
      ].join(":"),
    };
  }

  if (input.viewer && !input.platformUser) {
    const staffId = encodeScopePart(input.viewer.id);
    return {
      tenantId: "legacy-default",
      membershipId: `legacy-staff:${staffId}`,
      userId: `legacy:${staffId}`,
      key: `tenant:legacy-default:membership:legacy-staff:${staffId}:user:legacy:${staffId}`,
    };
  }
  return null;
}

/**
 * Keying the authenticated runtime by this value forces local component state,
 * SSE connections and polling loops to remount when identity, tenant or role
 * changes. QueryClient is cleared by StaffAuthProvider at the same boundary.
 */
export function authRuntimeScopeKey(input: {
  platformUser?: PlatformUser | null;
  viewer?: LegacyViewerUser | null;
  activeTenant?: TenantMembershipSummary | null;
}): string {
  const scope = resolveAuthClientScope(input);
  if (scope && input.activeTenant) {
    return `${scope.key}:role:${encodeScopePart(input.activeTenant.role)}:status:${encodeScopePart(input.activeTenant.status)}`;
  }
  if (scope) return scope.key;
  if (input.platformUser) return `platform:${encodeScopePart(input.platformUser.id)}:tenant:none`;
  return "anonymous";
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
