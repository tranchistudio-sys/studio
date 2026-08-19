import {
  TenantDatabaseContextError,
  maybeTenantDatabaseContext,
} from "@workspace/db/tenant-context";

const LEGACY_TENANT_SCOPE = "legacy-default";

/**
 * Stable namespace for process-local state that belongs to one business DB.
 *
 * In platform mode an absent ALS binding is a security error: silently sharing
 * a legacy namespace would let one studio observe another studio's cached data.
 */
export function currentTenantScope(): string {
  const context = maybeTenantDatabaseContext();
  if (context) {
    // A tenant can rotate to a replacement database while keeping the same
    // tenant id. Include the router's opaque fingerprint so DB-derived caches
    // can never survive that boundary.
    return `tenant:${context.tenantId}:db:${context.databaseFingerprint ?? context.databaseRef}`;
  }
  if (process.env.PLATFORM_DATABASE_URL?.trim()) {
    throw new TenantDatabaseContextError(
      "Tenant context is required for tenant-scoped process state in platform mode",
    );
  }
  return LEGACY_TENANT_SCOPE;
}

/** Collision-safe key for maps whose logical key is only unique within a tenant. */
export function tenantScopedKey(...parts: ReadonlyArray<string | number>): string {
  return JSON.stringify([currentTenantScope(), ...parts.map(String)]);
}
