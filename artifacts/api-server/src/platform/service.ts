import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { pool } from "@workspace/db";
import {
  getPlatformPool,
  isPlatformDatabaseConfigured,
  normalizeEmail,
  type PlatformQueryable,
  withPlatformTransaction,
} from "@workspace/platform-db";
import {
  clearLoginCsrf,
  createPlatformSession,
  loadSessionFromRequest,
  getSessionCsrfToken,
  revokeSession,
  setPlatformSessionCookie,
} from "./session";
import type {
  PlatformRole,
  PlatformSessionContext,
  PlatformUserSummary,
  TenantMembershipSummary,
  TenantRole,
  TenantStatus,
} from "./types";
import {
  registryMatchesAmazingRuntime,
  resolveAmazingTenantDatabaseReference,
  type TenantDatabaseRegistryRow,
} from "./tenant-database-reference";

export const GOOGLE_NOT_INVITED_MESSAGE =
  "Tài khoản Google này chưa được cấp quyền sử dụng Amazing Studio. Vui lòng liên hệ quản trị viên.";

interface LegacyStaff {
  id: number;
  name: string;
  role: string;
  roles: unknown;
  phone: string;
  email: string | null;
  avatar: string | null;
  username: string | null;
  is_active?: number;
}

interface PlatformUserRow {
  id: string;
  canonical_email: string | null;
  display_name: string;
  avatar_url: string | null;
  status: string;
  platform_role: PlatformRole;
}

interface MembershipRow {
  membership_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  tenant_status: TenantStatus;
  tenant_role: TenantRole;
  membership_status: string;
  tenant_staff_id: string | number | null;
  sessions_revoked_at: Date | string | null;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export interface PlatformAuthResponse {
  platformEnabled: true;
  token?: string;
  user?: {
    id: number;
    platformUserId: string;
    tenantMembershipId: string;
    name: string;
    role: string;
    roles: string[];
    phone: string;
    email?: string;
    avatar?: string;
    username?: string;
    tenantRole: TenantRole;
    platformRole: PlatformRole;
  };
  platformUser: PlatformUserSummary;
  activeTenant?: TenantMembershipSummary;
  memberships: TenantMembershipSummary[];
  requiresTenantSelection: boolean;
  csrfToken: string;
}

async function ensureAmazingTenant(queryable: PlatformQueryable): Promise<string> {
  const existing = await queryable.query<{ id: string }>(
    "SELECT id FROM tenants WHERE slug = 'amazing-studio' LIMIT 1",
  );
  const ref = resolveAmazingTenantDatabaseReference();
  let resolvedId = existing.rows[0]?.id;
  if (!resolvedId) {
    const tenantId = randomUUID();
    await queryable.query(
      `INSERT INTO tenants (id, name, slug, status, plan_id)
       VALUES ($1, 'Amazing Studio', 'amazing-studio', 'active', 'legacy')
       ON CONFLICT (slug) DO NOTHING`,
      [tenantId],
    );
    const selected = await queryable.query<{ id: string }>(
      "SELECT id FROM tenants WHERE slug = 'amazing-studio' LIMIT 1",
    );
    resolvedId = selected.rows[0]?.id;
  }
  if (!resolvedId) throw new Error("Không thể khởi tạo tenant Amazing Studio");

  await queryable.query(
    `INSERT INTO tenant_database_registry
      (tenant_id, database_ref, host_ref, database_name, role_name, secret_ref, health_status)
     VALUES ($1, 'amazing-studio-current-production', $2, $3, $4,
             'env:DEFAULT_TENANT_DATABASE_URL', 'unknown')
     ON CONFLICT (tenant_id) DO NOTHING`,
    [resolvedId, ref.hostRef, ref.databaseName, ref.roleName],
  );
  const registry = await queryable.query<TenantDatabaseRegistryRow>(
    `SELECT database_ref, host_ref, database_name, role_name, secret_ref
     FROM tenant_database_registry WHERE tenant_id = $1 LIMIT 1`,
    [resolvedId],
  );
  if (!registryMatchesAmazingRuntime(registry.rows[0])) {
    throw new Error("Database registry của Amazing Studio không khớp runtime reference");
  }
  return resolvedId;
}

async function findLegacyAdminStaffId(): Promise<number> {
  const configuredId = Number(process.env.BOOTSTRAP_TENANT_STAFF_ID);
  if (Number.isInteger(configuredId) && configuredId > 0) {
    const configured = await pool.query<{ id: number }>(
      `SELECT id FROM staff
       WHERE id = $1 AND is_active = 1
         AND (role = 'admin' OR roles::text LIKE '%admin%')
       LIMIT 1`,
      [configuredId],
    );
    if (!configured.rows[0]) {
      throw new Error("BOOTSTRAP_TENANT_STAFF_ID không trỏ tới admin nghiệp vụ đang hoạt động");
    }
    return configured.rows[0].id;
  }
  const result = await pool.query<{ id: number }>(
    `SELECT id
       FROM staff
      WHERE is_active = 1
        AND (role = 'admin' OR roles::text LIKE '%admin%')
      ORDER BY id
      LIMIT 2`,
  );
  if (result.rows.length !== 1) {
    throw new Error(
      "Không xác định duy nhất admin nghiệp vụ để liên kết OWNER. Hãy cấu hình BOOTSTRAP_TENANT_STAFF_ID.",
    );
  }
  return result.rows[0].id;
}

async function loadLegacyStaff(staffId: number): Promise<LegacyStaff | null> {
  const result = await pool.query<LegacyStaff>(
    `SELECT id, name, role, roles, phone, email, avatar, username, is_active
       FROM staff
      WHERE id = $1 AND is_active = 1
      LIMIT 1`,
    [staffId],
  );
  return result.rows[0] ?? null;
}

async function getPlatformUser(queryable: PlatformQueryable, userId: string): Promise<PlatformUserRow> {
  const result = await queryable.query<PlatformUserRow>(
    `SELECT id, canonical_email, display_name, avatar_url, status, platform_role
       FROM platform_users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  if (!result.rows[0]) throw new Error("Platform user không tồn tại");
  return result.rows[0];
}

async function getMembershipRows(
  queryable: PlatformQueryable,
  userId: string,
): Promise<MembershipRow[]> {
  const result = await queryable.query<MembershipRow>(
    `SELECT
       m.id AS membership_id,
       t.id AS tenant_id,
       t.name AS tenant_name,
       t.slug AS tenant_slug,
       t.status AS tenant_status,
       m.tenant_role,
       m.status AS membership_status,
       m.tenant_staff_id,
       m.sessions_revoked_at
     FROM tenant_memberships m
     JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = $1
       AND m.status = 'active'
       AND t.status IN ('active', 'trial')
     ORDER BY t.name, t.id`,
    [userId],
  );
  return result.rows;
}

function toMembershipSummary(row: MembershipRow): TenantMembershipSummary {
  return {
    id: row.tenant_id,
    name: row.tenant_name,
    slug: row.tenant_slug,
    status: row.tenant_status,
    role: row.tenant_role,
    membershipId: row.membership_id,
    tenantStaffId: row.tenant_staff_id === null ? null : Number(row.tenant_staff_id),
  };
}

async function writeAudit(
  queryable: PlatformQueryable,
  input: {
    actorUserId?: string | null;
    tenantId?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await queryable.query(
    `INSERT INTO platform_audit_logs
      (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      randomUUID(),
      input.actorUserId ?? null,
      input.tenantId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

async function revokePriorRequestSession(req: Request): Promise<void> {
  try {
    const previous = await loadSessionFromRequest(req);
    if (previous) await revokeSession(previous.sessionId, "rotated_after_login");
  } catch {
    // Login must still be able to recover from an invalid/stale cookie.
  }
}

async function assertMembershipUsesCurrentDatabase(
  queryable: PlatformQueryable,
  membership: MembershipRow,
): Promise<void> {
  const registry = await queryable.query<TenantDatabaseRegistryRow>(
    `SELECT database_ref, host_ref, database_name, role_name, secret_ref
     FROM tenant_database_registry WHERE tenant_id = $1 LIMIT 1`,
    [membership.tenant_id],
  );
  if (!registryMatchesAmazingRuntime(registry.rows[0])) {
    throw new Error("Database của studio chưa sẵn sàng trong phiên bản PR 1");
  }
}

async function buildResponse(
  session: {
    sessionId: string;
    csrfToken: string;
    userId: string;
    activeMembership: MembershipRow | null;
  },
): Promise<PlatformAuthResponse> {
  const platformPool = getPlatformPool();
  const platformUser = await getPlatformUser(platformPool, session.userId);
  const membershipRows = await getMembershipRows(platformPool, session.userId);
  const memberships = membershipRows.map(toMembershipSummary);
  const activeRow = session.activeMembership;
  const activeTenant = activeRow ? toMembershipSummary(activeRow) : undefined;

  const response: PlatformAuthResponse = {
    platformEnabled: true,
    platformUser: {
      id: platformUser.id,
      name: platformUser.display_name,
      ...(platformUser.canonical_email ? { email: platformUser.canonical_email } : {}),
      ...(platformUser.avatar_url ? { avatar: platformUser.avatar_url } : {}),
      platformRole: platformUser.platform_role,
    },
    memberships,
    ...(activeTenant ? { activeTenant } : {}),
    requiresTenantSelection: memberships.length > 1 && !activeTenant,
    csrfToken: session.csrfToken,
  };

  if (activeTenant?.tenantStaffId) {
    const staff = await loadLegacyStaff(activeTenant.tenantStaffId);
    if (!staff) throw new Error("Tài khoản nhân sự được liên kết đã bị khóa hoặc không tồn tại");
    const roles = Array.isArray(staff.roles)
      ? staff.roles.filter((role): role is string => typeof role === "string")
      : [];
    response.user = {
      id: staff.id,
      platformUserId: platformUser.id,
      tenantMembershipId: activeTenant.membershipId,
      name: staff.name,
      role: staff.role,
      roles,
      phone: staff.phone,
      ...(staff.email ? { email: staff.email } : {}),
      ...(staff.avatar ? { avatar: staff.avatar } : {}),
      ...(staff.username ? { username: staff.username } : {}),
      tenantRole: activeTenant.role,
      platformRole: platformUser.platform_role,
    };
  }
  return response;
}

async function finishLogin(
  req: Request,
  res: Response,
  userId: string,
  preferredMembership?: MembershipRow | null,
): Promise<PlatformAuthResponse> {
  const platformPool = getPlatformPool();
  const memberships = await getMembershipRows(platformPool, userId);
  const activeMembership = preferredMembership ?? (memberships.length === 1 ? memberships[0] : null);
  if (activeMembership && activeMembership.tenant_staff_id === null) {
    throw new Error("Membership chưa liên kết với hồ sơ nhân sự nghiệp vụ");
  }
  if (activeMembership) await assertMembershipUsesCurrentDatabase(platformPool, activeMembership);

  await revokePriorRequestSession(req);
  const created = await withPlatformTransaction((client) => createPlatformSession(client, req, userId, {
    tenantId: activeMembership?.tenant_id ?? null,
    membershipId: activeMembership?.membership_id ?? null,
    tenantStaffId: activeMembership?.tenant_staff_id === null || activeMembership?.tenant_staff_id === undefined
      ? null
      : Number(activeMembership.tenant_staff_id),
  }));
  try {
    const payload = await buildResponse({
      sessionId: created.sessionId,
      csrfToken: created.csrfToken,
      userId,
      activeMembership,
    });
    setPlatformSessionCookie(res, created.cookieToken, created.expiresAt);
    clearLoginCsrf(res);
    return payload;
  } catch (error) {
    await revokeSession(created.sessionId, "login_response_failed").catch(() => undefined);
    throw error;
  }
}

async function createUser(
  queryable: PlatformQueryable,
  profile: {
    email?: string | null;
    emailVerified?: boolean;
    name: string;
    avatar?: string | null;
    platformRole?: PlatformRole;
  },
): Promise<string> {
  const userId = randomUUID();
  await queryable.query(
    `INSERT INTO platform_users
      (id, canonical_email, display_name, avatar_url, platform_role, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      profile.email ? normalizeEmail(profile.email) : null,
      profile.name,
      profile.avatar ?? null,
      profile.platformRole ?? null,
      profile.email && profile.emailVerified ? new Date() : null,
    ],
  );
  return userId;
}

export async function establishLocalPlatformSession(
  req: Request,
  res: Response,
  staff: LegacyStaff,
): Promise<PlatformAuthResponse | null> {
  if (!isPlatformDatabaseConfigured()) return null;

  const result = await withPlatformTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `local-login:${staff.id}`,
    ]);
    const tenantId = await ensureAmazingTenant(client);
    const subject = `${tenantId}:staff:${staff.id}`;
    const identity = await client.query<{ user_id: string }>(
      `SELECT user_id FROM auth_identities
       WHERE provider = 'local' AND provider_subject = $1 LIMIT 1`,
      [subject],
    );
    let userId = identity.rows[0]?.user_id;

    if (!userId) {
      const linked = await client.query<{ user_id: string }>(
        `SELECT user_id FROM tenant_memberships
         WHERE tenant_id = $1 AND tenant_staff_id = $2 LIMIT 1`,
        [tenantId, staff.id],
      );
      userId = linked.rows[0]?.user_id;
    }
    if (!userId) {
      userId = await createUser(client, {
        email: staff.email,
        name: staff.name,
        avatar: staff.avatar,
      });
    }

    await client.query(
      `INSERT INTO auth_identities
        (id, user_id, provider, provider_subject, email_at_provider, profile, last_used_at)
       VALUES ($1, $2, 'local', $3, $4, $5::jsonb, now())
       ON CONFLICT (provider, provider_subject)
       DO UPDATE SET last_used_at = now()`,
      [randomUUID(), userId, subject, staff.email, JSON.stringify({ staffId: staff.id })],
    );

    // Một legacy role không được tự tạo platform ADMIN. Membership mới luôn
    // bắt đầu ở STAFF; OWNER nâng quyền qua workflow membership authoritative.
    const mappedRole: TenantRole = "STAFF";
    await client.query(
      `INSERT INTO tenant_memberships
        (id, tenant_id, user_id, tenant_role, status, tenant_staff_id)
       VALUES ($1, $2, $3, $4, 'active', $5)
       ON CONFLICT (tenant_id, user_id)
       DO UPDATE SET
         tenant_staff_id = COALESCE(tenant_memberships.tenant_staff_id, EXCLUDED.tenant_staff_id),
         updated_at = now()`,
      [randomUUID(), tenantId, userId, mappedRole, staff.id],
    );
    await client.query(
      `UPDATE platform_users
       SET display_name = $2,
           canonical_email = COALESCE(canonical_email, $3),
           avatar_url = COALESCE($4, avatar_url),
           last_login_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [userId, staff.name, staff.email ? normalizeEmail(staff.email) : null, staff.avatar],
    );
    await writeAudit(client, {
      actorUserId: userId,
      tenantId,
      action: "login.local",
      targetType: "session",
    });
    return { userId };
  });

  return finishLogin(req, res, result.userId);
}

export function validateGooglePayload(payload: TokenPayload | undefined): GoogleProfile {
  if (!payload?.sub || !payload.email || payload.email_verified !== true) {
    throw new GoogleAuthenticationError("GOOGLE_EMAIL_NOT_VERIFIED", "Gmail chưa được Google xác minh");
  }
  return {
    sub: payload.sub,
    email: normalizeEmail(payload.email),
    name: payload.name?.trim() || payload.email,
    ...(payload.picture ? { picture: payload.picture } : {}),
  };
}

export class GoogleAuthenticationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "GoogleAuthenticationError";
  }
}

export async function verifyGoogleCredential(credential: string): Promise<GoogleProfile> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) throw new GoogleAuthenticationError("GOOGLE_NOT_CONFIGURED", "Google Login chưa được cấu hình");
  try {
    const ticket = await new OAuth2Client().verifyIdToken({
      idToken: credential,
      audience: clientId,
    });
    return validateGooglePayload(ticket.getPayload());
  } catch (error) {
    if (error instanceof GoogleAuthenticationError) throw error;
    throw new GoogleAuthenticationError("GOOGLE_TOKEN_INVALID", "Phiên Google không hợp lệ hoặc đã hết hạn");
  }
}

async function findPendingInvitations(
  queryable: PlatformQueryable,
  email: string,
): Promise<Array<{
  id: string;
  tenant_id: string;
  invited_role: TenantRole;
  tenant_staff_id: string | number | null;
  invited_by: string;
  target_user_id: string | null;
}>> {
  const result = await queryable.query<{
    id: string;
    tenant_id: string;
    invited_role: TenantRole;
    tenant_staff_id: string | number | null;
    invited_by: string;
    target_user_id: string | null;
  }>(
    `SELECT id, tenant_id, invited_role, tenant_staff_id, invited_by, target_user_id
     FROM tenant_invitations
     WHERE lower(invited_email) = $1
       AND status = 'pending'
       AND expires_at > now()
     ORDER BY created_at
     FOR UPDATE`,
    [email],
  );
  return result.rows;
}

export async function authenticateGoogle(
  req: Request,
  res: Response,
  profile: GoogleProfile,
): Promise<PlatformAuthResponse> {
  const bootstrapEmail = process.env.BOOTSTRAP_OWNER_EMAIL
    ? normalizeEmail(process.env.BOOTSTRAP_OWNER_EMAIL)
    : null;
  const isBootstrapCandidate = bootstrapEmail === profile.email;
  let bootstrapStaffIdCandidate: number | null = null;
  if (isBootstrapCandidate) {
    const bootstrapState = await getPlatformPool().query<{
      bootstrap_completed_at: Date | null;
      active_owner_count: string;
    }>(
      `SELECT t.bootstrap_completed_at,
              count(m.id) FILTER (
                WHERE m.tenant_role = 'OWNER' AND m.status = 'active'
              )::text AS active_owner_count
       FROM tenants t
       LEFT JOIN tenant_memberships m ON m.tenant_id = t.id
       WHERE t.slug = 'amazing-studio'
       GROUP BY t.id`,
    );
    const state = bootstrapState.rows[0];
    if (!state?.bootstrap_completed_at && Number(state?.active_owner_count ?? 0) === 0) {
      // Resolve the tenant-side actor before opening/locking a platform
      // transaction. A slow tenant database must not hold platform locks.
      bootstrapStaffIdCandidate = await findLegacyAdminStaffId();
    }
  }

  const result = await withPlatformTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `google-login:${profile.sub}`,
    ]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `invite-google-email:${profile.email}`,
    ]);
    const amazingTenantId = await ensureAmazingTenant(client);
    const identity = await client.query<{ user_id: string }>(
      `SELECT user_id FROM auth_identities
       WHERE provider = 'google' AND provider_subject = $1 LIMIT 1`,
      [profile.sub],
    );
    const hadGoogleIdentity = Boolean(identity.rows[0]);
    let userId = identity.rows[0]?.user_id;
    let selectedInvitationTarget = false;
    let bootstrapped = false;
    let invitations = await findPendingInvitations(client, profile.email);

    const targetedUserIds = new Set(
      invitations.map((invitation) => invitation.target_user_id).filter((id): id is string => Boolean(id)),
    );
    if (targetedUserIds.size > 1) {
      throw new GoogleAuthenticationError(
        "INVITATION_IDENTITY_CONFLICT",
        "Lời mời không khớp tài khoản đã liên kết. Vui lòng liên hệ OWNER.",
      );
    }

    if (!userId && isBootstrapCandidate) {
      const tenant = await client.query<{ bootstrap_completed_at: Date | null }>(
        "SELECT bootstrap_completed_at FROM tenants WHERE id = $1 FOR UPDATE",
        [amazingTenantId],
      );
      const ownerCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM tenant_memberships
         WHERE tenant_id = $1 AND tenant_role = 'OWNER' AND status = 'active'`,
        [amazingTenantId],
      );
      if (!tenant.rows[0]?.bootstrap_completed_at && Number(ownerCount.rows[0]?.count ?? 0) === 0) {
        if (!bootstrapStaffIdCandidate) {
          throw new GoogleAuthenticationError(
            "BOOTSTRAP_STATE_CHANGED",
            "Trạng thái bootstrap vừa thay đổi. Vui lòng thử đăng nhập lại.",
          );
        }
        const bootstrapStaffId = bootstrapStaffIdCandidate;
        const linkedLocal = await client.query<{ user_id: string; membership_id: string }>(
          `SELECT user_id, id AS membership_id
           FROM tenant_memberships
           WHERE tenant_id = $1 AND tenant_staff_id = $2
           FOR UPDATE`,
          [amazingTenantId, bootstrapStaffId],
        );
        userId = linkedLocal.rows[0]?.user_id;
        if (userId) {
          await client.query(
            `UPDATE tenant_memberships
             SET tenant_role = 'OWNER', status = 'active', updated_at = now()
             WHERE id = $1`,
            [linkedLocal.rows[0].membership_id],
          );
          await client.query(
            `UPDATE platform_users
             SET platform_role = 'PLATFORM_OWNER', updated_at = now()
             WHERE id = $1`,
            [userId],
          );
        } else {
          userId = await createUser(client, {
            email: profile.email,
            emailVerified: true,
            name: profile.name,
            avatar: profile.picture,
            platformRole: "PLATFORM_OWNER",
          });
          await client.query(
            `INSERT INTO tenant_memberships
              (id, tenant_id, user_id, tenant_role, status, tenant_staff_id)
             VALUES ($1, $2, $3, 'OWNER', 'active', $4)`,
            [randomUUID(), amazingTenantId, userId, bootstrapStaffId],
          );
        }
        await client.query(
          `UPDATE tenants
           SET bootstrap_completed_at = now(), bootstrap_owner_user_id = $2, updated_at = now()
           WHERE id = $1`,
          [amazingTenantId, userId],
        );
        bootstrapped = true;
      }
    }

    if (userId && targetedUserIds.size === 1 && !targetedUserIds.has(userId)) {
      throw new GoogleAuthenticationError(
        "INVITATION_IDENTITY_CONFLICT",
        "Lời mời không khớp tài khoản đã liên kết. Vui lòng liên hệ OWNER.",
      );
    }
    if (!userId && targetedUserIds.size === 1) {
      userId = [...targetedUserIds][0];
      selectedInvitationTarget = true;
    }

    if (!userId && invitations.length > 0) {
      const firstLinked = invitations.find((invite) => invite.tenant_staff_id !== null);
      if (!firstLinked) {
        throw new GoogleAuthenticationError(
          "INVITATION_NOT_LINKED",
          "Lời mời chưa được liên kết với hồ sơ nhân sự. Vui lòng liên hệ quản trị viên.",
        );
      }
      userId = await createUser(client, {
        email: profile.email,
        emailVerified: true,
        name: profile.name,
        avatar: profile.picture,
      });
    }

    if (!userId) {
      throw new GoogleAuthenticationError("GOOGLE_NOT_INVITED", GOOGLE_NOT_INVITED_MESSAGE);
    }

    if (!hadGoogleIdentity && selectedInvitationTarget) {
      const lockedUser = await client.query<{ id: string }>(
        "SELECT id FROM platform_users WHERE id = $1 FOR UPDATE",
        [userId],
      );
      if (!lockedUser.rows[0]) {
        throw new GoogleAuthenticationError(
          "INVITATION_IDENTITY_CONFLICT",
          "Tài khoản được mời không còn tồn tại. Vui lòng liên hệ OWNER.",
        );
      }
      const invitationTenantIds = [...new Set(invitations.map((invitation) => invitation.tenant_id))];
      const outsideMembership = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id
         FROM tenant_memberships
         WHERE user_id = $1
           AND NOT (tenant_id = ANY($2::uuid[]))
         LIMIT 1
         FOR UPDATE`,
        [userId, invitationTenantIds],
      );
      if (outsideMembership.rows[0]) {
        throw new GoogleAuthenticationError(
          "INVITATION_CROSS_TENANT_IDENTITY",
          "Tài khoản này thuộc nhiều studio; PLATFORM_OWNER phải xác minh liên kết Google.",
        );
      }
      const otherGoogleIdentity = await client.query<{ provider_subject: string }>(
        `SELECT provider_subject
         FROM auth_identities
         WHERE user_id = $1 AND provider = 'google'
         LIMIT 1
         FOR UPDATE`,
        [userId],
      );
      if (
        otherGoogleIdentity.rows[0] &&
        otherGoogleIdentity.rows[0].provider_subject !== profile.sub
      ) {
        throw new GoogleAuthenticationError(
          "INVITATION_IDENTITY_CONFLICT",
          "Hồ sơ nhân sự này đã liên kết với một tài khoản Google khác.",
        );
      }
    }

    await client.query(
      `INSERT INTO auth_identities
        (id, user_id, provider, provider_subject, email_at_provider, profile, last_used_at)
       VALUES ($1, $2, 'google', $3, $4, $5::jsonb, now())
       ON CONFLICT (provider, provider_subject)
       DO UPDATE SET
         email_at_provider = EXCLUDED.email_at_provider,
         profile = EXCLUDED.profile,
         last_used_at = now()`,
      [
        randomUUID(),
        userId,
        profile.sub,
        profile.email,
        JSON.stringify({ name: profile.name, picture: profile.picture ?? null }),
      ],
    );
    await client.query(
      `UPDATE platform_users
       SET canonical_email = $2,
           display_name = $3,
           avatar_url = $4,
           email_verified_at = COALESCE(email_verified_at, now()),
           last_login_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [userId, profile.email, profile.name, profile.picture ?? null],
    );

    invitations = await findPendingInvitations(client, profile.email);
    const refreshedTargetUserIds = new Set(
      invitations.map((invitation) => invitation.target_user_id).filter((id): id is string => Boolean(id)),
    );
    if (
      refreshedTargetUserIds.size > 1 ||
      (refreshedTargetUserIds.size === 1 && !refreshedTargetUserIds.has(userId))
    ) {
      throw new GoogleAuthenticationError(
        "INVITATION_IDENTITY_CONFLICT",
        "Lời mời không khớp tài khoản đã liên kết. Vui lòng liên hệ OWNER.",
      );
    }
    for (const invitation of invitations) {
      if (invitation.tenant_staff_id === null) continue;
      const existingMemberships = await client.query<{
        user_id: string;
        tenant_staff_id: string | number | null;
      }>(
        `SELECT user_id, tenant_staff_id
         FROM tenant_memberships
         WHERE tenant_id = $1 AND (user_id = $2 OR tenant_staff_id = $3)
         FOR UPDATE`,
        [invitation.tenant_id, userId, invitation.tenant_staff_id],
      );
      if (existingMemberships.rows.length > 0) {
        const exact = existingMemberships.rows.length === 1 &&
          existingMemberships.rows[0].user_id === userId &&
          Number(existingMemberships.rows[0].tenant_staff_id) === Number(invitation.tenant_staff_id);
        if (!exact || invitation.target_user_id !== userId) {
          throw new GoogleAuthenticationError(
            "INVITATION_MEMBERSHIP_CONFLICT",
            "Lời mời xung đột với thành viên hiện có. Vui lòng liên hệ OWNER.",
          );
        }
      } else {
        await client.query(
          `INSERT INTO tenant_memberships
            (id, tenant_id, user_id, tenant_role, status, tenant_staff_id, invited_by)
           VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
          [
            randomUUID(),
            invitation.tenant_id,
            userId,
            invitation.invited_role,
            invitation.tenant_staff_id,
            invitation.invited_by,
          ],
        );
      }
      await client.query(
        `UPDATE tenant_invitations
         SET status = 'accepted', accepted_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [invitation.id],
      );
      await writeAudit(client, {
        actorUserId: userId,
        tenantId: invitation.tenant_id,
        action: "invitation.accepted",
        targetType: "tenant_invitation",
        targetId: invitation.id,
      });
    }

    const current = await getPlatformUser(client, userId);
    if (current.status !== "active") {
      throw new GoogleAuthenticationError("ACCOUNT_SUSPENDED", "Tài khoản đã bị khóa");
    }
    await writeAudit(client, {
      actorUserId: userId,
      tenantId: bootstrapped ? amazingTenantId : null,
      action: bootstrapped ? "bootstrap.owner" : "login.google",
      targetType: "auth_identity",
      targetId: profile.sub,
    });
    return { userId };
  });

  return finishLogin(req, res, result.userId);
}

export async function responseForSession(
  context: PlatformSessionContext,
): Promise<PlatformAuthResponse> {
  const platformPool = getPlatformPool();
  const rows = await getMembershipRows(platformPool, context.userId);
  const activeMembership = context.membershipId
    ? rows.find((row) => row.membership_id === context.membershipId) ?? null
    : null;
  const csrfToken = await getSessionCsrfToken(context.sessionId);
  return buildResponse({
    sessionId: context.sessionId,
    csrfToken,
    userId: context.userId,
    activeMembership,
  });
}

export async function selectTenantForSession(
  context: PlatformSessionContext,
  tenantId: string,
): Promise<PlatformAuthResponse> {
  const platformPool = getPlatformPool();
  const rows = await getMembershipRows(platformPool, context.userId);
  const selected = rows.find((row) => row.tenant_id === tenantId);
  if (!selected) throw new Error("Bạn không có quyền truy cập studio này");
  if (
    selected.sessions_revoked_at &&
    new Date(selected.sessions_revoked_at).getTime() >= context.createdAt.getTime()
  ) {
    throw new Error("Phiên đăng nhập cũ đã bị thu hồi cho studio này. Vui lòng đăng nhập lại");
  }
  if (selected.tenant_staff_id === null) throw new Error("Studio chưa liên kết hồ sơ nhân sự");
  await assertMembershipUsesCurrentDatabase(platformPool, selected);
  await platformPool.query(
    `UPDATE sessions
     SET active_tenant_id = $2,
         tenant_membership_id = $3,
         legacy_staff_id = $4,
         last_seen_at = now()
     WHERE id = $1 AND revoked_at IS NULL`,
    [context.sessionId, selected.tenant_id, selected.membership_id, selected.tenant_staff_id],
  );
  await writeAudit(platformPool, {
    actorUserId: context.userId,
    tenantId: selected.tenant_id,
    action: "tenant.switched",
    targetType: "tenant",
    targetId: selected.tenant_id,
  });
  const csrfToken = await getSessionCsrfToken(context.sessionId);
  return buildResponse({
    sessionId: context.sessionId,
    csrfToken,
    userId: context.userId,
    activeMembership: selected,
  });
}
