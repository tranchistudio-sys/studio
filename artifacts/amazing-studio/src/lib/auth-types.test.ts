import { describe, expect, it } from "vitest";
import {
  authRuntimeScopeKey,
  authNeedsStudioSelection,
  canManageTenantMembers,
  legacyViewerCanAdmin,
  normalizeAuthResponse,
  resolveAuthClientScope,
  resolveAuthClientState,
  resolveTenantAdmin,
  tenantCanRunApp,
  type LegacyViewerUser,
  type PlatformUser,
  type TenantMembershipSummary,
} from "./auth-types";

const tenant = (status: string, role: "OWNER" | "ADMIN" | "STAFF" = "STAFF"): TenantMembershipSummary => ({
  id: "tenant-1",
  membershipId: "membership-1",
  name: "Amazing Studio",
  slug: "amazing-studio",
  status,
  role,
});

const legacyAdmin: LegacyViewerUser = {
  id: 7,
  name: "Legacy Admin",
  role: "admin",
  roles: ["admin"],
};

const platformUser: PlatformUser = { id: "user-1", name: "Hoa" };

describe("auth types", () => {
  it("keeps the legacy /auth/me payload compatible", () => {
    const normalized = normalizeAuthResponse({ id: 7, name: "Hoa", role: "sale", roles: ["sale"] });
    expect(normalized?.user?.id).toBe(7);
  });

  it("does not confuse tenant ADMIN with platform roles", () => {
    expect(canManageTenantMembers("OWNER")).toBe(true);
    expect(canManageTenantMembers("ADMIN")).toBe(true);
    expect(canManageTenantMembers("STAFF")).toBe(false);
  });

  it("never lets a legacy admin role override an authoritative STAFF membership", () => {
    expect(legacyViewerCanAdmin(legacyAdmin)).toBe(true);
    expect(resolveTenantAdmin(tenant("active", "STAFF"), legacyAdmin)).toBe(false);
    expect(resolveTenantAdmin(tenant("active", "ADMIN"), {
      ...legacyAdmin,
      role: "sale",
      roles: ["sale"],
    })).toBe(true);
  });

  it("starts platform sessions from the cookie and discards a stale legacy token", () => {
    const state = resolveAuthClientState({
      platformEnabled: true,
      platformUser,
      activeTenant: tenant("active", "OWNER"),
      memberships: [tenant("active", "OWNER")],
    }, "stale-local-token");

    expect(state.platformSession).toBe(true);
    expect(state.token).toBeNull();
    expect(state.requiresTenantSelection).toBe(false);
  });

  it("keeps the stored token only for a compatible legacy startup", () => {
    const state = resolveAuthClientState({ user: legacyAdmin }, "legacy-token");
    expect(state.platformSession).toBe(false);
    expect(state.token).toBe("legacy-token");
  });

  it("routes a platform identity without an active tenant to studio selection", () => {
    expect(authNeedsStudioSelection({
      platformUser,
      memberships: [tenant("active")],
    })).toBe(true);
    expect(authNeedsStudioSelection({
      platformUser,
      activeTenant: tenant("active"),
      memberships: [tenant("active")],
    })).toBe(false);
    expect(authNeedsStudioSelection({
      memberships: [tenant("active"), { ...tenant("active"), id: "tenant-2" }],
    })).toBe(true);
  });

  it("only lets active and trial tenants enter the app", () => {
    expect(tenantCanRunApp(tenant("active"))).toBe(true);
    expect(tenantCanRunApp(tenant("trial"))).toBe(true);
    expect(tenantCanRunApp(tenant("suspended"))).toBe(false);
    expect(tenantCanRunApp(tenant("provisioning_failed"))).toBe(false);
  });

  it("scopes durable browser state by tenant, membership and user", () => {
    const first = resolveAuthClientScope({
      platformUser,
      activeTenant: tenant("active", "OWNER"),
    });
    const otherTenant = resolveAuthClientScope({
      platformUser,
      activeTenant: { ...tenant("active", "OWNER"), id: "tenant-2", membershipId: "membership-2" },
    });
    const otherUser = resolveAuthClientScope({
      platformUser: { ...platformUser, id: "user-2" },
      activeTenant: tenant("active", "OWNER"),
    });

    expect(first).toMatchObject({
      tenantId: "tenant-1",
      membershipId: "membership-1",
      userId: "platform:user-1",
    });
    expect(first?.key).not.toBe(otherTenant?.key);
    expect(first?.key).not.toBe(otherUser?.key);
  });

  it("pauses tenant-owned browser state until a platform tenant is selected", () => {
    expect(resolveAuthClientScope({ platformUser })).toBeNull();
    expect(resolveAuthClientScope({})).toBeNull();
    expect(resolveAuthClientScope({ viewer: legacyAdmin })).toMatchObject({
      tenantId: "legacy-default",
      userId: "legacy:7",
    });
  });

  it("changes the runtime boundary when tenant role or status changes", () => {
    const owner = authRuntimeScopeKey({ platformUser, activeTenant: tenant("active", "OWNER") });
    const staff = authRuntimeScopeKey({ platformUser, activeTenant: tenant("active", "STAFF") });
    const suspended = authRuntimeScopeKey({ platformUser, activeTenant: tenant("suspended", "OWNER") });

    expect(owner).not.toBe(staff);
    expect(owner).not.toBe(suspended);
    expect(authRuntimeScopeKey({ platformUser })).toBe("platform:user-1:tenant:none");
  });
});
