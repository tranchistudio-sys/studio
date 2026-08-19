import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getPlatformPool, normalizeEmail, withPlatformTransaction } from "@workspace/platform-db";
import {
  requireActiveTenantManager,
  requirePlatformCsrf,
  requirePlatformSession,
} from "../middlewares/platform-auth";
import type { PlatformSessionContext, TenantRole } from "../platform/types";
import {
  TenantDatabaseUnavailableError,
  withTenantDatabase,
} from "../platform/tenant-database-router";

const router: IRouter = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function contextFrom(res: Parameters<typeof requirePlatformSession>[1]): PlatformSessionContext {
  return res.locals.platformAuth as PlatformSessionContext;
}

async function canManageTarget(
  context: PlatformSessionContext,
  targetRole: TenantRole,
): Promise<boolean> {
  if (context.tenantRole === "OWNER") return true;
  // OWNER đã cho phép quyền này khi cấp role ADMIN. ADMIN chỉ được quản lý STAFF,
  // không thể đụng OWNER/ADMIN hay cấp platform role. `permissions` JSONB vẫn giữ
  // sẵn để PR sau bổ sung deny/allow chi tiết theo module.
  return context.tenantRole === "ADMIN" && targetRole === "STAFF";
}

router.get(
  "/tenant/members",
  requirePlatformSession,
  requireActiveTenantManager,
  async (_req, res) => {
    const context = contextFrom(res);
    const result = await getPlatformPool().query(
      `SELECT
         m.id,
         m.user_id AS "userId",
         u.display_name AS name,
         u.canonical_email AS email,
         u.avatar_url AS avatar,
         m.tenant_role AS role,
         m.status,
         m.last_login_at AS "lastLoginAt",
         m.tenant_staff_id AS "tenantStaffId",
         (m.id = $2) AS "isCurrent"
       FROM tenant_memberships m
       JOIN platform_users u ON u.id = m.user_id
       WHERE m.tenant_id = $1
       ORDER BY
         CASE m.tenant_role WHEN 'OWNER' THEN 1 WHEN 'ADMIN' THEN 2 ELSE 3 END,
         u.display_name`,
      [context.activeTenantId, context.membershipId],
    );
    res.set("Cache-Control", "no-store");
    res.json({ members: result.rows });
  },
);

router.get(
  "/tenant/invitations",
  requirePlatformSession,
  requireActiveTenantManager,
  async (_req, res) => {
    const context = contextFrom(res);
    const result = await getPlatformPool().query(
      `SELECT
         id,
         invited_email AS email,
         invited_role AS role,
         status,
         expires_at AS "expiresAt",
         created_at AS "createdAt",
         tenant_staff_id AS "tenantStaffId"
       FROM tenant_invitations
       WHERE tenant_id = $1
       ORDER BY created_at DESC`,
      [context.activeTenantId],
    );
    res.set("Cache-Control", "no-store");
    res.json({ invitations: result.rows });
  },
);

router.get(
  "/tenant/access-requests",
  requirePlatformSession,
  requireActiveTenantManager,
  async (_req, res) => {
    const context = contextFrom(res);
    const result = await getPlatformPool().query(
      `SELECT id, full_name AS "fullName", phone, email,
              requested_position AS "requestedPosition", status,
              tenant_staff_id AS "tenantStaffId", created_at AS "createdAt"
       FROM tenant_access_requests
       WHERE tenant_id = $1
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 100`,
      [context.activeTenantId],
    );
    res.set("Cache-Control", "no-store");
    res.json({ requests: result.rows });
  },
);

router.post(
  "/tenant/access-requests/:requestId/review",
  requirePlatformSession,
  requirePlatformCsrf,
  requireActiveTenantManager,
  async (req, res) => {
    const context = contextFrom(res);
    const requestId = Array.isArray(req.params.requestId) ? req.params.requestId[0] : req.params.requestId;
    const decision = req.body?.decision as "approved" | "rejected" | undefined;
    if (!requestId || !UUID_PATTERN.test(requestId) || (decision !== "approved" && decision !== "rejected")) {
      res.status(400).json({ error: "Yêu cầu hoặc quyết định không hợp lệ" });
      return;
    }
    try {
      const requestResult = await getPlatformPool().query<{
        id: string; full_name: string; phone: string; email: string; requested_position: string; status: string;
      }>(
        `SELECT id, full_name, phone, email, requested_position, status
         FROM tenant_access_requests WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [requestId, context.activeTenantId],
      );
      const accessRequest = requestResult.rows[0];
      if (!accessRequest) throw new Error("Không tìm thấy yêu cầu đăng ký");
      if (accessRequest.status !== "pending") throw new Error("Yêu cầu này đã được xử lý");

      if (decision === "rejected") {
        await getPlatformPool().query(
          `UPDATE tenant_access_requests SET status = 'rejected', reviewed_by = $2,
                  reviewed_at = now(), updated_at = now()
           WHERE id = $1 AND status = 'pending'`,
          [requestId, context.userId],
        );
        res.json({ success: true });
        return;
      }

      if (!context.activeTenantId) throw new TenantDatabaseUnavailableError();
      const staffId = await withTenantDatabase(context.activeTenantId, async () => {
        const matches = await pool.query<{ id: number; email: string | null; phone: string }>(
          `SELECT id, email, phone FROM staff
           WHERE is_active = 1 AND (lower(email) = $1 OR phone = $2)
           ORDER BY CASE WHEN lower(email) = $1 THEN 0 ELSE 1 END`,
          [normalizeEmail(accessRequest.email), accessRequest.phone],
        );
        const uniqueIds = [...new Set(matches.rows.map(row => Number(row.id)))];
        if (uniqueIds.length > 1) {
          throw new Error("Gmail và số điện thoại đang thuộc hai hồ sơ khác nhau. Vui lòng chỉnh hồ sơ nhân sự trước.");
        }
        if (matches.rows[0]) {
          await pool.query(
            `UPDATE staff SET email = COALESCE(NULLIF(email, ''), $2) WHERE id = $1`,
            [matches.rows[0].id, normalizeEmail(accessRequest.email)],
          );
          return Number(matches.rows[0].id);
        }
        const inserted = await pool.query<{ id: number }>(
          `INSERT INTO staff
             (name, phone, email, role, roles, is_active, status, staff_type,
              attendance_enabled, notes, join_date)
           VALUES ($1, $2, $3, 'assistant', '["assistant"]'::jsonb, 1,
                   'probation', 'official', true, $4, CURRENT_DATE)
           RETURNING id`,
          [accessRequest.full_name, accessRequest.phone, normalizeEmail(accessRequest.email),
           `Tự đăng ký vị trí: ${accessRequest.requested_position}`],
        );
        return Number(inserted.rows[0].id);
      });

      await withPlatformTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`approve-access:${requestId}`]);
        const pending = await client.query<{ status: string }>(
          `SELECT status FROM tenant_access_requests WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [requestId, context.activeTenantId],
        );
        if (pending.rows[0]?.status !== "pending") throw new Error("Yêu cầu này đã được xử lý");
        const membership = await client.query<{ id: string; user_id: string }>(
          `SELECT id, user_id FROM tenant_memberships
           WHERE tenant_id = $1 AND tenant_staff_id = $2 LIMIT 1`,
          [context.activeTenantId, staffId],
        );
        const invitationId = randomUUID();
        await client.query(
          `INSERT INTO tenant_invitations
             (id, tenant_id, invited_email, invited_role, tenant_staff_id,
              target_user_id, expires_at, invited_by, status)
           VALUES ($1, $2, $3, 'STAFF', $4, $5, now() + interval '7 days', $6, 'pending')
           ON CONFLICT (tenant_id, lower(invited_email)) WHERE status = 'pending'
           DO UPDATE SET tenant_staff_id = EXCLUDED.tenant_staff_id,
                         target_user_id = EXCLUDED.target_user_id,
                         expires_at = EXCLUDED.expires_at,
                         invited_by = EXCLUDED.invited_by`,
          [invitationId, context.activeTenantId, normalizeEmail(accessRequest.email), staffId,
           membership.rows[0]?.user_id ?? null, context.userId],
        );
        await client.query(
          `UPDATE tenant_access_requests SET status = 'approved', reviewed_by = $2,
                  reviewed_at = now(), tenant_staff_id = $3, updated_at = now()
           WHERE id = $1`,
          [requestId, context.userId, staffId],
        );
        await client.query(
          `INSERT INTO platform_audit_logs
             (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, 'access_request.approved', 'tenant_access_request', $4, $5::jsonb)`,
          [randomUUID(), context.userId, context.activeTenantId, requestId,
           JSON.stringify({ staffId, email: normalizeEmail(accessRequest.email) })],
        );
      });
      res.json({ success: true, staffId });
    } catch (error) {
      if (error instanceof TenantDatabaseUnavailableError) {
        res.status(503).json({ error: "Database chưa sẵn sàng", code: error.code }); return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : "Không thể xử lý yêu cầu" });
    }
  },
);

router.get(
  "/tenant/staff-candidates",
  requirePlatformSession,
  requireActiveTenantManager,
  async (_req, res) => {
    const context = contextFrom(res);
    try {
      if (!context.activeTenantId) throw new TenantDatabaseUnavailableError();
      const result = await withTenantDatabase(context.activeTenantId, () => pool.query(
        `SELECT id, name, email, (is_active = 1) AS "isActive"
         FROM staff
         WHERE is_active = 1
         ORDER BY name`,
      ));
      const linked = await getPlatformPool().query<{
        tenant_staff_id: string | number;
        user_id: string;
        google_linked: boolean;
        tenant_role: TenantRole;
      }>(
        `SELECT m.tenant_staff_id, m.user_id, m.tenant_role,
                EXISTS (
                  SELECT 1 FROM auth_identities i
                  WHERE i.user_id = m.user_id AND i.provider = 'google'
                ) AS google_linked
         FROM tenant_memberships m
         WHERE m.tenant_id = $1 AND m.tenant_staff_id IS NOT NULL`,
        [context.activeTenantId],
      );
      const linkedByStaff = new Map(
        linked.rows.map((row) => [Number(row.tenant_staff_id), row] as const),
      );
      res.set("Cache-Control", "no-store");
      res.json({
        staff: result.rows
          .filter((row) => {
            const linkedMembership = linkedByStaff.get(Number(row.id));
            if (linkedMembership?.google_linked) return false;
            return context.tenantRole !== "ADMIN" || !linkedMembership || linkedMembership.tenant_role === "STAFF";
          })
          .map((row) => ({
            ...row,
            platformLinked: linkedByStaff.has(Number(row.id)),
          })),
      });
    } catch (error) {
      res.status(503).json({ error: "Database chưa sẵn sàng", code: "TENANT_DATABASE_UNAVAILABLE" });
      return;
    }
  },
);

router.post(
  "/tenant/invitations",
  requirePlatformSession,
  requirePlatformCsrf,
  requireActiveTenantManager,
  async (req, res) => {
    const context = contextFrom(res);
    const email = typeof req.body?.email === "string" ? normalizeEmail(req.body.email) : "";
    const role = req.body?.role as TenantRole | undefined;
    const tenantStaffId = Number(req.body?.tenantStaffId);
    if (!EMAIL_PATTERN.test(email)) {
      res.status(400).json({ error: "Gmail không hợp lệ" });
      return;
    }
    if (role !== "OWNER" && role !== "ADMIN" && role !== "STAFF") {
      res.status(400).json({ error: "Role lời mời không hợp lệ" });
      return;
    }
    if (!Number.isInteger(tenantStaffId) || tenantStaffId <= 0) {
      res.status(400).json({ error: "Vui lòng chọn hồ sơ nhân sự cần liên kết" });
      return;
    }
    if (!(await canManageTarget(context, role))) {
      res.status(403).json({ error: "Bạn không có quyền mời role này" });
      return;
    }

    try {
      if (!context.activeTenantId) throw new TenantDatabaseUnavailableError();
      const staff = await withTenantDatabase(context.activeTenantId, () => pool.query<{ id: number }>(
        "SELECT id FROM staff WHERE id = $1 AND is_active = 1 LIMIT 1",
        [tenantStaffId],
      ));
      if (!staff.rows[0]) {
        res.status(400).json({ error: "Hồ sơ nhân sự không tồn tại hoặc đã khóa" });
        return;
      }

      const invitation = await withPlatformTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `invite-google-email:${email}`,
        ]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `invite-email:${context.activeTenantId}:${email}`,
        ]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `invite-staff:${context.activeTenantId}:${tenantStaffId}`,
        ]);
        const linked = await client.query<{ id: string; user_id: string; tenant_role: TenantRole }>(
          `SELECT id, user_id, tenant_role FROM tenant_memberships
           WHERE tenant_id = $1 AND tenant_staff_id = $2 LIMIT 1`,
          [context.activeTenantId, tenantStaffId],
        );
        const targetUserId = linked.rows[0]?.user_id ?? null;
        const linkedRole = linked.rows[0]?.tenant_role;
        if (linkedRole && !(await canManageTarget(context, linkedRole))) {
          throw new Error("Bạn không có quyền liên kết Google cho thành viên này");
        }
        if (linkedRole === "OWNER" && targetUserId !== context.userId) {
          throw new Error("OWNER chỉ được tự liên kết tài khoản Google của mình");
        }
        if (role === "OWNER" && linkedRole !== "OWNER") {
          throw new Error("Chỉ được mời role OWNER để tự liên kết một OWNER hiện có");
        }
        const effectiveRole = linkedRole ?? role;
        if (targetUserId) {
          const otherTenant = await client.query<{ tenant_id: string }>(
            `SELECT tenant_id FROM tenant_memberships
             WHERE user_id = $1 AND tenant_id <> $2
             LIMIT 1`,
            [targetUserId, context.activeTenantId],
          );
          if (otherTenant.rows[0]) {
            throw new Error("Tài khoản này thuộc nhiều studio; PLATFORM_OWNER phải xác minh liên kết Google");
          }
          const googleIdentity = await client.query<{ id: string }>(
            "SELECT id FROM auth_identities WHERE user_id = $1 AND provider = 'google' LIMIT 1",
            [targetUserId],
          );
          if (googleIdentity.rows[0]) {
            throw new Error("Hồ sơ nhân sự này đã liên kết với tài khoản Google");
          }
        }

        const existing = await client.query<{
          id: string;
          invited_email: string;
          tenant_staff_id: string | number | null;
        }>(
          `SELECT id, invited_email, tenant_staff_id FROM tenant_invitations
           WHERE tenant_id = $1 AND status = 'pending'
             AND (lower(invited_email) = $2 OR tenant_staff_id = $3)
           FOR UPDATE`,
          [context.activeTenantId, email, tenantStaffId],
        );
        if (existing.rows.length > 1) {
          throw new Error("Email hoặc hồ sơ nhân sự đang thuộc lời mời khác");
        }
        const pending = existing.rows[0];
        if (pending && (
          normalizeEmail(pending.invited_email) !== email ||
          Number(pending.tenant_staff_id) !== tenantStaffId
        )) {
          throw new Error("Email hoặc hồ sơ nhân sự đang thuộc lời mời khác");
        }
        const id = pending?.id ?? randomUUID();
        if (pending) {
          await client.query(
            `UPDATE tenant_invitations
             SET invited_role = $2, tenant_staff_id = $3,
                 target_user_id = $4,
                 expires_at = now() + interval '7 days', invited_by = $5
             WHERE id = $1`,
            [id, effectiveRole, tenantStaffId, targetUserId, context.userId],
          );
        } else {
          await client.query(
            `INSERT INTO tenant_invitations
              (id, tenant_id, invited_email, invited_role, tenant_staff_id, target_user_id,
               expires_at, invited_by, status)
             VALUES ($1, $2, $3, $4, $5, $6, now() + interval '7 days', $7, 'pending')`,
            [id, context.activeTenantId, email, effectiveRole, tenantStaffId, targetUserId, context.userId],
          );
        }
        await client.query(
          `INSERT INTO platform_audit_logs
            (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, 'invitation.created', 'tenant_invitation', $4, $5::jsonb)`,
          [randomUUID(), context.userId, context.activeTenantId, id, JSON.stringify({ role: effectiveRole, tenantStaffId })],
        );
        return { id, email, role: effectiveRole, tenantStaffId };
      });
      res.status(201).json({ success: true, invitation });
    } catch (error) {
      if (error instanceof TenantDatabaseUnavailableError) {
        res.status(503).json({ error: "Database chưa sẵn sàng", code: error.code });
        return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : "Không thể tạo lời mời" });
    }
  },
);

router.patch(
  "/tenant/members/:membershipId",
  requirePlatformSession,
  requirePlatformCsrf,
  requireActiveTenantManager,
  async (req, res) => {
    const context = contextFrom(res);
    const rawMembershipId = req.params.membershipId;
    const membershipId = Array.isArray(rawMembershipId) ? rawMembershipId[0] : rawMembershipId;
    if (!membershipId || !UUID_PATTERN.test(membershipId)) {
      res.status(400).json({ error: "Membership không hợp lệ" });
      return;
    }
    const role = req.body?.role as TenantRole | undefined;
    const status = req.body?.status as "active" | "suspended" | undefined;
    if ((role ? 1 : 0) + (status ? 1 : 0) !== 1) {
      res.status(400).json({ error: "Chỉ được đổi role hoặc trạng thái trong một request" });
      return;
    }
    if (role && !(["OWNER", "ADMIN", "STAFF"] as const).includes(role)) {
      res.status(400).json({ error: "Role không hợp lệ" });
      return;
    }
    if (status && status !== "active" && status !== "suspended") {
      res.status(400).json({ error: "Trạng thái không hợp lệ" });
      return;
    }

    try {
      await withPlatformTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `membership-owner:${context.activeTenantId}`,
        ]);
        const targetResult = await client.query<{
          tenant_role: TenantRole;
          status: string;
        }>(
          `SELECT tenant_role, status
           FROM tenant_memberships
           WHERE id = $1 AND tenant_id = $2
           FOR UPDATE`,
          [membershipId, context.activeTenantId],
        );
        const target = targetResult.rows[0];
        if (!target) throw new Error("Không tìm thấy thành viên");
        if (!(await canManageTarget(context, target.tenant_role))) {
          throw new Error("Bạn không có quyền chỉnh thành viên này");
        }
        if (role && context.tenantRole !== "OWNER") {
          throw new Error("Chỉ OWNER được thay đổi role");
        }

        const removesOwner = target.tenant_role === "OWNER" &&
          ((role && role !== "OWNER") || status === "suspended");
        if (removesOwner) {
          const owners = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM tenant_memberships
             WHERE tenant_id = $1 AND tenant_role = 'OWNER' AND status = 'active'`,
            [context.activeTenantId],
          );
          if (Number(owners.rows[0]?.count ?? 0) <= 1) {
            throw new Error("Không thể hạ quyền hoặc khóa OWNER cuối cùng của studio");
          }
        }

        if (role) {
          await client.query(
            `UPDATE tenant_memberships
             SET tenant_role = $2,
                 auth_version = auth_version + 1,
                 sessions_revoked_at = now(),
                 updated_at = now()
             WHERE id = $1`,
            [membershipId, role],
          );
          await client.query(
            `UPDATE sessions SET revoked_at = now(), revoked_reason = 'membership_role_changed'
             WHERE tenant_membership_id = $1 AND revoked_at IS NULL`,
            [membershipId],
          );
        } else {
          if (status === "suspended") {
            await client.query(
              `UPDATE tenant_memberships
               SET status = $2,
                   auth_version = auth_version + 1,
                   sessions_revoked_at = now(),
                   updated_at = now()
               WHERE id = $1`,
              [membershipId, status],
            );
            await client.query(
              `UPDATE sessions SET revoked_at = now(), revoked_reason = 'membership_suspended'
               WHERE tenant_membership_id = $1 AND revoked_at IS NULL`,
              [membershipId],
            );
          } else {
            await client.query(
              "UPDATE tenant_memberships SET status = $2, updated_at = now() WHERE id = $1",
              [membershipId, status],
            );
          }
        }
        await client.query(
          `INSERT INTO platform_audit_logs
            (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, $4, 'tenant_membership', $5, $6::jsonb)`,
          [
            randomUUID(),
            context.userId,
            context.activeTenantId,
            role ? "membership.role_changed" : status === "suspended" ? "membership.suspended" : "membership.activated",
            membershipId,
            JSON.stringify(role ? { role } : { status }),
          ],
        );
      });
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Không thể cập nhật thành viên" });
    }
  },
);

router.post(
  "/tenant/members/:membershipId/revoke-sessions",
  requirePlatformSession,
  requirePlatformCsrf,
  requireActiveTenantManager,
  async (req, res) => {
    const context = contextFrom(res);
    const rawMembershipId = req.params.membershipId;
    const membershipId = Array.isArray(rawMembershipId) ? rawMembershipId[0] : rawMembershipId;
    if (!membershipId || !UUID_PATTERN.test(membershipId)) {
      res.status(400).json({ error: "Membership không hợp lệ" });
      return;
    }
    const target = await getPlatformPool().query<{ tenant_role: TenantRole }>(
      "SELECT tenant_role FROM tenant_memberships WHERE id = $1 AND tenant_id = $2 LIMIT 1",
      [membershipId, context.activeTenantId],
    );
    if (!target.rows[0]) {
      res.status(404).json({ error: "Không tìm thấy thành viên" });
      return;
    }
    if (!(await canManageTarget(context, target.rows[0].tenant_role))) {
      res.status(403).json({ error: "Bạn không có quyền thu hồi phiên của thành viên này" });
      return;
    }
    await withPlatformTransaction(async (client) => {
      await client.query(
        `UPDATE tenant_memberships
         SET auth_version = auth_version + 1,
             sessions_revoked_at = now(),
             updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [membershipId, context.activeTenantId],
      );
      await client.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'revoked_by_tenant_manager'
         WHERE tenant_membership_id = $1 AND revoked_at IS NULL`,
        [membershipId],
      );
      await client.query(
        `INSERT INTO platform_audit_logs
          (id, actor_user_id, tenant_id, action, target_type, target_id)
         VALUES ($1, $2, $3, 'membership.sessions_revoked', 'tenant_membership', $4)`,
        [randomUUID(), context.userId, context.activeTenantId, membershipId],
      );
    });
    res.json({ success: true });
  },
);

export default router;
