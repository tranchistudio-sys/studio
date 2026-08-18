import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closePlatformPool, getPlatformPool } from "./index";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(packageRoot, "migrations");

async function main() {
  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
    .sort();

  if (files.length === 0) throw new Error("Không tìm thấy platform migration");

  const pool = getPlatformPool();
  const businessTables = await pool.query<{
    customers: string | null;
    bookings: string | null;
    payments: string | null;
  }>(`SELECT
        to_regclass('public.customers')::text AS customers,
        to_regclass('public.bookings')::text AS bookings,
        to_regclass('public.payments')::text AS payments`);
  if (Object.values(businessTables.rows[0] ?? {}).some(Boolean)) {
    throw new Error(
      "Từ chối migration: PLATFORM_DATABASE_URL có bảng nghiệp vụ customers/bookings/payments",
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum_sha256 TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    "ALTER TABLE platform_schema_migrations ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT",
  );

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const exists = await pool.query<{ filename: string; checksum_sha256: string | null }>(
      "SELECT filename, checksum_sha256 FROM platform_schema_migrations WHERE filename = $1",
      [file],
    );
    if (exists.rows[0]) {
      if (exists.rows[0].checksum_sha256 && exists.rows[0].checksum_sha256 !== checksum) {
        throw new Error(`Checksum platform migration đã thay đổi sau khi áp dụng: ${file}`);
      }
      if (!exists.rows[0].checksum_sha256) {
        await pool.query(
          "UPDATE platform_schema_migrations SET checksum_sha256 = $2 WHERE filename = $1",
          [file, checksum],
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO platform_schema_migrations (filename, checksum_sha256) VALUES ($1, $2)",
        [file, checksum],
      );
      await client.query("COMMIT");
      console.log(`[platform-db] applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

main()
  .finally(() => closePlatformPool())
  .catch((error) => {
    console.error("[platform-db] migration failed", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
