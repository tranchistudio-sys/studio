import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import {
  TenantDatabaseContextError,
  maybeTenantDatabaseContext,
  type BusinessDatabase,
} from "./tenant-context";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const legacyPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  max: 10,
  application_name: "amazing-studio-legacy",
});
// node-postgres emits idle-client failures on the Pool itself. Without an
// error listener, a transient proxy/network disconnect becomes an uncaught
// EventEmitter error and terminates the whole process. Active query failures
// still reject their caller normally; this only keeps idle connection churn
// from crashing startup or the running API.
legacyPool.on("error", (error) => {
  console.error("[db] Unexpected idle client error; pool will replace the connection", error);
});
const legacyDb = drizzle(legacyPool, { schema });

function platformModeEnabled(): boolean {
  return Boolean(process.env.PLATFORM_DATABASE_URL?.trim());
}

function currentPool(): pg.Pool {
  const context = maybeTenantDatabaseContext();
  if (context) return context.pool;
  if (platformModeEnabled()) {
    throw new TenantDatabaseContextError(
      "Business database access outside an explicit tenant context is forbidden in platform mode",
    );
  }
  return legacyPool;
}

function currentDb(): BusinessDatabase {
  const context = maybeTenantDatabaseContext();
  if (context) return context.db;
  if (platformModeEnabled()) {
    throw new TenantDatabaseContextError(
      "Drizzle access outside an explicit tenant context is forbidden in platform mode",
    );
  }
  return legacyDb;
}

function forwardingProxy<T extends object>(target: T, resolve: () => T): T {
  return new Proxy(target, {
    get(_target, property) {
      const current = resolve();
      const value = Reflect.get(current, property, current);
      return typeof value === "function" ? value.bind(current) : value;
    },
    set(_target, property, value) {
      return Reflect.set(resolve(), property, value);
    },
    has(_target, property) {
      return Reflect.has(resolve(), property);
    },
    ownKeys() {
      return Reflect.ownKeys(resolve());
    },
    getOwnPropertyDescriptor(_target, property) {
      return Reflect.getOwnPropertyDescriptor(resolve(), property);
    },
  });
}

// Compatibility facades let existing route modules keep importing `pool` and
// `db`, while every operation is dispatched to the immutable ALS binding.
export const pool: pg.Pool = forwardingProxy(legacyPool, currentPool);
export const db: BusinessDatabase = forwardingProxy(legacyDb, currentDb);

/** Explicit lifecycle hook for legacy-only tests and shutdown. */
export async function closeLegacyDatabasePool(): Promise<void> {
  await legacyPool.end();
}

export * from "./tenant-context";

export * from "./schema";

export * from "./additional-services";
