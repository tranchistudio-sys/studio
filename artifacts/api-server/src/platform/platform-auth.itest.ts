import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import pg from "pg";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";

const { Pool } = pg;

type ServiceModule = typeof import("./service");
type SessionModule = typeof import("./session");
type PlatformDbModule = typeof import("@workspace/platform-db");

let service: ServiceModule;
let session: SessionModule;
let platformDb: PlatformDbModule;
let tenantPool: pg.Pool;
let server: Server;
let baseUrl: string;

const platformUrl = process.env.PLATFORM_DATABASE_URL ?? "";
const tenantUrl = process.env.DATABASE_URL ?? "";

function assertDisposableTestDatabase(raw: string, label: string): void {
  const database = new URL(raw).pathname.replace(/^\//, "");
  if (!database.endsWith("_test")) {
    throw new Error(`${label} phải trỏ tới database có hậu tố _test`);
  }
}

function request(cookies: Record<string, string> = {}) {
  return {
    cookies,
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    get(name: string) {
      return name.toLowerCase() === "user-agent" ? "vitest-platform-integration" : undefined;
    },
  } as any;
}

function response() {
  const state: { sessionCookie?: string; cleared?: boolean } = {};
  return {
    state,
    value: {
      cookie(name: string, value: string) {
        if (name === session.PLATFORM_SESSION_COOKIE) state.sessionCookie = value;
      },
      clearCookie(name: string) {
        if (name === session.PLATFORM_SESSION_COOKIE) state.cleared = true;
      },
    } as any,
  };
}

async function bootstrapOwner() {
  const res = response();
  const payload = await service.authenticateGoogle(request(), res.value, {
    sub: "google-owner-sub",
    email: "owner@gmail.com",
    name: "Amazing Owner",
    picture: "https://example.test/owner.png",
  });
  return { payload, res };
}

async function inviteStaff(email = "staff@gmail.com") {
  const owner = await bootstrapOwner();
  const platformPool = platformDb.getPlatformPool();
  const tenantId = owner.payload.activeTenant!.id;
  const ownerUserId = owner.payload.platformUser.id;
  await platformPool.query(
    `INSERT INTO tenant_invitations
      (id, tenant_id, invited_email, invited_role, tenant_staff_id,
       expires_at, invited_by, status)
     VALUES ($1, $2, $3, 'STAFF', 2, now() + interval '1 day', $4, 'pending')`,
    [randomUUID(), tenantId, email, ownerUserId],
  );
  const res = response();
  const payload = await service.authenticateGoogle(request(), res.value, {
    sub: "google-staff-sub",
    email,
    name: "Invited Staff",
  });
  return { owner, payload, res };
}

function cookieFrom(headers: Headers, name: string): string {
  const values = typeof (headers as any).getSetCookie === "function"
    ? (headers as any).getSetCookie() as string[]
    : [headers.get("set-cookie") ?? ""];
  const raw = values.find((value) => value.startsWith(`${name}=`));
  if (!raw) throw new Error(`Response không có cookie ${name}`);
  return raw.split(";", 1)[0];
}

async function loginConfig(): Promise<{ csrfToken: string; cookie: string }> {
  const response = await fetch(`${baseUrl}/api/auth/config`);
  const body = await response.json() as { loginCsrfToken: string };
  return {
    csrfToken: body.loginCsrfToken,
    cookie: cookieFrom(response.headers, session.LOGIN_CSRF_COOKIE),
  };
}

beforeAll(async () => {
  if (!platformUrl || !tenantUrl) {
    throw new Error("Platform integration test cần PLATFORM_DATABASE_URL và DATABASE_URL");
  }
  assertDisposableTestDatabase(platformUrl, "PLATFORM_DATABASE_URL");
  assertDisposableTestDatabase(tenantUrl, "DATABASE_URL");
  if (platformUrl === tenantUrl) throw new Error("Platform test DB phải tách tenant test DB");

  process.env.DEFAULT_TENANT_DATABASE_URL = tenantUrl;
  process.env.BOOTSTRAP_OWNER_EMAIL = "owner@gmail.com";
  process.env.BOOTSTRAP_TENANT_STAFF_ID = "1";
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "integration-only-session-secret-32-bytes";
  process.env.GOOGLE_CLIENT_ID = "test-google-client.apps.googleusercontent.com";
  process.env.FACEBOOK_APP_SECRET = "test-facebook-app-secret";
  process.env.NODE_ENV = "test";

  const migrationDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../lib/platform-db/migrations",
  );
  const setupPool = new Pool({ connectionString: platformUrl });
  for (const migration of [
    "0001_platform_foundation.sql",
    "0002_membership_session_revocation.sql",
  ]) {
    await setupPool.query(await readFile(path.join(migrationDirectory, migration), "utf8"));
  }
  await setupPool.end();

  tenantPool = new Pool({ connectionString: tenantUrl });
  await tenantPool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      phone TEXT NOT NULL,
      email TEXT,
      avatar TEXT,
      username TEXT,
      password_hash TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `);

  platformDb = await import("@workspace/platform-db");
  service = await import("./service");
  session = await import("./session");

  const { OAuth2Client } = await import("google-auth-library");
  vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockImplementation(async ({ idToken }: any) => ({
    getPayload() {
      if (String(idToken).startsWith("unverified")) {
        return { sub: "unverified-sub", email: "unverified@gmail.com", email_verified: false };
      }
      if (String(idToken).startsWith("unknown")) {
        return { sub: "unknown-http-sub", email: "unknown@gmail.com", email_verified: true, name: "Unknown" };
      }
      if (String(idToken).startsWith("staff")) {
        return { sub: "google-staff-sub", email: "staff@gmail.com", email_verified: true, name: "Invited Staff" };
      }
      return {
        sub: "google-owner-sub",
        email: "owner@gmail.com",
        email_verified: true,
        name: "Amazing Owner",
        picture: "https://example.test/owner.png",
      };
    },
  } as any));

  // Import the production composition, not a hand-built mini router. NODE_ENV=test
  // disables background schedulers while preserving real middleware/parser order.
  const app = (await import("../app")).default;
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Không lấy được cổng E2E test");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await platformDb.getPlatformPool().query(`
    TRUNCATE TABLE
      platform_audit_logs, sessions, tenant_invitations, tenant_memberships,
      auth_identities, provisioning_jobs, subscriptions,
      tenant_database_registry, tenants, platform_users
    RESTART IDENTITY CASCADE
  `);
  // Production composition may create tenant tables that reference staff during
  // startup. This is an isolated CI database, so reset the complete FK graph
  // instead of letting a startup-created table make every auth test fail.
  await tenantPool.query("TRUNCATE TABLE staff RESTART IDENTITY CASCADE");
  await tenantPool.query(
    `INSERT INTO staff (id, name, role, roles, phone, email, username, is_active)
     VALUES
       (1, 'Amazing Owner', 'admin', '["admin"]'::jsonb, '0900000001', 'owner@gmail.com', 'owner', 1),
       (2, 'Invited Staff', 'sale', '["sale"]'::jsonb, '0900000002', 'staff@gmail.com', 'staff', 1)`,
  );
  const limiter = await import("../lib/login-rate-limit");
  limiter.clearLoginRateLimitForTests();
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  vi.restoreAllMocks();
  if (tenantPool) await tenantPool.end();
  const dbModule = await import("@workspace/db");
  await dbModule.pool.end();
  if (platformDb) await platformDb.closePlatformPool();
});

describe.sequential("platform auth PostgreSQL integration", () => {
  it("bootstrap OWNER Amazing Studio đúng một lần, không copy tenant data", async () => {
    const { payload, res } = await bootstrapOwner();

    expect(payload.activeTenant).toEqual(expect.objectContaining({
      slug: "amazing-studio",
      role: "OWNER",
      tenantStaffId: 1,
    }));
    expect(payload.platformUser.platformRole).toBe("PLATFORM_OWNER");
    expect(payload.user?.id).toBe(1);
    expect(res.state.sessionCookie).toBeTruthy();

    const tenantCount = await tenantPool.query<{ count: string }>("SELECT count(*)::text AS count FROM staff");
    expect(tenantCount.rows[0]?.count).toBe("2");
  });

  it("local login vẫn tạo cùng loại server session", async () => {
    const res = response();
    const payload = await service.establishLocalPlatformSession(request(), res.value, {
      id: 1,
      name: "Amazing Owner",
      role: "admin",
      roles: ["admin"],
      phone: "0900000001",
      email: "owner@gmail.com",
      avatar: null,
      username: "owner",
    } as any);

    expect(payload?.activeTenant?.role).toBe("STAFF");
    expect(payload?.user?.id).toBe(1);
    expect(res.state.sessionCookie).toBeTruthy();
  });

  it("local login không ghi đè tenant role đã bị OWNER hạ quyền", async () => {
    const first = response();
    const initial = await service.establishLocalPlatformSession(request(), first.value, {
      id: 1,
      name: "Amazing Owner",
      role: "admin",
      roles: ["admin"],
      phone: "0900000001",
      email: "owner@gmail.com",
      avatar: null,
      username: "owner",
    } as any);
    expect(initial?.activeTenant?.role).toBe("STAFF");
    await platformDb.getPlatformPool().query(
      "UPDATE tenant_memberships SET tenant_role = 'ADMIN' WHERE id = $1",
      [initial!.activeTenant!.membershipId],
    );
    const promoted = await service.establishLocalPlatformSession(request(), response().value, {
      id: 1,
      name: "Amazing Owner",
      role: "admin",
      roles: ["admin"],
      phone: "0900000001",
      email: "owner@gmail.com",
      avatar: null,
      username: "owner",
    } as any);
    expect(promoted?.activeTenant?.role).toBe("ADMIN");
    await platformDb.getPlatformPool().query(
      "UPDATE tenant_memberships SET tenant_role = 'STAFF' WHERE id = $1",
      [initial!.activeTenant!.membershipId],
    );
    const second = await service.establishLocalPlatformSession(request(), response().value, {
      id: 1,
      name: "Amazing Owner",
      role: "admin",
      roles: ["admin"],
      phone: "0900000001",
      email: "owner@gmail.com",
      avatar: null,
      username: "owner",
    } as any);
    expect(second?.activeTenant?.role).toBe("STAFF");
  });

  it("invitation liên kết Google vào đúng platform user đã local-login", async () => {
    const local = await service.establishLocalPlatformSession(request(), response().value, {
      id: 2,
      name: "Invited Staff",
      role: "sale",
      roles: ["sale"],
      phone: "0900000002",
      email: "staff@gmail.com",
      avatar: null,
      username: "staff",
    } as any);
    const platformPool = platformDb.getPlatformPool();
    await platformPool.query(
      `INSERT INTO tenant_invitations
        (id, tenant_id, invited_email, invited_role, tenant_staff_id, target_user_id,
         expires_at, invited_by, status)
       VALUES ($1, $2, 'staff@gmail.com', 'STAFF', 2, $3, now() + interval '1 day', $3, 'pending')`,
      [randomUUID(), local!.activeTenant!.id, local!.platformUser.id],
    );
    const google = await service.authenticateGoogle(request(), response().value, {
      sub: "staff-linked-google-sub",
      email: "staff@gmail.com",
      name: "Invited Staff",
    });
    expect(google.platformUser.id).toBe(local!.platformUser.id);
    const membershipCount = await platformPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tenant_memberships WHERE tenant_id = $1 AND tenant_staff_id = 2",
      [local!.activeTenant!.id],
    );
    expect(membershipCount.rows[0]?.count).toBe("1");
  });

  it("không cho tenant manager gắn Google toàn cục khi user có membership studio khác bị suspended", async () => {
    const local = await service.establishLocalPlatformSession(request(), response().value, {
      id: 2,
      name: "Invited Staff",
      role: "sale",
      roles: ["sale"],
      phone: "0900000002",
      email: "staff@gmail.com",
      avatar: null,
      username: "staff",
    } as any);
    const platformPool = platformDb.getPlatformPool();
    const otherTenantId = randomUUID();
    await platformPool.query(
      "INSERT INTO tenants (id, name, slug, status, plan_id) VALUES ($1, 'Studio B', 'studio-b', 'suspended', 'legacy')",
      [otherTenantId],
    );
    await platformPool.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, tenant_role, status)
       VALUES ($1, $2, $3, 'STAFF', 'suspended')`,
      [randomUUID(), otherTenantId, local!.platformUser.id],
    );
    const invitationId = randomUUID();
    await platformPool.query(
      `INSERT INTO tenant_invitations
        (id, tenant_id, invited_email, invited_role, tenant_staff_id, target_user_id,
         expires_at, invited_by, status)
       VALUES ($1, $2, 'staff@gmail.com', 'STAFF', 2, $3, now() + interval '1 day', $3, 'pending')`,
      [invitationId, local!.activeTenant!.id, local!.platformUser.id],
    );

    await expect(service.authenticateGoogle(request(), response().value, {
      sub: "cross-tenant-suspended-sub",
      email: "staff@gmail.com",
      name: "Invited Staff",
    })).rejects.toMatchObject({ code: "INVITATION_CROSS_TENANT_IDENTITY" });
    expect((await platformPool.query(
      "SELECT count(*)::text AS count FROM auth_identities WHERE provider = 'google' AND provider_subject = $1",
      ["cross-tenant-suspended-sub"],
    )).rows[0]?.count).toBe("0");
    expect((await platformPool.query(
      "SELECT status FROM tenant_invitations WHERE id = $1",
      [invitationId],
    )).rows[0]?.status).toBe("pending");
  });

  it("re-check cross-tenant ngay lúc nhận lời mời, không chỉ lúc tạo lời mời", async () => {
    const local = await service.establishLocalPlatformSession(request(), response().value, {
      id: 2,
      name: "Invited Staff",
      role: "sale",
      roles: ["sale"],
      phone: "0900000002",
      email: "staff@gmail.com",
      avatar: null,
      username: "staff",
    } as any);
    const platformPool = platformDb.getPlatformPool();
    const invitationId = randomUUID();
    await platformPool.query(
      `INSERT INTO tenant_invitations
        (id, tenant_id, invited_email, invited_role, tenant_staff_id, target_user_id,
         expires_at, invited_by, status)
       VALUES ($1, $2, 'staff@gmail.com', 'STAFF', 2, $3, now() + interval '1 day', $3, 'pending')`,
      [invitationId, local!.activeTenant!.id, local!.platformUser.id],
    );
    const otherTenantId = randomUUID();
    await platformPool.query(
      "INSERT INTO tenants (id, name, slug, status, plan_id) VALUES ($1, 'Studio B', 'studio-b', 'trial', 'legacy')",
      [otherTenantId],
    );
    await platformPool.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, tenant_role, status)
       VALUES ($1, $2, $3, 'STAFF', 'active')`,
      [randomUUID(), otherTenantId, local!.platformUser.id],
    );

    await expect(service.authenticateGoogle(request(), response().value, {
      sub: "cross-tenant-race-sub",
      email: "staff@gmail.com",
      name: "Invited Staff",
    })).rejects.toMatchObject({ code: "INVITATION_CROSS_TENANT_IDENTITY" });
    expect((await platformPool.query(
      "SELECT count(*)::text AS count FROM auth_identities WHERE provider = 'google' AND provider_subject = $1",
      ["cross-tenant-race-sub"],
    )).rows[0]?.count).toBe("0");
    expect((await platformPool.query(
      "SELECT status FROM tenant_invitations WHERE id = $1",
      [invitationId],
    )).rows[0]?.status).toBe("pending");
  });

  it("chỉ email được mời mới tạo identity và membership", async () => {
    const invited = await inviteStaff();
    expect(invited.payload.activeTenant).toEqual(expect.objectContaining({ role: "STAFF", tenantStaffId: 2 }));

    const invitation = await platformDb.getPlatformPool().query<{ status: string; accepted_at: Date | null }>(
      "SELECT status, accepted_at FROM tenant_invitations WHERE invited_email = 'staff@gmail.com'",
    );
    expect(invitation.rows[0]?.status).toBe("accepted");
    expect(invitation.rows[0]?.accepted_at).toBeTruthy();

    await expect(service.authenticateGoogle(request(), response().value, {
      sub: "unknown-sub",
      email: "unknown@gmail.com",
      name: "Unknown",
    })).rejects.toMatchObject({ code: "GOOGLE_NOT_INVITED" });
  });

  it("membership bị khóa hoặc session bị thu hồi có hiệu lực ngay request kế tiếp", async () => {
    const invited = await inviteStaff();
    const cookie = invited.res.state.sessionCookie!;
    const req = request({ [session.PLATFORM_SESSION_COOKIE]: cookie });
    const active = await session.loadSessionFromRequest(req);
    expect(active).not.toBeNull();

    await platformDb.getPlatformPool().query(
      "UPDATE tenant_memberships SET status = 'suspended' WHERE id = $1",
      [invited.payload.activeTenant!.membershipId],
    );
    expect(await session.loadSessionFromRequest(req)).toBeNull();

    await platformDb.getPlatformPool().query(
      "UPDATE tenant_memberships SET status = 'active' WHERE id = $1",
      [invited.payload.activeTenant!.membershipId],
    );
    await session.revokeSession(active!.sessionId, "integration_test");
    expect(await session.loadSessionFromRequest(req)).toBeNull();
  });

  it("tenant manager chỉ thu hồi phiên của membership hiện tại, không logout studio khác", async () => {
    const invited = await inviteStaff();
    const platformPool = platformDb.getPlatformPool();
    const otherTenantId = randomUUID();
    const otherMembershipId = randomUUID();
    await platformPool.query(
      "INSERT INTO tenants (id, name, slug, status, plan_id) VALUES ($1, 'Studio B', 'studio-b', 'trial', 'legacy')",
      [otherTenantId],
    );
    await platformPool.query(
      `INSERT INTO tenant_memberships
        (id, tenant_id, user_id, tenant_role, status, tenant_staff_id)
       VALUES ($1, $2, $3, 'STAFF', 'active', 2)`,
      [otherMembershipId, otherTenantId, invited.payload.platformUser.id],
    );
    const otherSession = await session.createPlatformSession(
      platformPool,
      request(),
      invited.payload.platformUser.id,
      { tenantId: otherTenantId, membershipId: otherMembershipId, tenantStaffId: 2 },
    );
    const otherRequest = request({ [session.PLATFORM_SESSION_COOKIE]: otherSession.cookieToken });
    const otherContext = await session.loadSessionFromRequest(otherRequest);
    expect(otherContext?.activeTenantId).toBe(otherTenantId);

    const revoke = await fetch(
      `${baseUrl}/api/tenant/members/${invited.payload.activeTenant!.membershipId}/revoke-sessions`,
      {
        method: "POST",
        headers: {
          cookie: `${session.PLATFORM_SESSION_COOKIE}=${invited.owner.res.state.sessionCookie!}`,
          "x-csrf-token": invited.owner.payload.csrfToken,
          origin: baseUrl,
        },
      },
    );
    expect(revoke.status).toBe(200);
    expect(await session.loadSessionFromRequest(otherRequest)).not.toBeNull();
    await expect(service.selectTenantForSession(
      otherContext!,
      invited.payload.activeTenant!.id,
    )).rejects.toThrow(/đã bị thu hồi/i);
  });

  it("MCP access token luôn re-check tenant role và membership auth version", async () => {
    const invited = await inviteStaff();
    const mcp = await import("../lib/mcp/oauth");
    const staleRoleToken = mcp.issueTestAccessToken(2, "admin", "test-client", 0, 0);
    const current = await mcp.mcpOAuthProvider.verifyAccessToken(staleRoleToken);
    expect(current.extra).toMatchObject({ staffId: 2, role: "staff" });

    await platformDb.getPlatformPool().query(
      `UPDATE tenant_memberships
       SET auth_version = auth_version + 1, sessions_revoked_at = now()
       WHERE id = $1`,
      [invited.payload.activeTenant!.membershipId],
    );
    await expect(mcp.mcpOAuthProvider.verifyAccessToken(staleRoleToken)).rejects.toThrow("invalid_token");
    const fresh = mcp.issueTestAccessToken(2, "staff", "test-client", 0, 1);
    expect((await mcp.mcpOAuthProvider.verifyAccessToken(fresh)).extra).toMatchObject({ role: "staff" });
  });

  it("user nhiều studio phải chọn studio và không thể chọn tenant ngoài membership", async () => {
    const first = await bootstrapOwner();
    const platformPool = platformDb.getPlatformPool();
    const secondTenantId = randomUUID();
    await platformPool.query(
      "INSERT INTO tenants (id, name, slug, status, plan_id) VALUES ($1, 'Studio B', 'studio-b', 'trial', 'legacy')",
      [secondTenantId],
    );
    await platformPool.query(
      `INSERT INTO tenant_memberships
        (id, tenant_id, user_id, tenant_role, status, tenant_staff_id)
       VALUES ($1, $2, $3, 'STAFF', 'active', 1)`,
      [randomUUID(), secondTenantId, first.payload.platformUser.id],
    );

    const secondResponse = response();
    const payload = await service.authenticateGoogle(request(), secondResponse.value, {
      sub: "google-owner-sub",
      email: "owner@gmail.com",
      name: "Amazing Owner",
    });
    expect(payload.requiresTenantSelection).toBe(true);
    expect(payload.activeTenant).toBeUndefined();
    expect(payload.memberships).toHaveLength(2);

    const context = await session.loadSessionFromRequest(request({
      [session.PLATFORM_SESSION_COOKIE]: secondResponse.state.sessionCookie!,
    }));
    await expect(service.selectTenantForSession(context!, randomUUID())).rejects.toThrow(
      /không có quyền truy cập studio/i,
    );
    await expect(service.selectTenantForSession(context!, secondTenantId)).rejects.toThrow(
      /database.*chưa sẵn sàng/i,
    );
  });

  it("E2E HTTP: local fallback, Google bootstrap, unknown/unverified rejection và logout", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    await tenantPool.query(
      "UPDATE staff SET password_hash = $2 WHERE id = $1",
      [1, await bcrypt.hash("safe-local-password", 4)],
    );

    const publicHealth = await fetch(`${baseUrl}/api/healthz`);
    expect(publicHealth.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/check-ai-key`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/accounting/transactions`)).status).toBe(401);

    const webhookBody = '{"object":"not-page","entry":[]}';
    const webhookSignature = createHmac("sha256", process.env.FACEBOOK_APP_SECRET!)
      .update(webhookBody)
      .digest("hex");
    expect((await fetch(`${baseUrl}/api/webhook/facebook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${webhookSignature}`,
      },
      body: webhookBody,
    })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/webhook/facebook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + "0".repeat(64),
      },
      body: webhookBody,
    })).status).toBe(401);

    const localConfig = await loginConfig();
    const localResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: localConfig.cookie,
        origin: baseUrl,
      },
      body: JSON.stringify({
        phone: "owner",
        password: "safe-local-password",
        loginCsrfToken: localConfig.csrfToken,
      }),
    });
    expect(localResponse.status).toBe(200);
    const localBody = await localResponse.json() as any;
    expect(localBody.activeTenant.role).toBe("STAFF");
    expect(localBody.token).toBeUndefined();
    const localCookie = cookieFrom(localResponse.headers, session.PLATFORM_SESSION_COOKIE);
    expect((await fetch(`${baseUrl}/api/readyz`, {
      headers: { cookie: localCookie },
    })).status).toBe(200);
    for (const mixedCasePath of [
      "/api/Salary-Rates",
      "/api/Staff-Rates",
      "/api/Accounting/transactions",
      "/api/Services",
    ]) {
      const denied = await fetch(`${baseUrl}${mixedCasePath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: localCookie,
          "x-csrf-token": localBody.csrfToken,
          origin: baseUrl,
        },
        body: "{}",
      });
      expect(denied.status, mixedCasePath).toBe(403);
    }

    // The tenant membership role is the authority ceiling even though staff 1
    // is still a legacy admin in the tenant database.
    const otherStaffCommission = await fetch(
      `${baseUrl}/api/staff-commissions?staffId=2`,
      { headers: { cookie: localCookie } },
    );
    expect(otherStaffCommission.status).toBe(403);

    for (const [prefix, expectedStatus, expectedCode] of [
      ["unverified", 401, "GOOGLE_EMAIL_NOT_VERIFIED"],
      ["unknown", 403, "GOOGLE_NOT_INVITED"],
    ] as const) {
      const config = await loginConfig();
      const denied = await fetch(`${baseUrl}/api/auth/google`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: config.cookie, origin: baseUrl },
        body: JSON.stringify({
          credential: `${prefix}-${"x".repeat(140)}`,
          loginCsrfToken: config.csrfToken,
        }),
      });
      expect(denied.status).toBe(expectedStatus);
      expect((await denied.json() as any).code).toBe(expectedCode);
    }

    const googleConfig = await loginConfig();
    const googleResponse = await fetch(`${baseUrl}/api/auth/google`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${localCookie}; ${googleConfig.cookie}`,
        origin: baseUrl,
      },
      body: JSON.stringify({
        credential: `owner-${"x".repeat(140)}`,
        loginCsrfToken: googleConfig.csrfToken,
      }),
    });
    expect(googleResponse.status).toBe(200);
    const googleBody = await googleResponse.json() as any;
    expect(googleBody.platformUser.id).toBe(localBody.platformUser.id);
    expect(googleBody.platformUser.platformRole).toBe("PLATFORM_OWNER");
    expect(googleBody.activeTenant.role).toBe("OWNER");
    expect(googleBody.token).toBeUndefined();
    const googleCookie = cookieFrom(googleResponse.headers, session.PLATFORM_SESSION_COOKIE);
    expect(googleCookie).not.toBe(localCookie);

    const oldSession = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: localCookie } });
    expect(oldSession.status).toBe(401);
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: googleCookie } });
    expect(me.status).toBe(200);
    const ownerCsrf = (await me.json() as any).csrfToken as string;
    const secondMe = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: googleCookie } });
    expect((await secondMe.json() as any).csrfToken).toBe(ownerCsrf);

    const ownerMembershipId = googleBody.activeTenant.membershipId as string;
    const invalidPlatformRole = await fetch(`${baseUrl}/api/tenant/members/${ownerMembershipId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: googleCookie,
        "x-csrf-token": ownerCsrf,
      },
      body: JSON.stringify({ role: "PLATFORM_OWNER" }),
    });
    expect(invalidPlatformRole.status).toBe(400);

    const lastOwner = await fetch(`${baseUrl}/api/tenant/members/${ownerMembershipId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: googleCookie,
        "x-csrf-token": ownerCsrf,
      },
      body: JSON.stringify({ role: "STAFF" }),
    });
    expect(lastOwner.status).toBe(400);
    expect((await lastOwner.json() as any).error).toMatch(/OWNER cuối cùng/i);

    const invite = await fetch(`${baseUrl}/api/tenant/invitations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: googleCookie,
        "x-csrf-token": ownerCsrf,
      },
      body: JSON.stringify({ email: "staff@gmail.com", role: "STAFF", tenantStaffId: 2 }),
    });
    expect(invite.status).toBe(201);

    const staffConfig = await loginConfig();
    const staffLogin = await fetch(`${baseUrl}/api/auth/google`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: staffConfig.cookie, origin: baseUrl },
      body: JSON.stringify({
        credential: `staff-${"x".repeat(140)}`,
        loginCsrfToken: staffConfig.csrfToken,
      }),
    });
    expect(staffLogin.status).toBe(200);
    const staffBody = await staffLogin.json() as any;
    const staffCookie = cookieFrom(staffLogin.headers, session.PLATFORM_SESSION_COOKIE);
    expect(staffBody.activeTenant.role).toBe("STAFF");

    const staffAccounting = await fetch(`${baseUrl}/api/accounting/transactions`, {
      headers: { cookie: staffCookie },
    });
    expect(staffAccounting.status).toBe(403);

    const staffMembersPage = await fetch(`${baseUrl}/api/tenant/members`, {
      headers: { cookie: staffCookie },
    });
    expect(staffMembersPage.status).toBe(403);

    await platformDb.getPlatformPool().query(
      "UPDATE tenant_memberships SET tenant_role = 'ADMIN' WHERE id = $1",
      [staffBody.activeTenant.membershipId],
    );
    const adminTakeover = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: staffCookie,
        "x-csrf-token": staffBody.csrfToken,
      },
      body: JSON.stringify({ targetId: 1, newPassword: "attacker-password" }),
    });
    expect(adminTakeover.status).toBe(403);

    const adminEditOwner = await fetch(`${baseUrl}/api/staff/1`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: staffCookie,
      },
      body: JSON.stringify({ isActive: false }),
    });
    expect(adminEditOwner.status).toBe(403);
    const adminDeleteOwner = await fetch(`${baseUrl}/api/staff/1`, {
      method: "DELETE",
      headers: { cookie: staffCookie },
    });
    expect(adminDeleteOwner.status).toBe(403);

    const suspendStaff = await fetch(
      `${baseUrl}/api/tenant/members/${staffBody.activeTenant.membershipId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: googleCookie,
          "x-csrf-token": ownerCsrf,
        },
        body: JSON.stringify({ status: "suspended" }),
      },
    );
    expect(suspendStaff.status).toBe(200);
    const lockedStaff = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: staffCookie } });
    expect(lockedStaff.status).toBe(401);

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        cookie: googleCookie,
        origin: baseUrl,
        "x-csrf-token": ownerCsrf,
      },
    });
    expect(logout.status).toBe(204);
    const revoked = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: googleCookie } });
    expect(revoked.status).toBe(401);
  });
});
