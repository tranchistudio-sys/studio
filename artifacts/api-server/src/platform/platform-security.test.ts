import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn() },
}));

import { GoogleAuthenticationError, validateGooglePayload } from "./service";
import {
  createPlatformSession,
  DEFAULT_SESSION_TTL_HOURS,
  MAX_SESSION_TTL_HOURS,
  platformSessionContextIsActive,
  platformSessionTtlHours,
  setPlatformSessionCookie,
} from "./session";
import {
  DEFAULT_LEGACY_SESSION_TTL_SECONDS,
  readLegacyToken,
  signLegacyToken,
} from "../lib/legacy-auth-token";
import type { PlatformSessionContext } from "./types";
import { LOGGER_REDACT_PATHS } from "../lib/log-redaction";
import {
  registryMatchesAmazingRuntime,
  resolveAmazingTenantDatabaseReference,
} from "./tenant-database-reference";

const originalNodeEnv = process.env.NODE_ENV;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalDefaultTenantUrl = process.env.DEFAULT_TENANT_DATABASE_URL;
const originalSessionTtlHours = process.env.PLATFORM_SESSION_TTL_HOURS;
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalDefaultTenantUrl === undefined) delete process.env.DEFAULT_TENANT_DATABASE_URL;
  else process.env.DEFAULT_TENANT_DATABASE_URL = originalDefaultTenantUrl;
  if (originalSessionTtlHours === undefined) delete process.env.PLATFORM_SESSION_TTL_HOURS;
  else process.env.PLATFORM_SESSION_TTL_HOURS = originalSessionTtlHours;
});

const activeContext = (): PlatformSessionContext => ({
  sessionId: "session",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  userId: "user",
  userStatus: "active",
  platformRole: null,
  activeTenantId: "tenant",
  tenantStatus: "active",
  membershipId: "membership",
  membershipStatus: "active",
  tenantRole: "STAFF",
  tenantStaffId: 7,
  csrfTokenHash: "hash",
  expiresAt: new Date(Date.now() + 60_000),
});

describe("Google identity validation", () => {
  it("dùng sub làm định danh và chuẩn hóa email", () => {
    const profile = validateGooglePayload({
      sub: "google-sub-immutable",
      email: " Owner@Gmail.Com ",
      email_verified: true,
      name: "Studio Owner",
    } as any);
    expect(profile).toEqual(expect.objectContaining({
      sub: "google-sub-immutable",
      email: "owner@gmail.com",
    }));
  });

  it("từ chối email chưa verified", () => {
    expect(() => validateGooglePayload({
      sub: "sub",
      email: "staff@gmail.com",
      email_verified: false,
    } as any)).toThrow(GoogleAuthenticationError);
  });
});

describe("session policy", () => {
  it("giữ phiên đăng nhập 180 ngày và không cho cấu hình vượt trần", () => {
    delete process.env.PLATFORM_SESSION_TTL_HOURS;
    expect(platformSessionTtlHours()).toBe(24 * 180);
    expect(DEFAULT_SESSION_TTL_HOURS).toBe(24 * 180);

    process.env.PLATFORM_SESSION_TTL_HOURS = String(24 * 365);
    expect(platformSessionTtlHours()).toBe(MAX_SESSION_TTL_HOURS);

    process.env.PLATFORM_SESSION_TTL_HOURS = "khong-hop-le";
    expect(platformSessionTtlHours()).toBe(DEFAULT_SESSION_TTL_HOURS);
  });

  it("lưu ngày hết hạn 180 ngày ở server cho phiên Google và mật khẩu dùng chung", async () => {
    delete process.env.PLATFORM_SESSION_TTL_HOURS;
    const before = Date.now();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const session = await createPlatformSession(
      { query } as any,
      { get: vi.fn().mockReturnValue("test-browser"), ip: "127.0.0.1", socket: {} } as any,
      "user",
      { tenantId: "tenant", membershipId: null, tenantStaffId: 7 },
    );
    const expectedMs = 180 * 24 * 60 * 60_000;
    expect(session.expiresAt.getTime() - before).toBeGreaterThanOrEqual(expectedMs);
    expect(session.expiresAt.getTime() - before).toBeLessThan(expectedMs + 2_000);
    expect(query).toHaveBeenCalled();
  });

  it("fallback đăng nhập cũ cũng phát hành token 180 ngày", () => {
    const payload = readLegacyToken(`Bearer ${signLegacyToken(7)}`);
    expect(payload).not.toBeNull();
    expect((payload?.exp ?? 0) - (payload?.iat ?? 0)).toBe(DEFAULT_LEGACY_SESSION_TTL_SECONDS);
    expect(DEFAULT_LEGACY_SESSION_TTL_SECONDS).toBe(180 * 24 * 60 * 60);
  });

  it("kiểm tra lại user, tenant và membership mỗi request", () => {
    expect(platformSessionContextIsActive(activeContext())).toBe(true);
    expect(platformSessionContextIsActive({ ...activeContext(), userStatus: "suspended" })).toBe(false);
    expect(platformSessionContextIsActive({ ...activeContext(), tenantStatus: "suspended" })).toBe(false);
    expect(platformSessionContextIsActive({ ...activeContext(), membershipStatus: "suspended" })).toBe(false);
  });

  it("cookie production có HttpOnly, Secure, SameSite=Lax và Path=/", () => {
    process.env.NODE_ENV = "production";
    const cookie = vi.fn();
    setPlatformSessionCookie({ cookie } as any, "opaque", new Date(Date.now() + 60_000));
    expect(cookie).toHaveBeenCalledWith("amazing_session", "opaque", expect.objectContaining({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    }));
  });
});

describe("Amazing tenant database reference", () => {
  it("chỉ chấp nhận registry khớp đúng database runtime hiện tại", () => {
    process.env.DATABASE_URL = "postgresql://tenant_role:secret@db.test:5432/amazing_current";
    process.env.DEFAULT_TENANT_DATABASE_URL = "postgresql://tenant_role:another@db.test:5432/amazing_current";
    expect(resolveAmazingTenantDatabaseReference()).toEqual({
      hostRef: "db.test:5432",
      databaseName: "amazing_current",
      roleName: "tenant_role",
    });
    expect(registryMatchesAmazingRuntime({
      database_ref: "amazing-studio-current-production",
      host_ref: "db.test:5432",
      database_name: "amazing_current",
      role_name: "tenant_role",
      secret_ref: "env:DEFAULT_TENANT_DATABASE_URL",
    })).toBe(true);
  });

  it("fail closed khi DEFAULT_TENANT_DATABASE_URL trỏ database khác", () => {
    process.env.DATABASE_URL = "postgresql://tenant_role:secret@db.test/amazing_current";
    process.env.DEFAULT_TENANT_DATABASE_URL = "postgresql://tenant_role:secret@db.test/studio_b";
    expect(() => resolveAmazingTenantDatabaseReference()).toThrow(/không khớp DATABASE_URL/i);
  });
});

describe("platform migration safety", () => {
  it("chỉ tạo platform tables và không chứa DDL phá dữ liệu", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const migrationDirectory = path.resolve(here, "../../../../lib/platform-db/migrations");
    const filenames = (await readdir(migrationDirectory))
      .filter((filename) => /^\d+_[a-z0-9_-]+\.sql$/i.test(filename))
      .sort();
    const migrationEntries = await Promise.all(filenames.map(async (filename) => [
      filename,
      await readFile(path.join(migrationDirectory, filename), "utf8"),
    ] as const));
    const migrations = new Map(migrationEntries);
    const foundation = migrations.get("0001_platform_foundation.sql") ?? "";
    const revocation = migrations.get("0002_membership_session_revocation.sql") ?? "";
    const isolation = migrations.get("0003_tenant_database_registry_isolation.sql") ?? "";
    const statements = migrationEntries.map(([, sql]) => sql).join("\n").replace(/--.*$/gm, "");
    expect(statements).not.toMatch(/\b(?:DROP|TRUNCATE)\b/i);
    expect(statements).not.toMatch(/CREATE TABLE IF NOT EXISTS (?:customers|bookings|payments)\b/i);
    for (const table of [
      "platform_users",
      "auth_identities",
      "tenants",
      "tenant_memberships",
      "tenant_invitations",
      "sessions",
    ]) {
      expect(foundation).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(revocation).toContain("ADD COLUMN IF NOT EXISTS auth_version");
    expect(revocation).toContain("ADD COLUMN IF NOT EXISTS sessions_revoked_at");
    expect(isolation).toContain("tenant_database_registry_physical_database_unique");
    expect(isolation).toMatch(/ON tenant_database_registry \(host_ref, database_name\)/);
  });
});


describe("API code-only deployment safety", () => {
  it("chỉ thay API, giữ rollback và tuyệt đối không thao tác database", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const script = await readFile(
      path.resolve(here, "../../../../scripts/vps-deploy-api-code-only.sh"),
      "utf8",
    );
    const commands = script.replace(/^[[:space:]]*#.*$/gm, "");
    expect(commands).toContain("PLATFORM_SESSION_TTL_HOURS");
    expect(commands).toContain("4320");
    expect(commands).toContain("ROLLBACK_API_IMAGE");
    expect(script).toMatch(/--no-deps\s+--force-recreate/);
    expect(script).not.toMatch(/\b(?:psql|pg_dump|createdb|dropdb|drizzle)\b/i);
    expect(script).not.toMatch(/\bdb\s+push\b/i);
    expect(script).not.toMatch(/\b(?:migrate|migration|seed)\b/i);
    expect(script).not.toMatch(/docker\s+(?:compose\s+[^\n]*\s+down|system\s+prune)/i);
  });
});
describe("sensitive logging policy", () => {
  it("redact auth token, cookie, Google credential và password", () => {
    expect(LOGGER_REDACT_PATHS).toEqual(expect.arrayContaining([
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.password",
      "req.body.credential",
      "res.headers['set-cookie']",
      "*.refreshToken",
      "*.databaseUrl",
    ]));
  });

  it("auth/platform source không console-log secret-bearing request fields", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const files = [
      path.resolve(here, "../routes/auth.ts"),
      path.resolve(here, "../routes/platform-auth.ts"),
      path.resolve(here, "service.ts"),
      path.resolve(here, "session.ts"),
    ];
    const source = (await Promise.all(files.map(file => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/console\.(?:log|warn|error)\([^\n]*(?:credential|password|cookie|DATABASE_URL)/i);
  });

  it("cài runtime console redaction trước khi import app và legacy routes", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const indexSource = await readFile(path.resolve(here, "../index.ts"), "utf8");
    const redactionImport = indexSource.indexOf('import "./lib/install-runtime-log-redaction"');
    const appImport = indexSource.indexOf('import app from "./app"');
    expect(redactionImport).toBeGreaterThanOrEqual(0);
    expect(appImport).toBeGreaterThan(redactionImport);
  });
});
