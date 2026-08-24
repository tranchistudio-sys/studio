import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { getPlatformPool, type PlatformQueryable, withPlatformTransaction } from "@workspace/platform-db";
import type { PlatformRole, PlatformSessionContext, TenantRole, TenantStatus } from "./types";

export const PLATFORM_SESSION_COOKIE = "amazing_session";
export const LOGIN_CSRF_COOKIE = "amazing_login_csrf";

export const DEFAULT_SESSION_TTL_HOURS = 24 * 365;
export const MAX_SESSION_TTL_HOURS = 24 * 365;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256(value));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cookieSecure(): boolean {
  return process.env.NODE_ENV === "production";
}

export function platformSessionTtlHours(): number {
  const parsed = Number(process.env.PLATFORM_SESSION_TTL_HOURS ?? DEFAULT_SESSION_TTL_HOURS);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_SESSION_TTL_HOURS;
  return Math.min(parsed, MAX_SESSION_TTL_HOURS);
}

function ipHash(req: Request): string | null {
  const ip = req.ip || req.socket.remoteAddress;
  if (!ip) return null;
  const salt = process.env.SESSION_SECRET || "development-session-salt";
  return sha256(`${salt}:${ip}`);
}

export function issueLoginCsrf(res: Response, existingToken?: unknown): string {
  const token = typeof existingToken === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(existingToken)
    ? existingToken
    : randomBytes(24).toString("base64url");
  res.cookie(LOGIN_CSRF_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 10 * 60_000,
  });
  return token;
}

function sessionCsrfToken(sessionId: string): string {
  const secret = process.env.SESSION_SECRET || "development-session-salt";
  return createHmac("sha256", secret)
    .update(`amazing-studio:csrf:${sessionId}`)
    .digest("base64url");
}

export function verifyLoginCsrf(req: Request, supplied: unknown): boolean {
  if (typeof supplied !== "string" || supplied.length < 20) return false;
  const cookie = req.cookies?.[LOGIN_CSRF_COOKIE] as string | undefined;
  if (!cookie) return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(cookie);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function clearLoginCsrf(res: Response): void {
  res.clearCookie(LOGIN_CSRF_COOKIE, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/api/auth",
  });
}

export interface NewSessionMembership {
  tenantId: string | null;
  membershipId: string | null;
  tenantStaffId: number | null;
}

export async function createPlatformSession(
  queryable: PlatformQueryable,
  req: Request,
  userId: string,
  membership: NewSessionMembership,
): Promise<{ sessionId: string; cookieToken: string; csrfToken: string; expiresAt: Date }> {
  const sessionId = randomUUID();
  const cookieToken = randomBytes(32).toString("base64url");
  // Stable per server session: multiple browser tabs do not invalidate one
  // another whenever either tab refreshes /auth/me.
  const csrfToken = sessionCsrfToken(sessionId);
  const expiresAt = new Date(Date.now() + platformSessionTtlHours() * 60 * 60_000);
  const userAgent = req.get("user-agent")?.slice(0, 500) || null;

  await queryable.query(
    `INSERT INTO sessions
      (id, token_hash, csrf_token_hash, user_id, active_tenant_id,
       tenant_membership_id, legacy_staff_id, user_agent, ip_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      sessionId,
      sha256(cookieToken),
      sha256(csrfToken),
      userId,
      membership.tenantId,
      membership.membershipId,
      membership.tenantStaffId,
      userAgent,
      ipHash(req),
      expiresAt,
    ],
  );
  if (membership.membershipId) {
    await queryable.query(
      "UPDATE tenant_memberships SET last_login_at = now(), updated_at = now() WHERE id = $1",
      [membership.membershipId],
    );
  }

  return { sessionId, cookieToken, csrfToken, expiresAt };
}

export function setPlatformSessionCookie(
  res: Response,
  cookieToken: string,
  expiresAt: Date,
): void {
  res.cookie(PLATFORM_SESSION_COOKIE, cookieToken, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearPlatformSessionCookie(res: Response): void {
  res.clearCookie(PLATFORM_SESSION_COOKIE, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
  });
}

interface SessionRow {
  session_id: string;
  created_at: Date | string;
  user_id: string;
  user_status: string;
  platform_role: PlatformRole;
  active_tenant_id: string | null;
  tenant_status: TenantStatus | null;
  membership_id: string | null;
  membership_status: string | null;
  tenant_role: TenantRole | null;
  tenant_staff_id: string | number | null;
  csrf_token_hash: string;
  expires_at: Date | string;
}

function mapSession(row: SessionRow): PlatformSessionContext {
  return {
    sessionId: row.session_id,
    createdAt: new Date(row.created_at),
    userId: row.user_id,
    userStatus: row.user_status,
    platformRole: row.platform_role,
    activeTenantId: row.active_tenant_id,
    tenantStatus: row.tenant_status,
    membershipId: row.membership_id,
    membershipStatus: row.membership_status,
    tenantRole: row.tenant_role,
    tenantStaffId: row.tenant_staff_id === null ? null : Number(row.tenant_staff_id),
    csrfTokenHash: row.csrf_token_hash,
    expiresAt: new Date(row.expires_at),
  };
}

const SESSION_SELECT = `
  SELECT
    s.id AS session_id,
    s.created_at,
    s.user_id,
    u.status AS user_status,
    u.platform_role,
    s.active_tenant_id,
    t.status AS tenant_status,
    s.tenant_membership_id AS membership_id,
    m.status AS membership_status,
    m.tenant_role,
    COALESCE(s.legacy_staff_id, m.tenant_staff_id) AS tenant_staff_id,
    s.csrf_token_hash,
    s.expires_at
  FROM sessions s
  JOIN platform_users u ON u.id = s.user_id
  LEFT JOIN tenants t ON t.id = s.active_tenant_id
  LEFT JOIN tenant_memberships m
    ON m.id = s.tenant_membership_id
   AND m.user_id = s.user_id
   AND m.tenant_id = s.active_tenant_id
  WHERE s.revoked_at IS NULL
    AND s.expires_at > now()
    AND (
      s.tenant_membership_id IS NULL
      OR m.sessions_revoked_at IS NULL
      OR s.created_at > m.sessions_revoked_at
    )
`;

export function platformSessionContextIsActive(context: PlatformSessionContext): boolean {
  if (context.userStatus !== "active") return false;
  if (!context.activeTenantId) return true;
  return (
    (context.tenantStatus === "active" || context.tenantStatus === "trial") &&
    context.membershipStatus === "active"
  );
}

export async function loadSessionFromRequest(req: Request): Promise<PlatformSessionContext | null> {
  const token = req.cookies?.[PLATFORM_SESSION_COOKIE] as string | undefined;
  if (!token) return null;
  const result = await getPlatformPool().query<SessionRow>(
    `${SESSION_SELECT} AND s.token_hash = $1 LIMIT 1`,
    [sha256(token)],
  );
  const context = result.rows[0] ? mapSession(result.rows[0]) : null;
  return context && platformSessionContextIsActive(context) ? context : null;
}

export async function loadSessionById(sessionId: string): Promise<PlatformSessionContext | null> {
  const result = await getPlatformPool().query<SessionRow>(
    `${SESSION_SELECT} AND s.id = $1 LIMIT 1`,
    [sessionId],
  );
  const context = result.rows[0] ? mapSession(result.rows[0]) : null;
  return context && platformSessionContextIsActive(context) ? context : null;
}

export function csrfMatches(context: PlatformSessionContext, supplied: unknown): boolean {
  return typeof supplied === "string" && safeEqual(supplied, context.csrfTokenHash);
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await getPlatformPool().query(
    `UPDATE sessions
       SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = COALESCE(revoked_reason, $2)
     WHERE id = $1`,
    [sessionId, reason.slice(0, 200)],
  );
}

export async function revokeAllUserSessions(userId: string, reason: string): Promise<void> {
  await withPlatformTransaction(async (client) => {
    await client.query(
      `UPDATE sessions
         SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = COALESCE(revoked_reason, $2)
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, reason.slice(0, 200)],
    );
    // MCP/OAuth grants are stateless, so auth_version is their revocation epoch.
    await client.query(
      "UPDATE platform_users SET auth_version = auth_version + 1, updated_at = now() WHERE id = $1",
      [userId],
    );
  });
}

export async function getSessionCsrfToken(sessionId: string): Promise<string> {
  const token = sessionCsrfToken(sessionId);
  await getPlatformPool().query(
    `UPDATE sessions SET csrf_token_hash = $2, last_seen_at = now()
     WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sessionId, sha256(token)],
  );
  return token;
}

/**
 * SSE requests pass auth middleware only once. Revalidate the authoritative
 * server session while the stream stays open so logout, membership suspension,
 * tenant suspension and staff lock take effect without waiting for reconnect.
 */
export function watchPlatformSessionValidity(
  res: Response,
  onInvalid: () => void,
  intervalMs = 10_000,
): () => void {
  const context = res.locals.platformAuth as PlatformSessionContext | undefined;
  if (!context) return () => {};
  let stopped = false;
  let checking = false;
  const timer = setInterval(() => {
    if (stopped || checking) return;
    checking = true;
    loadSessionById(context.sessionId)
      .then(active => {
        if (!active && !stopped) {
          stopped = true;
          clearInterval(timer);
          onInvalid();
        }
      })
      .catch(() => {
        if (!stopped) {
          stopped = true;
          clearInterval(timer);
          onInvalid();
        }
      })
      .finally(() => { checking = false; });
  }, Math.max(1_000, intervalMs));
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
