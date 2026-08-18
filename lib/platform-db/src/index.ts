import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";

const { Pool } = pg;

let platformPool: pg.Pool | null = null;

export interface PlatformQueryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

function normalizedDatabaseIdentity(raw: string): string {
  const url = new URL(raw);
  return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname}`;
}

export function isPlatformDatabaseConfigured(): boolean {
  return Boolean(process.env.PLATFORM_DATABASE_URL?.trim());
}

export function getPlatformPool(): pg.Pool {
  const connectionString = process.env.PLATFORM_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("PLATFORM_DATABASE_URL chưa được cấu hình");
  }

  const tenantConnectionString = process.env.DATABASE_URL?.trim();
  if (
    tenantConnectionString &&
    normalizedDatabaseIdentity(connectionString) === normalizedDatabaseIdentity(tenantConnectionString)
  ) {
    throw new Error(
      "PLATFORM_DATABASE_URL phải trỏ tới database nền tảng riêng, không được dùng chung DATABASE_URL nghiệp vụ",
    );
  }

  if (!platformPool) {
    const configuredMax = Number(process.env.PLATFORM_DB_POOL_MAX ?? "10");
    const max = Number.isInteger(configuredMax) && configuredMax > 0
      ? Math.min(configuredMax, 20)
      : 10;
    platformPool = new Pool({
      connectionString,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "amazing-studio-platform",
    });
    platformPool.on("error", (error: NodeJS.ErrnoException) => {
      // Do not serialize the Error object: connection strings or host details
      // must not reach logs. Idle-client errors are recoverable by pg.Pool.
      console.error(`[platform-db] idle client error code=${error.code ?? "unknown"}`);
    });
  }
  return platformPool;
}

export async function withPlatformTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPlatformPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '15000ms'");
    await client.query("SET LOCAL lock_timeout = '5000ms'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function closePlatformPool(): Promise<void> {
  const current = platformPool;
  platformPool = null;
  if (current) await current.end();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
