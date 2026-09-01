import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@workspace/db/schema";
import {
  getTenantDatabaseContext,
  runWithTenantDatabase,
  type TenantDatabaseContext,
} from "@workspace/db";
import { getPlatformPool } from "@workspace/platform-db";
import {
  registryMatchesAmazingRuntime,
  type TenantDatabaseRegistryRow,
} from "./tenant-database-reference";
import { assertTenantDatabaseMetadata } from "./tenant-database-metadata";

const { Pool } = pg;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SECRET_ENV = /^(?:DEFAULT_TENANT_DATABASE_URL|TENANT_[A-Z0-9_]*_DATABASE_URL)$/;
const REGISTRY_CACHE_TTL_MS = 15_000;
const CIRCUIT_OPEN_MS = 10_000;
const NEW_POOL_EVICTION_GRACE_MS = 1_000;

interface RegistryRecord extends TenantDatabaseRegistryRow {
  tenant_id: string;
  tenant_slug: string;
  tenant_status: string;
  encrypted_secret: Buffer | null;
  updated_at: Date | string;
}

interface ParsedDatabaseReference {
  hostRef: string;
  databaseName: string;
  roleName: string;
  physicalIdentity: string;
}

interface ResolvedRegistry {
  record: RegistryRecord;
  connectionString: string;
  fingerprint: string;
}

interface PoolEntry {
  context: TenantDatabaseContext;
  fingerprint: string;
  refs: number;
  lastUsedAt: number;
  retired: boolean;
  circuitOpenUntil: number;
  closing?: Promise<void>;
}

export interface TenantDatabaseLease {
  readonly context: TenantDatabaseContext;
  release(): Promise<void>;
}

export class TenantDatabaseUnavailableError extends Error {
  readonly code = "TENANT_DATABASE_UNAVAILABLE";

  constructor() {
    super("Tenant database is unavailable");
    this.name = "TenantDatabaseUnavailableError";
  }
}

const registryCache = new Map<string, { expiresAt: number; record: RegistryRecord | null }>();
const entries = new Map<string, PoolEntry>();
const allEntries = new Set<PoolEntry>();
const pendingEntries = new Map<string, Promise<PoolEntry>>();
let poolCreationTail: Promise<void> = Promise.resolve();

async function serializePoolCreation<T>(work: () => Promise<T>): Promise<T> {
  const previous = poolCreationTail;
  let release!: () => void;
  poolCreationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function configuredInteger(name: string, fallback: number, maximum: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function parseDatabaseReference(raw: string): ParsedDatabaseReference {
  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new TenantDatabaseUnavailableError();
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const roleName = decodeURIComponent(url.username);
  if (!url.hostname || !databaseName || !roleName) {
    throw new TenantDatabaseUnavailableError();
  }
  const hostRef = url.host.toLowerCase();
  return {
    hostRef,
    databaseName,
    roleName,
    physicalIdentity: `${hostRef}/${databaseName}`,
  };
}

function resolveSecret(record: RegistryRecord): string {
  if (record.encrypted_secret || !record.secret_ref?.startsWith("env:")) {
    // Encrypted/secret-manager values are introduced by provisioning PR 3.
    throw new TenantDatabaseUnavailableError();
  }
  const envName = record.secret_ref.slice(4);
  if (!ALLOWED_SECRET_ENV.test(envName)) throw new TenantDatabaseUnavailableError();
  const value = process.env[envName]?.trim();
  if (!value) throw new TenantDatabaseUnavailableError();
  return value;
}

function assertRegistryMatchesSecret(record: RegistryRecord, connectionString: string): void {
  const parsed = parseDatabaseReference(connectionString);
  if (
    parsed.hostRef !== record.host_ref.toLowerCase() ||
    parsed.databaseName !== record.database_name ||
    parsed.roleName !== record.role_name
  ) {
    throw new TenantDatabaseUnavailableError();
  }

  const platformUrl = process.env.PLATFORM_DATABASE_URL?.trim();
  if (platformUrl && parseDatabaseReference(platformUrl).physicalIdentity === parsed.physicalIdentity) {
    throw new TenantDatabaseUnavailableError();
  }

  if (record.tenant_slug === "amazing-studio" && !registryMatchesAmazingRuntime(record)) {
    throw new TenantDatabaseUnavailableError();
  }
}

function registryFingerprint(record: RegistryRecord, connectionString: string): string {
  return createHash("sha256")
    .update([
      record.tenant_id,
      record.database_ref,
      record.host_ref,
      record.database_name,
      record.role_name,
      record.secret_ref ?? "",
      new Date(record.updated_at).toISOString(),
      connectionString,
    ].join("\u0000"))
    .digest("base64url");
}

async function registryByTenantId(tenantId: string): Promise<RegistryRecord | null> {
  if (!UUID_PATTERN.test(tenantId)) throw new TenantDatabaseUnavailableError();
  const cached = registryCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.record;

  const result = await getPlatformPool().query<RegistryRecord>(
    `SELECT r.tenant_id, t.slug AS tenant_slug, t.status AS tenant_status,
            r.database_ref, r.host_ref, r.database_name, r.role_name,
            r.secret_ref, r.encrypted_secret, r.updated_at
       FROM tenant_database_registry r
       JOIN tenants t ON t.id = r.tenant_id
      WHERE r.tenant_id = $1
      LIMIT 1`,
    [tenantId],
  );
  const record = result.rows[0] ?? null;
  registryCache.set(tenantId, { expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS, record });
  return record;
}

async function tenantIdBySlug(slug: string): Promise<string> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new TenantDatabaseUnavailableError();
  const result = await getPlatformPool().query<{ id: string }>(
    `SELECT t.id
       FROM tenants t
       JOIN tenant_database_registry r ON r.tenant_id = t.id
      WHERE t.slug = $1 AND t.status IN ('active', 'trial')
      LIMIT 1`,
    [slug],
  );
  if (!result.rows[0]) throw new TenantDatabaseUnavailableError();
  return result.rows[0].id;
}

async function resolveRegistry(tenantId: string): Promise<ResolvedRegistry> {
  let record: RegistryRecord | null;
  try {
    record = await registryByTenantId(tenantId);
  } catch (error) {
    if (error instanceof TenantDatabaseUnavailableError) throw error;
    throw new TenantDatabaseUnavailableError();
  }
  if (!record || (record.tenant_status !== "active" && record.tenant_status !== "trial")) {
    throw new TenantDatabaseUnavailableError();
  }
  const connectionString = resolveSecret(record);
  assertRegistryMatchesSecret(record, connectionString);
  return {
    record,
    connectionString,
    fingerprint: registryFingerprint(record, connectionString),
  };
}

async function closeEntry(entry: PoolEntry): Promise<void> {
  if (!entry.closing) {
    entry.closing = entry.context.pool.end().catch(() => undefined);
  }
  await entry.closing;
  allEntries.delete(entry);
}

async function ensurePoolCapacity(): Promise<void> {
  const maximum = configuredInteger("TENANT_DB_MAX_POOLS", 20, 100);
  if (allEntries.size < maximum) return;
  const now = Date.now();
  const idle = [...allEntries]
    .filter((entry) => entry.refs === 0 && now - entry.lastUsedAt >= NEW_POOL_EVICTION_GRACE_MS)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  while (allEntries.size >= maximum && idle.length > 0) {
    const entry = idle.shift()!;
    if (entries.get(entry.context.tenantId) === entry) entries.delete(entry.context.tenantId);
    entry.retired = true;
    await closeEntry(entry);
  }
  if (allEntries.size >= maximum) throw new TenantDatabaseUnavailableError();
}

async function createEntry(resolved: ResolvedRegistry): Promise<PoolEntry> {
  // Capacity decisions and insertion into allEntries must be atomic across
  // different tenants; otherwise simultaneous cold starts can exceed the
  // configured global pool bound.
  return serializePoolCreation(async () => {
    await ensurePoolCapacity();
    const pool = new Pool({
      connectionString: resolved.connectionString,
      max: configuredInteger("TENANT_DB_POOL_MAX", 6, 20),
      idleTimeoutMillis: configuredInteger("TENANT_DB_IDLE_TIMEOUT_MS", 30_000, 300_000),
      connectionTimeoutMillis: configuredInteger("TENANT_DB_CONNECT_TIMEOUT_MS", 5_000, 30_000),
      application_name: "amazing-studio-tenant",
    });
    const context: TenantDatabaseContext = {
      tenantId: resolved.record.tenant_id,
      tenantSlug: resolved.record.tenant_slug,
      databaseRef: resolved.record.database_ref,
      databaseFingerprint: resolved.fingerprint,
      pool,
      db: drizzle(pool, { schema }),
    };
    const entry: PoolEntry = {
      context,
      fingerprint: resolved.fingerprint,
      refs: 0,
      lastUsedAt: Date.now(),
      retired: false,
      circuitOpenUntil: 0,
    };
    pool.on("error", () => {
      entry.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    });
    try {
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        const metadata = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id::text FROM tenant_metadata LIMIT 2`,
        ).catch((error: { code?: string }) => {
          if (error.code === "42P01" && resolved.record.tenant_slug === "amazing-studio") {
            return { rows: [] } as { rows: { tenant_id: string }[] };
          }
          throw error;
        });
        assertTenantDatabaseMetadata(
          resolved.record.tenant_id,
          resolved.record.tenant_slug,
          metadata.rows.map((row) => row.tenant_id),
        );
      } finally {
        client.release();
      }
    } catch {
      await pool.end().catch(() => undefined);
      throw new TenantDatabaseUnavailableError();
    }
    allEntries.add(entry);
    return entry;
  });
}


async function entryForTenant(tenantId: string): Promise<PoolEntry> {
  const resolved = await resolveRegistry(tenantId);
  const existing = entries.get(tenantId);
  if (existing && existing.fingerprint === resolved.fingerprint) {
    if (existing.circuitOpenUntil > Date.now()) throw new TenantDatabaseUnavailableError();
    existing.refs += 1;
    existing.lastUsedAt = Date.now();
    return existing;
  }

  let pending = pendingEntries.get(tenantId);
  if (!pending) {
    pending = (async () => {
      const previous = entries.get(tenantId);
      if (previous) {
        previous.retired = true;
        entries.delete(tenantId);
        if (previous.refs === 0) await closeEntry(previous);
      }
      const created = await createEntry(resolved);
      entries.set(tenantId, created);
      return created;
    })().finally(() => pendingEntries.delete(tenantId));
    pendingEntries.set(tenantId, pending);
  }
  const entry = await pending;
  // Reserve the lease before resolving to acquireTenantDatabase. Newly-created
  // zero-ref entries also have a short eviction grace so another tenant's cold
  // start cannot close the pool between promise reactions.
  entry.refs += 1;
  entry.lastUsedAt = Date.now();
  return entry;
}

export async function acquireTenantDatabase(tenantId: string): Promise<TenantDatabaseLease> {
  let entry: PoolEntry;
  try {
    entry = await entryForTenant(tenantId);
  } catch (error) {
    if (error instanceof TenantDatabaseUnavailableError) throw error;
    throw new TenantDatabaseUnavailableError();
  }
  return leaseForEntry(entry);
}

function leaseForEntry(entry: PoolEntry): TenantDatabaseLease {
  let released = false;
  return {
    context: entry.context,
    async release() {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      entry.lastUsedAt = Date.now();
      if (entry.retired && entry.refs === 0) await closeEntry(entry);
    },
  };
}

/**
 * Extends the lease already held by the current ALS scope for detached work
 * that may finish after the originating HTTP response releases its lease.
 */
export function retainCurrentTenantDatabaseLease(): TenantDatabaseLease {
  let context: TenantDatabaseContext;
  try {
    context = getTenantDatabaseContext();
  } catch {
    throw new TenantDatabaseUnavailableError();
  }
  const entry = [...allEntries].find((candidate) => (
    candidate.context === context && !candidate.closing && candidate.refs > 0
  ));
  if (!entry) throw new TenantDatabaseUnavailableError();
  entry.refs += 1;
  entry.lastUsedAt = Date.now();
  return leaseForEntry(entry);
}

export async function acquireTenantDatabaseBySlug(slug: string): Promise<TenantDatabaseLease> {
  return acquireTenantDatabase(await tenantIdBySlug(slug));
}

export async function withTenantDatabase<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  const lease = await acquireTenantDatabase(tenantId);
  try {
    return await runWithTenantDatabase(lease.context, work);
  } finally {
    await lease.release();
  }
}

export async function withTenantDatabaseBySlug<T>(slug: string, work: () => Promise<T>): Promise<T> {
  return withTenantDatabase(await tenantIdBySlug(slug), work);
}

export async function assertTenantDatabaseAvailable(tenantId: string): Promise<void> {
  const lease = await acquireTenantDatabase(tenantId);
  await lease.release();
}

export async function listRoutableTenantIds(): Promise<string[]> {
  try {
    const result = await getPlatformPool().query<{ id: string }>(
      `SELECT t.id
         FROM tenants t
         JOIN tenant_database_registry r ON r.tenant_id = t.id
        WHERE t.status IN ('active', 'trial')
        ORDER BY t.id`,
    );
    return result.rows.map((row) => row.id);
  } catch {
    throw new TenantDatabaseUnavailableError();
  }
}

export async function forEachRoutableTenant(
  work: (tenantId: string) => Promise<void>,
): Promise<void> {
  for (const tenantId of await listRoutableTenantIds()) {
    try {
      await withTenantDatabase(tenantId, () => work(tenantId));
    } catch {
      // A failed tenant must not stop or redirect the job to another database.
      continue;
    }
  }
}

export function invalidateTenantDatabaseRegistry(tenantId?: string): void {
  if (tenantId) registryCache.delete(tenantId);
  else registryCache.clear();
}

export async function closeTenantDatabaseRouter(): Promise<void> {
  // Server shutdown happens after HTTP close, so no new leases should enter.
  // Let cold-start attempts settle first; otherwise a pool can be added after
  // the close snapshot and keep the process alive.
  await Promise.allSettled([...pendingEntries.values()]);
  await poolCreationTail;
  registryCache.clear();
  entries.clear();
  pendingEntries.clear();
  const current = [...allEntries];
  for (const entry of current) {
    entry.retired = true;
    await closeEntry(entry);
  }
}

/** Test-only state without credentials, hosts, or database names. */
export function tenantDatabaseRouterStats(): { pools: number; activeLeases: number } {
  return {
    pools: allEntries.size,
    activeLeases: [...allEntries].reduce((sum, entry) => sum + entry.refs, 0),
  };
}
