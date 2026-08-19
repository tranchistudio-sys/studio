import { afterEach, describe, expect, it } from "vitest";
import { runWithTenantDatabase } from "@workspace/db";
import { currentTenantScope, tenantScopedKey } from "./tenant-scope";

const originalPlatformUrl = process.env.PLATFORM_DATABASE_URL;

function inTenant<T>(tenantId: string, work: () => T): T {
  return runWithTenantDatabase({
    tenantId,
    tenantSlug: tenantId,
    databaseRef: `db-${tenantId}`,
    pool: {} as never,
    db: {} as never,
  }, work);
}

afterEach(() => {
  if (originalPlatformUrl === undefined) delete process.env.PLATFORM_DATABASE_URL;
  else process.env.PLATFORM_DATABASE_URL = originalPlatformUrl;
});

describe("tenant-scoped process state", () => {
  it("namespaces identical logical keys by immutable tenant id", () => {
    delete process.env.PLATFORM_DATABASE_URL;
    const a = inTenant("studio-a", () => tenantScopedKey("staff", 7));
    const b = inTenant("studio-b", () => tenantScopedKey("staff", 7));

    expect(a).not.toBe(b);
    expect(inTenant("studio-a", () => tenantScopedKey("staff", 7))).toBe(a);
  });

  it("keeps legacy single-tenant behavior when platform mode is disabled", () => {
    delete process.env.PLATFORM_DATABASE_URL;
    expect(currentTenantScope()).toBe("legacy-default");
  });

  it("fails closed instead of using a shared fallback in platform mode", () => {
    process.env.PLATFORM_DATABASE_URL = "postgresql://platform.invalid/platform";
    expect(() => tenantScopedKey("same-id")).toThrowError(
      expect.objectContaining({ code: "TENANT_DATABASE_CONTEXT_REQUIRED" }),
    );
  });
});
