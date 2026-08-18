import { AsyncLocalStorage } from "node:async_hooks";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type * as schema from "./schema";

export type BusinessDatabase = NodePgDatabase<typeof schema>;

export interface TenantDatabaseContext {
  tenantId: string;
  tenantSlug: string;
  databaseRef: string;
  /** Opaque router fingerprint; namespaces process state across DB rotation. */
  databaseFingerprint?: string;
  pool: pg.Pool;
  db: BusinessDatabase;
}

export interface TenantDatabaseIdentity {
  tenantId: string;
  tenantSlug: string;
  databaseRef: string;
}

export class TenantDatabaseContextError extends Error {
  readonly code = "TENANT_DATABASE_CONTEXT_REQUIRED";

  constructor(message = "Tenant database context is required") {
    super(message);
    this.name = "TenantDatabaseContextError";
  }
}

const tenantDatabaseStorage = new AsyncLocalStorage<TenantDatabaseContext>();

export function runWithTenantDatabase<T>(
  context: TenantDatabaseContext,
  work: () => T,
): T {
  return tenantDatabaseStorage.run(context, work);
}

export function getTenantDatabaseContext(): TenantDatabaseContext {
  const context = tenantDatabaseStorage.getStore();
  if (!context) throw new TenantDatabaseContextError();
  return context;
}

export function maybeTenantDatabaseContext(): TenantDatabaseContext | undefined {
  return tenantDatabaseStorage.getStore();
}

export function getTenantDatabaseIdentity(): TenantDatabaseIdentity {
  const { tenantId, tenantSlug, databaseRef } = getTenantDatabaseContext();
  return { tenantId, tenantSlug, databaseRef };
}
