import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn() },
}));

import { GoogleAuthenticationError, validateGooglePayload } from "./service";
import {
  platformSessionContextIsActive,
  setPlatformSessionCookie,
} from "./session";
import type { PlatformSessionContext } from "./types";
import { LOGGER_REDACT_PATHS } from "../lib/log-redaction";
import {
  registryMatchesAmazingRuntime,
  resolveAmazingTenantDatabaseReference,
} from "./tenant-database-reference";

const originalNodeEnv = process.env.NODE_ENV;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalDefaultTenantUrl = process.env.DEFAULT_TENANT_DATABASE_URL;
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalDefaultTenantUrl === undefined) delete process.env.DEFAULT_TENANT_DATABASE_URL;
  else process.env.DEFAULT_TENANT_DATABASE_URL = originalDefaultTenantUrl;
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
    const [foundation, revocation] = await Promise.all([
      readFile(path.join(migrationDirectory, "0001_platform_foundation.sql"), "utf8"),
      readFile(path.join(migrationDirectory, "0002_membership_session_revocation.sql"), "utf8"),
    ]);
    const statements = `${foundation}\n${revocation}`.replace(/--.*$/gm, "");
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
