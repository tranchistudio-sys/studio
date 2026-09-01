import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { requirePlatformOwner } from "../middlewares/platform-owner";
import { getTenantEntitlements, resolveEntitlements } from "./entitlements";
import { assertTenantDatabaseMetadata, TenantDatabaseMetadataMismatchError } from "./tenant-database-metadata";
// @ts-expect-error repository deploy guard utility is intentionally plain ESM
import { containsDestructiveSql } from "../../../../scripts/deploy-guard-sql.mjs";
// @ts-expect-error repository deploy guard utility is intentionally plain ESM
import { lockedMigrationChecksum, verifyLockedMigration } from "../../../../scripts/deploy-guard-policy.mjs";

function authorize(platformRole: "PLATFORM_OWNER" | "PLATFORM_ADMIN" | null, authenticated = true) {
  const status = vi.fn(); const json = vi.fn(); const next = vi.fn();
  status.mockReturnValue({ json });
  const res = { locals: authenticated ? { platformAuth: { platformRole } } : {}, status } as never;
  requirePlatformOwner({} as never, res, next);
  return { status, json, next };
}

describe("Platform Admin authorization", () => {
  it("allows PLATFORM_OWNER", () => expect(authorize("PLATFORM_OWNER").next).toHaveBeenCalledOnce());
  it.each(["PLATFORM_ADMIN", null] as const)("forbids non-owner role %s", role => {
    expect(authorize(role).status).toHaveBeenCalledWith(403);
  });
  it("returns 401 without a session", () => expect(authorize(null, false).status).toHaveBeenCalledWith(401));
  it.each(["tenant OWNER", "tenant ADMIN", "tenant STAFF"])("forbids %s", () => {
    expect(authorize(null).status).toHaveBeenCalledWith(403);
  });
});

describe("commercial idempotency and isolation guards", () => {
  const migration = readFileSync(new URL("../../../../lib/platform-db/migrations/0005_commercial_saas_foundation.sql", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../routes/platform-commercial.ts", import.meta.url), "utf8");
  it("prevents duplicate current subscriptions, setup fees and open provisioning jobs", () => {
    expect(migration).toContain("subscriptions_one_current_per_tenant");
    expect(migration).toContain("platform_payments_setup_fee_tenant_unique");
    expect(migration).toContain("provisioning_jobs_one_open_per_tenant");
  });
  it("extends the current subscription instead of inserting another", () => {
    expect(routes).toContain("UPDATE subscriptions SET current_period_start");
  });
  it("marks setup fee paid through an idempotent conflict path", () => {
    expect(routes).toContain("ON CONFLICT (tenant_id, payment_type)");
    expect(routes).toContain("COALESCE(platform_payments.paid_at,now())");
  });
  it("scopes studio detail, payments and subscription actions by tenant id", () => {
    expect(routes).toContain("WHERE t.id=$1 LIMIT 1");
    expect(routes).toContain("WHERE s.tenant_id=$1 AND s.source='DIRECT'");
    expect(routes).toContain("'tenant',$6,$5::jsonb");
  });
});

describe("deploy guard destructive SQL detection", () => {
  it.each(["DELETE FROM customers", "truncate table customers", "DROP TABLE customers", "ALTER TABLE customers DROP COLUMN name"])(
    "blocks %s", sql => expect(containsDestructiveSql(sql)).toBe(true));
  it.each(["-- DELETE FROM customers\nSELECT 1", "SELECT 'DELETE FROM customers'", "/* DELETE FROM customers */ SELECT 1"])(
    "ignores comments and string literals", sql => expect(containsDestructiveSql(sql)).toBe(false));
  it.each([
    "SELECT '--'; DROP TABLE customers",
    "SELECT '/*'; DELETE FROM customers",
    "SELECT 'it''s -- safe'; TRUNCATE customers",
    'SELECT "--identifier"; ALTER TABLE customers DROP COLUMN name',
    "DO $$ BEGIN RAISE NOTICE '--'; END $$; DROP INDEX customers_idx",
    "DO $body$ BEGIN RAISE NOTICE '/*'; END $body$; DELETE FROM customers",
    "/* outer /* nested */ comment */ DROP VIEW customer_view",
  ])("cannot mask destructive SQL with quoted/comment text: %s", sql => {
    expect(containsDestructiveSql(sql)).toBe(true);
  });
});

describe("locked legacy migration checksum", () => {
  const filename = "0004_seed_amazing_wedding_gifts.sql";
  const expected = "f54c59b96624037c5581238ba0c16032a5c86c7a921d6768ecc65d971e8b83e6";
  const original = readFileSync(new URL(`../../../../lib/db/migrations/${filename}`, import.meta.url), "utf8");
  const checksums = new Map([[filename, expected]]);
  it("accepts the exact locked file and treats CRLF/LF identically", () => {
    expect(lockedMigrationChecksum(original)).toBe(expected);
    expect(lockedMigrationChecksum(original.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"))).toBe(expected);
    expect(verifyLockedMigration(filename, original, checksums)).toMatchObject({ locked:true, valid:true });
  });
  it.each([
    ["one token", (value:string) => value.replace(/DELETE/i, "UPDATE")],
    ["remove DELETE and add UPDATE", (value:string) => value.replace(/DELETE\s+FROM/i, "UPDATE")],
    ["comment", (value:string) => `${value}\n-- changed`],
    ["whitespace", (value:string) => value.replace(" ", "  ")],
  ])("rejects a %s change", (_name, mutate) => {
    expect(verifyLockedMigration(filename, mutate(original), checksums)).toMatchObject({ locked:true, valid:false });
  });
});

describe("commercial entitlements", () => {
  const future = new Date("2030-01-01T00:00:00Z");
  const now = new Date("2026-01-01T00:00:00Z");
  it("STANDARD enables core management only", () => {
    const value = resolveEntitlements({ planCode: "STANDARD", status: "active", expiresAt: future,
      features: { core_management: true }, now });
    expect(value.active).toBe(true); expect(value.features.core_management).toBe(true);
    expect(value.features.ai_lulu).toBe(false);
  });
  it("PRO exposes configured features centrally", () => {
    const value = resolveEntitlements({ planCode: "PRO", status: "active", expiresAt: future,
      features: { core_management: true, website: true, ai_lulu: true, copilot: true }, now });
    expect(value.features).toMatchObject({ core_management: true, website: true, ai_lulu: true, copilot: true });
  });
  it.each(["suspended", "cancelled"])("%s is inactive", status => {
    expect(resolveEntitlements({ planCode: "PRO", status, expiresAt: future,
      features: { core_management: true }, now }).active).toBe(false);
  });
  it("expired period is inactive", () => {
    expect(resolveEntitlements({ planCode: "PRO", status: "active", expiresAt: "2025-01-01",
      features: { core_management: true }, now }).active).toBe(false);
  });
  it("requires an explicit period for commercial plans but preserves legacy manual access", () => {
    expect(resolveEntitlements({ planCode: "PRO", status: "active", features: { core_management:true }, now }).active).toBe(false);
    expect(resolveEntitlements({ planCode: "LEGACY", status: "active", features: { core_management:true }, now }).active).toBe(true);
  });
  it("scopes subscription lookup to the requested tenant", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await getTenantEntitlements("tenant-a", { query } as never);
    expect(query.mock.calls[0]?.[1]).toEqual(["tenant-a"]);
    expect(String(query.mock.calls[0]?.[0])).toContain("s.tenant_id = $1");
  });
});

describe("tenant database fingerprint", () => {
  it("accepts the expected metadata", () => {
    expect(() => assertTenantDatabaseMetadata("a", "abc", ["a"])).not.toThrow();
  });
  it("fails closed on cross-tenant metadata", () => {
    expect(() => assertTenantDatabaseMetadata("a", "abc", ["b"])).toThrow(TenantDatabaseMetadataMismatchError);
  });
  it("only permits empty legacy metadata for Amazing", () => {
    expect(() => assertTenantDatabaseMetadata("a", "amazing-studio", [])).not.toThrow();
    expect(() => assertTenantDatabaseMetadata("a", "abc", [])).toThrow(TenantDatabaseMetadataMismatchError);
  });
});
